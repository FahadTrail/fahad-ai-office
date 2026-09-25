import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentTurnGateway } from '../src/model-gateway/agentic/turn-gateway.js';
import { MemoryProviderStateStore, failureOutcome, HEALTH } from '../src/model-gateway/agentic/provider-state.js';
import { createModelPool } from '../src/model-gateway/agentic/model-pool.js';
import { classifyProviderError } from '../src/model-gateway/contracts.js';

function route(id, overrides = {}) {
  const [provider, model] = id.split(':');
  return {
    id, provider, model, protocol: 'test', billingClass: 'paid', qualityTier: 5, costTier: 3, contextWindow: 200_000,
    privacyApproved: true, pricing: { inputPerMillion: 1, outputPerMillion: 1 }, unavailableReasons: [], ...overrides,
  };
}

function scripted(responses) {
  const calls = [];
  return {
    calls,
    async turn(input) {
      calls.push(input);
      const next = responses.shift();
      if (next instanceof Error || next?.status) throw next;
      return { message: { role: 'assistant', content: [{ type: 'text', text: next }] }, stopReason: 'end',
        usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.001 }, requestId: 'r', durationMs: 1 };
    },
  };
}

const failure = (status, extra = {}) => Object.assign(new Error('fail'), { status, ...extra });

test('a rate-limited primary triggers checkpoint-before-switch and the backup continues', async () => {
  const primary = scripted([failure(429, { retryAfter: '600' })]);
  const backup = scripted(['continued']);
  const store = new MemoryProviderStateStore();
  const events = [];
  const gateway = new AgentTurnGateway({
    pool: [route('anthropic:claude-opus-5', { protocolClient: primary }), route('deepseek:deepseek-flash', { costTier: 1, qualityTier: 4, protocolClient: backup })],
    stateStore: store, sleepFn: async () => {},
  });
  const result = await gateway.turn({
    tools: [],
    preferredRouteId: 'anthropic:claude-opus-5',
    prepare: async (candidate, handoff) => {
      events.push(`prepare:${candidate.id}:${handoff.switching}`);
      return { system: 'S', messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }] };
    },
    hooks: { onSwitch: async (change) => { events.push(`checkpoint:${change.from}->${change.to}:${change.reason.code}`); } },
  });
  assert.equal(result.route.id, 'deepseek:deepseek-flash');
  assert.equal(result.message.content[0].text, 'continued');
  assert.deepEqual(events, [
    'prepare:anthropic:claude-opus-5:false',
    'checkpoint:anthropic:claude-opus-5->deepseek:deepseek-flash:PROVIDER_RATE_LIMIT',
    'prepare:deepseek:deepseek-flash:true',
  ]);
  const state = (await store.snapshot()).get('anthropic:claude-opus-5');
  assert.equal(state.health, HEALTH.RATE_LIMITED);
  assert.ok(Date.parse(state.cooldownUntil) > Date.now() + 500_000);
});

test('cooling-down routes are skipped on later turns without another failed call', async () => {
  const store = new MemoryProviderStateStore();
  const primary = scripted([]);
  const backup = scripted(['ok']);
  const pool = [route('a:m', { protocolClient: primary }), route('b:m', { protocolClient: backup })];
  await store.recordFailure(pool[0], classifyProviderError(failure(429, { retryAfter: '120' })));
  const gateway = new AgentTurnGateway({ pool, stateStore: store });
  const result = await gateway.turn({ tools: [], preferredRouteId: 'a:m', prepare: async () => ({ system: 'S', messages: [] }) });
  assert.equal(primary.calls.length, 0);
  assert.equal(result.route.id, 'b:m');
  assert.equal(result.switched, true);
});

test('short transient errors retry the same route before switching', async () => {
  const primary = scripted([failure(503), 'recovered']);
  const gateway = new AgentTurnGateway({ pool: [route('a:m', { protocolClient: primary })], stateStore: new MemoryProviderStateStore(), sleepFn: async () => {} });
  const result = await gateway.turn({ tools: [], prepare: async () => ({ system: 'S', messages: [] }) });
  assert.equal(result.message.content[0].text, 'recovered');
  assert.equal(primary.calls.length, 2);
});

