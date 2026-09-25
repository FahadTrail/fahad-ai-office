-- ============================================================
-- claim_next_job()
-- The runtime calls this to grab exactly one waiting job.
-- FOR UPDATE SKIP LOCKED guarantees that even if two runtime
-- instances ever run at once, a job is never picked up twice.
-- ============================================================

create or replace function private.claim_next_job()
returns public.jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.jobs;
begin
  select * into claimed
  from public.jobs
  where status = 'planning'
  order by
    case priority when 'urgent' then 0 when 'high' then 1
                  when 'normal' then 2 else 3 end,
    created_at
  limit 1
  for update skip locked;

  if not found then
    return null;
  end if;

  update public.jobs
     set status = 'running',
         started_at = coalesce(started_at, now())
   where id = claimed.id
  returning * into claimed;

  return claimed;
end $$;

revoke all on function private.claim_next_job() from public, anon, authenticated;
grant usage on schema private to service_role;
grant execute on function private.claim_next_job() to service_role;
