#!/usr/bin/env bash
# Proves ops/cleanup/v5.4-test-data-cleanup.sql against a throwaway local
# PostgreSQL. It never connects to Supabase or production.
#   bash ops/cleanup/verify-v5.4-cleanup.sh
# Steps:
#   1. Replay every migration into a fresh database.
#   2. Load synthetic rows shaped exactly like the manifest
#      (v5.4-cleanup-fixture.sql), plus rows that must survive.
#   3. Run the script in preview mode, then through refused and drifted
#      cases, then apply the recommended groups.
#   4. Check that only the listed test rows went.
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "$0")/../.." && pwd)
SCRIPT="$ROOT/ops/cleanup/v5.4-test-data-cleanup.sql"
FIXTURE="$ROOT/ops/cleanup/v5.4-cleanup-fixture.sql"
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

block() { sed -n "/^-- MANIFEST $1 BEGIN/,/^-- MANIFEST $1 END/p" "$SCRIPT"; }
{
  echo 'create schema fixture; set search_path = fixture, public;'
  echo 'create table v54_jobs (job_id uuid primary key, grp text not null, evidence boolean not null, project_id uuid, created_at timestamptz not null, tasks integer not null, runs integer not null, model_attempts integer not null, tool_executions integer not null, agent_sessions integer not null, knowledge_items integer not null);'
  echo 'create table v54_conversations (conversation_id uuid primary key, grp text not null);'
  echo 'create table v54_continuity (task_id uuid primary key, idempotency_key text not null, checkpoints integer not null, events integer not null, handoffs integer not null, usage integer not null);'
  block JOBS; block CONVERSATIONS; block CONTINUITY
  echo 'reset search_path;'
  cat "$FIXTURE"
} > "$WORK/fixture.sql"
"${PSQL[@]}" -1 -f "$WORK/fixture.sql" >/dev/null 2>"$WORK/err" || { echo 'FIXTURE FAILED' >&2; cat "$WORK/err" >&2; exit 1; }

TABLES="projects workspace_policies workspace_provider_permissions workspace_tool_grants deliverable_reviews conversations jobs tasks runs results events handoffs artifacts model_attempts tool_executions agent_sessions agent_events agent_checkpoints knowledge_items continuity_tasks continuity_checkpoints continuity_events continuity_handoffs continuity_usage"
snapshot() {
  local sql="select concat_ws(' '" t
  for t in $TABLES; do sql+=", '$t=' || (select count(*) from public.$t)"; done
  "${PSQL[@]}" -A -t -c "$sql)"
}
q() { "${PSQL[@]}" -A -t -c "$1"; }
fail() { echo "FAIL: $*" >&2; [[ -f "$WORK/out" ]] && cat "$WORK/out" >&2; exit 1; }
# run <ok|stop> <expected text> [setting ...]
run() {
  local expect=$1 pattern=$2 status args=(); shift 2
  for setting in "$@"; do args+=(-c "set $setting"); done
  if "${PSQL[@]}" "${args[@]}" -f "$SCRIPT" >"$WORK/out" 2>&1; then status=ok; else status=stop; fi
  [[ $status == "$expect" ]] || fail "expected $expect, got $status ($*)"
  grep -qF -- "$pattern" "$WORK/out" || fail "missing \"$pattern\" ($*)"
  echo "ok   $expect: ${*:-preview}"
}

BEFORE=$(snapshot)
run ok 'PREVIEW ONLY: nothing was deleted'
grep -qF 'Jobs selected: 53   evidence rows held back: 14' "$WORK/out" || fail 'preview selects 53 jobs and holds 14 evidence rows'
grep -qF "set cleanup.groups = 'A,B,C,P', cleanup.expect_jobs = '53'" "$WORK/out" || fail 'preview prints the apply settings'
[[ $(snapshot) == "$BEFORE" ]] || fail 'preview changed rows'

