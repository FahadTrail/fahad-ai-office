// Coding Continuity Supervisor, Phase A: continuity.checkpoint.v1 validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkpointToMarkdown, validateCheckpoint } from '../src/continuity/checkpoint.js';

const valid = () => ({
  schema: 'continuity.checkpoint.v1',
  timestamp: '2026-10-01T12:00:00Z',
  repository: 'FahadTrail/fahad-ai-office',
  branch: 'claude/continuity-foundation',
  agent_id: 'claude-code',
  agent_type: 'cli',
  session_id: 'session-1',
  objective: 'Build Phase A of the Coding Continuity Supervisor.',
  phase: 'A',
  status: 'HANDOFF_READY',
  base_commit: 'a'.repeat(40),
  last_commit: 'b'.repeat(40),
  rollback_commit: 'a'.repeat(40),
  files_changed: ['src/continuity/states.js'],
  tests_run: 'node --test',
  tests_passed: 10,
  tests_failed: 0,
  ci_status: 'pending',
  decisions: ['coding_ prefix for new tables'],
  errors: [],
  quota_state: { basis: 'UNKNOWN', used_pct: null, reset_at: null },
  next_exact_action: 'Review the Phase A PR.',
  unresolved_items: [],
});
const ENV = {};

test('checkpoint: a complete v1 checkpoint is valid', () => {
  assert.deepEqual(validateCheckpoint(valid(), { env: ENV }), { ok: true, errors: [] });
});

test('checkpoint: missing fields, bad hashes, bad basis and a missing next action are named', () => {
  const missing = valid();
  delete missing.objective;
  delete missing.files_changed;
  assert.deepEqual(validateCheckpoint(missing, { env: ENV }).errors, ['objective: required', 'files_changed: required list']);
  assert.deepEqual(validateCheckpoint({ ...valid(), schema: 'continuity.checkpoint.v0' }, { env: ENV }).errors, ['schema: must be continuity.checkpoint.v1']);
  for (const commit of ['abc123', 'B'.repeat(40), 'g'.repeat(40), null]) {
    assert.deepEqual(validateCheckpoint({ ...valid(), last_commit: commit }, { env: ENV }).errors, ['last_commit: must be a 40-character lowercase git commit']);
  }
  assert.deepEqual(validateCheckpoint({ ...valid(), quota_state: { basis: 'GUESSED' } }, { env: ENV }).errors,
    ['quota_state.basis: one of MEASURED, PROVIDER_REPORTED, ESTIMATED, UNKNOWN']);
  assert.deepEqual(validateCheckpoint({ ...valid(), quota_state: { basis: 'UNKNOWN', used_pct: 92 } }, { env: ENV }).errors,
    ['quota_state.used_pct: must be null when basis is UNKNOWN'], 'no invented percentage');
  for (const action of [undefined, '', '   ']) {
    assert.deepEqual(validateCheckpoint({ ...valid(), next_exact_action: action }, { env: ENV }).errors, ['next_exact_action: required']);
  }
  assert.deepEqual(validateCheckpoint({ ...valid(), status: 'DONE', agent_type: 'bot', ci_status: 'green' }, { env: ENV }).errors,
    ['agent_type: one of native, cli, manual', 'status: unknown state', 'ci_status: one of success, failure, pending, none']);
  assert.equal(validateCheckpoint(null).ok, false);
  assert.equal(validateCheckpoint([]).ok, false);
});

test('checkpoint: secret-like values are refused (shared project detector)', () => {
  const token = `ghp_${'x'.repeat(30)}`;
  assert.deepEqual(validateCheckpoint({ ...valid(), errors: [`push failed with ${token}`] }, { env: ENV }).errors, ['secret: credential-shaped token found; remove it']);
  const configured = { ANTHROPIC_API_KEY: 'configured-value-123456' };
  assert.deepEqual(validateCheckpoint({ ...valid(), decisions: ['use configured-value-123456'] }, { env: configured }).errors, ['secret: configured credential value found; remove it']);
});

test('checkpoint: markdown carries the next action, commits and basis', () => {
  const text = checkpointToMarkdown(valid());
  assert.match(text, /\*\*Next exact action:\*\* Review the Phase A PR\./);
  assert.match(text, /last `b{40}`/);
  assert.match(text, /Quota:\*\* unknown \(UNKNOWN\)/);
  assert.match(text, /node --test → 10 passed, 0 failed/);
  assert.match(text, /### Unresolved\n- none/);
});

test('checkpoint: the committed handover checkpoint is valid', () => {
  const file = JSON.parse(readFileSync(new URL('../.continuity/checkpoint.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateCheckpoint(file, { env: ENV }).errors, []);
  assert.equal(file.repository, 'FahadTrail/fahad-ai-office');
});
