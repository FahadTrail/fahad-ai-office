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

test('the Office adapter always sends create_coding_session a bounded positive budget', async () => {
  // Regression guard for the live Phase N failure: `budgetUsd: task.budgetUsd
  // ?? 0` sent 0 whenever a task carried no budget and create_coding_session
  // rejected it with agent_sessions_budget_usd_check (0 < budget_usd <= 500).
  const seen = [];
  const db = {
    from: () => {
      const api = { update: () => api, select: () => api, eq: () => api, order: () => api, limit: () => api,
        maybeSingle: async () => ({ data: null, error: null }), then: (resolve) => resolve({ data: null, error: null }) };
      return api;
    },
    rpc: async () => ({ data: true, error: null }),
  };
  const nativeStore = {
    createSession: async (input) => { seen.push(input); return { id: `native-${seen.length}`, status: 'queued' }; },
    appendEvent: async () => {},
  };
  const adapter = new OfficeContinuityAdapter({ db, nativeStore, sleep: async () => {} });
  const start = (budget) => adapter.start({
    continuationPacket: 'packet', branch: 'continuity/phase-n-drill',
    task: { projectId: 'p', objective: 'Drill', repository: 'FahadTrail/fahad-ai-office', ...(budget === undefined ? {} : { budgetUsd: budget }) },
  });
  // Missing budget → the Coding Agent default; invalid values never reach the RPC.
  await start(undefined);
  await start(0);
  await start(-3);
  await start('nope');
  assert.deepEqual(seen.map((input) => input.budgetUsd), [5, 5, 5, 5]);
  // An explicit valid budget passes through; an oversized one is clamped to the schema bound.
  await start(12.5);
  await start(999);
  assert.deepEqual(seen.slice(4).map((input) => input.budgetUsd), [12.5, 500]);
  for (const input of seen) assert.ok(input.budgetUsd > 0 && input.budgetUsd <= 500, `agent_sessions_budget_usd_check violated: ${input.budgetUsd}`);
});
