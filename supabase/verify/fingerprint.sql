-- Structural fingerprint of the application schemas. Run identically against
-- production (read-only) and a local replay of supabase/migrations; the
-- outputs must match line for line. It reads catalogs only. Carriage returns
-- (some production functions were applied from a Windows client) and the
-- PostgreSQL 17 MAINTAIN privilege bit are normalized away.
with objects as (
  select 'column' as kind, format('%s.%s.%s %s null=%s default=%s', c.table_schema, c.table_name, c.column_name,
    c.data_type, c.is_nullable, coalesce(c.column_default, '')) as detail
  from information_schema.columns c
  where c.table_schema in ('public', 'private')
  union all
  select 'constraint', format('%s.%s %s %s', n.nspname, t.relname, con.conname, pg_get_constraintdef(con.oid))
  from pg_constraint con join pg_class t on t.oid = con.conrelid join pg_namespace n on n.oid = t.relnamespace
  where n.nspname in ('public', 'private')
  union all
  select 'index', format('%s %s', schemaname, indexdef) from pg_indexes where schemaname in ('public', 'private')
  union all
  select 'function', format('%s.%s(%s) md5=%s', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid),
    md5(replace(pg_get_functiondef(p.oid), chr(13), '')))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.prokind in ('f', 'p')
  union all
  select 'function_acl', format('%s.%s(%s) %s', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid),
    coalesce((select string_agg(a, ',' order by a) from unnest(p.proacl::text[]) a
      where a !~ '^(postgres|supabase_admin)='), 'default'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.prokind in ('f', 'p')
  union all
  select 'table_acl', format('%s.%s rls=%s %s', n.nspname, c.relname, c.relrowsecurity,
    coalesce((select string_agg(replace(a, 'm/', '/'), ',' order by a) from unnest(c.relacl::text[]) a
      where a !~ '^(postgres|supabase_admin)='), 'default'))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v')
  union all
  select 'policy', format('%s.%s %s %s roles=%s using=%s check=%s', schemaname, tablename, policyname, cmd,
    roles::text, coalesce(qual, ''), coalesce(with_check, ''))
  from pg_policies where schemaname in ('public', 'private')
  union all
  select 'trigger', format('%s.%s %s', n.nspname, c.relname, pg_get_triggerdef(t.oid))
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'private') and not t.tgisinternal
  union all
  select 'publication', format('%s %s.%s', pubname, schemaname, tablename)
  from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'
)
select kind, md5(detail) as hash, left(detail, 160) as detail from objects order by kind, detail;
