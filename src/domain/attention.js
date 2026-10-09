// Owner attention. Only a real approval, question or blocked session that
// Fahad must act on. Capacity waits, historical tests and finished work with
// no pending request are not alarms.

import { classifyWork } from './classification.js';
import { isCapacityReason, jobLifecycle, sessionLifecycle } from './lifecycle.js';

function testJob(job, open) {
  return job ? classifyWork(job, { open }).class === 'TEST' : false;
}

export function attentionItems({ jobs = [], tasks = [], sessions = [], approvals = [], now = Date.now() } = {}) {
  const items = [];
  const tasksByJob = new Map();
  for (const task of tasks) {
    const list = tasksByJob.get(task.job_id) || [];
    list.push(task);
    tasksByJob.set(task.job_id, list);
  }
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  for (const job of jobs) {
    if (testJob(job, !['completed', 'failed', 'cancelled'].includes(job.status))) continue;
    const jobTasks = tasksByJob.get(job.id) || [];
    const jobSessions = sessions.filter((session) => session.job_id === job.id);
    const jobApprovals = approvals.filter((approval) => approval.job_id === job.id || jobSessions.some((session) => session.id === approval.session_id));
    const life = jobLifecycle(job, { tasks: jobTasks, approvals: jobApprovals, sessions: jobSessions, now });
    for (const attention of life.ownerAttention) {
      if (isCapacityReason(attention.code) || isCapacityReason(attention.title)) continue;
      items.push({
        kind: attention.kind,
        objectiveId: job.id,
        projectId: job.project_id || null,
        taskId: attention.taskId || null,
        sessionId: attention.sessionId || null,
        title: job.title || String(job.goal || '').slice(0, 160),
        detail: attention.title,
        lifecycle: life.category,
        at: attention.at || null,
      });
    }
  }
  for (const session of sessions) {
    const job = jobById.get(session.job_id) || null;
    if (job && testJob(job, sessionLifecycle(session, { approvals, now })?.current)) continue;
    if (!job && classifyWork({ id: session.id, title: session.title, goal: session.objective }, { open: !['completed', 'failed', 'cancelled'].includes(session.status) }).class === 'TEST' && ['completed', 'failed', 'cancelled'].includes(session.status)) continue;
    const life = sessionLifecycle(session, { approvals, now });
    if (!life?.ownerAttention?.length) continue;
    if (job && items.some((item) => item.sessionId === session.id)) continue;
    for (const attention of life.ownerAttention) {
      if (isCapacityReason(attention.code) || isCapacityReason(session.error_code)) continue;
      items.push({
        kind: attention.kind,
        objectiveId: session.job_id || null,
        projectId: session.workspace_id || job?.project_id || null,
        taskId: session.task_id || null,
        sessionId: session.id,
        title: session.title,
        detail: attention.title,
        lifecycle: life.category,
        at: session.updated_at || null,
      });
    }
  }
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.kind}:${item.objectiveId || ''}:${item.sessionId || ''}:${item.taskId || ''}:${item.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
