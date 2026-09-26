import { chiefJob, planJob, reviewResearch, validatePlan } from './chief.js';
import { performSpecialist, specialistFor, SPECIALISTS } from './research.js';
import { EscalationRequired, classifyOfficeData } from './office/pool-runner.js';
import {
  CHIEF_MODEL,
  DEEPSEEK_MODEL,
  MODEL_PROVIDER,
  RESEARCH_MODEL,
  STALE_TASK_MINUTES,
  TASK_MAX_ATTEMPTS,
} from './config.js';
import { ScopedToolBrokerSession } from './tool-broker/session.js';

export const WORKFLOW = 'chief-research-chief';
export const WORKFLOW_VERSION = 1;
export const STAGES = Object.freeze({ PLAN: 'chief_plan', RESEARCH: 'research', REVIEW: 'chief_review' });
export const SEQUENCES = Object.freeze({ PLAN: 10, RESEARCH: 20, REVIEW: 30 });

export class OfficeWorkflow {
  constructor({
    store,
    plan = planJob,
    research = performSpecialist,
    review = reviewResearch,
    staleMinutes = STALE_TASK_MINUTES,
    maxAttempts = TASK_MAX_ATTEMPTS,
    recoveryIntervalMs = 60_000,
    now = () => Date.now(),
    workspacePolicyStore = null,
    enforceLegacyWorkspacePolicy = false,
    toolBroker = null,
    modelRunner = null,
    env = process.env,
  }) {
    // modelRunner: the shared Model Pool runner (office/pool-runner.js). When
    // present every stage asks for a job type and the shared router picks the
    // model; without it the legacy Anthropic-first gateway is used.
    this.modelRunner = modelRunner;
    this.env = env;
    this.store = store;
    this.executors = { plan, research, review };
    this.staleMinutes = staleMinutes;
    this.maxAttempts = maxAttempts;
    this.recoveryIntervalMs = recoveryIntervalMs;
    this.now = now;
    this.lastRecoveryAt = 0;
    this.workspacePolicyStore = workspacePolicyStore;
    this.enforceLegacyWorkspacePolicy = enforceLegacyWorkspacePolicy;
    this.toolBroker = toolBroker;
  }

  async runOnce() {
    let progressed = false;
    if (this.now() - this.lastRecoveryAt >= this.recoveryIntervalMs) {
      const recovered = await this.store.requeueStaleTasks(this.staleMinutes);
      this.lastRecoveryAt = this.now();
      progressed = recovered > 0;
    }

    const job = await this.store.claimNextJob();
    if (job) {
      await this.bootstrap(job);
      progressed = true;
    }

    const task = await this.store.claimNextTask();
    if (!task) return progressed;
    await this.execute(task);
    return true;
  }

  async bootstrap(job) {
    await this.store.emit({
      jobId: job.id,
      type: 'job_created',
      message: 'Fahad request accepted by the Step 3C workflow.',
      payload: { workflow: WORKFLOW, workflow_version: WORKFLOW_VERSION, status: 'WORKING' },
    });
    const brief = encodeBrief(STAGES.PLAN, { goal: job.goal });
    const task = await this.store.ensureTask({
      jobId: job.id,
      agentSlug: 'chief-of-staff',
      title: 'Chief planning',
      brief,
      sequence: SEQUENCES.PLAN,
      maxAttempts: this.maxAttempts,
    });
    await this.store.emit({
      jobId: job.id,
      taskId: task.id,
      agentId: task.agent_id,
      type: 'status_changed',
      message: 'Chief of Staff started the job.',
      payload: { status: 'WORKING', stage: 'CHIEF_STARTED' },
    });
  }

