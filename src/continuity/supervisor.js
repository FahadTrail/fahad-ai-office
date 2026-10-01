import { LeaseManager } from './lease.js';
import { ContinuityCheckpointer } from './checkpointer.js';
import { assertAdapterContract } from './adapter-contract.js';
import { buildContinuationPacket } from './packet.js';
import { HandoffHistory, selectWorker } from './select.js';
import { ContinuityEvents } from './events.js';
import { UsageTracker } from './usage.js';

const ACTIVE_STATES = ['ACQUIRING', 'ACTIVE', 'DRAINING', 'CHECKPOINTING', 'HANDOFF_READY', 'RATE_LIMITED', 'QUOTA_EXHAUSTED', 'ABNORMAL_EXIT'];

function copyCheckpoint(checkpoint, patch) {
  return {
    ...structuredClone(checkpoint),
    ...patch,
    timestamp: new Date().toISOString(),
    quota_state: { basis: 'UNKNOWN', used_pct: null, reset_at: null, ...(checkpoint.quota_state || {}), ...(patch.quota_state || {}) },
    rate_limit_state: { limited: false, retry_after_s: null, ...(checkpoint.rate_limit_state || {}), ...(patch.rate_limit_state || {}) },
  };
}
export class ContinuitySupervisor {
  constructor({
    store,
    adapters = [],
    leaseManager = new LeaseManager({ store }),
    checkpointerFactory = (options) => new ContinuityCheckpointer(options),
    events = new ContinuityEvents({ store }),
    usage = new UsageTracker({ store }),
    gates,
    verifyBranch = async () => ({ ok: false, reason: 'BRANCH_VERIFIER_NOT_CONFIGURED' }),
    confirmStopped = async () => false,
    prepareWorktree = null,
    prepareTransfer = null,
    releaseWorktree = null,
    mirrorPath,
    mirrorPathForSession = null,
    doNotTouch = [],
    drainAtPct = 85,
    scheduler = globalThis,
    statusIntervalMs = 60_000,
    usageIntervalMs = 5 * 60_000,
  } = {}) {
    if (!store) throw new TypeError('ContinuitySupervisor requires a store');
    this.store = store;
    this.adapters = new Map(adapters.map((adapter) => [adapter.key, assertAdapterContract(adapter)]));
    this.leaseManager = leaseManager;
    this.checkpointerFactory = checkpointerFactory;
    this.events = events;
    this.usage = usage;
    this.gates = gates;
    this.verifyBranch = verifyBranch;
    this.confirmStopped = confirmStopped;
    this.prepareWorktree = prepareWorktree;
    this.prepareTransfer = prepareTransfer;
    this.releaseWorktree = releaseWorktree;
    this.mirrorPath = mirrorPath;
    this.mirrorPathForSession = mirrorPathForSession;
    this.doNotTouch = doNotTouch;
    this.drainAtPct = drainAtPct;
    this.scheduler = scheduler;
    this.statusIntervalMs = statusIntervalMs;
    this.usageIntervalMs = usageIntervalMs;
    this.running = new Map();
    this.history = new HandoffHistory();
    this.started = false;
    this.statusTimer = null;
    this.usageTimer = null;
  }

  async workerCandidates(task) {
    const workers = await this.store.listWorkers();
    return selectWorker({ workers, adapters: this.adapters, task, history: this.history });
  }

  heartbeatCallbacks(sessionId, workerKey) {
    return {
      onLost: (error) => this.onLeaseLost(sessionId, error),
      onHeartbeat: (lease) => this.events.emit('LEASE_HEARTBEAT', { sessionId, leaseId: lease.id, worker: workerKey, expiresAt: lease.expires_at }).catch(() => {}),
    };
  }

  makeCheckpointer(lease, task = null) {
    // Runtime mirrors live outside writable worker worktrees. Writing a mirror
    // into a worker branch after it stops would create an uncommitted diff and
    // invalidate the clean-branch handoff guard.
    const mirrorPath = this.mirrorPathForSession?.(lease, task) || this.mirrorPath;
    return this.checkpointerFactory({ store: this.store, lease, mirrorPath, env: process.env });
  }

  async prepareSessionWorktree(session, task, selection) {
    if (selection.adapter.capabilities().worktreeManagement !== 'supervisor') return { session, task };
    if (!this.prepareWorktree) throw new Error('CONTINUITY_WORKTREE_PREPARER_REQUIRED');
    const prepared = await this.prepareWorktree({ session, task, worker: selection.worker });
    if (!prepared?.path) throw new Error('CONTINUITY_WORKTREE_PREPARATION_FAILED');
    const nextTask = { ...task, worktree: prepared.path };
    const nextSession = await this.store.updateSession(session.id, { worktree: prepared.path });
    return { session: nextSession, task: nextTask };
  }

  async verifyPreparedHead(task, checkpoint, adapter) {
    if (adapter.capabilities().worktreeManagement !== 'supervisor') return;
    const result = await this.verifyBranch({ worktree: task.worktree }, { ...checkpoint, branch: task.branch });
    if (!result?.ok || result.head !== checkpoint.last_commit) throw new Error('CONTINUITY_PREPARED_HEAD_MISMATCH');
  }

  async cleanupManagedWorktree(adapter, task) {
    if (adapter?.capabilities().worktreeManagement !== 'supervisor' || !this.releaseWorktree || !task?.worktree) return false;
    try { await this.releaseWorktree(task.worktree); return true; }
    catch { return false; } // Preserve any dirty or unpushed evidence.
  }

  async stopFailedExecution(adapter, execution, reason) {
    if (!execution?.session) return true;
    try {
      const result = await adapter.stop({ session: execution.session, reason });
      if (result?.stopped !== true || result?.draining === true) return false;
      await adapter.cleanup?.({ session: execution.session });
      return true;
    } catch { return false; }
  }

  async preserveUnconfirmedWorker(sessionId, workerKey, error) {
    await this.store.failSession(sessionId, { status: 'ABNORMAL_EXIT', reason: 'WORKER_STOP_UNCONFIRMED' }).catch(() => {});
    await this.events.emit('WORKER_FAILED', { sessionId, worker: workerKey, code: 'WORKER_STOP_UNCONFIRMED', cause: error.message }, { level: 'error' }).catch(() => {});
  }

