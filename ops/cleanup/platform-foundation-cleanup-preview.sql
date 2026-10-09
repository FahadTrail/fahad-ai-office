-- Fail-closed cleanup PREVIEW for the explicit 2026-10-09 confirmed-test ids.
-- Run in one psql session, after the selection script has created cleanup_jobs:
--
--   begin;
--   \ir 2026-10-09-test-data-selection.sql
--   \ir platform-foundation-cleanup-preview.sql
--
-- This file counts and aborts when a job outside the selection still shares a
-- conversation. It does not delete. The transaction rolls back.
-- Do not run a production deletion without Fahad's approval.

do $$
declare
  v_outside int;
begin
  if to_regclass('pg_temp.cleanup_jobs') is null then
    raise exception 'CLEANUP_BLOCKED: cleanup_jobs is missing; load the explicit-id selection first';
  end if;
  select count(*) into v_outside
  from public.jobs j
  where j.conversation_id in (
    select s.conversation_id
    from public.jobs s
    join cleanup_jobs c on c.job_id = s.id
    where s.conversation_id is not null
  )
  and not exists (select 1 from cleanup_jobs c where c.job_id = j.id);
  if v_outside > 0 then
    raise exception 'CLEANUP_BLOCKED: % job(s) outside the selection share a conversation', v_outside;
  end if;
end $$;

select 'jobs' as relation, count(*) as rows from public.jobs j join cleanup_jobs c on c.job_id = j.id
union all select 'tasks', count(*) from public.tasks t join cleanup_jobs c on c.job_id = t.job_id
union all select 'results', count(*) from public.results r join cleanup_jobs c on c.job_id = r.job_id
union all select 'agent_sessions', count(*) from public.agent_sessions s join cleanup_jobs c on c.job_id = s.job_id;

rollback;
