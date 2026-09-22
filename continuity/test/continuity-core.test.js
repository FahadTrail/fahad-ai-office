import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, FAILURE, retryAfterMs, CostTracker, ProgressGuard, newTaskEnvelope, validateTaskEnvelope } from '../src/continuity-core.js';

test('failure classifier distinguishes retry, failover and human approval classes', () => {
  assert.equal(classifyFailure({ status: 429 }), FAILURE.RATE_LIMIT);
  assert.equal(classifyFailure({ status: 503 }), FAILURE.TRANSIENT);
  assert.equal(classifyFailure({ status: 402 }), FAILURE.BILLING);
  assert.equal(classifyFailure({ status: 401 }), FAILURE.AUTH);
  assert.equal(retryAfterMs({ retryAfter: '2' }), 2000);
});

test('cost tracker emits 70 and 90 percent thresholds and stops at 100', async () => {
  const seen = [];
  const tracker = new CostTracker(1, async ({ threshold }) => seen.push(threshold));
  await tracker.add({ costUsd: 0.71 });
  await tracker.add({ costUsd: 0.2 });
  await assert.rejects(tracker.add({ costUsd: 0.09 }), /budget exhausted/);
  assert.deepEqual(seen, [0.7, 0.9, 1]);
});

test('progress guard stops repeated identical state', () => {
  const guard = new ProgressGuard(2);
  guard.observe({ stage: 1 }); guard.observe({ stage: 1 });
  assert.throws(() => guard.observe({ stage: 1 }), /No-progress/);
});

test('task envelope is restricted to the approved repository and branch namespace', () => {
  const task = newTaskEnvelope({ expectedSha: 'a'.repeat(40) });
  assert.equal(task.repository, 'FahadTrail/fahad-ai-office');
  assert.match(task.workingBranch, /^continuity\/poc-/);
  assert.throws(() => validateTaskEnvelope({ ...task, testCommand: ['sh', '-c', 'anything'] }), /tool policy/);
  assert.throws(() => validateTaskEnvelope({ ...task, allowedFiles: ['src/index.js'] }), /Allowed files/);
});
