// Fahad Coding Agent controller.
//
// A controller-driven loop, not a single model response:
//   UNDERSTAND → PLAN → EDIT → RUN → TEST → DEBUG → FIX → RE-TEST (model turns)
//   → GATE (tests, protected paths, secrets) → COMMIT/PR → CI (→ back to DEBUG)
//   → MERGE/DEPLOY (policy) → VERIFY → REPORT
//
// Every turn ends in a durable checkpoint (plan, state, provider-neutral
// transcript, working-tree patch). Model ownership can change between turns;
// the next model receives a continuation built from that state. Tool calls go
// through the Tool Broker, so policy (AUTO / APPROVAL / DENY) and audit apply.

import { createHash, randomUUID } from 'node:crypto';
import { argumentsSha256 } from '../tool-broker/broker.js';
import { pendingToolCalls, toolResult, transcriptChars, truncate, userText } from '../model-gateway/agentic/conversation.js';
import { estimateTokens } from '../model-gateway/agentic/turn-gateway.js';
import { normalizeRouting } from '../model-gateway/agentic/routing-policy.js';
import { CODING_BROKER, MODEL_TOOL_TO_BROKER, modelToolSpecs } from './tools.js';
import { classifyChangedPaths, findSecretMaterial, redact, safeSlug } from './policy.js';
import { continuationMessage, finalReport, initialMessage, systemPrompt } from './prompts.js';

export const DEFAULT_LIMITS = Object.freeze({
  maxIterations: 120,
  maxWallClockMs: 6 * 60 * 60 * 1000,
  maxTextOnlyTurns: 3,
  maxRepeatedCalls: 4,
  maxConsecutiveToolErrors: 10,
  maxGateFailures: 6,
  maxCiRounds: 3,
  compactAtChars: 360_000,
  maxOutputTokens: 16_000,
  ciPollMs: 30_000,
  ciTimeoutMs: 45 * 60 * 1000,
  ciNoChecksGraceMs: 3 * 60 * 1000,
  deployPollMs: 20_000,
  deployTimeoutMs: 30 * 60 * 1000,
  verifyAttempts: 6,
  verifyDelayMs: 20_000,
  leaseRenewMs: 60_000,
  // When every otherwise-eligible model is only cooling down (rate limit or
  // outage with a known reset), wait for the earliest reset instead of
  // blocking the owner; longer waits block with the per-route reasons.
  maxProviderWaitMs: 20 * 60 * 1000,
  providerWaitSliceMs: 60_000,
});

class Stop extends Error {
  constructor(status, message, { code = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.status = status;
    this.code = code;
  }
}

export class CodingAgentController {
  constructor({
    store,
    gateway,
    createSandbox,
    createBroker,
    recordModelAttempt = async () => {},
    authorizedRouteIds = null,
    authorizeRoute = async () => {},
    routingFor = async () => null,
    budget = { reserve: async () => null, settle: async () => {} },
    limits = {},
    log = () => {},
    now = () => Date.now(),
    sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    env = process.env,
    build = null,
  }) {
    this.store = store;
    this.build = build;
    this.gateway = gateway;
    this.createSandbox = createSandbox;
    this.createBroker = createBroker;
    this.recordModelAttempt = recordModelAttempt;
    this.authorizedRouteIds = authorizedRouteIds;
    this.authorizeRoute = authorizeRoute;
    this.routingFor = routingFor;
    this.budget = budget;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.log = log;
    this.now = now;
    this.sleepFn = sleepFn;
    this.env = env;
  }

  // Runs one claimed session until it completes, blocks, waits for approval,
  // is cancelled, or loses its lease. Always leaves a resumable checkpoint.
  async run(claimed) {
    const run = new SessionRun(this, claimed);
    return run.execute();
  }
}

class SessionRun {
  constructor(controller, session) {
    this.c = controller;
    this.session = { ...session };
    this.config = normalizeConfig(session.config || {});
    this.state = normalizeState(session.state || {});
    this.plan = Array.isArray(session.plan) ? session.plan : [];
    this.transcript = { messages: [], segmentRoute: null, pending: null };
    this.leaseLost = false;
    this.cancelRequested = false;
    this.textOnlyTurns = 0;
    this.consecutiveToolErrors = 0;
    this.recentCalls = [];
    this.runStartedAt = controller.now();
  }

  async event(type, message, payload = {}, level = 'info') {
    await this.c.store.appendEvent(this.session.id, { type, level, message: redact(message, this.c.env, 1900), payload });
  }

  async execute() {
    const heartbeat = setInterval(() => { this.renew().catch(() => {}); }, this.c.limits.leaseRenewMs);
    heartbeat.unref?.();
    try {
      await this.restore();
      await this.prepareSandbox();
      await this.loop();
      return { status: 'completed' };
    } catch (error) {
      return this.stop(error);
    } finally {
      clearInterval(heartbeat);
    }
  }

  async renew() {
    const lease = await this.c.store.renewLease(this.session);
    if (!lease.ok) this.leaseLost = true;
    if (lease.cancelRequested) this.cancelRequested = true;
    return lease;
  }

  async stop(error) {
    if (error?.code === 'AGENT_LEASE_LOST' || this.leaseLost) {
      this.c.log(`session ${this.session.id}: lease lost; another worker owns it now`);
      return { status: 'lease_lost' };
    }
    const stop = error instanceof Stop ? error
      : new Stop('blocked', `Unexpected controller error: ${redact(error?.message || String(error), this.c.env, 500)}`, { code: 'CONTROLLER_ERROR', cause: error });
    try {
      await this.checkpoint(stop.status === 'awaiting_approval' ? 'approval' : 'blocked');
    } catch (checkpointError) {
      if (checkpointError?.code === 'AGENT_LEASE_LOST') return { status: 'lease_lost' };
    }
    const level = stop.status === 'failed' ? 'error' : 'warning';
    await this.event(stop.status === 'awaiting_approval' ? 'approval' : 'guard', stop.message, { status: stop.status, code: stop.code }, level);
    const result = stop.status === 'cancelled' || stop.status === 'failed'
      ? { summary: stop.message, report: finalReport({ session: this.session, state: this.state, status: stop.status, summary: stop.message }) }
      : null;
    await this.c.store.finish(this.session, { status: stop.status, blocker: stop.message, errorCode: stop.code, result });
    return { status: stop.status, blocker: stop.message };
  }

