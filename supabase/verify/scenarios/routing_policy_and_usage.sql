-- Behavioral checks for workspace routing policies and model_usage_summary.
do $$
declare
  v_workspace uuid;
  v_other uuid;
  v_session public.agent_sessions%rowtype;
  v_row record;
  v_failed boolean := false;
begin
  insert into public.projects(name) values ('Routing') returning id into v_workspace;
  insert into public.workspace_policies (workspace_id, enabled, monthly_budget_usd, max_request_budget_usd, budget_period_start, budget_period_end)
    values (v_workspace, true, 10, 1, now() - interval '3 days', now() + interval '1 day');
  insert into public.projects(name) values ('Other') returning id into v_other;
  insert into public.workspace_policies (workspace_id, enabled, monthly_budget_usd, max_request_budget_usd, budget_period_start, budget_period_end)
    values (v_other, true, 10, 1, now() - interval '3 days', now() + interval '1 day');

  insert into public.workspace_routing_policies (workspace_id) values (v_workspace);
  assert (select strategy = 'economy' and billing_priority = array['free', 'included', 'promo', 'paid'] and allow_paid
    from public.workspace_routing_policies where workspace_id = v_workspace), 'free-first economy defaults';
  begin
    update public.workspace_routing_policies set billing_priority = array['paid', 'bogus'] where workspace_id = v_workspace;
    v_failed := false;
  exception when check_violation then v_failed := true; end;
  assert v_failed, 'unknown billing classes are rejected';

  select * into v_session from public.create_coding_session(v_workspace, 'Usage', 'Measure usage for the dashboard', 'FahadTrail/fahad-ai-office');
  insert into public.model_attempts (workspace_id, job_id, task_id, run_id, attempt_no, provider_attempt, provider, model, stage, status, idempotency_key, input_tokens, output_tokens, cost_usd, started_at, ended_at) values
    (v_workspace, v_session.job_id, v_session.task_id, v_session.run_id, 1, 1, 'deepseek', 'deepseek-flash', 'coding', 'succeeded', 'k1', 100, 10, 0.01, now() - interval '1 hour', now() - interval '1 hour'),
    (v_workspace, v_session.job_id, v_session.task_id, v_session.run_id, 2, 1, 'deepseek', 'deepseek-flash', 'coding', 'failed', 'k2', 0, 0, 0, now() - interval '30 minutes', now() - interval '30 minutes'),
    (v_workspace, v_session.job_id, v_session.task_id, v_session.run_id, 3, 1, 'deepseek', 'deepseek-flash', 'coding', 'succeeded', 'k3', 50, 5, 0.02, now() - interval '2 days', now() - interval '2 days'),
    (v_workspace, v_session.job_id, v_session.task_id, v_session.run_id, 4, 1, 'anthropic', 'claude-opus-5', 'coding', 'succeeded', 'k4', 10, 1, 0.5, now() - interval '5 days', now() - interval '5 days');

  select * into v_row from public.model_usage_summary(now() - interval '2 hours', v_workspace) where provider = 'deepseek';
  assert v_row.requests = 2 and v_row.failures = 1 and v_row.input_tokens = 100 and v_row.cost_usd = 0.01, 'explicit window';
  select * into v_row from public.model_usage_summary(null, v_workspace) where provider = 'deepseek';
  assert v_row.requests = 3 and v_row.cost_usd = 0.03, 'defaults to the workspace budget period';
  assert not exists (select 1 from public.model_usage_summary(null, v_workspace) where provider = 'anthropic'), 'spend before the period is excluded';
  assert not exists (select 1 from public.model_usage_summary(null, v_other)), 'other workspaces are isolated';
end;
$$;
set local role anon;
do $$ begin
  begin perform 1 from public.workspace_routing_policies; raise exception 'anon read routing policies'; exception when insufficient_privilege then null; end;
  begin perform 1 from public.model_usage_summary(null, null); raise exception 'anon ran usage summary'; exception when insufficient_privilege then null; end;
end $$;
reset role;
