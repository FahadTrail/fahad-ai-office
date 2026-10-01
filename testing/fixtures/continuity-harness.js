import { canTransition } from '../../src/continuity/states.js';
import { normalizedStatus } from '../../src/continuity/adapter-contract.js';

const clone = (value) => structuredClone(value);

export class MemoryContinuityStore {
  constructor({ workers = [] } = {}) {
    this.workers = new Map(workers.map((worker) => [worker.key, clone(worker)]));
    this.sessions = new Map(); this.leases = new Map(); this.checkpoints = new Map(); this.handoffs = new Map(); this.usage = []; this.events = [];
    this.sequence = { session: 0, lease: 0, checkpoint: 0, handoff: 0 };
  }
  async listWorkers() { return [...this.workers.values()].map(clone); }
  async setWorkerEnabled(key, enabled) { const row = this.workers.get(key); row.enabled = enabled; return clone(row); }
  async createSession(input) { const id = `session-${++this.sequence.session}`; const row = { id, worker_key: input.workerKey, project_id: input.projectId, repository: input.repository, branch: input.branch, worktree: input.worktree, objective: input.objective, status: input.status || 'STANDBY' }; this.sessions.set(id, row); return clone(row); }
  async getSession(id) { return this.sessions.has(id) ? clone(this.sessions.get(id)) : null; }
  async updateSession(id, patch) { const row = this.sessions.get(id); Object.assign(row, patch); return clone(row); }
  async listSessions({ statuses } = {}) { return [...this.sessions.values()].filter((row) => !statuses?.length || statuses.includes(row.status)).map(clone); }
  async transitionSession(id, to, patch = {}) { const row = this.sessions.get(id); if (!row) throw new Error('not found'); if (row.status !== to && !canTransition(row.status, to)) throw new Error(`invalid ${row.status} -> ${to}`); Object.assign(row, patch, { status: to }); return clone(row); }
  async failSession(id, { status, reason }) { const row = this.sessions.get(id); row.status = status; row.exit_reason = reason; return clone(row); }
  async acquireLease(sessionId) { const session = this.sessions.get(sessionId); if ([...this.leases.values()].some((row) => row.repository === session.repository && row.branch === session.branch && ['ACTIVE', 'FROZEN'].includes(row.status))) throw new Error('CODING_LEASE_HELD'); const id = `lease-${++this.sequence.lease}`; const row = { id, token: `token-${id}`, session_id: sessionId, worker_key: session.worker_key, repository: session.repository, branch: session.branch, worktree: session.worktree, status: 'ACTIVE', expires_at: '2099-01-01T00:00:00Z' }; this.leases.set(id, row); session.status = 'ACTIVE'; return clone(row); }
  async heartbeatLease(id, token) { const row = this.leases.get(id); return Boolean(row && row.token === token && row.status === 'ACTIVE'); }
  async releaseLease(id, token, checkpointId, finalStatus) { const lease = this.leases.get(id); if (!lease || lease.token !== token || !checkpointId) return false; lease.status = 'RELEASED'; lease.checkpoint_id = checkpointId; this.sessions.get(lease.session_id).status = finalStatus; return true; }
  async freezeStaleLeases() { const rows = [...this.leases.values()].filter((row) => row.status === 'ACTIVE' && row.stale); rows.forEach((row) => { row.status = 'FROZEN'; this.sessions.get(row.session_id).status = 'ABNORMAL_EXIT'; }); return rows.map(clone); }
  async reclaimLease(id) { const row = this.leases.get(id); if (row?.status !== 'FROZEN') return false; row.status = 'RECLAIMED'; return true; }
  async saveCheckpoint(leaseId, token, payload, nativeCheckpointId = null) { const lease = this.leases.get(leaseId); if (!lease || lease.token !== token || lease.status !== 'ACTIVE') throw new Error('CODING_LEASE_INVALID'); const id = `checkpoint-${++this.sequence.checkpoint}`; const prior = [...this.checkpoints.values()].filter((row) => row.session_id === lease.session_id); const row = { id, session_id: lease.session_id, sequence: prior.length + 1, payload: clone(payload), last_commit: payload.last_commit, status: payload.status, next_exact_action: payload.next_exact_action, native_checkpoint_id: nativeCheckpointId }; this.checkpoints.set(id, row); lease.checkpoint_id = id; return clone(row); }
  async latestCheckpoint(sessionId) { return [...this.checkpoints.values()].filter((row) => row.session_id === sessionId).sort((a, b) => b.sequence - a.sequence).map(clone)[0] || null; }
  async latestValidCheckpoint(sessionId) { return this.latestCheckpoint(sessionId); }
  async listCheckpoints() { return [...this.checkpoints.values()].map(clone); }
  async proposeHandoff(input) { const id = `handoff-${++this.sequence.handoff}`; const from = this.sessions.get(input.fromSessionId); const row = { id, from_session_id: input.fromSessionId, to_session_id: null, from_worker: from.worker_key, to_worker: input.toWorker, checkpoint_id: input.checkpointId, reason: input.reason, packet: input.packet, status: 'PROPOSED' }; this.handoffs.set(id, row); return clone(row); }
  async acceptHandoff(id, sessionId) { const row = this.handoffs.get(id); row.status = 'ACCEPTED'; row.to_session_id = sessionId; return clone(row); }
  async failHandoff(id) { const row = this.handoffs.get(id); row.status = 'FAILED'; return clone(row); }
  async listHandoffs() { return [...this.handoffs.values()].map(clone); }
  async writeUsageSnapshot(snapshot) { const row = { id: this.usage.length + 1, ...clone(snapshot) }; this.usage.push(row); return clone(row); }
  async listUsageSnapshots() { return this.usage.map(clone); }
  async listLeases({ statuses, repository, branch } = {}) { return [...this.leases.values()].filter((row) => (!statuses?.length || statuses.includes(row.status)) && (!repository || row.repository === repository) && (!branch || row.branch === branch)).map(clone); }
  async recordEvent(event, options) { this.events.push({ event, ...clone(options) }); return true; }
}
export function fakeAdapter(key, { quality = 4, privacyClasses = ['PUBLIC', 'NORMAL'], usage = { task_tokens: 10, session_pct: null, weekly_pct: null, reset_at: null, basis: 'MEASURED' }, available = true } = {}) {
  const calls = [];
  return {
    key, calls,
    capabilities: () => ({ headless: true, resume: true, structuredOutput: true, usageReporting: true, worktrees: true, maxContext: null, privacyClasses, taskSizes: ['small', 'medium', 'large', 'refactor'], taskTypes: ['coding'], quality, taskFit: { medium: quality }, speed: quality, costClass: 'included', quotaSource: key }),
    available: async () => ({ ok: available, reason: available ? null : 'NOT_CONFIGURED' }),
    health: async () => ({ status: available ? 'healthy' : 'down', basis: 'MEASURED', detail: key }),
    start: async (input) => { calls.push({ method: 'start', input }); return { session: { id: `${key}-run-${calls.length}`, worktree: input.worktree } }; },
    resume: async (input) => { calls.push({ method: 'resume', input }); return { session: input.session }; },
    stop: async (input) => { calls.push({ method: 'stop', input }); return { stopped: true }; },
    status: async ({ session }) => normalizedStatus(key, session, 'ACTIVE', { health: 'healthy' }),
    usage: async () => clone(usage),
    checkpoint: async ({ context }) => ({ payload: clone(context.checkpoint), nativeCheckpointId: null }),
    handoff: async ({ context }) => ({ checkpoint: { payload: clone(context.checkpoint), nativeCheckpointId: null }, packet: context.packet }),
  };
}
export function validCheckpoint(patch = {}) {
  return {
    schema: 'continuity.checkpoint.v1', timestamp: '2026-10-01T12:00:00Z', repository: 'FahadTrail/fahad-ai-office', branch: 'codex/continuity-runtime', worktree: null,
    agent_id: 'office', agent_type: 'native', session_id: 'pending', objective: 'Complete continuity safely.', phase: 'C', status: 'ACTIVE',
    base_commit: 'a'.repeat(40), last_commit: 'b'.repeat(40), rollback_commit: 'a'.repeat(40), files_changed: ['src/continuity/supervisor.js'], diff_summary: 'Continuity runtime.',
    tests_run: 'node --test', tests_passed: 1, tests_failed: 0, ci_status: 'success', decisions: [], constraints: [], errors: [], unresolved_items: [],
    quota_state: { basis: 'UNKNOWN', used_pct: null, reset_at: null }, rate_limit_state: { limited: false, retry_after_s: null }, next_exact_action: 'Continue the same branch from this checkpoint.', summary_md: 'Runtime in progress.', data_class: 'PUBLIC', privacy_requirements: [], handoff_reason: null,
    ...patch,
  };
}