  async execute(task) {
    const brief = decodeBrief(task.brief);
    try {
      if (brief.stage === STAGES.PLAN) await this.executePlan(task);
      else if (brief.stage === STAGES.RESEARCH) await this.executeResearch(task, brief);
      else if (brief.stage === STAGES.REVIEW) await this.executeReview(task, brief);
      else throw new Error('Unsupported workflow stage');
    } catch (error) {
      const safe = safeError(error);
      const failure = await this.store.failTask(task, safe);
      if (failure?.ignored) return { ok: failure.status === 'done', error: safe };
      await this.store.emit({
        jobId: task.job_id,
        taskId: task.task_id,
        runId: task.run_id,
        agentId: task.agent_id,
        type: 'status_changed',
        level: failure?.will_retry ? 'warning' : 'error',
        message: failure?.will_retry ? 'Task is queued for a safe retry.' : 'Task failed after exhausting retries.',
        payload: { status: failure?.will_retry ? 'RETRYING' : 'FAILED', attempt: task.attempt_no },
      });
      return { ok: false, error: safe };
    }
    return { ok: true };
  }

  async executePlan(task) {
    assertAgent(task, 'chief-of-staff');
    const agent = await this.store.getAgent('chief-of-staff');
    const preference = await this.providerPreference(task, STAGES.PLAN);
    const model = preference === 'deepseek' ? DEEPSEEK_MODEL : CHIEF_MODEL;
    const request = officeRequest(task.goal, this.env);
    const job = chiefJob(request.goal);
    if (this.modelRunner) {
      await this.startStage(task, agent, 'CHIEF_PLANNING', `shared-pool:${job}`, `Chief of Staff is planning (job: ${job}; free-first shared Model Pool).`, preference, { job, dataClass: request.dataClass });
    } else {
      await this.startStage(task, agent, 'CHIEF_PLANNING', model, 'Chief of Staff is planning.', preference);
    }
    const outcome = await this.withHeartbeat(task, (onActivity) => this.executors.plan({
      agent,
      goal: request.goal,
      onActivity,
      execution: this.modelExecution(task, STAGES.PLAN, preference, model),
      toolBroker: this.toolSession(task, STAGES.PLAN),
      ...(this.modelRunner ? { run: this.poolRun(task, STAGES.PLAN, { job, request, preference, validate: request.drills.escalate ? escalationDrill(validatePlan) : validatePlan }) } : {}),
    }));

    const specialist = specialistFor(outcome.plan.specialist);
    const researchTask = await this.store.ensureTask({
      jobId: task.job_id,
      agentSlug: this.modelRunner ? specialist.agentSlug : 'research-strategy',
      title: this.modelRunner ? `${specialist.label} (job: ${specialist.job})` : 'Research & Strategy investigation',
      brief: encodeBrief(STAGES.RESEARCH, { researchBrief: outcome.plan.research_brief, ...(this.modelRunner ? { role: outcome.plan.specialist } : {}) }),
      sequence: SEQUENCES.RESEARCH,
      dependsOn: [task.task_id],
      maxAttempts: this.maxAttempts,
    });
    const reviewTask = await this.store.ensureTask({
      jobId: task.job_id,
      agentSlug: 'chief-of-staff',
      title: 'Chief final review',
      brief: encodeBrief(STAGES.REVIEW, { reviewBrief: outcome.plan.review_brief }),
      sequence: SEQUENCES.REVIEW,
      dependsOn: [researchTask.id],
      maxAttempts: this.maxAttempts,
    });

    await this.recordOutcome(task, outcome, 'Chief plan is ready to save.');
    await this.store.emit({
      jobId: task.job_id,
      taskId: task.task_id,
      runId: task.run_id,
      agentId: task.agent_id,
      type: 'plan_created',
      message: 'Chief created the Research delegation and final-review dependency.',
      payload: {
        status: 'COMPLETED',
        research_task_id: researchTask.id,
        review_task_id: reviewTask.id,
      },
    });
    await this.store.completeTask(task, outcome, outcome.plan.plan_summary);
    await this.store.emit({
      jobId: task.job_id,
      taskId: task.task_id,
      runId: task.run_id,
      agentId: task.agent_id,
      type: 'status_changed',
      message: 'Chief is waiting for Research.',
      payload: { status: 'WAITING', stage: 'RESEARCH' },
    });
  }

