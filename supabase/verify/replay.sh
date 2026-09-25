#!/usr/bin/env bash
# Replays supabase/migrations into a throwaway local PostgreSQL and prints the
# structural fingerprint. Compare it with the same fingerprint read from
# production to prove the repository reproduces the live schema.
#   supabase/verify/replay.sh [output-file]
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "$0")/../.." && pwd)
PGBIN=${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}
[[ -x "$PGBIN/initdb" ]] || { echo 'PostgreSQL server binaries not found (set PGBIN)' >&2; exit 1; }
WORK=$(mktemp -d)
RUN=()
if [[ $(id -u) == 0 ]]; then chown postgres "$WORK"; RUN=(runuser -u postgres --); fi
cleanup() { "${RUN[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
"${RUN[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres --auth=trust >/dev/null
"${RUN[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-k $WORK -c listen_addresses='' -c wal_level=logical" -l "$WORK/log" -w start >/dev/null
PSQL=("${RUN[@]}" "$PGBIN/psql" -h "$WORK" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1)
"${PSQL[@]}" -f "$ROOT/supabase/verify/supabase-stubs.sql" >/dev/null
for file in "$ROOT"/supabase/migrations/*.sql; do
  "${PSQL[@]}" -1 -f "$file" >/dev/null 2>"$WORK/err" || { echo "FAILED: $(basename "$file")" >&2; cat "$WORK/err" >&2; exit 1; }
done
for file in "$ROOT"/supabase/verify/scenarios/*.sql; do
  [[ -e "$file" ]] || continue
  { echo 'begin;'; cat "$file"; echo 'rollback;'; } > "$WORK/scenario.sql"
  "${PSQL[@]}" -f "$WORK/scenario.sql" >/dev/null 2>"$WORK/err" || { echo "SCENARIO FAILED: $(basename "$file")" >&2; cat "$WORK/err" >&2; exit 1; }
done
OUT=${1:-/dev/stdout}
"${PSQL[@]}" -A -t -F '|' -f "$ROOT/supabase/verify/fingerprint.sql" > "$WORK/fp"
cat "$WORK/fp" > "$OUT"
echo "Replayed $(ls "$ROOT"/supabase/migrations/*.sql | wc -l) migrations" >&2
