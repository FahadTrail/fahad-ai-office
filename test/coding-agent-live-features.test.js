import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodingWorker, authorizedRoutes } from '../src/coding-agent/runtime.js';
import { MemoryProviderStateStore } from '../src/model-gateway/agentic/provider-state.js';
import {
  REPOSITORY, SESSION_CONFIG, WORKSPACE_ID, createFixtureRepo, fakeApis, localRuntime, scriptedPool,
} from '../testing/fixtures/coding-agent-harness.js';

async function withRuntime(options, fn, { pendingPolls = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fahad-coding-live-'));
  try {
    const { bare } = createFixtureRepo(root);
    const apis = fakeApis({ bare, pendingPolls });
    const log = [];
    const env = localRuntime({ root, storePath: join(root, 'state.json'), pool: scriptedPool({ log }), fetchFn: apis.fetchFn, ...options });
    await fn({ ...env, apis, bare, log, worker: new CodingWorker({ runtime: env.runtime, sessionStore: env.sessionStore }) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const objective = 'The add() function returns wrong results. Fix it and keep the tests green.';

test('a controlled failover drill hands the same task to the next model without marking the provider unhealthy', { timeout: 120_000 }, async () => {
  await withRuntime({}, async ({ sessionStore, providerStateStore, attempts, bare, log, worker }) => {
    const created = await sessionStore.createSession({
      workspaceId: WORKSPACE_ID, title: 'Fix add() bug', repository: REPOSITORY, objective,
      config: { ...SESSION_CONFIG, fetchUrl: bare, pushUrl: bare, drill: { failoverAfterIteration: 6 } },
    });
    const outcome = await worker.runOnce();
    assert.equal(outcome.status, 'awaiting_approval', outcome.blocker);
    const session = await sessionStore.getSession(created.id);
    assert.equal(session.providerSwitches, 1);
    assert.equal(session.previousRoute, 'anthropic:claude-opus-5');
    assert.equal(session.currentRoute, 'deepseek:deepseek-flash');
    assert.ok(log.some((entry) => entry.provider === 'backup' && entry.continuation), 'the backup continued from the checkpoint');
    assert.ok(attempts.some((attempt) => attempt.route === 'anthropic:claude-opus-5' && attempt.error === 'DRILL_INJECTED_RATE_LIMIT'));
    assert.ok(!attempts.some((attempt) => attempt.error === 'PROVIDER_RATE_LIMIT'), 'the drill replaced the scripted rate limit');
    assert.notEqual((await providerStateStore.snapshot()).get('anthropic:claude-opus-5')?.health, 'rate_limited', 'a drill never marks real provider health');
    const events = await sessionStore.listEvents(created.id);
    const drill = events.find((event) => event.type === 'provider_switch' && event.payload.drill);
    assert.match(drill.message, /injected ONE recoverable rate-limit failure for anthropic:claude-opus-5 after 6 model turns/);
    const switched = events.find((event) => event.type === 'provider_switch' && !event.payload.drill);
    assert.equal(switched.payload.reason.code, 'DRILL_INJECTED_RATE_LIMIT');
    assert.equal(switched.payload.reason.injected, true);
    assert.ok(events.indexOf(drill) < events.indexOf(switched));
    const checkpoints = sessionStore.data.checkpoints[created.id];
    const switchCheckpoint = checkpoints.find((checkpoint) => checkpoint.reason === 'provider_switch');
    assert.equal(switchCheckpoint.state.drill.fired, true, 'the drill fires once and survives restarts');
    assert.ok(switchCheckpoint.state.filesChanged.includes('src/math.js'));
  });
});

test('when no model can run, the session blocks with the reason for every route', { timeout: 60_000 }, async () => {
  await withRuntime({}, async ({ sessionStore, attempts, bare, worker }) => {
    const created = await sessionStore.createSession({
      workspaceId: WORKSPACE_ID, title: 'Budget probe', repository: REPOSITORY, objective, budgetUsd: 0.0001,
      config: { ...SESSION_CONFIG, fetchUrl: bare, pushUrl: bare },
    });
    const outcome = await worker.runOnce();
    assert.equal(outcome.status, 'blocked');
    const session = await sessionStore.getSession(created.id);
    assert.equal(session.errorCode, 'NO_ELIGIBLE_PROVIDER');
    assert.match(session.blocker, /No model can take the next turn \(NO_ELIGIBLE_PROVIDER\)/);
    assert.match(session.blocker, /anthropic:claude-opus-5: [^;]*BUDGET_INSUFFICIENT/);
    assert.match(session.blocker, /deepseek:deepseek-flash: [^;]*BUDGET_INSUFFICIENT/);
    assert.equal(attempts.length, 0, 'no model was called');
  });
});

test('when every eligible model is only cooling down, the session waits for the reset and continues', { timeout: 120_000 }, async () => {
  const clock = { t: Date.now() };
  const now = () => clock.t;
  const providerStateStore = new MemoryProviderStateStore({ now });
  const until = new Date(clock.t + 90_000).toISOString();
  for (const id of ['anthropic:claude-opus-5', 'deepseek:deepseek-flash']) providerStateStore.rows.set(id, { health: 'rate_limited', cooldownUntil: until });
  await withRuntime({ now, sleepFn: async (ms) => { clock.t += ms; }, providerStateStore }, async ({ sessionStore, bare, worker }) => {
    const created = await sessionStore.createSession({
      workspaceId: WORKSPACE_ID, title: 'Fix add() bug', repository: REPOSITORY, objective,
      config: { ...SESSION_CONFIG, fetchUrl: bare, pushUrl: bare },
    });
    const outcome = await worker.runOnce();
    assert.notEqual(outcome.status, 'blocked', outcome.blocker);
    const events = await sessionStore.listEvents(created.id);
    const waiting = events.findIndex((event) => event.type === 'guard' && event.payload.waiting);
    assert.ok(waiting >= 0, 'the controller waited instead of blocking');
    assert.ok(events.slice(waiting).some((event) => event.type === 'model_turn'), 'and then continued the same task');
    assert.ok(clock.t - Date.parse(until) >= 0);
  });
});

test('only routes the workspace authorizes (provider, model and secret reference) are routable', () => {
  const pool = [
    { id: 'anthropic:claude-opus-5', provider: 'anthropic', model: 'claude-opus-5', secretRef: 'env://ANTHROPIC_API_KEY' },
    { id: 'anthropic:claude-sonnet-5', provider: 'anthropic', model: 'claude-sonnet-5', secretRef: 'env://ANTHROPIC_API_KEY' },
    { id: 'openai:gpt-5.3-codex', provider: 'openai', model: 'gpt-5.3-codex', secretRef: 'env://OPENAI_API_KEY' },
    { id: 'deepseek:deepseek-flash', provider: 'deepseek', model: 'deepseek-flash', secretRef: 'env://DEEPSEEK_API_KEY' },
  ];
  const policy = { providers: [
    { provider: 'anthropic', models: ['claude-sonnet-5'], secretRef: 'env://ANTHROPIC_API_KEY', enabled: true },
    { provider: 'deepseek', models: ['deepseek-flash'], secretRef: 'env://OTHER_KEY', enabled: true },
    { provider: 'openai', models: ['gpt-5.3-codex'], secretRef: 'env://OPENAI_API_KEY', enabled: false },
  ] };
  assert.deepEqual(authorizedRoutes(pool, policy), ['anthropic:claude-sonnet-5']);
});

test('a failing routing hook is not recorded as a provider failure and releases its reservation', async () => {
  const { AgentTurnGateway } = await import('../src/model-gateway/agentic/turn-gateway.js');
  const stateStore = new MemoryProviderStateStore();
  const route = { id: 'x:m', provider: 'x', model: 'm', billingClass: 'paid', qualityTier: 5, costTier: 1, contextWindow: 100_000,
    privacyApproved: true, pricing: { inputPerMillion: 1, outputPerMillion: 1 }, unavailableReasons: [],
    protocolClient: { turn: async () => { throw new Error('provider must not be called'); } } };
  const settled = [];
  const gateway = new AgentTurnGateway({ pool: [route], stateStore, minQualityTier: 1 });
  await assert.rejects(gateway.turn({
    tools: [], routing: { requiresPrivateData: false }, prepare: async () => ({ system: 'S', messages: [] }),
    hooks: { reserve: async () => ({ id: 'r1' }), settle: async (reservation, usd) => settled.push([reservation.id, usd]), beforeCall: async () => { throw new Error('event store down'); } },
  }), /event store down/);
  assert.deepEqual(settled, [['r1', 0]]);
  assert.equal((await stateStore.snapshot()).size, 0, 'no provider outcome was recorded');
});

test('every event type the controller emits is accepted by the agent_events table', async () => {
  const { readFileSync } = await import('node:fs');
  const { AGENT_EVENT_TYPES } = await import('../src/agent-state/session-store.js');
  const migration = readFileSync(new URL('../supabase/migrations/20260925160000_coding_agent_foundation.sql', import.meta.url), 'utf8');
  const check = migration.match(/create table public\.agent_events[\s\S]*?type text not null check \(type in \(([\s\S]*?)\)\)/)[1];
  const allowed = [...check.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  assert.deepEqual([...AGENT_EVENT_TYPES].sort(), allowed.sort(), 'the store mirrors the database constraint');
  const controller = readFileSync(new URL('../src/coding-agent/controller.js', import.meta.url), 'utf8');
  const emitted = new Set([...controller.matchAll(/this\.event\('([a-z_]+)'/g)].map((match) => match[1]));
  for (const literal of controller.matchAll(/this\.event\([^,]*\?\s*'([a-z_]+)'\s*:\s*'([a-z_]+)'/g)) { emitted.add(literal[1]); emitted.add(literal[2]); }
  for (const type of emitted) assert.ok(allowed.includes(type), `controller emits '${type}', which agent_events rejects`);
});

test('a test run whose failure is masked by the shell still counts as failing', async () => {
  const { reportedTestFailures } = await import('../src/coding-agent/controller.js');
  assert.equal(reportedTestFailures('TAP version 13\nnot ok 1 - x\n# tests 1\n# pass 0\n# fail 1\nexit=1\n'), 1);
  assert.equal(reportedTestFailures('\u2139 tests 3\n\u2139 pass 3\n\u2139 fail 0\n'), 0);
  assert.equal(reportedTestFailures('  2 passing\n  1 failing\n'), 1);
  assert.equal(reportedTestFailures('Tests:       2 failed, 3 passed, 5 total'), 2);
});

test('CI and deployment polls really re-execute while checks are still running (no idempotent replay)', { timeout: 120_000 }, async () => {
  await withRuntime({}, async ({ sessionStore, auditStore, apis, bare, worker }) => {
    const created = await sessionStore.createSession({
      workspaceId: WORKSPACE_ID, title: 'Fix add() bug', repository: REPOSITORY, objective,
      config: { ...SESSION_CONFIG, fetchUrl: bare, pushUrl: bare },
    });
    const first = await worker.runOnce();
    assert.equal(first.status, 'awaiting_approval', first.blocker);
    const approval = Object.values(sessionStore.data.approvals).find((row) => row.tool === 'github.pr_merge');
    await sessionStore.decideApproval(approval.id, 'approved');
    const second = await worker.runOnce();
    assert.equal(second.status, 'completed', second.blocker);
    const ciPolls = auditStore.rows().filter((row) => row.tool === 'github.ci_status' && row.status === 'succeeded');
    assert.ok(ciPolls.length >= 6, `each pending poll executed (${ciPolls.length})`);
    assert.equal(new Set(ciPolls.map((row) => row.key)).size, ciPolls.length, 'every poll has its own idempotency key');
    const deployPolls = auditStore.rows().filter((row) => row.tool === 'deploy.status' && row.status === 'succeeded');
    assert.ok(deployPolls.length >= 3);
    const session = await sessionStore.getSession(created.id);
    assert.equal(session.result.verify.ok, true);
    assert.equal(apis.state.merged.number, 1);
  }, { pendingPolls: 2 });
});
