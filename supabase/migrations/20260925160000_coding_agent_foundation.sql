-- Coding Agent + unified continuity foundation.
--
-- One durable state model replaces the separate continuity POC and the
-- development escape route: an agent session owns a provider-neutral
-- transcript, plan, state and checkpoints, and shares the Office's
-- job/task/run lineage so model attempts, Tool Broker audit and workspace
-- budgets apply unchanged. Every object is service-role only.
--
-- Credentials are never stored here. Transcripts can contain repository
-- content and tool output (redacted before persistence) because a different
-- model must be able to continue the same task.

-- ---------------------------------------------------------------- agent row
insert into public.agents
  (slug, name, name_ar, role, tagline, model_tier, allowed_tools, sort_order, accent_color, system_prompt)
values (
  'coding-agent', 'Coding Agent', 'وكيل البرمجة', 'engineer',
  'Understand · Build · Test · Ship', 'deep',
  array[
    'repo.list', 'repo.read', 'repo.search', 'repo.write', 'repo.edit',
    'shell.run', 'git.status', 'git.diff', 'git.commit', 'git.push',
    'github.pr_create', 'github.pr_status', 'github.ci_status', 'github.ci_logs', 'github.pr_merge',
    'deploy.status', 'verify.http',
    'supabase.query_read', 'supabase.query_write', 'supabase.migration_apply'
  ]::text[],
  70, '#0EA5E9',
  'You are the Fahad AI Office Coding Agent. The controller supplies the task-specific instructions.'
)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------- sessions
create table public.agent_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace_policies(workspace_id) on delete restrict,
  job_id uuid not null unique references public.jobs(id) on delete restrict,
  task_id uuid not null unique references public.tasks(id) on delete restrict,
  run_id uuid not null unique references public.runs(id) on delete restrict,
  agent_id uuid not null references public.agents(id) on delete restrict,
  kind text not null default 'coding' check (kind in ('coding')),
  title text not null check (char_length(title) between 1 and 200),
  objective text not null check (char_length(objective) between 12 and 40000),
  repository text not null check (repository ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
  base_branch text not null default 'main' check (base_branch ~ '^[A-Za-z0-9._/-]{1,200}$'),
  work_branch text check (work_branch is null or work_branch ~ '^[A-Za-z0-9._/-]{1,200}$'),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'awaiting_approval', 'blocked', 'completed', 'failed', 'cancelled')),
  phase text not null default 'understand'
    check (phase in ('understand', 'plan', 'implement', 'test', 'debug', 'review', 'publish', 'ci', 'deploy', 'verify', 'report', 'done')),
  plan jsonb not null default '[]'::jsonb check (jsonb_typeof(plan) = 'array'),
  state jsonb not null default '{}'::jsonb check (jsonb_typeof(state) = 'object'),
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  next_action text check (next_action is null or char_length(next_action) <= 4000),
  current_route text check (current_route is null or char_length(current_route) <= 200),
  previous_route text check (previous_route is null or char_length(previous_route) <= 200),
  provider_switches integer not null default 0 check (provider_switches >= 0),
  iteration integer not null default 0 check (iteration >= 0),
  budget_usd numeric(12, 4) not null default 5 check (budget_usd > 0 and budget_usd <= 500),
  spent_usd numeric(16, 8) not null default 0 check (spent_usd >= 0),
  tokens_in bigint not null default 0 check (tokens_in >= 0),
  tokens_out bigint not null default 0 check (tokens_out >= 0),
  result jsonb check (result is null or jsonb_typeof(result) = 'object'),
  blocker text check (blocker is null or char_length(blocker) <= 4000),
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{2,80}$'),
  cancel_requested boolean not null default false,
  lease_owner text check (lease_owner is null or char_length(lease_owner) <= 200),
  lease_token uuid,
  lease_expires_at timestamptz,
  checkpoint_seq integer not null default 0 check (checkpoint_seq >= 0),
  created_by text check (created_by is null or char_length(created_by) <= 320),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

