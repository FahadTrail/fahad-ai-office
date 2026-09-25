import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelPool } from '../src/model-gateway/agentic/model-pool.js';
import { AgentTurnGateway } from '../src/model-gateway/agentic/turn-gateway.js';
import { MemoryProviderStateStore } from '../src/model-gateway/agentic/provider-state.js';
import { JOB_PROFILES, capabilityGaps, capabilityProfile } from '../src/model-gateway/agentic/capabilities.js';
import { FREE_ALLOWANCES, freeQuotaStatus, isDailyQuotaText, nextResetAt } from '../src/model-gateway/agentic/free-quota.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const chatReply = { model: 'm', choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } };
const geminiReply = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } };
const env = {
  GEMINI_API_KEY: 'gemini-test-key-12345', ZHIPU_API_KEY: 'zhipu-test-key-1234', OPENROUTER_API_KEY: 'sk-or-test-123456789',
  DEEPSEEK_API_KEY: 'sk-deepseek-test-1234', GITHUB_MODELS_TOKEN: 'github_pat_models_test_1234567890',
};
const messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
const prepare = async () => ({ system: 'S', messages });

function gatewayFor(pool, now) {
  return new AgentTurnGateway({ pool, stateStore: new MemoryProviderStateStore({ now: () => now.value }), minQualityTier: 1, now: () => now.value, sleepFn: async () => {} });
}

test('every job profile names real capabilities and every route carries a capability profile', () => {
  for (const [job, profile] of Object.entries(JOB_PROFILES)) {
    for (const score of Object.keys({ ...profile.min, ...profile.weights })) {
      assert.ok(['coding', 'reasoning', 'research', 'writing', 'speed'].includes(score), `${job}.${score}`);
    }
  }
  for (const route of createModelPool({ env })) {
    assert.ok(route.capabilities, route.id);
    assert.ok(['registry', 'route default', 'owner override'].includes(route.capabilities.source), route.id);
    assert.match(route.capabilities.privacyClass, /^(private-data-approved|public-data-only)$/);
  }
  const unknown = capabilityProfile({ model: 'brand-new-model', qualityTier: 3, contextWindow: 32_000, billingClass: 'free' });
  assert.equal(unknown.source, 'route default', 'unknown models are never overstated');
  assert.equal(unknown.coding, 3);
  const overridden = capabilityProfile({ model: 'brand-new-model', qualityTier: 3, contextWindow: 32_000, billingClass: 'free' },
    { MODEL_CAPABILITIES_JSON: '{"brand-new-model":{"coding":5}}' });
  assert.equal(overridden.coding, 5);
  assert.equal(overridden.source, 'owner override');
});

test('a free model that cannot do the job never gets it; capable free models go first', async () => {
  const pool = createModelPool({ env }).filter((route) => ['zhipu:glm-4.7-flash', 'gemini:gemini-flash-latest', 'deepseek:deepseek-flash', 'github:openai/gpt-4.1'].includes(route.id));
  const gateway = gatewayFor(pool, { value: Date.now() });
  const coding = await gateway.evaluate({ requiresPrivateData: false, job: 'coding', minQualityTier: 1 });
  const reasons = Object.fromEntries(coding.map((entry) => [entry.route.id, entry.reasons]));
  assert.ok(reasons['zhipu:glm-4.7-flash'].includes('CAPABILITY_CODING_BELOW_4'), 'free GLM Flash is below the coding floor');
  assert.ok(reasons['github:openai/gpt-4.1'].includes('CONTEXT_WINDOW_TOO_SMALL'), 'GitHub Models 8K input is too small for coding');
  assert.deepEqual(gateway.order(coding, { strategy: 'economy', job: 'coding' }).map((route) => route.id),
    ['gemini:gemini-flash-latest', 'deepseek:deepseek-flash'], 'free capable first, then paid');

  const content = await gateway.evaluate({ requiresPrivateData: false, job: 'content', minQualityTier: 1 });
  const order = gateway.order(content, { strategy: 'economy', job: 'content' }).map((route) => route.id);
  assert.equal(order.at(-1), 'deepseek:deepseek-flash', 'paid comes after every free route');
  assert.ok(order.includes('zhipu:glm-4.7-flash'), 'free GLM Flash is fine for simple content');
  assert.deepEqual(capabilityGaps(pool[0].capabilities, null), []);
});

test('a used-up daily free allowance rotates to the next model and returns after the provider reset', async () => {
  const now = { value: Date.parse('2026-09-25T20:00:00Z') }; // 13:00 in California
  let geminiCalls = 0;
  const fetchFn = async (url) => {
    if (String(url).includes('generativelanguage')) {
      geminiCalls += 1;
      if (geminiCalls === 1) {
        return json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: "Quota exceeded for metric generate_content_free_tier_requests, quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier" } }, 429);
      }
      return json(geminiReply);
    }
    return json(chatReply);
  };
  const pool = createModelPool({ env, fetchFn }).filter((route) => ['gemini:gemini-flash-latest', 'openrouter:openai/gpt-oss-120b:free'].includes(route.id));
  const store = new MemoryProviderStateStore({ now: () => now.value });
  const gateway = new AgentTurnGateway({ pool, stateStore: store, minQualityTier: 1, now: () => now.value, sleepFn: async () => {} });
  const switches = [];
  const routing = { requiresPrivateData: false, strategy: 'quality' };
  const result = await gateway.turn({ tools: [], prepare, routing, hooks: { onSwitch: async (event) => switches.push(event) } });
  assert.equal(result.route.id, 'openrouter:openai/gpt-oss-120b:free', 'the next free model continued the turn');
  assert.equal(switches[0].from, 'gemini:gemini-flash-latest');
  const state = (await store.snapshot()).get('gemini:gemini-flash-latest');
  assert.equal(state.health, 'quota_exhausted');
  assert.equal(state.cooldownUntil, '2026-09-26T07:00:00.000Z', 'eligible again at midnight Pacific');
  assert.doesNotMatch(JSON.stringify(state), /Quota exceeded|GenerateRequests/, 'provider text is never stored');

  now.value = Date.parse('2026-09-26T06:59:00Z');
  let reasons = Object.fromEntries((await gateway.evaluate(routing)).map((entry) => [entry.route.id, entry.reasons]));
  assert.ok(reasons['gemini:gemini-flash-latest'].includes('COOLDOWN_QUOTA_EXHAUSTED'));
  now.value = Date.parse('2026-09-26T07:00:01Z');
  reasons = Object.fromEntries((await gateway.evaluate(routing)).map((entry) => [entry.route.id, entry.reasons]));
  assert.deepEqual(reasons['gemini:gemini-flash-latest'], [], 'back in rotation after the reset');
  const again = await gateway.turn({ tools: [], prepare, routing });
  assert.equal(again.route.id, 'gemini:gemini-flash-latest');
});

