// Fail-closed cleanup preview. Explicit ids only. This module never deletes.
// A preview is runnable only when every dependency set was supplied and no
// outside row still depends on a row the preview would remove.

import { isConfirmedTest, isHeuristicTestObjective } from './classification.js';
import { CONFIRMED_TEST_JOB_IDS } from './work-registry.js';

const DELETE_ORDER = Object.freeze([
  'tool_executions',
  'agent_sessions',
  'knowledge_items',
  'jobs',
  'conversations',
  'continuity_tasks',
]);

function countBy(rows, predicate) {
  if (rows == null) return null;
  return rows.filter(predicate).length;
}

export function cleanupPreview({
  selectedIds = [...CONFIRMED_TEST_JOB_IDS],
  jobs = null,
  tasks = null,
  runs = null,
  events = null,
  results = null,
  handoffs = null,
  artifacts = null,
  modelAttempts = null,
  toolExecutions = null,
  agentSessions = null,
  agentEvents = null,
  agentCheckpoints = null,
  knowledgeItems = null,
  conversations = null,
  continuityTasks = null,
} = {}) {
  const selected = new Set(selectedIds.map((id) => String(id).toLowerCase()));
  const blockers = [];
  const supplied = {
    jobs, tasks, runs, events, results, handoffs, artifacts, modelAttempts, toolExecutions,
    agentSessions, agentEvents, agentCheckpoints, knowledgeItems, conversations, continuityTasks,
  };
  const missing = Object.entries(supplied).filter(([key, value]) => key !== 'continuityTasks' && value == null).map(([key]) => key);
  const selectedJobs = jobs == null ? null : jobs.filter((job) => selected.has(String(job.id).toLowerCase()));
  const conversationIds = new Set();
  if (selectedJobs) {
    for (const job of selectedJobs) if (job.conversation_id) conversationIds.add(job.conversation_id);
  }
  const keptConversations = new Set();
  if (jobs) {
    for (const conversationId of conversationIds) {
      const outside = jobs.some((job) => job.conversation_id === conversationId && !selected.has(String(job.id).toLowerCase()));
      if (outside) keptConversations.add(conversationId);
    }
  }
  if (agentSessions && jobs) {
    for (const session of agentSessions) {
      const job = jobs.find((row) => row.id === session.job_id);
      const conversationId = session.conversation_id || job?.conversation_id;
      if (!conversationId || !conversationIds.has(conversationId)) continue;
      if (!job || !selected.has(String(job.id).toLowerCase())) keptConversations.add(conversationId);
    }
  }
  if (selectedJobs) {
    for (const job of selectedJobs) {
      if (!isConfirmedTest(job) && !isHeuristicTestObjective(job)) blockers.push({ code: 'NOT_CONFIRMED_TEST', jobId: job.id });
    }
  }
  const dropConversations = new Set([...conversationIds].filter((id) => !keptConversations.has(id)));
  const counts = {
    jobs: countBy(jobs, (job) => selected.has(String(job.id).toLowerCase())),
    tasks: countBy(tasks, (row) => selected.has(String(row.job_id).toLowerCase())),
    runs: countBy(runs, (row) => selected.has(String(row.job_id).toLowerCase())),
    events: countBy(events, (row) => selected.has(String(row.job_id).toLowerCase())),
    results: countBy(results, (row) => selected.has(String(row.job_id).toLowerCase())),
    handoffs: countBy(handoffs, (row) => selected.has(String(row.job_id).toLowerCase())),
    artifacts: countBy(artifacts, (row) => selected.has(String(row.job_id).toLowerCase())),
    modelAttempts: countBy(modelAttempts, (row) => selected.has(String(row.job_id).toLowerCase())),
    toolExecutions: countBy(toolExecutions, (row) => row.job_id ? selected.has(String(row.job_id).toLowerCase()) : false),
    agentSessions: countBy(agentSessions, (row) => selected.has(String(row.job_id || '').toLowerCase())),
    agentEvents: countBy(agentEvents, (row) => row.job_id ? selected.has(String(row.job_id).toLowerCase()) : false),
    agentCheckpoints: countBy(agentCheckpoints, () => false),
    knowledgeItems: countBy(knowledgeItems, (row) => selected.has(String(row.source_job_id || row.job_id || '').toLowerCase())),
    conversations: conversations == null ? null : dropConversations.size,
    continuityTasks: continuityTasks == null ? 'UNKNOWN' : countBy(continuityTasks, (row) => selected.has(String(row.job_id || '').toLowerCase())),
  };
  if (agentSessions && agentCheckpoints) {
    const sessionIds = new Set(agentSessions.filter((session) => selected.has(String(session.job_id || '').toLowerCase())).map((session) => session.id));
    counts.agentCheckpoints = agentCheckpoints.filter((row) => sessionIds.has(row.session_id)).length;
  }
  if (agentSessions && agentEvents) {
    const sessionIds = new Set(agentSessions.filter((session) => selected.has(String(session.job_id || '').toLowerCase())).map((session) => session.id));
    counts.agentEvents = agentEvents.filter((row) => sessionIds.has(row.session_id) || selected.has(String(row.job_id || '').toLowerCase())).length;
  }
  const ready = missing.length === 0 && blockers.length === 0;
  return {
    executed: false,
    mode: 'preview',
    ready,
    selected: selected.size,
    absent: jobs == null ? 'UNKNOWN' : [...selected].filter((id) => !jobs.some((job) => String(job.id).toLowerCase() === id)).length,
    counts,
    blockers,
    missing,
    deleteOrder: DELETE_ORDER,
    keptConversations: [...keptConversations],
    sql: previewSql([...selected], [...dropConversations]),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function quoteList(ids) {
  return ids.map((id) => {
    const value = String(id).toLowerCase();
    if (!UUID_RE.test(value)) throw Object.assign(new Error('CLEANUP_ID_INVALID'), { statusCode: 400 });
    return `'${value}'`;
  }).join(',\n  ');
}

export function previewSql(jobIds, conversationIds = []) {
  const jobs = quoteList(jobIds);
  const conversations = conversationIds.length ? quoteList(conversationIds) : null;
  return `-- FAIL-CLOSED PREVIEW. This script rolls back. It does not delete.
-- Explicit job ids only. Do not run against production without Fahad's approval.
begin;

create temporary table cleanup_jobs (job_id uuid primary key) on commit drop;
insert into cleanup_jobs (job_id)
select unnest(array[
  ${jobs}
]::uuid[]);

-- Outside rows that still depend on a selected job abort the preview.
do $$
declare
  v_outside int;
begin
  select count(*) into v_outside from public.jobs j
    where j.conversation_id in (
      select s.conversation_id from public.jobs s
      join cleanup_jobs c on c.job_id = s.id
      where s.conversation_id is not null
    )
    and not exists (select 1 from cleanup_jobs c where c.job_id = j.id);
  if v_outside > 0 then
    raise exception 'CLEANUP_BLOCKED: % job(s) outside the selection share a conversation', v_outside;
  end if;
end $$;

-- Counts are reported by the caller. No DELETE is issued in this preview.
select 'jobs' as relation, count(*) as rows from public.jobs j join cleanup_jobs c on c.job_id = j.id
union all select 'tasks', count(*) from public.tasks t join cleanup_jobs c on c.job_id = t.job_id
union all select 'results', count(*) from public.results r join cleanup_jobs c on c.job_id = r.job_id;

${conversations ? `-- Conversations eligible only because every job and session that uses them is inside the selection:\n-- ${conversations}` : '-- No conversation is eligible for removal.'}

rollback;
`;
}