  // ------------------------------------------------------------------ state
  async restore() {
    const checkpoint = await this.c.store.latestCheckpoint(this.session.id);
    if (checkpoint?.transcript) {
      this.transcript = {
        messages: checkpoint.transcript.messages || [],
        segmentRoute: checkpoint.transcript.segmentRoute || null,
        pending: checkpoint.transcript.pending || null,
        worktreePatch: checkpoint.transcript.worktreePatch || null,
      };
      this.state = normalizeState(checkpoint.state || this.state);
      this.plan = checkpoint.plan || this.plan;
      await this.event('session', `Resumed from checkpoint ${checkpoint.sequence} (${checkpoint.reason}) by worker ${this.session.leaseOwner || 'unknown'}.`,
        { sequence: checkpoint.sequence, phase: checkpoint.phase || this.session.phase, iteration: this.session.iteration, ...this.workerInfo() });
    } else {
      this.transcript.messages = [userText(initialMessage(this.session))];
      await this.event('session', `Coding Agent session started by worker ${this.session.leaseOwner || 'unknown'}.`, { repository: this.session.repository, ...this.workerInfo() });
    }
    this.state.resumes = (this.state.resumes || 0) + (checkpoint ? 1 : 0);
  }

  workerInfo() {
    return { worker: this.session.leaseOwner || null, ...(this.c.build ? { build: this.c.build } : {}) };
  }

  async prepareSandbox() {
    this.sandbox = await this.c.createSandbox(this.session);
    const workBranch = this.session.workBranch || `fahad/${safeSlug(this.session.title, 32)}-${this.session.id.slice(0, 8)}`;
    this.session.workBranch = workBranch;
    const existed = await this.sandbox.exists();
    const token = this.c.env.CODING_GITHUB_TOKEN || null;
    const remoteBranch = this.state.git.pushedHead ? workBranch : this.session.baseBranch;
    const prepared = await this.sandbox.prepare({
      repository: this.session.repository, baseBranch: remoteBranch, workBranch, token, fetchUrl: this.config.fetchUrl,
    });
    if (!existed && this.transcript.worktreePatch) {
      const applied = await this.sandbox.applyPatch(this.transcript.worktreePatch);
      await this.event('session', applied ? 'Working tree restored from the durable checkpoint patch.' : 'Checkpoint patch could not be re-applied; continuing from the last pushed state.', {}, applied ? 'info' : 'warning');
    }
    if (!this.state.git.baseHead) this.state.git.baseHead = prepared.head;
    this.broker = this.c.createBroker(this.session, this.sandbox);
    this.testCommand = this.config.testCommand ?? await detectTestCommand(this.sandbox);
    await this.refreshGitState();
    await this.event('session', `Sandbox ready on ${workBranch} (${existed ? 'existing worktree' : 'fresh clone'}).`, { branch: workBranch, head: prepared.head, testCommand: this.testCommand });
  }

  async refreshGitState() {
    const git = await this.sandbox.gitState();
    this.state.git = { ...this.state.git, branch: git.branch, head: git.head };
    const changed = git.changed.map((entry) => entry.path);
    const committed = this.state.git.baseHead ? await this.sandbox.changedPathsSince(this.state.git.baseHead).catch(() => []) : [];
    this.state.filesChanged = [...new Set([...committed, ...changed])].sort();
    return git;
  }

  async checkpoint(reason) {
    const patch = await this.sandbox?.fullPatch().catch(() => null);
    const sequence = await this.c.store.saveCheckpoint(this.session, {
      reason,
      patch: {
        phase: this.session.phase,
        plan: this.plan,
        state: this.state,
        next_action: this.session.nextAction || null,
        current_route: this.session.currentRoute || undefined,
        previous_route: this.session.previousRoute || undefined,
        provider_switches: this.session.providerSwitches,
        iteration: this.session.iteration,
        spent_usd: roundUsd(this.session.spentUsd),
        tokens_in: this.session.tokensIn,
        tokens_out: this.session.tokensOut,
        work_branch: this.session.workBranch || undefined,
      },
      transcript: { messages: this.transcript.messages, segmentRoute: this.transcript.segmentRoute, pending: this.transcript.pending, worktreePatch: patch },
      gitHead: this.state.git.head,
    });
    return sequence;
  }

  guard() {
    if (this.leaseLost) throw Object.assign(new Error('AGENT_LEASE_LOST'), { code: 'AGENT_LEASE_LOST' });
    if (this.cancelRequested) throw new Stop('cancelled', 'Cancelled by the owner.', { code: 'CANCELLED' });
    if (this.session.iteration >= this.c.limits.maxIterations) {
      throw new Stop('blocked', `Iteration limit (${this.c.limits.maxIterations}) reached without completion. Review the progress and resume to continue.`, { code: 'ITERATION_LIMIT' });
    }
    if (this.c.now() - this.runStartedAt > this.c.limits.maxWallClockMs) {
      throw new Stop('blocked', 'Wall-clock limit reached. Resume the session to continue.', { code: 'WALL_CLOCK_LIMIT' });
    }
    if (this.session.spentUsd >= this.session.budgetUsd) {
      throw new Stop('blocked', `Session budget of $${this.session.budgetUsd} is exhausted. Raise the budget and resume to continue.`, { code: 'BUDGET_EXHAUSTED' });
    }
  }

  async setPhase(phase) {
    if (this.session.phase === phase) return;
    this.session.phase = phase;
    await this.event('phase', `Phase: ${phase}`, { phase });
  }

  // ------------------------------------------------------------------ loop
  async loop() {
    for (;;) {
      this.guard();
      const phase = this.session.phase;
      if (['understand', 'plan', 'implement', 'test', 'debug', 'review'].includes(phase)) {
        const finished = await this.agentStep();
        if (finished) await this.setPhase(this.state.noChanges ? 'report' : this.config.publish === 'none' ? 'report' : 'publish');
        await this.checkpoint('turn');
      } else if (phase === 'publish') {
        await this.publish();
        await this.setPhase(this.config.publish === 'pull_request' && this.config.waitForCi ? 'ci' : 'report');
        await this.checkpoint('phase');
      } else if (phase === 'ci') {
        const ok = await this.watchCi();
        await this.setPhase(ok ? (this.config.deploy.mode === 'merge' ? 'deploy' : 'report') : 'debug');
        await this.checkpoint('phase');
      } else if (phase === 'deploy') {
        await this.deploy();
        await this.setPhase(this.config.verify.url ? 'verify' : 'report');
        await this.checkpoint('phase');
      } else if (phase === 'verify') {
        await this.verify();
        await this.setPhase('report');
        await this.checkpoint('phase');
      } else if (phase === 'report' || phase === 'done') {
        await this.complete();
        return;
      } else {
        throw new Stop('failed', `Unknown phase ${phase}`, { code: 'PHASE_INVALID' });
      }
    }
  }

