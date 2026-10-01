import test from 'node:test';
import assert from 'node:assert/strict';
import { ContinuityStore } from '../src/continuity/store.js';

function fakeDb() {
  const calls = [];
  const responses = new Map();
  const builder = (table) => {
    const call = { table, filters: [], operation: 'select', payload: null };
    const api = {
      select(columns) { call.columns = columns; return api; }, insert(payload) { call.operation = 'insert'; call.payload = payload; return api; },
      update(payload) { call.operation = 'update'; call.payload = payload; return api; }, eq(column, value) { call.filters.push(['eq', column, value]); return api; },
      in(column, value) { call.filters.push(['in', column, value]); return api; }, gte(column, value) { call.filters.push(['gte', column, value]); return api; },
      or(value) { call.filters.push(['or', value]); return api; }, order(column, options) { call.order = [column, options]; return api; }, limit(value) { call.limit = value; return api; },
      single() { calls.push(call); return Promise.resolve(responses.get(`${table}:${call.operation}`) || { data: { id: 'row-1', ...call.payload }, error: null }); },
      maybeSingle() { calls.push(call); return Promise.resolve(responses.get(`${table}:single`) || { data: null, error: null }); },
      then(resolve) { calls.push(call); return resolve(responses.get(`${table}:${call.operation}`) || { data: [], error: null }); },
    };
    return api;
  };
  return {
    calls, responses,
    from: builder,
    async rpc(name, args) { calls.push({ rpc: name, args }); return responses.get(`rpc:${name}`) || { data: true, error: null }; },
  };
}

test('continuity store maps session, lease, checkpoint and handoff operations to the Phase A contract', async () => {
  const db = fakeDb();
  db.responses.set('rpc:acquire_coding_lease', { data: [{ id: 'lease', token: 'token' }], error: null });
  db.responses.set('rpc:save_continuity_checkpoint', { data: { id: 'checkpoint' }, error: null });
  db.responses.set('rpc:propose_handoff', { data: { id: 'handoff' }, error: null });
  const store = new ContinuityStore(db, { now: () => new Date('2026-10-01T12:00:00Z') });
  const session = await store.createSession({ workerKey: 'office', repository: 'x/y', branch: 'b', objective: 'o' });
  assert.equal(session.worker_key, 'office');
  assert.equal((await store.acquireLease('s')).id, 'lease');
  assert.equal((await store.saveCheckpoint('lease', 'token', { schema: 'continuity.checkpoint.v1' })).id, 'checkpoint');
  assert.equal((await store.proposeHandoff({ fromSessionId: 's', checkpointId: 'c', reason: 'limit', packet: 'p', toWorker: 'codex' })).id, 'handoff');
  assert.deepEqual(db.calls.find((call) => call.rpc === 'save_continuity_checkpoint').args, { p_lease: 'lease', p_token: 'token', p_payload: { schema: 'continuity.checkpoint.v1' }, p_native_checkpoint: null });
  assert.deepEqual(db.calls.find((call) => call.rpc === 'propose_handoff').args, { p_from_session: 's', p_checkpoint: 'c', p_reason: 'limit', p_packet: 'p', p_to_worker: 'codex' });
});
test('continuity store propagates named database errors and validates state transitions', async () => {
  const db = fakeDb();
  db.responses.set('rpc:heartbeat_coding_lease', { data: null, error: { message: 'timeout', code: '57014' } });
  const store = new ContinuityStore(db);
  await assert.rejects(store.heartbeatLease('l', 't'), (error) => error.code === '57014' && /heartbeat continuity lease: timeout/.test(error.message));
  db.responses.set('coding_worker_sessions:single', { data: { id: 's', status: 'ACTIVE' }, error: null });
  await assert.rejects(store.transitionSession('s', 'COMPLETED'), /CONTINUITY_TRANSITION_INVALID/);
});

test('continuity events are redacted before database persistence', async () => {
  const db = fakeDb();
  const store = new ContinuityStore(db, { env: { OPENAI_API_KEY: 'sk-proj-this-is-a-configured-secret-value' } });
  await store.recordEvent('SESSION_FAILED', {
    message: 'failed with sk-proj-this-is-a-configured-secret-value',
    payload: { nested: { token: 'Bearer secret-token-value', configured: 'sk-proj-this-is-a-configured-secret-value' } },
  });
  const inserted = db.calls.find((call) => call.table === 'events' && call.operation === 'insert').payload;
  assert.doesNotMatch(JSON.stringify(inserted), /configured-secret|secret-token/);
  assert.match(JSON.stringify(inserted), /REDACTED/);
});
