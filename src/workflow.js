import { planJob, reviewResearch } from './chief.js';
import { performResearch } from './research.js';
import {
  CHIEF_MODEL,
  MODEL_PROVIDER,
  RESEARCH_MODEL,
  STALE_TASK_MINUTES,
  TASK_MAX_ATTEMPTS,
} from './config.js';

export const WORKFLOW = 'chief-research-chief';
export const WORKFLOW_VERSION = 1;
export const STAGES = Object.freeze({ PLAN: 'chief_plan', RESEARCH: 'research', REVIEW: 'chief_review' });
export const SEQUENCES = Object.freeze({ PLAN: 10, RESEARCH: 20, REVIEW: 30 });

export class OfficeWorkflow {
  constructor({
    store,
    plan = planJob,
    research = performResearch,
    review = reviewResearch,
    staleMinutes = STALE_TASK_MINUTES,
    maxAttempts = TASK_MAX_ATTEMPTS,
    recoveryIntervalMs = 60_000,
    now = () => Date.now(),
    workspacePolicyStore = null,
  }) {
    this.store = store;
    this.executors = { plan, research, review };
    this.staleMinutes = staleMinutes;
    this.maxAttempts = maxAttempts;
    this.recoveryIntervalMs = recoveryIntervalMs;
    this.now = now;
    this.lastRecoveryAt = 0;
    this.workspacePolicyStore = workspacePolicyStore;
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
    await this.startStage(task, agent, 'CHIEF_PLANNING', CHIEF_MODEL, 'Chief of Staff is planning.');
    const outcome = await this.withHeartbeat(task, (onActivity) => this.executors.plan({
      agent,
      goal: task.goal,
      onActivity,
      execution: this.modelExecution(task, STAGES.PLAN),
    }));

    const researchTask = await this.store.ensureTask({
      jobId: task.job_id,
      agentSlug: 'research-strategy',
      title: 'Research & Strategy investigation',
      brief: encodeBrief(STAGES.RESEARCH, { researchBrief: outcome.plan.research_brief }),
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
    assertAgent(task, 'research-strategy');
    const agent = await this.store.getAgent('research-strategy');
    assertAuthorizedResearchTools(agent.allowed_tools || []);
    await this.startStage(task, agent, 'RESEARCH_WORKING', RESEARCH_MODEL, 'Research & Strategy is working.');
    const outcome = await this.withHeartbeat(task, (onActivity) => this.executors.research({
      agent,
      goal: task.goal,
      brief: brief.researchBrief,
      onActivity,
      execution: this.modelExecution(task, STAGES.RESEARCH),
    }));
    await this.recordOutcome(task, outcome, 'Research result is ready to save.');
    await this.store.completeTask(task, outcome, summarize(outcome.text));
  }

  async executeReview(task, brief) {
    assertAgent(task, 'chief-of-staff');
    const upstream = Array.isArray(task.upstream) ? task.upstream : [];
    if (upstream.length !== 1 || upstream[0].agent_slug !== 'research-strategy' || !upstream[0].content) {
      throw new Error('Chief review received an invalid Research handoff');
    }
    const agent = await this.store.getAgent('chief-of-staff');
    await this.startStage(task, agent, 'CHIEF_REVIEW_STARTED', CHIEF_MODEL, 'Chief is reviewing Research.');
    const outcome = await this.withHeartbeat(task, (onActivity) => this.executors.review({
      agent,
      goal: task.goal,
      reviewBrief: brief.reviewBrief,
      research: upstream[0],
      onActivity,
      execution: this.modelExecution(task, STAGES.REVIEW),
    }));
    await this.recordOutcome(task, outcome, 'Chief final result is ready to save.');
    await this.store.completeTask(task, outcome, summarize(outcome.text));
  }

  async startStage(task, agent, stage, model, message) {
    await this.store.setRunModel(task.run_id, model);
    await this.store.emit({
      jobId: task.job_id,
      taskId: task.task_id,
      runId: task.run_id,
      agentId: agent.id,
      type: 'status_changed',
      message,
      payload: {
        status: 'WORKING', stage, provider: MODEL_PROVIDER, model,
        attempt: task.attempt_no, max_attempts: task.max_attempts,
      },
    });
  }

  async recordOutcome(task, outcome, message) {
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

  modelExecution(task, stage) {
    const context = {
      workspaceId: task.project_id || null,
      jobId: task.job_id,
      taskId: task.task_id,
      runId: task.run_id,
      agentId: task.agent_id,
      stage,
    };
    return {
      gatewayContext: context,
      workspacePolicyStore: this.workspacePolicyStore,
      idempotencyKey: `${task.run_id}:${stage}`,
      onAttempt: (attempt) => this.store.recordModelAttempt(attempt),
      onCheckpoint: (checkpoint) => this.store.emit({
        jobId: task.job_id,
        taskId: task.task_id,
        runId: task.run_id,
        agentId: task.agent_id,
        type: 'model_checkpoint',
        level: 'warning',
        message: 'Provider-neutral checkpoint saved before model ownership changed.',
        payload: checkpoint,
      }),
      onProviderSwitch: (checkpoint) => this.store.emit({
        jobId: task.job_id,
        taskId: task.task_id,
        runId: task.run_id,
        agentId: task.agent_id,
        type: 'provider_switch',
        level: 'warning',
        message: `Model ownership changed from ${checkpoint.fromProvider} to ${checkpoint.toProvider}.`,
        payload: checkpoint,
      }),
      onBudgetThreshold: (threshold) => this.store.emit({
        jobId: task.job_id,
        taskId: task.task_id,
        runId: task.run_id,
        agentId: task.agent_id,
        type: 'cost_threshold',
        level: threshold.threshold >= 0.9 ? 'warning' : 'info',
        message: `Model budget reached ${threshold.threshold * 100}%.`,
        payload: threshold,
      }),
    };
  }

  async withHeartbeat(task, operation) {
    let progress = 10;
    const heartbeat = setInterval(() => {
      this.store.touchTask(task.task_id, progress).catch(() => {});
    }, 30_000);
    heartbeat.unref?.();
    try {
      return await operation(async ({ turns = 0 } = {}) => {
        progress = Math.min(90, 20 + turns * 10);
        await this.store.touchTask(task.task_id, progress);
      });
    } finally {
      clearInterval(heartbeat);
    }
  }
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
