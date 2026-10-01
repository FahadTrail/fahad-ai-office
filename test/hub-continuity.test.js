import test from 'node:test';
import assert from 'node:assert/strict';
import { continuityPublicState, handleContinuityApi } from '../src/hub-continuity.js';

test('continuity API projection excludes lease tokens and checkpoint payloads', () => {
  const view = continuityPublicState({
    workers: [{ key: 'office', display_name: 'Office', kind: 'native', quota_source: 'office-pools', enabled: true, capabilities: {}, health: 'healthy', health_basis: 'MEASURED', last_error: `ghp_${'x'.repeat(30)}` }],
    sessions: [{ id: 's', worker_key: 'office', exit_reason: `Bearer ${'y'.repeat(24)}` }], leases: [{ id: 'l', repository: 'x/y', branch: 'b', token: 'secret-token', status: 'ACTIVE' }],
    checkpoints: [{ id: 'c', session_id: 's', sequence: 1, payload: { secret: 'never return' }, last_commit: 'a'.repeat(40), status: 'ACTIVE', next_exact_action: 'continue' }],
    handoffs: [], usage: [],
  });
  assert.equal(JSON.stringify(view).includes('secret-token'), false);
  assert.equal(JSON.stringify(view).includes('never return'), false);
  assert.equal(JSON.stringify(view).includes('ghp_'), false);
  assert.equal(JSON.stringify(view).includes('yyyy'), false);
});
test('continuity API exposes worker dashboard metrics with an explicit basis', () => {
  const view = continuityPublicState({
    workers: [{ key: 'codex', display_name: 'Codex', kind: 'cli', quota_source: 'openai-chatgpt', enabled: true, health: 'healthy', health_basis: 'MEASURED' }],
    sessions: [{ id: 's', worker_key: 'codex', status: 'COMPLETED', started_at: '2026-10-01T10:00:00Z', ended_at: '2026-10-01T10:10:00Z', task_tokens: 42, tokens_basis: 'PROVIDER_REPORTED' }],
    leases: [], checkpoints: [{ session_id: 's', last_commit: 'a'.repeat(40), created_at: '2026-10-01T10:10:00Z' }], handoffs: [], usage: [],
  });
  assert.deepEqual(view.workers[0].metrics, {
    completed: 1, failed: 0, handoffs: 0, countsBasis: 'MEASURED', lifetimeTokens: 42, tokensBasis: 'PROVIDER_REPORTED',
    averageLatencyMs: 600000, latencyBasis: 'MEASURED', successRatePct: 100, successBasis: 'MEASURED', lastCommit: 'a'.repeat(40), latestUsage: null,
  });
});
test('continuity mutations fail closed while the supervisor flag is off', async () => {
  let sent;
  const handled = await handleContinuityApi({
    db: {}, supervisor: null, request: { method: 'POST' }, response: {},
    url: new URL('http://localhost/api/continuity/actions'),
    sendJson: (_response, status, body) => { sent = { status, body }; },
    readJson: async () => ({ action: 'ENABLE_WORKER', workerKey: 'codex' }),
  });
  assert.equal(handled, true);
  assert.deepEqual(sent, { status: 503, body: { ok: false, error: 'CONTINUITY_SUPERVISOR_DISABLED' } });
});
