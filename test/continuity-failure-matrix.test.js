import test from 'node:test';
import assert from 'node:assert/strict';
import { ContinuityCheckpointer } from '../src/continuity/checkpointer.js';
import { LeaseManager } from '../src/continuity/lease.js';
import { HandoffHistory, selectWorker } from '../src/continuity/select.js';
import { fakeAdapter, validCheckpoint } from '../testing/fixtures/continuity-harness.js';

test('failure matrix: checkpoint, database, disabled worker, privacy, capacity and handoff loops fail closed', async (t) => {
  await t.test('invalid checkpoint', async () => {
    const cp = new ContinuityCheckpointer({ store: { saveCheckpoint: async () => ({ id: 'x' }) }, lease: { id: 'l', token: 't' }, writeMirror: async () => {}, env: {}, clock: { now: () => 0 } });
    await assert.rejects(cp.save({ ...validCheckpoint(), last_commit: 'short' }), /CHECKPOINT_INVALID/);
  });
  await t.test('secret in checkpoint', async () => {
    const cp = new ContinuityCheckpointer({ store: { saveCheckpoint: async () => ({ id: 'x' }) }, lease: { id: 'l', token: 't' }, writeMirror: async () => {}, env: {}, clock: { now: () => 0 } });
    await assert.rejects(cp.save({ ...validCheckpoint(), errors: [`ghp_${'x'.repeat(30)}`] }), /secret/);
  });
  await t.test('database transient error leaves no mirror', async () => {
    let mirror = false;
    const cp = new ContinuityCheckpointer({ store: { saveCheckpoint: async () => { throw new Error('transient'); } }, lease: { id: 'l', token: 't' }, writeMirror: async () => { mirror = true; }, env: {}, clock: { now: () => 0 } });
    await assert.rejects(cp.save(validCheckpoint()), /transient/); assert.equal(mirror, false);
  });
  await t.test('wrong token, heartbeat after release, release without checkpoint', async () => {
    let released = false;
    const backend = { acquireLease: async () => ({ id: 'l', token: 'right' }), heartbeatLease: async (_id, token) => token === 'right' && !released, releaseLease: async (_id, token, checkpoint) => { if (token !== 'right' || !checkpoint) return false; released = true; return true; }, freezeStaleLeases: async () => [], reclaimLease: async () => false };
    const manager = new LeaseManager({ store: backend, clock: globalThis });
    const lease = await manager.acquire('s');
    manager.active.get('l').lease.token = 'wrong';
    await assert.rejects(manager.heartbeat(lease), /REJECTED/);
    manager.active.get('l').lease.token = 'right';
    await assert.rejects(manager.release(lease, null), /CHECKPOINT_REQUIRED/);
    await manager.release(lease, 'cp');
    await assert.rejects(manager.heartbeat(lease), /NOT_HELD/);
  });
  await t.test('disabled worker, privacy mismatch and no eligible worker', async () => {
    const result = await selectWorker({ workers: [{ key: 'x', enabled: false }], adapters: new Map([['x', fakeAdapter('x', { privacyClasses: ['PUBLIC'] })]]), task: { dataClass: 'PRIVATE', size: 'large' } });
    assert.equal(result.blocker, 'NO_ELIGIBLE_WORKER');
    assert.deepEqual(result.evaluated[0].reasons, ['WORKER_DISABLED', 'PRIVACY_MISMATCH']);
  });
  await t.test('capacity exhausted', async () => {
    const adapter = fakeAdapter('x', { usage: { basis: 'PROVIDER_REPORTED', session_pct: 100, weekly_pct: null } });
    const result = await selectWorker({ workers: [{ key: 'x', enabled: true }], adapters: new Map([['x', adapter]]), task: { dataClass: 'PUBLIC', size: 'medium' } });
    assert.deepEqual(result.evaluated[0].reasons, ['QUOTA_EXHAUSTED']);
  });
  await t.test('repeated handoff loop', () => {
    const history = new HandoffHistory({ repeatedFailureLimit: 3 });
    for (let i = 0; i < 3; i += 1) history.add({ from: 'a', to: 'b', reason: 'worker crash', progress: false });
    assert.equal(history.detectLoop().loop, true);
  });
});