  // One model turn plus execution of the requested tool calls. Returns true
  // when the model called finish and the gate passed.
  async agentStep() {
    // Finish any tool calls interrupted by an approval wait or a restart.
    if (this.transcript.pending) {
      const finished = await this.executeToolCalls(this.transcript.pending.calls, this.transcript.pending.results);
      if (finished) return true;
      if (this.transcript.pending === null) return false;
    }
    const tools = modelToolSpecs({ supabase: this.config.supabase.projects.length > 0 });
    const system = systemPrompt({
      repository: this.session.repository, baseBranch: this.session.baseBranch, workBranch: this.session.workBranch,
      testCommand: this.testCommand, supabaseProjects: this.config.supabase.projects, verifyHosts: this.config.verify.hosts,
    });
    if (transcriptChars(this.transcript.messages) > this.c.limits.compactAtChars) await this.compact();
    const estimatedInputTokens = estimateTokens(system, this.transcript.messages, tools);
    const policy = await this.c.routingFor(this.session, this.config.routing) || {};
    const routing = {
      requiresPrivateData: this.config.privateData,
      estimatedInputTokens,
      remainingBudgetUsd: Math.max(0, this.session.budgetUsd - this.session.spentUsd),
      authorizedRouteIds: policy.authorizedRouteIds || this.c.authorizedRouteIds,
      allowPaid: this.config.allowPaid && policy.allowPaid !== false,
      billingPriority: policy.billingPriority,
      strategy: policy.strategy,
      effort: policy.effort,
      policyExcludedRouteIds: policy.excludedRoutes || [],
      budgetExhaustedRouteIds: policy.exhaustedRoutes || [],
    };
    let prepared = null;
    let response;
    try {
      response = await this.c.gateway.turn({
        tools,
        preferredRouteId: this.transcript.segmentRoute || this.session.currentRoute || null,
        maxOutputTokens: this.c.limits.maxOutputTokens,
        routing,
        prepare: async (route) => {
          if (this.transcript.segmentRoute === route.id || (!this.transcript.segmentRoute && !this.transcript.handedOff)) {
            prepared = { messages: this.transcript.messages, handoff: false };
          } else {
            prepared = {
              handoff: true,
              messages: [userText(continuationMessage({
                session: this.session, state: this.state, plan: this.plan, nextAction: this.session.nextAction,
                recentMessages: this.transcript.messages.slice(-24), reason: 'model handoff',
                fromRoute: this.transcript.segmentRoute, toRoute: route.id,
              }))],
            };
          }
          return { system, messages: prepared.messages };
        },
        hooks: {
          authorize: (route) => this.c.authorizeRoute(route, this.session),
          reserve: (request) => this.c.budget.reserve(this.session, request),
          settle: (reservation, actualUsd) => this.c.budget.settle(this.session, reservation, actualUsd),
          onSwitch: async ({ from, to, reason }) => {
            this.session.previousRoute = from;
            this.session.providerSwitches += 1;
            this.state.switches.push({ from, to, reason: reason.code, at: new Date(this.c.now()).toISOString(), iteration: this.session.iteration });
            await this.checkpoint('provider_switch');
            await this.event('provider_switch', `Model switch ${from || 'none'} → ${to} (${reason.code}). Checkpoint saved; the new model continues the same task.`,
              { from, to, reason }, 'warning');
          },
          onAttempt: (attempt) => this.c.recordModelAttempt(this.session, attempt),
          beforeCall: ({ route }) => this.maybeInjectDrill(route),
        },
      });
    } catch (error) {
      if (!['NO_ELIGIBLE_PROVIDER', 'ALL_PROVIDERS_UNAVAILABLE'].includes(error?.code)) throw error;
      return this.noEligibleModel(error, routing);
    }

    // Adopt the route and, after a handoff, the rendered continuation.
    if (prepared?.handoff) {
      this.transcript.messages = prepared.messages;
      this.transcript.handedOff = true;
    }
    this.transcript.segmentRoute = response.route.id;
    if (this.session.currentRoute !== response.route.id) {
      if (this.session.currentRoute) this.session.previousRoute = this.session.currentRoute;
      this.session.currentRoute = response.route.id;
    }
    if (!this.state.routesUsed.includes(response.route.id)) this.state.routesUsed.push(response.route.id);
    this.session.spentUsd += Number(response.usage.costUsd || 0);
    for (const attempt of response.attempts) {
      if (attempt.status === 'failed') this.session.spentUsd += Number(attempt.usage?.costUsd || 0);
    }
    this.session.tokensIn += Number(response.usage.inputTokens || 0);
    this.session.tokensOut += Number(response.usage.outputTokens || 0);
    this.session.iteration += 1;
    this.transcript.messages.push(response.message);
    const calls = response.message.content.filter((block) => block.type === 'tool_call');
    const said = response.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
    await this.event('model_turn', said ? truncate(said, 600) : `${calls.length} tool call(s)`, {
      route: response.route.id, iteration: this.session.iteration, toolCalls: calls.map((call) => call.name),
      inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, costUsd: response.usage.costUsd,
    });

    if (!calls.length) {
      this.textOnlyTurns += 1;
      if (this.textOnlyTurns >= this.c.limits.maxTextOnlyTurns) {
        throw new Stop('blocked', 'The model stopped calling tools without finishing. Resume to retry with a fresh turn.', { code: 'NO_PROGRESS' });
      }
      this.transcript.messages.push(userText(response.stopReason === 'max_tokens'
        ? 'Your response was cut off. Continue, using tools.'
        : 'Continue the task using the tools. Call finish when the objective is fully implemented and verified, or request_human if genuinely blocked.'));
      return false;
    }
    this.textOnlyTurns = 0;
    return this.executeToolCalls(calls, []);
  }

