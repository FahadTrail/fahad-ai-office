-- ============================================================
-- OWNER / ADMIN SCAFFOLDING
-- One owner: Fahad. Everything in the office is gated on this.
-- is_owner() is SECURITY DEFINER so it bypasses RLS on office_owners
-- itself — this avoids the recursive-lockout trap where RLS is
-- enabled but the check can never read its own table.
-- ============================================================

create table public.office_owners (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  label      text not null default 'Owner',
  created_at timestamptz not null default now()
);

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from public.office_owners o
    where o.user_id = auth.uid()
  );
$$;

revoke all on function public.is_owner() from public, anon;
grant execute on function public.is_owner() to authenticated;

-- Lock the owners table itself to the owner
alter table public.office_owners enable row level security;

create policy owner_reads_owners on public.office_owners
  for select to authenticated
  using (public.is_owner());