  normalizeCheckpoint(checkpoint, session, worker, task, status = 'ACTIVE') {
    const workerKey = typeof worker === 'string' ? worker : worker.key;
    const agentType = typeof worker === 'string' ? checkpoint.agent_type : worker.kind;
    return copyCheckpoint(checkpoint, {
      session_id: session.id,
      repository: session.repository || task.repository,
      branch: session.branch || task.branch,
      worktree: session.worktree ?? task.worktree ?? null,
      agent_id: workerKey,
      agent_type: agentType || checkpoint.agent_type,
      status,
      objective: session.objective || task.objective,
      data_class: task.dataClass || checkpoint.data_class || 'NORMAL',
      privacy_requirements: task.privacyRequirements || checkpoint.privacy_requirements || [],
    });
  }

  async startTask({ task, checkpoint }) {
    const selection = await this.workerCandidates(task);
    if (!selection.selected) {
      for (const entry of selection.evaluated) if (['AUTH_REQUIRED', 'CLI_NOT_FOUND', 'UNSUPPORTED_VERSION'].some((reason) => entry.reasons?.includes(reason))) {
        await this.events.emit('WORKER_AUTH_BLOCKED', { worker: entry.worker.key, reasons: entry.reasons }, { level: 'warning' });
      }
      return { started: false, blocker: selection.blocker, evaluated: selection.evaluated };
    }
    const { worker, adapter } = selection.selected;
    let session = await this.store.createSession({
      workerKey: worker.key, projectId: task.projectId, repository: task.repository, branch: task.branch,
      worktree: adapter.capabilities().worktreeManagement === 'supervisor' ? null : task.worktree || null,
      objective: task.objective, status: 'STANDBY',
    });
    ({ session, task } = await this.prepareSessionWorktree(session, task, selection.selected));
    try { await this.verifyPreparedHead(task, checkpoint, adapter); }
    catch (error) {
      if (this.releaseWorktree && task.worktree) await this.releaseWorktree(task.worktree).catch(() => {});
      throw error;
    }
    let lease;
    try {
      session = await this.store.transitionSession(session.id, 'ACQUIRING');
      lease = await this.leaseManager.acquire(session.id, this.heartbeatCallbacks(session.id, worker.key));
    } catch (error) {
      if (adapter.capabilities().worktreeManagement === 'supervisor' && this.releaseWorktree) {
        await this.releaseWorktree(task.worktree).catch(() => {});
      }
      throw error;
    }
    const checkpointer = this.makeCheckpointer(lease, task);
    const initial = this.normalizeCheckpoint(checkpoint, session, worker, task, 'ACTIVE');
    let checkpointRow;
    try { checkpointRow = await checkpointer.save(initial); }
    catch (error) {
      // The write may have reached the database before the local mirror
      // failed. Release only with a verified persisted checkpoint; otherwise
      // leave the lease to freeze rather than invent a safe handoff.
      let persisted = null;
      try { persisted = await this.store.latestValidCheckpoint?.(session.id); } catch { /* Retain the lease. */ }
      await this.store.failSession(session.id, { status: 'ABNORMAL_EXIT', reason: 'CHECKPOINT_FAILED' }).catch(() => {});
      if (persisted?.id) await this.leaseManager.release(lease, persisted.id, 'HANDOFF_READY').catch(() => {});
      await this.cleanupManagedWorktree(adapter, task);
      throw error;
    }
    const continuationPacket = buildContinuationPacket(initial, { doNotTouch: this.doNotTouch });
    let execution;
    try {
      execution = await adapter.start({ continuationPacket, worktree: task.worktree, branch: task.branch, lease, task });
      if (execution.nativeSessionId) session = await this.store.updateSession(session.id, { native_session_id: execution.nativeSessionId });
    } catch (error) {
      if (!await this.stopFailedExecution(adapter, execution, 'continuity session binding failed')) {
        await this.preserveUnconfirmedWorker(session.id, worker.key, error);
        throw new Error('WORKER_STOP_UNCONFIRMED', { cause: error });
      }
      await this.leaseManager.release(lease, checkpointRow.id, 'HANDOFF_READY');
      await this.cleanupManagedWorktree(adapter, task);
      await this.events.emit('SESSION_FAILED', { sessionId: session.id, worker: worker.key, reason: error.message }, { level: 'error' });
      await this.events.emit('WORKER_FAILED', { sessionId: session.id, worker: worker.key, code: error.code || 'WORKER_CRASHED' }, { level: 'error' });
      throw error;
    }
    const runtime = { task, worker, adapter, session, adapterSession: execution.session, lease, checkpointer, checkpoint: initial, checkpointRow };
    this.running.set(session.id, runtime);
    this.leaseManager.startHeartbeat(lease, this.heartbeatCallbacks(session.id, worker.key));
    await this.events.emit('LEASE_ACQUIRED', { sessionId: session.id, leaseId: lease.id, worker: worker.key, repository: task.repository, branch: task.branch });
    await this.events.emit('CHECKPOINT_SAVED', { sessionId: session.id, checkpointId: checkpointRow.id, reason: 'initial' });
    await this.events.emit('WORKER_STARTED', { sessionId: session.id, worker: worker.key, worktree: task.worktree });
    return { started: true, session, worker: worker.key, lease, checkpoint: checkpointRow };
  }

  async saveCheckpoint(sessionId, checkpoint, { event = 'manual', nativeCheckpointId = null } = {}) {
    const runtime = this.running.get(sessionId);
    if (!runtime) throw new Error('CONTINUITY_SESSION_NOT_RUNNING');
    const payload = this.normalizeCheckpoint(checkpoint, runtime.session, runtime.worker, runtime.task, checkpoint.status || 'ACTIVE');
    const saved = await runtime.checkpointer.maybeSave(payload, { event, nativeCheckpointId });
    if (saved.saved) {
      runtime.checkpoint = payload;
      runtime.checkpointRow = saved.row;
      await this.events.emit('CHECKPOINT_SAVED', { sessionId, checkpointId: saved.row.id, reason: saved.reason });
    }
    return saved;
  }