test('a per-minute rate limit is a short cooldown, not a wait until the daily reset', async () => {
  const now = { value: Date.parse('2026-09-25T20:00:00Z') };
  const fetchFn = async (url) => (String(url).includes('openrouter')
    ? json({ error: { message: 'Rate limit exceeded: free-models-per-min', code: 429 } }, 429)
    : json(geminiReply));
  const pool = createModelPool({ env, fetchFn }).filter((route) => ['gemini:gemini-flash-latest', 'openrouter:openai/gpt-oss-120b:free'].includes(route.id));
  const store = new MemoryProviderStateStore({ now: () => now.value });
  const gateway = new AgentTurnGateway({ pool, stateStore: store, minQualityTier: 1, now: () => now.value, sleepFn: async () => {}, maxAttemptsPerRoute: 1 });
  const result = await gateway.turn({ tools: [], prepare, routing: { requiresPrivateData: false, strategy: 'economy' }, preferredRouteId: 'openrouter:openai/gpt-oss-120b:free' });
  assert.equal(result.route.id, 'gemini:gemini-flash-latest');
  const state = (await store.snapshot()).get('openrouter:openai/gpt-oss-120b:free');
  assert.equal(state.health, 'rate_limited');
  assert.ok(Date.parse(state.cooldownUntil) - now.value <= 30 * 60_000);
});

test('daily reset times follow the provider time zone, including daylight-saving changes', () => {
  const pacific = { kind: 'daily', timeZone: 'America/Los_Angeles' };
  assert.equal(nextResetAt(pacific, Date.parse('2026-09-25T20:00:00Z')), '2026-09-26T07:00:00.000Z');
  assert.equal(nextResetAt(pacific, Date.parse('2026-11-01T06:00:00Z')), '2026-11-01T07:00:00.000Z');
  assert.equal(nextResetAt(pacific, Date.parse('2026-11-01T12:00:00Z')), '2026-11-02T08:00:00.000Z');
  assert.equal(nextResetAt({ kind: 'daily', timeZone: 'UTC' }, Date.parse('2026-09-25T20:00:00Z')), '2026-09-26T00:00:00.000Z');
  assert.equal(nextResetAt({ kind: 'monthly' }, Date.parse('2026-09-25T20:00:00Z')), '2026-10-01T00:00:00.000Z');
  assert.equal(nextResetAt({ kind: 'rolling' }, Date.now()), null);
  assert.ok(isDailyQuotaText('Rate limit reached for model on requests per day (RPD)'));
  assert.ok(isDailyQuotaText('Rate limit of 150 per 86400s exceeded for UserByModelByDay'));
  assert.ok(!isDailyQuotaText('Rate limit exceeded: 20 requests per minute'));
});

test('free quota status never invents a percentage', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const [openrouter] = createModelPool({ env }).filter((route) => route.provider === 'openrouter');
  const estimated = freeQuotaStatus(openrouter, { usedToday: { requests: 45 }, now });
  assert.equal(estimated.requestsRemaining, 5);
  assert.match(estimated.basis, /^ESTIMATED/);
  assert.equal(estimated.percentRemaining, null, 'published limits are not turned into percentages');
  assert.equal(estimated.nextResetAt, '2026-09-26T00:00:00.000Z');
  assert.equal(estimated.estimatedExhaustionAt, '2026-09-25T13:20:00.000Z', 'projected from today\'s rate, before the reset');
  assert.equal(freeQuotaStatus(openrouter, { usedToday: { requests: 2 }, now }).estimatedExhaustionAt, null, 'no exhaustion expected before the reset');
  const reported = freeQuotaStatus(openrouter, { usedToday: { requests: 10 }, rateLimit: { requestsLimit: 1000, requestsRemaining: 250 }, now });
  assert.equal(reported.basis, 'PROVIDER-REPORTED');
  assert.equal(reported.percentRemaining, 25);
  const gemini = createModelPool({ env }).find((route) => route.provider === 'gemini');
  const unknown = freeQuotaStatus(gemini, { usedToday: { requests: 3 }, now });
  assert.equal(unknown.requestsRemaining, null);
  assert.equal(unknown.basis, 'EXACT QUOTA NOT AVAILABLE');
  const paid = createModelPool({ env }).find((route) => route.provider === 'deepseek');
  assert.equal(freeQuotaStatus(paid, { now }), null);
  for (const [provider, allowance] of Object.entries(FREE_ALLOWANCES)) assert.match(allowance.source, /^https:\/\//, provider);
});
