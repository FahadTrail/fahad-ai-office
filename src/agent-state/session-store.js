// Durable Coding Agent session state. The Supabase implementation is the
// production authority (leases, fencing and checkpoints are enforced by
// database functions). The memory implementation mirrors the same semantics
// for tests and local runs, optionally persisted to a JSON file so a killed
// worker process can be restarted and resume the same session.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

// Must match the agent_events CHECK constraints in the Coding Agent migration;
// the Supabase store only warns on a rejected insert, so the memory store
// enforces the same lists to catch a new, unsupported event in tests.
export const AGENT_EVENT_TYPES = Object.freeze([
  'session', 'phase', 'plan', 'model_turn', 'provider_switch', 'checkpoint', 'tool_call', 'tool_result',
  'test', 'git', 'github', 'ci', 'deploy', 'verify', 'supabase', 'approval', 'guard', 'error', 'report', 'note', 'owner',
]);
export const AGENT_EVENT_LEVELS = Object.freeze(['info', 'success', 'warning', 'error']);

export const TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);

export class SupabaseAgentSessionStore {
  constructor(db) {
    this.db = db;
  }

  async createSession({ workspaceId, title, objective, repository, baseBranch = 'main', budgetUsd = 5, config = {}, createdBy = null }) {
    const { data, error } = await this.db.rpc('create_coding_session', {
      p_workspace: workspaceId, p_title: title, p_objective: objective, p_repository: repository,
      p_base_branch: baseBranch, p_budget_usd: budgetUsd, p_config: config, p_created_by: createdBy,
    });
    if (error) throw storeError('create_coding_session', error);
    return fromSessionRow(Array.isArray(data) ? data[0] : data);
  }

  async claim({ worker, leaseSeconds = 300 }) {
    const { data, error } = await this.db.rpc('claim_agent_session', { p_worker: worker, p_lease_seconds: leaseSeconds });
    if (error) throw storeError('claim_agent_session', error);
    const row = Array.isArray(data) ? data[0] : data;
    return row?.id ? fromSessionRow(row) : null;
  }