  async onLeaseLost(sessionId, error) {
    const runtime = this.running.get(sessionId);
    if (!runtime) return;
    let stopped = false;
    try {
      const result = await runtime.adapter.stop({ session: runtime.adapterSession, reason: 'write lease lost' });
      stopped = result?.stopped === true && result?.draining !== true;
    } catch { /* An unconfirmed stop must never be treated as safe to reclaim. */ }
    await this.store.failSession(sessionId, { status: 'ABNORMAL_EXIT', reason: stopped ? 'LEASE_LOST_STOP_CONFIRMED' : 'WORKER_STOP_UNCONFIRMED' }).catch(() => {});
    await this.events.emit('SESSION_FAILED', { sessionId, worker: runtime.worker.key, reason: error.message, stopConfirmed: stopped }, { level: 'error' }).catch(() => {});
    await this.events.emit('WORKER_FAILED', { sessionId, worker: runtime.worker.key, code: 'LEASE_LOST', stopConfirmed: stopped }, { level: 'error' }).catch(() => {});
    this.running.delete(sessionId);
  }

  async chooseNext(runtime, reason) {
    return this.workerCandidates({ ...runtime.task, excludeWorkers: [runtime.worker.key], lastWorker: runtime.worker.key, meaningfulProgress: false, session: runtime.adapterSession, handoffReason: reason });
  }

  async captureRuntimeUsage(runtime, completionStatus = null) {
    const usage = await runtime.adapter.usage({ session: runtime.adapterSession });
    const snapshot = await this.usage.capture({
      workerKey: runtime.worker.key, quotaSource: runtime.worker.quota_source, sessionId: runtime.session.id,
      basis: usage.basis, sessionPct: usage.session_pct, weeklyPct: usage.weekly_pct,
      taskTokens: usage.task_tokens, resetAt: usage.reset_at,
      raw: {
        taskId: runtime.task.id || null, repository: runtime.task.repository, branch: runtime.task.branch,
        costUsd: usage.cost_usd ?? null, turns: usage.turns ?? null, elapsedMs: usage.elapsed_ms ?? null,
        provider: usage.provider ?? null, model: usage.model ?? null,
        handoffs: this.history.entries.filter((entry) => entry.from === runtime.worker.key || entry.to === runtime.worker.key).length,
        failures: usage.failures ?? 0, checkpointCount: runtime.checkpointRow?.sequence || 1,
        completionStatus,
      },
    });
    if (usage.task_tokens != null) {
      runtime.session = await this.store.updateSession(runtime.session.id, { task_tokens: usage.task_tokens, tokens_basis: usage.basis });
    }
    return { usage, snapshot };
  }

