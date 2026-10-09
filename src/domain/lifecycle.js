// Derived lifecycle for objectives, tasks and Coding Agent sessions.
//
// Rows are never rewritten. Terminal work stays terminal. A capacity wait is
// not an owner approval. A completed job is never promoted to current work.
// An employee assignment on a finished objective is not active.

export const LIFECYCLE = Object.freeze(['ACTIVE', 'WAITING', 'NEEDS_OWNER', 'COMPLETED', 'FAILED', 'CANCELLED']);
export const TERMINAL_LIFECYCLE = Object.freeze(['COMPLETED', 'FAILED', 'CANCELLED']);
export const OPEN_JOB_STATUSES = Object.freeze(['planning', 'running', 'waiting_approval', 'blocked', 'review']);
export const TERMINAL_JOB_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);
export const OPEN_SESSION_STATUSES = Object.freeze(['queued', 'running', 'awaiting_approval', 'blocked']);
export const TERMINAL_SESSION_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);

const JOB_TERMINAL = Object.freeze({ completed: 'COMPLETED', failed: 'FAILED', cancelled: 'CANCELLED' });
const TASK_TERMINAL = Object.freeze({ done: 'COMPLETED', skipped: 'COMPLETED', failed: 'FAILED' });
const SESSION_TERMINAL = Object.freeze({ completed: 'COMPLETED', failed: 'FAILED', cancelled: 'CANCELLED' });

const CAPACITY_REASONS = new Set([
  'NO_FREE_CAPACITY', 'WAITING_FOR_CAPACITY', 'NO_ELIGIBLE_PROVIDER', 'ALL_PROVIDERS_UNAVAILABLE',
  'COOLDOWN_RATE_LIMITED', 'COOLDOWN_QUOTA_EXHAUSTED', 'COOLDOWN_UNAVAILABLE', 'COOLDOWN_DEGRADED',
  'COOLDOWN_POOL_RATE_LIMITED', 'COOLDOWN_POOL_QUOTA_EXHAUSTED', 'RATE_LIMITED', 'QUOTA_EXHAUSTED',
  'FAILED_THIS_TURN',
]);

const EXECUTING_TASK = new Set(['running', 'handoff', 'review']);
const SCHEDULED_TASK = new Set(['queued', 'assigned']);

export function isTerminalCategory(category) {
  return TERMINAL_LIFECYCLE.includes(category);
}

export function isCapacityReason(value) {
  const text = String(value || '');
  if (!text) return false;
  if (CAPACITY_REASONS.has(text)) return true;
  return /NO_FREE_CAPACITY|WAITING_FOR_CAPACITY|free model capacity/i.test(text);
}

export function briefOf(task) {
  if (!task) return {};
  if (task.brief && typeof task.brief === 'object') return task.brief;
  try { return JSON.parse(task.brief || '{}') || {}; } catch { return {}; }
}

const time = (value) => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
};

export function capacityWait(row, now = Date.now()) {
  if (!row) return null;
  const reason = row.wait_info?.reason || row.error_code || null;
  const resumesAt = row.not_before || row.wait_info?.expected_at || null;
  const until = time(row.not_before);
  if (until != null && until > now) {
    return { reason: 'capacity', code: reason || 'NO_FREE_CAPACITY', detail: row.wait_info?.detail || row.wait_info?.message || null, resumesAt: row.not_before };
  }
  if (isCapacityReason(reason) || isCapacityReason(row.wait_info?.detail) || isCapacityReason(row.wait_info?.message) || isCapacityReason(row.blocker)) {
    return { reason: 'capacity', code: reason || 'NO_FREE_CAPACITY', detail: row.wait_info?.detail || row.blocker || row.wait_info?.message || null, resumesAt };
  }
  return null;
}

function failureText(job, tasks = [], sessions = []) {
  const failedTask = tasks.find((task) => task.status === 'failed');
  const failedSession = sessions.find((session) => session.status === 'failed');
  const text = failedSession?.blocker || failedTask?.wait_info?.detail || failedTask?.error_message || null;
  if (text) return { text: String(text).slice(0, 500), basis: 'RECORDED' };
  if (job?.final_summary) return { text: String(job.final_summary).slice(0, 500), basis: 'RECORDED' };
  return { text: null, basis: 'UNKNOWN' };
}

function ownerItemFromApproval(approval) {
  return {
    kind: 'approval',
    id: approval.id,
    taskId: approval.task_id || null,
    sessionId: approval.session_id || null,
    title: approval.title || approval.summary || 'Approval required',
    at: approval.created_at || approval.requested_at || null,
  };
}