  // Controlled failover drill (session config `drill.failoverAfterIteration`):
  // once the task has made that many model turns, the next call to the model
  // that owns the task fails ONCE with a labelled, recoverable rate limit at
  // the routing boundary. The gateway then checkpoints and hands the SAME task
  // to the next eligible model. The drill never touches provider health.
  async maybeInjectDrill(route) {
    const drill = this.config.drill;
    if (!drill || this.state.drill?.fired) return;
    if (this.session.iteration < drill.failoverAfterIteration) return;
    if (!this.transcript.segmentRoute || route.id !== this.transcript.segmentRoute) return;
    this.state.drill = { fired: true, route: route.id, iteration: this.session.iteration, at: new Date(this.c.now()).toISOString() };
    await this.event('provider_switch', `Controlled failover drill: injected ONE recoverable rate-limit failure for ${route.id} after ${this.session.iteration} model turns (not a real provider error).`,
      { drill: true, route: route.id, iteration: this.session.iteration, injected: true }, 'warning');
    throw Object.assign(new Error('Controlled failover drill: injected rate limit'), {
      status: 429, type: 'rate_limit_error', retryAfter: '600', injected: true, code: 'DRILL_INJECTED_RATE_LIMIT',
    });
  }

  // No model can take the next turn. If the only obstacle is cooldowns with a
  // known reset, wait for the earliest one (checkpointed, lease kept alive);
  // otherwise block with the reason for every route.
  async noEligibleModel(error, routing) {
    const evaluations = await this.c.gateway.evaluate({ ...routing, maxOutputTokens: this.c.limits.maxOutputTokens }).catch(() => []);
    const nowMs = this.c.now();
    const waitable = evaluations.filter((entry) => entry.reasons.length && entry.reasons.every((reason) => reason.startsWith('COOLDOWN_')));
    const resets = waitable.map((entry) => Date.parse(entry.state?.cooldownUntil || '')).filter((value) => Number.isFinite(value) && value > nowMs);
    const summary = evaluations.length
      ? evaluations.map((entry) => `${entry.route.id}: ${entry.reasons.join(', ') || 'eligible'}`).join('; ')
      : (error.evaluations || []).map((entry) => `${entry.id}: ${entry.reasons.join(', ')}`).join('; ');
    if (resets.length) {
      const waitMs = Math.min(...resets) - nowMs + 1000;
      if (waitMs <= this.c.limits.maxProviderWaitMs) {
        await this.event('guard', `All eligible models are cooling down; waiting ${Math.ceil(waitMs / 1000)}s for the earliest reset, then continuing the same task.`,
          { waiting: true, waitMs, routes: waitable.map((entry) => ({ id: entry.route.id, until: entry.state?.cooldownUntil || null })) }, 'warning');
        await this.checkpoint('waiting');
        const until = nowMs + waitMs;
        while (this.c.now() < until) {
          this.guard();
          await this.c.sleepFn(Math.min(this.c.limits.providerWaitSliceMs, until - this.c.now()));
        }
        return false;
      }
    }
    const lastFailure = (error.attempts || []).filter((attempt) => attempt.status === 'failed').at(-1);
    const detail = lastFailure ? ` Last failure: ${lastFailure.route.id} ${lastFailure.error?.code || 'error'}.` : '';
    throw new Stop('blocked', `No model can take the next turn (${error.code}).${detail} Per route: ${truncate(summary, 1500)}`, { code: error.code });
  }

  async executeToolCalls(calls, doneResults) {
    const results = [...doneResults];
    let finished = false;
    for (const call of calls) {
      if (results.some((result) => result.callId === call.id)) continue;
      this.transcript.pending = { calls, results };
      const outcome = await this.executeToolCall(call);
      results.push(outcome.block);
      if (outcome.finished) finished = true;
    }
    this.transcript.pending = null;
    const nudges = this.noProgressNudges(calls, results);
    this.transcript.messages.push({ role: 'user', content: [...results, ...nudges.map((note) => ({ type: 'text', text: note }))] });
    return finished;
  }

  noProgressNudges(calls, results) {
    const notes = [];
    for (const call of calls) {
      const signature = createHash('sha256').update(`${call.name}:${JSON.stringify(call.arguments || {})}`).digest('hex');
      this.recentCalls.push(signature);
    }
    this.recentCalls = this.recentCalls.slice(-12);
    const last = this.recentCalls.at(-1);
    const repeats = this.recentCalls.filter((signature) => signature === last).length;
    if (repeats >= this.c.limits.maxRepeatedCalls + 2) {
      throw new Stop('blocked', 'No-progress guard: the same tool call keeps repeating. Resume after reviewing the session.', { code: 'NO_PROGRESS' });
    }
    if (repeats >= this.c.limits.maxRepeatedCalls) notes.push('Controller note: you are repeating the same action without progress. Change approach, re-read the relevant files, or record what is blocking you.');
    const errors = results.filter((result) => result.isError).length;
    this.consecutiveToolErrors = errors === results.length && results.length ? this.consecutiveToolErrors + errors : 0;
    if (this.consecutiveToolErrors >= this.c.limits.maxConsecutiveToolErrors) {
      throw new Stop('blocked', 'Too many consecutive tool errors. Resume after reviewing the session events.', { code: 'TOOL_ERROR_LIMIT' });
    }
    return notes;
  }

  async executeToolCall(call) {
    const args = call.arguments && typeof call.arguments === 'object' && !call.arguments.__invalid_json ? call.arguments : null;
    if (!args) return { block: toolResult(call, 'INVALID_ARGUMENTS: arguments were not valid JSON. Retry with a JSON object.', { isError: true }) };
    switch (call.name) {
      case 'update_plan': {
        this.plan = (Array.isArray(args.steps) ? args.steps : []).slice(0, 40).map((step) => ({
          title: String(step?.title || '').slice(0, 300), status: ['pending', 'in_progress', 'done'].includes(step?.status) ? step.status : 'pending',
        })).filter((step) => step.title);
        this.session.nextAction = String(args.next_action || '').slice(0, 2000) || null;
        if (['understand', 'plan'].includes(this.session.phase)) await this.setPhase('implement');
        await this.event('plan', `Plan updated (${this.plan.length} steps). Next: ${this.session.nextAction || 'n/a'}`, { plan: this.plan });
        return { block: toolResult(call, 'Plan recorded.') };
      }
      case 'record_note': {
        const note = String(args.note || '').trim().slice(0, 600);
        if (note) this.state.notes = [...this.state.notes, note].slice(-40);
        await this.event('note', note);
        return { block: toolResult(call, 'Noted.') };
      }
      case 'request_human': {
        throw new Stop('blocked', `Agent needs the owner: ${String(args.reason || '').slice(0, 800)} — ${String(args.question || '').slice(0, 1200)}`, { code: 'HUMAN_INPUT_REQUIRED' });
      }
      case 'finish':
        return this.finishGate(call, args);
      default:
        return this.brokerToolCall(call, args);
    }
  }

