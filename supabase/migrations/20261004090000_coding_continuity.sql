-- Coding Continuity Supervisor, Phase A (docs/CODING-CONTINUITY-SUPERVISOR.md).
--
-- Additive only: six new tables and their RPCs. No existing object changes.
-- The write lease copies the proven claim_agent_session /
-- renew_agent_session_lease design: token guarded, row locks, explicit errors.
-- Service role only; RLS on. Metadata only — no credentials, no transcripts.
--
-- Naming: the 2026-09-22 Phase 1 POC already owns continuity_checkpoints and
-- continuity_handoffs (applied, unused by code, never modified). The
-- Supervisor's tables therefore use the coding_ prefix: coding_checkpoints and
-- coding_handoffs. The RPC names follow the locked spec.

-- ---------------------------------------------------------------- workers
create table public.coding_workers (
  key text primary key check (key ~ '^[a-z][a-z0-9-]{1,39}$'),
  display_name text not null check (length(btrim(display_name)) between 1 and 100),
  kind text not null check (kind in ('native', 'cli', 'manual')),
  -- Deduplication key for capacity: workers that share a subscription share it.
  quota_source text not null check (quota_source ~ '^[a-z][a-z0-9-]{1,59}$'),
  enabled boolean not null default false,
  capabilities jsonb not null default '{}'::jsonb check (jsonb_typeof(capabilities) = 'object' and pg_column_size(capabilities) <= 20000),
  health text not null default 'unknown' check (health in ('healthy', 'degraded', 'down', 'unknown')),
  health_basis text not null default 'UNKNOWN' check (health_basis in ('MEASURED', 'PROVIDER_REPORTED', 'ESTIMATED', 'UNKNOWN')),
  last_seen_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.coding_workers is
  'Permanent coding worker stack (Coding Continuity Supervisor). quota_source deduplicates shared subscriptions.';

-- The permanent stack. Only the native Office agent starts enabled; external
-- workers stay disabled until their adapter is implemented and approved.
-- Kilo moves to quota_source openai-chatgpt when it is signed in with ChatGPT.
insert into public.coding_workers (key, display_name, kind, quota_source, enabled) values
  ('office', 'Fahad Office Coding Agent', 'native', 'office-pools', true),
  ('claude-code', 'Claude Code', 'cli', 'anthropic-claude-subscription', false),
  ('codex', 'OpenAI Codex', 'cli', 'openai-chatgpt', false),
  ('antigravity', 'Google Antigravity', 'cli', 'google-ai-pro', false),
  ('opencode', 'OpenCode', 'cli', 'opencode', false),
  ('kilo', 'Kilo Code', 'cli', 'kilo-auto-free', false),
  ('freebuff', 'Freebuff', 'manual', 'freebuff', false);

-- ---------------------------------------------------------------- sessions
create table public.coding_worker_sessions (
  id uuid primary key default gen_random_uuid(),
  worker_key text not null references public.coding_workers(key),
  project_id uuid references public.projects(id) on delete set null,
  repository text not null check (repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  branch text not null check (length(branch) between 1 and 250 and branch !~ '\s'),
  worktree text check (worktree is null or length(worktree) <= 500),
  objective text not null check (length(btrim(objective)) between 1 and 20000),
  status text not null default 'STANDBY' check (status in (
    'STANDBY', 'ACQUIRING', 'ACTIVE', 'DRAINING', 'CHECKPOINTING', 'HANDOFF_READY', 'RELEASED', 'COMPLETED',
    'RATE_LIMITED', 'QUOTA_EXHAUSTED', 'AUTH_REQUIRED', 'UNAVAILABLE', 'FAILED', 'ABNORMAL_EXIT')),
  native_session_id uuid references public.agent_sessions(id) on delete set null,
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz,
  ended_at timestamptz,
  task_tokens bigint check (task_tokens is null or task_tokens >= 0),
  tokens_basis text not null default 'UNKNOWN' check (tokens_basis in ('MEASURED', 'PROVIDER_REPORTED', 'ESTIMATED', 'UNKNOWN')),
  exit_reason text check (exit_reason is null or length(exit_reason) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index coding_worker_sessions_status_heartbeat on public.coding_worker_sessions (status, heartbeat_at);

-- ---------------------------------------------------------------- checkpoints
create table public.coding_checkpoints (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.coding_worker_sessions(id) on delete cascade,
  sequence integer not null check (sequence > 0),
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object'
    and payload->>'schema' = 'continuity.checkpoint.v1'
    and pg_column_size(payload) <= 200000),
  last_commit text not null check (last_commit ~ '^[0-9a-f]{40}$'),
  status text not null check (status in (
    'STANDBY', 'ACQUIRING', 'ACTIVE', 'DRAINING', 'CHECKPOINTING', 'HANDOFF_READY', 'RELEASED', 'COMPLETED',
    'RATE_LIMITED', 'QUOTA_EXHAUSTED', 'AUTH_REQUIRED', 'UNAVAILABLE', 'FAILED', 'ABNORMAL_EXIT')),
  -- Durable copy of the one field a new agent must always have.
  next_exact_action text not null check (length(btrim(next_exact_action)) between 1 and 2000),
  native_checkpoint_id uuid references public.agent_checkpoints(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (session_id, sequence)
);
create index coding_checkpoints_session_sequence on public.coding_checkpoints (session_id, sequence desc);

-- ---------------------------------------------------------------- leases
create table public.coding_leases (
  id uuid primary key default gen_random_uuid(),
  repository text not null,
  branch text not null,
  worktree text,
  worker_key text not null references public.coding_workers(key),
  session_id uuid not null references public.coding_worker_sessions(id) on delete cascade,
  token uuid not null default gen_random_uuid(),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'RELEASED', 'FROZEN', 'RECLAIMED')),
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  expires_at timestamptz not null,
  released_at timestamptz,
  checkpoint_id uuid references public.coding_checkpoints(id) on delete set null
);
-- One writer per (repository, branch). A FROZEN lease also blocks new leases
-- until the Supervisor has verified the branch head and reclaimed it.
create unique index coding_leases_one_writer on public.coding_leases (repository, branch) where status in ('ACTIVE', 'FROZEN');
create index coding_leases_status_expires on public.coding_leases (status, expires_at);

-- ---------------------------------------------------------------- handoffs
create table public.coding_handoffs (
  id uuid primary key default gen_random_uuid(),
  from_session_id uuid not null references public.coding_worker_sessions(id) on delete cascade,
  to_session_id uuid references public.coding_worker_sessions(id) on delete set null,
  from_worker text not null references public.coding_workers(key),
  to_worker text references public.coding_workers(key),
  checkpoint_id uuid not null references public.coding_checkpoints(id),
  reason text not null check (length(btrim(reason)) between 1 and 500),
  packet text not null check (length(btrim(packet)) between 1 and 50000),
  status text not null default 'PROPOSED' check (status in ('PROPOSED', 'ACCEPTED', 'STARTED', 'FAILED')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);
create index coding_handoffs_status_created on public.coding_handoffs (status, created_at);
create unique index coding_handoffs_one_open on public.coding_handoffs (from_session_id) where status = 'PROPOSED';

-- ---------------------------------------------------------------- usage
create table public.coding_usage_snapshots (
  id bigserial primary key,
  worker_key text not null references public.coding_workers(key),
  quota_source text not null,
  session_id uuid references public.coding_worker_sessions(id) on delete set null,
  taken_at timestamptz not null default now(),
  session_pct numeric check (session_pct is null or session_pct between 0 and 100),
  weekly_pct numeric check (weekly_pct is null or weekly_pct between 0 and 100),
  task_tokens bigint check (task_tokens is null or task_tokens >= 0),
  reset_at timestamptz,
  basis text not null check (basis in ('MEASURED', 'PROVIDER_REPORTED', 'ESTIMATED', 'UNKNOWN')),
  raw jsonb not null default '{}'::jsonb check (jsonb_typeof(raw) = 'object' and pg_column_size(raw) <= 20000)
);
create index coding_usage_snapshots_worker_taken on public.coding_usage_snapshots (worker_key, taken_at desc);

-- ---------------------------------------------------------------- RPCs
-- Acquires the write lease for a session's (repository, branch).
create function public.acquire_coding_lease(p_session uuid, p_lease_seconds integer default 300)
returns setof public.coding_leases
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_session public.coding_worker_sessions%rowtype;
  v_lease public.coding_leases%rowtype;
begin
  if p_lease_seconds not between 30 and 3600 then
    raise exception 'CODING_LEASE_INVALID' using errcode = '22023';
  end if;
  select * into v_session from public.coding_worker_sessions s where s.id = p_session for update;
  if not found or v_session.ended_at is not null then
    raise exception 'CODING_SESSION_NOT_FOUND' using errcode = 'P0002';
  end if;
  begin
    insert into public.coding_leases (repository, branch, worktree, worker_key, session_id, expires_at)
    values (v_session.repository, v_session.branch, v_session.worktree, v_session.worker_key, v_session.id,
            now() + make_interval(secs => p_lease_seconds))
    returning * into v_lease;
  exception when unique_violation then
    raise exception 'CODING_LEASE_HELD' using errcode = '55P03';
  end;
  update public.coding_worker_sessions s
  set status = 'ACTIVE', heartbeat_at = now(), updated_at = now()
  where s.id = v_session.id;
  return next v_lease;
end;
$$;

-- Extends a live lease. False for a wrong token, an expired or a non-ACTIVE lease.
create function public.heartbeat_coding_lease(p_lease uuid, p_token uuid, p_lease_seconds integer default 300)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_session uuid;
begin
  update public.coding_leases l
  set heartbeat_at = now(),
      expires_at = now() + make_interval(secs => least(greatest(p_lease_seconds, 30), 3600))
  where l.id = p_lease and l.token = p_token and l.status = 'ACTIVE' and l.expires_at > now()
  returning l.session_id into v_session;
  if not found then
    return false;
  end if;
  update public.coding_worker_sessions s set heartbeat_at = now(), updated_at = now() where s.id = v_session;
  return true;
end;
$$;

-- Records a continuity.checkpoint.v1 payload. Only the live lease holder writes.
create function public.save_continuity_checkpoint(
  p_lease uuid,
  p_token uuid,
  p_payload jsonb,
  p_native_checkpoint uuid default null
) returns public.coding_checkpoints
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_lease public.coding_leases%rowtype;
  v_row public.coding_checkpoints%rowtype;
begin
  select * into v_lease from public.coding_leases l
  where l.id = p_lease and l.token = p_token and l.status = 'ACTIVE' and l.expires_at > now()
  for update;
  if not found then
    raise exception 'CODING_LEASE_INVALID' using errcode = '42501';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object' or p_payload->>'schema' is distinct from 'continuity.checkpoint.v1' then
    raise exception 'CHECKPOINT_SCHEMA_INVALID' using errcode = '22023';
  end if;
  if p_payload->>'repository' is distinct from v_lease.repository or p_payload->>'branch' is distinct from v_lease.branch then
    raise exception 'CHECKPOINT_BRANCH_MISMATCH' using errcode = '22023';
  end if;
  -- Defense in depth; the JS validator (src/continuity/checkpoint.js) runs first.
  if p_payload::text ~ '(-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|sb_secret_[A-Za-z0-9_-]{16,}|sbp_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,})' then
    raise exception 'CHECKPOINT_SECRET_MATERIAL' using errcode = '22023';
  end if;
  insert into public.coding_checkpoints (session_id, sequence, payload, last_commit, status, next_exact_action, native_checkpoint_id)
  values (
    v_lease.session_id,
    coalesce((select max(c.sequence) from public.coding_checkpoints c where c.session_id = v_lease.session_id), 0) + 1,
    p_payload, p_payload->>'last_commit', p_payload->>'status', p_payload->>'next_exact_action', p_native_checkpoint)
  returning * into v_row;
  update public.coding_leases l set checkpoint_id = v_row.id, heartbeat_at = now() where l.id = v_lease.id;
  update public.coding_worker_sessions s set heartbeat_at = now(), updated_at = now() where s.id = v_lease.session_id;
  return v_row;
end;
$$;

-- Releases a lease. A release always names a checkpoint of the same session.
create function public.release_coding_lease(
  p_lease uuid,
  p_token uuid,
  p_checkpoint uuid,
  p_final_status text default 'RELEASED'
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_lease public.coding_leases%rowtype;
begin
  if p_final_status not in ('HANDOFF_READY', 'RELEASED', 'COMPLETED') then
    raise exception 'CODING_LEASE_STATUS_INVALID' using errcode = '22023';
  end if;
  select * into v_lease from public.coding_leases l
  where l.id = p_lease and l.token = p_token and l.status = 'ACTIVE'
  for update;
  if not found then
    raise exception 'CODING_LEASE_INVALID' using errcode = '42501';
  end if;
  if p_checkpoint is null or not exists (
    select 1 from public.coding_checkpoints c where c.id = p_checkpoint and c.session_id = v_lease.session_id) then
    raise exception 'CODING_LEASE_CHECKPOINT_REQUIRED' using errcode = '22023';
  end if;
  update public.coding_leases l
  set status = 'RELEASED', released_at = now(), checkpoint_id = p_checkpoint
  where l.id = v_lease.id;
  update public.coding_worker_sessions s
  set status = p_final_status,
      ended_at = case when p_final_status = 'HANDOFF_READY' then s.ended_at else now() end,
      updated_at = now()
  where s.id = v_lease.session_id;
  return true;
end;
$$;

-- Freezes ACTIVE leases whose heartbeat expired; their sessions become
-- ABNORMAL_EXIT. A FROZEN lease still blocks the branch until reclaimed.
create function public.freeze_stale_coding_leases(p_grace_seconds integer default 0)
returns setof public.coding_leases
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
  with frozen as (
    update public.coding_leases l
    set status = 'FROZEN'
    where l.status = 'ACTIVE' and l.expires_at < now() - make_interval(secs => greatest(p_grace_seconds, 0))
    returning l.*
  ), sessions as (
    update public.coding_worker_sessions s
    set status = 'ABNORMAL_EXIT', exit_reason = 'lease heartbeat expired', ended_at = now(), updated_at = now()
    from frozen f
    where s.id = f.session_id and s.status not in ('RELEASED', 'COMPLETED', 'FAILED', 'ABNORMAL_EXIT')
    returning s.id
  )
  select * from frozen;
end;
$$;

-- After the Supervisor verified the branch head against the last checkpoint,
-- it reclaims the frozen lease so the next worker can acquire the branch.
create function public.reclaim_coding_lease(p_lease uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.coding_leases l
  set status = 'RECLAIMED', released_at = now()
  where l.id = p_lease and l.status = 'FROZEN';
  return found;
end;
$$;

-- Proposes passing the baton from a session, anchored on one of its checkpoints.
create function public.propose_handoff(
  p_from_session uuid,
  p_checkpoint uuid,
  p_reason text,
  p_packet text,
  p_to_worker text default null
) returns public.coding_handoffs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_session public.coding_worker_sessions%rowtype;
  v_row public.coding_handoffs%rowtype;
begin
  select * into v_session from public.coding_worker_sessions s where s.id = p_from_session for update;
  if not found then
    raise exception 'CODING_SESSION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.coding_checkpoints c where c.id = p_checkpoint and c.session_id = p_from_session) then
    raise exception 'HANDOFF_CHECKPOINT_INVALID' using errcode = '22023';
  end if;
  if p_to_worker is not null and not exists (select 1 from public.coding_workers w where w.key = p_to_worker) then
    raise exception 'HANDOFF_WORKER_UNKNOWN' using errcode = '22023';
  end if;
  begin
    insert into public.coding_handoffs (from_session_id, from_worker, to_worker, checkpoint_id, reason, packet)
    values (p_from_session, v_session.worker_key, p_to_worker, p_checkpoint, btrim(p_reason), p_packet)
    returning * into v_row;
  exception when unique_violation then
    raise exception 'HANDOFF_ALREADY_PROPOSED' using errcode = '55P03';
  end;
  return v_row;
end;
$$;

-- The receiving session accepts. It must work on the same repository and
-- branch, and nobody else may still hold the branch.
create function public.accept_handoff(p_handoff uuid, p_to_session uuid)
returns public.coding_handoffs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_handoff public.coding_handoffs%rowtype;
  v_from public.coding_worker_sessions%rowtype;
  v_to public.coding_worker_sessions%rowtype;
begin
  select * into v_handoff from public.coding_handoffs h where h.id = p_handoff for update;
  if not found or v_handoff.status <> 'PROPOSED' then
    raise exception 'HANDOFF_NOT_PROPOSED' using errcode = '55000';
  end if;
  select * into v_from from public.coding_worker_sessions s where s.id = v_handoff.from_session_id;
  select * into v_to from public.coding_worker_sessions s where s.id = p_to_session;
  if not found or v_to.id = v_from.id or v_to.repository <> v_from.repository or v_to.branch <> v_from.branch
     or (v_handoff.to_worker is not null and v_handoff.to_worker <> v_to.worker_key) then
    raise exception 'HANDOFF_TARGET_INVALID' using errcode = '22023';
  end if;
  if exists (select 1 from public.coding_leases l
             where l.repository = v_from.repository and l.branch = v_from.branch
               and l.status in ('ACTIVE', 'FROZEN') and l.session_id <> p_to_session) then
    raise exception 'HANDOFF_BRANCH_STILL_LEASED' using errcode = '55P03';
  end if;
  update public.coding_handoffs h
  set status = 'ACCEPTED', to_session_id = p_to_session, to_worker = v_to.worker_key, accepted_at = now()
  where h.id = p_handoff
  returning * into v_handoff;
  return v_handoff;
end;
$$;

-- ---------------------------------------------------------------- privileges
do $$
declare
  v_table text;
  v_signature text;
begin
  foreach v_table in array array['coding_workers', 'coding_worker_sessions', 'coding_checkpoints', 'coding_leases', 'coding_handoffs', 'coding_usage_snapshots'] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', v_table);
    execute format('grant select, insert, update on table public.%I to service_role', v_table);
  end loop;
  foreach v_signature in array array[
    'public.acquire_coding_lease(uuid, integer)',
    'public.heartbeat_coding_lease(uuid, uuid, integer)',
    'public.save_continuity_checkpoint(uuid, uuid, jsonb, uuid)',
    'public.release_coding_lease(uuid, uuid, uuid, text)',
    'public.freeze_stale_coding_leases(integer)',
    'public.reclaim_coding_lease(uuid)',
    'public.propose_handoff(uuid, uuid, text, text, text)',
    'public.accept_handoff(uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;
grant usage, select on sequence public.coding_usage_snapshots_id_seq to service_role;
revoke all on sequence public.coding_usage_snapshots_id_seq from public, anon, authenticated;
-- Usage snapshots are pruned after 90 days (docs/CODING-CONTINUITY-SUPERVISOR.md section 10).
grant delete on table public.coding_usage_snapshots to service_role;