// Real owner actions. Capacity waits are excluded even when a session is blocked.
export function ownerSignals({ job = null, tasks = [], approvals = [], sessions = [] } = {}) {
  const items = [];
  for (const approval of approvals) {
    if (approval.status === 'pending') items.push(ownerItemFromApproval(approval));
  }
  for (const task of tasks) {
    if (task.status !== 'waiting_approval') continue;
    if (items.some((item) => item.taskId === task.id)) continue;
    items.push({ kind: 'approval', id: null, taskId: task.id, sessionId: null, title: task.title || 'Approval required', at: task.created_at || null });
  }
  for (const session of sessions) {
    if (capacityWait(session)) continue;
    if (session.status === 'awaiting_approval') {
      if (!items.some((item) => item.sessionId === session.id)) {
        items.push({ kind: 'approval', id: null, taskId: session.task_id || null, sessionId: session.id, title: session.title || 'Approval required', at: session.updated_at || null });
      }
    } else if (session.status === 'blocked' && !isCapacityReason(session.error_code)) {
      const question = session.error_code === 'HUMAN_INPUT_REQUIRED';
      items.push({
        kind: question ? 'question' : 'blocked',
        id: null,
        taskId: session.task_id || null,
        sessionId: session.id,
        title: question ? (session.blocker || 'A question needs an answer') : (session.blocker || 'Paused until you continue'),
        code: session.error_code || null,
        at: session.updated_at || null,
      });
    }
  }
  if (job?.status === 'waiting_approval' && !items.length) {
    items.push({ kind: 'approval', id: null, taskId: null, sessionId: null, title: job.title || 'Approval required', at: job.created_at || null });
  }
  const blocking = items.some((item) => item.kind === 'approval' || item.kind === 'question' || item.kind === 'blocked');
  return { items, blocking, pending: items.length > 0, reason: items[0]?.title || null };
}

export function waitSignals({ tasks = [], sessions = [], now = Date.now() } = {}) {
  const items = [];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    if (TASK_TERMINAL[task.status] || task.status === 'failed') continue;
    const capacity = capacityWait(task, now);
    if (capacity && !EXECUTING_TASK.has(task.status)) {
      items.push({ taskId: task.id, reason: 'capacity', code: capacity.code, detail: capacity.detail, resumesAt: capacity.resumesAt });
      continue;
    }
    if (!SCHEDULED_TASK.has(task.status)) continue;
    const open = (task.depends_on || []).filter((id) => {
      const dep = byId.get(id);
      return dep && !TASK_TERMINAL[dep.status];
    });
    if (open.length) items.push({ taskId: task.id, reason: 'dependency', dependsOn: open });
  }
  for (const session of sessions) {
    const capacity = capacityWait(session, now);
    if (capacity && session.status !== 'running') items.push({ sessionId: session.id, reason: 'capacity', code: capacity.code, detail: capacity.detail, resumesAt: capacity.resumesAt });
    else if (session.status === 'queued') items.push({ sessionId: session.id, reason: 'queue' });
  }
  const blocking = items.length > 0;
  const reason = items.some((item) => item.reason === 'capacity') ? 'capacity' : items.some((item) => item.reason === 'dependency') ? 'dependency' : items[0]?.reason || null;
  return { items, blocking, reason };
}

function taskMap(tasks) {
  return tasks instanceof Map ? tasks : new Map((tasks || []).map((task) => [task.id, task]));
}

// One task's posture. `current` is false on a terminal objective, so a finished
// objective cannot leave the employee looking busy.
export function taskExecution(task, { job = null, tasks = [], now = Date.now() } = {}) {
  const byId = taskMap(tasks);
  const jobTerminal = job ? JOB_TERMINAL[job.status] || null : null;
  const ownTerminal = TASK_TERMINAL[task.status] || null;
  if (jobTerminal || ownTerminal) {
    const category = ownTerminal || jobTerminal;
    return {
      posture: ownTerminal === 'COMPLETED' ? 'completed' : ownTerminal === 'FAILED' ? 'failed' : jobTerminal ? 'closed' : 'completed',
      category,
      current: false,
      historical: true,
      reason: category === 'FAILED' ? (task.wait_info?.detail || null) : null,
      reasonBasis: category === 'FAILED' ? (task.wait_info?.detail ? 'RECORDED' : 'UNKNOWN') : null,
      wait: null,
    };
  }
  const capacity = capacityWait(task, now);
  if (task.status === 'waiting_approval') {
    return { posture: 'needs_owner', category: 'NEEDS_OWNER', current: true, historical: false, reason: 'approval', reasonBasis: 'RECORDED', wait: null };
  }
  if (task.status === 'blocked') {
    if (capacity) return { posture: 'waiting', category: 'WAITING', current: true, historical: false, reason: 'capacity', reasonBasis: 'RECORDED', wait: capacity };
    return { posture: 'waiting', category: 'WAITING', current: true, historical: false, reason: 'blocked', reasonBasis: 'RECORDED', wait: null };
  }
  if (EXECUTING_TASK.has(task.status)) {
    return { posture: 'executing', category: 'ACTIVE', current: true, historical: false, reason: null, reasonBasis: null, wait: null };
  }
  if (capacity) {
    return { posture: 'waiting', category: 'WAITING', current: true, historical: false, reason: 'capacity', reasonBasis: 'RECORDED', wait: capacity };
  }
  const open = (task.depends_on || []).filter((id) => byId.has(id) && !TASK_TERMINAL[byId.get(id).status]);
  if (open.length) {
    return { posture: 'waiting', category: 'WAITING', current: true, historical: false, reason: 'dependency', reasonBasis: 'RECORDED', wait: { reason: 'dependency', dependsOn: open } };
  }
  if (task.status === 'assigned') {
    return { posture: 'assigned', category: 'ACTIVE', current: true, historical: false, reason: null, reasonBasis: null, wait: null };
  }
  return { posture: 'queued', category: 'ACTIVE', current: true, historical: false, reason: null, reasonBasis: null, wait: null };
}