  // Identity-scoped claim: binds EXACTLY this session id and refuses
  // anything else, unlike claim() which may return any queued session by
  // queue order. The Phase N one-shot Office runner relies on this so a
  // drill session can never absorb an unrelated production job and a
  // production worker can never be handed the drill's session. It performs
  // the same state transition as the claim_agent_session function, guarded
  // to one id, and needs no new database object: the row is only reachable
  // this way with the service role, and the `status = 'queued'` predicate
  // makes the update atomic against a concurrent claim.
  async claimById(id, { worker, leaseSeconds = 300 } = {}) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw storeError('claimById', new Error('session id must be a uuid'));
    if (!worker) throw storeError('claimById', new Error('worker is required'));
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 3600) throw storeError('claimById', new Error('AGENT_LEASE_INVALID'));
    const current = await this.getSession(id);
    if (!current) return { ok: false, reason: 'SESSION_NOT_FOUND' };
    if (current.cancelRequested) return { ok: false, reason: 'CANCEL_REQUESTED', session: current };
    if (current.status !== 'queued') {
      return current.status === 'running' && current.leaseOwner === worker
        ? { ok: true, alreadyOwned: true, session: current }
        : { ok: false, reason: 'NOT_QUEUED', session: current };
    }
    const now = new Date();
    const { data, error } = await this.db.from('agent_sessions').update({
      status: 'running',
      lease_owner: String(worker).slice(0, 200),
      lease_token: randomUUID(),
      lease_expires_at: new Date(now.getTime() + leaseSeconds * 1000).toISOString(),
      started_at: current.startedAt || now.toISOString(),
      blocker: null,
      updated_at: now.toISOString(),
    }).eq('id', id).eq('status', 'queued').eq('cancel_requested', false).select();
    if (error) throw storeError('agent_sessions', error);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      // The row changed between read and update: never retry into a
      // different session — report the exact current state instead.
      return { ok: false, reason: 'CLAIM_RACE_LOST', session: await this.getSession(id) };
    }
    const { error: jobError } = await this.db.from('jobs').update({ status: 'running' }).eq('id', row.job_id).neq('status', 'running');
    if (jobError) console.warn('[agent-state] job status not advanced by claimById:', jobError.message);
    return { ok: true, session: fromSessionRow(row) };
  }

  async getSession(id) {
    const { data, error } = await this.db.from('agent_sessions').select('*').eq('id', id).maybeSingle();
    if (error) throw storeError('agent_sessions', error);
    return data ? fromSessionRow(data) : null;
  }

  async latestCheckpoint(sessionId) {
    const { data, error } = await this.db.from('agent_checkpoints')
      .select('sequence,reason,route,phase,plan,state,transcript,git_head,created_at')
      .eq('session_id', sessionId).not('transcript', 'is', null)
      .order('sequence', { ascending: false }).limit(1).maybeSingle();
    if (error) throw storeError('agent_checkpoints', error);
    return data ? { ...data, gitHead: data.git_head } : null;
  }

  async renewLease(session) {
    const { data, error } = await this.db.rpc('renew_agent_session_lease', {
      p_session: session.id, p_token: session.leaseToken, p_lease_seconds: 300,
    });
    if (error) throw storeError('renew_agent_session_lease', error);
    const row = Array.isArray(data) ? data[0] : data;
    return { ok: Boolean(row?.ok), cancelRequested: Boolean(row?.cancel_requested) };
  }

  async saveCheckpoint(session, { reason, patch = {}, transcript = null, gitHead = null }) {
    const { data, error } = await this.db.rpc('save_agent_checkpoint', {
      p_session: session.id, p_token: session.leaseToken, p_reason: reason, p_patch: patch,
      p_transcript: transcript, p_git_head: /^[0-9a-f]{40}$/.test(gitHead || '') ? gitHead : null,
    });
    if (error) throw storeError('save_agent_checkpoint', error);
    return Number(data);
  }

  async finish(session, { status, result = null, blocker = null, errorCode = null }) {
    const { error } = await this.db.rpc('finish_agent_session', {
      p_session: session.id, p_token: session.leaseToken, p_status: status, p_result: result,
      p_blocker: blocker ? String(blocker).slice(0, 4000) : null, p_error_code: errorCode,
    });
    if (error) throw storeError('finish_agent_session', error);
  }

  async appendEvent(sessionId, { type, level = 'info', message, payload = {} }) {
    const { error } = await this.db.from('agent_events').insert({
      session_id: sessionId, type, level, message: String(message).slice(0, 2000), payload,
    });
    if (error) console.warn('[agent-state] event not recorded:', error.message);
  }

  async listEvents(sessionId, { afterId = 0, limit = 200 } = {}) {
    const { data, error } = await this.db.from('agent_events').select('id,type,level,message,payload,created_at')
      .eq('session_id', sessionId).gt('id', afterId).order('id', { ascending: true }).limit(limit);
    if (error) throw storeError('agent_events', error);
    return data || [];
  }

  async requestApproval(session, approval) {
    const { data, error } = await this.db.rpc('request_agent_approval', {
      p_session: session.id, p_token: session.leaseToken, p_call_id: approval.callId, p_broker: approval.broker,
      p_tool: approval.tool, p_action: approval.action, p_risk: approval.risk, p_summary: approval.summary,
      p_arguments_sha256: approval.argumentsSha256, p_arguments_preview: approval.preview || {},
    });
    if (error) throw storeError('request_agent_approval', error);
    return data;
  }

  async findApproval(sessionId, callId) {
    const { data, error } = await this.db.from('agent_approvals').select('*')
      .eq('session_id', sessionId).eq('call_id', callId).maybeSingle();
    if (error) throw storeError('agent_approvals', error);
    return data ? { id: data.id, status: data.status, note: data.note, argumentsSha256: data.arguments_sha256 } : null;
  }

  async consumeApproval({ approvalId, sessionId, callId, tool, argumentsSha256 }) {
    const { data, error } = await this.db.rpc('consume_agent_approval', {
      p_approval: approvalId, p_session: sessionId, p_call_id: callId, p_tool: tool, p_arguments_sha256: argumentsSha256,
    });
    if (error) throw storeError('consume_agent_approval', error);
    return data === true;
  }

  // Protected paths the owner approved for this session (path-scoped grants).
  // Only an owner decision on a repo.protected_change approval produces one.
  async listProtectedGrants(sessionId) {
    const { data, error } = await this.db.from('agent_approvals').select('arguments_preview,status')
      .eq('session_id', sessionId).eq('tool_name', PROTECTED_CHANGE_TOOL).in('status', ['approved', 'consumed']);
    if (error) throw storeError('agent_approvals', error);
    return grantedPaths(data || []);
  }

  // The owner's replies, taken exactly once by the lease holder.
  async consumeOwnerInputs(session) {
    const { data, error } = await this.db.rpc('consume_agent_owner_inputs', { p_session: session.id, p_token: session.leaseToken });
    if (error) throw storeError('consume_agent_owner_inputs', error);
    return (data || []).map((row) => ({ id: row.id, message: row.message, createdAt: row.created_at }));
  }
}