  async brokerToolCall(call, args) {
    const mapping = MODEL_TOOL_TO_BROKER[call.name];
    if (!mapping) return { block: toolResult(call, `UNKNOWN_TOOL: ${call.name} is not available.`, { isError: true }) };
    const outcome = await this.invoke(mapping.tool, mapping.action, args, { callId: call.id, allowApproval: true });
    if (outcome.approvalRejected) return { block: toolResult(call, `The owner rejected this action${outcome.note ? `: ${outcome.note}` : ''}. Choose another approach.`, { isError: true }) };
    if (outcome.error) {
      await this.event('tool_result', `${call.name} failed: ${outcome.error}`, { tool: mapping.tool, error: outcome.code }, 'warning');
      return { block: toolResult(call, `${outcome.code}: ${outcome.error}`, { isError: true }) };
    }
    await this.observe(mapping.tool, args, outcome);
    const toolError = outcome.structured?.error;
    await this.event('tool_result', `${call.name}${toolError ? ` → ${toolError}` : ' ok'}`, summarizeToolEvent(mapping.tool, args, outcome), toolError ? 'warning' : 'info');
    return { block: toolResult(call, truncate(outcome.text, 20_000), { isError: Boolean(toolError) }) };
  }

  // Calls a catalog tool through the Tool Broker with approval handling.
  async invoke(tool, action, args, { callId = randomUUID(), allowApproval = true } = {}) {
    const context = {
      workspaceId: this.session.workspaceId, jobId: this.session.jobId, taskId: this.session.taskId,
      runId: this.session.runId, agentId: this.session.agentId,
    };
    const idempotencyKey = `${this.session.id}:${callId}`.slice(0, 480);
    let approval = null;
    const existing = await this.c.store.findApproval(this.session.id, callId);
    if (existing?.status === 'approved') approval = { id: existing.id, callId, sessionId: this.session.id };
    else if (existing?.status === 'rejected') return { approvalRejected: true, note: existing.note };
    await this.event('tool_call', `${tool}`, { tool, action, args: previewArgs(args) });
    try {
      const result = await this.broker.execute({ context, broker: CODING_BROKER, tool, action, arguments: args, idempotencyKey, approval });
      const text = (result.content || []).filter((item) => item.type === 'text').map((item) => item.text).join('\n');
      // A replay (same idempotency key, already succeeded) proves the call
      // happened but carries no result; callers re-read state when needed.
      return { text: redact(text, this.c.env, 60_000), structured: result.structuredContent || {}, replayed: Boolean(result.replayed) };
    } catch (error) {
      if (error?.code === 'TOOL_APPROVAL_REQUIRED' && allowApproval) {
        const summary = approvalSummary(tool, args);
        const approvalId = await this.c.store.requestApproval(this.session, {
          callId, broker: CODING_BROKER, tool, action, risk: riskOf(tool), summary,
          argumentsSha256: argumentsSha256(args), preview: previewArgs(args),
        });
        throw new Stop('awaiting_approval', `Waiting for owner approval: ${summary}`, { code: 'APPROVAL_REQUIRED', cause: { approvalId } });
      }
      if (error?.code === 'AGENT_LEASE_LOST') throw error;
      const code = /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.code || '') ? error.code : 'TOOL_FAILED';
      return { error: redact(error?.message || 'Tool failed', this.c.env, 1500), code };
    }
  }

  async observe(tool, args, outcome) {
    if (tool === 'repo.read' && args.path) {
      this.state.filesInspected = [...new Set([...this.state.filesInspected, String(args.path)])].slice(-200);
    }
    if (tool === 'repo.write' || tool === 'repo.edit') {
      this.state.filesChanged = [...new Set([...this.state.filesChanged, String(args.path)])].sort();
    }
    if (tool === 'shell.run') {
      const command = String(args.command || '');
      if (looksLikeTest(command, this.testCommand)) {
        // A wrapper such as `; echo "exit=$?"` masks the test runner's exit
        // code; the runner's own failure summary still counts as a failure.
        const reported = reportedTestFailures(outcome.text);
        const exitCode = outcome.structured.exitCode === 0 && reported > 0 ? 1 : outcome.structured.exitCode;
        const masked = exitCode !== outcome.structured.exitCode;
        this.state.lastTest = { command, exitCode, at: new Date(this.c.now()).toISOString(), output: truncate(outcome.text, 4000), ...(masked ? { failures: reported } : {}) };
        await this.event('test', `${command} → ${masked ? `${reported} failing (shell exit 0 masked the failure)` : `exit ${exitCode}`}`,
          { exitCode, ...(masked ? { failures: reported, shellExitCode: 0 } : {}) }, exitCode === 0 ? 'success' : 'warning');
        if (exitCode !== 0 && ['implement', 'test'].includes(this.session.phase)) await this.setPhase('debug');
        else if (exitCode === 0 && this.session.phase === 'implement') await this.setPhase('test');
      }
    }
  }

