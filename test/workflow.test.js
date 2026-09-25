import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficeWorkflow, SEQUENCES, STAGES, safeError, selectWorkspacePolicyStore } from '../src/workflow.js';

const outcome = (text, extra = {}) => ({
  text, tokensIn: 10, tokensOut: 5, costUsd: 0.01, durationMs: 25, turns: 1, ...extra,
});

function fixture(overrides = {}, options = {}) {
  const store = new MemoryStore();
  const calls = [];
  const plan = overrides.plan || (async ({ onActivity }) => {
    calls.push('chief-plan');
    await onActivity({ turns: 1 });
    return outcome('{"plan":true}', {
      plan: { plan_summary: 'Delegate verified research.', research_brief: 'Find three verified options.', review_brief: 'Review and recommend.' },
    });
  });
  const research = overrides.research || (async ({ onActivity }) => {
    calls.push('research');
    await onActivity({ turns: 2 });
    return outcome('## Findings\nThree verified options.\n\nSources: https://example.test');
  });
  const review = overrides.review || (async ({ research: input, onActivity }) => {
    calls.push('chief-review');
    assert.match(input.content, /Three verified options/);
    await onActivity({ turns: 1 });
    return outcome('Recommendation: apply all three in stages.');
  });
  const workflow = new OfficeWorkflow({
    store, plan, research, review,
    maxAttempts: options.maxAttempts || 3,
    recoveryIntervalMs: options.recoveryIntervalMs ?? 60_000,
    now: () => store.now,
  });
  return { store, calls, workflow };
}

async function drain(workflow, limit = 20) {
  for (let index = 0; index < limit; index += 1) {
    if (!await workflow.runOnce()) return;
  }
  throw new Error('Workflow did not become idle');
}

test('A. normal workflow runs Chief -> Research -> Chief and completes', async () => {
  const { store, calls, workflow } = fixture();
  await drain(workflow);
  assert.deepEqual(calls, ['chief-plan', 'research', 'chief-review']);
  assert.equal(store.jobs[0].status, 'completed');
  assert.deepEqual(store.tasks.map((task) => task.status), ['done', 'done', 'done']);
  assert.equal(store.runs.length, 3);
  assert.equal(store.handoffs.length, 2);
  assert.equal(store.results.filter((result) => result.kind === 'final').length, 1);
});

test('manual DeepSeek preference applies only to tool-free Chief stages', async () => {
  const { store, workflow } = fixture();
  store.jobs[0].requested_provider = 'deepseek';
  const task = { job_id: 'job-1', task_id: 'task-1', run_id: 'run-1', agent_id: 'chief', project_id: 'workspace-1' };
  assert.equal(await workflow.providerPreference(task, STAGES.PLAN), 'deepseek');
  assert.equal(await workflow.providerPreference(task, STAGES.RESEARCH), 'anthropic');
  assert.equal(workflow.modelExecution(task, STAGES.PLAN, 'deepseek', 'deepseek-flash').gatewayContext.provider, 'deepseek');
  assert.equal(workflow.modelExecution(task, STAGES.RESEARCH).gatewayContext.provider, null);
});

test('B. final review remains blocked until Research completes', async () => {
  const { store, workflow } = fixture();
  await workflow.runOnce();
  const research = store.tasks.find((task) => task.sequence === SEQUENCES.RESEARCH);
  const review = store.tasks.find((task) => task.sequence === SEQUENCES.REVIEW);
  assert.deepEqual(review.depends_on, [research.id]);
  assert.equal(review.status, 'queued');
  const claimed = await store.claimNextTask();
  assert.equal(claimed.task_id, research.id);
  const second = await store.claimNextTask();
  assert.equal(second, null);
});

test('C. handoffs preserve task, agent and persisted Research content', async () => {
  const { store, workflow } = fixture();
  await drain(workflow);
  const [toResearch, toChief] = store.handoffs;
  assert.equal(toResearch.from_agent_id, 'chief');
  assert.equal(toResearch.to_agent_id, 'research');
  assert.equal(toChief.from_agent_id, 'research');
  assert.equal(toChief.to_agent_id, 'chief');
  assert.equal(toChief.job_id, store.jobs[0].id);
  const researchResult = store.results.find((result) => result.task_id === toChief.from_task_id);
  assert.match(researchResult.content, /Three verified options/);
});

