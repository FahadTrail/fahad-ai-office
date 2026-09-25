-- ============================================================
-- Move is_owner() out of the public schema so it is no longer
-- callable over the REST API, while RLS policies can still use it.
-- ============================================================

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create or replace function private.is_owner()
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

revoke all on function private.is_owner() from public, anon;
grant execute on function private.is_owner() to authenticated;

-- Repoint every policy at the private function
do $$
declare t text;
begin
  foreach t in array array[
    'agents','projects','jobs','tasks','runs','events',
    'handoffs','results','memory','files','approvals'
  ]
  loop
    execute format('drop policy if exists %I on public.%I;', 'owner_only_' || t, t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (private.is_owner()) with check (private.is_owner());',
      'owner_only_' || t, t
    );
  end loop;
end $$;

drop policy if exists owner_reads_owners on public.office_owners;
create policy owner_reads_owners on public.office_owners
  for select to authenticated
  using (private.is_owner());

-- Remove the publicly exposed version
drop function if exists public.is_owner();