export function sessionLifecycle(session, { approvals = [], now = Date.now() } = {}) {
  if (!session) return null;
  const terminal = SESSION_TERMINAL[session.status] || null;
  const pending = approvals.filter((approval) => approval.status === 'pending' && (!approval.session_id || approval.session_id === session.id));
  if (terminal) {
    const failure = terminal === 'FAILED' ? (session.blocker || session.error_code || null) : null;
    return {
      category: terminal,
      history: true,
      current: false,
      working: false,
      ownerAttention: pending.map(ownerItemFromApproval),
      reason: failure ? String(failure).slice(0, 500) : null,
      reasonBasis: terminal === 'FAILED' ? (failure ? 'RECORDED' : 'UNKNOWN') : null,
    };
  }
  const capacity = capacityWait(session, now);
  if (pending.length || session.status === 'awaiting_approval') {
    return { category: 'NEEDS_OWNER', history: false, current: true, working: false, ownerAttention: pending.length ? pending.map(ownerItemFromApproval) : [{ kind: 'approval', id: null, sessionId: session.id, title: session.title || 'Approval required' }], reason: 'approval', reasonBasis: 'RECORDED' };
  }
  if (session.status === 'blocked' && !capacity && !isCapacityReason(session.error_code)) {
    const question = session.error_code === 'HUMAN_INPUT_REQUIRED';
    return { category: 'NEEDS_OWNER', history: false, current: true, working: false, ownerAttention: [{ kind: question ? 'question' : 'blocked', sessionId: session.id, title: session.blocker || session.title, code: session.error_code || null }], reason: question ? 'question' : 'blocked', reasonBasis: 'RECORDED' };
  }
  if (capacity || session.status === 'queued') {
    return { category: 'WAITING', history: false, current: true, working: false, ownerAttention: [], reason: capacity ? 'capacity' : 'queue', reasonBasis: 'RECORDED', wait: capacity };
  }
  if (session.status === 'running') {
    return { category: 'ACTIVE', history: false, current: true, working: true, ownerAttention: [], reason: null, reasonBasis: null };
  }
  return { category: 'WAITING', history: false, current: true, working: false, ownerAttention: [], reason: 'UNKNOWN', reasonBasis: 'UNKNOWN' };
}

// The objective's single primary category, plus separate attention. Executing
// work stays ACTIVE even when another task needs the owner; the attention list
// still carries that request. Nothing here writes a status.
export function jobLifecycle(job, { tasks = [], approvals = [], sessions = [], now = Date.now() } = {}) {
  if (!job) return null;
  const terminal = JOB_TERMINAL[job.status] || null;
  const owner = ownerSignals({ job, tasks, approvals, sessions });
  const waits = waitSignals({ tasks, sessions, now });
  const executing = tasks.some((task) => EXECUTING_TASK.has(task.status) && !TASK_TERMINAL[task.status])
    || sessions.some((session) => session.status === 'running');
  const scheduled = tasks.some((task) => taskExecution(task, { job, tasks, now }).posture === 'assigned' || taskExecution(task, { job, tasks, now }).posture === 'queued');
  if (terminal) {
    const failure = terminal === 'FAILED' ? failureText(job, tasks, sessions) : { text: null, basis: null };
    return {
      category: terminal,
      lane: 'HISTORY',
      history: true,
      current: false,
      executing: false,
      ownerAttention: owner.items,
      waiting: [],
      reason: failure.text,
      reasonBasis: failure.basis,
    };
  }
  let category = 'ACTIVE';
  let reason = null;
  let reasonBasis = null;
  if (!executing && owner.blocking) {
    category = 'NEEDS_OWNER';
    reason = owner.reason;
    reasonBasis = 'RECORDED';
  } else if (!executing && waits.blocking) {
    category = 'WAITING';
    reason = waits.reason;
    reasonBasis = 'RECORDED';
  } else if (executing || scheduled || ['planning', 'running', 'review'].includes(job.status)) {
    category = 'ACTIVE';
  } else if (job.status === 'waiting_approval') {
    category = 'NEEDS_OWNER';
    reason = owner.reason || 'Approval required';
    reasonBasis = 'RECORDED';
  } else if (job.status === 'blocked') {
    category = 'WAITING';
    reason = 'blocked';
    reasonBasis = 'RECORDED';
  } else {
    category = 'WAITING';
    reason = null;
    reasonBasis = 'UNKNOWN';
  }
  return {
    category,
    lane: category,
    history: false,
    current: true,
    executing,
    ownerAttention: owner.items,
    waiting: waits.items,
    reason,
    reasonBasis,
  };
}
