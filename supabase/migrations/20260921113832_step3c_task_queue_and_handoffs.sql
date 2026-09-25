-- ============================================================
-- STEP 3C — multi-agent task queue, dependency resolution, handoffs
-- Additive only. Nothing the v1 runtime uses is changed:
--   * claim_next_job() untouched
--   * v1 creates tasks as 'assigned'; this queue only claims 'queued'
--   * event types are a strict superset of the old list
-- ============================================================

-- 1. New event types (superset) ---------------------------------
alter table public.events drop constraint events_type_check;
alter table public.events add constraint events_type_check check (type in (
  'job_created','plan_created','task_created','agent_assigned',
  'agent_started','status_changed','progress','activity',
  'result_produced','handoff','error','retry',
  'approval_requested','approval_granted','approval_rejected',
  'job_completed','job_failed',
  'task_completed','task_failed','task_blocked'
));

-- 2. Fast lookup of "who depends on this task" ------------------
create index if not exists idx_tasks_depends_on on public.tasks using gin (depends_on);
create index if not exists idx_tasks_queued on public.tasks (status, sequence, created_at) where status = 'queued';

-- 3. Event helper ------------------------------------------------
create or replace function private.emit(
  p_type text, p_message text,
  p_job uuid default null, p_task uuid default null, p_run uuid default null,
  p_agent uuid default null, p_from uuid default null, p_to uuid default null,
  p_level text default 'info', p_payload jsonb default '{}'
) returns void language sql security definer set search_path = public as $$
  insert into public.events (type, message, job_id, task_id, run_id, agent_id,
                             from_agent_id, to_agent_id, level, payload)
  values (p_type, p_message, p_job, p_task, p_run, p_agent, p_from, p_to, p_level, p_payload);
$$;

