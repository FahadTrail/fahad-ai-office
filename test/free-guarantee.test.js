import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentTurnGateway, sameModelFamily, assertFreeRouteHonest } from '../src/model-gateway/agentic/turn-gateway.js';
import { MemoryProviderStateStore, failureOutcome, HEALTH, ACCOUNT_BLOCKERS } from '../src/model-gateway/agentic/provider-state.js';
import { providerReasonHint } from '../src/model-gateway/agentic/http.js';
import { classifyProviderError } from '../src/model-gateway/contracts.js';
import { chargeUnreserved } from '../src/office/pool-runner.js';

function route(id, overrides = {}) {
  const [provider, ...rest] = id.split(':');
  return {
    id, provider, model: rest.join(':'), protocol: 'test', billingClass: 'free', qualityTier: 4, costTier: 1, contextWindow: 128_000,
    privacyApproved: false, pricing: null, unavailableReasons: [], ...overrides,
  };
}

function client(reply) {
  const calls = [];
  return {
    calls,
    async turn(input) {
      calls.push(input);
      const { model, cost } = reply(input);
      return { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, stopReason: 'end', model,
        usage: { inputTokens: 5, outputTokens: 1, costUsd: 0, ...(cost ? { reportedCostUsd: cost } : {}) }, durationMs: 1 };
    },
  };
}

const prepare = async () => ({ system: 'S', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });

test('any FREE route that reports a cost is refused, charged to the ledger, quarantined, checkpointed and failed over', async () => {
  const billed = client(() => ({ model: 'gemini-3.8-flash', cost: 0.0031 }));
  const backup = client((input) => ({ model: input.model }));
  const now = Date.parse('2026-09-26T12:00:00Z');
  const store = new MemoryProviderStateStore({ now: () => now });
  const gateway = new AgentTurnGateway({ pool: [route('gemini:gemini-flash-latest', { protocolClient: billed }), route('groq:openai/gpt-oss-120b', { protocolClient: backup })], stateStore: store, now: () => now, sleepFn: async () => {} });
  const charged = [];
  const incidents = [];
  const switches = [];
  const result = await gateway.turn({ tools: [], preferredRouteId: 'gemini:gemini-flash-latest', prepare, routing: { requiresPrivateData: false, job: 'content' },
    hooks: { charge: async (request) => charged.push(request.amountUsd), onIncident: async (incident) => incidents.push(incident.kind), onSwitch: async (change) => switches.push(change.reason.code) } });
  assert.equal(result.route.id, 'groq:openai/gpt-oss-120b');
  assert.equal(billed.calls.length, 1, 'a billed free route is never retried');
  assert.deepEqual(charged, [0.0031], 'the real cost reaches the budget ledger');
  assert.deepEqual(incidents, ['paid_on_free_route']);
  assert.equal(switches.length, 1, 'a checkpoint precedes the next route');
  const state = (await store.snapshot()).get('gemini:gemini-flash-latest');
  assert.equal(state.lastErrorCode, 'PAID_ON_FREE_ROUTE');
  assert.equal(Date.parse(state.cooldownUntil) - now, 24 * 3600_000);
});

test('a FREE route that silently serves another model family is blocked; renamed/dated ids are not', async () => {
  assert.equal(sameModelFamily('gemini-flash-latest', 'gemini-3.8-flash'), true);
  assert.equal(sameModelFamily('nvidia/nemotron-3-ultra-550b-a55b:free', 'nvidia/nemotron-3-ultra-550b-a55b-20260801'), true);
  assert.equal(sameModelFamily('openai/gpt-oss-120b', 'openai/gpt-oss-120b'), true);
  assert.equal(sameModelFamily('glm-4.7-flash', 'GLM-4.7-Flash'), true);
  assert.equal(sameModelFamily('nvidia/nemotron-3-ultra-550b-a55b:free', 'openai/gpt-5.5'), false);
  assert.equal(sameModelFamily('gpt-oss-120b', 'llama-4-maverick'), false);
  assert.throws(() => assertFreeRouteHonest(route('openrouter:nvidia/nemotron-3-ultra:free'), { model: 'anthropic/claude-sonnet-5', usage: {} }), (error) => error.type === 'free_route_model_mismatch');
  assert.doesNotThrow(() => assertFreeRouteHonest(route('deepseek:deepseek-flash', { billingClass: 'paid' }), { model: 'other', usage: { reportedCostUsd: 1 } }), 'paid routes are budgeted, not guarded');

  const swapped = client(() => ({ model: 'openai/gpt-5.5' }));
  const backup = client((input) => ({ model: input.model }));
  const store = new MemoryProviderStateStore();
  const gateway = new AgentTurnGateway({ pool: [route('openrouter:nvidia/nemotron-3-ultra:free', { protocolClient: swapped }), route('groq:openai/gpt-oss-120b', { protocolClient: backup })], stateStore: store, sleepFn: async () => {} });
  const incidents = [];
  const result = await gateway.turn({ tools: [], preferredRouteId: 'openrouter:nvidia/nemotron-3-ultra:free', prepare, routing: { requiresPrivateData: false }, hooks: { onIncident: async (incident) => incidents.push(incident) } });
  assert.equal(result.route.provider, 'groq');
  assert.equal(incidents[0].kind, 'free_route_model_mismatch');
  assert.equal(incidents[0].reportedModel, 'openai/gpt-5.5');
  assert.equal((await store.snapshot()).get('openrouter:nvidia/nemotron-3-ultra:free').lastErrorCode, 'FREE_ROUTE_MODEL_MISMATCH');
});