  async handoff(sessionId, { reason, checkpoint, preferredWorker = null, pauseOnly = false, abort = false } = {}) {
    const runtime = this.running.get(sessionId);
    if (!runtime) throw new Error('CONTINUITY_SESSION_NOT_RUNNING');
    await this.events.emit('HANDOFF_REQUESTED', { sessionId, worker: runtime.worker.key, reason, pauseOnly });
    await this.store.transitionSession(sessionId, 'DRAINING');
    await this.events.emit('WORKER_DRAINING', { sessionId, worker: runtime.worker.key, reason });
    const stopped = await runtime.adapter.stop({ session: runtime.adapterSession, reason });
    if (stopped?.stopped !== true || stopped?.draining === true) throw new Error('WORKER_STOP_UNCONFIRMED');
    await this.events.emit('WORKER_STOPPED', { sessionId, worker: runtime.worker.key, reason });
    await this.store.transitionSession(sessionId, 'CHECKPOINTING');
    const adapterCheckpoint = await runtime.adapter.checkpoint({ session: runtime.adapterSession, context: { checkpoint: checkpoint || runtime.checkpoint, reason } });
    const finalPayload = this.normalizeCheckpoint(adapterCheckpoint.payload, runtime.session, runtime.worker, runtime.task, abort ? 'RELEASED' : 'HANDOFF_READY');
    finalPayload.handoff_reason = reason;
    const row = await runtime.checkpointer.save(finalPayload, { nativeCheckpointId: adapterCheckpoint.nativeCheckpointId });
    await this.events.emit('CHECKPOINT_SAVED', { sessionId, checkpointId: row.id, reason: 'handoff' });
    await this.captureRuntimeUsage(runtime, 'HANDOFF_READY').catch(() => null);
    await runtime.adapter.cleanup?.({ session: runtime.adapterSession });
    if (this.prepareTransfer) {
      try {
        await this.prepareTransfer({ runtime, checkpoint: finalPayload });
        if (runtime.adapter.capabilities().worktreeManagement === 'supervisor') runtime.task = { ...runtime.task, worktree: null };
      } catch (error) {
        await this.store.failSession(sessionId, { status: 'ABNORMAL_EXIT', reason: 'HANDOFF_WORKTREE_UNSAFE' }).catch(() => {});
        this.leaseManager.stopHeartbeat(runtime.lease);
        this.running.delete(sessionId);
        await this.events.emit('HANDOFF_FAILED', { sessionId, worker: runtime.worker.key, reason: 'HANDOFF_WORKTREE_UNSAFE' }, { level: 'warning' });
        return { handedOff: false, blocker: 'HANDOFF_WORKTREE_UNSAFE', error: error.message, checkpoint: row };
      }
    }
    if (pauseOnly || abort) {
      await this.leaseManager.release(runtime.lease, row.id, abort ? 'RELEASED' : 'HANDOFF_READY');
      if (abort) await this.store.updateSession(sessionId, { exit_reason: 'OWNER_ABORTED' });
      this.running.delete(sessionId);
      await this.events.emit('LEASE_RELEASED', { sessionId, leaseId: runtime.lease.id, checkpointId: row.id });
      return { handedOff: false, paused: !abort, aborted: abort, checkpoint: row };
    }
    const selection = await this.chooseNext(runtime, reason);
    if (preferredWorker) selection.selected = selection.evaluated.find((entry) => entry.eligible && entry.worker.key === preferredWorker) || null;
    if (!selection.selected) {
      await this.leaseManager.release(runtime.lease, row.id, 'HANDOFF_READY');
      this.running.delete(sessionId);
      await this.events.emit('HANDOFF_FAILED', { sessionId, worker: runtime.worker.key, reason: selection.blocker || 'PREFERRED_WORKER_NOT_ELIGIBLE' });
      return { handedOff: false, blocker: selection.blocker || 'PREFERRED_WORKER_NOT_ELIGIBLE', checkpoint: row };
    }
    const target = selection.selected;
    let nextSession = await this.store.createSession({
      workerKey: target.worker.key, projectId: runtime.task.projectId, repository: runtime.task.repository,
      branch: runtime.task.branch, worktree: target.adapter.capabilities().worktreeManagement === 'supervisor' ? null : runtime.task.worktree || null,
      objective: runtime.task.objective,
    });
    let targetTask = target.adapter.capabilities().worktreeManagement === 'supervisor'
      ? { ...runtime.task, worktree: null } : runtime.task;
    try {
      ({ session: nextSession, task: targetTask } = await this.prepareSessionWorktree(nextSession, targetTask, target));
      await this.verifyPreparedHead(targetTask, finalPayload, target.adapter);
    }
    catch (error) {
      if (target.adapter.capabilities().worktreeManagement === 'supervisor' && this.releaseWorktree && targetTask.worktree) {
        await this.releaseWorktree(targetTask.worktree).catch(() => {});
      }
      await this.leaseManager.release(runtime.lease, row.id, 'HANDOFF_READY');
      this.running.delete(sessionId);
      await this.events.emit('SESSION_FAILED', { sessionId: nextSession.id, worker: target.worker.key, reason: error.message }, { level: 'error' });
      await this.events.emit('HANDOFF_FAILED', { sessionId, worker: target.worker.key, reason: 'TARGET_WORKTREE_PREPARATION_FAILED' });
      return { handedOff: false, blocker: 'TARGET_WORKTREE_PREPARATION_FAILED', error: error.message, checkpoint: row };
    }
    const targetPacketPayload = this.normalizeCheckpoint(finalPayload, nextSession, target.worker, targetTask, 'ACTIVE');
    const packet = buildContinuationPacket(targetPacketPayload, { doNotTouch: this.doNotTouch });
    let handoff;
    try { handoff = await this.store.proposeHandoff({ fromSessionId: sessionId, checkpointId: row.id, reason, packet, toWorker: target.worker.key }); }
    catch (error) {
      await this.leaseManager.release(runtime.lease, row.id, 'HANDOFF_READY');
      this.running.delete(sessionId);
      await this.events.emit('HANDOFF_FAILED', { sessionId, worker: target.worker.key, reason: 'HANDOFF_PERSISTENCE_FAILED' });
      return { handedOff: false, blocker: 'HANDOFF_PERSISTENCE_FAILED', error: error.message, checkpoint: row };
    }
    await this.events.emit('HANDOFF_PROPOSED', { handoffId: handoff.id, from: runtime.worker.key, to: target.worker.key, checkpointId: row.id, reason });
    await this.leaseManager.release(runtime.lease, row.id, 'HANDOFF_READY');
    await this.events.emit('LEASE_RELEASED', { sessionId, leaseId: runtime.lease.id, checkpointId: row.id });
    let nextLease;
    let nextCheckpointer;
    let acceptedRow;
    const nextCheckpoint = this.normalizeCheckpoint(finalPayload, nextSession, target.worker, targetTask, 'ACTIVE');
    try {
      nextSession = await this.store.transitionSession(nextSession.id, 'ACQUIRING');
      nextLease = await this.leaseManager.acquire(nextSession.id, this.heartbeatCallbacks(nextSession.id, target.worker.key));
      nextCheckpointer = this.makeCheckpointer(nextLease, targetTask);
      acceptedRow = await nextCheckpointer.save(nextCheckpoint);
      await this.store.acceptHandoff(handoff.id, nextSession.id);
      await this.events.emit('HANDOFF_ACCEPTED', { handoffId: handoff.id, sessionId: nextSession.id, worker: target.worker.key });
    } catch (error) {
      if (nextLease && acceptedRow) await this.leaseManager.release(nextLease, acceptedRow.id, 'HANDOFF_READY').catch(() => {});
      await this.store.failHandoff(handoff.id).catch(() => {});
      await this.cleanupManagedWorktree(target.adapter, targetTask);
      this.running.delete(sessionId);
      await this.events.emit('HANDOFF_FAILED', { sessionId, worker: target.worker.key, reason: 'HANDOFF_ACCEPTANCE_FAILED' });
      return { handedOff: false, blocker: acceptedRow ? 'HANDOFF_ACCEPTANCE_FAILED' : 'TARGET_LEASE_OR_CHECKPOINT_FAILED', error: error.message, checkpoint: acceptedRow || row };
    }
    let execution;
    try {
      execution = await target.adapter.start({ continuationPacket: packet, worktree: targetTask.worktree, branch: targetTask.branch, lease: nextLease, task: targetTask });
      if (execution.nativeSessionId) nextSession = await this.store.updateSession(nextSession.id, { native_session_id: execution.nativeSessionId });
    } catch (error) {
      if (!await this.stopFailedExecution(target.adapter, execution, 'continuity session binding failed')) {
        await this.preserveUnconfirmedWorker(nextSession.id, target.worker.key, error);
        return { handedOff: false, blocker: 'WORKER_STOP_UNCONFIRMED', error: error.message, checkpoint: acceptedRow };
      }
      await this.leaseManager.release(nextLease, acceptedRow.id, 'HANDOFF_READY');
      await this.store.failHandoff(handoff.id).catch(() => {});
      await this.cleanupManagedWorktree(target.adapter, targetTask);
      await this.events.emit('SESSION_FAILED', { sessionId: nextSession.id, worker: target.worker.key, reason: error.message }, { level: 'error' });
      await this.events.emit('HANDOFF_FAILED', { sessionId, worker: target.worker.key, reason: 'TARGET_WORKER_START_FAILED' });
      this.running.delete(sessionId);
      return { handedOff: false, blocker: 'TARGET_WORKER_START_FAILED', error: error.message, checkpoint: acceptedRow };
    }
    const nextRuntime = { ...runtime, task: targetTask, worker: target.worker, adapter: target.adapter, session: nextSession, adapterSession: execution.session, lease: nextLease, checkpointer: nextCheckpointer, checkpoint: nextCheckpoint, checkpointRow: acceptedRow };
    this.running.delete(sessionId);
    this.running.set(nextSession.id, nextRuntime);
    this.leaseManager.startHeartbeat(nextLease, this.heartbeatCallbacks(nextSession.id, target.worker.key));
    await this.events.emit('WORKER_STARTED', { sessionId: nextSession.id, worker: target.worker.key, worktree: targetTask.worktree });
    this.history.add({ from: runtime.worker.key, to: target.worker.key, reason, lastCommit: finalPayload.last_commit, checkpointId: row.id, progress: finalPayload.last_commit !== runtime.checkpoint.last_commit });
    await this.events.emit('WORKER_SWITCHED', { from: runtime.worker.key, to: target.worker.key, fromSessionId: sessionId, toSessionId: nextSession.id });
    return { handedOff: true, from: runtime.worker.key, to: target.worker.key, session: nextSession, handoff, checkpoint: acceptedRow };
  }

