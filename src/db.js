// Supabase is the durable workflow authority. State transitions that require
// locking or idempotency stay in the existing service-role-only RPCs.

import { buildJobContext } from './job-context.js';
import { createClient } from '@supabase/supabase-js';
import { FAILURE_CLASS, GatewayError } from './model-gateway/contracts.js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  process.exit(1);
}

export const db = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Keep OTP sessions isolated from service-role database access.
export const hubAuth = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
}).auth;

export function log(...parts) {
  console.log('[' + new Date().toISOString() + ']', ...parts);
}

export class SupabaseStore {
  constructor(client = db) {
    this.db = client;
  }

  async emit(event) {
    const row = {
      job_id: event.jobId ?? null,
      task_id: event.taskId ?? null,
      run_id: event.runId ?? null,
      agent_id: event.agentId ?? null,
      from_agent_id: event.fromAgentId ?? null,
      to_agent_id: event.toAgentId ?? null,
      type: event.type,
      level: event.level ?? 'info',
      message: event.message,
      payload: event.payload ?? {},
    };
    const { error } = await this.db.from('events').insert(row);
    if (error && event.required) throw new GatewayError('Required audit event could not be recorded', {
      code: 'AUDIT_PERSISTENCE_FAILED', failureClass: FAILURE_CLASS.FATAL, cause: error,
    });
    if (error) log('WARN  could not write event:', error.message);
    else log('event  ' + row.type.padEnd(18) + ' ' + row.message);
  }

  async getAgent(slug) {
    const { data, error } = await this.db.from('agents').select('*').eq('slug', slug).single();
    if (error) throw new Error(`Agent "${slug}" not found: ${error.message}`);
    return data;
  }

  async claimNextJob() {
    const { data, error } = await this.db.rpc('claim_next_job');
    if (error) throw new Error('claim_next_job failed: ' + error.message);
    return data?.id ? data : null;
  }

  async claimNextTask() {
    const { data, error } = await this.db.rpc('claim_next_task', { p_agent_slug: null });
    if (error) throw new Error('claim_next_task failed: ' + error.message);
    return data?.task_id ? data : null;
  }

  async ensureTask({ jobId, agentSlug, title, brief, sequence, dependsOn = [], maxAttempts = 3 }) {
    const { data: rows, error: readError } = await this.db
      .from('tasks')
      .select('id,agent_id,title,brief,sequence,depends_on,max_attempts,status')
      .eq('job_id', jobId)
      .eq('sequence', sequence)
      .limit(2);
    if (readError) throw new Error('Could not inspect task sequence: ' + readError.message);
    if (rows.length > 1) throw new Error(`Duplicate workflow tasks found at sequence ${sequence}`);

    const agent = await this.getAgent(agentSlug);
    if (rows.length === 1) {
      const task = rows[0];
      const actualDependencies = [...(task.depends_on || [])].sort();
      const expectedDependencies = [...dependsOn].sort();
      if (task.agent_id !== agent.id || task.title !== title ||
          JSON.stringify(actualDependencies) !== JSON.stringify(expectedDependencies)) {
        throw new Error(`Existing task at sequence ${sequence} conflicts with the workflow plan`);
      }
      return { ...task, created: false };
    }

    const { data: taskId, error } = await this.db.rpc('create_task', {
      p_job: jobId,
      p_agent_slug: agentSlug,
      p_title: title,
      p_brief: brief,
      p_sequence: sequence,
      p_depends_on: dependsOn,
      p_max_attempts: maxAttempts,
    });
    if (error) throw new Error('create_task failed: ' + error.message);
    return { id: taskId, agent_id: agent.id, title, brief, sequence, depends_on: dependsOn, created: true };
  }

  async completeTask(task, outcome, summary) {
    const { data, error } = await this.db.rpc('complete_task', {
      p_task: task.task_id,
      p_run: task.run_id,
      p_summary: summary,
      p_content: outcome.text,
      p_format: 'markdown',
      p_tokens_in: outcome.tokensIn,
      p_tokens_out: outcome.tokensOut,
      p_cost: outcome.costUsd,
    });
    if (error) throw new Error('complete_task failed: ' + error.message);
    return data;
  }

  async failTask(task, errorMessage) {
    const { data, error } = await this.db.rpc('fail_task', {
      p_task: task.task_id,
      p_run: task.run_id,
      p_error: errorMessage,
    });
    if (error) throw new Error('fail_task failed: ' + error.message);
    return data;
  }

  async requeueStaleTasks(minutes) {
    const { data, error } = await this.db.rpc('requeue_stale_tasks', {
      p_older_than: `${minutes} minutes`,
    });
    if (error) throw new Error('requeue_stale_tasks failed: ' + error.message);
    return Number(data || 0);
  }

  async setRunModel(runId, model) {
    const { error } = await this.db.from('runs').update({ model }).eq('id', runId).eq('status', 'running');
    if (error) throw new Error('Could not record run model: ' + error.message);
  }

