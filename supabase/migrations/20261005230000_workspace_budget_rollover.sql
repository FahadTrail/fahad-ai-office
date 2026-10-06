-- V5.4 certification fix: monthly workspace budgets roll over.
--
-- A workspace budget is monthly (budget_period_start/end span one calendar
-- month), but nothing ever advanced the period. From the moment a period
-- ended, reserve_workspace_budget refused every paid reservation with
-- WORKSPACE_BUDGET_PERIOD_EXPIRED and the Hub kept showing last month's
-- spend. In production the Fahad AI Office period ended on 2026-10-01, so no
-- paid route (including the Coding Agent's privacy-approved models) could run
-- in October.
--
-- roll_workspace_budget_period moves an ended period to the current calendar
-- month (UTC) and starts its spend at zero. In-flight reservations are kept
-- (reserved_usd is unchanged), so they settle normally. A period that has not
-- ended is left alone, so calling it is always safe and idempotent.
-- Service role only; no table or data changes by itself.

create or replace function public.roll_workspace_budget_period(p_workspace uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rolled integer;
begin
  update public.workspace_policies as wp
     set budget_period_start = date_trunc('month', now()),
         budget_period_end = date_trunc('month', now()) + interval '1 month',
         spent_usd = 0,
         version = wp.version + 1,
         updated_at = now()
   where wp.workspace_id = p_workspace
     and wp.enabled
     and now() >= wp.budget_period_end;
  get diagnostics v_rolled = row_count;
  return v_rolled > 0;
end;
$$;

revoke all on function public.roll_workspace_budget_period(uuid) from public, anon, authenticated;
grant execute on function public.roll_workspace_budget_period(uuid) to service_role;
