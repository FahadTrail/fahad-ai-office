import { ContinuityStore } from './continuity/store.js';
import { sanitizeContinuityValue } from './continuity/safe.js';
import { CodexContinuityAdapter } from './continuity/adapters/codex.js';
import { ClaudeCodeContinuityAdapter } from './continuity/adapters/claude-code.js';
import { OpenCodeContinuityAdapter } from './continuity/adapters/opencode.js';
import { GeminiCliContinuityAdapter } from './continuity/adapters/gemini-cli.js';
import { workerLiveStatus } from './coding-agent/presence.js';

const ACTIONS = new Set(['START_SESSION', 'PAUSE_SESSION', 'RESUME_SESSION', 'FORCE_CHECKPOINT', 'REQUEST_HANDOFF', 'COMPLETE_SESSION', 'ABORT_SESSION', 'DISABLE_WORKER', 'ENABLE_WORKER']);
const PREPARED_ADAPTERS = new Map([
  ['codex', new CodexContinuityAdapter()],
  ['claude-code', new ClaudeCodeContinuityAdapter()],
  ['opencode', new OpenCodeContinuityAdapter()],
  ['gemini-cli', new GeminiCliContinuityAdapter()],
]);

// What a worker really is, for the owner (2026-10-09 audit: seven disabled or
// unconfigured adapters were listed next to the one real worker as if they
// were employees). Each worker gets one class and plain answers:
//   ACTIVE                  enabled, executable and verified — Office can hand it work
//   CONFIGURED_UNAVAILABLE  enabled, but not verified/authenticated or the Supervisor is off
//   DISABLED                an adapter exists but is switched off
//   MANUAL_ONLY             a tool Fahad uses by hand; never handed work automatically
//   EXPERIMENTAL            no executable adapter in this build (future)
// `quota` is only claimed when the worker reported a usage snapshot.
export function workerTruth(worker, { supervisorOn = false, activity = null, now = Date.now() } = {}) {
  // The native Office Coding Agent runs as its own service and takes the
  // Office's development workstreams directly; it does not need Continuity.
  const native = worker.kind === 'native';
  const executable = native || worker.executionMode === 'EXECUTABLE';
  const authenticated = worker.authState === 'AUTHENTICATED' || worker.availability === 'OPERATIONAL';
  const verified = native || worker.availability === 'OPERATIONAL';
  const workerClass = worker.executionMode === 'MANUAL_ONLY' || worker.kind === 'manual' ? 'MANUAL_ONLY'
    : !executable ? 'EXPERIMENTAL'
      : !worker.enabled ? 'DISABLED'
        : verified && (native || supervisorOn) ? 'ACTIVE' : 'CONFIGURED_UNAVAILABLE';
  const usage = worker.metrics?.latestUsage || null;
  // Measured live status (the native worker reports presence; others only when they do).
  const live = workerLiveStatus({ enabled: worker.enabled, lastSeenAt: worker.lastSeenAt || null, running: activity?.running || 0, blocked: activity?.blocked || 0, now });
  return {
    class: workerClass, status: live.status, statusDetail: live.detail,
    canExecuteNow: workerClass === 'ACTIVE',
    authenticated: native ? 'not needed (runs on the Office model pool)' : authenticated ? 'yes' : 'no',
    enabled: Boolean(worker.enabled),
    realQuota: usage ? `reported ${usage.takenAt ? String(usage.takenAt).slice(0, 10) : ''}`.trim() : native ? 'Office model pool' : 'unknown — never reported',
    automaticHandoff: workerClass !== 'ACTIVE' ? 'no' : native ? 'yes — Office development workstreams' : 'yes — Continuity handoffs',
    why: workerClass === 'ACTIVE' ? null
      : workerClass === 'MANUAL_ONLY' ? 'Used by hand only.'
        : workerClass === 'EXPERIMENTAL' ? 'No executable adapter in this build.'
          : workerClass === 'DISABLED' ? 'Switched off.'
            : !supervisorOn && !native ? 'Continuity Supervisor is off.'
              : !authenticated ? 'Not authenticated on the server.' : 'Not verified yet.',
  };
}

