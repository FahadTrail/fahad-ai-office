import { canTransition } from './states.js';
import { validateCheckpoint } from './checkpoint.js';
import { sanitizeContinuityValue } from './safe.js';

function failure(label, error) {
  const message = error?.message || String(error || 'unknown database error');
  const wrapped = new Error(`${label}: ${message}`);
  wrapped.code = error?.code || 'CONTINUITY_STORE_ERROR';
  wrapped.cause = error;
  return wrapped;
}
function result(label, response) {
  if (response?.error) throw failure(label, response.error);
  return response?.data ?? null;
}

function row(label, response) {
  const data = result(label, response);
  return Array.isArray(data) ? (data[0] ?? null) : data;
}

const SESSION_PATCH = new Set([
  'status', 'heartbeat_at', 'ended_at', 'task_tokens', 'tokens_basis',
  'exit_reason', 'worktree', 'native_session_id', 'updated_at',
]);

function safeSessionPatch(patch) {
  return Object.fromEntries(Object.entries(patch || {}).filter(([key]) => SESSION_PATCH.has(key)));
}

export class ContinuityStore {
  constructor(db, { now = () => new Date(), env = process.env } = {}) {
    if (!db?.from || !db?.rpc) throw new TypeError('ContinuityStore requires a Supabase-compatible client');
    this.db = db;
    this.now = now;
    this.env = env;
  }

  async getWorker(key) {
    return row('read continuity worker', await this.db.from('coding_workers').select('*').eq('key', key).maybeSingle());
  }

  async listWorkers({ enabled } = {}) {
    let query = this.db.from('coding_workers').select('*').order('key');
    if (typeof enabled === 'boolean') query = query.eq('enabled', enabled);
    return result('list continuity workers', await query) || [];
  }

  async setWorkerEnabled(key, enabled, { reason = null } = {}) {
    const patch = { enabled: Boolean(enabled), updated_at: this.now().toISOString() };
    if (reason != null) patch.last_error = String(sanitizeContinuityValue(reason, this.env)).slice(0, 2000);
    return row('update continuity worker', await this.db.from('coding_workers').update(patch).eq('key', key).select('*').single());
  }

  async createSession({ workerKey, projectId = null, repository, branch, worktree = null, objective, nativeSessionId = null, status = 'STANDBY' }) {
    const payload = {
      worker_key: workerKey,
      project_id: projectId,
      repository,
      branch,
      worktree,
      objective,
      native_session_id: nativeSessionId,
      status,
    };
    return row('create continuity session', await this.db.from('coding_worker_sessions').insert(payload).select('*').single());
  }

  async getSession(id) {
    return row('read continuity session', await this.db.from('coding_worker_sessions').select('*').eq('id', id).maybeSingle());
  }

  async listSessions({ projectId, statuses, limit = 100 } = {}) {
    let query = this.db.from('coding_worker_sessions').select('*').order('created_at', { ascending: false }).limit(limit);
    if (projectId) query = query.eq('project_id', projectId);
    if (statuses?.length) query = query.in('status', statuses);
    return result('list continuity sessions', await query) || [];
  }

  async updateSession(id, patch) {
    const safe = safeSessionPatch({ ...patch, updated_at: this.now().toISOString() });
    if (!Object.keys(safe).length) throw new TypeError('No supported continuity session fields to update');
    return row('update continuity session', await this.db.from('coding_worker_sessions').update(safe).eq('id', id).select('*').single());
  }

  async transitionSession(id, to, patch = {}) {
    const current = await this.getSession(id);
    if (!current) throw Object.assign(new Error('CONTINUITY_SESSION_NOT_FOUND'), { code: 'CONTINUITY_SESSION_NOT_FOUND' });
    if (current.status !== to && !canTransition(current.status, to)) {
      throw Object.assign(new Error(`CONTINUITY_TRANSITION_INVALID: ${current.status} -> ${to}`), { code: 'CONTINUITY_TRANSITION_INVALID' });
    }
    return this.updateSession(id, { ...patch, status: to });
  }

  async completeSession(id, { taskTokens = null, tokensBasis = 'UNKNOWN' } = {}) {
    return this.transitionSession(id, 'COMPLETED', {
      task_tokens: taskTokens,
      tokens_basis: tokensBasis,
      ended_at: this.now().toISOString(),
    });
  }

  async failSession(id, { status = 'FAILED', reason } = {}) {
    return this.transitionSession(id, status, {
      exit_reason: String(reason || status).slice(0, 2000),
      ended_at: this.now().toISOString(),
    });
  }

  async acquireLease(sessionId, leaseSeconds = 300) {
    return row('acquire continuity lease', await this.db.rpc('acquire_coding_lease', { p_session: sessionId, p_lease_seconds: leaseSeconds }));
  }

  async heartbeatLease(leaseId, token, leaseSeconds = 300) {
    return Boolean(result('heartbeat continuity lease', await this.db.rpc('heartbeat_coding_lease', {
      p_lease: leaseId, p_token: token, p_lease_seconds: leaseSeconds,
    })));
  }

  async releaseLease(leaseId, token, checkpointId, finalStatus = 'RELEASED') {
    return Boolean(result('release continuity lease', await this.db.rpc('release_coding_lease', {
      p_lease: leaseId, p_token: token, p_checkpoint: checkpointId, p_final_status: finalStatus,
    })));
  }