  async executeResearch(task, brief) {
    const role = this.modelRunner && SPECIALISTS[brief.role] ? brief.role : 'research';
    const specialist = specialistFor(role);
    assertAgent(task, specialist.agentSlug);
    const agent = await this.store.getAgent(specialist.agentSlug);
    if (specialist.webTools) assertAuthorizedResearchTools(agent.allowed_tools || []);
    const request = officeRequest(task.goal, this.env);
    if (this.modelRunner) {
      await this.startStage(task, agent, 'RESEARCH_WORKING', `shared-pool:${specialist.job}`, `${specialist.label} is working (job: ${specialist.job}; free-first shared Model Pool).`, MODEL_PROVIDER, { job: specialist.job, dataClass: request.dataClass, role });
    } else {
      await this.startStage(task, agent, 'RESEARCH_WORKING', RESEARCH_MODEL, 'Research & Strategy is working.');
    }
    const outcome = await this.withHeartbeat(task, (onActivity) => this.executors.research({
      agent,
      goal: request.goal,
      brief: brief.researchBrief,
      role,
      onActivity,
      execution: this.modelExecution(task, STAGES.RESEARCH),
      toolBroker: this.toolSession(task, STAGES.RESEARCH),
      ...(this.modelRunner ? { run: this.poolRun(task, STAGES.RESEARCH, { job: specialist.job, request, preference: MODEL_PROVIDER, drillFailover: request.drills.failover }) } : {}),
    }));
    await this.recordOutcome(task, outcome, 'Research result is ready to save.');
    await this.store.completeTask(task, outcome, summarize(outcome.text));
  }

  async executeReview(task, brief) {
    assertAgent(task, 'chief-of-staff');
    const upstream = Array.isArray(task.upstream) ? task.upstream : [];
    const specialistSlugs = new Set(Object.values(SPECIALISTS).map((entry) => entry.agentSlug));
    if (upstream.length !== 1 || !specialistSlugs.has(upstream[0].agent_slug) || !upstream[0].content) {
      throw new Error('Chief review received an invalid Research handoff');
    }
    const agent = await this.store.getAgent('chief-of-staff');
    const preference = await this.providerPreference(task, STAGES.REVIEW);
    const model = preference === 'deepseek' ? DEEPSEEK_MODEL : CHIEF_MODEL;
    const request = officeRequest(task.goal, this.env);
    const job = chiefJob(request.goal, { stage: 'review' });
    if (this.modelRunner) {
      await this.startStage(task, agent, 'CHIEF_REVIEW_STARTED', `shared-pool:${job}`, `Chief is reviewing the specialist result (job: ${job}; free-first shared Model Pool).`, preference, { job, dataClass: request.dataClass });
    } else {
      await this.startStage(task, agent, 'CHIEF_REVIEW_STARTED', model, 'Chief is reviewing Research.', preference);
    }
    const outcome = await this.withHeartbeat(task, (onActivity) => this.executors.review({
      agent,
      goal: request.goal,
      reviewBrief: brief.reviewBrief,
      research: upstream[0],
      onActivity,
      execution: this.modelExecution(task, STAGES.REVIEW, preference, model),
      toolBroker: this.toolSession(task, STAGES.REVIEW),
      ...(this.modelRunner ? { run: this.poolRun(task, STAGES.REVIEW, { job, request, preference }) } : {}),
    }));
    await this.recordOutcome(task, outcome, 'Chief final result is ready to save.');
    await this.store.completeTask(task, outcome, summarize(outcome.text));
  }

  async startStage(task, agent, stage, model, message, provider = MODEL_PROVIDER, routing = null) {
    await this.store.setRunModel(task.run_id, model);
    await this.store.emit({
      jobId: task.job_id,
      taskId: task.task_id,
      runId: task.run_id,
      agentId: agent.id,
      type: 'status_changed',
      message,
      payload: {
        status: 'WORKING', stage, provider: routing ? 'shared-pool' : provider, model,
        attempt: task.attempt_no, max_attempts: task.max_attempts,
        ...(routing ? { kind: 'model_stage_started', job: routing.job, data_class: routing.dataClass, role: routing.role || null, agent_slug: agent.slug || task.agent_slug } : {}),
      },
    });
  }

