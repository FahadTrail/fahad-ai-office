-- Phase 2D workspace policy foundation. These tables are controller-only.
-- Secret values, prompts, responses, and repository content are never stored.
create table public.workspace_policies (
  workspace_id uuid primary key references public.projects(id) on delete cascade,
  enabled boolean not null default false,
  monthly_budget_usd numeric(16, 8) not null check (monthly_budget_usd > 0),
  max_request_budget_usd numeric(16, 8) not null check (
    max_request_budget_usd > 0 and max_request_budget_usd <= monthly_budget_usd
  ),
  spent_usd numeric(16, 8) not null default 0 check (spent_usd >= 0),
  reserved_usd numeric(16, 8) not null default 0 check (reserved_usd >= 0),
  budget_period_start timestamptz not null,
  budget_period_end timestamptz not null,
  version bigint not null default 1 check (version > 0),
  updated_at timestamptz not null default now(),
  check (budget_period_end > budget_period_start)
);

create table public.workspace_provider_permissions (
  workspace_id uuid not null references public.workspace_policies(workspace_id) on delete cascade,
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  models text[] not null check (cardinality(models) > 0),
  secret_ref text not null check (
    secret_ref ~ '^(env://[A-Z][A-Z0-9_]{2,127}|vault://[A-Za-z0-9][A-Za-z0-9_./:-]{2,255})$'
  ),
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, provider),
  check (not (models @> array['*']::text[]))
);

create table public.workspace_tool_grants (
  workspace_id uuid not null references public.workspace_policies(workspace_id) on delete cascade,
  broker text not null check (char_length(broker) between 1 and 80),
  tool_name text not null check (char_length(tool_name) between 1 and 160),
  action text not null default 'invoke' check (char_length(action) between 1 and 80),
  scopes text[] not null default '{}'::text[],
  risk text not null default 'low' check (risk in ('low', 'medium', 'high', 'critical')),
  decision text not null default 'deny' check (decision in ('auto', 'approval', 'deny')),
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, broker, tool_name, action)
);

create table public.workspace_budget_reservations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace_policies(workspace_id) on delete cascade,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 512),
  reserved_usd numeric(16, 8) not null check (reserved_usd > 0),
  actual_usd numeric(16, 8) check (actual_usd is null or actual_usd >= 0),
  status text not null default 'reserved' check (status in ('reserved', 'settled')),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (workspace_id, idempotency_key),
  check ((status = 'reserved' and settled_at is null and actual_usd is null) or
         (status = 'settled' and settled_at is not null and actual_usd is not null))
);

comment on column public.workspace_provider_permissions.secret_ref is
  'Opaque controller-side env:// or vault:// reference only. Never stores a credential value.';
comment on table public.workspace_tool_grants is
  'Future Tool Broker/MCP grants. Absence of an exact automatic grant means deny.';

create index workspace_budget_reservations_open_idx
  on public.workspace_budget_reservations (workspace_id, created_at)
  where status = 'reserved';
create index workspace_tool_grants_lookup_idx
  on public.workspace_tool_grants (workspace_id, broker, tool_name, action)
  where enabled;

alter table public.workspace_policies enable row level security;
alter table public.workspace_provider_permissions enable row level security;
alter table public.workspace_tool_grants enable row level security;
alter table public.workspace_budget_reservations enable row level security;

revoke all on table public.workspace_policies from public, anon, authenticated, service_role;
revoke all on table public.workspace_provider_permissions from public, anon, authenticated, service_role;
revoke all on table public.workspace_tool_grants from public, anon, authenticated, service_role;
revoke all on table public.workspace_budget_reservations from public, anon, authenticated, service_role;
grant select, insert, update on table public.workspace_policies to service_role;
grant select, insert, update on table public.workspace_provider_permissions to service_role;
grant select, insert, update on table public.workspace_tool_grants to service_role;
grant select, insert, update on table public.workspace_budget_reservations to service_role;

create function public.assert_workspace_execution_context(
  p_workspace uuid,
  p_job uuid,
  p_task uuid,
  p_run uuid
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_workspace is null or p_job is null or p_task is null or p_run is null then
    raise exception 'WORKSPACE_LINEAGE_REQUIRED' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.jobs j
    join public.tasks t on t.id = p_task and t.job_id = j.id
    join public.runs r on r.id = p_run and r.task_id = t.id and r.job_id = j.id
    where j.id = p_job and j.project_id = p_workspace
  ) then
    raise exception 'CROSS_WORKSPACE_ACCESS_DENIED' using errcode = '42501';
  end if;
end;
$$;

create function public.reserve_workspace_budget(
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

create function public.settle_workspace_budget(
  p_workspace uuid,
  p_reservation uuid,
  p_idempotency_key text,
  p_actual_usd numeric
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_reservation public.workspace_budget_reservations%rowtype;
begin
  if p_actual_usd is null or p_actual_usd < 0 then
    raise exception 'WORKSPACE_ACTUAL_COST_INVALID' using errcode = '22023';
  end if;
  select * into v_reservation
  from public.workspace_budget_reservations r
  where r.id = p_reservation and r.workspace_id = p_workspace and r.idempotency_key = p_idempotency_key
  for update;
  if not found then
    raise exception 'WORKSPACE_BUDGET_RESERVATION_MISSING' using errcode = '42501';
  end if;
  if v_reservation.status = 'settled' then
    return;
  end if;

  update public.workspace_policies
  set reserved_usd = greatest(0, reserved_usd - v_reservation.reserved_usd),
      spent_usd = spent_usd + p_actual_usd,
      updated_at = now()
  where workspace_id = p_workspace;
  update public.workspace_budget_reservations
  set actual_usd = p_actual_usd,
      status = 'settled',
      settled_at = now()
  where id = p_reservation;
end;
$$;

revoke execute on function public.assert_workspace_execution_context(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.reserve_workspace_budget(uuid, text, numeric)
  from public, anon, authenticated;
revoke execute on function public.settle_workspace_budget(uuid, uuid, text, numeric)
  from public, anon, authenticated;
grant execute on function public.assert_workspace_execution_context(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.reserve_workspace_budget(uuid, text, numeric) to service_role;
grant execute on function public.settle_workspace_budget(uuid, uuid, text, numeric) to service_role;

create function public.enforce_model_attempt_workspace()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.workspace_id is not null then
    perform public.assert_workspace_execution_context(new.workspace_id, new.job_id, new.task_id, new.run_id);
  end if;
  return new;
end;
$$;

revoke execute on function public.enforce_model_attempt_workspace() from public, anon, authenticated;
grant execute on function public.enforce_model_attempt_workspace() to service_role;
create trigger model_attempts_workspace_guard
before insert or update of workspace_id, job_id, task_id, run_id
on public.model_attempts
for each row execute function public.enforce_model_attempt_workspace();