run ok 'Jobs selected: 81   evidence rows held back: 0' "cleanup.groups = 'A,B,C,D,P'" "cleanup.include_evidence = 'yes'"
run stop 'needs an explicit cleanup.groups list' "cleanup.apply = 'yes'"
run stop 'may only list A, B, C, D and P' "cleanup.groups = 'A,X'"
run stop 'must equal the selected job count (53)' "cleanup.groups = 'A,B,C,P'" "cleanup.apply = 'yes'" "cleanup.expect_jobs = '52'"
run stop 'must equal the selected job count (53)' "cleanup.groups = 'A,B,C,P'" "cleanup.apply = 'yes'"
[[ $(snapshot) == "$BEFORE" ]] || fail 'refused runs changed rows'

# Drift: a listed job gained a task since the manifest.
q "insert into public.tasks (job_id, agent_id, title, status) values ('221b3c38-37c3-4147-9faf-d5d4ff726bae', (select id from public.agents where slug = 'chief-of-staff'), 'late task', 'done');"
run stop 'these jobs no longer match the manifest: 221b3c38' "cleanup.groups = 'A,B,C,P'" "cleanup.apply = 'yes'" "cleanup.expect_jobs = '53'"
q "delete from public.tasks where title = 'late task';"
# Activity in the last hour.
q "insert into public.events (job_id, type, level, message, payload) values ('6adc823b-6172-4358-91ed-f42aab3f0b76', 'activity', 'info', 'recent', '{}');"
run stop 'active in the last hour' "cleanup.groups = 'C'"
q "delete from public.events where message = 'recent';"
# A live lease on a selected coding session.
q "update public.agent_sessions set lease_expires_at = now() + interval '5 minutes' where job_id = '4e14eabc-cfa8-4b11-852c-832535a9d1bd';"
run stop 'holds a lease' "cleanup.groups = 'C'"
q "update public.agent_sessions set lease_expires_at = null where job_id = '4e14eabc-cfa8-4b11-852c-832535a9d1bd';"
# A kept objective launched a selected coding session.
q "insert into public.events (job_id, type, level, message, payload, created_at) select 'f45e3086-631a-45b9-bbb1-8fd5019c2023', 'activity', 'info', 'cross launch', jsonb_build_object('kind', 'task_launched', 'session_id', id), now() - interval '2 days' from public.agent_sessions where job_id = '4e14eabc-cfa8-4b11-852c-832535a9d1bd';"
run stop 'a kept job launched a selected session' "cleanup.groups = 'C'"
q "delete from public.events where message = 'cross launch';"
# A kept objective joined a listed conversation.
q "update public.jobs set conversation_id = 'df05337e-95d8-45a7-a2dd-1890d9cae6a3' where id = 'f45e3086-631a-45b9-bbb1-8fd5019c2023';"
run stop 'these conversations hold rows outside the selection: df05337e' "cleanup.groups = 'B'"
q "update public.jobs set conversation_id = 'd25764ca-233d-4821-89e6-4c6cc396f805' where id = 'f45e3086-631a-45b9-bbb1-8fd5019c2023';"
# A new objective in the certification project.
q "insert into public.jobs (project_id, goal, status) values ('09627575-684a-4c8f-b21b-e25bcf6ed65f', 'late objective', 'completed');"
run stop 'the certification project holds rows outside the selection: jobs' "cleanup.groups = 'A'"
q "delete from public.jobs where goal = 'late objective';"
# A Continuity proof-of-concept task changed.
q "insert into public.continuity_events (task_id, type, message) values ('f4b57e4b-b20a-4f9f-bd40-02b7e66b9bcf', 'progress', 'late event');"
run stop 'these Continuity tasks no longer match the manifest: f4b57e4b' "cleanup.groups = 'P'"
q "delete from public.continuity_events where message = 'late event';"
[[ $(snapshot) == "$BEFORE" ]] || fail 'the drift checks left rows behind'

