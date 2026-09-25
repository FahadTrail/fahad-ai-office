-- Correct the reserve RPC installed by the initial Phase 2D migration.
-- The RETURNS TABLE output column reserved_usd must not shadow the policy column.
create or replace function public.reserve_workspace_budget(
  p_workspace uuid,
  p_idempotency_key text,
  p_requested_usd numeric
) returns table (reservation_id uuid, reserved_usd numeric)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_policy public.workspace_policies%rowtype;
  v_existing public.workspace_budget_reservations%rowtype;
  v_reservation_id uuid;
begin
  if p_requested_usd is null or p_requested_usd <= 0 then
    raise exception 'WORKSPACE_BUDGET_REQUEST_INVALID' using errcode = '22023';
  end if;
  select * into v_policy
  from public.workspace_policies p
  where p.workspace_id = p_workspace
  for update;
  if not found or not v_policy.enabled then
    raise exception 'WORKSPACE_POLICY_DISABLED' using errcode = '42501';
  end if;
  select * into v_existing
  from public.workspace_budget_reservations r
  where r.workspace_id = p_workspace and r.idempotency_key = p_idempotency_key
  for update;
  if found then
    if v_existing.status <> 'reserved' then
      raise exception 'WORKSPACE_IDEMPOTENCY_ALREADY_SETTLED' using errcode = '23505';
    end if;
    return query select v_existing.id, v_existing.reserved_usd;
    return;
  end if;

  if now() < v_policy.budget_period_start or now() >= v_policy.budget_period_end then
    raise exception 'WORKSPACE_BUDGET_PERIOD_EXPIRED' using errcode = '22023';
  end if;
  if p_requested_usd > v_policy.max_request_budget_usd or
     v_policy.spent_usd + v_policy.reserved_usd + p_requested_usd > v_policy.monthly_budget_usd then
    raise exception 'WORKSPACE_BUDGET_EXHAUSTED' using errcode = '42501';
  end if;

  insert into public.workspace_budget_reservations (
    workspace_id, idempotency_key, reserved_usd
  ) values (
    p_workspace, p_idempotency_key, p_requested_usd
  ) returning id into v_reservation_id;
  update public.workspace_policies as p
  set reserved_usd = p.reserved_usd + p_requested_usd,
      updated_at = now()
  where p.workspace_id = p_workspace;
  return query select v_reservation_id, p_requested_usd;
end;
$$;

revoke execute on function public.reserve_workspace_budget(uuid, text, numeric)
  from public, anon, authenticated;
grant execute on function public.reserve_workspace_budget(uuid, text, numeric) to service_role;

