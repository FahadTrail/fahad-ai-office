-- Bulk-delete guard for the Office's durable history.
--
-- Incident (docs/FAHAD-OFFICE-COMPLETION.md §A): shortly before 2026-10-22
-- 21:06 UTC every job, task, run, result, event, coding session and model
-- attempt was deleted in one pass, while configuration tables were kept. No
-- repository script or application path can do that (the only cleanup script
-- deletes explicit IDs with expected counts), so it was a privileged manual or
-- agent SQL statement. This migration makes that class of accident refuse
-- itself.
--
-- Rule: one statement may delete at most 25 rows from a guarded table, and
-- TRUNCATE is refused, unless the same transaction first opts in:
--
--   select set_config('office.allow_bulk_delete', 'jobs,tasks', true);  -- named tables
--   select set_config('office.allow_bulk_delete', 'all', true);         -- reviewed cleanup
--
-- The setting is transaction-local (third argument true), so an opt-in never
-- leaks into later statements. Every allowed bulk delete is written to
-- public.events (kind 'bulk_delete_allowed') with the table and row count.
-- Application paths delete one row at a time and are unaffected; cascades
-- from a single job (its tasks, runs, results …) stay far below the limit.
--
-- Deliberately not a security boundary: a superuser can disable triggers.
-- It stops the accidental `delete from jobs` / `truncate events`.
-- Rollback: drop the triggers and the two functions (see the end of file).

create or replace function private.bulk_delete_allowed(p_table text)
returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('office.allow_bulk_delete', true), '') = 'all'
      or p_table = any (string_to_array(replace(coalesce(current_setting('office.allow_bulk_delete', true), ''), ' ', ''), ','));
$$;
revoke all on function private.bulk_delete_allowed(text) from public, anon, authenticated, service_role;

create or replace function private.guard_bulk_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_limit constant int := 25;
  v_count bigint;
begin
  if tg_op = 'TRUNCATE' then
    if not private.bulk_delete_allowed(tg_table_name) then
      raise exception 'BULK_DELETE_GUARD: TRUNCATE of public.% is refused. Opt in for this transaction with select set_config(''office.allow_bulk_delete'', ''%'', true);', tg_table_name, tg_table_name
        using errcode = 'P0001';
    end if;
    insert into public.events (type, level, message, payload)
    values ('activity', 'warning', 'Bulk delete allowed: TRUNCATE public.' || tg_table_name,
            jsonb_build_object('kind', 'bulk_delete_allowed', 'table', tg_table_name, 'operation', 'truncate', 'role', current_user));
    return null;
  end if;

  select count(*) into v_count from old_rows;
  if v_count <= v_limit then return null; end if;
  if not private.bulk_delete_allowed(tg_table_name) then
    raise exception 'BULK_DELETE_GUARD: one statement tried to delete % rows from public.% (limit %). Opt in for this transaction with select set_config(''office.allow_bulk_delete'', ''%'', true);', v_count, tg_table_name, v_limit, tg_table_name
      using errcode = 'P0001';
  end if;
  -- events rows deleted by an allowed cleanup are already gone; the audit row is new.
  insert into public.events (type, level, message, payload)
  values ('activity', 'warning', 'Bulk delete allowed: ' || v_count || ' rows from public.' || tg_table_name,
          jsonb_build_object('kind', 'bulk_delete_allowed', 'table', tg_table_name, 'operation', 'delete', 'rows', v_count, 'role', current_user));
  return null;
end;
$$;
revoke all on function private.guard_bulk_delete() from public, anon, authenticated, service_role;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'jobs', 'tasks', 'runs', 'results', 'handoffs', 'events', 'artifacts', 'conversations', 'projects',
    'project_memory', 'knowledge_items', 'deliverable_reviews', 'model_attempts', 'tool_executions',
    'agent_sessions', 'agent_events', 'agent_checkpoints', 'agent_approvals', 'agent_owner_inputs',
    'workspace_policies', 'workspace_provider_permissions', 'workspace_tool_grants', 'provider_canary_runs'
  ] loop
    execute format('create trigger %I after delete on public.%I referencing old table as old_rows for each statement execute function private.guard_bulk_delete()',
                   v_table || '_bulk_delete_guard', v_table);
    execute format('create trigger %I before truncate on public.%I for each statement execute function private.guard_bulk_delete()',
                   v_table || '_truncate_guard', v_table);
  end loop;
end;
$$;

-- Rollback (manual, reviewed):
--   do $$ declare t text; begin foreach t in array array['jobs', … same list …] loop
--     execute format('drop trigger if exists %I on public.%I', t || '_bulk_delete_guard', t);
--     execute format('drop trigger if exists %I on public.%I', t || '_truncate_guard', t);
--   end loop; end $$;
--   drop function private.guard_bulk_delete(); drop function private.bulk_delete_allowed(text);
