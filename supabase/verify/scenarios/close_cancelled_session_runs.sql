-- A cancelled Coding Agent session closes its carrier run and task
-- (20261009090000). Runs inside a rolled-back transaction against a local replay.
do $$
declare
  v_workspace uuid;
  v_session public.agent_sessions%rowtype;
begin
  insert into public.projects(name) values ('Fahad AI Office') returning id into v_workspace;
  insert into public.workspace_policies (workspace_id, enabled, monthly_budget_usd, max_request_budget_usd, budget_period_start, budget_period_end)
    values (v_workspace, true, 10, 1, now() - interval '1 day', now() + interval '1 day');
  select * into v_session from public.create_coding_session(v_workspace, 'Probe', 'Cancel me before a worker claims it', 'FahadTrail/fahad-ai-office');
  assert (select status from public.runs where id = v_session.run_id) = 'running', 'the carrier run starts running';
  perform public.request_agent_session_cancel(v_session.id);
  assert (select status from public.agent_sessions where id = v_session.id) = 'cancelled', 'session cancelled';
  assert (select status from public.jobs where id = v_session.job_id) = 'cancelled', 'job cancelled';
  assert (select status from public.runs where id = v_session.run_id) = 'cancelled', 'carrier run closed with the session';
  assert (select ended_at from public.runs where id = v_session.run_id) is not null, 'run end time recorded';
  assert (select status from public.tasks where id = v_session.task_id) = 'failed', 'task closed with the session';
  -- Idempotent: a second cancel changes nothing.
  perform public.request_agent_session_cancel(v_session.id);
  assert (select status from public.runs where id = v_session.run_id) = 'cancelled', 'second cancel is a no-op';
end;
$$;
