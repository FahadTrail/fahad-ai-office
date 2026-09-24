-- Propagate the owning workspace through the service-role-only task claim so
-- the runtime can enforce policy before any provider call.
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
    'upstream', v_upstream);
end;
$$;

revoke execute on function private.claim_next_task(text) from public, anon, authenticated;
grant execute on function private.claim_next_task(text) to service_role;
