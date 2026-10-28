#!/usr/bin/env bash
# Independent backup + restore drill for the Office database, at no cost.
#
# Takes a consistent, READ-ONLY logical dump of the application schemas
# (public, private) and the migration history (supabase_migrations) from the
# Supabase database, restores it into a throwaway
# local PostgreSQL cluster, and proves the restore is complete:
#   * every table's exact row count equals the source, counted in the very
#     snapshot that was dumped (no drift from live writes);
#   * the structural fingerprint (columns, constraints, indexes, functions,
#     policies, triggers) equals the source's, ACL lines aside;
#   * pg_restore reported zero errors.
# Nothing is written to the source: every source session runs with
# default_transaction_read_only=on, and only SELECT and pg_dump are used.
#
#   supabase/verify/restore-drill.sh [--keep-dump DIR]
#
# Connection: the Supabase "Session pooler" URI (Dashboard → Connect; port
# 5432 — the transaction pooler on 6543 cannot export a snapshot). It is read
# from RESTORE_SOURCE_URL or with hidden input, never echoed, never put on a
# command line; the password goes into a 0600 PGPASSFILE that is deleted on
# exit. The report contains no credential.
#
# Requires PostgreSQL client + server binaries at least as new as the source
# (17 for the production project); set PGBIN, or run inside the official
# image (no installation, no cost):
#   mkdir -p "$HOME/office-backups"
#   docker run --rm -it -v "$PWD":/w:ro -v "$HOME/office-backups":/backups -w /w postgres:17 \
#     bash supabase/verify/restore-drill.sh --keep-dump /backups
#
# --keep-dump DIR keeps the dump (custom format, mode 0600, directory 0700) as
# an independent copy outside Supabase; otherwise it is deleted with the
# scratch cluster. DIR must be outside this repository and any git work tree.
# Not covered: Supabase-owned schemas (auth, storage, vault, realtime) — rely
# on Supabase's daily backups for those (see docs/V3-OPERATIONAL-CLOSURE-2026-10-28.md).
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "$0")/../.." && pwd)
KEEP_DIR=
while (($#)); do
  case $1 in
    --keep-dump) KEEP_DIR=${2:?--keep-dump needs a directory}; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
# A kept dump holds production data: never inside this repository or any
# other git work tree, where it could be committed and pushed.
if [[ -n $KEEP_DIR ]]; then
  KEEP_DIR=$(realpath -m -- "$KEEP_DIR")
  repo_real=$(cd -- "$ROOT" && pwd -P)
  refuse_keep() { echo "Refusing --keep-dump $KEEP_DIR: $1. Use a private directory outside any git repository (for example \$HOME/office-backups)." >&2; exit 1; }
  [[ $KEEP_DIR == "$repo_real" || $KEEP_DIR == "$repo_real"/* ]] && refuse_keep 'it is inside the Office repository'
  dir=$KEEP_DIR
  while :; do [[ -e $dir/.git ]] && refuse_keep "it is inside the git work tree $dir"; [[ $dir == / ]] && break; dir=$(dirname -- "$dir"); done
  mkdir -p "$KEEP_DIR"; chmod 700 "$KEEP_DIR"
fi
PGBIN=${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}
for tool in initdb pg_ctl psql pg_dump pg_restore; do
  [[ -x "$PGBIN/$tool" ]] || { echo "PostgreSQL binary $tool not found (set PGBIN)" >&2; exit 1; }
done

URL=${RESTORE_SOURCE_URL:-}
if [[ -z $URL ]]; then read -rsp 'Supabase session pooler URI (hidden): ' URL; echo >&2; fi
unset RESTORE_SOURCE_URL
re='^postgres(ql)?://([^:@/]+):([^@]+)@([^:/?]+)(:([0-9]+))?/([^?]+)'
[[ $URL =~ $re ]] || { unset URL; echo 'Not a postgresql://user:password@host:port/db URI; nothing was done.' >&2; exit 1; }
SRC_USER=${BASH_REMATCH[2]}; SRC_PASS=${BASH_REMATCH[3]}; SRC_HOST=${BASH_REMATCH[4]}
SRC_PORT=${BASH_REMATCH[6]:-5432}; SRC_DB=${BASH_REMATCH[7]}
unset URL
urldecode() { local value=${1//+/ }; printf '%b' "${value//%/\\x}"; }
SRC_PASS=$(urldecode "$SRC_PASS"); SRC_USER=$(urldecode "$SRC_USER")

WORK=$(mktemp -d); chmod 700 "$WORK"
RUN=()
if [[ $(id -u) == 0 ]]; then chown postgres "$WORK"; RUN=(runuser -u postgres --); fi
cleanup() {
  [[ -n ${COPROC_PID:-} ]] && kill "$COPROC_PID" 2>/dev/null || true
  "${RUN[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
esc() { local value=${1//\\/\\\\}; printf '%s' "${value//:/\\:}"; }
( umask 077; printf '%s:%s:%s:%s:%s\n' "$(esc "$SRC_HOST")" "$SRC_PORT" "$(esc "$SRC_DB")" "$(esc "$SRC_USER")" "$(esc "$SRC_PASS")" > "$WORK/pgpass" )
[[ ${#RUN[@]} -gt 0 ]] && chown postgres "$WORK/pgpass"
unset SRC_PASS
SRC_ENV=(env PGPASSFILE="$WORK/pgpass" PGHOST="$SRC_HOST" PGPORT="$SRC_PORT" PGUSER="$SRC_USER" PGDATABASE="$SRC_DB"
  PGSSLMODE="${PGSSLMODE:-require}" PGOPTIONS='-c default_transaction_read_only=on' PGAPPNAME=office-restore-drill)
# Application data (public, private) and the migration history. Supabase-owned
# schemas (auth, storage, vault, realtime) are not covered: see the coverage
# section of docs/V3-OPERATIONAL-CLOSURE-2026-10-28.md.
SCHEMAS="'public','private','supabase_migrations'"
COUNT_SQL="select format('select %L || ''|'' || count(*) from %I.%I', n.nspname || '.' || c.relname, n.nspname, c.relname)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r','p') and n.nspname in ($SCHEMAS) order by 1"
started=$(date +%s)
# The drill compares full object text (fingerprint.sql truncates it to 160
# characters for display).
sed 's/left(detail, 160) as detail/detail/' "$ROOT/supabase/verify/fingerprint.sql" > "$WORK/fingerprint.sql"
grep -q 'md5(detail) as hash, detail from' "$WORK/fingerprint.sql" || { echo 'fingerprint.sql changed shape; update restore-drill.sh' >&2; exit 1; }

# 1. Versions: the local tools must be at least as new as the source server.
src_major=$("${RUN[@]}" "${SRC_ENV[@]}" "$PGBIN/psql" -X -A -t -c 'show server_version_num' | cut -c1-2)
local_major=$("$PGBIN/pg_dump" --version | grep -oE '[0-9]+' | head -1)
(( local_major >= src_major )) || { echo "Local PostgreSQL $local_major is older than the source ($src_major); use PostgreSQL $src_major (see the docker line in this file)." >&2; exit 1; }

# 2. One read-only REPEATABLE READ session exports its snapshot, counts every
#    table in it, and stays open while pg_dump reads the same snapshot.
coproc SRC { "${RUN[@]}" "${SRC_ENV[@]}" "$PGBIN/psql" -X -A -t -q -v ON_ERROR_STOP=1 2>&1; }
# Coprocess descriptors do not survive subshells, so answers go to files.
ask() {  # ask OUTFILE SQL
  printf '%s\n\\echo __END__\n' "$2" >&"${SRC[1]}"
  : > "$1"
  local line
  while IFS= read -r line <&"${SRC[0]}"; do
    [[ $line == __END__ ]] && return 0
    printf '%s\n' "$line" >> "$1"
  done
  echo "Source session closed unexpectedly: $(tail -3 "$1")" >&2; return 1
}
ask "$WORK/out" 'begin transaction isolation level repeatable read read only;'
ask "$WORK/out" 'select pg_export_snapshot();'
snapshot=$(cat "$WORK/out")
[[ $snapshot =~ ^[0-9A-F-]+$ ]] || { echo "Could not export a snapshot (use the session pooler, port 5432): $snapshot" >&2; exit 1; }
ask "$WORK/count.sql" "$COUNT_SQL;"
: > "$WORK/source-counts.raw"
while IFS= read -r statement; do
  ask "$WORK/out" "$statement;"
  cat "$WORK/out" >> "$WORK/source-counts.raw"
done < "$WORK/count.sql"
sort "$WORK/source-counts.raw" > "$WORK/source-counts"
ask "$WORK/out" "\\i $WORK/fingerprint.sql"
grep -Ev '^(function_acl|table_acl)\|' "$WORK/out" | sort > "$WORK/source-fingerprint" || true
# Rows that reference hosted auth.users (Supabase-owned, not dumped) need
# stand-in ids before their foreign keys are recreated.
ask "$WORK/auth.sql" "select format('insert into auth.users(id) select distinct %I from %I.%I where %I is not null on conflict do nothing;',
    a.attname, n.nspname, c.relname, a.attname)
  from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
  where k.contype = 'f' and k.confrelid = 'auth.users'::regclass and n.nspname in ($SCHEMAS) order by 1;"
# A schema-filtered dump does not carry publication membership (Realtime).
ask "$WORK/publications.sql" "select format('alter publication %I add table %I.%I;', pubname, schemaname, tablename)
  from pg_publication_tables where pubname = 'supabase_realtime' and schemaname in ($SCHEMAS) order by 1;"
"${RUN[@]}" "${SRC_ENV[@]}" "$PGBIN/pg_dump" --snapshot="$snapshot" --format=custom --no-owner --no-privileges \
  --schema=public --schema=private --schema=supabase_migrations --file="$WORK/office.dump"
ask "$WORK/out" 'commit;'
printf '\\q\n' >&"${SRC[1]}" || true
dump_bytes=$(stat -c %s "$WORK/office.dump")
dump_sha=$(sha256sum "$WORK/office.dump" | cut -d' ' -f1)

# 3. Restore into a scratch cluster with the hosted-Supabase stand-ins.
"${RUN[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres --auth=trust >/dev/null
"${RUN[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-k $WORK -c listen_addresses='' -c wal_level=logical" -l "$WORK/log" -w start >/dev/null
DST=("${RUN[@]}" env -u PGPASSFILE "$PGBIN/psql" -h "$WORK" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1)
"${DST[@]}" -f "$ROOT/supabase/verify/supabase-stubs.sql" >/dev/null
RESTORE=("${RUN[@]}" "$PGBIN/pg_restore" -h "$WORK" -U postgres -d postgres --no-owner --no-privileges)
errors=0
"${RESTORE[@]}" --section=pre-data "$WORK/office.dump" 2>>"$WORK/restore.err" || true
"${RESTORE[@]}" --section=data --disable-triggers "$WORK/office.dump" 2>>"$WORK/restore.err" || true
[[ -s "$WORK/auth.sql" ]] && "${DST[@]}" -f "$WORK/auth.sql" >/dev/null
"${RESTORE[@]}" --section=post-data "$WORK/office.dump" 2>>"$WORK/restore.err" || true
[[ -s "$WORK/publications.sql" ]] && "${DST[@]}" -f "$WORK/publications.sql" >/dev/null
# The scratch cluster already has the public schema; that message is expected.
grep '^pg_restore: error' "$WORK/restore.err" | grep -v 'schema "public" already exists' > "$WORK/restore.errors" || true
errors=$(wc -l < "$WORK/restore.errors")

# 4. Compare with the source snapshot.
"${DST[@]}" -A -t -c "$COUNT_SQL" | while IFS= read -r statement; do "${DST[@]}" -A -t -c "$statement"; done | sort > "$WORK/restored-counts"
"${DST[@]}" -A -t -F '|' -f "$WORK/fingerprint.sql" | grep -Ev '^(function_acl|table_acl)\|' | sort > "$WORK/restored-fingerprint"
# pg_dump re-prints CHECK expressions with fewer redundant parentheses, so
# constraint text is compared without parentheses (and without the md5 of the
# raw text); every other line is compared exactly.
normalize() { awk -F'|' 'BEGIN{OFS="|"} {kind=$1; $1=""; $2=""; line=substr($0,3); if (kind=="constraint") gsub(/[()]/,"",line); print kind "|" line}' "$1" | sort; }
normalize "$WORK/source-fingerprint" > "$WORK/source-fp"; normalize "$WORK/restored-fingerprint" > "$WORK/restored-fp"
tables=$(wc -l < "$WORK/source-counts")
rows=$(awk -F'|' '{s+=$2} END {print s+0}' "$WORK/source-counts")
count_diff=$(diff "$WORK/source-counts" "$WORK/restored-counts" || true)
fp_diff=$(diff "$WORK/source-fp" "$WORK/restored-fp" || true)

if [[ -n $KEEP_DIR ]]; then
  mkdir -p "$KEEP_DIR"
  kept="$KEEP_DIR/office-$(date -u +%Y%m%dT%H%M%SZ).dump"
  ( umask 077; cp "$WORK/office.dump" "$kept" )
  # Inside docker the copy is made by root; give it to the directory's owner.
  chown --reference="$KEEP_DIR" "$kept" 2>/dev/null || true
fi

verdict=PASS
[[ $errors -eq 0 && -z $count_diff && -z $fp_diff && $tables -gt 0 ]] || verdict=FAIL
cat <<REPORT
Office restore drill — $(date -u +%Y-%m-%dT%H:%M:%SZ)
  source server major : $src_major (read-only session, snapshot $snapshot)
  local PostgreSQL    : $local_major
  dump                : $dump_bytes bytes, sha256 $dump_sha${kept:+, kept at $kept}
  tables              : $tables, rows in snapshot: $rows
  restore errors      : $errors
  row-count mismatches: $( [[ -z $count_diff ]] && echo 0 || grep -c '^>' <<<"$count_diff")
  structure mismatches: $( [[ -z $fp_diff ]] && echo 0 || grep -cE '^[<>]' <<<"$fp_diff")
  duration            : $(( $(date +%s) - started ))s
  VERDICT             : $verdict
REPORT
if [[ $verdict == FAIL ]]; then
  [[ $errors -gt 0 ]] && { echo '--- first restore errors ---'; head -20 "$WORK/restore.errors"; }
  [[ -n $count_diff ]] && { echo '--- row counts (< source, > restored) ---'; head -40 <<<"$count_diff"; }
  [[ -n $fp_diff ]] && { echo '--- structure (< source, > restored) ---'; head -40 <<<"$fp_diff"; }
  exit 1
fi