  async recordOutcome(task, outcome, message) {
    if (outcome.path) {
      await this.store.emit({
        jobId: task.job_id,
        taskId: task.task_id,
        runId: task.run_id,
        agentId: task.agent_id,
        type: 'activity',
        message: `${task.agent_slug} ran on ${outcome.path.map((step) => `${step.routeId} (${step.billingClass.toUpperCase()})`).join(' → ')}.`,
        payload: {
          kind: 'model_route', agent_slug: task.agent_slug, stage: decodeBrief(task.brief).stage, job: outcome.job, data_class: outcome.dataClass,
          route_id: outcome.routeId, provider: outcome.provider, model: outcome.model, billing_class: outcome.billingClass,
          path: outcome.path, switches: outcome.switches, escalations: outcome.escalations, tools_used: outcome.toolsUsed,
          checkpoints: outcome.checkpoints, tokens_in: outcome.tokensIn, tokens_out: outcome.tokensOut, cost_usd: outcome.costUsd,
          duration_ms: outcome.durationMs, savings: outcome.savings,
        },
      });
    }
    await this.store.setRunModel(
      task.run_id,
      outcome.model || (task.agent_slug === 'research-strategy' ? RESEARCH_MODEL : CHIEF_MODEL),
    );
    await this.store.emit({
      jobId: task.job_id,
      taskId: task.task_id,
      runId: task.run_id,
      agentId: task.agent_id,
      type: 'activity',
      message,
      payload: {
        status: 'COMPLETED',
        provider: outcome.provider || MODEL_PROVIDER,
        model: outcome.model || (task.agent_slug === 'research-strategy' ? RESEARCH_MODEL : CHIEF_MODEL),
        tokens_in: outcome.tokensIn,
        tokens_out: outcome.tokensOut,
        cost_usd: outcome.costUsd,
        duration_ms: outcome.durationMs,
        retry_count: Math.max(0, task.attempt_no - 1),
      },
    });
  }

  async providerPreference(task, stage) {
    if (stage === STAGES.RESEARCH) return MODEL_PROVIDER;
    const job = await this.store.getJob(task.job_id);
    const requested = job.requested_provider || 'auto';
    if (!['auto', 'anthropic', 'deepseek'].includes(requested)) throw new Error('Unsupported job provider preference');
    return requested === 'auto' ? MODEL_PROVIDER : requested;
  }

  // A stage run on the shared Model Pool: the stage names its job type; the
  // shared router chooses the model. Audit, checkpoints and provider switches
  // go to the same durable records as before.
  poolRun(task, stage, { job, request, preference = MODEL_PROVIDER, validate = null, drillFailover = false }) {
    const execution = this.modelExecution(task, stage);
    return async (args) => this.modelRunner.run({
      job,
      systemPrompt: args.systemPrompt,
      prompt: args.prompt,
      useWebTools: (args.allowedTools || []).length > 0,
      maxTurns: args.maxTurns,
      dataClass: request.dataClass,
      onlyProvider: preference && preference !== MODEL_PROVIDER ? preference : null,
      context: execution.gatewayContext,
      validate,
      beforeCall: drillFailover ? failoverDrill() : null,
      hooks: {
        onAttempt: execution.onAttempt,
        onCheckpoint: execution.onCheckpoint,
        onProviderSwitch: execution.onProviderSwitch,
        onActivity: args.onActivity,
        onEscalation: (change) => this.store.emit({
          jobId: task.job_id, taskId: task.task_id, runId: task.run_id, agentId: task.agent_id,
          type: 'activity', required: true, level: 'warning',
          message: `Escalated: ${change.fromRoute} could not complete this ${job} step (${change.reason}); checkpoint ${change.checkpointSequence} saved, choosing the next suitable model.`,
          payload: { kind: 'model_escalation', job, from_route: change.fromRoute, reason: change.reason, checkpoint: change.checkpointSequence },
        }),
      },
    });
  }