comment on table public.agent_sessions is
  'Durable Coding Agent sessions. Provider-neutral state that any eligible model can resume. No credentials.';

create index agent_sessions_queue_idx on public.agent_sessions (status, created_at)
  where status in ('queued', 'running');
create index agent_sessions_workspace_idx on public.agent_sessions (workspace_id, created_at desc);

create table public.agent_checkpoints (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.agent_sessions(id) on delete cascade,
  sequence integer not null check (sequence > 0),
  reason text not null check (reason in ('turn', 'provider_switch', 'approval', 'phase', 'compaction', 'resume', 'final', 'blocked')),
  route text check (route is null or char_length(route) <= 200),
  phase text not null,
  plan jsonb not null default '[]'::jsonb,
  state jsonb not null default '{}'::jsonb,
  transcript jsonb check (transcript is null or jsonb_typeof(transcript) = 'object'),
  git_head text check (git_head is null or git_head ~ '^[0-9a-f]{40}$'),
  created_at timestamptz not null default now(),
  unique (session_id, sequence)
);

create table public.agent_events (
  id bigserial primary key,
  session_id uuid not null references public.agent_sessions(id) on delete cascade,
  type text not null check (type in (
    'session', 'phase', 'plan', 'model_turn', 'provider_switch', 'checkpoint', 'tool_call', 'tool_result',
    'test', 'git', 'github', 'ci', 'deploy', 'verify', 'supabase', 'approval', 'guard', 'error', 'report', 'note'
  )),
  level text not null default 'info' check (level in ('info', 'success', 'warning', 'error')),
  message text not null check (char_length(message) <= 2000),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now()
);

create index agent_events_session_idx on public.agent_events (session_id, id);

create table public.agent_approvals (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.agent_sessions(id) on delete cascade,
  workspace_id uuid not null references public.workspace_policies(workspace_id) on delete restrict,
  call_id text not null check (char_length(call_id) between 1 and 200),
  broker text not null check (char_length(broker) between 1 and 80),
  tool_name text not null check (char_length(tool_name) between 1 and 128),
  action text not null check (char_length(action) between 1 and 80),
  risk text not null check (risk in ('low', 'medium', 'high', 'critical')),
  summary text not null check (char_length(summary) between 1 and 2000),
  arguments_sha256 text not null check (arguments_sha256 ~ '^[a-f0-9]{64}$'),
  arguments_preview jsonb not null default '{}'::jsonb check (jsonb_typeof(arguments_preview) = 'object'),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'consumed', 'expired')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text check (decided_by is null or char_length(decided_by) <= 320),
  note text check (note is null or char_length(note) <= 2000),
  consumed_at timestamptz,
  unique (session_id, call_id)
);

create index agent_approvals_pending_idx on public.agent_approvals (status, requested_at) where status = 'pending';

-- ---------------------------------------------------------------- provider status
create table public.provider_status (
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  model text not null check (char_length(model) between 1 and 200),
  billing_class text not null default 'paid' check (billing_class in ('included', 'free', 'promo', 'paid')),
  health text not null default 'unknown'
    check (health in ('healthy', 'degraded', 'rate_limited', 'quota_exhausted', 'unavailable', 'auth_error', 'unknown')),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  cooldown_until timestamptz,
  rate_limit jsonb check (rate_limit is null or jsonb_typeof(rate_limit) = 'object'),
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{2,80}$'),
  requests_total bigint not null default 0,
  failures_total bigint not null default 0,
  input_tokens_total bigint not null default 0,
  output_tokens_total bigint not null default 0,
  cost_usd_total numeric(16, 8) not null default 0,
  verified_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (provider, model)
);

comment on table public.provider_status is
  'Observed provider/model health, rate-limit headers and usage. Quota values are provider-reported only; nothing is estimated.';

-- ---------------------------------------------------------------- privileges
do $$
declare
  v_table text;