test('D. temporary Research failure retries without duplicate result', async () => {
  let attempts = 0;
  const { store, workflow } = fixture({
    research: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary provider failure');
      return outcome('## Findings\nThree verified options.');
    },
  });
  await drain(workflow);
  const researchTask = store.tasks.find((task) => task.sequence === SEQUENCES.RESEARCH);
  assert.equal(researchTask.attempts, 2);
  assert.equal(store.results.filter((result) => result.task_id === researchTask.id).length, 1);
  assert.equal(store.events.filter((event) => event.type === 'retry').length, 1);
  assert.equal(store.jobs[0].status, 'completed');
});

test('E. exhausted Research failure blocks review and fails the job', async () => {
  let reviewCalls = 0;
  const { store, workflow } = fixture({
    research: async () => { throw new Error('permanent research failure'); },
    review: async () => { reviewCalls += 1; return outcome('must not run'); },
  }, { maxAttempts: 2 });
  await drain(workflow);
  const review = store.tasks.find((task) => task.sequence === SEQUENCES.REVIEW);
  assert.equal(review.status, 'blocked');
  assert.equal(store.jobs[0].status, 'failed');
  assert.equal(reviewCalls, 0);
});

test('F. stale task recovery fails the abandoned run and safely retries', async () => {
  const { store, workflow } = fixture({}, { recoveryIntervalMs: 1 });
  await workflow.runOnce();
  const abandoned = await store.claimNextTask();
  assert.equal(abandoned.agent_slug, 'research-strategy');
  store.tasks.find((task) => task.id === abandoned.task_id).stale = true;
  store.now += 2;
  await drain(workflow);
  const researchTask = store.tasks.find((task) => task.sequence === SEQUENCES.RESEARCH);
  assert.equal(researchTask.attempts, 2);
  assert.equal(store.runs.filter((run) => run.task_id === researchTask.id && run.status === 'failed').length, 1);
  assert.equal(store.jobs[0].status, 'completed');
});

test('G. claim locking prevents simultaneous duplicate execution', async () => {
  const { store, workflow } = fixture();
  await workflow.runOnce();
  const [first, second] = await Promise.all([store.claimNextTask(), store.claimNextTask()]);
  assert.ok(first?.task_id);
  assert.equal(second, null);
  assert.equal(store.runs.filter((run) => run.task_id === first.task_id).length, 1);
});

test('H. cost, model and operational events stay attached to the correct records', async () => {
  const { store, workflow } = fixture();
  await drain(workflow);
  assert.equal(store.jobs[0].tokens_used, 45);
  assert.equal(store.jobs[0].cost_usd, 0.03);
  assert.ok(store.runs.every((run) => run.model && run.tokens_in === 10 && run.tokens_out === 5));
  const metrics = store.events.filter((event) => event.type === 'activity' && event.payload?.provider);
  assert.equal(metrics.length, 3);
  assert.ok(metrics.every((event) => event.jobId && event.taskId && event.runId));
  assert.deepEqual(metrics.map((event) => event.payload.provider), ['anthropic', 'anthropic', 'anthropic']);
  assert.ok(store.events.some((event) => event.type === 'job_completed'));
});

test('errors redact credential-shaped values before persistence', () => {
  const credentialShapedFixture = 'sk-' + 'example123456789';
  assert.equal(safeError(new Error('Bearer secret-value ' + credentialShapedFixture)), 'Bearer [REDACTED] [REDACTED]');
});

test('workspace-scoped jobs enforce policy while legacy jobs remain unchanged', () => {
  const policyStore = { marker: 'policy-store' };
  assert.equal(selectWorkspacePolicyStore({ policyStore, workspaceId: 'workspace-1' }), policyStore);
  assert.equal(selectWorkspacePolicyStore({ policyStore, workspaceId: null }), null);
  assert.equal(selectWorkspacePolicyStore({ policyStore, workspaceId: null, enforceLegacy: true }), policyStore);
  assert.equal(selectWorkspacePolicyStore({ policyStore: null, workspaceId: 'workspace-1' }), null);
});

