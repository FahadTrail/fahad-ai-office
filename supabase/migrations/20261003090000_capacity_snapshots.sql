-- Capacity V2 (Part 26): one daily snapshot of effective free capacity.
--
-- Additive and minimal: one row per UTC day with the capacity model's
-- summary (per job class tokens, coding jobs/day, projects/day, pool states,
-- cost). Metadata only — no prompts, no model output, no credentials.
-- Service role only; RLS on.

create table public.capacity_snapshots (
  snapshot_date date primary key,
  taken_at timestamptz not null default now(),
  summary jsonb not null check (jsonb_typeof(summary) = 'object' and pg_column_size(summary) <= 100000)
);

alter table public.capacity_snapshots enable row level security;
revoke all on table public.capacity_snapshots from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.capacity_snapshots to service_role;

comment on table public.capacity_snapshots is
  'Daily effective free capacity summary (Capacity V2). One row per UTC day; metadata only.';
