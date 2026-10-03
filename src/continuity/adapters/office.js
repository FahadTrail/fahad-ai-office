import { SupabaseAgentSessionStore } from '../../agent-state/session-store.js';
import { normalizedStatus } from '../adapter-contract.js';

function unwrap(label, response) {
  if (response?.error) throw new Error(`${label}: ${response.error.message}`);
  return response?.data ?? null;
}

// create_coding_session writes agent_sessions.budget_usd, which is checked
// `budget_usd > 0 and budget_usd <= 500` (column default and Hub default are
// both 5). A missing or invalid task budget must never be sent as 0 — the
// old `task.budgetUsd ?? 0` failed the live Phase N Office leg with
// agent_sessions_budget_usd_check.
const DEFAULT_BUDGET_USD = 5;
const MAX_BUDGET_USD = 500;
function boundedBudget(requested) {
  const value = Number(requested);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_BUDGET_USD;
  return Math.min(value, MAX_BUDGET_USD);
}
export class OfficeContinuityAdapter {
  key = 'office';

  constructor({ db, nativeStore = db ? new SupabaseAgentSessionStore(db) : null, checkpointBuilder, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), drainTimeoutMs = 5 * 60_000, drainPollMs = 1000 } = {}) {
    if (!db || !nativeStore) throw new TypeError('Office adapter requires the existing Coding Agent database and store');
    this.db = db;
    this.nativeStore = nativeStore;
    this.checkpointBuilder = checkpointBuilder;
    this.sleep = sleep;
    this.drainTimeoutMs = drainTimeoutMs;
    this.drainPollMs = drainPollMs;
  }

  capabilities() {
    return {
      executionMode: 'EXECUTABLE', headless: true, resume: true, checkpoint: true,
      structuredOutput: true, usageReporting: true, worktrees: true,
      worktreeManagement: 'adapter',
      authRequirement: 'Existing Office service role and native Coding Agent configuration',
      maxContext: null, privacyClasses: ['PUBLIC', 'NORMAL', 'PRIVATE', 'CONFIDENTIAL'],
      taskSizes: ['small', 'medium', 'large', 'refactor'], taskTypes: ['coding'], quality: 4,
      taskFit: { small: 5, medium: 4, large: 3, refactor: 3 }, speed: 3, costClass: 'free-first', quotaSource: 'office-pools',
    };
  }

  async available() { return { ok: true, reason: null, authState: 'AUTHENTICATED' }; }
  async authReadiness() { return this.available(); }
  async health() { return { status: 'healthy', basis: 'MEASURED', detail: 'in-process Coding Agent' }; }

  async start({ continuationPacket, branch, task = {} }) {
    const session = await this.nativeStore.createSession({
      workspaceId: task.projectId,
      title: task.title || task.objective.slice(0, 120),
      objective: `${task.objective}\n\n${continuationPacket}`,
      repository: task.repository,
      baseBranch: task.baseBranch || branch,
      budgetUsd: boundedBudget(task.budgetUsd),
      config: { ...(task.config || {}), continuity: true, dataClass: task.dataClass || 'NORMAL' },
      createdBy: 'continuity-supervisor',
    });
    // The native controller reuses an existing work_branch when present. Set
    // it to the Supervisor-leased branch so its sandbox cannot fork a second,
    // unleased branch of the same task.
    unwrap('bind Office Coding Agent to continuity branch', await this.db.from('agent_sessions')
      .update({ work_branch: branch }).eq('id', session.id));
    session.workBranch = branch;
    return { session, nativeSessionId: session.id };
  }

  async resume({ session, continuationPacket }) {
    unwrap('resume_agent_session', await this.db.rpc('resume_agent_session', { p_session: session.id }));
    await this.nativeStore.appendEvent(session.id, { type: 'note', message: 'Continuity resume packet attached.', payload: { packetLength: continuationPacket.length } });
    return { session };
  }

  async stop({ session, reason }) {
    await this.nativeStore.appendEvent(session.id, { type: 'note', level: 'warning', message: 'Continuity Supervisor requested drain.', payload: { reason } });
    unwrap('request Office Coding Agent drain', await this.db.rpc('request_agent_session_cancel', { p_session: session.id }));
    const deadline = Date.now() + this.drainTimeoutMs;
    while (Date.now() <= deadline) {
      const current = await this.nativeStore.getSession(session.id);
      if (['completed', 'failed', 'cancelled'].includes(current?.status)) return { stopped: true, draining: false, status: current.status };
      await this.sleep(this.drainPollMs);
    }
    throw new Error('OFFICE_DRAIN_TIMEOUT');
  }

  async status({ session }) {
    const current = await this.nativeStore.getSession(session.id);
    const mapped = current?.status === 'completed' ? 'COMPLETED' : current?.status === 'failed' ? 'FAILED' : 'ACTIVE';
    return normalizedStatus(this.key, current, mapped, { current_task: current?.objective, health: current ? 'healthy' : 'down' });
  }

  async usage({ session } = {}) {
    const current = session?.id ? await this.nativeStore.getSession(session.id) : null;
    if (!current?.jobId) return { task_tokens: null, session_pct: null, weekly_pct: null, reset_at: null, basis: 'UNKNOWN' };
    const rows = unwrap('office continuity usage', await this.db.from('model_attempts').select('provider,model,status,input_tokens,output_tokens,cost_usd,duration_ms,started_at,ended_at').eq('job_id', current.jobId).order('started_at')) || [];
    const latest = rows.at(-1) || {};
    return {
      task_tokens: rows.reduce((sum, item) => sum + Number(item.input_tokens || 0) + Number(item.output_tokens || 0), 0),
      cost_usd: rows.reduce((sum, item) => sum + Number(item.cost_usd || 0), 0),
      turns: rows.length,
      elapsed_ms: rows.reduce((sum, item) => sum + Number(item.duration_ms || 0), 0),
      provider: latest.provider || null,
      model: latest.model || null,
      failures: rows.filter((item) => item.status !== 'success').length,
      session_pct: null, weekly_pct: null, reset_at: null, basis: 'MEASURED',
    };
  }

  async checkpoint({ session, context }) {
    const native = unwrap('office native checkpoint', await this.db.from('agent_checkpoints').select('id,sequence,reason,route,phase,plan,state,git_head,created_at')
      .eq('session_id', session.id).order('sequence', { ascending: false }).limit(1).maybeSingle());
    if (!this.checkpointBuilder && !context?.checkpoint) throw new Error('OFFICE_CONTINUITY_CHECKPOINT_CONTEXT_REQUIRED');
    const source = context?.checkpoint || await this.checkpointBuilder({ session, native, context });
    const payload = {
      ...source,
      ...(native?.git_head && /^[0-9a-f]{40}$/.test(native.git_head) ? { last_commit: native.git_head } : {}),
      ...(native?.phase ? { phase: native.phase } : {}),
      timestamp: new Date().toISOString(),
    };
    return { payload, nativeCheckpointId: native?.id || context?.nativeCheckpointId || null };
  }

  async handoff({ session, context }) {
    const checkpoint = await this.checkpoint({ session, context });
    return { checkpoint, packet: context?.packet || null };
  }
}
