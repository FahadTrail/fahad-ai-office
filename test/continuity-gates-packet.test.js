import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContinuationPacket, verifyResume } from '../src/continuity/packet.js';
import { runCompletionGates } from '../src/continuity/gates.js';
import { validCheckpoint } from '../testing/fixtures/continuity-harness.js';

test('continuation packet carries branch, diff, tests, privacy and exact action', () => {
  const checkpoint = validCheckpoint({ files_changed: ['a.js'], unresolved_items: ['review x'], privacy_requirements: ['PRIVATE stays private'] });
  const packet = buildContinuationPacket(checkpoint, { doNotTouch: ['src/model-gateway/'] });
  assert.match(packet, /Branch: codex\/continuity-runtime/);
  assert.match(packet, /PRIVATE stays private/);
  assert.match(packet, /Next exact action: Continue the same branch/);
  assert.match(packet, /src\/model-gateway\//);
  assert.deepEqual(verifyResume(checkpoint, { ...checkpoint }), { ok: true, mismatches: [] });
  assert.deepEqual(verifyResume(checkpoint, { ...checkpoint, branch: 'wrong' }).mismatches, ['branch']);
});
test('completion gates require tests, acceptance, CI and a clean tree', async () => {
  const passing = await runCompletionGates({ run: async () => ({ ok: true }), readCi: async () => ({ status: 'success' }), gitStatus: async () => ({ clean: true }), acceptance: [{ name: 'no duplicate edit', check: async () => true }] });
  assert.equal(passing.ok, true);
  const failing = await runCompletionGates({ run: async () => ({ ok: false, detail: '1 failed' }), readCi: async () => ({ status: 'pending' }), gitStatus: async () => ({ clean: false, detail: 'M a.js' }) });
  assert.equal(failing.ok, false);
  assert.equal(failing.failed.length, 3);
  assert.equal(failing.nextExactAction, 'Fix completion gate: node --test');
});
