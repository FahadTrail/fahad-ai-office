-- Behavioral checks for the monthly workspace budget rollover. Runs inside a
-- rolled-back transaction against a local replay; never production.
do $$
declare
  v_workspace uuid;
  v_fresh uuid;
  v_failed boolean;
  v_policy public.workspace_policies%rowtype;
  v_reservation record;
begin
  insert into public.projects(name) values ('Rollover scenario') returning id into v_workspace;
  insert into public.workspace_policies (workspace_id, enabled, monthly_budget_usd, max_request_budget_usd, spent_usd, reserved_usd, budget_period_start, budget_period_end)
    values (v_workspace, true, 2, 0.1, 1.9, 0.05, date_trunc('month', now()) - interval '1 month', date_trunc('month', now()));

  -- The bug: an ended period refuses every paid reservation.
  v_failed := false;
  begin perform public.reserve_workspace_budget(v_workspace, 'rollover-scenario-1', 0.01); exception when others then v_failed := sqlerrm = 'WORKSPACE_BUDGET_PERIOD_EXPIRED'; end;
  assert v_failed, 'an ended period refuses reservations until it rolls over';

  assert public.roll_workspace_budget_period(v_workspace), 'an ended period rolls over';
  select * into v_policy from public.workspace_policies where workspace_id = v_workspace;
  assert v_policy.budget_period_start = date_trunc('month', now()), 'the new period starts this month';
  assert v_policy.budget_period_end = date_trunc('month', now()) + interval '1 month', 'and ends next month';
  assert v_policy.spent_usd = 0, 'spend starts at zero';
  assert v_policy.reserved_usd = 0.05, 'in-flight reservations are kept so they settle normally';
  assert not public.roll_workspace_budget_period(v_workspace), 'rolling again is a no-op';

  select * into v_reservation from public.reserve_workspace_budget(v_workspace, 'rollover-scenario-2', 0.01);
  assert v_reservation.reserved_usd = 0.01, 'paid reservations work again in the new period';

  -- A period that has not ended is never touched.
  insert into public.projects(name) values ('Current scenario') returning id into v_fresh;
  insert into public.workspace_policies (workspace_id, enabled, monthly_budget_usd, max_request_budget_usd, spent_usd, budget_period_start, budget_period_end)
    values (v_fresh, true, 2, 0.1, 0.7, date_trunc('month', now()), date_trunc('month', now()) + interval '1 month');
  assert not public.roll_workspace_budget_period(v_fresh), 'a current period is left alone';
  assert (select spent_usd from public.workspace_policies where workspace_id = v_fresh) = 0.7, 'its spend is unchanged';
end $$;