# Apply the recommended groups.
KNOWLEDGE_LINKED=$(q "select count(*) from public.knowledge_items where project_id = '2ae856da-00cb-4594-a7e6-710f2011d0c3' and job_id in (select job_id from fixture.v54_jobs where grp in ('B', 'C') and not evidence);")
run ok 'APPLIED: 53 test objectives removed' "cleanup.groups = 'A,B,C,P'" "cleanup.expect_jobs = '53'" "cleanup.apply = 'yes'"
[[ $(q "select count(*) from public.jobs where id in (select job_id from fixture.v54_jobs where not evidence);") == 0 ]] || fail 'selected jobs remain'
[[ $(q "select count(*) from public.jobs where id in (select job_id from fixture.v54_jobs where evidence);") == 28 ]] || fail 'evidence jobs must stay'
[[ $(q "select count(*) from public.jobs where id in (select job_id from fixture.fx_kept_jobs);") == 3 ]] || fail 'REAL and UNCERTAIN jobs must stay'
[[ $(q "select count(*) from public.agent_sessions where job_id in (select job_id from fixture.fx_kept_jobs);") == 1 ]] || fail 'the kept coding session must stay'
[[ $(q "select count(*) from public.events where payload->>'kind' = 'task_launched';") == 1 ]] || fail 'the kept launch event must stay'
[[ $(q "select count(*) from public.projects where id = '09627575-684a-4c8f-b21b-e25bcf6ed65f';") == 0 ]] || fail 'the certification project must go'
[[ $(q "select count(*) from public.workspace_policies where workspace_id = '09627575-684a-4c8f-b21b-e25bcf6ed65f';") == 0 ]] || fail 'its workspace policy must go'
[[ $(q "select count(*) from public.deliverable_reviews;") == 0 ]] || fail 'the neutral review row must go'
[[ $(q "select count(*) from public.projects where id = '2ae856da-00cb-4594-a7e6-710f2011d0c3';") == 1 ]] || fail 'the main project must stay'
[[ $(q "select count(*) from public.workspace_policies where workspace_id = '2ae856da-00cb-4594-a7e6-710f2011d0c3';") == 1 ]] || fail 'the main workspace policy must stay'
[[ $(q "select count(*) from public.conversations where id in (select conversation_id from fixture.v54_conversations);") == 0 ]] || fail 'listed conversations must go'
[[ $(q "select count(*) from public.conversations where id in ('d25764ca-233d-4821-89e6-4c6cc396f805', '993d4761-917a-48d5-9142-dbabccfce3b3');") == 2 ]] || fail 'kept conversations must stay'
[[ $(q "select count(*) from public.continuity_tasks;") == 1 ]] || fail 'only the kept Continuity task stays'
[[ $(q "select count(*) from public.knowledge_items where job_id is null;") == "$KNOWLEDGE_LINKED" ]] || fail 'knowledge items of removed jobs stay, unlinked'
[[ $(q "select count(*) from public.knowledge_items where project_id = '09627575-684a-4c8f-b21b-e25bcf6ed65f';") == 0 ]] || fail 'certification knowledge must go'
[[ $(q "select (payload->>'removedModelCostUsd')::numeric > 0 and payload->'removed'->>'jobs' = '53' from public.events where payload->>'kind' = 'test_data_cleanup';") == t ]] || fail 'one audit event with counts and removed cost'
echo 'ok   apply: 53 jobs removed; evidence, REAL and UNCERTAIN rows kept'

run stop 'nothing left to remove in groups A,B,C' "cleanup.groups = 'A,B,C'"
run ok 'APPLIED: 28 test objectives removed' "cleanup.groups = 'B,C,D'" "cleanup.include_evidence = 'yes'" "cleanup.expect_jobs = '28'" "cleanup.apply = 'yes'"
[[ $(q "select count(*) from public.jobs;") == 3 ]] || fail 'only REAL and UNCERTAIN jobs remain'
echo 'V5.4 cleanup script verified on a throwaway database.'
