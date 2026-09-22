import { CostTracker, ProgressGuard, classifyFailure, FAILURE, retryAfterMs, stableHash, ContinuityError, validateTaskEnvelope } from './continuity-core.js';
import { leaseToken, verifyHandoff } from './continuity-infra.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HANDOFF_MARKER = '<!-- CONTINUITY_HANDOFF -->';

function checkpointPayload({ task, proposal, snapshot, cost, previousErrors = [], failoverReason = null, nextSafeAction }) {
  return {
    taskEnvelope: {
      ...task,
      currentProvider: failoverReason ? 'openai' : task.currentProvider,
      currentModel: 'gpt-5.3-codex',
      currentStage: failoverReason ? 'handoff' : 'verify',
      currentCommitSha: snapshot.sha,
      currentTaskState: failoverReason ? 'checkpointed_for_handoff' : 'initial_work_complete',
    },
    proposal,
    completedWork: ['Initial proof content written by GPT-5.3-Codex', 'Repository tests passed', 'Git state captured'],
    remainingWork: ['Verify checkpoint against Git state', 'Complete the proof at the handoff marker', 'Run final tests', 'Create one commit and pull request'],
    changedFiles: snapshot.files,
    patchReference: { path: proposal.path, contentSha256: stableHash(proposal.content), workingTreeStatus: snapshot.status },
    testResults: snapshot.tests,
    buildStatus: { required: false, reason: 'The POC changes one Markdown proof file; repository tests remain the verification gate.' },
    previousErrors,
    decisions: ['GitHub remains source of truth', 'Only the approved proof file may be changed', 'The controller owns all credentials and tools'],
    supabaseState: { taskId: task.id, durable: true },
    deploymentState: { touched: false, required: false },
    previousProvider: 'openai',
    previousModel: 'gpt-5.3-codex',
    failoverReason,
    consumedCostUsd: cost.spentUsd,
    nextSafeAction,
    allowedToolPermissions: task.allowedTools,
    restrictedActions: task.restrictedActions,
  };
}

export class ContinuityController {
  constructor({ store, workspace, publisher, providers, sleepFn = sleep } = {}) { this.store = store; this.workspace = workspace; this.publisher = publisher; this.providers = providers; this.sleepFn = sleepFn; }

  async callProvider(task, stage, request, activeProvider, cost, onSwitch = async () => {}) {
    let providerName = activeProvider;
    let switches = 0;
    const failures = [];
    while (switches <= task.maxProviderSwitchesPerStage) {
      const provider = this.providers[providerName];
      if (!provider) throw new ContinuityError(`Provider adapter is not configured: ${providerName}`, { code: 'PROVIDER_NOT_CONFIGURED' });
      for (let attempt = 1; attempt <= task.maxAttemptsPerProvider; attempt++) {
        let result;
        const startedAt = Date.now();
        try {
          await this.store.event(task.id, 'provider_attempt', `${providerName} attempt ${attempt} for ${stage}`, { stage, attempt, model: provider.model }, 'info', providerName);
          result = await provider.complete({ ...request, stage, metadata: { task_id: task.id, stage } });
        } catch (error) {
          const failure = classifyFailure(error);
          const failureRecord = { failure, attempt, status: error.status || null, networkCode: error.networkCode || null, simulated: Boolean(error.simulated), durationMs: Date.now() - startedAt, provider: providerName, model: provider.model };
          failures.push(failureRecord);
          await this.store.event(task.id, 'provider_failure', `${providerName} failed for ${stage}`, failureRecord, 'warning', providerName);
          if (failure === FAILURE.AUTH) throw new ContinuityError('NEEDS HUMAN APPROVAL: provider authentication failed', { code: 'NEEDS_HUMAN_APPROVAL', provider: providerName });
          if (failure === FAILURE.BILLING) break;
          if (failure === FAILURE.INVALID_REQUEST || failure === FAILURE.UNKNOWN) throw error;
          if (attempt < task.maxAttemptsPerProvider) {
            if (failure === FAILURE.RATE_LIMIT) await this.sleepFn(retryAfterMs(error));
            else await this.sleepFn(250 * attempt);
            continue;
          }
        }
        if (!result) break;
        const durationMs = Date.now() - startedAt;
        const usage = { ...result.usage, agent: 'continuity-controller', stage, attempt, durationMs };
        await this.store.usage(task.id, providerName, result.model, usage);
        await cost.add(usage);
        return { ...result, usage, providerName, attempt, switches, failures, durationMs };
      }
      switches++;
      if (switches > task.maxProviderSwitchesPerStage) break;
      const fromProvider = providerName;
      providerName = providerName === 'openai' ? 'anthropic' : 'openai';
      const switchContext = { stage, switches, lastFailure: failures.at(-1), failures: [...failures] };
      await onSwitch(fromProvider, providerName, switchContext);
      await this.store.event(task.id, 'provider_switch', `Switching ${stage} ownership to ${providerName}`, { ...switchContext, fromProvider, toProvider: providerName }, 'warning', providerName);
    }
    throw new ContinuityError('ALL PROVIDERS UNAVAILABLE', { code: 'ALL_PROVIDERS_UNAVAILABLE' });
  }