  async recordModelAttempt(attempt) {
    const usage = attempt.usage || {};
    const row = {
      id: attempt.id,
      workspace_id: attempt.context?.workspaceId || null,
      job_id: attempt.context?.jobId,
      task_id: attempt.context?.taskId,
      run_id: attempt.context?.runId,
      attempt_no: attempt.attemptNo,
      provider_attempt: attempt.providerAttempt,
      provider: attempt.provider,
      model: attempt.model,
      stage: attempt.stage,
      status: attempt.status,
      idempotency_key: attempt.idempotencyKey,
      client_request_id: attempt.clientRequestId,
      provider_request_id: attempt.providerRequestId || null,
      route: attempt.route || [],
      input_tokens: Number(usage.inputTokens || 0),
      output_tokens: Number(usage.outputTokens || 0),
      reasoning_tokens: Number(usage.reasoningTokens || 0),
      cached_input_tokens: Number(usage.cachedInputTokens || 0),
      cost_usd: Number(usage.costUsd || 0),
      duration_ms: Number(attempt.durationMs || 0),
      error_code: attempt.error?.code || null,
      failure_class: attempt.error?.failureClass || null,
      http_status: attempt.error?.status || null,
      started_at: attempt.startedAt,
      ended_at: attempt.endedAt || null,
      updated_at: new Date().toISOString(),
    };
    const { error } = await this.db.from('model_attempts').upsert(row, { onConflict: 'id' });
    if (error) throw new Error('Could not record model attempt: ' + error.message);
  }

  async touchTask(taskId, progress) {
    const values = { started_at: new Date().toISOString() };
    if (Number.isInteger(progress)) values.progress = Math.max(0, Math.min(99, progress));
    const { error } = await this.db.from('tasks').update(values).eq('id', taskId).eq('status', 'running');
    if (error) throw new Error('Could not update task heartbeat: ' + error.message);
  }

  async createJob({ title, goal, priority = 'normal', projectId = null, requestedProvider = 'auto', conversationId = null }) {
    const values = { title, goal, priority, status: 'planning', requested_provider: requestedProvider };
    if (projectId) values.project_id = projectId;
    if (conversationId) values.conversation_id = conversationId;
    const { data, error } = await this.db
      .from('jobs')
      .insert(values)
      .select('id,title,goal,status,priority')
      .single();
    if (error) throw new Error('Could not create job: ' + error.message);
    return data;
  }

  // Compact context for the Chief: project facts, owner memory, the earlier
  // turns of this conversation and the project's recent tasks.
  async jobContext(jobId) {
    const { data: job } = await this.db.from('jobs').select('id,project_id,conversation_id,created_at').eq('id', jobId).maybeSingle();
    if (!job?.project_id) return null;
    const [projectRow, memoryRows, turnRows, taskRows] = await Promise.all([
      this.db.from('projects').select('id,name,description,default_repository').eq('id', job.project_id).maybeSingle(),
      this.db.from('project_memory').select('kind,content').eq('project_id', job.project_id).order('created_at', { ascending: false }).limit(20),
      job.conversation_id
        ? this.db.from('jobs').select('id,goal,status,final_summary,created_at').eq('conversation_id', job.conversation_id).lt('created_at', job.created_at).order('created_at', { ascending: false }).limit(6)
        : Promise.resolve({ data: [] }),
      this.db.from('agent_sessions').select('title,status,result').eq('workspace_id', job.project_id).order('created_at', { ascending: false }).limit(5),
    ]);
    const project = projectRow.data || null;
    const turns = (turnRows.data || []).reverse();
    const finals = turns.length
      ? (await this.db.from('results').select('job_id,content').eq('kind', 'final').in('job_id', turns.map((turn) => turn.id))).data || []
      : [];
    return buildJobContext({
      project, memory: memoryRows.data || [], turns: turns.map((turn) => ({ ...turn, answer: finals.find((row) => row.job_id === turn.id)?.content || turn.final_summary || '' })),
      tasks: taskRows.data || [], conversationId: job.conversation_id,
    });
  }

  async createCodingSession({ workspaceId, title, objective, repository, conversationId = null, createdBy = null, budgetUsd = 2 }) {
    const { data, error } = await this.db.rpc('create_coding_session', {
      p_workspace: workspaceId, p_title: title, p_objective: objective, p_repository: repository,
      p_base_branch: 'main', p_budget_usd: budgetUsd, p_config: { publish: 'pull_request' }, p_created_by: createdBy,
    });
    if (error) throw new Error('Could not start the Coding Agent task: ' + error.message);
    const session = Array.isArray(data) ? data[0] : data;
    if (conversationId) await this.db.from('agent_sessions').update({ conversation_id: conversationId }).eq('id', session.id);
    return session;
  }

  async getJob(jobId) {
    const { data, error } = await this.db.from('jobs').select('*').eq('id', jobId).single();
    if (error) throw new Error('Could not read job: ' + error.message);
    return data;
  }
}

export const store = new SupabaseStore();
