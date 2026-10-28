#!/usr/bin/env bash
# Test fixture for test/restore-drill.test.js: a local, password-protected
# stand-in for the production database (all migrations + a row that
# references auth.users).
#   restore-drill-source.sh start DIR PORT   (password from DRILL_PASSWORD)
#   restore-drill-source.sh count DIR PORT
#   restore-drill-source.sh stop  DIR
set -euo pipefail
ACTION=$1; SRC=$2; PORT=${3:-}
ROOT=$(cd -- "$(dirname -- "$0")/../.." && pwd)
R=(); if [[ $(id -u) == 0 ]]; then R=(runuser -u postgres --); fi
case $ACTION in
  start)
    [[ ${#R[@]} -gt 0 ]] && chown postgres "$SRC"
    ( umask 077; printf '%s' "$DRILL_PASSWORD" > "$SRC/pw" ); [[ ${#R[@]} -gt 0 ]] && chown postgres "$SRC/pw"
    "${R[@]}" "$PGBIN/initdb" -D "$SRC/data" -U postgres --auth-local=trust --auth-host=scram-sha-256 --pwfile="$SRC/pw" >/dev/null
    rm -f "$SRC/pw"
    "${R[@]}" "$PGBIN/pg_ctl" -D "$SRC/data" -o "-k $SRC -c listen_addresses=127.0.0.1 -p $PORT -c wal_level=logical" -l "$SRC/log" -w start >/dev/null
    P=("${R[@]}" "$PGBIN/psql" -h "$SRC" -p "$PORT" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1)
    "${P[@]}" -f "$ROOT/supabase/verify/supabase-stubs.sql" >/dev/null 2>&1
    for f in "$ROOT"/supabase/migrations/*.sql; do "${P[@]}" -1 -f "$f" >/dev/null 2>&1; done
    "${P[@]}" -c "insert into auth.users(id, email) values ('00000000-0000-4000-8000-000000000001', 'owner@example.test');
      insert into public.office_owners(user_id, email) values ('00000000-0000-4000-8000-000000000001', 'owner@example.test');
      create schema supabase_migrations;
      create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
      insert into supabase_migrations.schema_migrations(version, name) values ('20260920163620', 'office_core_schema');" >/dev/null ;;
  count)
    "${R[@]}" "$PGBIN/psql" -h "$SRC" -p "$PORT" -U postgres -d postgres -X -A -t -c 'select count(*) from public.office_owners' ;;
  stop)
    "${R[@]}" "$PGBIN/pg_ctl" -D "$SRC/data" -m immediate stop >/dev/null 2>&1 || true ;;
esac
