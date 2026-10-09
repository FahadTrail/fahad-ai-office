// Current work. Empty when nothing is actually open. A completed objective
// is never selected as the current objective. Historical tests and benchmarks
// are excluded. A genuinely open test is returned separately and labelled.

import { classifyWork } from './classification.js';
import { jobLifecycle } from './lifecycle.js';
import { objectiveSummary } from './objectives.js';

function contextFor(job, { tasks, sessions, approvals, results, agents }) {
  const jobTasks = tasks.filter((task) => task.job_id === job.id);
  const jobSessions = sessions.filter((session) => session.job_id === job.id);
  const jobApprovals = approvals.filter((approval) => approval.job_id === job.id || jobSessions.some((session) => session.id === approval.session_id));
  return { tasks: jobTasks, sessions: jobSessions, approvals: jobApprovals, results: results.filter((result) => result.job_id === job.id), agents };
}

export function currentWork({ jobs = [], tasks = [], agents = [], sessions = [], approvals = [], results = [], now = Date.now() } = {}) {
  const active = [];
  const waiting = [];
  const needsOwner = [];
  const activeTests = [];
  for (const job of jobs) {
    const context = contextFor(job, { tasks, sessions, approvals, results, agents });
    const life = jobLifecycle(job, { ...context, now });
    if (!life?.current) continue;
    const classification = classifyWork(job, { open: true });
    const summary = objectiveSummary({ job, ...context, now });
    if (classification.class === 'TEST') activeTests.push(summary);
    else if (life.category === 'NEEDS_OWNER') needsOwner.push(summary);
    else if (life.category === 'WAITING') waiting.push(summary);
    else active.push(summary);
  }
  const byOpened = (a, b) => String(b.openedAt || '').localeCompare(String(a.openedAt || ''));
  active.sort(byOpened);
  waiting.sort(byOpened);
  needsOwner.sort(byOpened);
  activeTests.sort(byOpened);
  const current = active[0] || needsOwner[0] || waiting[0] || null;
  return {
    empty: active.length + waiting.length + needsOwner.length === 0,
    current: current ? { id: current.id, title: current.title, lifecycle: current.lifecycle } : null,
    active,
    waiting,
    needsOwner,
    activeTests,
    counts: {
      active: active.length,
      waiting: waiting.length,
      needsOwner: needsOwner.length,
      activeTests: activeTests.length,
      real: active.length + waiting.length + needsOwner.length,
    },
  };
}
