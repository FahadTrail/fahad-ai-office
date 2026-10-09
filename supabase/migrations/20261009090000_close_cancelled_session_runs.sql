-- Fahad AI Office — a cancelled Coding Agent session closes its carrier run.
--
-- Audit 2026-10-09: request_agent_session_cancel cancelled the session and its
-- job but left the job's carrier run 'running' (and its task 'assigned') when
-- the session was cancelled from queued / blocked / awaiting_approval. Nine
-- such runs had stayed 'running' for days on cancelled jobs and were reported
-- as runsLeftRunningOnClosedObjectives by the health snapshot.
--
-- 1. The function now closes the run and the task the same way
--    finish_agent_session does for 'cancelled'. Body otherwise unchanged;
--    `create or replace` keeps the existing grants (service_role only).
-- 2. One-time repair: runs still 'running' whose session AND job are both
--    'cancelled' are closed. Nothing is deleted; blocked sessions (which can
--    still resume) are untouched.

create or replace function public.request_agent_session_cancel(p_session uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.agent_sessions s
  set cancel_requested = true,
      status = case when s.status in ('queued', 'awaiting_approval', 'blocked') then 'cancelled' else s.status end,
      completed_at = case when s.status in ('queued', 'awaiting_approval', 'blocked') then now() else s.completed_at end,
      updated_at = now()
  where s.id = p_session and s.status not in ('completed', 'failed', 'cancelled');
  update public.jobs j set status = 'cancelled', completed_at = now()
    from public.agent_sessions s where s.id = p_session and j.id = s.job_id and s.status = 'cancelled';
  -- Close the carrier run and its task (a running session closes its own via finish_agent_session).
  update public.runs r set status = 'cancelled', ended_at = now(), error_message = 'SESSION_CANCELLED'
    from public.agent_sessions s where s.id = p_session and r.id = s.run_id and s.status = 'cancelled' and r.status = 'running';
  update public.tasks t set status = 'failed', completed_at = now()
    from public.agent_sessions s where s.id = p_session and t.id = s.task_id and s.status = 'cancelled' and t.status not in ('done', 'failed');
end;
$$;

update public.runs r
   set status = 'cancelled', ended_at = coalesce(r.ended_at, now()), error_message = 'SESSION_CANCELLED (closed by 20261009090000)'
  from public.agent_sessions s, public.jobs j
 where r.id = s.run_id and j.id = s.job_id
   and r.status = 'running' and s.status = 'cancelled' and j.status = 'cancelled';

update public.tasks t
   set status = 'failed', completed_at = coalesce(t.completed_at, now())
  from public.agent_sessions s, public.jobs j
 where t.id = s.task_id and j.id = s.job_id
   and t.status not in ('done', 'failed') and s.status = 'cancelled' and j.status = 'cancelled';