class MemoryStore {
  constructor() {
    this.now = 100_000;
    this.serial = 0;
    this.agents = {
      'chief-of-staff': { id: 'chief', slug: 'chief-of-staff', system_prompt: 'Chief '.repeat(30), allowed_tools: [] },
      'research-strategy': { id: 'research', slug: 'research-strategy', system_prompt: 'Research '.repeat(30), allowed_tools: ['web_search', 'web_fetch'] },
    };
    this.jobs = [{ id: 'job-1', title: 'Cost research', goal: 'Research three practical API cost reductions.', status: 'planning', priority: 'normal', tokens_used: 0, cost_usd: 0 }];
    this.tasks = [];
    this.runs = [];
    this.results = [];
    this.handoffs = [];
    this.modelAttempts = [];
    this.events = [];
  }

  id(prefix) { this.serial += 1; return `${prefix}-${this.serial}`; }
  async emit(event) { this.events.push(structuredClone(event)); }
  async getAgent(slug) { return structuredClone(this.agents[slug]); }
  async getJob(id) { return structuredClone(this.jobs.find((job) => job.id === id)); }

  async claimNextJob() {
    const job = this.jobs.find((candidate) => candidate.status === 'planning');
    if (!job) return null;
    job.status = 'running';
    return structuredClone(job);
  }

  async ensureTask({ jobId, agentSlug, title, brief, sequence, dependsOn = [], maxAttempts = 3 }) {
    const matches = this.tasks.filter((task) => task.job_id === jobId && task.sequence === sequence);
    if (matches.length > 1) throw new Error('Duplicate workflow tasks');
    if (matches.length === 1) return { ...structuredClone(matches[0]), created: false };
    const task = { id: this.id('task'), job_id: jobId, agent_id: this.agents[agentSlug].id, agent_slug: agentSlug, title, brief, sequence, depends_on: [...dependsOn], max_attempts: maxAttempts, attempts: 0, status: 'queued', progress: 0 };
    this.tasks.push(task);
    await this.emit({ jobId, taskId: task.id, agentId: task.agent_id, type: 'task_created', message: title, payload: { sequence, depends_on: dependsOn } });
    await this.emit({ jobId, taskId: task.id, agentId: task.agent_id, type: 'agent_assigned', message: title });
    return { ...structuredClone(task), created: true };
  }

  async claimNextTask() {
    const task = this.tasks.find((candidate) => candidate.status === 'queued' && candidate.depends_on.every((id) => this.tasks.find((dependency) => dependency.id === id)?.status === 'done'));
    if (!task) return null;
    task.status = 'running';
    task.attempts += 1;
    task.started_at = this.now;
    const run = { id: this.id('run'), task_id: task.id, job_id: task.job_id, agent_id: task.agent_id, attempt_no: task.attempts, status: 'running', model: null, tokens_in: 0, tokens_out: 0, cost_usd: 0 };
    this.runs.push(run);
    await this.emit({ jobId: task.job_id, taskId: task.id, runId: run.id, agentId: task.agent_id, type: 'agent_started', message: task.title, payload: { attempt: task.attempts } });
    const upstream = task.depends_on.map((id) => {
      const dependency = this.tasks.find((candidate) => candidate.id === id);
      const result = [...this.results].reverse().find((candidate) => candidate.task_id === id);
      return { task_id: id, title: dependency.title, agent_slug: dependency.agent_slug, summary: result?.summary, content: result?.content };
    });
    return { task_id: task.id, job_id: task.job_id, run_id: run.id, agent_id: task.agent_id, agent_slug: task.agent_slug, attempt_no: task.attempts, max_attempts: task.max_attempts, title: task.title, brief: task.brief, goal: this.jobs.find((job) => job.id === task.job_id).goal, upstream };
  }