  async finish(sessionId, { checkpoint, gateContext } = {}) {
    const runtime = this.running.get(sessionId);
    if (!runtime) throw new Error('CONTINUITY_SESSION_NOT_RUNNING');
    await this.store.transitionSession(sessionId, 'DRAINING');
    const stopped = await runtime.adapter.stop({ session: runtime.adapterSession, reason: 'completion gates' });
    if (stopped?.stopped !== true || stopped?.draining === true) throw new Error('WORKER_STOP_UNCONFIRMED');
    await this.events.emit('WORKER_STOPPED', { sessionId, worker: runtime.worker.key, reason: 'completion gates' });
    await this.store.transitionSession(sessionId, 'CHECKPOINTING');
    let gatePreparationError = null;
    let effectiveGateContext = { ...(gateContext || {}) };
    if (!effectiveGateContext.worktree && runtime.task.worktree) effectiveGateContext.worktree = runtime.task.worktree;
    if (!effectiveGateContext.worktree && this.prepareWorktree) {
      try {
        const prepared = await this.prepareWorktree({ session: runtime.session, task: runtime.task, worker: runtime.worker, purpose: 'verification' });
        effectiveGateContext.worktree = prepared.path;
        runtime.task = { ...runtime.task, worktree: prepared.path };
        runtime.session = await this.store.updateSession(runtime.session.id, { worktree: prepared.path });
        runtime.managedGateWorktree = true;
      } catch (error) { gatePreparationError = error; }
    }
    if (!('ciStatus' in effectiveGateContext)) effectiveGateContext.ciStatus = runtime.task.ciStatus || 'none';
    if (!('acceptance' in effectiveGateContext)) effectiveGateContext.acceptance = runtime.task.acceptance || [];
    const gates = gatePreparationError || !effectiveGateContext.worktree
      ? { ok: false, checks: [{ kind: 'environment', name: 'verification worktree', ok: false, detail: gatePreparationError?.message || 'not configured' }], failed: [{ name: 'verification worktree' }], nextExactAction: 'Prepare the verification worktree and rerun completion gates.' }
      : await this.gates(effectiveGateContext);
    let status = gates.ok ? 'COMPLETED' : 'HANDOFF_READY';
    const adapterCheckpoint = await runtime.adapter.checkpoint({ session: runtime.adapterSession, context: { checkpoint: checkpoint || runtime.checkpoint, reason: 'completion gates' } });
    const finalPayload = this.normalizeCheckpoint(adapterCheckpoint.payload, runtime.session, runtime.worker, runtime.task, status);
    if (!gates.ok) finalPayload.next_exact_action = gates.nextExactAction;
    let transferError = null;
    if (this.prepareTransfer) {
      try { await this.prepareTransfer({ runtime, checkpoint: finalPayload }); }
      catch (error) {
        transferError = error;
        gates.ok = false;
        gates.failed = [...(gates.failed || []), { name: 'publish and retire managed worktree' }];
        gates.nextExactAction = 'Resolve the managed worktree and publish its committed branch before completion.';
        status = 'HANDOFF_READY';
        finalPayload.status = status;
        finalPayload.next_exact_action = gates.nextExactAction;
      }
    }
    const row = await runtime.checkpointer.save(finalPayload, { nativeCheckpointId: adapterCheckpoint.nativeCheckpointId });
    await this.captureRuntimeUsage(runtime, status).catch(() => null);
    await runtime.adapter.cleanup?.({ session: runtime.adapterSession });
    if (transferError) {
      await this.store.failSession(sessionId, { status: 'ABNORMAL_EXIT', reason: 'HANDOFF_WORKTREE_UNSAFE' }).catch(() => {});
      this.leaseManager.stopHeartbeat(runtime.lease);
      this.running.delete(sessionId);
      await this.events.emit('SESSION_FAILED', { sessionId, worker: runtime.worker.key, blocker: 'HANDOFF_WORKTREE_UNSAFE' }, { level: 'warning' });
      return { completed: false, blocker: 'HANDOFF_WORKTREE_UNSAFE', gates, checkpoint: row };
    }
    await this.leaseManager.release(runtime.lease, row.id, status);
    this.running.delete(sessionId);
    await this.events.emit('LEASE_RELEASED', { sessionId, leaseId: runtime.lease.id, checkpointId: row.id });
    let cleanup = null;
    if (gates.ok && runtime.managedGateWorktree && this.releaseWorktree && runtime.task.worktree) {
      try { await this.releaseWorktree(runtime.task.worktree); cleanup = { ok: true }; }
      catch (error) { cleanup = { ok: false, error: error.message }; }
    }
    await this.events.emit(gates.ok ? 'SESSION_COMPLETED' : 'SESSION_FAILED', { sessionId, worker: runtime.worker.key, gates, cleanup }, { level: gates.ok ? 'success' : 'warning' });
    return { completed: gates.ok, gates, checkpoint: row, cleanup };
  }

  async tick() {
    const actions = [];
    for (const [sessionId, runtime] of [...this.running]) {
      let usage;
      try { ({ usage } = await this.captureRuntimeUsage(runtime)); }
      catch (error) {
        await this.events.emit('SESSION_FAILED', { sessionId, worker: runtime.worker.key, reason: `usage unavailable: ${error.message}` }, { level: 'warning' }).catch(() => {});
        continue;
      }
      const reported = usage.basis === 'PROVIDER_REPORTED';
      const high = Math.max(...[usage.session_pct, usage.weekly_pct].filter(Number.isFinite), 0) >= this.drainAtPct;
      if (reported && high) actions.push(await this.handoff(sessionId, { reason: 'quota warning threshold', checkpoint: runtime.checkpoint }));
    }
    return actions;
  }