  // ------------------------------------------------------------------ gate
  async finishGate(call, args) {
    this.state.finishSummary = String(args.summary || '').slice(0, 4000);
    const git = await this.refreshGitState();
    const changedPaths = this.state.filesChanged;
    const classification = classifyChangedPaths(changedPaths);
    const failures = [];
    if (classification.hermes.length) failures.push(`Hermes paths were modified and must be reverted: ${classification.hermes.join(', ')}`);
    if (classification.protected.length && !this.config.allowProtectedPaths) {
      failures.push(`Protected paths changed without task permission: ${classification.protected.join(', ')}. Revert them or explain why they are required.`);
    }
    const diff = (await this.sandbox.fullPatch(4_000_000)) || (await this.sandbox.diff({ maxBytes: 4_000_000 })).diff;
    const secret = findSecretMaterial(diff, this.c.env);
    if (secret) failures.push(`Secret scan failed (${secret}). Remove credential material from the change.`);
    let testOutcome = null;
    if (!failures.length && this.testCommand && changedPaths.length) {
      await this.setPhase('test');
      testOutcome = await this.invoke('shell.run', 'execute', { command: this.testCommand, timeout_seconds: 1800 }, { callId: `gate-${this.session.iteration}-${randomUUID().slice(0, 8)}` });
      if (testOutcome.error) failures.push(`Test gate could not run: ${testOutcome.error}`);
      else {
        this.state.lastTest = { command: this.testCommand, exitCode: testOutcome.structured.exitCode, at: new Date(this.c.now()).toISOString(), output: truncate(testOutcome.text, 4000) };
        await this.event('test', `Gate: ${this.testCommand} → exit ${testOutcome.structured.exitCode}`, { exitCode: testOutcome.structured.exitCode, gate: true },
          testOutcome.structured.exitCode === 0 ? 'success' : 'warning');
        if (testOutcome.structured.exitCode !== 0) failures.push(`Test gate failed (${this.testCommand}, exit ${testOutcome.structured.exitCode}):\n${truncate(testOutcome.text, 12_000)}`);
      }
    }
    if (failures.length) {
      this.state.gateFailures += 1;
      this.state.lastGateFailure = failures.join('\n\n');
      if (this.state.gateFailures >= this.c.limits.maxGateFailures) {
        throw new Stop('blocked', `The finish gate failed ${this.state.gateFailures} times. Last failure: ${truncate(this.state.lastGateFailure, 1500)}`, { code: 'GATE_LIMIT' });
      }
      await this.setPhase('debug');
      return { block: toolResult(call, `GATE FAILED — the task is not finished:\n${this.state.lastGateFailure}\nFix these problems, then call finish again.`, { isError: true }) };
    }
    this.state.noChanges = changedPaths.length === 0;
    this.state.gate = { passedAt: new Date(this.c.now()).toISOString(), head: git.head, testCommand: this.testCommand, tested: Boolean(testOutcome) };
    this.state.lastGateFailure = null;
    await this.event('test', this.state.noChanges ? 'Finish accepted with no repository changes.' : 'Finish gate passed.', { gate: this.state.gate }, 'success');
    return { block: toolResult(call, 'Gate passed. The controller will now publish and follow CI.'), finished: true };
  }

  // ------------------------------------------------------------------ publish / CI
  async publish() {
    const message = `${this.session.title}\n\n${truncate(this.state.finishSummary || '', 3000)}\n\nFahad AI Office Coding Agent session ${this.session.id}`;
    const commit = await this.required('git.commit', 'write', { message }, 'commit');
    await this.refreshGitState();
    const head = commit.structured.head || this.state.git.head;
    await this.event('git', commit.structured.committed ? `Committed ${head.slice(0, 7)}.` : `Nothing new to commit; head ${head.slice(0, 7)}.`, { head });
    if (this.config.publish === 'none') return;
    await this.required('git.push', 'publish', {
      branch: this.session.workBranch, expected_head: head, ...(this.state.git.pushedHead ? { previous_head: this.state.git.pushedHead } : {}),
    }, 'push');
    this.state.git.pushedHead = head;
    await this.event('github', `Pushed ${this.session.workBranch} at ${head.slice(0, 7)}.`, { branch: this.session.workBranch, head });
    if (this.config.publish === 'pull_request') {
      const body = [
        `Automated change by the Fahad AI Office Coding Agent (session \`${this.session.id}\`).`,
        '',
        '## Objective',
        truncate(this.session.objective, 3000),
        '',
        '## Summary',
        truncate(this.state.finishSummary || '', 3000),
        '',
        `Test gate: \`${this.testCommand || 'none'}\` → ${this.state.lastTest ? `exit ${this.state.lastTest.exitCode}` : 'not run'}`,
        `Models: ${this.state.routesUsed.join(', ')} · Switches: ${this.session.providerSwitches}`,
      ].join('\n');
      const prArgs = { branch: this.session.workBranch, base: this.session.baseBranch, title: this.session.title.slice(0, 200), body };
      let pr = await this.required('github.pr_create', 'publish', prArgs, 'pull request');
      // After a restart the create call is replayed without its result; asking
      // again is safe because an open PR for the branch is reused, not duplicated.
      if (!pr.structured.number) pr = await this.required('github.pr_create', 'publish', prArgs, 'pull request', { fresh: true });
      this.state.pr = { number: pr.structured.number, url: pr.structured.url };
      await this.event('github', `${pr.structured.reused ? 'Updated' : 'Opened'} pull request #${pr.structured.number}.`, this.state.pr, 'success');
    }
  }

  // Controller-owned tool call that must succeed. Writes use a deterministic
  // idempotency key (exactly once, even across restarts); polls pass
  // `fresh: true` so every poll really executes instead of replaying.
  async required(tool, action, args, label, { fresh = false } = {}) {
    const base = `${tool}-${this.session.iteration}-${createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 12)}`;
    const outcome = await this.invoke(tool, action, args, { callId: fresh ? `${base}-${randomUUID().slice(0, 8)}` : base });
    if (outcome.approvalRejected) throw new Stop('blocked', `The owner rejected the ${label}.`, { code: 'APPROVAL_REJECTED' });
    if (outcome.error || outcome.structured?.error) {
      const code = outcome.code || outcome.structured.error;
      const hint = code === 'TOOL_SECRET_UNAVAILABLE' ? ' (the Coding Agent credential for this integration is not configured)' : '';
      throw new Stop('blocked', `Could not complete the ${label}: ${outcome.error || outcome.text}${hint}`, { code });
    }
    return outcome;
  }

