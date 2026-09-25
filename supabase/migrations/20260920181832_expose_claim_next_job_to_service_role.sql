-- ============================================================
-- Supabase's API layer only exposes the `public` schema, so the
-- runtime cannot reach private.claim_next_job() directly.
--
-- Add a thin wrapper in `public` that ONLY the service_role key
-- can execute. Signed-in users and anonymous visitors are denied,
-- so this adds no attack surface — the real logic stays private.
-- ============================================================

create or replace function public.claim_next_job()
returns public.jobs
language sql
volatile
security definer
set search_path = private, public
as $$
  select private.claim_next_job();
$$;

revoke all on function public.claim_next_job() from public, anon, authenticated;
grant execute on function public.claim_next_job() to service_role;