  async pollStatus() {
    const actions = [];
    for (const [sessionId, runtime] of [...this.running]) {
      let status;
      try { status = await runtime.adapter.status({ session: runtime.adapterSession }); }
      catch (error) { status = { status: 'UNAVAILABLE', error: error.message }; }
      const failure = ['RATE_LIMITED', 'QUOTA_EXHAUSTED', 'AUTH_REQUIRED', 'UNAVAILABLE', 'FAILED', 'ABNORMAL_EXIT'].includes(status.status);
      const shortCooldown = status.status === 'RATE_LIMITED' && Number(status.quota?.retry_after_s) > 0 && Number(status.quota.retry_after_s) <= 120;
      if (['COMPLETED', 'CHECKPOINTING'].includes(status.status)) {
        actions.push(await this.finish(sessionId, { gateContext: { worktree: runtime.task.worktree, ciStatus: runtime.task.ciStatus || 'none', acceptance: runtime.task.acceptance || [] } }));
      } else if (failure && !shortCooldown) {
        await this.events.emit(status.status === 'AUTH_REQUIRED' ? 'WORKER_AUTH_BLOCKED' : 'WORKER_FAILED',
          { sessionId, worker: runtime.worker.key, code: status.error || status.status }, { level: 'warning' });
        actions.push(await this.handoff(sessionId, { reason: status.error || status.status, checkpoint: runtime.checkpoint }));
      }
    }
    // A restarted Supervisor may observe an unexpired lease on its first
    // pass. Re-check on the bounded 60 s status cadence so it is recovered
    // as soon as it becomes stale, without creating another polling loop.
    const recovered = await this.recoverStale();
    actions.push(...recovered.filter((entry) => entry.recovered));
    return actions;
  }

  async recoverStale() {
    const newlyFrozen = await this.leaseManager.freezeStale();
    const newIds = new Set(newlyFrozen.map((lease) => lease.id));
    const frozen = [...new Map([
      ...newlyFrozen,
      ...(await this.store.listLeases({ statuses: ['FROZEN'] })),
    ].map((lease) => [lease.id, lease])).values()];
    const recovered = [];
    for (const lease of frozen) {
      await this.events.emit('RECOVERY_STARTED', { leaseId: lease.id, sessionId: lease.session_id });
      if (newIds.has(lease.id)) await this.events.emit('LEASE_FROZEN', { leaseId: lease.id, sessionId: lease.session_id }, { level: 'warning' });
      const oldSession = await this.store.getSession(lease.session_id);
      if (!oldSession) { recovered.push({ lease, recovered: false, blocker: 'CONTINUITY_SESSION_NOT_FOUND' }); continue; }
      let stopConfirmed = oldSession?.exit_reason === 'LEASE_LOST_STOP_CONFIRMED';
      if (!stopConfirmed) {
        try { stopConfirmed = await this.confirmStopped({ session: oldSession, lease }); }
        catch { stopConfirmed = false; }
      }
      if (!stopConfirmed) {
        recovered.push({ lease, recovered: false, blocker: 'WORKER_STOP_UNCONFIRMED' });
        continue;
      }
      const checkpointRow = this.store.latestValidCheckpoint ? await this.store.latestValidCheckpoint(lease.session_id) : await this.store.latestCheckpoint(lease.session_id);
      if (!checkpointRow?.payload) { recovered.push({ lease, recovered: false, blocker: 'NO_CHECKPOINT' }); continue; }
      const verification = await this.verifyBranch(lease, checkpointRow.payload);
      if (!verification?.ok) { recovered.push({ lease, recovered: false, blocker: 'BRANCH_VERIFICATION_FAILED', verification }); continue; }
      const oldAdapter = this.adapters.get(oldSession.worker_key);
      if (oldAdapter?.capabilities().worktreeManagement === 'supervisor' && this.prepareTransfer) {
        try {
          await this.prepareTransfer({
            runtime: { task: { worktree: oldSession.worktree }, adapter: oldAdapter },
            checkpoint: { ...checkpointRow.payload, last_commit: verification.head },
          });
        } catch {
          recovered.push({ lease, recovered: false, blocker: 'RECOVERY_WORKTREE_UNSAFE' });
          continue;
        }
      }
      await this.leaseManager.reclaim(lease, { verify: async () => verification });
      await this.events.emit('LEASE_RECLAIMED', { leaseId: lease.id, sessionId: lease.session_id, head: verification.head });
      let task = {
        projectId: oldSession.project_id, repository: oldSession.repository, branch: oldSession.branch,
        worktree: oldAdapter?.capabilities().worktreeManagement === 'supervisor' ? null : oldSession.worktree,
        objective: oldSession.objective,
        dataClass: checkpointRow.payload.data_class || 'NORMAL', excludeWorkers: [oldSession.worker_key],
      };
      const selection = await this.workerCandidates(task);
      if (!selection.selected) { recovered.push({ lease, recovered: false, blocker: selection.blocker }); continue; }
      let session = await this.store.createSession({ workerKey: selection.selected.worker.key, projectId: task.projectId, repository: task.repository, branch: task.branch, worktree: task.worktree, objective: task.objective });
      try {
        ({ session, task } = await this.prepareSessionWorktree(session, task, selection.selected));
        await this.verifyPreparedHead(task, { ...checkpointRow.payload, last_commit: verification.head }, selection.selected.adapter);
      }
      catch (error) {
        if (selection.selected.adapter.capabilities().worktreeManagement === 'supervisor' && this.releaseWorktree && task.worktree) {
          await this.releaseWorktree(task.worktree).catch(() => {});
        }
        recovered.push({ lease, recovered: false, blocker: 'RECOVERY_WORKTREE_PREPARATION_FAILED', error: error.message }); continue;
      }
      const packetPayload = copyCheckpoint(checkpointRow.payload, {
        last_commit: verification.head || checkpointRow.payload.last_commit,
        decisions: [...(checkpointRow.payload.decisions || []), ...(verification.extraCommits?.length ? [`Recovered commits after checkpoint: ${verification.extraCommits.join(', ')}`] : [])],
        errors: [...(checkpointRow.payload.errors || []), 'Previous worker exited abnormally; stale lease reclaimed.'],
        status: 'ACTIVE', agent_id: selection.selected.worker.key, agent_type: selection.selected.worker.kind, session_id: session.id,
        worktree: task.worktree || null,
        next_exact_action: checkpointRow.payload.next_exact_action,
      });
      const packet = buildContinuationPacket(packetPayload, { doNotTouch: this.doNotTouch });
      const handoff = await this.store.proposeHandoff({ fromSessionId: oldSession.id, checkpointId: checkpointRow.id, reason: 'abnormal exit recovery', packet, toWorker: selection.selected.worker.key });
      let nextLease;
      let checkpointer;
      let row;
      try {
        session = await this.store.transitionSession(session.id, 'ACQUIRING');
        nextLease = await this.leaseManager.acquire(session.id, this.heartbeatCallbacks(session.id, selection.selected.worker.key));
        checkpointer = this.makeCheckpointer(nextLease, task);
        row = await checkpointer.save(packetPayload);
        await this.store.acceptHandoff(handoff.id, session.id);
      } catch (error) {
        if (nextLease && row) await this.leaseManager.release(nextLease, row.id, 'HANDOFF_READY').catch(() => {});
        await this.store.failHandoff(handoff.id).catch(() => {});
        await this.cleanupManagedWorktree(selection.selected.adapter, task);
        recovered.push({ lease, recovered: false, blocker: row ? 'RECOVERY_HANDOFF_ACCEPTANCE_FAILED' : 'RECOVERY_LEASE_OR_CHECKPOINT_FAILED', error: error.message });
        continue;
      }
      let execution;
      try {
        execution = await selection.selected.adapter.start({ continuationPacket: packet, worktree: task.worktree, branch: task.branch, lease: nextLease, task });
        if (execution.nativeSessionId) session = await this.store.updateSession(session.id, { native_session_id: execution.nativeSessionId });
      } catch (error) {
        if (!await this.stopFailedExecution(selection.selected.adapter, execution, 'continuity recovery binding failed')) {
          await this.preserveUnconfirmedWorker(session.id, selection.selected.worker.key, error);
          recovered.push({ lease, recovered: false, blocker: 'WORKER_STOP_UNCONFIRMED', error: error.message });
          continue;
        }
        await this.leaseManager.release(nextLease, row.id, 'HANDOFF_READY');
        await this.store.failHandoff(handoff.id).catch(() => {});
        await this.cleanupManagedWorktree(selection.selected.adapter, task);
        recovered.push({ lease, recovered: false, blocker: 'RECOVERY_WORKER_START_FAILED', error: error.message });
        continue;
      }
      this.running.set(session.id, { task, worker: selection.selected.worker, adapter: selection.selected.adapter, session, adapterSession: execution.session, lease: nextLease, checkpointer, checkpoint: packetPayload, checkpointRow: row });
      this.leaseManager.startHeartbeat(nextLease, this.heartbeatCallbacks(session.id, selection.selected.worker.key));
      await this.events.emit('RECOVERY_COMPLETED', { leaseId: lease.id, sessionId: session.id, worker: selection.selected.worker.key });
      recovered.push({ lease, recovered: true, session, worker: selection.selected.worker.key, verification });
    }
    return recovered;
  }