  async watchCi() {
    const sha = this.state.git.pushedHead;
    const started = this.c.now();
    for (;;) {
      this.guard();
      const status = await this.required('github.ci_status', 'read', { sha }, 'CI status check', { fresh: true });
      const ci = status.structured;
      this.state.ci = { sha, state: ci.state, failing: ci.failing, total: ci.total, checkedAt: new Date(this.c.now()).toISOString() };
      if (ci.state === 'success') {
        await this.event('ci', `CI passed on ${sha.slice(0, 7)} (${ci.total} checks).`, this.state.ci, 'success');
        return true;
      }
      if (ci.state === 'pending' && ci.total === 0 && this.c.now() - started > this.c.limits.ciNoChecksGraceMs) {
        this.state.ci.state = 'none';
        await this.event('ci', 'No CI checks were reported for this commit; continuing without CI.', this.state.ci, 'warning');
        return true;
      }
      if (ci.state === 'failure') {
        this.state.ciRounds += 1;
        await this.event('ci', `CI failed on ${sha.slice(0, 7)}: ${ci.failing.join(', ')}`, this.state.ci, 'warning');
        if (this.state.ciRounds > this.c.limits.maxCiRounds) {
          throw new Stop('blocked', `CI still failing after ${this.c.limits.maxCiRounds} repair rounds: ${ci.failing.join(', ')}`, { code: 'CI_LIMIT' });
        }
        const logs = [];
        for (const run of ci.runs.filter((entry) => entry.status === 'completed' && !['success', 'neutral', 'skipped'].includes(entry.conclusion)).slice(0, 2)) {
          const log = await this.invoke('github.ci_logs', 'read', { job_id: run.id }, { callId: `ci-log-${run.id}-${randomUUID().slice(0, 8)}` });
          logs.push(`### ${run.name} (${run.conclusion})\n${log.error ? `(log unavailable: ${log.error})` : truncate(log.text, 12_000)}`);
        }
        this.state.lastGateFailure = `CI failed: ${ci.failing.join(', ')}`;
        this.transcript.messages.push(userText([
          `CI FAILED on pushed commit ${sha.slice(0, 7)} (pull request ${this.state.pr ? `#${this.state.pr.number}` : 'n/a'}).`,
          `Failing checks: ${ci.failing.join(', ')}`,
          '',
          ...logs,
          '',
          'Diagnose the failure, fix it in the working tree, run the relevant checks, then call finish again.',
        ].join('\n')));
        return false;
      }
      if (this.c.now() - started > this.c.limits.ciTimeoutMs) {
        throw new Stop('blocked', `CI did not finish within ${Math.round(this.c.limits.ciTimeoutMs / 60000)} minutes. Resume to keep watching.`, { code: 'CI_TIMEOUT' });
      }
      await this.checkpoint('phase');
      await this.c.sleepFn(this.c.limits.ciPollMs);
    }
  }

  async deploy() {
    if (!this.state.pr) throw new Stop('blocked', 'Deployment requires a pull request.', { code: 'DEPLOY_NO_PR' });
    if (!this.state.deploy?.mergeSha) {
      const merged = await this.required('github.pr_merge', 'merge', { number: this.state.pr.number, sha: this.state.git.pushedHead }, 'merge');
      let mergeSha = merged.structured.sha || null;
      if (!mergeSha) {
        // Replayed after a restart: the merge happened; read its commit back.
        const pull = await this.required('github.pr_status', 'read', { number: this.state.pr.number }, 'pull request status', { fresh: true });
        if (!pull.structured.merged || !pull.structured.mergeCommitSha) {
          throw new Stop('blocked', `Pull request #${this.state.pr.number} is not merged after an approved merge; check it on GitHub and resume.`, { code: 'MERGE_NOT_CONFIRMED' });
        }
        mergeSha = pull.structured.mergeCommitSha;
      }
      this.state.deploy = { status: 'merged', mergeSha };
      await this.event('deploy', `Merged pull request #${this.state.pr.number} as ${String(merged.structured.sha).slice(0, 7)}.`, this.state.deploy, 'success');
      await this.checkpoint('phase');
    }
    if (!this.config.deploy.workflow) {
      this.state.deploy.status = 'merged (no deployment workflow configured)';
      return;
    }
    const started = this.c.now();
    for (;;) {
      this.guard();
      const status = await this.required('deploy.status', 'read', { workflow: this.config.deploy.workflow, sha: this.state.deploy.mergeSha }, 'deployment status check', { fresh: true });
      const run = status.structured.runs?.[0];
      if (run?.status === 'completed') {
        this.state.deploy = { ...this.state.deploy, status: run.conclusion, url: run.url };
        if (run.conclusion !== 'success') {
          await this.event('deploy', `Deployment ${run.conclusion}; the pipeline's rollback protects production.`, this.state.deploy, 'error');
          throw new Stop('blocked', `Deployment workflow concluded ${run.conclusion} (${run.url}). Production rollback is handled by the pipeline; investigate before retrying.`, { code: 'DEPLOY_FAILED' });
        }
        await this.event('deploy', 'Deployment workflow succeeded.', this.state.deploy, 'success');
        return;
      }
      if (this.c.now() - started > this.c.limits.deployTimeoutMs) {
        throw new Stop('blocked', 'Deployment did not complete in time. Resume to keep watching.', { code: 'DEPLOY_TIMEOUT' });
      }
      await this.c.sleepFn(this.c.limits.deployPollMs);
    }
  }

  async verify() {
    const expected = this.config.verify.expectShaField && this.state.deploy?.mergeSha ? this.state.deploy.mergeSha : null;
    let detail = 'not run';
    for (let attempt = 1; attempt <= this.c.limits.verifyAttempts; attempt += 1) {
      const outcome = await this.invoke('verify.http', 'read', { url: this.config.verify.url }, { callId: `verify-${attempt}-${this.session.iteration}-${randomUUID().slice(0, 8)}` });
      if (!outcome.error && !outcome.structured.error) {
        const response = outcome.structured;
        const reported = expected ? String(response.json?.[this.config.verify.expectShaField] || '') : null;
        const shaOk = !expected || (reported && expected.startsWith(reported.slice(0, 7)) && reported.length >= 7);
        detail = `HTTP ${response.status}${expected ? `, ${this.config.verify.expectShaField}=${reported || 'missing'} (expected ${expected.slice(0, 7)})` : ''}`;
        if (response.ok && shaOk) {
          this.state.verify = { ok: true, detail, at: new Date(this.c.now()).toISOString() };
          await this.event('verify', `Production verification passed: ${detail}`, this.state.verify, 'success');
          return;
        }
      } else {
        detail = outcome.error || outcome.text;
      }
      if (attempt < this.c.limits.verifyAttempts) await this.c.sleepFn(this.c.limits.verifyDelayMs);
    }
    this.state.verify = { ok: false, detail, at: new Date(this.c.now()).toISOString() };
    await this.event('verify', `Production verification failed: ${detail}`, this.state.verify, 'error');
    throw new Stop('blocked', `Production verification failed: ${detail}`, { code: 'VERIFY_FAILED' });
  }