  async run(inputTask) {
    let task = validateTaskEnvelope(inputTask);
    const token = leaseToken();
    const progress = new ProgressGuard();
    const runStartedAt = Date.now();
    const taskRow = await this.store.createTask(task);
    if (taskRow?.status === 'completed') return { ...taskRow.result, taskId: taskRow.id || task.id };
    if (taskRow?.task_envelope) task = validateTaskEnvelope(taskRow.task_envelope);
    const initialSpentUsd = this.store.spent ? await this.store.spent(task.id) : Number(taskRow?.spent_usd || 0);
    const cost = new CostTracker(task.budgetUsd, async (threshold) => this.store.event(task.id, 'cost_threshold', `Cost reached ${threshold.threshold * 100}%`, threshold, threshold.threshold >= 0.9 ? 'warning' : 'info'), initialSpentUsd);
    await this.store.acquireLease(task.id, 'openai', token, 900);
    await this.store.event(task.id, 'task_started', 'Continuity POC started', { expectedSha: task.expectedSha, branch: task.workingBranch });
    await this.store.event(task.id, 'writer_lock_acquired', 'Exclusive writer lease acquired', { owner: 'openai', leaseSeconds: 900 }, 'info', 'openai');
    try {
      this.workspace.prepare(task);
      const existingCheckpoint = await this.store.latestCheckpoint?.(task.id);
      let implementation;
      let proposal;
      let checkpoint;
      let snapshot;
      if (['verify', 'handoff'].includes(existingCheckpoint?.stage)) {
        proposal = existingCheckpoint.payload.proposal;
        implementation = { providerName: existingCheckpoint.owner_provider || 'openai', failures: [] };
        checkpoint = existingCheckpoint;
        await this.store.event(task.id, 'checkpoint_restored', 'Resuming from the durable continuity checkpoint', { checkpointId: checkpoint.id, stage: checkpoint.stage });
      } else {
        const initialMarker = `Initial work by GPT-5.3-Codex at ${task.expectedSha.slice(0, 12)}`;
        implementation = await this.callProvider({ ...task, maxProviderSwitchesPerStage: 0 }, 'implement', {
          instructions: 'You are the primary coding provider in a controlled POC. Return JSON only. You cannot access credentials or tools directly.',
          input: `Task: ${task.goal}\nReturn {"summary":string,"path":"continuity-poc-proof.md","content":string,"commitMessage":string}. The Markdown must contain the exact text "${initialMarker}" and the exact marker "${HANDOFF_MARKER}" once. Leave that marker for the backup provider to complete. Include no secrets.`,
        }, 'openai', cost);
        proposal = implementation.data;
      }
      const initialMarker = `Initial work by GPT-5.3-Codex at ${task.expectedSha.slice(0, 12)}`;
      if (proposal.path !== task.allowedFiles[0] || typeof proposal.content !== 'string' || typeof proposal.commitMessage !== 'string' || !proposal.content.includes(initialMarker) || proposal.content.split(HANDOFF_MARKER).length !== 2) throw new ContinuityError('Primary provider returned an invalid continuation proposal');
      this.workspace.writeAllowed(task, proposal.path, proposal.content);
      await this.store.event(task.id, 'files_modified', 'GPT-5.3-Codex initial work written through the controlled workspace', { files: [proposal.path], contentSha256: stableHash(proposal.content) }, 'info', 'openai');
      const tests = this.workspace.test(task);
      await this.store.event(task.id, 'tests_run', 'Tests executed after primary work', { passed: tests.passed, exitCode: tests.exitCode }, tests.passed ? 'success' : 'error', 'openai');
      if (!tests.passed) throw new ContinuityError('Primary proposal failed repository tests', { output: tests.output });
      snapshot = this.workspace.snapshot(task, tests);
      if (!checkpoint) {
        const payload = checkpointPayload({ task, proposal, snapshot, cost, nextSafeAction: 'Attempt verification with the primary provider; checkpoint and transfer ownership if the simulated limit persists.' });
        const progressHash = progress.observe({ proposal, snapshot });
        checkpoint = await this.store.checkpoint(task.id, 1, 'verify', 'openai', task.expectedSha, snapshot, payload, progressHash);
        await this.store.event(task.id, 'checkpoint_saved', 'Durable checkpoint saved before verification', { checkpointId: checkpoint.id, progressHash, sequence: 1 });
      }

      const verificationRequest = {
        instructions: 'You are the backup coding provider. First verify the structured checkpoint and Git snapshot. Then continue the same file by preserving all text before and after the handoff marker and replacing only that marker with a concise sentence containing "Claude Sonnet 5". Return JSON only as {"approved":boolean,"summary":string,"path":"continuity-poc-proof.md","content":string,"commitMessage":string}. You cannot access credentials or tools directly.',
        input: JSON.stringify({ taskEnvelope: task, checkpoint: checkpoint.payload, snapshot, proposal }, null, 2),
      };
      let handoffProvider = null;
      let handoffReason = null;
      const continuation = await this.callProvider(task, 'verify', verificationRequest, 'openai', cost, async (fromProvider, toProvider, context) => {
        handoffReason = context.lastFailure?.failure || 'PROVIDER_UNAVAILABLE';
        const currentSnapshot = this.workspace.snapshot(task, tests);
        if (checkpoint.stage !== 'handoff') {
          const payload = checkpointPayload({ task, proposal, snapshot: currentSnapshot, cost, previousErrors: context.failures, failoverReason: handoffReason, nextSafeAction: 'Transfer the verified writer lease to Claude Sonnet 5, preserve the initial content, and complete only the handoff marker.' });
          checkpoint = await this.store.checkpoint(task.id, Number(checkpoint.sequence || 1) + 1, 'handoff', fromProvider, task.expectedSha, currentSnapshot, payload, progress.observe({ proposal, currentSnapshot, failures: context.failures }));
          await this.store.event(task.id, 'checkpoint_saved', 'Failover checkpoint saved after the simulated provider limit', { checkpointId: checkpoint.id, sequence: checkpoint.sequence, failoverReason: handoffReason }, 'warning', fromProvider);
        }
        const proof = verifyHandoff({ task, checkpoint, snapshot: currentSnapshot });
        await this.store.event(task.id, 'checkpoint_verified', 'Checkpoint matches the controlled working tree', proof, 'success', toProvider);
        await this.store.event(task.id, 'git_sha_verified', 'Expected Git SHA verified before ownership transfer', { expectedSha: task.expectedSha, actualSha: proof.sha }, 'success', toProvider);
        await this.store.transfer(task.id, fromProvider, toProvider, token, checkpoint.id, proof);
        handoffProvider = toProvider;
        verificationRequest.input = JSON.stringify({ taskEnvelope: checkpoint.payload.taskEnvelope, checkpoint: checkpoint.payload, handoffVerification: proof, proposal }, null, 2);
        await this.store.event(task.id, 'handoff_completed', `Writer ownership transferred from ${fromProvider} to ${toProvider}`, { ...proof, failoverReason: handoffReason }, 'success', toProvider);
        await this.store.event(task.id, 'backup_provider_started', 'Claude Sonnet 5 received the verified structured handoff', { checkpointId: checkpoint.id }, 'info', toProvider);
      });
      if (continuation.providerName !== 'openai' && handoffProvider !== continuation.providerName) throw new ContinuityError('Backup provider ran without an accepted handoff', { code: 'HANDOFF_REQUIRED' });
      const completed = continuation.data;
      const [beforeHandoff, afterHandoff] = proposal.content.split(HANDOFF_MARKER);
      if (completed.approved !== true || completed.path !== proposal.path || typeof completed.content !== 'string' || typeof completed.commitMessage !== 'string' || !completed.content.startsWith(beforeHandoff) || !completed.content.endsWith(afterHandoff) || completed.content.includes(HANDOFF_MARKER) || !completed.content.includes('Claude Sonnet 5')) throw new ContinuityError('Backup provider did not safely continue the checkpointed work', { code: 'VERIFICATION_REJECTED' });
      this.workspace.writeAllowed(task, completed.path, completed.content);
      await this.store.event(task.id, 'task_continued', 'Claude Sonnet 5 completed the same checkpointed file', { file: completed.path, preservedInitialContent: true, contentSha256: stableHash(completed.content) }, 'success', continuation.providerName);
      progress.observe({ approved: completed.summary, fileHash: stableHash(completed.content) });
      const finalTests = this.workspace.test(task);
      if (!finalTests.passed) throw new ContinuityError('Final test gate failed', { output: finalTests.output });
      await this.store.event(task.id, 'tests_passed', 'Final repository tests passed after Claude continuation', { passed: true, exitCode: finalTests.exitCode }, 'success', continuation.providerName);
      const published = await this.publisher.publish(task, completed.path, completed.content, completed.commitMessage);
      await this.store.event(task.id, 'commit_created', 'Controlled commit and pull request created', published, 'success', continuation.providerName);
      const retryCount = implementation.failures.length + continuation.failures.length;
      const result = {
        taskId: task.id,
        providers: { implementation: implementation.providerName, continuation: continuation.providerName },
        checkpointId: checkpoint.id,
        tests: { passed: true },
        failoverReason: handoffReason,
        retryCount,
        providerSwitches: continuation.switches,
        durationMs: Date.now() - runStartedAt,
        spentUsd: cost.spentUsd,
        ...published,
      };
      await this.store.finish(task.id, 'completed', result, cost.spentUsd, token);
      try { await this.store.event(task.id, 'task_completed', 'Continuity POC completed with a pull request', result, 'success', continuation.providerName); } catch {}
      return result;
    } catch (error) {
      const status = error.code === 'NEEDS_HUMAN_APPROVAL' ? 'needs_human' : 'failed';
      try { await this.store.event(task.id, status === 'needs_human' ? 'task_needs_human' : 'task_failed', error.message, { code: error.code || 'FAILED', durationMs: Date.now() - runStartedAt }, 'error'); } catch {}
      try { await this.store.finish(task.id, status, { code: error.code || 'FAILED', message: error.message }, cost.spentUsd, token); } catch {}
      throw error;
    }
  }
}
