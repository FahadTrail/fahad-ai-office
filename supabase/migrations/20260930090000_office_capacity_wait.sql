-- Fahad AI Office — wait for free model capacity instead of failing.
--
-- When no allowed model route is available right now but one is expected to
-- recover (quota reset, cooldown), the worker defers the task: the open run is
-- closed as 'cancelled' (WAITING_FOR_CAPACITY), the task returns to the queue
-- with not_before = the expected recovery time, and claim_next_task skips it
-- until then. Completed tasks, results, handoffs and artifacts are untouched.
-- A deferral never consumes the task's retry budget, and waits are bounded
-- (the caller passes the limit; after it the task fails with the blocker).
-- Additive: new nullable columns, one new function, claim filter extended.

alter table public.tasks
  add column not_before timestamptz,
  add column wait_count int not null default 0 check (wait_count between 0 and 1000),
  add column wait_info jsonb check (wait_info is null or (jsonb_typeof(wait_info) = 'object' and pg_column_size(wait_info) <= 20000));

create index tasks_waiting_idx on public.tasks (not_before) where status = 'queued' and not_before is not null;

create or replace function private.defer_task(p_task uuid, p_run uuid, p_until timestamptz, p_info jsonb default '{}'::jsonb, p_max_waits int default 48)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.tasks;
  v_agent public.agents;
  v_until timestamptz;
begin
  if p_info is not null and jsonb_typeof(p_info) <> 'object' then
    raise exception 'DEFER_INFO_INVALID' using errcode = '22023';
  end if;
  select * into v_task from public.tasks where id = p_task for update;
  if not found then raise exception 'defer_task: task % not found', p_task; end if;
  if v_task.status <> 'running' then
    return jsonb_build_object('ignored', true, 'status', v_task.status);
  end if;
  if v_task.wait_count >= greatest(1, least(coalesce(p_max_waits, 48), 1000)) then
    return jsonb_build_object('exhausted', true, 'wait_count', v_task.wait_count);
  end if;

  -- At least 30 seconds, at most 24 hours from now.
  v_until := least(greatest(coalesce(p_until, now()), now() + interval '30 seconds'), now() + interval '24 hours');

  select * into v_agent from public.agents where id = v_task.agent_id;

  update public.runs set status = 'cancelled', ended_at = now(), error_message = 'WAITING_FOR_CAPACITY'
   where id = p_run and task_id = p_task and status = 'running';

  update public.tasks
     set status = 'queued', started_at = null, not_before = v_until,
         wait_count = wait_count + 1, wait_info = coalesce(p_info, '{}'::jsonb),
         max_attempts = max_attempts + 1
   where id = p_task;

  perform private.emit('status_changed',
    v_agent.name || ' is waiting for free model capacity — will resume automatically.',
    v_task.job_id, p_task, p_run, v_agent.id, p_level => 'warning',
    p_payload => jsonb_build_object('status', 'WAITING_FOR_CAPACITY', 'until', v_until,
      'wait_count', v_task.wait_count + 1) || coalesce(p_info, '{}'::jsonb));

  return jsonb_build_object('waiting', true, 'until', v_until, 'wait_count', v_task.wait_count + 1);
end;
$$;
revoke all on function private.defer_task(uuid, uuid, timestamptz, jsonb, int) from public, anon, authenticated, service_role;

create or replace function public.defer_task(p_task uuid, p_run uuid, p_until timestamptz, p_info jsonb default '{}'::jsonb, p_max_waits int default 48)
returns jsonb language sql volatile security definer set search_path = private, public as $$
  select private.defer_task(p_task, p_run, p_until, p_info, p_max_waits);
$$;
revoke all on function public.defer_task(uuid, uuid, timestamptz, jsonb, int) from public, anon, authenticated;
grant execute on function public.defer_task(uuid, uuid, timestamptz, jsonb, int) to service_role;

-- claim_next_task: identical to 20260924044535 plus the not_before filter
-- (a waiting task is claimable again once its recovery time has passed).
create or replace function private.claim_next_task(p_agent_slug text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.tasks;
  v_agent public.agents;
  v_run uuid;
  v_upstream jsonb;
  v_workspace uuid;
begin
  select t.* into v_task
  from public.tasks t
  join public.jobs j on j.id = t.job_id
  join public.agents a on a.id = t.agent_id
  where t.status = 'queued'
    and j.status = 'running'
    and (t.not_before is null or t.not_before <= now())
    and (p_agent_slug is null or a.slug = p_agent_slug)
    and not exists (
      select 1 from unnest(t.depends_on) d(id)
      left join public.tasks dt on dt.id = d.id
      where dt.id is null or dt.status not in ('done', 'skipped')
    )
  order by case j.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
           t.sequence, t.created_at
  limit 1
  for update of t skip locked;

  if not found then return null; end if;

  select j.project_id into v_workspace
  from public.jobs j
  where j.id = v_task.job_id;

  update public.tasks
  set status = 'running', attempts = attempts + 1, started_at = now(), not_before = null
  where id = v_task.id
  returning * into v_task;

  select * into v_agent from public.agents where id = v_task.agent_id;

  insert into public.runs (task_id, job_id, agent_id, attempt_no, status)
  values (v_task.id, v_task.job_id, v_task.agent_id, v_task.attempts, 'running')
  returning id into v_run;

  perform private.emit('agent_started', v_agent.name || ' started: ' || v_task.title,
    v_task.job_id, v_task.id, v_run, v_agent.id,
    p_payload => jsonb_build_object('attempt', v_task.attempts));

  select coalesce(jsonb_agg(jsonb_build_object(
           'task_id', dt.id, 'title', dt.title, 'agent_slug', da.slug,
           'summary', r.summary, 'content', r.content) order by dt.sequence), '[]')
    into v_upstream
  from unnest(v_task.depends_on) d(id)
  join public.tasks dt on dt.id = d.id
  join public.agents da on da.id = dt.agent_id
  left join lateral (select summary, content from public.results
                     where task_id = dt.id order by created_at desc limit 1) r on true;

  return jsonb_build_object(
    'task_id', v_task.id, 'job_id', v_task.job_id, 'project_id', v_workspace,
    'run_id', v_run, 'agent_id', v_agent.id, 'agent_slug', v_agent.slug,
    'attempt_no', v_task.attempts, 'max_attempts', v_task.max_attempts,
    'title', v_task.title, 'brief', v_task.brief,
    'goal', (select goal from public.jobs where id = v_task.job_id),
    'upstream', v_upstream,
    'wait_count', v_task.wait_count, 'wait_info', v_task.wait_info);
end;
$$;
revoke execute on function private.claim_next_task(text)
from public, anon, authenticated, service_role;