  async complete() {
    const status = this.state.noChanges ? 'completed (no changes were required)' : 'completed';
    const report = finalReport({ session: this.session, state: this.state, status, summary: this.state.finishSummary });
    this.session.phase = 'done';
    await this.checkpoint('final');
    await this.event('report', 'Session completed.', { pr: this.state.pr || null }, 'success');
    await this.c.store.finish(this.session, {
      status: 'completed',
      result: { summary: truncate(this.state.finishSummary || status, 3900), report, pr: this.state.pr || null, ci: this.state.ci || null,
        deploy: this.state.deploy || null, verify: this.state.verify || null, filesChanged: this.state.filesChanged, routesUsed: this.state.routesUsed },
    });
  }

  async compact() {
    this.transcript.messages = [userText(continuationMessage({
      session: this.session, state: this.state, plan: this.plan, nextAction: this.session.nextAction,
      recentMessages: this.transcript.messages.slice(-30), reason: 'transcript compaction',
    }))];
    this.transcript.segmentRoute = null;
    this.transcript.handedOff = false;
    await this.checkpoint('compaction');
    await this.event('checkpoint', 'Transcript compacted into a durable continuation summary.', {});
  }
}

// Failure counts printed by common test runners (node:test TAP and spec
// reporters, mocha, jest/vitest). Returns 0 when none is reported.
export function reportedTestFailures(output) {
  const text = String(output || '');
  const counts = [
    ...text.matchAll(/^(?:#|ℹ)\s*fail(?:ed)?\s+(\d+)\s*$/gim),
    ...text.matchAll(/^\s*(\d+)\s+failing\b/gim),
    ...text.matchAll(/^Tests?:\s.*?\b(\d+)\s+failed\b/gim),
  ].map((match) => Number(match[1]));
  return counts.length ? Math.max(...counts) : 0;
}

function normalizeConfig(config) {
  const deploy = config.deploy || {};
  const verify = config.verify || {};
  const supabase = config.supabase || {};
  return {
    testCommand: typeof config.testCommand === 'string' ? config.testCommand : config.testCommand === null ? null : undefined,
    publish: ['pull_request', 'branch', 'none'].includes(config.publish) ? config.publish : 'pull_request',
    waitForCi: config.waitForCi !== false,
    privateData: config.privateData !== false,
    allowPaid: config.allowPaid !== false && config.routing?.allowPaid !== false,
    routing: normalizeRouting(config.routing || {}),
    drill: Number.isInteger(config.drill?.failoverAfterIteration) && config.drill.failoverAfterIteration >= 1 && config.drill.failoverAfterIteration <= 100
      ? { failoverAfterIteration: config.drill.failoverAfterIteration } : null,
    allowProtectedPaths: config.allowProtectedPaths === true,
    fetchUrl: typeof config.fetchUrl === 'string' ? config.fetchUrl : null,
    deploy: { mode: deploy.mode === 'merge' ? 'merge' : 'none', workflow: typeof deploy.workflow === 'string' ? deploy.workflow : null },
    verify: {
      url: typeof verify.url === 'string' ? verify.url : null,
      hosts: Array.isArray(verify.hosts) ? verify.hosts.filter((host) => typeof host === 'string') : [],
      expectShaField: typeof verify.expectShaField === 'string' ? verify.expectShaField : null,
    },
    supabase: { projects: Array.isArray(supabase.projects) ? supabase.projects.filter((ref) => /^[a-z0-9]{20}$/.test(ref)) : [] },
  };
}

function normalizeState(state) {
  return {
    ...state,
    filesChanged: Array.isArray(state.filesChanged) ? state.filesChanged : [],
    filesInspected: Array.isArray(state.filesInspected) ? state.filesInspected : [],
    notes: Array.isArray(state.notes) ? state.notes : [],
    switches: Array.isArray(state.switches) ? state.switches : [],
    routesUsed: Array.isArray(state.routesUsed) ? state.routesUsed : [],
    git: state.git && typeof state.git === 'object' ? state.git : {},
    gateFailures: Number(state.gateFailures || 0),
    ciRounds: Number(state.ciRounds || 0),
  };
}

async function detectTestCommand(sandbox) {
  try {
    const file = await sandbox.readFile('package.json');
    const json = JSON.parse(file.content.split('\n').map((line) => line.replace(/^\s*\d+ {2}/, '')).join('\n'));
    if (json.scripts?.test && !/no test specified/.test(json.scripts.test)) return 'npm test';
  } catch {}
  for (const [path, command] of [['pytest.ini', 'python -m pytest -q'], ['pyproject.toml', 'python -m pytest -q'], ['go.mod', 'go test ./...'], ['Cargo.toml', 'cargo test']]) {
    try {
      await sandbox.resolveInside(path);
      return command;
    } catch {}
  }
  return null;
}

function looksLikeTest(command, testCommand) {
  return (testCommand && command.includes(testCommand)) || /\b(npm (run )?test|node --test|pytest|go test|cargo test|jest|vitest|mocha|npm run (lint|build|check|typecheck))\b/.test(command);
}

function previewArgs(args) {
  const preview = {};
  for (const [key, value] of Object.entries(args || {})) {
    preview[key] = typeof value === 'string' ? truncate(redact(value, process.env, 600), 600) : value;
  }
  return preview;
}

function approvalSummary(tool, args) {
  if (tool === 'github.pr_merge') return `Merge pull request #${args.number} (head ${String(args.sha).slice(0, 7)})`;
  if (tool === 'supabase.migration_apply') return `Apply migration ${args.name} to Supabase project ${args.project_ref}: ${String(args.reason || '').slice(0, 300)}`;
  if (tool === 'supabase.query_write') return `Run data-changing SQL on ${args.project_ref}: ${String(args.reason || '').slice(0, 300)}`;
  return `${tool} ${JSON.stringify(previewArgs(args)).slice(0, 400)}`;
}

function riskOf(tool) {
  return ['supabase.query_write', 'supabase.migration_apply'].includes(tool) ? 'high' : 'medium';
}

function summarizeToolEvent(tool, args, outcome) {
  const payload = { tool };
  if (args.path) payload.path = String(args.path);
  if (tool === 'shell.run') Object.assign(payload, { command: truncate(redact(String(args.command), process.env, 300), 300), exitCode: outcome.structured.exitCode, durationMs: outcome.structured.durationMs });
  return payload;
}

function roundUsd(value) {
  return Math.round(Number(value || 0) * 100_000_000) / 100_000_000;
}

export { Stop, normalizeConfig };
