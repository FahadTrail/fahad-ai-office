-- Free-first routing policy per workspace and a usage summary for the Model
-- Pool dashboard and per-route budget caps. Additive only.

-- Workspace routing policy. Tasks may override it in agent_sessions.config.
-- It can only reorder, exclude or cap routes; provider authorization stays in
-- workspace_provider_permissions.
create table public.workspace_routing_policies (
  workspace_id uuid primary key references public.workspace_policies(workspace_id) on delete cascade,
  strategy text not null default 'economy' check (strategy in ('economy', 'balanced', 'quality')),
  billing_priority text[] not null default array['free', 'included', 'promo', 'paid']
    check (cardinality(billing_priority) between 1 and 4 and billing_priority <@ array['free', 'included', 'promo', 'paid']),
  allow_paid boolean not null default true,
  excluded_routes text[] not null default '{}' check (cardinality(excluded_routes) <= 50),
  route_monthly_budget_usd jsonb not null default '{}'::jsonb check (jsonb_typeof(route_monthly_budget_usd) = 'object'),
  updated_at timestamptz not null default now()
);

alter table public.workspace_routing_policies enable row level security;
revoke all on table public.workspace_routing_policies from public, anon, authenticated, service_role;
grant select, insert, update on table public.workspace_routing_policies to service_role;

-- Audited usage per provider/model from model_attempts (Office and Coding
-- Agent). Without p_since: the workspace's current budget period when a
-- workspace is given, otherwise the current UTC day.
create function public.model_usage_summary(p_since timestamptz default null, p_workspace uuid default null)
returns table (
  provider text, model text, requests bigint, failures bigint,
  input_tokens bigint, output_tokens bigint, cost_usd numeric,
  last_success_at timestamptz, last_error_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  with bounds as (
    select coalesce(
      p_since,
      (select wp.budget_period_start from public.workspace_policies wp where p_workspace is not null and wp.workspace_id = p_workspace),
      date_trunc('day', now() at time zone 'utc') at time zone 'utc'
    ) as since
  )
  select a.provider, a.model,
    count(*) filter (where a.status <> 'started'),
    count(*) filter (where a.status in ('failed', 'blocked')),
    coalesce(sum(a.input_tokens), 0)::bigint,
    coalesce(sum(a.output_tokens), 0)::bigint,
    coalesce(sum(a.cost_usd), 0),
    max(a.ended_at) filter (where a.status = 'succeeded'),
    max(a.ended_at) filter (where a.status in ('failed', 'blocked'))
  from public.model_attempts a, bounds b
  where a.started_at >= b.since
    and (p_workspace is null or a.workspace_id = p_workspace)
  group by a.provider, a.model;
$$;

revoke all on function public.model_usage_summary(timestamptz, uuid) from public, anon, authenticated, service_role;
grant execute on function public.model_usage_summary(timestamptz, uuid) to service_role;