test('routing honors billing priority, privacy, quality floor and budget', async () => {
  const gateway = new AgentTurnGateway({
    pool: [
      route('paid:p', { billingClass: 'paid', qualityTier: 5 }),
      route('free:f', { billingClass: 'free', qualityTier: 4, pricing: null }),
      route('free:weak', { billingClass: 'free', qualityTier: 2, pricing: null }),
      route('free:private', { billingClass: 'free', qualityTier: 5, privacyApproved: false, pricing: null }),
    ],
    stateStore: new MemoryProviderStateStore(),
  });
  const evaluations = await gateway.evaluate({ requiresPrivateData: true, estimatedInputTokens: 1000 });
  assert.deepEqual(gateway.order(evaluations).map((entry) => entry.id), ['free:f', 'paid:p']);
  assert.ok(evaluations.find((entry) => entry.route.id === 'free:private').reasons.includes('PRIVACY_NOT_APPROVED'));
  assert.ok(evaluations.find((entry) => entry.route.id === 'free:weak').reasons.includes('BELOW_QUALITY_FLOOR'));
  const tight = await gateway.evaluate({ remainingBudgetUsd: 0.000001, estimatedInputTokens: 100_000 });
  assert.ok(tight.find((entry) => entry.route.id === 'paid:p').reasons.includes('BUDGET_INSUFFICIENT'));
});

test('no eligible route is a human-facing blocker with reasons, not a guess', async () => {
  const gateway = new AgentTurnGateway({ pool: [route('a:m', { unavailableReasons: ['CREDENTIAL_MISSING'] })], stateStore: new MemoryProviderStateStore() });
  await assert.rejects(gateway.turn({ tools: [], prepare: async () => ({}) }), (error) => {
    assert.equal(error.code, 'NO_ELIGIBLE_PROVIDER');
    assert.deepEqual(error.evaluations, [{ id: 'a:m', reasons: ['CREDENTIAL_MISSING'] }]);
    return true;
  });
});

test('failure outcomes map provider errors to durable health', () => {
  const now = Date.parse('2026-09-25T00:00:00Z');
  assert.equal(failureOutcome(classifyProviderError(failure(401)), {}, now).health, HEALTH.AUTH_ERROR);
  assert.equal(failureOutcome(classifyProviderError(failure(402)), {}, now).health, HEALTH.QUOTA_EXHAUSTED);
  const transient = failureOutcome(classifyProviderError(failure(500)), {}, now);
  assert.equal(transient.health, HEALTH.DEGRADED);
  assert.equal(transient.cooldownUntil, null);
  assert.equal(failureOutcome(classifyProviderError(failure(500)), transient, now).health, HEALTH.UNAVAILABLE);
  const refusal = failureOutcome(classifyProviderError(failure(422, { type: 'refusal' })), {}, now);
  assert.equal(refusal.cooldownUntil, null);
});

test('model pool marks missing credentials, unknown pricing and privacy truthfully', () => {
  const pool = createModelPool({ env: { ANTHROPIC_API_KEY: 'sk-ant-test-key-1234', OPENAI_API_KEY: 'sk-test-key-123456', DEEPSEEK_API_KEY: 'deepseek-key-1234' } });
  const byId = Object.fromEntries(pool.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId['anthropic:claude-opus-5'].unavailableReasons, []);
  assert.deepEqual(byId['openai:gpt-5.3-codex'].unavailableReasons, ['PRICING_UNKNOWN']);
  assert.equal(byId['deepseek:deepseek-flash'].privacyApproved, false);
  assert.ok(byId['gemini:gemini-2.5-flash'].unavailableReasons.includes('CREDENTIAL_MISSING'));
  assert.ok(pool.find((entry) => entry.provider === 'minimax').privacyApproved === false);
  assert.ok(pool.find((entry) => entry.provider === 'openrouter').unavailableReasons.includes('MODEL_NOT_CONFIGURED'));
});
