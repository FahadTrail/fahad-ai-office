// In-memory Office store (jobs, tasks, runs, results, events) used by the
// workflow tests. Mirrors the Supabase RPC semantics the workflow relies on.
import assert from 'node:assert/strict';

export class MemoryStore {
  constructor({ goal = 'Research three practical API cost reductions.', projectId = null } = {}) {
    this.now = 100_000;
    this.serial = 0;
    this.agents = {
      'chief-of-staff': { id: 'chief', slug: 'chief-of-staff', system_prompt: 'Chief '.repeat(30), allowed_tools: [] },
      'research-strategy': { id: 'research', slug: 'research-strategy', system_prompt: 'Research '.repeat(30), allowed_tools: ['web_search', 'web_fetch'] },
      'business-finance': { id: 'finance', slug: 'business-finance', system_prompt: 'Finance '.repeat(30), allowed_tools: ['web_search', 'web_fetch'] },
    };
    this.jobs = [{ id: 'job-1', title: 'Cost research', goal, project_id: projectId, status: 'planning', priority: 'normal', tokens_used: 0, cost_usd: 0 }];
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
    return { task_id: task.id, job_id: task.job_id, run_id: run.id, agent_id: task.agent_id, agent_slug: task.agent_slug, attempt_no: task.attempts, max_attempts: task.max_attempts, title: task.title, brief: task.brief, goal: this.jobs.find((job) => job.id === task.job_id).goal, project_id: this.jobs.find((job) => job.id === task.job_id).project_id, upstream };
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
