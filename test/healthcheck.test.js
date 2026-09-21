import test from 'node:test';
import assert from 'node:assert/strict';
import { checkHealth, checkRuntime } from '../src/healthcheck.js';

const env = { SUPABASE_URL: 'https://office.example', SUPABASE_SERVICE_ROLE_KEY: 'test-only-service-key', ANTHROPIC_API_KEY: 'test-only-anthropic-key' };
test('runtime health rejects dead processes, stale heartbeats and a broken polling loop', () => {
  const now = 100000;
  const state = { pid: 1, updatedAt: now, lastPollAt: now, busy: false, pollIntervalMs: 5000 };
  assert.equal(checkRuntime(state, now, () => {}), true);
  assert.throws(() => checkRuntime({ ...state, updatedAt: now - 31000 }, now, () => {}), /heartbeat/);
  assert.throws(() => checkRuntime({ ...state, lastPollAt: now - 31000 }, now, () => {}), /heartbeat/);
  assert.throws(() => checkRuntime(state, now, () => { throw new Error('process exited'); }), /exited/);
  assert.equal(checkRuntime({ ...state, busy: true, lastPollAt: now - 31000 }, now, () => {}), true);
});
function fixture(overrides = {}) {
  const requests = [];
  const fetchFn = async (url, options) => {
    requests.push({ url, options });
    const body = url.pathname === '/rest/v1/agents' ? [{ id: 'chief', system_prompt: 'x'.repeat(120) }]
      : url.pathname === '/rest/v1/' ? { paths: { '/rpc/claim_next_job': { post: {} } } } : [];
    return { ok: true, status: 200, json: async () => body, ...overrides };
  };
  return { requests, fetchFn };
}
test('readiness uses GET only and never invokes the claim RPC or an AI endpoint', async () => {
  const f = fixture();
  assert.equal(await checkHealth({ env, fetchFn: f.fetchFn, verifyCode: false }), true);
  assert.equal(f.requests.length, 3);
  for (const { url, options } of f.requests) {
    assert.equal(options.method, 'GET');
    assert.equal(url.origin, env.SUPABASE_URL);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(!url.pathname.includes('/rpc/'));
  }
});
test('missing credentials fail before network access', async () => {
  const f = fixture();
  await assert.rejects(checkHealth({ env: { ...env, ANTHROPIC_API_KEY: '' }, fetchFn: f.fetchFn, verifyCode: false }), /Missing/);
  assert.equal(f.requests.length, 0);
});
test('database errors fail readiness without exposing response text', async () => {
  const f = fixture({ ok: false, status: 401, json: async () => ({ secret: 'not-for-logs' }) });
  await assert.rejects(checkHealth({ env, fetchFn: f.fetchFn, verifyCode: false }), /^Error: Database readiness request failed \(HTTP 401\)$/);
});
test('missing Chief or public RPC fails readiness', async () => {
  await assert.rejects(checkHealth({ env, fetchFn: fixture({ json: async () => [] }).fetchFn, verifyCode: false }), /Chief/);
  const f = fixture();
  await assert.rejects(checkHealth({ env, verifyCode: false, fetchFn: (url, options) => url.pathname === '/rest/v1/'
    ? Promise.resolve({ ok: true, json: async () => ({ paths: {} }) }) : f.fetchFn(url, options) }), /Public claim_next_job/);
});
