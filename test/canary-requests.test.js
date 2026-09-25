import test from 'node:test';
import assert from 'node:assert/strict';
import { CanaryRequestRunner } from '../src/canary/canary-requests.js';

function fakeDb({ queued = null, rpcError = null } = {}) {
  const updates = [];
  return {
    updates,
    rpc: async () => (rpcError ? { data: null, error: rpcError } : { data: queued ? [queued] : [], error: null }),
    from: (table) => ({ update: (values) => ({ eq: (key, value) => { const entry = { table, values, filters: [[key, value]] }; updates.push(entry); return { eq: (k2, v2) => { entry.filters.push([k2, v2]); return Promise.resolve({ error: null }); }, then: (resolve) => resolve({ error: null }) }; } }) }),
  };
}

test('nothing runs or bills unless a canary is queued', async () => {
  let ran = 0;
  const runner = new CanaryRequestRunner({ db: fakeDb(), stateStore: {}, run: async () => { ran += 1; }, intervalMs: 0 });
  assert.equal(await runner.maybeRun(), false);
  assert.equal(ran, 0);
});

test('a queued canary runs once and stores a metadata report and verification', async () => {
  const db = fakeDb({ queued: { id: 'r1' } });
  const report = { routes: [{ id: 'anthropic:claude-sonnet-5', ok: true }, { id: 'deepseek:deepseek-flash', ok: false, error: 'X' }], failover: { ok: false } };
  const runner = new CanaryRequestRunner({ db, stateStore: {}, run: async () => report, intervalMs: 0 });
  assert.equal(await runner.maybeRun(), true);
  const verified = db.updates.find((entry) => entry.table === 'provider_status');
  assert.deepEqual(verified.filters, [['provider', 'anthropic'], ['model', 'claude-sonnet-5']]);
  const done = db.updates.find((entry) => entry.table === 'provider_canary_runs');
  assert.equal(done.values.status, 'completed');
  assert.equal(done.values.report, report);
});

test('the runner disables itself quietly before its migration is applied', async () => {
  const runner = new CanaryRequestRunner({ db: fakeDb({ rpcError: { message: 'Could not find the function public.claim_provider_canary_run', code: 'PGRST202' } }), stateStore: {}, intervalMs: 0 });
  assert.equal(await runner.maybeRun(), false);
  assert.equal(runner.unavailable, true);
  assert.equal(await runner.maybeRun(), false);
});