-- 4. create_task -------------------------------------------------
create or replace function private.create_task(
  p_job uuid, p_agent_slug text, p_title text, p_brief text,
  p_sequence int default 0, p_depends_on uuid[] default '{}', p_max_attempts int default 3
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_agent public.agents; v_task uuid; v_bad int;
begin
  select * into v_agent from public.agents where slug = p_agent_slug and is_active;
  if not found then raise exception 'create_task: unknown or inactive agent %', p_agent_slug; end if;

  if not exists (select 1 from public.jobs where id = p_job) then
    raise exception 'create_task: job % does not exist', p_job;
  end if;

  -- every dependency must exist and belong to the same job
  select count(*) into v_bad
  from unnest(coalesce(p_depends_on,'{}')) d(id)
  left join public.tasks t on t.id = d.id and t.job_id = p_job
  where t.id is null;
  if v_bad > 0 then
    raise exception 'create_task: % dependency id(s) missing or belong to another job', v_bad;
  end if;

  insert into public.tasks (job_id, agent_id, title, brief, status, sequence, depends_on, max_attempts)
  values (p_job, v_agent.id, p_title, coalesce(p_brief,''), 'queued', p_sequence,
          coalesce(p_depends_on,'{}'), p_max_attempts)
  returning id into v_task;

  perform private.emit('task_created', 'Task created: ' || p_title, p_job, v_task, null, v_agent.id,
    p_payload => jsonb_build_object('title', p_title, 'sequence', p_sequence, 'depends_on', to_jsonb(coalesce(p_depends_on,'{}'))));
  perform private.emit('agent_assigned', v_agent.name || ' assigned: ' || p_title, p_job, v_task, null, v_agent.id);

  return v_task;
end $$;

-- 5. claim_next_task --------------------------------------------
-- Returns one ready task (all dependencies done/skipped) as jsonb, or null.
-- FOR UPDATE ... SKIP LOCKED: two workers can never take the same task.
create or replace function private.claim_next_task(p_agent_slug text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_task public.tasks; v_agent public.agents; v_run uuid; v_upstream jsonb;
begin
  select t.* into v_task
  from public.tasks t
  join public.jobs j   on j.id = t.job_id
  join public.agents a on a.id = t.agent_id
  where t.status = 'queued'
    and j.status = 'running'
    and (p_agent_slug is null or a.slug = p_agent_slug)
    and not exists (
      select 1 from unnest(t.depends_on) d(id)
      left join public.tasks dt on dt.id = d.id
      where dt.id is null or dt.status not in ('done','skipped')
    )
  order by case j.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
           t.sequence, t.created_at
  limit 1
  for update of t skip locked;

  if not found then return null; end if;

  update public.tasks
     set status = 'running', attempts = attempts + 1, started_at = now()
   where id = v_task.id
  returning * into v_task;

  select * into v_agent from public.agents where id = v_task.agent_id;

  insert into public.runs (task_id, job_id, agent_id, attempt_no, status)
  values (v_task.id, v_task.job_id, v_task.agent_id, v_task.attempts, 'running')
  returning id into v_run;

  perform private.emit('agent_started', v_agent.name || ' started: ' || v_task.title,
    v_task.job_id, v_task.id, v_run, v_agent.id,
    p_payload => jsonb_build_object('attempt', v_task.attempts));

  -- everything the upstream tasks produced, handed to this agent
  select coalesce(jsonb_agg(jsonb_build_object(
           'task_id', dt.id, 'title', dt.title, 'agent_slug', da.slug,
           'summary', r.summary, 'content', r.content) order by dt.sequence), '[]')
    into v_upstream
  from unnest(v_task.depends_on) d(id)
  join public.tasks dt  on dt.id = d.id
  join public.agents da on da.id = dt.agent_id
  left join lateral (select summary, content from public.results
                     where task_id = dt.id order by created_at desc limit 1) r on true;

  return jsonb_build_object(
    'task_id', v_task.id, 'job_id', v_task.job_id, 'run_id', v_run,
    'agent_id', v_agent.id, 'agent_slug', v_agent.slug,
    'attempt_no', v_task.attempts, 'max_attempts', v_task.max_attempts,
    'title', v_task.title, 'brief', v_task.brief,
    'goal', (select goal from public.jobs where id = v_task.job_id),
    'upstream', v_upstream);
end $$;

-- 6. report_progress --------------------------------------------
create or replace function private.report_progress(p_task uuid, p_run uuid, p_progress int, p_message text)
returns void language plpgsql security definer set search_path = public as $$
declare v_task public.tasks;
begin
  update public.tasks set progress = greatest(0, least(100, p_progress))
   where id = p_task and status = 'running' returning * into v_task;
  if not found then return; end if;
  perform private.emit('progress', p_message, v_task.job_id, p_task, p_run, v_task.agent_id,
    p_payload => jsonb_build_object('progress', v_task.progress));
end $$;

-- 7. complete_task ----------------------------------------------
create or replace function private.complete_task(
  p_task uuid, p_run uuid, p_summary text, p_content text,
  p_format text default 'markdown', p_tokens_in int default 0,
  p_tokens_out int default 0, p_cost numeric default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_task public.tasks; v_agent public.agents; v_result uuid;
  v_dep record; v_handoffs int := 0; v_total int; v_finished int; v_job_done boolean := false;
begin
  select * into v_task from public.tasks where id = p_task for update;
  if not found then raise exception 'complete_task: task % not found', p_task; end if;

  -- idempotent: a retried network call must not double-complete
  if v_task.status = 'done' then
    return jsonb_build_object('already_done', true);
  end if;
  if v_task.status <> 'running' then
    raise exception 'complete_task: task % is %, not running', p_task, v_task.status;
  end if;
  if not exists (select 1 from public.runs where id = p_run and task_id = p_task and status = 'running') then
    raise exception 'complete_task: run % is not the open run of task %', p_run, p_task;
  end if;

  select * into v_agent from public.agents where id = v_task.agent_id;

  insert into public.results (job_id, task_id, agent_id, kind, summary, content, format)
  values (v_task.job_id, p_task, v_agent.id, 'task', coalesce(p_summary,''), coalesce(p_content,''), p_format)
  returning id into v_result;

  update public.runs set status='succeeded', ended_at=now(),
         tokens_in=p_tokens_in, tokens_out=p_tokens_out, cost_usd=p_cost
   where id = p_run;

  update public.tasks set status='done', progress=100, completed_at=now() where id = p_task;

  update public.jobs set tokens_used = tokens_used + p_tokens_in + p_tokens_out,
                         cost_usd = cost_usd + p_cost
   where id = v_task.job_id;

  perform private.emit('result_produced', v_agent.name || ' produced a result.',
    v_task.job_id, p_task, p_run, v_agent.id, p_level => 'success',
    p_payload => jsonb_build_object('result_id', v_result, 'chars', length(coalesce(p_content,''))));
  perform private.emit('task_completed', v_agent.name || ' completed: ' || v_task.title,
    v_task.job_id, p_task, p_run, v_agent.id, p_level => 'success');

  -- one handoff per dependency edge leaving this task
  for v_dep in
    select t.id, t.agent_id, t.title, a.name
    from public.tasks t join public.agents a on a.id = t.agent_id
    where t.job_id = v_task.job_id and p_task = any(t.depends_on) and t.status = 'queued'
  loop
    insert into public.handoffs (job_id, from_agent_id, to_agent_id, from_task_id, to_task_id, summary)
    values (v_task.job_id, v_agent.id, v_dep.agent_id, p_task, v_dep.id, coalesce(p_summary,''));

    perform private.emit('handoff', v_agent.name || ' handed off to ' || v_dep.name || '.',
      v_task.job_id, v_dep.id, null, v_agent.id, v_agent.id, v_dep.agent_id,
      p_payload => jsonb_build_object('from_task', p_task, 'to_task', v_dep.id));
    v_handoffs := v_handoffs + 1;
  end loop;

  -- job progress and closure
  select count(*), count(*) filter (where status in ('done','skipped'))
    into v_total, v_finished from public.tasks where job_id = v_task.job_id;

  update public.jobs set progress = (100 * v_finished / greatest(v_total,1)) where id = v_task.job_id;

  if v_finished = v_total then
    v_job_done := true;
    insert into public.results (job_id, task_id, agent_id, kind, summary, content, format)
    values (v_task.job_id, p_task, v_agent.id, 'final', coalesce(p_summary,''), coalesce(p_content,''), p_format);

    update public.jobs set status='completed', progress=100, completed_at=now(),
           final_summary = left(coalesce(p_summary,''), 300)
     where id = v_task.job_id;

    perform private.emit('job_completed', 'Job completed.', v_task.job_id, null, null, v_agent.id,
      p_level => 'success',
      p_payload => (select jsonb_build_object('cost_usd', cost_usd, 'tokens', tokens_used)
                    from public.jobs where id = v_task.job_id));
  end if;

  return jsonb_build_object('result_id', v_result, 'handoffs', v_handoffs, 'job_completed', v_job_done);
end $$;

-- 8. fail_task ---------------------------------------------------
-- Retries while attempts remain; otherwise fails the task, blocks
-- everything downstream, and fails the job.
create or replace function private.fail_task(p_task uuid, p_run uuid, p_error text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_task public.tasks; v_agent public.agents; v_blocked record; v_n int := 0;
begin
  select * into v_task from public.tasks where id = p_task for update;
  if not found then raise exception 'fail_task: task % not found', p_task; end if;
  if v_task.status <> 'running' then
    return jsonb_build_object('ignored', true, 'status', v_task.status);
  end if;

  select * into v_agent from public.agents where id = v_task.agent_id;

  update public.runs set status='failed', ended_at=now(), error_message=p_error
   where id = p_run and task_id = p_task;

  perform private.emit('error', v_agent.name || ' failed: ' || left(coalesce(p_error,''),200),
    v_task.job_id, p_task, p_run, v_agent.id, p_level => 'error',
    p_payload => jsonb_build_object('attempt', v_task.attempts, 'error', p_error));

  if v_task.attempts < v_task.max_attempts then
    update public.tasks set status='queued', started_at=null where id = p_task;
    perform private.emit('retry',
      'Retrying ' || v_task.title || ' (next attempt ' || (v_task.attempts+1) || ' of ' || v_task.max_attempts || ').',
      v_task.job_id, p_task, null, v_agent.id, p_level => 'warning');
    return jsonb_build_object('will_retry', true, 'attempts', v_task.attempts);
  end if;

  update public.tasks set status='failed', completed_at=now() where id = p_task;
  perform private.emit('task_failed', v_agent.name || ' gave up on: ' || v_task.title,
    v_task.job_id, p_task, p_run, v_agent.id, p_level => 'error');

  for v_blocked in
    with recursive downstream as (
      select t.id from public.tasks t where t.job_id = v_task.job_id and p_task = any(t.depends_on)
      union
      select t.id from public.tasks t join downstream d on d.id = any(t.depends_on)
      where t.job_id = v_task.job_id
    )
    update public.tasks t set status='blocked'
      from downstream d where t.id = d.id and t.status = 'queued'
    returning t.id, t.agent_id, t.title
  loop
    perform private.emit('task_blocked', 'Blocked (upstream failed): ' || v_blocked.title,
      v_task.job_id, v_blocked.id, null, v_blocked.agent_id, p_level => 'warning');
    v_n := v_n + 1;
  end loop;

  update public.jobs set status='failed', completed_at=now(),
         final_summary = left('Failed: ' || v_task.title || ' — ' || coalesce(p_error,''), 300)
   where id = v_task.job_id;
  perform private.emit('job_failed', 'Job failed: ' || v_task.title || ' exhausted its attempts.',
    v_task.job_id, null, null, v_agent.id, p_level => 'error',
    p_payload => jsonb_build_object('blocked_downstream', v_n));

  return jsonb_build_object('will_retry', false, 'blocked_downstream', v_n);
end $$;

-- 9. requeue_stale_tasks — recovery if a runtime dies mid-task ---
create or replace function private.requeue_stale_tasks(p_older_than interval default interval '15 minutes')
returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in
    select t.id as task_id,
           (select id from public.runs where task_id = t.id and status='running'
            order by started_at desc limit 1) as run_id
    from public.tasks t
    where t.status = 'running' and t.started_at < now() - p_older_than
      and exists (select 1 from public.runs where task_id = t.id and status='running')
  loop
    perform private.fail_task(r.task_id, r.run_id, 'Stale: no heartbeat, assumed crashed');
    n := n + 1;
  end loop;
  return n;
end $$;

-- 10. Lock private functions down --------------------------------
revoke all on function private.emit(text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb) from public, anon, authenticated;
revoke all on function private.create_task(uuid,text,text,text,int,uuid[],int) from public, anon, authenticated;
revoke all on function private.claim_next_task(text) from public, anon, authenticated;
revoke all on function private.report_progress(uuid,uuid,int,text) from public, anon, authenticated;
revoke all on function private.complete_task(uuid,uuid,text,text,text,int,int,numeric) from public, anon, authenticated;
revoke all on function private.fail_task(uuid,uuid,text) from public, anon, authenticated;
revoke all on function private.requeue_stale_tasks(interval) from public, anon, authenticated;

-- 11. Public wrappers — service_role only (API exposes only `public`)
create or replace function public.create_task(p_job uuid, p_agent_slug text, p_title text, p_brief text,
  p_sequence int default 0, p_depends_on uuid[] default '{}', p_max_attempts int default 3)
returns uuid language sql volatile security definer set search_path = private, public as $$
  select private.create_task(p_job, p_agent_slug, p_title, p_brief, p_sequence, p_depends_on, p_max_attempts);
$$;

create or replace function public.claim_next_task(p_agent_slug text default null)
returns jsonb language sql volatile security definer set search_path = private, public as $$
  select private.claim_next_task(p_agent_slug);
$$;

create or replace function public.report_progress(p_task uuid, p_run uuid, p_progress int, p_message text)
returns void language sql volatile security definer set search_path = private, public as $$
  select private.report_progress(p_task, p_run, p_progress, p_message);
$$;

create or replace function public.complete_task(p_task uuid, p_run uuid, p_summary text, p_content text,
  p_format text default 'markdown', p_tokens_in int default 0, p_tokens_out int default 0, p_cost numeric default 0)
returns jsonb language sql volatile security definer set search_path = private, public as $$
  select private.complete_task(p_task, p_run, p_summary, p_content, p_format, p_tokens_in, p_tokens_out, p_cost);
$$;

create or replace function public.fail_task(p_task uuid, p_run uuid, p_error text)
returns jsonb language sql volatile security definer set search_path = private, public as $$
  select private.fail_task(p_task, p_run, p_error);
$$;

create or replace function public.requeue_stale_tasks(p_older_than interval default interval '15 minutes')
returns int language sql volatile security definer set search_path = private, public as $$
  select private.requeue_stale_tasks(p_older_than);
$$;

revoke all on function public.create_task(uuid,text,text,text,int,uuid[],int) from public, anon, authenticated;
revoke all on function public.claim_next_task(text) from public, anon, authenticated;
revoke all on function public.report_progress(uuid,uuid,int,text) from public, anon, authenticated;
revoke all on function public.complete_task(uuid,uuid,text,text,text,int,int,numeric) from public, anon, authenticated;
revoke all on function public.fail_task(uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.requeue_stale_tasks(interval) from public, anon, authenticated;

grant execute on function public.create_task(uuid,text,text,text,int,uuid[],int) to service_role;
grant execute on function public.claim_next_task(text) to service_role;
grant execute on function public.report_progress(uuid,uuid,int,text) to service_role;
grant execute on function public.complete_task(uuid,uuid,text,text,text,int,int,numeric) to service_role;
grant execute on function public.fail_task(uuid,uuid,text) to service_role;
grant execute on function public.requeue_stale_tasks(interval) to service_role;
