// Project contracts. A project is a container. Completing an objective does
// not archive the project. The default project is never a test or certification
// project merely because it was opened last.

import { classifyWork } from './classification.js';
import { jobLifecycle, TERMINAL_JOB_STATUSES } from './lifecycle.js';
import { objectiveSummary } from './objectives.js';

const TEST_PROJECT = /\b(test|tests|testing|demo|certification|sandbox|staging|safe to delete)\b/i;

export function defaultableProject(project) {
  return Boolean(project) && project.status !== 'archived' && !TEST_PROJECT.test(String(project.name || ''));
}

export function recommendProject(projects = [], savedId = null) {
  const saved = projects.find((project) => project.id === savedId);
  if (defaultableProject(saved)) return saved;
  return projects.find((project) => project.name === 'Fahad AI Office' && project.status !== 'archived')
    || projects.find(defaultableProject)
    || null;
}

function objectiveBrief(job, context) {
  const summary = objectiveSummary({ job, ...context });
  return {
    id: job.id,
    title: summary.title,
    lifecycle: summary.lifecycle,
    lane: summary.lane,
    current: summary.current,
    classification: summary.classification,
    nextAction: summary.nextAction,
    openedAt: job.created_at || null,
    closedAt: job.completed_at || null,
    conversationId: job.conversation_id || null,
  };
}

export function projectSummary({
  project,
  jobs = [],
  tasks = [],
  agents = [],
  results = [],
  sessions = [],
  approvals = [],
  conversations = [],
  costs = null,
  now = Date.now(),
} = {}) {
  if (!project) return null;
  const ownJobs = jobs.filter((job) => !job.project_id || job.project_id === project.id);
  const tasksByJob = new Map();
  for (const task of tasks) {
    const list = tasksByJob.get(task.job_id) || [];
    list.push(task);
    tasksByJob.set(task.job_id, list);
  }
  const briefs = ownJobs.map((job) => {
    const jobTasks = tasksByJob.get(job.id) || [];
    const jobSessions = sessions.filter((session) => session.job_id === job.id);
    const jobApprovals = approvals.filter((approval) => approval.job_id === job.id || jobSessions.some((session) => session.id === approval.session_id));
    return { job, brief: objectiveBrief(job, { tasks: jobTasks, agents, sessions: jobSessions, approvals: jobApprovals, results: results.filter((result) => result.job_id === job.id), now }) };
  });
  const real = (entry) => entry.brief.classification.class !== 'TEST';
  const active = briefs.filter((entry) => entry.brief.current && entry.brief.lifecycle === 'ACTIVE' && real(entry));
  const waiting = briefs.filter((entry) => entry.brief.current && entry.brief.lifecycle === 'WAITING' && real(entry));
  const needsOwner = briefs.filter((entry) => (entry.brief.lifecycle === 'NEEDS_OWNER' || entry.brief.ownerAttention?.length) && entry.brief.current && real(entry));
  const attention = briefs.filter((entry) => real(entry) && entry.brief.nextAction && ['APPROVE', 'ANSWER', 'OWNER_REVIEW'].includes(entry.brief.nextAction.code));
  const completed = briefs.filter((entry) => entry.brief.lifecycle === 'COMPLETED' && real(entry));
  const history = briefs.filter((entry) => entry.brief.lane === 'HISTORY');
  const recentResults = results
    .filter((result) => ownJobs.some((job) => job.id === result.job_id && classifyWork(job, { open: false }).class !== 'TEST'))
    .slice(0, 8)
    .map((result) => ({ id: result.id, objectiveId: result.job_id, kind: result.kind, at: result.created_at }));
  return {
    id: project.id,
    name: project.name,
    description: project.description || '',
    status: project.status || 'active',
    archived: project.status === 'archived',
    repository: project.default_repository || null,
    createdAt: project.created_at || null,
    overview: {
      activeObjectives: active.length,
      waitingObjectives: waiting.length,
      ownerAttention: attention.length,
      completedObjectives: completed.length,
      history: history.length,
    },
    activeObjectives: [...active, ...waiting, ...needsOwner].map((entry) => entry.brief),
    ownerAttention: attention.map((entry) => ({ objectiveId: entry.job.id, title: entry.brief.title, nextAction: entry.brief.nextAction })),
    recentResults,
    completedObjectives: completed.map((entry) => entry.brief),
    history: history.map((entry) => entry.brief),
    costs: costs || { totalSpendUsd: 'UNKNOWN', basis: 'UNKNOWN' },
    conversations: conversations.filter((conversation) => !conversation.project_id || conversation.project_id === project.id).map((conversation) => ({
      id: conversation.id, title: conversation.title, archived: Boolean(conversation.archived), updatedAt: conversation.updated_at || conversation.last_message_at || null,
    })),
    codingSessions: sessions.filter((session) => !session.workspace_id || session.workspace_id === project.id).map((session) => ({
      id: session.id, title: session.title, status: session.status, jobId: session.job_id || null, current: !TERMINAL_JOB_STATUSES.includes(session.status) && !['completed', 'failed', 'cancelled'].includes(session.status),
    })),
  };
}