  modelExecution(task, stage, provider = MODEL_PROVIDER, model = null) {
    const context = {
      workspaceId: task.project_id || null,
      jobId: task.job_id,
      taskId: task.task_id,
      runId: task.run_id,
      agentId: task.agent_id,
      stage,
      provider: provider === MODEL_PROVIDER ? null : provider,
    };
    return {
      ...(model ? { model } : {}),
      gatewayContext: context,
      workspacePolicyStore: selectWorkspacePolicyStore({
        policyStore: this.workspacePolicyStore,
        workspaceId: task.project_id,
        enforceLegacy: this.enforceLegacyWorkspacePolicy,
      }),
      idempotencyKey: `${task.run_id}:${stage}`,
      onAttempt: (attempt) => this.store.recordModelAttempt(attempt),
      onCheckpoint: (checkpoint) => this.store.emit({
        jobId: task.job_id,
        taskId: task.task_id,
        runId: task.run_id,
        agentId: task.agent_id,
        type: 'activity',
        required: true,
        level: 'warning',
        message: 'Provider-neutral checkpoint saved before model ownership changed.',
        payload: { ...checkpoint, kind: 'model_checkpoint' },
      }),
      onProviderSwitch: (checkpoint) => this.store.emit({
        jobId: task.job_id,
        taskId: task.task_id,
        runId: task.run_id,
        agentId: task.agent_id,
        type: 'activity',
        required: true,
        level: 'warning',
        message: `Model ownership changed from ${checkpoint.fromProvider} to ${checkpoint.toProvider}.`,
        payload: { ...checkpoint, kind: 'provider_switch' },
      }),
      onBudgetThreshold: (threshold) => this.store.emit({
        jobId: task.job_id,
        taskId: task.task_id,
        runId: task.run_id,
        agentId: task.agent_id,
        type: 'activity',
        level: threshold.threshold >= 0.9 ? 'warning' : 'info',
        message: `Model budget reached ${threshold.threshold * 100}%.`,
        payload: { ...threshold, kind: 'cost_threshold' },
      }),
    };
  }

  toolSession(task, stage) {
    if (!this.toolBroker || !task.project_id) return null;
    return new ScopedToolBrokerSession({
      broker: this.toolBroker,
      context: {
        workspaceId: task.project_id,
        jobId: task.job_id,
        taskId: task.task_id,
        runId: task.run_id,
        agentId: task.agent_id,
      },
      idempotencyPrefix: `${task.run_id}:${stage}:tool`,
    });
  }

  async withHeartbeat(task, operation) {
    let progress = 10;
    const heartbeat = setInterval(() => {
      this.store.touchTask(task.task_id, progress).catch(() => {});
    }, 30_000);
    heartbeat.unref?.();
    try {
      return await operation(async ({ turns = 0, hostTool } = {}) => {
        if (hostTool) {
          await this.store.emit({
            jobId: task.job_id,
            taskId: task.task_id,
            runId: task.run_id,
            agentId: task.agent_id,
            type: 'activity',
            required: true,
            level: hostTool.status === 'failed' ? 'warning' : 'info',
            message: `${hostTool.name} ${hostTool.status}.`,
            payload: {
              kind: 'host_tool', tool: hostTool.name, status: hostTool.status,
              tool_use_id: hostTool.id, duration_ms: hostTool.durationMs ?? null,
            },
          });
        }
        progress = Math.min(90, 20 + turns * 10);
        await this.store.touchTask(task.task_id, progress);
      });
    } finally {
      clearInterval(heartbeat);
    }
  }
}