  async start() {
    if (this.started) return false;
    this.started = true;
    await this.recoverStale();
    this.statusTimer = this.scheduler.setInterval(() => this.pollStatus().catch(() => {}), this.statusIntervalMs);
    this.usageTimer = this.scheduler.setInterval(() => this.tick().catch(() => {}), this.usageIntervalMs);
    this.statusTimer?.unref?.();
    this.usageTimer?.unref?.();
    return true;
  }

  async drainForShutdown() {
    if (this.statusTimer) this.scheduler.clearInterval(this.statusTimer);
    if (this.usageTimer) this.scheduler.clearInterval(this.usageTimer);
    this.statusTimer = null;
    this.usageTimer = null;
    this.started = false;
    const results = [];
    for (const [sessionId, runtime] of [...this.running]) {
      let confirmed = false;
      try {
        const stopped = await runtime.adapter.stop({ session: runtime.adapterSession, reason: 'supervisor shutdown' });
        confirmed = stopped?.stopped === true && stopped?.draining !== true;
      } catch { /* Freeze the lease later; never infer process death. */ }
      await this.store.failSession(sessionId, { status: 'ABNORMAL_EXIT', reason: confirmed ? 'LEASE_LOST_STOP_CONFIRMED' : 'WORKER_STOP_UNCONFIRMED' }).catch(() => {});
      await this.events.emit(confirmed ? 'WORKER_STOPPED' : 'WORKER_FAILED',
        { sessionId, worker: runtime.worker.key, code: confirmed ? 'SUPERVISOR_SHUTDOWN' : 'WORKER_STOP_UNCONFIRMED' },
        { level: confirmed ? 'info' : 'warning' }).catch(() => {});
      results.push({ sessionId, confirmed });
      if (confirmed) {
        this.running.delete(sessionId);
        if (runtime.adapter.cleanup) await runtime.adapter.cleanup({ session: runtime.adapterSession }).catch(() => {});
      }
    }
    this.leaseManager.stopAll();
    return results;
  }

  stop() {
    this.leaseManager.stopAll();
    if (this.statusTimer) this.scheduler.clearInterval(this.statusTimer);
    if (this.usageTimer) this.scheduler.clearInterval(this.usageTimer);
    this.statusTimer = null;
    this.usageTimer = null;
    this.started = false;
  }

