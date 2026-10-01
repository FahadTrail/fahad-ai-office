import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ContinuityCheckpointer } from '../src/continuity/checkpointer.js';

const payload = () => ({
  schema: 'continuity.checkpoint.v1', timestamp: '2026-10-01T12:00:00Z', repository: 'FahadTrail/fahad-ai-office',
  branch: 'codex/continuity-runtime', worktree: null, agent_id: 'codex', agent_type: 'cli', session_id: 'session-1',
  objective: 'Complete the continuity runtime.', phase: 'B', status: 'ACTIVE', base_commit: 'a'.repeat(40), last_commit: 'b'.repeat(40),
  files_changed: ['src/continuity/store.js'], diff_summary: 'Store and lease engine.', tests_run: 'node --test test/continuity-lease.test.js',
  tests_passed: 3, tests_failed: 0, ci_status: 'none', decisions: [], constraints: [], errors: [],
  quota_state: { basis: 'UNKNOWN', used_pct: null, reset_at: null }, rate_limit_state: { limited: false, retry_after_s: null },
  next_exact_action: 'Build the Supervisor controller.', unresolved_items: [], rollback_commit: 'a'.repeat(40), summary_md: 'Phase B in progress.',
  data_class: 'PUBLIC', privacy_requirements: ['Do not downgrade privacy'], active_provider: null, active_model: null, handoff_reason: null,
});
test('checkpointer: turn and time intervals fire whichever comes first', async () => {
  let now = 0;
  const writes = [];
  const cp = new ContinuityCheckpointer({
    store: { saveCheckpoint: async (_id, _token, value) => { writes.push(value); return { id: `cp-${writes.length}`, payload: value }; } },
    lease: { id: 'lease', token: 'token' }, clock: { now: () => now }, writeMirror: async () => {}, env: {},
  });
  for (let i = 0; i < 9; i += 1) assert.equal(cp.noteTurn(), false);
  assert.equal(cp.noteTurn(), true);
  assert.equal((await cp.maybeSave(payload)).reason, 'turn_interval');
  now += 15 * 60_000;
  assert.equal((await cp.maybeSave(payload)).reason, 'time_interval');
  assert.equal(writes.length, 2);
});

test('checkpointer: milestone saves immediately and mirror equals stored payload', async () => {
  const directory = join(tmpdir(), `fahad-continuity-${randomUUID()}`);
  const path = join(directory, '.continuity', 'checkpoint.json');
  let stored;
  const cp = new ContinuityCheckpointer({
    store: { saveCheckpoint: async (_id, _token, value) => { stored = structuredClone(value); return { id: 'cp-1', payload: value }; } },
    lease: { id: 'lease', token: 'token' }, mirrorPath: path, clock: { now: () => 0 }, env: {},
  });
  const saved = await cp.maybeSave(payload, { event: 'milestone' });
  assert.equal(saved.saved, true);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), stored);
  await rm(directory, { recursive: true, force: true });
});

test('checkpointer: invalid or rejected persistence never writes a mirror', async () => {
  let mirrored = false;
  const cp = new ContinuityCheckpointer({
    store: { saveCheckpoint: async () => { throw new Error('database unavailable'); } },
    lease: { id: 'lease', token: 'token' }, writeMirror: async () => { mirrored = true; }, clock: { now: () => 0 }, env: {},
  });
  await assert.rejects(cp.save(payload()), /database unavailable/);
  assert.equal(mirrored, false);
  await assert.rejects(cp.save({ ...payload(), next_exact_action: '' }), /CHECKPOINT_INVALID/);
  assert.equal(mirrored, false);
});