export function selectWorkspacePolicyStore({ policyStore, workspaceId, enforceLegacy = false }) {
  if (!policyStore) return null;
  // A non-null workspace is an explicit policy boundary and must never bypass
  // enforcement. Legacy jobs remain unchanged unless the global flag is set.
  return workspaceId || enforceLegacy ? policyStore : null;
}

export function encodeBrief(stage, values = {}) {
  return JSON.stringify({ workflow: WORKFLOW, workflow_version: WORKFLOW_VERSION, stage, ...values });
}

export function decodeBrief(value) {
  let brief;
  try {
    brief = JSON.parse(value);
  } catch {
    throw new Error('Task brief is not valid workflow JSON');
  }
  if (brief?.workflow !== WORKFLOW || brief.workflow_version !== WORKFLOW_VERSION ||
      !Object.values(STAGES).includes(brief.stage)) {
    throw new Error('Task does not belong to the supported Step 3C workflow');
  }
  return brief;
}

function assertAgent(task, expected) {
  if (task.agent_slug !== expected) throw new Error(`Stage requires ${expected}`);
}

function assertAuthorizedResearchTools(tools) {
  const normalized = tools.map((tool) => String(tool).toLowerCase());
  for (const required of ['web_search', 'web_fetch']) {
    if (!normalized.includes(required)) throw new Error(`Research agent is not authorized for ${required}`);
  }
}

function summarize(text) {
  const first = String(text || '').split('\n').find((line) => line.trim()) || '';
  return first.trim().slice(0, 300);
}

export function safeError(error) {
  let safe = String(error?.message || error || 'Unknown task failure');
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'CONTINUITY_GITHUB_TOKEN']) {
    const value = process.env[name];
    if (value && value.length >= 8) safe = safe.replaceAll(value, '[REDACTED]');
  }
  return safe
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk[-_]|ghp_|github_pat_)[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
    .slice(0, 500);
}

// The request as Office sees it: owner drill markers and the confidential
// marker are removed from what models receive; the data class is decided
// once per job (office/pool-runner.js classifyOfficeData).
export function officeRequest(goal, env = process.env) {
  const raw = String(goal || '');
  const drillsEnabled = !/^(0|false|no)$/i.test(String(env.OFFICE_DRILLS_ENABLED || ''));
  const drills = {
    failover: drillsEnabled && /\[drill:failover\]/i.test(raw),
    escalate: drillsEnabled && /\[drill:escalate\]/i.test(raw),
  };
  const { dataClass, reason } = classifyOfficeData(raw, { env });
  const cleaned = raw.replace(/\[drill:(failover|escalate)\]/gi, '').replace(/^\s*\[(confidential|private|سري)\]\s*/i, '').trim();
  return { goal: cleaned || raw, dataClass, dataClassReason: reason, drills };
}

// Controlled failover drill (owner marker [drill:failover]): after the first
// model has completed one real step, ONE simulated rate limit is injected on
// its next call. The gateway treats it like a real 429 (checkpoint, switch)
// but never records it as provider health. Reported as injected.
export function failoverDrill() {
  let firstRoute = null;
  let calls = 0;
  let injected = false;
  return async ({ route }) => {
    firstRoute ||= route.id;
    if (route.id !== firstRoute || injected) return;
    calls += 1;
    if (calls === 2) {
      injected = true;
      throw Object.assign(new Error('DRILL: injected rate limit for the Office failover drill'), { status: 429, type: 'rate_limit_error', retryAfter: '600', injected: true, code: 'DRILL_INJECTED_RATE_LIMIT' });
    }
  };
}

// Controlled escalation drill (owner marker [drill:escalate]): the first
// model's valid plan is treated ONCE as insufficient, so the stage escalates
// to the next suitable model from its checkpoint. Reported as injected.
export function escalationDrill(validate) {
  let used = false;
  return async (text) => {
    if (!used) {
      used = true;
      throw new EscalationRequired('DRILL: first plan treated as insufficient', 'DRILL_INJECTED_INSUFFICIENT');
    }
    return validate(text);
  };
}