export class MemoryAgentSessionStore {
  constructor({ persistPath = null, now = () => Date.now() } = {}) {
    this.persistPath = persistPath;
    this.now = now;
    this.data = { sessions: {}, checkpoints: {}, events: {}, approvals: {}, eventSeq: 0 };
    if (persistPath && existsSync(persistPath)) this.data = JSON.parse(readFileSync(persistPath, 'utf8'));
  }

  persist() {
    if (!this.persistPath) return;
    const temporary = `${this.persistPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data));
    renameSync(temporary, this.persistPath);
  }

  reload() {
    if (this.persistPath && existsSync(this.persistPath)) this.data = JSON.parse(readFileSync(this.persistPath, 'utf8'));
  }

  iso() {
    return new Date(this.now()).toISOString();
  }

  async createSession({ workspaceId = randomUUID(), title, objective, repository, baseBranch = 'main', budgetUsd = 5, config = {}, createdBy = null }) {
    this.reload();
    const id = randomUUID();
    this.data.sessions[id] = {
      id, workspace_id: workspaceId, job_id: randomUUID(), task_id: randomUUID(), run_id: randomUUID(), agent_id: randomUUID(),
      kind: 'coding', title, objective, repository, base_branch: baseBranch, work_branch: null, status: 'queued', phase: 'understand',
      plan: [], state: {}, config, next_action: null, current_route: null, previous_route: null, provider_switches: 0,
      iteration: 0, budget_usd: budgetUsd, spent_usd: 0, tokens_in: 0, tokens_out: 0, result: null, blocker: null,
      error_code: null, cancel_requested: false, lease_owner: null, lease_token: null, lease_expires_at: null,
      checkpoint_seq: 0, created_by: createdBy, created_at: this.iso(), updated_at: this.iso(), started_at: null, completed_at: null,
    };
    this.data.checkpoints[id] = [];
    this.data.events[id] = [];
    this.persist();
    return fromSessionRow(this.data.sessions[id]);
  }

  async claim({ worker, leaseSeconds = 300 }) {
    this.reload();
    const now = this.now();
    const candidate = Object.values(this.data.sessions)
      .filter((row) => !row.cancel_requested && (row.status === 'queued' ||
        (row.status === 'running' && Date.parse(row.lease_expires_at) < now)))
      .sort((left, right) => left.created_at.localeCompare(right.created_at))[0];
    if (!candidate) return null;
    Object.assign(candidate, {
      status: 'running', lease_owner: worker, lease_token: randomUUID(), blocker: null,
      lease_expires_at: new Date(now + leaseSeconds * 1000).toISOString(), started_at: candidate.started_at || this.iso(), updated_at: this.iso(),
    });
    this.persist();
    return fromSessionRow(candidate);
  }

  // Memory twin of SupabaseAgentSessionStore.claimById: binds exactly this
  // id when (and only when) it is queued, refusing every other session —
  // proven against the queue-order claim() by the Phase N runner tests.
  async claimById(id, { worker, leaseSeconds = 300 } = {}) {
    if (!worker) throw storeError('claimById', new Error('worker is required'));
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 3600) throw storeError('claimById', new Error('AGENT_LEASE_INVALID'));
    this.reload();
    const row = this.data.sessions[id];
    if (!row) return { ok: false, reason: 'SESSION_NOT_FOUND' };
    if (row.cancel_requested) return { ok: false, reason: 'CANCEL_REQUESTED', session: fromSessionRow(row) };
    if (row.status !== 'queued') {
      return row.status === 'running' && row.lease_owner === worker
        ? { ok: true, alreadyOwned: true, session: fromSessionRow(row) }
        : { ok: false, reason: 'NOT_QUEUED', session: fromSessionRow(row) };
    }
    const now = this.now();
    Object.assign(row, {
      status: 'running', lease_owner: String(worker).slice(0, 200), lease_token: randomUUID(), blocker: null,
      lease_expires_at: new Date(now + leaseSeconds * 1000).toISOString(),
      started_at: row.started_at || new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
    });
    this.persist();
    return { ok: true, session: fromSessionRow(row) };
  }

  async getSession(id) {
    this.reload();
    return this.data.sessions[id] ? fromSessionRow(this.data.sessions[id]) : null;
  }

  async latestCheckpoint(sessionId) {
    this.reload();
    const checkpoint = (this.data.checkpoints[sessionId] || []).filter((entry) => entry.transcript).at(-1);
    return checkpoint ? structuredClone(checkpoint) : null;
  }

  fence(session) {
    this.reload();
    const row = this.data.sessions[session.id];
    if (!row || row.lease_token !== session.leaseToken) throw Object.assign(new Error('AGENT_LEASE_LOST'), { code: 'AGENT_LEASE_LOST' });
    return row;
  }

  async renewLease(session) {
    this.reload();
    const row = this.data.sessions[session.id];
    if (!row || row.lease_token !== session.leaseToken || row.status !== 'running') return { ok: false, cancelRequested: false };
    row.lease_expires_at = new Date(this.now() + 300_000).toISOString();
    this.persist();
    return { ok: true, cancelRequested: row.cancel_requested };
  }

  async saveCheckpoint(session, { reason, patch = {}, transcript = null, gitHead = null }) {
    const row = this.fence(session);
    if (row.status !== 'running') throw Object.assign(new Error('AGENT_LEASE_LOST'), { code: 'AGENT_LEASE_LOST' });
    for (const [key, value] of Object.entries(patch)) if (value !== undefined) row[key] = value;
    row.checkpoint_seq += 1;
    row.updated_at = this.iso();
    const list = this.data.checkpoints[session.id];
    list.push({ sequence: row.checkpoint_seq, reason, route: row.current_route, phase: row.phase, plan: row.plan, state: row.state,
      transcript, gitHead, created_at: this.iso() });
    for (const entry of list.slice(0, -5)) entry.transcript = null;
    this.persist();
    return row.checkpoint_seq;
  }

  async finish(session, { status, result = null, blocker = null, errorCode = null }) {
    const row = this.fence(session);
    Object.assign(row, {
      status, result: result ?? row.result, blocker, error_code: errorCode, lease_owner: null, lease_token: null,
      lease_expires_at: null, completed_at: TERMINAL_STATUSES.includes(status) ? this.iso() : null, updated_at: this.iso(),
    });
    this.persist();
  }

  async appendEvent(sessionId, { type, level = 'info', message, payload = {} }) {
    if (!AGENT_EVENT_TYPES.includes(type) || !AGENT_EVENT_LEVELS.includes(level)) {
      throw new Error(`agent_events rejects type=${type} level=${level}`);
    }
    this.reload();
    this.data.eventSeq += 1;
    (this.data.events[sessionId] ||= []).push({ id: this.data.eventSeq, type, level, message: String(message).slice(0, 2000), payload, created_at: this.iso() });
    this.persist();
  }

  async listEvents(sessionId, { afterId = 0 } = {}) {
    this.reload();
    return (this.data.events[sessionId] || []).filter((event) => event.id > afterId);
  }

  async requestApproval(session, approval) {
    this.fence(session);
    const key = `${session.id}:${approval.callId}`;
    this.data.approvals[key] ||= { id: randomUUID(), session_id: session.id, call_id: approval.callId, tool: approval.tool,
      status: 'pending', arguments_sha256: approval.argumentsSha256, summary: approval.summary, arguments_preview: approval.preview || {},
      requested_at: this.iso() };
    this.persist();
    return this.data.approvals[key].id;
  }

  async findApproval(sessionId, callId) {
    this.reload();
    const row = this.data.approvals[`${sessionId}:${callId}`];
    return row ? { id: row.id, status: row.status, note: row.note || null, argumentsSha256: row.arguments_sha256 } : null;
  }

  // Test/local equivalent of decide_agent_approval.
  async decideApproval(approvalId, decision, note = null) {
    this.reload();
    const row = Object.values(this.data.approvals).find((entry) => entry.id === approvalId && entry.status === 'pending');
    if (!row) throw new Error('AGENT_APPROVAL_NOT_PENDING');
    Object.assign(row, { status: decision, note, decided_at: this.iso() });
    const pending = Object.values(this.data.approvals).some((entry) => entry.session_id === row.session_id && entry.status === 'pending');
    const session = this.data.sessions[row.session_id];
    if (!pending && session.status === 'awaiting_approval') Object.assign(session, { status: 'queued', blocker: null });
    this.persist();
  }

  async consumeApproval({ approvalId, sessionId, callId, tool, argumentsSha256 }) {
    this.reload();
    const row = this.data.approvals[`${sessionId}:${callId}`];
    if (!row || row.id !== approvalId || row.status !== 'approved' || row.tool !== tool || row.arguments_sha256 !== argumentsSha256) return false;
    row.status = 'consumed';
    this.persist();
    return true;
  }

  async listProtectedGrants(sessionId) {
    this.reload();
    return grantedPaths(Object.values(this.data.approvals)
      .filter((row) => row.session_id === sessionId && row.tool === PROTECTED_CHANGE_TOOL && ['approved', 'consumed'].includes(row.status)));
  }

  // Test/local equivalent of reply_agent_session.
  async replyToSession(sessionId, message, createdBy = null) {
    this.reload();
    const row = this.data.sessions[sessionId];
    const text = String(message || '').trim();
    if (!text || text.length > 8000) throw new Error('AGENT_REPLY_INVALID');
    if (!row) throw new Error('AGENT_SESSION_NOT_FOUND');
    if (TERMINAL_STATUSES.includes(row.status) || row.cancel_requested) throw new Error('AGENT_SESSION_CLOSED');
    this.data.ownerInputs ||= {};
    const input = { id: randomUUID(), session_id: sessionId, message: text, created_by: createdBy, created_at: this.iso(), consumed_at: null };
    (this.data.ownerInputs[sessionId] ||= []).push(input);
    this.data.eventSeq += 1;
    this.data.events[sessionId].push({ id: this.data.eventSeq, session_id: sessionId, type: 'owner', level: 'info',
      message: `Fahad replied: ${text}`.slice(0, 2000), payload: { input_id: input.id }, created_at: this.iso() });
    if (row.status === 'blocked') Object.assign(row, { status: 'queued', blocker: null, error_code: null });
    this.persist();
    return input;
  }

  async consumeOwnerInputs(session) {
    this.fence(session);
    const pending = (this.data.ownerInputs?.[session.id] || []).filter((input) => !input.consumed_at);
    for (const input of pending) input.consumed_at = this.iso();
    this.persist();
    return pending.map((input) => ({ id: input.id, message: input.message, createdAt: input.created_at }));
  }

  async requestCancel(sessionId) {
    this.reload();
    const row = this.data.sessions[sessionId];
    row.cancel_requested = true;
    if (['queued', 'awaiting_approval', 'blocked'].includes(row.status)) row.status = 'cancelled';
    this.persist();
  }

  async resume(sessionId) {
    this.reload();
    const row = this.data.sessions[sessionId];
    if (row.status === 'blocked' && !row.cancel_requested) Object.assign(row, { status: 'queued', blocker: null, error_code: null });
    this.persist();
  }

  expireLease(sessionId) {
    this.reload();
    this.data.sessions[sessionId].lease_expires_at = new Date(this.now() - 1000).toISOString();
    this.persist();
  }
}

export const PROTECTED_CHANGE_TOOL = 'repo.protected_change';

function grantedPaths(rows) {
  const paths = new Set();
  for (const row of rows) {
    for (const path of Array.isArray(row.arguments_preview?.paths) ? row.arguments_preview.paths : []) {
      if (typeof path === 'string' && path.length <= 500) paths.add(path);
    }
  }
  return [...paths].sort();
}

export function fromSessionRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    jobId: row.job_id,
    taskId: row.task_id,
    runId: row.run_id,
    agentId: row.agent_id,
    title: row.title,
    objective: row.objective,
    repository: row.repository,
    baseBranch: row.base_branch,
    workBranch: row.work_branch,
    status: row.status,
    phase: row.phase,
    plan: row.plan || [],
    state: row.state || {},
    config: row.config || {},
    nextAction: row.next_action,
    currentRoute: row.current_route,
    previousRoute: row.previous_route,
    providerSwitches: Number(row.provider_switches || 0),
    iteration: Number(row.iteration || 0),
    budgetUsd: Number(row.budget_usd || 0),
    spentUsd: Number(row.spent_usd || 0),
    tokensIn: Number(row.tokens_in || 0),
    tokensOut: Number(row.tokens_out || 0),
    result: row.result,
    blocker: row.blocker,
    errorCode: row.error_code || null,
    cancelRequested: Boolean(row.cancel_requested),
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    startedAt: row.started_at,
    createdAt: row.created_at,
  };
}

function storeError(operation, error) {
  const failure = new Error(`${operation} failed: ${error.message}`);
  failure.code = /AGENT_LEASE_LOST/.test(error.message || '') ? 'AGENT_LEASE_LOST' : 'AGENT_STATE_ERROR';
  return failure;
}