  async completeTask(claim, result, summary) {
    const task = this.tasks.find((candidate) => candidate.id === claim.task_id);
    if (task.status === 'done') return { already_done: true };
    assert.equal(task.status, 'running');
    const run = this.runs.find((candidate) => candidate.id === claim.run_id);
    const stored = { id: this.id('result'), job_id: task.job_id, task_id: task.id, agent_id: task.agent_id, kind: 'task', summary, content: result.text, format: 'markdown' };
    this.results.push(stored);
    Object.assign(run, { status: 'succeeded', tokens_in: result.tokensIn, tokens_out: result.tokensOut, cost_usd: result.costUsd, ended_at: this.now });
    Object.assign(task, { status: 'done', progress: 100, completed_at: this.now });
    const job = this.jobs.find((candidate) => candidate.id === task.job_id);
    job.tokens_used += result.tokensIn + result.tokensOut;
    job.cost_usd = Number((job.cost_usd + result.costUsd).toFixed(8));
    await this.emit({ jobId: task.job_id, taskId: task.id, runId: run.id, agentId: task.agent_id, type: 'result_produced', message: 'Result saved', payload: { result_id: stored.id } });
    await this.emit({ jobId: task.job_id, taskId: task.id, runId: run.id, agentId: task.agent_id, type: 'task_completed', message: 'Task completed' });
    for (const dependent of this.tasks.filter((candidate) => candidate.status === 'queued' && candidate.depends_on.includes(task.id))) {
      const handoff = { id: this.id('handoff'), job_id: task.job_id, from_agent_id: task.agent_id, to_agent_id: dependent.agent_id, from_task_id: task.id, to_task_id: dependent.id, summary };
      this.handoffs.push(handoff);
      await this.emit({ jobId: task.job_id, taskId: dependent.id, agentId: task.agent_id, fromAgentId: task.agent_id, toAgentId: dependent.agent_id, type: 'handoff', message: 'Handoff', payload: { from_task: task.id, to_task: dependent.id } });
    }
    if (this.tasks.filter((candidate) => candidate.job_id === job.id).every((candidate) => ['done', 'skipped'].includes(candidate.status))) {
      job.status = 'completed';
      this.results.push({ ...stored, id: this.id('result'), kind: 'final' });
      await this.emit({ jobId: job.id, agentId: task.agent_id, type: 'job_completed', message: 'Job completed', payload: { tokens: job.tokens_used, cost_usd: job.cost_usd } });
    }
    return { result_id: stored.id, job_completed: job.status === 'completed' };
  }

  async failTask(claim, error) {
    const task = this.tasks.find((candidate) => candidate.id === claim.task_id);
    if (task.status !== 'running') return { ignored: true };
    const run = this.runs.find((candidate) => candidate.id === claim.run_id);
    Object.assign(run, { status: 'failed', error_message: error, ended_at: this.now });
    await this.emit({ jobId: task.job_id, taskId: task.id, runId: run.id, agentId: task.agent_id, type: 'error', message: error, payload: { attempt: task.attempts } });
    if (task.attempts < task.max_attempts) {
      task.status = 'queued';
      task.started_at = null;
      await this.emit({ jobId: task.job_id, taskId: task.id, agentId: task.agent_id, type: 'retry', message: 'Retrying' });
      return { will_retry: true };
    }
    task.status = 'failed';
    for (const downstream of this.tasks.filter((candidate) => candidate.depends_on.includes(task.id) && candidate.status === 'queued')) downstream.status = 'blocked';
    const job = this.jobs.find((candidate) => candidate.id === task.job_id);
    job.status = 'failed';
    await this.emit({ jobId: job.id, agentId: task.agent_id, type: 'job_failed', message: 'Job failed' });
    return { will_retry: false };
  }

  async requeueStaleTasks() {
    const stale = this.tasks.filter((task) => task.status === 'running' && task.stale);
    for (const task of stale) {
      task.stale = false;
      const run = [...this.runs].reverse().find((candidate) => candidate.task_id === task.id && candidate.status === 'running');
      await this.failTask({ task_id: task.id, run_id: run.id }, 'Stale: no heartbeat, assumed crashed');
    }
    return stale.length;
  }

  async setRunModel(runId, model) { this.runs.find((run) => run.id === runId).model = model; }
  async recordModelAttempt(attempt) {
    const index = this.modelAttempts.findIndex((candidate) => candidate.id === attempt.id);
    if (index >= 0) this.modelAttempts[index] = structuredClone(attempt);
    else this.modelAttempts.push(structuredClone(attempt));
  }
  async touchTask(taskId, progress) {
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (task.status === 'running') { task.started_at = this.now; task.progress = progress; }
  }
}
