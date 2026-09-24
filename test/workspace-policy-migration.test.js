import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const file = readdirSync(new URL('../supabase/migrations/', import.meta.url))
  .find((name) => name.endsWith('_workspace_policy_foundation.sql'));
const sql = file ? readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8').toLowerCase() : '';
const fixFile = readdirSync(new URL('../supabase/migrations/', import.meta.url))
  .find((name) => name.endsWith('_fix_workspace_budget_reservation_ambiguity.sql'));
const fixSql = fixFile ? readFileSync(new URL(`../supabase/migrations/${fixFile}`, import.meta.url), 'utf8').toLowerCase() : '';
const lineageFile = readdirSync(new URL('../supabase/migrations/', import.meta.url))
  .find((name) => name.endsWith('_propagate_workspace_lineage_to_task_claim.sql'));
const lineageSql = lineageFile ? readFileSync(new URL(`../supabase/migrations/${lineageFile}`, import.meta.url), 'utf8').toLowerCase() : '';

test('workspace policy migration is service-only and stores opaque secret references', () => {
  assert.ok(file);
  for (const table of ['workspace_policies', 'workspace_provider_permissions', 'workspace_tool_grants', 'workspace_budget_reservations']) {
    assert.match(sql, new RegExp(`create table public\\.${table}`));
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated, service_role`));
  }
  assert.match(sql, /secret_ref text not null/);
  assert.match(sql, /env:\/\//);
  assert.doesNotMatch(sql, /secret_value|api_key\s+text|prompt\s+text|response_body/);
});

test('budget reservation is atomic, idempotent and service-role-only', () => {
  assert.match(sql, /create function public\.reserve_workspace_budget/);
  assert.match(sql, /for update/);
  assert.match(sql, /unique \(workspace_id, idempotency_key\)/);
  assert.match(sql, /create function public\.settle_workspace_budget/);
  assert.match(sql, /security invoker/);
  assert.match(sql, /revoke execute on function public\.reserve_workspace_budget[\s\S]*from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.reserve_workspace_budget[\s\S]*to service_role/);
  assert.match(sql, /update public\.workspace_policies as p[\s\S]*set reserved_usd = p\.reserved_usd \+ p_requested_usd/);
  assert.ok(fixFile);
  assert.match(fixSql, /create or replace function public\.reserve_workspace_budget/);
  assert.match(fixSql, /set reserved_usd = p\.reserved_usd \+ p_requested_usd/);
  assert.match(fixSql, /revoke execute on function public\.reserve_workspace_budget[\s\S]*from public, anon, authenticated/);
  assert.match(fixSql, /grant execute on function public\.reserve_workspace_budget[\s\S]*to service_role/);
});

test('model-attempt lineage trigger prevents cross-workspace records', () => {
  assert.match(sql, /create function public\.assert_workspace_execution_context/);
  assert.match(sql, /j\.project_id = p_workspace/);
  assert.match(sql, /create trigger model_attempts_workspace_guard/);
  assert.match(sql, /cross_workspace_access_denied/);
});

test('task claims propagate project lineage into every model request', () => {
  assert.ok(lineageFile);
  assert.match(lineageSql, /create or replace function private\.claim_next_task/);
  assert.match(lineageSql, /select t\.\* into v_task/);
  assert.match(lineageSql, /select j\.project_id into v_workspace/);
  assert.match(lineageSql, /'project_id', v_workspace/);
  assert.match(lineageSql, /for update of t skip locked/);
  assert.match(lineageSql, /set search_path = ''/);
  assert.match(lineageSql, /revoke execute on function private\.claim_next_task\(text\) from public, anon, authenticated/);
});
