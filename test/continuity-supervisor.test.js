import test from 'node:test';
import assert from 'node:assert/strict';
import { ContinuitySupervisor } from '../src/continuity/supervisor.js';
import { ContinuityCheckpointer } from '../src/continuity/checkpointer.js';
import { MemoryContinuityStore, fakeAdapter, validCheckpoint } from '../testing/fixtures/continuity-harness.js';

const workers = () => [
  { key: 'office', kind: 'native', enabled: true, quota_source: 'office-pools', health: 'healthy', health_basis: 'MEASURED' },
  { key: 'codex', kind: 'cli', enabled: true, quota_source: 'openai-chatgpt', health: 'healthy', health_basis: 'MEASURED' },
];

function supervisor({ store = new MemoryContinuityStore({ workers: workers() }), officeUsage, verifyBranch } = {}) {
  const office = fakeAdapter('office', { quality: 5, usage: officeUsage });
  const codex = fakeAdapter('codex', { quality: 4 });
  const value = new ContinuitySupervisor({
    store,
    adapters: [office, codex],
    checkpointerFactory: (options) => new ContinuityCheckpointer({ ...options, writeMirror: async () => {}, env: {}, clock: { now: () => Date.now() } }),
    gates: async () => ({ ok: true, checks: [{ name: 'tests', ok: true }], failed: [], nextExactAction: null }),
    verifyBranch: verifyBranch || (async (_lease, checkpoint) => ({ ok: true, head: checkpoint.last_commit, extraCommits: [] })),
  });
  return { value, store, office, codex };
}

const task = () => ({ projectId: 'project-1', repository: 'FahadTrail/fahad-ai-office', branch: 'codex/continuity-runtime', worktree: 'C:\\worktree', objective: 'Complete continuity safely.', dataClass: 'PUBLIC', size: 'medium', capability: 'coding' });

