// Owner-facing facts for the V5 shell. Pure: the same rows the Hub already
// returned, with no invented zeroes and no second count for people who are
// already working on a counted objective.

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const WORKING = new Set(['THINKING', 'WORKING', 'TESTING', 'REVIEWING']);

export function knownNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function countLabel(value) {
  const number = knownNumber(value);
  return number == null ? null : String(number);
}

// Running work is objectives plus coding sessions that are not already the
// coding step of one of those objectives. Employees assigned to an objective
// are the team on that objective, not additional running items.
export function ownerWorkCounts({ jobs = [], tasks = [], agents = [] } = {}) {
  const objectives = (jobs || []).filter((job) => job && !TERMINAL.has(job.status));
  const objectiveIds = new Set(objectives.map((job) => job.id).filter(Boolean));
  const coding = (tasks || []).filter((task) => task && (task.group === 'running' || task.group === 'attention') && !(task.jobId && objectiveIds.has(task.jobId)));
  const employeesOnObjectives = (agents || []).filter((agent) => WORKING.has(agent?.state) && agent.assignment?.jobId && objectiveIds.has(agent.assignment.jobId)).length;
  return { objectives: objectives.length, coding: coding.length, running: objectives.length + coding.length, employeesOnObjectives };
}

export function progressWidth(value) {
  const number = knownNumber(value);
  if (number == null || number <= 0) return 0;
  return Math.max(3, Math.min(100, number));
}

// One card per completed job or coding task. Attention rows, job rows and
// task rows that describe the same work collapse to the first, richest item.
export function latestResults({ attention = [], jobs = [], tasks = [] } = {}, limit = 5) {
  const seen = new Set();
  const items = [];
  const push = (item) => {
    if (!item?.title) return;
    const keys = [];
    if (item.jobId) keys.push(`job:${item.jobId}`);
    if (item.taskId) keys.push(`task:${item.taskId}`);
    if (!keys.length && item.href) keys.push(`href:${item.href}`);
    if (!keys.length) keys.push(`title:${item.title}|${item.at || ''}`);
    if (keys.some((key) => seen.has(key))) return;
    keys.forEach((key) => seen.add(key));
    items.push(item);
  };
  for (const item of attention || []) {
    push({
      title: item.title, detail: item.detail || '', at: item.at || null,
      jobId: item.jobId || null, taskId: item.taskId || null,
      href: item.taskId ? `#/task/${item.taskId}` : item.jobId ? `#/job/${item.jobId}` : '#/artifacts',
    });
  }
  for (const job of jobs || []) {
    if (job?.status !== 'completed') continue;
    push({ title: job.title, detail: '', at: job.completed_at || job.created_at || null, jobId: job.id, taskId: null, href: `#/job/${job.id}` });
  }
  for (const task of tasks || []) {
    if (task?.group !== 'completed') continue;
    push({ title: task.title, detail: task.summary || '', at: task.completedAt || null, jobId: task.jobId || null, taskId: task.id, href: `#/task/${task.id}` });
  }
  return items.toSorted((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, limit);
}

export function projectFacts({ center = null, stats = null } = {}) {
  const active = center && Array.isArray(center.objectives?.active) ? center.objectives.active.length : null;
  const tasks = stats ? knownNumber(stats.tasks) : null;
  const completed = stats ? knownNumber(stats.completedTasks) : null;
  const cost = center ? knownNumber(center.costUsd) : null;
  let state = 'unavailable';
  if (center) {
    if (center.status === 'NEEDS FAHAD' || center.status === 'AT RISK') state = 'attention';
    else if ((active || 0) > 0 || center.status === 'IN PROGRESS') state = 'active';
    else state = 'ready';
  }
  return { active, tasks, completed, cost, state };
}

export function healthFacts({ health = null, platform = null } = {}) {
  if (health == null && platform == null) return { state: 'unavailable', hub: 'unavailable', database: 'unavailable' };
  const hub = health?.ok === true ? 'healthy' : health?.ok === false ? 'unhealthy' : platform?.systemHealth?.hub === 'ok' ? 'healthy' : platform?.systemHealth?.hub ? 'unhealthy' : platform == null && health == null ? 'unavailable' : 'unknown';
  const database = platform?.systemHealth?.database === 'ok' ? 'healthy' : platform?.systemHealth?.database ? 'unhealthy' : platform == null ? 'unavailable' : 'unknown';
  const state = hub === 'healthy' && database === 'healthy' ? 'healthy' : hub === 'unhealthy' || database === 'unhealthy' ? 'unhealthy' : hub === 'unavailable' && database === 'unavailable' ? 'unavailable' : 'unknown';
  return { state, hub, database };
}

export function capacitySentence(summary, language = 'en') {
  if (!summary) return null;
  const available = knownNumber(summary.healthyPools);
  const degraded = knownNumber(summary.degradedPools) || 0;
  const exhausted = knownNumber(summary.exhaustedPools) || 0;
  if (available == null) return null;
  const total = available + degraded + exhausted;
  if (language === 'ar') {
    const parts = [`${available} من ${total} مجموعات مجانية متاحة`];
    if (degraded) parts.push(`${degraded} محدودة`);
    if (exhausted) parts.push(`${exhausted} مستنفدة`);
    return `${parts.join('؛ ')}.`;
  }
  const parts = [`${available} of ${total} free capacity pools are available`];
  if (degraded) parts.push(`${degraded} limited`);
  if (exhausted) parts.push(`${exhausted} used up`);
  return `${parts.join('; ')}.`;
}
