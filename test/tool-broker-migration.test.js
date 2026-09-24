import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const file = readdirSync(new URL('../supabase/migrations/', import.meta.url))
  .find((name) => name.endsWith('_tool_broker_mcp_foundation.sql'));
const sql = file ? readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8').toLowerCase() : '';

test('Tool Broker audit is service-only, RLS protected and excludes sensitive payloads', () => {
  assert.ok(file);
  assert.match(sql, /create table public\.tool_executions/);
  assert.match(sql, /alter table public\.tool_executions enable row level security/);
  assert.match(sql, /revoke all on table public\.tool_executions from public, anon, authenticated, service_role/);
  assert.match(sql, /grant select, insert, update on table public\.tool_executions to service_role/);
  assert.doesNotMatch(sql, /arguments\s+(?:json|jsonb|text)|result_body|prompt\s+text|secret_value|api_key\s+text/);
  assert.match(sql, /result_sha256/);
  assert.match(sql, /output_bytes/);
});

test('execution lineage and agent ownership fail closed in the database', () => {
  assert.match(sql, /create function public\.enforce_tool_execution_workspace/);
  assert.match(sql, /perform public\.assert_workspace_execution_context/);
  assert.match(sql, /r\.agent_id = new\.agent_id/);
  assert.match(sql, /tool_agent_lineage_denied/);
  assert.match(sql, /create trigger tool_executions_workspace_guard/);
});

test('begin and finish RPCs use short row locks and durable idempotency', () => {
  assert.match(sql, /unique \(workspace_id, idempotency_key\)/);
  assert.match(sql, /create function public\.begin_tool_execution/);
  assert.match(sql, /on conflict \(workspace_id, idempotency_key\) do nothing/);
  assert.match(sql, /get diagnostics v_inserted_count = row_count/);
  assert.match(sql, /for update/);
  assert.match(sql, /'in_progress'::text/);
  assert.match(sql, /'replay'::text/);
  assert.match(sql, /create function public\.finish_tool_execution/);
  assert.match(sql, /security invoker/);
  assert.match(sql, /set search_path = ''/);
});

test('risk, decision, retry, cost and opaque secret metadata are constrained', () => {
  assert.match(sql, /risk text not null check \(risk in \('low', 'medium', 'high', 'critical'\)\)/);
  assert.match(sql, /decision text not null check \(decision in \('auto', 'approval', 'deny'\)\)/);
  assert.match(sql, /max_retries smallint not null default 0 check \(max_retries between 0 and 3\)/);
  assert.match(sql, /cost_usd numeric\(16, 8\).*cost_usd <= 0\.1/);
  assert.match(sql, /alter table public\.workspace_tool_grants[\s\S]*add column secret_ref text/);
  assert.match(sql, /env:\/\//);
  assert.match(sql, /vault:\/\//);
});

test('Tool Broker RPCs are callable only by service_role', () => {
  assert.match(sql, /revoke execute on function public\.begin_tool_execution[\s\S]*from public, anon, authenticated, service_role/);
  assert.match(sql, /revoke execute on function public\.finish_tool_execution[\s\S]*from public, anon, authenticated, service_role/);
  assert.match(sql, /grant execute on function public\.begin_tool_execution[\s\S]*to service_role/);
  assert.match(sql, /grant execute on function public\.finish_tool_execution[\s\S]*to service_role/);
});
