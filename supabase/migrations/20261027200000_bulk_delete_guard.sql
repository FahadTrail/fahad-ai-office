-- Bulk-delete guard for the Office's durable history.
--
-- Context (docs/FAHAD-OFFICE-COMPLETION.md §A): on 2026-10-22 the owner had
-- all test jobs, sessions and logs removed in one pass — an intended cleanup.
-- It showed that nothing distinguished an approved bulk delete from an
-- accidental one, and nothing recorded who ran it. This migration refuses
-- unapproved bulk deletes and records every approved one; approved cleanups
-- keep working through the per-transaction opt-in below.
--
-- Rules
-- * A statement run directly may delete at most 25 rows from a guarded table.
-- * Rows removed by ON DELETE CASCADE (their parent row is gone) may reach
--   1000 per table and statement, so deleting one real objective — with its
--   tasks, runs, results and events — still works; the statement that
--   deleted the parent is itself limited to 25 rows.
-- * TRUNCATE of a guarded table is refused.
-- * A reviewed bulk delete opts in for ITS OWN TRANSACTION only:
--     select set_config('office.allow_bulk_delete', 'jobs,tasks@' || txid_current()::text, true);
--     select set_config('office.allow_bulk_delete', 'all@' || txid_current()::text, true);
--   The value must carry the current transaction id, so an opt-in set for a
--   whole session (or left over from an earlier transaction) opens nothing.
-- * Every allowed bulk delete is written to private.bulk_delete_audit, an
--   append-only table that refuses DELETE and TRUNCATE outright (no opt-in),
--   with the role, session user, application name and client address; a copy
--   goes to public.events (kind 'bulk_delete_allowed') for the ops watch.
--
-- Application paths delete one row at a time and are unaffected.
-- Deliberately not a security boundary: a superuser can disable triggers or
-- set session_replication_role = replica. It stops the accidental
-- `delete from jobs` / `truncate events` and makes intended ones attributable.
-- Rollback: see the end of this file.

create table private.bulk_delete_audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  table_name text not null,
  operation text not null check (operation in ('delete', 'truncate')),
  row_count bigint,
  cascaded boolean not null default false,
  db_role text not null default current_user,
  session_role text not null default session_user,
  application_name text default current_setting('application_name', true),
  client_addr inet default inet_client_addr(),
  txid bigint not null default txid_current()
);
alter table private.bulk_delete_audit enable row level security;
revoke all on table private.bulk_delete_audit from public, anon, authenticated, service_role;

create or replace function private.bulk_delete_audit_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'BULK_DELETE_AUDIT_APPEND_ONLY: private.bulk_delete_audit cannot be % (append-only)', lower(tg_op) using errcode = 'P0001';
end;
$$;
revoke all on function private.bulk_delete_audit_append_only() from public, anon, authenticated, service_role;
create trigger bulk_delete_audit_no_delete before delete or update on private.bulk_delete_audit
  for each statement execute function private.bulk_delete_audit_append_only();
create trigger bulk_delete_audit_no_truncate before truncate on private.bulk_delete_audit
  for each statement execute function private.bulk_delete_audit_append_only();

-- The opt-in names tables (or 'all') and must end with '@<current txid>'.
create or replace function private.bulk_delete_allowed(p_table text)
returns boolean language plpgsql volatile set search_path = '' as $$
declare
  v_value text := replace(coalesce(current_setting('office.allow_bulk_delete', true), ''), ' ', '');
  v_tables text;
begin
  if v_value = '' or position('@' in v_value) = 0 then return false; end if;
  if split_part(v_value, '@', 2) <> txid_current()::text then return false; end if;
  v_tables := split_part(v_value, '@', 1);
  return v_tables = 'all' or p_table = any (string_to_array(v_tables, ','));
end;
$$;
revoke all on function private.bulk_delete_allowed(text) from public, anon, authenticated, service_role;

create or replace function private.guard_bulk_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_count bigint;
  v_cascaded bigint := 0;
  v_direct bigint;
  v_condition text;
  v_operation text := case when tg_op = 'TRUNCATE' then 'truncate' else 'delete' end;
begin
  if v_operation = 'delete' then
    select count(*) into v_count from old_rows;
    if v_count <= 25 then return null; end if;
    -- A row removed by ON DELETE CASCADE has a cascading foreign key whose
    -- parent no longer exists; the statement that deleted the parent was
    -- itself held to 25 rows. Single-column cascading keys of this table:
    select string_agg(format('(o.%I is not null and not exists (select 1 from %s p where p.%I = o.%I))', a.attname, c.confrelid::regclass, pa.attname, a.attname), ' or ')
      into v_condition
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    join pg_catalog.pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1]
    where c.conrelid = tg_relid and c.contype = 'f' and c.confdeltype = 'c' and cardinality(c.conkey) = 1;
    if v_condition is not null then
      execute 'select count(*) from old_rows o where ' || v_condition into v_cascaded;
    end if;
    v_direct := v_count - v_cascaded;
    if v_direct <= 25 and v_cascaded <= 1000 then return null; end if;
  end if;
  if not private.bulk_delete_allowed(tg_table_name) then
    raise exception 'BULK_DELETE_GUARD: % of public.% refused (% rows: % direct, % by cascade; limits 25 direct, 1000 by cascade, 0 for TRUNCATE). Opt in for this transaction only with: select set_config(''office.allow_bulk_delete'', ''%@'' || txid_current()::text, true);',
      upper(v_operation), tg_table_name, coalesce(v_count::text, 'all'), coalesce(v_direct::text, '-'), coalesce(v_cascaded::text, '-'), tg_table_name
      using errcode = 'P0001';
  end if;
  insert into private.bulk_delete_audit (table_name, operation, row_count, cascaded) values (tg_table_name, v_operation, v_count, coalesce(v_cascaded, 0) > 0);
  insert into public.events (type, level, message, payload)
  values ('activity', 'warning',
          'Bulk delete allowed: ' || case when v_operation = 'truncate' then 'TRUNCATE public.' || tg_table_name else v_count || ' rows from public.' || tg_table_name end,
          jsonb_build_object('kind', 'bulk_delete_allowed', 'table', tg_table_name, 'operation', v_operation, 'rows', v_count,
                             'cascaded_rows', v_cascaded, 'role', session_user, 'application', current_setting('application_name', true)));
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

-- Rollback (manual, reviewed; keeps the audit table and its rows):
--   do $$ declare t text; begin foreach t in array array['jobs', … same list …] loop
--     execute format('drop trigger if exists %I on public.%I', t || '_bulk_delete_guard', t);
--     execute format('drop trigger if exists %I on public.%I', t || '_truncate_guard', t);
--   end loop; end $$;
--   drop function private.guard_bulk_delete(); drop function private.bulk_delete_allowed(text);