begin
  foreach v_table in array array['agent_sessions', 'agent_checkpoints', 'agent_events', 'agent_approvals', 'provider_status'] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', v_table);
    execute format('grant select, insert, update on table public.%I to service_role', v_table);
  end loop;
end;
$$;
grant usage, select on sequence public.agent_events_id_seq to service_role;
revoke all on sequence public.agent_events_id_seq from public, anon, authenticated;

-- ---------------------------------------------------------------- functions
create function public.create_coding_session(
  p_workspace uuid,
  p_title text,
  p_objective text,
  p_repository text,
  p_base_branch text default 'main',
  p_budget_usd numeric default 5,
  p_config jsonb default '{}'::jsonb,
  p_created_by text default null
) returns setof public.agent_sessions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_agent public.agents%rowtype;
  v_job uuid;
  v_task uuid;
  v_run uuid;
  v_session public.agent_sessions%rowtype;
begin
  if not exists (select 1 from public.workspace_policies p where p.workspace_id = p_workspace and p.enabled) then
    raise exception 'WORKSPACE_DISABLED' using errcode = '42501';
  end if;
  select * into v_agent from public.agents a where a.slug = 'coding-agent' and a.is_active;
  if not found then
    raise exception 'CODING_AGENT_UNAVAILABLE' using errcode = '42501';
  end if;
  insert into public.jobs (project_id, title, goal, status, started_at)
    values (p_workspace, left(btrim(p_title), 120), p_objective, 'running', now())
    returning id into v_job;
  insert into public.tasks (job_id, agent_id, title, brief, status, sequence, max_attempts, started_at)
    values (v_job, v_agent.id, 'Coding Agent session',
      jsonb_build_object('workflow', 'coding-agent', 'workflow_version', 1)::text, 'assigned', 10, 1, now())
    returning id into v_task;
  insert into public.runs (task_id, job_id, agent_id, attempt_no, status)
    values (v_task, v_job, v_agent.id, 1, 'running')
    returning id into v_run;
  insert into public.agent_sessions (
    workspace_id, job_id, task_id, run_id, agent_id, title, objective, repository, base_branch, budget_usd, config, created_by
  ) values (
    p_workspace, v_job, v_task, v_run, v_agent.id, left(btrim(p_title), 200), p_objective, p_repository,
    coalesce(nullif(btrim(p_base_branch), ''), 'main'), coalesce(p_budget_usd, 5), coalesce(p_config, '{}'::jsonb), p_created_by
  ) returning * into v_session;
  insert into public.events (job_id, task_id, run_id, agent_id, type, message, payload)
    values (v_job, v_task, v_run, v_agent.id, 'job_created', 'Coding Agent session queued.',
      jsonb_build_object('session_id', v_session.id, 'workflow', 'coding-agent'));
  return next v_session;
end;
$$;

create function public.claim_agent_session(p_worker text, p_lease_seconds integer default 300)
returns setof public.agent_sessions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_session public.agent_sessions%rowtype;
begin
  if p_lease_seconds not between 30 and 3600 then
    raise exception 'AGENT_LEASE_INVALID' using errcode = '22023';
  end if;
  select * into v_session
  from public.agent_sessions s
  where (s.status = 'queued' or (s.status = 'running' and s.lease_expires_at < now()))
    and not s.cancel_requested
  order by s.created_at
  for update skip locked
  limit 1;
  if not found then
    return;
  end if;
  update public.agent_sessions s
  set status = 'running',
      lease_owner = left(p_worker, 200),
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      started_at = coalesce(s.started_at, now()),
      blocker = null,
      updated_at = now()
  where s.id = v_session.id
  returning * into v_session;
  update public.jobs j set status = 'running' where j.id = v_session.job_id and j.status <> 'running';
  return next v_session;
end;
$$;

