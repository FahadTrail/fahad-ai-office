-- 20261027200000_bulk_delete_guard: a large delete or a truncate is refused
-- without a transaction-local opt-in; one real objective (with its cascade)
-- still deletes; allowed bulk deletes are audited append-only.
do $$
declare
  v_refused boolean := false;
  v_job uuid;
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

  -- One real objective with 40 events: deleting the job cascades 40 event
  -- rows (above the direct limit, below the cascade limit) and is allowed.
  insert into public.jobs (title, goal, status) values ('Guard', 'cascade scenario', 'completed') returning id into v_job;
  insert into public.events (job_id, type, level, message) select v_job, 'activity', 'info', 'cascade ' || n from generate_series(1, 40) n;
  delete from public.jobs where id = v_job;
  if exists (select 1 from public.events where job_id = v_job) then raise exception 'the single-job cascade did not complete'; end if;

  -- An opt-in without the current transaction id (a session-wide or stale
  -- setting) opens nothing; naming another table opens nothing.
  perform set_config('office.allow_bulk_delete', 'all', true);
  v_refused := false;
  begin delete from public.events where message like 'guard scenario %';
  exception when sqlstate 'P0001' then v_refused := true; end;
  if not v_refused then raise exception 'an opt-in without the transaction id opened the guard'; end if;

  perform set_config('office.allow_bulk_delete', 'all@1', true);
  v_refused := false;
  begin delete from public.events where message like 'guard scenario %';
  exception when sqlstate 'P0001' then v_refused := true; end;
  if not v_refused then raise exception 'an opt-in for another transaction opened the guard'; end if;

  perform set_config('office.allow_bulk_delete', 'jobs@' || txid_current()::text, true);
  v_refused := false;
  begin delete from public.events where message like 'guard scenario %';
  exception when sqlstate 'P0001' then v_refused := true; end;
  if not v_refused then raise exception 'an opt-in for jobs opened events'; end if;

  perform set_config('office.allow_bulk_delete', 'events@' || txid_current()::text, true);
  delete from public.events where message like 'guard scenario %';
  select count(*) into v_audit from private.bulk_delete_audit where table_name = 'events' and operation = 'delete' and row_count = 29 and not cascaded;
  if v_audit <> 1 then raise exception 'the allowed bulk delete was not audited'; end if;
  if not exists (select 1 from public.events where payload->>'kind' = 'bulk_delete_allowed' and payload->>'table' = 'events') then raise exception 'no ops-watch event'; end if;
  perform set_config('office.allow_bulk_delete', '', true);

  -- The audit is append-only, opt-in or not.
  perform set_config('office.allow_bulk_delete', 'all@' || txid_current()::text, true);
  v_refused := false;
  begin delete from private.bulk_delete_audit;
  exception when sqlstate 'P0001' then v_refused := sqlerrm like 'BULK_DELETE_AUDIT_APPEND_ONLY:%'; end;
  if not v_refused then raise exception 'the audit could be deleted'; end if;
  v_refused := false;
  begin truncate private.bulk_delete_audit;
  exception when sqlstate 'P0001' then v_refused := true; end;
  if not v_refused then raise exception 'the audit could be truncated'; end if;
  perform set_config('office.allow_bulk_delete', '', true);
end;
$$;
