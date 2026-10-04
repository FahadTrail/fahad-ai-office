import { ContinuityStore } from './continuity/store.js';
import { sanitizeContinuityValue } from './continuity/safe.js';

const ACTIONS = new Set(['START_SESSION', 'PAUSE_SESSION', 'RESUME_SESSION', 'FORCE_CHECKPOINT', 'REQUEST_HANDOFF', 'COMPLETE_SESSION', 'DISABLE_WORKER', 'ENABLE_WORKER']);

function publicState(state) {
  const checkpointsBySession = new Map(state.checkpoints.map((checkpoint) => [checkpoint.session_id, checkpoint]));
  const usageByWorker = new Map();
  for (const snapshot of state.usage) if (!usageByWorker.has(snapshot.worker_key)) usageByWorker.set(snapshot.worker_key, snapshot);
  const workerMetrics = (workerKey) => {
    const sessions = state.sessions.filter((session) => session.worker_key === workerKey);
    const completed = sessions.filter((session) => session.status === 'COMPLETED').length;
    const failed = sessions.filter((session) => ['FAILED', 'ABNORMAL_EXIT'].includes(session.status)).length;
    const finished = sessions.filter((session) => session.ended_at && session.started_at);
    const durations = finished.map((session) => new Date(session.ended_at).getTime() - new Date(session.started_at).getTime()).filter((value) => Number.isFinite(value) && value >= 0);
    const tokens = sessions.filter((session) => Number.isFinite(Number(session.task_tokens)));
    const tokenBases = new Set(tokens.map((session) => session.tokens_basis || 'UNKNOWN'));
    const latestCheckpoint = sessions.map((session) => checkpointsBySession.get(session.id)).filter(Boolean)
      .sort((left, right) => String(right.created_at || '').localeCompare(String(left.created_at || '')))[0] || null;
    return {
      completed, failed, handoffs: state.handoffs.filter((handoff) => handoff.from_worker === workerKey || handoff.to_worker === workerKey).length,
      countsBasis: 'MEASURED',
      lifetimeTokens: tokens.length ? tokens.reduce((sum, session) => sum + Number(session.task_tokens), 0) : null,
      tokensBasis: tokenBases.size === 1 ? [...tokenBases][0] : tokens.length ? 'UNKNOWN' : 'UNKNOWN',
      averageLatencyMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
      latencyBasis: durations.length ? 'MEASURED' : 'UNKNOWN',
      successRatePct: completed + failed ? Math.round((completed / (completed + failed)) * 1000) / 10 : null,
      successBasis: completed + failed ? 'MEASURED' : 'UNKNOWN',
      lastCommit: latestCheckpoint?.last_commit || null,
      latestUsage: usageByWorker.get(workerKey) || null,
    };
  };
  return sanitizeContinuityValue({
    workers: state.workers.map(({ key, display_name, kind, quota_source, enabled, capabilities, health, health_basis, last_seen_at, last_error }) => ({ key, displayName: display_name, kind, quotaSource: quota_source, enabled, capabilities, health, healthBasis: health_basis, lastSeenAt: last_seen_at, lastError: last_error, metrics: workerMetrics(key) })),
    sessions: state.sessions.map(({ id, worker_key, project_id, repository, branch, worktree, objective, status, started_at, heartbeat_at, ended_at, task_tokens, tokens_basis, exit_reason }) => ({ id, workerKey: worker_key, projectId: project_id, repository, branch, worktree, objective, status, startedAt: started_at, heartbeatAt: heartbeat_at, endedAt: ended_at, taskTokens: task_tokens, tokensBasis: tokens_basis, exitReason: exit_reason })),
    leases: state.leases.map(({ id, repository, branch, worktree, worker_key, session_id, status, started_at, heartbeat_at, expires_at, checkpoint_id }) => ({ id, repository, branch, worktree, workerKey: worker_key, sessionId: session_id, status, startedAt: started_at, heartbeatAt: heartbeat_at, expiresAt: expires_at, checkpointId: checkpoint_id })),
    checkpoints: state.checkpoints.map(({ id, session_id, sequence, last_commit, status, next_exact_action, created_at }) => ({ id, sessionId: session_id, sequence, lastCommit: last_commit, status, nextExactAction: next_exact_action, createdAt: created_at })),
    handoffs: state.handoffs.map(({ id, from_session_id, to_session_id, from_worker, to_worker, checkpoint_id, reason, status, created_at, accepted_at }) => ({ id, fromSessionId: from_session_id, toSessionId: to_session_id, fromWorker: from_worker, toWorker: to_worker, checkpointId: checkpoint_id, reason, status, createdAt: created_at, acceptedAt: accepted_at })),
    usage: state.usage.map(({ id, worker_key, quota_source, session_id, taken_at, session_pct, weekly_pct, task_tokens, reset_at, basis }) => ({ id, workerKey: worker_key, quotaSource: quota_source, sessionId: session_id, takenAt: taken_at, sessionPct: session_pct, weeklyPct: weekly_pct, taskTokens: task_tokens, resetAt: reset_at, basis })),
  });
}

export async function handleContinuityApi({ db, supervisor = null, request, response, url, sendJson, readJson }) {
  if (!url.pathname.startsWith('/api/continuity')) return false;
  if (request.method === 'GET' && url.pathname === '/api/continuity') {
    const store = supervisor?.store || new ContinuityStore(db);
    const state = publicState(await store.readState({ projectId: url.searchParams.get('projectId') || null }));
    return sendJson(response, 200, { ok: true, enabled: Boolean(supervisor?.started), ...state }), true;
  }
  if (request.method === 'POST' && url.pathname === '/api/continuity/actions') {
    if (!supervisor?.started) return sendJson(response, 503, { ok: false, error: 'CONTINUITY_SUPERVISOR_DISABLED' }), true;
    const body = await readJson(request);
    const action = String(body.action || '').toUpperCase();
    if (!ACTIONS.has(action)) return sendJson(response, 400, { ok: false, error: 'CONTINUITY_ACTION_INVALID' }), true;
    let result;
    if (action === 'START_SESSION') result = await supervisor.startTask({ task: body.task, checkpoint: body.checkpoint });
    else if (action === 'COMPLETE_SESSION') result = await supervisor.finish(body.sessionId, { checkpoint: body.checkpoint, gateContext: body.gateContext || {} });
    else result = await supervisor.requestAction(action, body);
    return sendJson(response, 200, { ok: true, action, result }), true;
  }
  return sendJson(response, 404, { ok: false, error: 'CONTINUITY_NOT_FOUND' }), true;
}

export { publicState as continuityPublicState };
