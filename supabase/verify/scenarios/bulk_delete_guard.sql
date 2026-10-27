-- 20261027200000_bulk_delete_guard: a large delete or a truncate is refused
-- without a transaction-local opt-in, allowed and audited with one.
do $$
declare
  v_refused boolean := false;
  v_audit int;
begin
  insert into public.events (type, level, message) select 'activity', 'info', 'guard scenario ' || n from generate_series(1, 30) n;

  -- Small deletes (the application's one-row paths) pass untouched.
  delete from public.events where message = 'guard scenario 1';

  begin
    delete from public.events where message like 'guard scenario %';
  exception when sqlstate 'P0001' then v_refused := sqlerrm like 'BULK_DELETE_GUARD:%';
  end;
  if not v_refused then raise exception 'a 29-row delete was not refused'; end if;
  if (select count(*) from public.events where message like 'guard scenario %') <> 29 then raise exception 'the refused delete removed rows'; end if;

  v_refused := false;
  begin
    truncate public.events;
  exception when sqlstate 'P0001' then v_refused := true;
  end;
  if not v_refused then raise exception 'truncate was not refused'; end if;

  -- Naming another table does not open this one.
  perform set_config('office.allow_bulk_delete', 'jobs', true);
  v_refused := false;
  begin
    delete from public.events where message like 'guard scenario %';
  exception when sqlstate 'P0001' then v_refused := true;
  end;
  if not v_refused then raise exception 'an opt-in for jobs opened events'; end if;

  perform set_config('office.allow_bulk_delete', 'events', true);
  delete from public.events where message like 'guard scenario %';
  select count(*) into v_audit from public.events where payload->>'kind' = 'bulk_delete_allowed' and payload->>'table' = 'events' and (payload->>'rows')::int = 29;
  if v_audit <> 1 then raise exception 'the allowed bulk delete was not audited'; end if;
  perform set_config('office.allow_bulk_delete', '', true);
end;
$$;
