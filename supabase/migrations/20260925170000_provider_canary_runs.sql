-- On-demand live provider canary. The owner (Hub) or an operator inserts a
-- queued row; the Office runtime, which already holds the provider keys,
-- claims it, runs the agentic canary once with synthetic data and stores a
-- metadata-only report (route ids, pass/fail, error codes, durations). No
-- prompts, responses beyond the checked numeric answer, or credentials.
create table public.provider_canary_runs (
  id uuid primary key default gen_random_uuid(),
  requested_at timestamptz not null default now(),
  requested_by text check (requested_by is null or char_length(requested_by) <= 320),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  started_at timestamptz,
  completed_at timestamptz,
  report jsonb check (report is null or jsonb_typeof(report) = 'object'),
  error text check (error is null or char_length(error) <= 500)
);

create index provider_canary_runs_queue_idx on public.provider_canary_runs (status, requested_at) where status = 'queued';

alter table public.provider_canary_runs enable row level security;
revoke all on table public.provider_canary_runs from public, anon, authenticated, service_role;
grant select, insert, update on table public.provider_canary_runs to service_role;

-- Claims the oldest queued run; a run stuck in "running" for 15 minutes
-- (runtime restarted mid-canary) is failed so the queue never wedges.
create function public.claim_provider_canary_run()
returns setof public.provider_canary_runs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_run public.provider_canary_runs%rowtype;
begin
  update public.provider_canary_runs r
  set status = 'failed', completed_at = now(), error = 'CANARY_INTERRUPTED'
  where r.status = 'running' and r.started_at < now() - interval '15 minutes';
  select * into v_run from public.provider_canary_runs r
  where r.status = 'queued' order by r.requested_at for update skip locked limit 1;
  if not found then
    return;
  end if;
  update public.provider_canary_runs r set status = 'running', started_at = now()
  where r.id = v_run.id returning * into v_run;
  return next v_run;
end;
$$;

revoke all on function public.claim_provider_canary_run() from public, anon, authenticated, service_role;
grant execute on function public.claim_provider_canary_run() to service_role;