test('supervisor: Office starts, durable checkpoint precedes a lease, then Codex resumes the same branch', async () => {
  const { value, store, office, codex } = supervisor();
  const started = await value.startTask({ task: task(), checkpoint: validCheckpoint() });
  assert.equal(started.worker, 'office');
  assert.equal([...store.leases.values()].filter((lease) => lease.status === 'ACTIVE').length, 1);
  assert.equal(store.checkpoints.size, 1);
  const handed = await value.handoff(started.session.id, { reason: 'quota exhausted', checkpoint: validCheckpoint({ last_commit: 'c'.repeat(40), files_changed: ['same-file.js'] }) });
  assert.equal(handed.handedOff, true);
  assert.equal(handed.to, 'codex');
  assert.equal(handed.session.repository, task().repository);
  assert.equal(handed.session.branch, task().branch);
  assert.equal([...store.leases.values()].filter((lease) => lease.status === 'ACTIVE').length, 1, 'one writer throughout');
  assert.equal([...store.handoffs.values()][0].checkpoint_id, 'checkpoint-2', 'handoff anchored after persisted checkpoint');
  assert.equal(codex.calls[0].input.continuationPacket.includes('Last commit: cccccccccccccccccccccccccccccccccccccccc'), true);
  assert.equal(office.calls.some((call) => call.method === 'stop'), true);
  const finished = await value.finish(handed.session.id, { checkpoint: validCheckpoint({ last_commit: 'd'.repeat(40), agent_type: 'cli' }) });
  assert.equal(finished.completed, true);
  assert.equal(store.sessions.get(handed.session.id).status, 'COMPLETED');
  assert.equal([...store.leases.values()].filter((lease) => lease.status === 'ACTIVE').length, 0);
  value.stop();
});
test('supervisor: only provider-reported 85% usage drains; UNKNOWN never invents a threshold', async () => {
  const reported = supervisor({ officeUsage: { task_tokens: 10, session_pct: 85, weekly_pct: null, reset_at: null, basis: 'PROVIDER_REPORTED' } });
  const first = await reported.value.startTask({ task: task(), checkpoint: validCheckpoint() });
  const actions = await reported.value.tick();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].handedOff, true);
  reported.value.stop();

  const unknown = supervisor({ officeUsage: { task_tokens: null, session_pct: null, weekly_pct: null, reset_at: null, basis: 'UNKNOWN' } });
  await unknown.value.startTask({ task: task(), checkpoint: validCheckpoint() });
  assert.deepEqual(await unknown.value.tick(), []);
  unknown.value.stop();
});
test('supervisor: completion claim that fails gates becomes HANDOFF_READY', async () => {
  const setup = supervisor();
  setup.value.gates = async () => ({ ok: false, failed: [{ name: 'node --test' }], nextExactAction: 'Fix completion gate: node --test' });
  const started = await setup.value.startTask({ task: task(), checkpoint: validCheckpoint() });
  const result = await setup.value.finish(started.session.id, { checkpoint: validCheckpoint() });
  assert.equal(result.completed, false);
  assert.equal(setup.store.sessions.get(started.session.id).status, 'HANDOFF_READY');
  assert.equal(result.checkpoint.payload.next_exact_action, 'Fix completion gate: node --test');
  setup.value.stop();
});
test('supervisor: startup freezes, verifies and reclaims a stale lease before recovery', async () => {
  const store = new MemoryContinuityStore({ workers: workers() });
  let old = await store.createSession({ workerKey: 'office', projectId: 'p', repository: task().repository, branch: task().branch, worktree: task().worktree, objective: task().objective });
  old = await store.transitionSession(old.id, 'ACQUIRING');
  const lease = await store.acquireLease(old.id);
  const checkpoint = validCheckpoint({ session_id: old.id, last_commit: 'b'.repeat(40) });
  await store.saveCheckpoint(lease.id, lease.token, checkpoint);
  store.leases.get(lease.id).stale = true;
  const setup = supervisor({ store, verifyBranch: async () => ({ ok: true, head: 'c'.repeat(40), extraCommits: ['c'.repeat(40)] }) });
  await setup.value.start();
  assert.equal(store.leases.get(lease.id).status, 'RECLAIMED');
  assert.equal(setup.value.running.size, 1);
  const recovered = [...setup.value.running.values()][0];
  assert.equal(recovered.worker.key, 'codex');
  assert.equal(recovered.checkpoint.last_commit, 'c'.repeat(40));
  assert.match(recovered.checkpoint.decisions.at(-1), /Recovered commits after checkpoint/);
  setup.value.stop();
});
test('supervisor: owner can resume a durable HANDOFF_READY session after capacity returns', async () => {
  const rows = workers();
  rows[1].enabled = false;
  const store = new MemoryContinuityStore({ workers: rows });
  const setup = supervisor({ store });
  const started = await setup.value.startTask({ task: task(), checkpoint: validCheckpoint() });
  const paused = await setup.value.requestAction('PAUSE_SESSION', { sessionId: started.session.id, reason: 'owner pause', checkpoint: validCheckpoint() });
  assert.equal(paused.handedOff, false);
  assert.equal(store.sessions.get(started.session.id).status, 'HANDOFF_READY');
  await store.setWorkerEnabled('codex', true);
  const resumed = await setup.value.requestAction('RESUME_SESSION', { sessionId: started.session.id, preferredWorker: 'codex' });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.worker, 'codex');
  assert.equal([...store.leases.values()].filter((lease) => lease.status === 'ACTIVE').length, 1);
  setup.value.stop();
});
test('supervisor: a worker that fails to start cannot strand an active lease', async () => {
  const store = new MemoryContinuityStore({ workers: [{ key: 'office', kind: 'native', enabled: true, quota_source: 'office-pools' }] });
  const broken = fakeAdapter('office', { quality: 5 });
  broken.start = async () => { throw new Error('worker crashed'); };
  const value = new ContinuitySupervisor({
    store, adapters: [broken],
    checkpointerFactory: (options) => new ContinuityCheckpointer({ ...options, writeMirror: async () => {}, env: {}, clock: { now: () => Date.now() } }),
    gates: async () => ({ ok: true }),
  });
  await assert.rejects(value.startTask({ task: task(), checkpoint: validCheckpoint() }), /worker crashed/);
  assert.equal([...store.leases.values()].filter((lease) => lease.status === 'ACTIVE').length, 0);
});
