-- Phase 2E Tool Broker + MCP foundation. This migration is intentionally
-- service-role only and stores metadata/hashes, never arguments, results,
-- prompts, repository content, or credential values.
alter table public.workspace_tool_grants
  add column secret_ref text;

alter table public.workspace_tool_grants
  add constraint workspace_tool_grants_secret_ref_format
  check (
    secret_ref is null or
    secret_ref ~ '^(env://[A-Z][A-Z0-9_]{2,127}|vault://[A-Za-z0-9][A-Za-z0-9_./:-]{2,255})$'
  );

comment on column public.workspace_tool_grants.secret_ref is
  'Optional opaque controller-side env:// or vault:// reference. Never stores a credential value.';

create table public.tool_executions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace_policies(workspace_id) on delete restrict,
  job_id uuid not null references public.jobs(id) on delete restrict,
  task_id uuid not null references public.tasks(id) on delete restrict,
  run_id uuid not null references public.runs(id) on delete restrict,
  agent_id uuid not null references public.agents(id) on delete restrict,
  broker text not null check (broker ~ '^[A-Za-z0-9_.-]{1,80}$'),
  tool_name text not null check (tool_name ~ '^[A-Za-z0-9_.-]{1,128}$'),
  action text not null check (action ~ '^[A-Za-z0-9_.-]{1,80}$'),
  scopes text[] not null default '{}'::text[],
  risk text not null check (risk in ('low', 'medium', 'high', 'critical')),
  decision text not null check (decision in ('auto', 'approval', 'deny')),
  secret_ref text check (
    secret_ref is null or
    secret_ref ~ '^(env://[A-Z][A-Z0-9_]{2,127}|vault://[A-Za-z0-9][A-Za-z0-9_./:-]{2,255})$'
  ),
  server_name text not null check (server_name ~ '^[A-Za-z0-9_.-]{1,80}$'),
  protocol_version text not null check (char_length(protocol_version) between 1 and 32),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 512),
  status text not null check (status in ('running', 'succeeded', 'failed', 'approval_required', 'denied')),
  retry_safe boolean not null default false,
  max_retries smallint not null default 0 check (max_retries between 0 and 3),
  attempt_count smallint not null default 0 check (attempt_count between 0 and 4),
  retry_count smallint not null default 0 check (retry_count between 0 and 3),
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  cost_usd numeric(16, 8) not null default 0 check (cost_usd >= 0 and cost_usd <= 0.1),
  result_sha256 text check (result_sha256 is null or result_sha256 ~ '^[a-f0-9]{64}$'),
  output_bytes integer check (output_bytes is null or output_bytes >= 0),
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{2,80}$'),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  check (
    (status = 'running' and decision = 'auto' and ended_at is null) or
    (status in ('succeeded', 'failed') and decision = 'auto' and ended_at is not null) or
    (status = 'approval_required' and decision = 'approval' and ended_at is not null) or
    (status = 'denied' and decision = 'deny' and ended_at is not null)
  )
);

comment on table public.tool_executions is
  'Service-only Tool Broker authorization and execution metadata. Arguments, results, prompts, and secret values are prohibited.';

create index tool_executions_workspace_started_idx
  on public.tool_executions (workspace_id, started_at desc);
create index tool_executions_job_idx
  on public.tool_executions (job_id, started_at desc);
create index tool_executions_task_run_idx
  on public.tool_executions (task_id, run_id);
create index tool_executions_agent_idx
  on public.tool_executions (agent_id, started_at desc);
create index tool_executions_open_idx
  on public.tool_executions (status, started_at)
  where status = 'running';

alter table public.tool_executions enable row level security;
revoke all on table public.tool_executions from public, anon, authenticated, service_role;
grant select, insert, update on table public.tool_executions to service_role;

create function public.enforce_tool_execution_workspace()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform public.assert_workspace_execution_context(
    new.workspace_id, new.job_id, new.task_id, new.run_id
  );
  if not exists (
    select 1
    from public.runs r
    where r.id = new.run_id
      and r.task_id = new.task_id
      and r.job_id = new.job_id
      and r.agent_id = new.agent_id
  ) then
    raise exception 'TOOL_AGENT_LINEAGE_DENIED' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.enforce_tool_execution_workspace()
  from public, anon, authenticated, service_role;
grant execute on function public.enforce_tool_execution_workspace() to service_role;

create trigger tool_executions_workspace_guard
before insert or update of workspace_id, job_id, task_id, run_id, agent_id
on public.tool_executions
for each row execute function public.enforce_tool_execution_workspace();

