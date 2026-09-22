-- Phase 1 Continuity POC. Logically isolated by the continuity_ namespace.
-- Apply only to the existing Fahad AI Office project after review.
create extension if not exists pgcrypto;

create table if not exists public.continuity_tasks (
  id uuid primary key,
  idempotency_key text not null unique,
  repository text not null,
  base_branch text not null,
  expected_sha text not null check (expected_sha ~ '^[0-9a-f]{40}$'),
  working_branch text not null unique,
  stage text not null default 'prepare',
  status text not null default 'running' check (status in ('running','completed','failed','needs_human')),
  owner_provider text not null check (owner_provider in ('openai','anthropic')),
  lease_token uuid,
  lease_expires_at timestamptz,
  lock_version bigint not null default 0,
  budget_usd numeric(12,6) not null check (budget_usd > 0),
  spent_usd numeric(12,6) not null default 0 check (spent_usd >= 0),
  task_envelope jsonb not null,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.continuity_checkpoints (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.continuity_tasks(id) on delete cascade,
  sequence integer not null check (sequence > 0),
  stage text not null,
  owner_provider text not null check (owner_provider in ('openai','anthropic')),
  expected_sha text not null,
  repo_state jsonb not null,
  payload jsonb not null,
  progress_hash text not null,
  created_at timestamptz not null default now(),
  unique (task_id, sequence)
);

create table if not exists public.continuity_events (
  id bigint generated always as identity primary key,
  task_id uuid not null references public.continuity_tasks(id) on delete cascade,
  type text not null,
  level text not null default 'info',
  provider text,
  message text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.continuity_usage (
  id bigint generated always as identity primary key,
  task_id uuid not null references public.continuity_tasks(id) on delete cascade,
  provider text not null,
  model text not null,
  agent text not null default 'continuity-controller',
  stage text not null,
  attempt integer not null check (attempt > 0),
  duration_ms bigint not null default 0 check (duration_ms >= 0),
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cached_input_tokens bigint not null default 0,
  cost_usd numeric(12,6) not null default 0,
  request_id text,
  created_at timestamptz not null default now()
);

create unique index if not exists continuity_usage_request_id_key
  on public.continuity_usage(request_id);

create table if not exists public.continuity_handoffs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.continuity_tasks(id) on delete cascade,
  from_provider text not null,
  to_provider text not null,
  checkpoint_id uuid not null references public.continuity_checkpoints(id),
  verification jsonb not null,
  status text not null default 'accepted',
  created_at timestamptz not null default now()
);

create index if not exists continuity_events_task_id_idx
  on public.continuity_events(task_id);

create index if not exists continuity_usage_task_id_idx
  on public.continuity_usage(task_id);

create index if not exists continuity_handoffs_checkpoint_id_idx
  on public.continuity_handoffs(checkpoint_id);

create unique index if not exists continuity_handoffs_once_key
  on public.continuity_handoffs(task_id, from_provider, to_provider, checkpoint_id);

alter table public.continuity_tasks enable row level security;
alter table public.continuity_checkpoints enable row level security;
alter table public.continuity_events enable row level security;
alter table public.continuity_usage enable row level security;
alter table public.continuity_handoffs enable row level security;

revoke all on public.continuity_tasks, public.continuity_checkpoints, public.continuity_events, public.continuity_usage, public.continuity_handoffs from anon, authenticated;
grant select, insert, update, delete on public.continuity_tasks, public.continuity_checkpoints, public.continuity_events, public.continuity_usage, public.continuity_handoffs to service_role;
grant usage, select on sequence public.continuity_events_id_seq, public.continuity_usage_id_seq to service_role;

create or replace function public.continuity_acquire_lease(p_task_id uuid, p_owner text, p_token uuid, p_seconds integer default 300)
returns setof public.continuity_tasks language sql security invoker set search_path = '' as $$
  update public.continuity_tasks
     set owner_provider = p_owner, lease_token = p_token, status = 'running', completed_at = null,
         lease_expires_at = now() + make_interval(secs => greatest(30, least(p_seconds, 900))),
         lock_version = lock_version + 1, updated_at = now()
   where id = p_task_id and status in ('running','failed','needs_human')
     and (lease_token is null or lease_expires_at < now() or lease_token = p_token)
  returning *;
$$;

create or replace function public.continuity_transfer_owner(p_task_id uuid, p_from_owner text, p_to_owner text, p_token uuid, p_checkpoint_id uuid, p_verification jsonb)
returns setof public.continuity_tasks language plpgsql security invoker set search_path = '' as $$
declare
  v_task public.continuity_tasks%rowtype;
begin
  update public.continuity_tasks
     set owner_provider = p_to_owner, lock_version = lock_version + 1, updated_at = now()
   where id = p_task_id and owner_provider = p_from_owner and lease_token = p_token and lease_expires_at >= now() and status = 'running'
  returning * into v_task;
  if not found then return; end if;
  insert into public.continuity_handoffs(task_id, from_provider, to_provider, checkpoint_id, verification)
  values (p_task_id, p_from_owner, p_to_owner, p_checkpoint_id, p_verification)
  on conflict (task_id, from_provider, to_provider, checkpoint_id) do nothing;
  return next v_task;
end;
$$;

revoke all on function public.continuity_acquire_lease(uuid,text,uuid,integer) from public, anon, authenticated;
revoke all on function public.continuity_transfer_owner(uuid,text,text,uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.continuity_acquire_lease(uuid,text,uuid,integer) to service_role;
grant execute on function public.continuity_transfer_owner(uuid,text,text,uuid,uuid,jsonb) to service_role;

-- Make continuity state available to a future authorized server-side dashboard
-- without granting browser roles direct table access in this POC.
do $$
declare
  v_table text;
begin
  foreach v_table in array array['continuity_tasks', 'continuity_events', 'continuity_handoffs'] loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end;
$$;
