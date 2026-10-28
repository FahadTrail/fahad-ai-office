import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { INTEGRITY_TABLES, integrityFindings, stuckObjectives } from '../src/ops/ops-watch.js';

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
  assert.match(migration, /v_direct <= 25 and v_cascaded <= 1000/, 'direct statements 25 rows, cascades 1000');
  assert.match(migration, /c\.confdeltype = 'c'/, 'cascaded rows are recognised by their ON DELETE CASCADE parent');
  assert.match(migration, /split_part\(v_value, '@', 2\) <> txid_current\(\)::text/, 'the opt-in is bound to the current transaction');
  assert.match(migration, /create table private\.bulk_delete_audit/);
  assert.match(migration, /BULK_DELETE_AUDIT_APPEND_ONLY/);
  assert.match(migration, /'bulk_delete_allowed'/);
  assert.match(migration, /revoke all on function private\.guard_bulk_delete\(\) from public, anon, authenticated, service_role/);
  const scenario = read('supabase/verify/scenarios/bulk_delete_guard.sql');
  for (const check of ['a 29-row delete was not refused', 'the single-job cascade did not complete', 'an opt-in without the transaction id opened the guard', 'the audit could be deleted']) assert.ok(scenario.includes(check), check);
  // The reviewed cleanup opts in for its own transaction only.
  assert.match(read('ops/cleanup/v5.4-test-data-cleanup.sql'), /set_config\('office\.allow_bulk_delete', 'all@' \|\| txid_current\(\)::text, true\)/);
});

test('a running objective with nothing claimable is announced once its grace period passes', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  const jobs = [
    { id: 'a', title: 'Stuck plan', status: 'running', created_at: '2026-10-27T10:00:00Z' },
    { id: 'b', title: 'Working', status: 'running', created_at: '2026-10-27T10:00:00Z' },
    { id: 'c', title: 'Just started', status: 'planning', created_at: '2026-10-27T11:50:00Z' },
  ];
  const tasks = [{ job_id: 'a', status: 'done' }, { job_id: 'a', status: 'failed' }, { job_id: 'b', status: 'queued' }];
  assert.deepEqual(stuckObjectives({ jobs, tasks, now }).map((item) => item.key), ['stuck:a']);
});

test('a drop covered by an approved, audited bulk delete is reported as a cleanup, not data loss', () => {
  const previous = { at: '2026-11-01T10:00:00Z', counts: { jobs: 120, events: 3000 } };
  const current = { counts: { jobs: 0, events: 40 } };
  const approved = [{ id: 9, payload: { kind: 'bulk_delete_allowed', table: 'jobs', operation: 'delete', rows: 120, role: 'postgres' } }];
  const keys = integrityFindings(previous, current, approved).map((item) => [item.key, item.severity]);
  assert.deepEqual(keys, [['cleanup:jobs:120->0', 'medium'], ['integrity:events:3000->40', 'high'], ['bulk-delete:9', 'medium']],
    'jobs was approved; events was not named in the opt-in, so its drop is still suspected data loss');
});
