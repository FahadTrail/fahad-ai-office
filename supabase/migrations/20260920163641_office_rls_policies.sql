-- ============================================================
-- ROW LEVEL SECURITY
-- Signed-in users (Fahad) get full access. Anonymous gets nothing.
-- The Office Runtime uses the service_role key, which bypasses RLS.
-- Every table gets an explicit policy — RLS enabled with no policy
-- silently blocks everything, so we never leave one empty.
-- ============================================================

do $$
declare t text;
begin
  foreach t in array array[
    'agents','projects','jobs','tasks','runs','events',
    'handoffs','results','memory','files','approvals'
  ]
  loop
    execute format('alter table public.%I enable row level security;', t);

    execute format(
      'create policy %I on public.%I for all to authenticated using (true) with check (true);',
      'authenticated_full_access_' || t, t
    );
  end loop;
end $$;

-- Explicitly remove anonymous access
revoke all on all tables in schema public from anon;
