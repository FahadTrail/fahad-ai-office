// Conversation projections. A conversation is not an objective, a task or a
// Coding Agent session. Those stay linked by id.

import { executiveSummaryOf } from './results.js';
import { sessionLifecycle } from './lifecycle.js';
import { matchesQuery } from './pagination.js';

function messageFromJob(job, results) {
  const final = results.find((result) => result.job_id === job.id && result.kind === 'final')
    || results.filter((result) => result.job_id === job.id).at(-1)
    || null;
  const summary = final ? executiveSummaryOf(final) : { text: null, status: 'MISSING', source: null };
  return [
    { id: `user:${job.id}`, role: 'owner', at: job.created_at, text: job.goal || job.title || '', jobId: job.id, sessionId: null },
    { id: `assistant:${job.id}`, role: 'office', at: final?.created_at || job.completed_at || job.created_at, text: summary.text, summaryStatus: summary.status, resultId: final?.id || null, jobId: job.id, sessionId: null },
  ];
}

export function conversationSummary({ conversation, jobs = [], sessions = [], results = [], approvals = [], query = '' } = {}) {
  if (!conversation) return null;
  const linkedJobs = jobs.filter((job) => job.conversation_id === conversation.id).toSorted((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const linkedSessions = sessions.filter((session) => session.conversation_id === conversation.id || linkedJobs.some((job) => job.id === session.job_id));
  const messages = linkedJobs.flatMap((job) => messageFromJob(job, results));
  for (const session of linkedSessions) {
    messages.push({ id: `session:${session.id}`, role: 'coding', at: session.created_at || session.updated_at, text: session.title, summaryStatus: 'PRESENT', resultId: null, jobId: session.job_id || null, sessionId: session.id });
  }
  messages.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  const liveSession = linkedSessions.find((session) => sessionLifecycle(session, { approvals }).current) || null;
  const liveJob = linkedJobs.find((job) => !['completed', 'failed', 'cancelled'].includes(job.status)) || null;
  const pending = approvals.filter((approval) => approval.status === 'pending' && (linkedSessions.some((session) => session.id === approval.session_id) || linkedJobs.some((job) => job.id === approval.job_id)));
  const summary = {
    id: conversation.id,
    projectId: conversation.project_id,
    title: conversation.title,
    archived: Boolean(conversation.archived),
    updatedAt: conversation.updated_at || conversation.last_message_at || null,
    objectiveIds: linkedJobs.map((job) => job.id),
    codingSessionIds: linkedSessions.map((session) => session.id),
    live: liveJob || liveSession ? {
      objectiveId: liveJob?.id || liveSession?.job_id || null,
      sessionId: liveSession?.id || null,
      state: liveSession ? sessionLifecycle(liveSession, { approvals }).category : (liveJob?.status || null),
    } : null,
    approvals: pending.map((approval) => ({ id: approval.id, sessionId: approval.session_id || null, jobId: approval.job_id || null, title: approval.title || approval.summary || 'Approval required' })),
    searchable: { title: conversation.title, updatedAt: conversation.updated_at || conversation.last_message_at || null },
    messages,
  };
  if (query && !matchesQuery([summary.title, ...summary.messages.map((message) => message.text)], query)) return null;
  return summary;
}

export function conversationIndex(conversations, context) {
  return conversations.map((conversation) => conversationSummary({ conversation, ...context })).filter(Boolean).map((conversation) => ({
    id: conversation.id,
    projectId: conversation.projectId,
    title: conversation.title,
    archived: conversation.archived,
    updatedAt: conversation.updatedAt,
    objectiveIds: conversation.objectiveIds,
    codingSessionIds: conversation.codingSessionIds,
    live: conversation.live,
    searchable: conversation.searchable,
  }));
}
