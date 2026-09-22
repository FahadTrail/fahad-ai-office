-- Phase 2B stores only operational model-attempt metadata. Prompts, responses,
-- credentials, and hidden reasoning are deliberately excluded.
create table public.model_attempts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.projects(id) on delete set null,
  job_id uuid not null references public.jobs(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  run_id uuid not null references public.runs(id) on delete cascade,
  attempt_no integer not null check (attempt_no > 0),
  provider_attempt integer not null check (provider_attempt > 0),
  provider text not null check (char_length(provider) between 1 and 64),
  model text not null check (char_length(model) between 1 and 160),
  stage text not null check (char_length(stage) between 1 and 80),
  status text not null check (status in ('started', 'succeeded', 'failed', 'blocked')),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 512),
  client_request_id text check (client_request_id is null or char_length(client_request_id) <= 512),
  provider_request_id text check (provider_request_id is null or char_length(provider_request_id) <= 512),
  route jsonb not null default '[]'::jsonb check (jsonb_typeof(route) = 'array'),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  reasoning_tokens bigint not null default 0 check (reasoning_tokens >= 0),
  cached_input_tokens bigint not null default 0 check (cached_input_tokens >= 0),
  cost_usd numeric(16, 8) not null default 0 check (cost_usd >= 0),
  duration_ms bigint not null default 0 check (duration_ms >= 0),
  error_code text,
  failure_class text check (failure_class is null or failure_class in ('retry', 'failover', 'approval', 'fatal')),
  http_status integer check (http_status is null or http_status between 100 and 599),
  started_at timestamptz not null,
  ended_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (run_id, idempotency_key, attempt_no),
  check (ended_at is null or ended_at >= started_at)
);

comment on table public.model_attempts is
  'Service-only audit trail for provider-neutral model attempts. Never stores prompts, responses, credentials, or hidden reasoning.';

create index model_attempts_workspace_started_idx
  on public.model_attempts (workspace_id, started_at desc)
  where workspace_id is not null;
create index model_attempts_job_started_idx
  on public.model_attempts (job_id, started_at desc);
create index model_attempts_task_started_idx
  on public.model_attempts (task_id, started_at desc);
create index model_attempts_run_idx
  on public.model_attempts (run_id, attempt_no);
create index model_attempts_provider_status_idx
  on public.model_attempts (provider, status, started_at desc);

alter table public.model_attempts enable row level security;

-- The runtime uses the server-side service role. Browser roles receive no
-- table grants and no RLS policies in Phase 2B.
revoke all on table public.model_attempts from public, anon, authenticated;
grant select, insert, update on table public.model_attempts to service_role;