  async resumeSession(sessionId, { preferredWorker = null } = {}) {
    const previous = await this.store.getSession(sessionId);
    if (!previous || previous.status !== 'HANDOFF_READY') throw new Error('CONTINUITY_RESUME_REQUIRES_HANDOFF_READY');
    const checkpointRow = this.store.latestValidCheckpoint ? await this.store.latestValidCheckpoint(sessionId) : await this.store.latestCheckpoint(sessionId);
    if (!checkpointRow?.payload) throw new Error('CONTINUITY_RESUME_CHECKPOINT_REQUIRED');
    const blocking = (await this.store.listLeases({ repository: previous.repository, branch: previous.branch, statuses: ['ACTIVE', 'FROZEN'] }));
    if (blocking.length) throw new Error('CONTINUITY_RESUME_BRANCH_LEASED');
    let task = {
      projectId: previous.project_id, repository: previous.repository, branch: previous.branch,
      worktree: previous.worktree, objective: previous.objective,
      dataClass: checkpointRow.payload.data_class || 'NORMAL', size: 'medium', capability: 'coding',
    };
    const selection = await this.workerCandidates(task);
    if (preferredWorker) selection.selected = selection.evaluated.find((entry) => entry.eligible && entry.worker.key === preferredWorker) || null;
    if (!selection.selected) return { resumed: false, blocker: selection.blocker || 'PREFERRED_WORKER_NOT_ELIGIBLE' };
    let session = await this.store.createSession({ workerKey: selection.selected.worker.key, projectId: task.projectId, repository: task.repository, branch: task.branch,
      worktree: selection.selected.adapter.capabilities().worktreeManagement === 'supervisor' ? null : task.worktree, objective: task.objective });
    try {
      ({ session, task } = await this.prepareSessionWorktree(session, task, selection.selected));
      await this.verifyPreparedHead(task, checkpointRow.payload, selection.selected.adapter);
    } catch (error) {
      if (selection.selected.adapter.capabilities().worktreeManagement === 'supervisor' && this.releaseWorktree && task.worktree) {
        await this.releaseWorktree(task.worktree).catch(() => {});
      }
      throw error;
    }
    const payload = this.normalizeCheckpoint(checkpointRow.payload, session, selection.selected.worker, task, 'ACTIVE');
    const packet = buildContinuationPacket(payload, { doNotTouch: this.doNotTouch });
    const handoff = await this.store.proposeHandoff({ fromSessionId: previous.id, checkpointId: checkpointRow.id, reason: 'owner resume', packet, toWorker: selection.selected.worker.key });
    let lease;
    let checkpointer;
    let saved;
    try {
      session = await this.store.transitionSession(session.id, 'ACQUIRING');
      lease = await this.leaseManager.acquire(session.id, this.heartbeatCallbacks(session.id, selection.selected.worker.key));
      checkpointer = this.makeCheckpointer(lease, task);
      saved = await checkpointer.save(payload);
      await this.store.acceptHandoff(handoff.id, session.id);
    } catch (error) {
      if (lease && saved) await this.leaseManager.release(lease, saved.id, 'HANDOFF_READY').catch(() => {});
      await this.store.failHandoff(handoff.id).catch(() => {});
      await this.cleanupManagedWorktree(selection.selected.adapter, task);
      throw error;
    }
    let execution;
    try {
      const sameWorkerResume = selection.selected.worker.key === previous.worker_key
        && selection.selected.adapter.capabilities().resume === true
        && typeof checkpointRow.payload.cli_session_id === 'string';
      execution = sameWorkerResume
        ? await selection.selected.adapter.resume({
          session: { id: previous.id, worktree: task.worktree, cliSessionId: checkpointRow.payload.cli_session_id },
          continuationPacket: packet, branch: task.branch, lease, task,
        })
        : await selection.selected.adapter.start({ continuationPacket: packet, worktree: task.worktree, branch: task.branch, lease, task });
      if (execution.nativeSessionId) session = await this.store.updateSession(session.id, { native_session_id: execution.nativeSessionId });
    } catch (error) {
      if (!await this.stopFailedExecution(selection.selected.adapter, execution, 'continuity session binding failed')) {
        await this.preserveUnconfirmedWorker(session.id, selection.selected.worker.key, error);
        throw new Error('WORKER_STOP_UNCONFIRMED', { cause: error });
      }
      await this.leaseManager.release(lease, saved.id, 'HANDOFF_READY');
      await this.store.failHandoff(handoff.id).catch(() => {});
      await this.cleanupManagedWorktree(selection.selected.adapter, task);
      throw error;
    }
    this.running.set(session.id, { task, worker: selection.selected.worker, adapter: selection.selected.adapter, session, adapterSession: execution.session, lease, checkpointer, checkpoint: payload, checkpointRow: saved });
    this.leaseManager.startHeartbeat(lease, this.heartbeatCallbacks(session.id, selection.selected.worker.key));
    await this.events.emit('WORKER_STARTED', { sessionId: session.id, worker: selection.selected.worker.key, worktree: task.worktree });
    return { resumed: true, session, worker: selection.selected.worker.key, checkpoint: saved };
  }

  async requestAction(action, input = {}) {
    if (action === 'ENABLE_WORKER') {
      const adapter = this.adapters.get(input.workerKey);
      if (!adapter || adapter.capabilities().executionMode !== 'EXECUTABLE') throw new Error('CONTINUITY_WORKER_NOT_EXECUTABLE');
      const ready = await adapter.available();
      if (!ready.ok) {
        await this.events.emit('WORKER_AUTH_BLOCKED', { worker: input.workerKey, authState: ready.authState, reason: ready.reason }, { level: 'warning' });
        throw new Error(ready.reason || 'AUTH_REQUIRED');
      }
      return this.store.setWorkerEnabled(input.workerKey, true, { reason: input.reason || null });
    }
    if (action === 'DISABLE_WORKER') {
      for (const [sessionId, runtime] of [...this.running]) if (runtime.worker.key === input.workerKey) {
        const paused = await this.handoff(sessionId, { reason: 'owner disabled worker', pauseOnly: true });
        if (!paused.paused) throw new Error(paused.blocker || 'WORKER_STOP_UNCONFIRMED');
      }
      return this.store.setWorkerEnabled(input.workerKey, false, { reason: input.reason || null });
    }
    if (action === 'FORCE_CHECKPOINT') {
      const runtime = this.running.get(input.sessionId);
      if (!runtime) throw new Error('CONTINUITY_SESSION_NOT_RUNNING');
      const fromAdapter = input.checkpoint ? { payload: input.checkpoint } : await runtime.adapter.checkpoint({ session: runtime.adapterSession, context: { checkpoint: runtime.checkpoint, reason: 'owner checkpoint' } });
      return this.saveCheckpoint(input.sessionId, fromAdapter.payload, { event: 'manual', nativeCheckpointId: fromAdapter.nativeCheckpointId });
    }
    if (action === 'REQUEST_HANDOFF' || action === 'PAUSE_SESSION') return this.handoff(input.sessionId, {
      reason: input.reason || (action === 'PAUSE_SESSION' ? 'owner pause' : 'owner request'), checkpoint: input.checkpoint,
      preferredWorker: input.preferredWorker, pauseOnly: action === 'PAUSE_SESSION',
    });
    if (action === 'ABORT_SESSION') return this.handoff(input.sessionId, { reason: input.reason || 'owner abort', checkpoint: input.checkpoint, abort: true });
    if (action === 'RESUME_SESSION') return this.resumeSession(input.sessionId, { preferredWorker: input.preferredWorker });
    throw Object.assign(new Error('CONTINUITY_ACTION_UNKNOWN'), { code: 'CONTINUITY_ACTION_UNKNOWN' });
  }
}
export function supervisorEnabled(env = process.env) {
  return /^(1|true|yes)$/i.test(String(env.CONTINUITY_SUPERVISOR || ''));
}
