-- ============================================================
-- Register Fahad as the office owner, then narrow every RLS
-- policy from "any signed-in user" to "the owner only".
-- ============================================================

insert into public.office_owners (user_id, email, label)
select id, email, 'Fahad — Owner'
from auth.users
where email = 'fahad.alshehhi@live.com'
on conflict (user_id) do nothing;

-- Swap the policies on all 11 office tables
do $$
declare t text;
begin
  foreach t in array array[
    'agents','projects','jobs','tasks','runs','events',
    'handoffs','results','memory','files','approvals'
  ]
  loop
    execute format('drop policy if exists %I on public.%I;',
                   'authenticated_full_access_' || t, t);

    execute format(
      'create policy %I on public.%I for all to authenticated
         using (public.is_owner()) with check (public.is_owner());',
      'owner_only_' || t, t
    );
  end loop;
end $$;