test('an unexpected cost without a reservation is charged at its real amount', async () => {
  const calls = [];
  const policyStore = {
    reserveBudget: async (request) => { calls.push(['reserve', request.amountUsd]); return { reservationId: 'r1' }; },
    settleBudget: async (request) => { calls.push(['settle', request.actualUsd]); },
  };
  assert.equal(await chargeUnreserved(policyStore, 'ws', 'key', 0.0042), true);
  assert.deepEqual(calls, [['reserve', 0.000001], ['settle', 0.0042]]);
  assert.equal(await chargeUnreserved(policyStore, 'ws', 'key', 0), false);
});

test('account and credential blockers are named, rest for a day and never look like a generic outage', () => {
  assert.equal(providerReasonHint(403, '{"code":"AccessDenied.Unpurchased","message":"Access to model denied. Please make sure you are eligible for using the model."}'), 'ACCOUNT_NOT_ACTIVATED');
  assert.equal(providerReasonHint(400, '{"code":"Arrearage","message":"Access denied, please make sure your account is in good standing."}'), 'ACCOUNT_OVERDUE');
  assert.equal(providerReasonHint(401, '{"error":{"message":"Invalid API Key","code":"invalid_api_key"}}'), 'CREDENTIAL_INVALID');
  assert.equal(providerReasonHint(403, '{"message":"The models:read permission is required"}'), 'PERMISSION_MISSING');
  assert.equal(providerReasonHint(403, '{"message":"User location is not supported for the API use."}'), 'REGION_NOT_SUPPORTED');
  const now = Date.parse('2026-09-26T00:00:00Z');
  const blocked = classifyProviderError(Object.assign(new Error('x'), { status: 403, reason: 'ACCOUNT_NOT_ACTIVATED' }));
  const outcome = failureOutcome(blocked, {}, now);
  assert.equal(outcome.health, HEALTH.AUTH_ERROR);
  assert.equal(outcome.lastErrorCode, 'PROVIDER_AUTH_ACCOUNT_NOT_ACTIVATED');
  assert.equal(Date.parse(outcome.cooldownUntil) - now, 24 * 3600_000, 'not hammered');
  assert.ok(ACCOUNT_BLOCKERS.ACCOUNT_NOT_ACTIVATED);
});

test('a restart re-checks account/credential blockers once; rate-limit cooldowns stay', async () => {
  let now = Date.parse('2026-09-26T00:00:00Z');
  const store = new MemoryProviderStateStore({ now: () => now });
  await store.recordFailure(route('qwen:qwen3.8-flash'), classifyProviderError(Object.assign(new Error('x'), { status: 403, reason: 'ACCOUNT_NOT_ACTIVATED' })));
  await store.recordFailure(route('openrouter:x:free'), classifyProviderError(Object.assign(new Error('x'), { status: 429, retryAfter: '600' })));
  now += 60_000;
  assert.deepEqual(await store.releaseAuthCooldowns(), ['qwen:qwen3.8-flash']);
  const state = await store.snapshot();
  assert.ok(Date.parse(state.get('qwen:qwen3.8-flash').cooldownUntil) <= now);
  assert.ok(Date.parse(state.get('openrouter:x:free').cooldownUntil) > now);
});

test('a route that keeps answering 429 with tiny retry-after values is not hammered', () => {
  const now = Date.parse('2026-09-26T00:00:00Z');
  const limited = classifyProviderError(Object.assign(new Error('x'), { status: 429, retryAfter: '5' }));
  const first = failureOutcome(limited, {}, now);
  assert.equal(Date.parse(first.cooldownUntil) - now, 5_000, 'the provider hint is honoured at first');
  const eighth = failureOutcome(limited, { consecutiveFailures: 7, health: 'rate_limited' }, now);
  assert.equal(Date.parse(eighth.cooldownUntil) - now, 30 * 60_000, 'repeated limits back off up to 30 minutes');
});

test('a rejected key rests every model behind it; other providers carry on', async () => {
  const now = Date.parse('2026-09-26T00:00:00Z');
  const store = new MemoryProviderStateStore({ now: () => now });
  const groqA = route('groq:openai/gpt-oss-120b', { secretRef: 'env://GROQ_API_KEY' });
  const groqB = route('groq:qwen/qwen3.8-27b', { secretRef: 'env://GROQ_API_KEY' });
  const gemini = route('gemini:gemini-flash-lite-latest', { secretRef: 'env://GEMINI_API_KEY' });
  await store.recordFailure(groqA, classifyProviderError(Object.assign(new Error('x'), { status: 401, reason: 'CREDENTIAL_INVALID' })));
  const gateway = new AgentTurnGateway({ pool: [groqA, groqB, gemini], stateStore: store, now: () => now });
  const byId = Object.fromEntries((await gateway.evaluate({ requiresPrivateData: false })).map((entry) => [entry.route.id, entry.reasons]));
  assert.ok(byId['groq:openai/gpt-oss-120b'].includes('COOLDOWN_AUTH_ERROR'));
  assert.deepEqual(byId['groq:qwen/qwen3.8-27b'], ['PROVIDER_CREDENTIAL_BLOCKED']);
  assert.deepEqual(byId['gemini:gemini-flash-lite-latest'], []);
});