function publicState(state, { readiness = new Map(), adapters = new Map(), supervisorOn = false, nativeActivity = null } = {}) {
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
    workers: state.workers.map(({ key, display_name, kind, quota_source, enabled, capabilities, health, health_basis, last_seen_at, last_error }) => {
      const adapter = adapters.get(key);
      const actual = adapter?.capabilities() || capabilities || {};
      const ready = readiness.get(key) || {};
      return { key, displayName: display_name, kind, quotaSource: actual.quotaSource || quota_source, enabled,
        capabilities: actual, executionMode: actual.executionMode || 'DISABLED', authState: ready.authState || 'NOT_CONFIGURED',
        availability: ready.ok === true ? 'OPERATIONAL' : ready.reason || 'NOT_CONFIGURED',
        ownerAction: ready.ok ? null : actual.ownerAction || ready.reason || 'Configure and verify this worker.',
        health, healthBasis: health_basis, lastSeenAt: last_seen_at, lastError: last_error, metrics: workerMetrics(key) };
    }).map((worker) => ({ ...worker, truth: workerTruth(worker, { supervisorOn, activity: worker.kind === 'native' ? nativeActivity : null }) })),
    sessions: state.sessions.map(({ id, worker_key, project_id, repository, branch, worktree, objective, status, started_at, heartbeat_at, ended_at, task_tokens, tokens_basis, exit_reason }) => ({ id, workerKey: worker_key, projectId: project_id, repository, branch, worktree, objective, status, startedAt: started_at, heartbeatAt: heartbeat_at, endedAt: ended_at, taskTokens: task_tokens, tokensBasis: tokens_basis, exitReason: exit_reason })),
    leases: state.leases.map(({ id, repository, branch, worktree, worker_key, session_id, status, started_at, heartbeat_at, expires_at, checkpoint_id }) => ({ id, repository, branch, worktree, workerKey: worker_key, sessionId: session_id, status, startedAt: started_at, heartbeatAt: heartbeat_at, expiresAt: expires_at, checkpointId: checkpoint_id })),
    checkpoints: state.checkpoints.map(({ id, session_id, sequence, last_commit, status, next_exact_action, created_at }) => ({ id, sessionId: session_id, sequence, lastCommit: last_commit, status, nextExactAction: next_exact_action, createdAt: created_at })),
    handoffs: state.handoffs.map(({ id, from_session_id, to_session_id, from_worker, to_worker, checkpoint_id, reason, status, created_at, accepted_at }) => ({ id, fromSessionId: from_session_id, toSessionId: to_session_id, fromWorker: from_worker, toWorker: to_worker, checkpointId: checkpoint_id, reason, status, createdAt: created_at, acceptedAt: accepted_at })),
    usage: state.usage.map(({ id, worker_key, quota_source, session_id, taken_at, session_pct, weekly_pct, task_tokens, reset_at, basis }) => ({ id, workerKey: worker_key, quotaSource: quota_source, sessionId: session_id, takenAt: taken_at, sessionPct: session_pct, weeklyPct: weekly_pct, taskTokens: task_tokens, resetAt: reset_at, basis })),
  });
}

export async function handleContinuityApi({ db, supervisor = null, ownerAuthorized = false, request, response, url, sendJson, readJson }) {
  if (!url.pathname.startsWith('/api/continuity')) return false;
  if (request.method === 'GET' && url.pathname === '/api/continuity') {
    const store = supervisor?.store || new ContinuityStore(db);
    const snapshot = await store.readState({ projectId: url.searchParams.get('projectId') || null });
    const adapters = supervisor?.adapters || PREPARED_ADAPTERS;
    const readiness = new Map(await Promise.all(snapshot.workers.map(async (worker) => {
      const adapter = adapters.get(worker.key);
      if (!adapter) return [worker.key, { ok: false, authState: 'NOT_CONFIGURED', reason: 'SUPERVISOR_OFF' }];
      try { return [worker.key, await (adapter.authReadiness?.() || adapter.available())]; }
      catch { return [worker.key, { ok: false, authState: 'OWNER_ACTION_REQUIRED', reason: 'READINESS_UNAVAILABLE' }]; }
    })));
    // The native worker's live status counts its real Coding Agent sessions.
    const nativeActivity = await (async () => {
      try {
        const { data, error } = await db.from('agent_sessions').select('status').in('status', ['running', 'blocked', 'awaiting_approval']);
        if (error) return null;
        return { running: (data || []).filter((row) => row.status === 'running').length, blocked: (data || []).filter((row) => row.status !== 'running').length };
      } catch { return null; }
    })();
    const state = publicState(snapshot, { readiness, adapters, supervisorOn: Boolean(supervisor?.started), nativeActivity });
    return sendJson(response, 200, { ok: true, enabled: Boolean(supervisor?.started), ...state }), true;
  }
  if (request.method === 'POST' && url.pathname === '/api/continuity/actions') {
    if (!supervisor?.started) return sendJson(response, 503, { ok: false, error: 'CONTINUITY_SUPERVISOR_DISABLED' }), true;
    if (!ownerAuthorized) return sendJson(response, 403, { ok: false, error: 'CONTINUITY_OWNER_AUTH_REQUIRED' }), true;
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
