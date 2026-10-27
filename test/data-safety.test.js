import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { INTEGRITY_TABLES, integrityFindings } from '../src/ops/ops-watch.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('a sharp drop in a core history table is announced as suspected data loss', () => {
  const previous = { at: '2026-10-22T20:00:00Z', counts: { jobs: 124, tasks: 294, events: 3565, conversations: 50 } };
  const current = { counts: { jobs: 0, tasks: 0, events: 31, conversations: 1 } };
  const found = integrityFindings(previous, current);
  assert.deepEqual(found.map((item) => item.key).sort(), ['integrity:conversations:50->1', 'integrity:events:3565->31', 'integrity:jobs:124->0', 'integrity:tasks:294->0']);
  assert.ok(found.every((item) => item.severity === 'high' && /Data loss suspected/.test(item.text)));
});

test('normal growth, single-row deletes and unreadable tables are not data loss', () => {
  const previous = { at: 'x', counts: { jobs: 10, events: 400, conversations: 12 } };
  assert.deepEqual(integrityFindings(previous, { counts: { jobs: 12, events: 380, conversations: 11 } }), [], 'a 20-row drop below the floor is ordinary');
  assert.deepEqual(integrityFindings(previous, { counts: { events: 400 } }), [], 'a table missing from the snapshot is skipped, never read as zero');
  assert.deepEqual(integrityFindings(null, { counts: { jobs: 0 } }), [], 'the first snapshot has nothing to compare');
  assert.ok(INTEGRITY_TABLES.includes('jobs') && INTEGRITY_TABLES.includes('model_attempts'));
});

test('an allowed bulk delete is announced, never silent', () => {
  const found = integrityFindings(null, null, [{ id: 7, payload: { kind: 'bulk_delete_allowed', table: 'jobs', operation: 'delete', rows: 40, role: 'postgres' } }]);
  assert.deepEqual(found.map((item) => [item.key, item.severity]), [['bulk-delete:7', 'medium']]);
  assert.match(found[0].text, /40 rows from public\.jobs by postgres/);
});

test('the bulk-delete guard covers the history tables, is transaction-local, audited and replay-checked', () => {
  const migration = read('supabase/migrations/20261027200000_bulk_delete_guard.sql');
  for (const table of ['jobs', 'tasks', 'runs', 'results', 'events', 'conversations', 'agent_sessions', 'model_attempts', 'tool_executions', 'artifacts']) {
    assert.match(migration, new RegExp(`'${table}'`), table);
  }
  assert.match(migration, /referencing old table as old_rows for each statement/);
  assert.match(migration, /before truncate/);
  assert.match(migration, /v_limit constant int := 25/);
  assert.match(migration, /'bulk_delete_allowed'/);
  assert.match(migration, /revoke all on function private\.guard_bulk_delete\(\) from public, anon, authenticated, service_role/);
  assert.match(read('supabase/verify/scenarios/bulk_delete_guard.sql'), /a 29-row delete was not refused/);
  // The reviewed cleanup opts in for its own transaction only.
  assert.match(read('ops/cleanup/v5.4-test-data-cleanup.sql'), /set_config\('office\.allow_bulk_delete', 'all', true\)/);
});