create function public.renew_agent_session_lease(p_session uuid, p_token uuid, p_lease_seconds integer default 300)
returns table (ok boolean, cancel_requested boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_cancel boolean;
begin
  update public.agent_sessions s
  set lease_expires_at = now() + make_interval(secs => least(greatest(p_lease_seconds, 30), 3600)),
      updated_at = now()
  where s.id = p_session and s.lease_token = p_token and s.status = 'running'
  returning s.cancel_requested into v_cancel;
  if not found then
    return query select false, false;
    return;
  end if;
  return query select true, v_cancel;
end;
$$;

-- Atomically applies a state patch and records a checkpoint. Only the current
-- lease holder can write, so a stale worker can never overwrite newer state.
create function public.save_agent_checkpoint(
  p_session uuid,
  p_token uuid,
  p_reason text,
  p_patch jsonb,
  p_transcript jsonb default null,
  p_git_head text default null
) returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_session public.agent_sessions%rowtype;
  v_sequence integer;
begin
  select * into v_session from public.agent_sessions s where s.id = p_session for update;
  if not found or v_session.lease_token is distinct from p_token or v_session.status <> 'running' then
    raise exception 'AGENT_LEASE_LOST' using errcode = '42501';
  end if;
  update public.agent_sessions s
  set phase = coalesce(p_patch->>'phase', s.phase),
      plan = coalesce(p_patch->'plan', s.plan),
      state = coalesce(p_patch->'state', s.state),
      next_action = case when p_patch ? 'next_action' then p_patch->>'next_action' else s.next_action end,
      current_route = coalesce(p_patch->>'current_route', s.current_route),
      previous_route = coalesce(p_patch->>'previous_route', s.previous_route),
      provider_switches = coalesce((p_patch->>'provider_switches')::integer, s.provider_switches),
      iteration = coalesce((p_patch->>'iteration')::integer, s.iteration),
      spent_usd = coalesce((p_patch->>'spent_usd')::numeric, s.spent_usd),
      tokens_in = coalesce((p_patch->>'tokens_in')::bigint, s.tokens_in),
      tokens_out = coalesce((p_patch->>'tokens_out')::bigint, s.tokens_out),
      work_branch = coalesce(p_patch->>'work_branch', s.work_branch),
      checkpoint_seq = s.checkpoint_seq + 1,
      lease_expires_at = greatest(s.lease_expires_at, now() + interval '5 minutes'),
      updated_at = now()
  where s.id = p_session
  returning s.checkpoint_seq into v_sequence;
  insert into public.agent_checkpoints (session_id, sequence, reason, route, phase, plan, state, transcript, git_head)
  select s.id, v_sequence, p_reason, s.current_route, s.phase, s.plan, s.state, p_transcript, p_git_head
  from public.agent_sessions s where s.id = p_session;
  -- Keep full transcripts only for the most recent checkpoints.
  update public.agent_checkpoints c set transcript = null
  where c.session_id = p_session and c.sequence <= v_sequence - 5 and c.transcript is not null;
  return v_sequence;
end;
$$;

create function public.finish_agent_session(
  p_session uuid,
  p_token uuid,
  p_status text,
  p_result jsonb default null,
  p_blocker text default null,
  p_error_code text default null
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_session public.agent_sessions%rowtype;
  v_summary text;
begin
  if p_status not in ('completed', 'failed', 'blocked', 'awaiting_approval', 'cancelled') then
    raise exception 'AGENT_STATUS_INVALID' using errcode = '22023';
  end if;
  select * into v_session from public.agent_sessions s where s.id = p_session for update;
  if not found or v_session.lease_token is distinct from p_token then
    raise exception 'AGENT_LEASE_LOST' using errcode = '42501';
  end if;
  update public.agent_sessions s
  set status = p_status,
      result = coalesce(p_result, s.result),
      blocker = p_blocker,
      error_code = p_error_code,
      lease_owner = null,
      lease_token = null,
      lease_expires_at = null,
      completed_at = case when p_status in ('completed', 'failed', 'cancelled') then now() else null end,
      updated_at = now()
  where s.id = p_session;
  v_summary := left(coalesce(p_result->>'summary', p_blocker, p_status), 4000);
  if p_status = 'completed' then
    update public.runs r set status = 'succeeded', ended_at = now(), cost_usd = least(v_session.spent_usd, 999999),
      tokens_in = least(v_session.tokens_in, 2147483647), tokens_out = least(v_session.tokens_out, 2147483647)
      where r.id = v_session.run_id;
    update public.tasks t set status = 'done', progress = 100, completed_at = now() where t.id = v_session.task_id;
    insert into public.results (job_id, task_id, agent_id, kind, summary, content, format)
      values (v_session.job_id, v_session.task_id, v_session.agent_id, 'final', left(v_summary, 300),
        coalesce(p_result->>'report', v_summary), 'markdown');
    update public.jobs j set status = 'completed', progress = 100, completed_at = now(), final_summary = v_summary,
      cost_usd = least(v_session.spent_usd, 999999), tokens_used = least(v_session.tokens_in + v_session.tokens_out, 2147483647)
      where j.id = v_session.job_id;
  elsif p_status in ('failed', 'cancelled') then
    update public.runs r set status = case when p_status = 'failed' then 'failed' else 'cancelled' end, ended_at = now(),
      error_message = left(coalesce(p_blocker, p_error_code, p_status), 2000), cost_usd = least(v_session.spent_usd, 999999)
      where r.id = v_session.run_id;
    update public.tasks t set status = 'failed', completed_at = now() where t.id = v_session.task_id;
    update public.jobs j set status = p_status, completed_at = now(), final_summary = v_summary,
      cost_usd = least(v_session.spent_usd, 999999) where j.id = v_session.job_id;
  else
    update public.jobs j set status = case when p_status = 'awaiting_approval' then 'waiting_approval' else 'blocked' end,
      cost_usd = least(v_session.spent_usd, 999999) where j.id = v_session.job_id;
  end if;
end;
$$;

create function public.request_agent_approval(
  p_session uuid,
  p_token uuid,
  p_call_id text,
  p_broker text,
  p_tool text,
  p_action text,
  p_risk text,
  p_summary text,
  p_arguments_sha256 text,
  p_arguments_preview jsonb
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_session public.agent_sessions%rowtype;
  v_id uuid;
begin
  select * into v_session from public.agent_sessions s where s.id = p_session;
  if not found or v_session.lease_token is distinct from p_token then
    raise exception 'AGENT_LEASE_LOST' using errcode = '42501';
  end if;
  insert into public.agent_approvals (
    session_id, workspace_id, call_id, broker, tool_name, action, risk, summary, arguments_sha256, arguments_preview
  ) values (
    p_session, v_session.workspace_id, p_call_id, p_broker, p_tool, p_action, p_risk, left(p_summary, 2000),
    p_arguments_sha256, coalesce(p_arguments_preview, '{}'::jsonb)
  ) on conflict (session_id, call_id) do nothing;
  select a.id into v_id from public.agent_approvals a where a.session_id = p_session and a.call_id = p_call_id;
  return v_id;
end;
$$;

-- Owner decision from the Hub. Approving the last pending request re-queues
-- the session so a worker resumes it from its latest checkpoint.
create function public.decide_agent_approval(p_approval uuid, p_decision text, p_decided_by text, p_note text default null)
returns public.agent_approvals
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_approval public.agent_approvals%rowtype;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'AGENT_APPROVAL_DECISION_INVALID' using errcode = '22023';
  end if;
  update public.agent_approvals a
  set status = p_decision, decided_at = now(), decided_by = left(p_decided_by, 320), note = left(p_note, 2000)
  where a.id = p_approval and a.status = 'pending'
  returning * into v_approval;
  if not found then
    raise exception 'AGENT_APPROVAL_NOT_PENDING' using errcode = '42501';
  end if;
  if not exists (select 1 from public.agent_approvals a where a.session_id = v_approval.session_id and a.status = 'pending') then
    update public.agent_sessions s set status = 'queued', blocker = null, updated_at = now()
      where s.id = v_approval.session_id and s.status = 'awaiting_approval';
    update public.jobs j set status = 'running'
      from public.agent_sessions s where s.id = v_approval.session_id and j.id = s.job_id and j.status = 'waiting_approval';
  end if;
  insert into public.agent_events (session_id, type, level, message, payload)
    values (v_approval.session_id, 'approval', case when p_decision = 'approved' then 'success' else 'warning' end,
      format('%s %s', v_approval.tool_name, p_decision),
      jsonb_build_object('approval_id', v_approval.id, 'tool', v_approval.tool_name, 'decision', p_decision));
  return v_approval;
end;
$$;

-- Consumes an approved request exactly once for the exact arguments that
-- were shown to the approver.
create function public.consume_agent_approval(p_approval uuid, p_session uuid, p_call_id text, p_arguments_sha256 text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.agent_approvals a
  set status = 'consumed', consumed_at = now()
  where a.id = p_approval and a.session_id = p_session and a.call_id = p_call_id
    and a.arguments_sha256 = p_arguments_sha256 and a.status = 'approved';
  return found;
end;
$$;

create function public.request_agent_session_cancel(p_session uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.agent_sessions s
  set cancel_requested = true,
      status = case when s.status in ('queued', 'awaiting_approval', 'blocked') then 'cancelled' else s.status end,
      completed_at = case when s.status in ('queued', 'awaiting_approval', 'blocked') then now() else s.completed_at end,
      updated_at = now()
  where s.id = p_session and s.status not in ('completed', 'failed', 'cancelled');
  update public.jobs j set status = 'cancelled', completed_at = now()
    from public.agent_sessions s where s.id = p_session and j.id = s.job_id and s.status = 'cancelled';
end;
$$;

-- Owner action from the Hub: continue a blocked session (for example after a
-- missing credential was provided). It resumes from its latest checkpoint.
create function public.resume_agent_session(p_session uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.agent_sessions s set status = 'queued', blocker = null, error_code = null, updated_at = now()
  where s.id = p_session and s.status = 'blocked' and not s.cancel_requested;
  update public.jobs j set status = 'running'
    from public.agent_sessions s where s.id = p_session and j.id = s.job_id and s.status = 'queued';
end;
$$;

create function public.record_provider_outcome(
  p_provider text,
  p_model text,
  p_billing_class text,
  p_success boolean,
  p_health text,
  p_cooldown_until timestamptz,
  p_error_code text,
  p_rate_limit jsonb,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_cost_usd numeric
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.provider_status as ps (
    provider, model, billing_class, health, consecutive_failures, cooldown_until, rate_limit,
    last_success_at, last_error_at, last_error_code, requests_total, failures_total,
    input_tokens_total, output_tokens_total, cost_usd_total, updated_at
  ) values (
    p_provider, p_model, coalesce(p_billing_class, 'paid'), p_health, case when p_success then 0 else 1 end,
    p_cooldown_until, p_rate_limit,
    case when p_success then now() end, case when p_success then null else now() end,
    case when p_success then null else p_error_code end,
    case when p_success then 1 else 0 end, case when p_success then 0 else 1 end,
    greatest(0, coalesce(p_input_tokens, 0)), greatest(0, coalesce(p_output_tokens, 0)),
    greatest(0, coalesce(p_cost_usd, 0)), now()
  )
  on conflict (provider, model) do update set
    billing_class = excluded.billing_class,
    health = excluded.health,
    consecutive_failures = case when p_success then 0 else ps.consecutive_failures + 1 end,
    cooldown_until = excluded.cooldown_until,
    rate_limit = coalesce(excluded.rate_limit, ps.rate_limit),
    last_success_at = coalesce(excluded.last_success_at, ps.last_success_at),
    last_error_at = coalesce(excluded.last_error_at, ps.last_error_at),
    last_error_code = coalesce(excluded.last_error_code, ps.last_error_code),
    requests_total = ps.requests_total + excluded.requests_total,
    failures_total = ps.failures_total + excluded.failures_total,
    input_tokens_total = ps.input_tokens_total + excluded.input_tokens_total,
    output_tokens_total = ps.output_tokens_total + excluded.output_tokens_total,
    cost_usd_total = ps.cost_usd_total + excluded.cost_usd_total,
    updated_at = now();
end;
$$;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.create_coding_session(uuid, text, text, text, text, numeric, jsonb, text)',
    'public.claim_agent_session(text, integer)',
    'public.renew_agent_session_lease(uuid, uuid, integer)',
    'public.save_agent_checkpoint(uuid, uuid, text, jsonb, jsonb, text)',
    'public.finish_agent_session(uuid, uuid, text, jsonb, text, text)',
    'public.request_agent_approval(uuid, uuid, text, text, text, text, text, text, text, jsonb)',
    'public.decide_agent_approval(uuid, text, text, text)',
    'public.consume_agent_approval(uuid, uuid, text, text)',
    'public.request_agent_session_cancel(uuid)',
    'public.resume_agent_session(uuid)',
    'public.record_provider_outcome(text, text, text, boolean, text, timestamptz, text, jsonb, bigint, bigint, numeric)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;

-- ---------------------------------------------------------------- workspace grants
-- Coding tools for the Office template workspace. Routine reversible work in
-- the isolated sandbox is AUTO; merge and write access to databases require
-- approval; the owner can relax medium-risk rows later. High-risk rows keep
-- an irreducible approval floor in the controller catalog.
insert into public.workspace_tool_grants (workspace_id, broker, tool_name, action, scopes, risk, decision, secret_ref, enabled)
select p.workspace_id, 'coding', g.tool_name, g.action, g.scopes, g.risk, g.decision, g.secret_ref, true
from public.workspace_policies p
join public.projects pr on pr.id = p.workspace_id and pr.name = 'Fahad AI Office'
cross join (values
  ('repo.list', 'read', array['sandbox:read'], 'low', 'auto', null),
  ('repo.read', 'read', array['sandbox:read'], 'low', 'auto', null),
  ('repo.search', 'read', array['sandbox:read'], 'low', 'auto', null),
  ('repo.write', 'write', array['sandbox:write'], 'low', 'auto', null),
  ('repo.edit', 'write', array['sandbox:write'], 'low', 'auto', null),
  ('shell.run', 'execute', array['sandbox:execute'], 'medium', 'auto', null),
  ('git.status', 'read', array['sandbox:read'], 'low', 'auto', null),
  ('git.diff', 'read', array['sandbox:read'], 'low', 'auto', null),
  ('git.commit', 'write', array['sandbox:write'], 'low', 'auto', null),
  ('git.push', 'publish', array['github:branch'], 'medium', 'auto', 'env://CODING_GITHUB_TOKEN'),
  ('github.pr_create', 'publish', array['github:pull_request'], 'medium', 'auto', 'env://CODING_GITHUB_TOKEN'),
  ('github.pr_status', 'read', array['github:read'], 'low', 'auto', 'env://CODING_GITHUB_TOKEN'),
  ('github.ci_status', 'read', array['github:read'], 'low', 'auto', 'env://CODING_GITHUB_TOKEN'),
  ('github.ci_logs', 'read', array['github:read'], 'low', 'auto', 'env://CODING_GITHUB_TOKEN'),
  ('github.pr_merge', 'merge', array['github:merge'], 'medium', 'approval', 'env://CODING_GITHUB_TOKEN'),
  ('deploy.status', 'read', array['github:read'], 'low', 'auto', 'env://CODING_GITHUB_TOKEN'),
  ('verify.http', 'read', array['network:https'], 'low', 'auto', null),
  ('supabase.query_read', 'read', array['supabase:read'], 'medium', 'auto', 'env://CODING_SUPABASE_ACCESS_TOKEN'),
  ('supabase.query_write', 'write', array['supabase:write'], 'high', 'approval', 'env://CODING_SUPABASE_ACCESS_TOKEN'),
  ('supabase.migration_apply', 'write', array['supabase:migration'], 'high', 'approval', 'env://CODING_SUPABASE_ACCESS_TOKEN')
) as g(tool_name, action, scopes, risk, decision, secret_ref)
on conflict (workspace_id, broker, tool_name, action) do nothing;

-- The Coding Agent's default Anthropic model must be authorized explicitly.
update public.workspace_provider_permissions wpp
set models = array_append(wpp.models, 'claude-opus-5'), updated_at = now()
from public.projects pr
where pr.id = wpp.workspace_id and pr.name = 'Fahad AI Office'
  and wpp.provider = 'anthropic' and not (wpp.models @> array['claude-opus-5']::text[]);

-- New Hub projects inherit the template's coding grants and provider models.
create or replace function public.create_hub_project(p_name text)
returns table (id uuid, name text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_template uuid;
  v_policy public.workspace_policies%rowtype;
  v_project uuid;
begin
  if p_name is null or char_length(btrim(p_name)) not between 2 and 80 then
    raise exception 'HUB_PROJECT_NAME_INVALID' using errcode = '22023';
  end if;
  if lower(btrim(p_name)) = lower('Fahad AI Office') then
    raise exception 'HUB_PROJECT_NAME_RESERVED' using errcode = '22023';
  end if;
  if (select count(*) from public.projects where name = 'Fahad AI Office') <> 1 then
    raise exception 'HUB_PROJECT_TEMPLATE_AMBIGUOUS' using errcode = '42501';
  end if;
  select p.id into v_template from public.projects p where p.name = 'Fahad AI Office';
  select * into v_policy from public.workspace_policies
    where workspace_id = v_template and enabled;
  if not found then
    raise exception 'HUB_PROJECT_TEMPLATE_UNAVAILABLE' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.workspace_provider_permissions
    where workspace_id = v_template and provider = 'anthropic' and enabled
      and models @> array['claude-sonnet-5']::text[]
  ) then
    raise exception 'HUB_PROJECT_DEFAULT_PROVIDER_UNAVAILABLE' using errcode = '42501';
  end if;

  insert into public.projects(name) values (btrim(p_name)) returning projects.id into v_project;
  insert into public.workspace_policies (
    workspace_id, enabled, monthly_budget_usd, max_request_budget_usd,
    budget_period_start, budget_period_end
  ) values (
    v_project, true, least(v_policy.monthly_budget_usd, 0.50),
    least(v_policy.max_request_budget_usd, 0.10),
    date_trunc('month', now()), date_trunc('month', now()) + interval '1 month'
  );
  insert into public.workspace_provider_permissions
    (workspace_id, provider, models, secret_ref, enabled)
  select v_project, provider, models, secret_ref, true
  from public.workspace_provider_permissions
  where workspace_id = v_template and enabled and provider in ('anthropic', 'deepseek');
  insert into public.workspace_tool_grants
    (workspace_id, broker, tool_name, action, scopes, risk, decision, secret_ref, enabled)
  select v_project, broker, tool_name, action, scopes, risk, decision, secret_ref, true
  from public.workspace_tool_grants
  where workspace_id = v_template and enabled and decision in ('auto', 'approval')
    and ((broker = 'model-host' and tool_name in ('WebSearch', 'WebFetch') and decision = 'auto')
      or (broker = 'mcp-office' and tool_name in ('office.echo', 'office.current_time') and decision = 'auto')
      or broker = 'coding');
  return query select p.id, p.name from public.projects p where p.id = v_project;
end;
$$;

revoke all on function public.create_hub_project(text) from public, anon, authenticated;
grant execute on function public.create_hub_project(text) to service_role;