create function public.begin_tool_execution(
  p_workspace uuid,
  p_job uuid,
  p_task uuid,
  p_run uuid,
  p_agent uuid,
  p_broker text,
  p_tool text,
  p_action text,
  p_scopes text[],
  p_risk text,
  p_decision text,
  p_secret_ref text,
  p_idempotency_key text,
  p_protocol text,
  p_server_name text,
  p_retry_safe boolean,
  p_max_retries integer,
  p_error_code text default null
) returns table (
  execution_id uuid,
  status text,
  disposition text,
  attempt_count integer,
  retry_count integer,
  result_sha256 text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_execution public.tool_executions%rowtype;
  v_status text;
  v_inserted_count integer := 0;
begin
  perform public.assert_workspace_execution_context(p_workspace, p_job, p_task, p_run);
  if p_decision not in ('auto', 'approval', 'deny') then
    raise exception 'TOOL_DECISION_INVALID' using errcode = '22023';
  end if;
  v_status := case p_decision
    when 'auto' then 'running'
    when 'approval' then 'approval_required'
    else 'denied'
  end;

  insert into public.tool_executions (
    workspace_id, job_id, task_id, run_id, agent_id,
    broker, tool_name, action, scopes, risk, decision, secret_ref,
    server_name, protocol_version, idempotency_key, status,
    retry_safe, max_retries, attempt_count, retry_count, error_code, ended_at
  ) values (
    p_workspace, p_job, p_task, p_run, p_agent,
    p_broker, p_tool, p_action, coalesce(p_scopes, '{}'::text[]), p_risk, p_decision, p_secret_ref,
    p_server_name, p_protocol, p_idempotency_key, v_status,
    coalesce(p_retry_safe, false), coalesce(p_max_retries, 0),
    case when p_decision = 'auto' then 1 else 0 end, 0, p_error_code,
    case when p_decision = 'auto' then null else now() end
  ) on conflict (workspace_id, idempotency_key) do nothing;
  get diagnostics v_inserted_count = row_count;

  select * into v_execution
  from public.tool_executions e
  where e.workspace_id = p_workspace and e.idempotency_key = p_idempotency_key
  for update;

  if v_execution.broker <> p_broker or v_execution.tool_name <> p_tool or
     v_execution.action <> p_action or v_execution.agent_id <> p_agent then
    raise exception 'TOOL_IDEMPOTENCY_CONFLICT' using errcode = '23505';
  end if;

  if v_execution.status = 'succeeded' then
    return query select v_execution.id, v_execution.status, 'replay'::text,
      v_execution.attempt_count::integer, v_execution.retry_count::integer, v_execution.result_sha256;
    return;
  end if;
  if v_execution.status = 'running' then
    return query select v_execution.id, v_execution.status,
      case when v_inserted_count > 0 then 'execute'::text else 'in_progress'::text end,
      v_execution.attempt_count::integer, v_execution.retry_count::integer, v_execution.result_sha256;
    return;
  end if;
  if v_execution.status = 'failed' and v_execution.retry_safe and
     v_execution.retry_count < v_execution.max_retries then
    update public.tool_executions e
    set status = 'running',
        started_at = now(),
        ended_at = null,
        duration_ms = null,
        error_code = null,
        attempt_count = e.attempt_count + 1,
        retry_count = e.retry_count + 1
    where e.id = v_execution.id
    returning * into v_execution;
    return query select v_execution.id, v_execution.status, 'execute'::text,
      v_execution.attempt_count::integer, v_execution.retry_count::integer, v_execution.result_sha256;
    return;
  end if;
  return query select v_execution.id, v_execution.status, 'blocked'::text,
    v_execution.attempt_count::integer, v_execution.retry_count::integer, v_execution.result_sha256;
end;
$$;

create function public.finish_tool_execution(
  p_execution uuid,
  p_status text,
  p_duration_ms integer,
  p_cost_usd numeric,
  p_result_sha256 text,
  p_output_bytes integer,
  p_attempt_count integer,
  p_retry_count integer,
  p_error_code text default null
) returns table (status text, ended_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_execution public.tool_executions%rowtype;
begin
  if p_status not in ('succeeded', 'failed') then
    raise exception 'TOOL_EXECUTION_STATUS_INVALID' using errcode = '22023';
  end if;
  select * into v_execution
  from public.tool_executions e
  where e.id = p_execution
  for update;
  if not found then
    raise exception 'TOOL_EXECUTION_MISSING' using errcode = '42501';
  end if;
  if v_execution.status in ('succeeded', 'failed') then
    return query select v_execution.status, v_execution.ended_at;
    return;
  end if;
  if v_execution.status <> 'running' or v_execution.decision <> 'auto' then
    raise exception 'TOOL_EXECUTION_NOT_SETTLEABLE' using errcode = '42501';
  end if;

  update public.tool_executions e
  set status = p_status,
      ended_at = now(),
      duration_ms = greatest(0, coalesce(p_duration_ms, 0)),
      cost_usd = greatest(0, coalesce(p_cost_usd, 0)),
      result_sha256 = case when p_status = 'succeeded' then p_result_sha256 else null end,
      output_bytes = greatest(0, coalesce(p_output_bytes, 0)),
      attempt_count = p_attempt_count,
      retry_count = p_retry_count,
      error_code = case when p_status = 'failed' then coalesce(p_error_code, 'TOOL_EXECUTION_FAILED') else null end
  where e.id = p_execution
  returning * into v_execution;
  return query select v_execution.status, v_execution.ended_at;
end;
$$;

revoke execute on function public.begin_tool_execution(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text[], text, text,
  text, text, text, text, boolean, integer, text
) from public, anon, authenticated, service_role;
revoke execute on function public.finish_tool_execution(
  uuid, text, integer, numeric, text, integer, integer, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.begin_tool_execution(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text[], text, text,
  text, text, text, text, boolean, integer, text
) to service_role;
grant execute on function public.finish_tool_execution(
  uuid, text, integer, numeric, text, integer, integer, integer, text
) to service_role;
