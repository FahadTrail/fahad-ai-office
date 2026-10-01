import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageTracker } from '../src/continuity/usage.js';

test('usage snapshots preserve basis, metadata and shared-source deduplication', async () => {
  const rows = [];
  const tracker = new UsageTracker({ store: { writeUsageSnapshot: async (row) => { rows.push(row); return row; } }, env: {}, now: () => new Date('2026-10-01T12:00:00Z') });
  await tracker.capture({ workerKey: 'codex', quotaSource: 'openai-chatgpt', basis: 'PROVIDER_REPORTED', sessionPct: 20, taskTokens: 100, raw: { repository: 'x/y', turns: 2 } });
  await tracker.capture({ workerKey: 'kilo', quotaSource: 'openai-chatgpt', basis: 'PROVIDER_REPORTED', sessionPct: 30, taskTokens: 120, raw: { repository: 'x/y', turns: 3 } });
  assert.equal(tracker.capacityBySource(rows).length, 1);
  assert.equal(tracker.capacityBySource(rows)[0].usedPct, 20, 'equal timestamps keep the first observation deterministically');
  await assert.rejects(tracker.capture({ workerKey: 'x', quotaSource: 'x', basis: 'UNKNOWN', sessionPct: 80 }), /invented/);
  await assert.rejects(tracker.capture({ workerKey: 'x', quotaSource: 'x', raw: { token: `ghp_${'x'.repeat(30)}` } }), /SECRET_MATERIAL/);
});
