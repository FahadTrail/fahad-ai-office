import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeQuotaSources, HandoffHistory, selectWorker } from '../src/continuity/select.js';
import { fakeAdapter } from '../testing/fixtures/continuity-harness.js';

test('worker selection applies enabled, health, privacy, quota and capability hard filters', async () => {
  const workers = [
    { key: 'disabled', enabled: false, quota_source: 'x' },
    { key: 'public', enabled: true, quota_source: 'p' },
    { key: 'private', enabled: true, quota_source: 'q' },
  ];
  const adapters = new Map([
    ['disabled', fakeAdapter('disabled', { quality: 9 })],
    ['public', fakeAdapter('public', { quality: 8, privacyClasses: ['PUBLIC'] })],
    ['private', fakeAdapter('private', { quality: 5, privacyClasses: ['PUBLIC', 'PRIVATE'] })],
  ]);
  const result = await selectWorker({ workers, adapters, task: { dataClass: 'PRIVATE', size: 'medium', capability: 'coding', requiresHeadless: true } });
  assert.equal(result.selected.worker.key, 'private');
  assert.deepEqual(result.evaluated.find((entry) => entry.worker.key === 'disabled').reasons, ['WORKER_DISABLED', 'PRIVACY_MISMATCH']);
  assert.deepEqual(result.evaluated.find((entry) => entry.worker.key === 'public').reasons, ['PRIVACY_MISMATCH']);
});
test('shared quota is counted once and uses the newest snapshot', () => {
  const rows = dedupeQuotaSources([
    { worker_key: 'codex', quota_source: 'openai-chatgpt', session_pct: 20, taken_at: '2026-10-01T10:00:00Z' },
    { worker_key: 'kilo', quota_source: 'openai-chatgpt', session_pct: 40, taken_at: '2026-10-01T11:00:00Z' },
    { worker_key: 'office', quota_source: 'office-pools', session_pct: 10, taken_at: '2026-10-01T10:00:00Z' },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.quota_source === 'openai-chatgpt').worker_key, 'kilo');
});
test('PUBLIC, NORMAL, PRIVATE and CONFIDENTIAL never downgrade the data path', async () => {
  const workers = [
    { key: 'public', enabled: true, quota_source: 'public' },
    { key: 'normal', enabled: true, quota_source: 'normal' },
    { key: 'private', enabled: true, quota_source: 'private' },
    { key: 'confidential', enabled: true, quota_source: 'confidential' },
  ];
  const adapters = new Map([
    ['public', fakeAdapter('public', { privacyClasses: ['PUBLIC'], quality: 9 })],
    ['normal', fakeAdapter('normal', { privacyClasses: ['PUBLIC', 'NORMAL'], quality: 8 })],
    ['private', fakeAdapter('private', { privacyClasses: ['PUBLIC', 'NORMAL', 'PRIVATE'], quality: 7 })],
    ['confidential', fakeAdapter('confidential', { privacyClasses: ['PUBLIC', 'NORMAL', 'PRIVATE', 'CONFIDENTIAL'], quality: 6 })],
  ]);
  for (const [dataClass, expected] of [['PUBLIC', 'public'], ['NORMAL', 'normal'], ['PRIVATE', 'private'], ['CONFIDENTIAL', 'confidential']]) {
    const selected = await selectWorker({ workers, adapters, task: { dataClass, size: 'medium', capability: 'coding' } });
    assert.equal(selected.selected.worker.key, expected);
    assert.ok(selected.evaluated.filter((item) => item.eligible).every((item) => item.capabilities.privacyClasses.includes(dataClass)));
  }
  const noEligible = await selectWorker({ workers: workers.slice(0, 3), adapters, task: { dataClass: 'CONFIDENTIAL', size: 'medium', capability: 'coding' } });
  assert.equal(noEligible.selected, null);
  assert.equal(noEligible.blocker, 'NO_ELIGIBLE_WORKER');
});
test('Codex and ChatGPT-signed Kilo share one source; Antigravity and Gemini API remain separate', () => {
  const rows = dedupeQuotaSources([
    { worker_key: 'codex', quota_source: 'openai-chatgpt', taken_at: '2026-10-01T10:00:00Z' },
    { worker_key: 'kilo', quota_source: 'openai-chatgpt', taken_at: '2026-10-01T11:00:00Z' },
    { worker_key: 'antigravity', quota_source: 'google-ai-pro', taken_at: '2026-10-01T11:00:00Z' },
    { worker_key: 'gemini-api', quota_source: 'gemini-api', taken_at: '2026-10-01T11:00:00Z' },
  ]);
  assert.deepEqual(rows.map((row) => row.quota_source).sort(), ['gemini-api', 'google-ai-pro', 'openai-chatgpt']);
  assert.equal(rows.find((row) => row.quota_source === 'openai-chatgpt').worker_key, 'kilo');
});
test('anti-thrashing stops A-B-A-B without meaningful progress', async () => {
  const history = new HandoffHistory();
  history.add({ from: 'a', to: 'b', reason: 'limit', lastCommit: '1', checkpointId: '1' });
  history.add({ from: 'b', to: 'a', reason: 'limit', lastCommit: '1', checkpointId: '2' });
  history.add({ from: 'a', to: 'b', reason: 'limit', lastCommit: '1', checkpointId: '3' });
  history.add({ from: 'b', to: 'a', reason: 'limit', lastCommit: '1', checkpointId: '4' });
  const result = await selectWorker({ workers: [{ key: 'a', enabled: true }], adapters: new Map([['a', fakeAdapter('a')]]), task: { dataClass: 'PUBLIC', size: 'medium' }, history });
  assert.equal(result.selected, null);
  assert.equal(result.blocker, 'HANDOFF_LOOP_DETECTED');
});
