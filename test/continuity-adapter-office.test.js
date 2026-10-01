import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficeContinuityAdapter } from '../src/continuity/adapters/office.js';

function query(data = null) {
  const value = { data, error: null };
  const api = { update: () => api, select: () => api, eq: () => api, order: () => api, limit: () => api, maybeSingle: async () => value, then: (resolve) => resolve(value) };
  return api;
}

test('Office adapter creates a native session, binds the leased branch and drains through the native cancel checkpoint path', async () => {
  const calls = [];
  let reads = 0;
  const db = {
    from: (table) => { calls.push(['from', table]); return query(table === 'agent_checkpoints' ? { id: 'native-cp' } : null); },
    rpc: async (name, args) => { calls.push(['rpc', name, args]); return { data: true, error: null }; },
  };
  const nativeStore = {
    createSession: async (input) => ({ id: 'native-1', status: 'queued', ...input }),
    appendEvent: async () => {},
    getSession: async () => ({ id: 'native-1', status: ++reads > 1 ? 'cancelled' : 'running', jobId: null }),
  };
  const adapter = new OfficeContinuityAdapter({ db, nativeStore, sleep: async () => {}, drainTimeoutMs: 100, drainPollMs: 0 });
  const started = await adapter.start({ continuationPacket: 'packet', branch: 'codex/task', task: { projectId: 'p', objective: 'Build it', repository: 'x/y' } });
  assert.equal(started.nativeSessionId, 'native-1');
  assert.equal(started.session.workBranch, 'codex/task');
  assert.equal((await adapter.stop({ session: started.session, reason: 'handoff' })).status, 'cancelled');
  assert.ok(calls.some((call) => call[0] === 'rpc' && call[1] === 'request_agent_session_cancel'));
});