  async freezeStaleLeases(graceSeconds = 0) {
    const data = result('freeze stale continuity leases', await this.db.rpc('freeze_stale_coding_leases', { p_grace_seconds: graceSeconds }));
    return data || [];
  }

  async reclaimLease(leaseId) {
    return Boolean(result('reclaim continuity lease', await this.db.rpc('reclaim_coding_lease', { p_lease: leaseId })));
  }

  async listLeases({ statuses, repository, branch, limit = 100 } = {}) {
    let query = this.db.from('coding_leases').select('*').order('started_at', { ascending: false }).limit(limit);
    if (statuses?.length) query = query.in('status', statuses);
    if (repository) query = query.eq('repository', repository);
    if (branch) query = query.eq('branch', branch);
    return result('list continuity leases', await query) || [];
  }

  async saveCheckpoint(leaseId, token, payload, nativeCheckpointId = null) {
    return row('save continuity checkpoint', await this.db.rpc('save_continuity_checkpoint', {
      p_lease: leaseId,
      p_token: token,
      p_payload: payload,
      p_native_checkpoint: nativeCheckpointId,
    }));
  }

  async listCheckpoints({ sessionId, limit = 100 } = {}) {
    let query = this.db.from('coding_checkpoints').select('*').order('sequence', { ascending: false }).limit(limit);
    if (sessionId) query = query.eq('session_id', sessionId);
    return result('list continuity checkpoints', await query) || [];
  }

  async getCheckpoint(id) {
    return row('read continuity checkpoint', await this.db.from('coding_checkpoints').select('*').eq('id', id).maybeSingle());
  }

  async latestCheckpoint(sessionId) {
    return row('read latest continuity checkpoint', await this.db.from('coding_checkpoints').select('*')
      .eq('session_id', sessionId).order('sequence', { ascending: false }).limit(1).maybeSingle());
  }

  async latestValidCheckpoint(sessionId) {
    const rows = await this.listCheckpoints({ sessionId, limit: 100 });
    return rows.find((entry) => entry?.payload && validateCheckpoint(entry.payload, { env: this.env }).ok) || null;
  }

  async proposeHandoff({ fromSessionId, checkpointId, reason, packet, toWorker = null }) {
    return row('propose continuity handoff', await this.db.rpc('propose_handoff', {
      p_from_session: fromSessionId,
      p_checkpoint: checkpointId,
      p_reason: reason,
      p_packet: packet,
      p_to_worker: toWorker,
    }));
  }

  async acceptHandoff(handoffId, toSessionId) {
    return row('accept continuity handoff', await this.db.rpc('accept_handoff', { p_handoff: handoffId, p_to_session: toSessionId }));
  }

  async failHandoff(handoffId) {
    return row('fail continuity handoff', await this.db.from('coding_handoffs').update({ status: 'FAILED' }).eq('id', handoffId).select('*').single());
  }

  async listHandoffs({ statuses, sessionId, limit = 100 } = {}) {
    let query = this.db.from('coding_handoffs').select('*').order('created_at', { ascending: false }).limit(limit);
    if (statuses?.length) query = query.in('status', statuses);
    if (sessionId) query = query.or(`from_session_id.eq.${sessionId},to_session_id.eq.${sessionId}`);
    return result('list continuity handoffs', await query) || [];
  }

  async getHandoff(id) {
    return row('read continuity handoff', await this.db.from('coding_handoffs').select('*').eq('id', id).maybeSingle());
  }

  async writeUsageSnapshot(snapshot) {
    return row('write continuity usage snapshot', await this.db.from('coding_usage_snapshots').insert(snapshot).select('*').single());
  }

  async listUsageSnapshots({ workerKey, sessionId, since, limit = 500 } = {}) {
    let query = this.db.from('coding_usage_snapshots').select('*').order('taken_at', { ascending: false }).limit(limit);
    if (workerKey) query = query.eq('worker_key', workerKey);
    if (sessionId) query = query.eq('session_id', sessionId);
    if (since) query = query.gte('taken_at', since);
    return result('list continuity usage snapshots', await query) || [];
  }

  async recordEvent(event, { level = 'info', message = event, payload = {} } = {}) {
    const safe = sanitizeContinuityValue({ message, payload }, this.env);
    const response = await this.db.from('events').insert({
      type: 'activity',
      level,
      message: String(safe.message).slice(0, 2000),
      payload: { kind: 'continuity_event', event, ...safe.payload },
    });
    result('record continuity event', response);
    return true;
  }

  async readState({ projectId = null } = {}) {
    const [workers, sessions, leases, handoffs, usage] = await Promise.all([
      this.listWorkers(),
      this.listSessions({ projectId }),
      this.listLeases({ statuses: ['ACTIVE', 'FROZEN'] }),
      this.listHandoffs({ statuses: ['PROPOSED', 'ACCEPTED', 'STARTED'] }),
      this.listUsageSnapshots({ limit: 100 }),
    ]);
    const sessionIds = sessions.map((session) => session.id);
    const checkpoints = [];
    for (const sessionId of sessionIds) {
      const latest = await this.latestCheckpoint(sessionId);
      if (latest) checkpoints.push(latest);
    }
    return { workers, sessions, leases, checkpoints, handoffs, usage };
  }
}

