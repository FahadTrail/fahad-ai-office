do $$
declare
  v_first uuid;
  v_claim public.provider_canary_runs%rowtype;
begin
  insert into public.provider_canary_runs (requested_by) values ('owner') returning id into v_first;
  insert into public.provider_canary_runs (requested_by) values ('owner');
  select * into v_claim from public.claim_provider_canary_run();
  assert v_claim.id = v_first and v_claim.status = 'running', 'oldest queued run is claimed';
  update public.provider_canary_runs set started_at = now() - interval '20 minutes' where id = v_first;
  select * into v_claim from public.claim_provider_canary_run();
  assert (select status from public.provider_canary_runs where id = v_first) = 'failed', 'stuck run is failed';
  assert v_claim.id <> v_first, 'the next queued run is claimed';
  assert (select count(*) from public.claim_provider_canary_run()) = 0, 'nothing left to claim';
end;
$$;
set local role anon;
do $$ begin
  begin perform 1 from public.provider_canary_runs; raise exception 'anon read canary runs'; exception when insufficient_privilege then null; end;
end $$;
reset role;
