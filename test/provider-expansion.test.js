// Provider expansion preparation (branch claude/provider-expansion-prep):
// Mistral readiness without a real key, CHIEF synthesis fallback through a
// healthy, qualified Mistral pool, and the provider metadata contract.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentTurnGateway } from '../src/model-gateway/agentic/turn-gateway.js';
import { MemoryProviderStateStore, failureOutcome } from '../src/model-gateway/agentic/provider-state.js';
import { createModelPool, modelPoolDefinitions } from '../src/model-gateway/agentic/model-pool.js';
import { setProviderCatalog } from '../src/model-gateway/agentic/provider-catalogs.js';
import { capacityPool } from '../src/model-gateway/agentic/capacity-pools.js';
import { alnum9, ChatCompletionsProtocol } from '../src/model-gateway/agentic/chat-completions.js';
import { QUALIFICATION_SUITE_VERSION } from '../src/model-gateway/agentic/qualification.js';
import { authorizedRoutes } from '../src/workspace-policy/engine.js';
import { classifyProviderError } from '../src/model-gateway/contracts.js';
import { isDailyQuotaText } from '../src/model-gateway/agentic/free-quota.js';
import { capacityDecision } from '../src/office/capacity.js';

const NOW = Date.parse('2026-09-28T07:30:00Z');
const KEY = 'placeholder0test0key0000000000000';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const qualified = () => ({ status: 'qualified', suiteVersion: QUALIFICATION_SUITE_VERSION, testedAt: new Date(NOW - 86_400_000).toISOString(),
  skills: { instruction: true, structured: true, reasoning: true, coding: true, writing: true, reading: true, tools: true } });
const exhausted = (until) => ({ health: 'quota_exhausted', cooldownUntil: until, consecutiveFailures: 1, lastErrorCode: 'PROVIDER_RATE_LIMIT' });

function officePool(env, fetchFn) {
  setProviderCatalog('gemini', { ok: true, models: ['gemini-flash-latest', 'gemini-flash-lite-latest'], contexts: {} });
  try {
    return createModelPool({ env: { GEMINI_API_KEY: KEY, GROQ_API_KEY: KEY, OPENROUTER_API_KEY: KEY, ZHIPU_API_KEY: KEY, ...env }, fetchFn,
      openRouterCatalog: { models: [{ id: 'nvidia/nemotron-3-ultra-550b-a55b:free', admitted: true, contextLength: 262_144, structuredOutput: true }] } });
  } finally {
    setProviderCatalog('gemini', null);
  }
}
const qualifications = (pool) => new Map(pool.filter((route) => route.billingClass !== 'paid').map((route) => [route.id, qualified()]));

test('Mistral route metadata: endpoint, own pool, protocol quirks as metadata, inactive without a key', () => {
  const idle = createModelPool({ env: {} }).find((route) => route.provider === 'mistral');
  assert.equal(idle.endpoint, 'https://api.mistral.ai/v1/chat/completions');
  assert.equal(idle.model, 'mistral-medium-latest');
  assert.ok(idle.unavailableReasons.includes('CREDENTIAL_MISSING'));
  assert.equal(idle.billingClass, 'paid', 'no free quota claimed until the owner states the plan');
  assert.deepEqual(idle.protocolOptions, { toolCallIds: 'alnum9', omitEmptyTools: true });
  assert.equal(capacityPool(idle).id, 'mistral:account', 'pool declared in the definition');
  assert.equal(idle.privacyApproved, false);
});

test('Mistral wire format: 9-character alphanumeric tool-call ids that stay paired; no empty tools array', async () => {
  const bodies = [];
  const protocol = new ChatCompletionsProtocol({ apiKey: KEY, endpoint: 'https://api.mistral.ai/v1/chat/completions', toolCallIds: 'alnum9', omitEmptyTools: true,
    fetchFn: async (url, init) => { bodies.push(JSON.parse(init.body)); return json({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }); } });
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'add' }] },
    { role: 'assistant', content: [{ type: 'tool_call', id: 'call_1228488-long_id', name: 'add_numbers', arguments: { a: 1, b: 2 } }] },
    { role: 'user', content: [{ type: 'tool_result', callId: 'call_1228488-long_id', content: '3' }] },
  ];
  await protocol.turn({ provider: 'mistral', model: 'mistral-medium-latest', system: 'S', messages, tools: [] });
  const [body] = bodies;
  const callId = body.messages[2].tool_calls[0].id;
  assert.match(callId, /^[A-Za-z0-9]{9}$/);
  assert.equal(body.messages[3].tool_call_id, callId, 'the tool result keeps the matching id');
  assert.ok(!('tools' in body) && !('tool_choice' in body), 'no tools sent when there are none');
  assert.equal(alnum9('Ab3dE5gH9'), 'Ab3dE5gH9', 'a valid Mistral id is kept as is');
  assert.equal(alnum9('x'), alnum9('x'), 'deterministic');
});

test('Mistral monthly allowance exhausted: waits for the reset instead of being probed', () => {
  assert.equal(isDailyQuotaText('{"message":"Monthly tokens quota exceeded"}'), true);
  assert.equal(isDailyQuotaText('{"message":"Requests rate limit exceeded (per second)"}'), false);
  const route = createModelPool({ env: { MISTRAL_API_KEY: KEY, MISTRAL_BILLING_CLASS: 'free' } }).find((entry) => entry.provider === 'mistral');
  // The gateway carries the transport's quotaScope onto the classified error.
  const error = Object.assign(classifyProviderError(Object.assign(new Error('429'), { status: 429 })), { quotaScope: 'day' });
  const outcome = failureOutcome(error, {}, NOW, route);
  assert.equal(outcome.health, 'quota_exhausted');
  assert.equal(outcome.cooldownUntil, '2026-10-01T00:00:00.000Z', 'monthly reset');
});

test('workspace authorization: "*:free" admits Mistral only when its billing class is free', () => {
  const policy = { providers: [{ provider: 'mistral', models: ['*:free'], secretRef: 'env://MISTRAL_API_KEY', enabled: true }] };
  const paid = createModelPool({ env: { MISTRAL_API_KEY: KEY } }).filter((route) => route.provider === 'mistral');
  const free = createModelPool({ env: { MISTRAL_API_KEY: KEY, MISTRAL_BILLING_CLASS: 'free' } }).filter((route) => route.provider === 'mistral');
  assert.deepEqual(authorizedRoutes(paid, policy), []);
  assert.deepEqual(authorizedRoutes(free, policy), ['mistral:mistral-medium-latest']);
});

test('CHIEF SYNTHESIS FALLBACK: OpenRouter and Gemini strong pools exhausted, Mistral healthy + qualified → synthesis runs on Mistral', async () => {
  const called = [];
  const fetchFn = async (url) => {
    called.push(String(url));
    if (String(url).includes('api.mistral.ai')) return json({ choices: [{ finish_reason: 'stop', message: { content: '## Executive summary\nSynthesis.' } }], usage: { prompt_tokens: 9000, completion_tokens: 1500 } });
    return json({ error: { message: 'must not be called' } }, 500);
  };
  const pool = officePool({ MISTRAL_API_KEY: KEY, MISTRAL_BILLING_CLASS: 'free' }, fetchFn);
  const store = new MemoryProviderStateStore({ now: () => NOW });
  store.rows.set('openrouter:nvidia/nemotron-3-ultra-550b-a55b:free', exhausted('2026-09-29T00:00:00Z'));
  store.rows.set('gemini:gemini-flash-latest', exhausted('2026-09-29T07:00:00Z'));
  const gateway = new AgentTurnGateway({ pool, stateStore: store, now: () => NOW, sleepFn: async () => {} });
  const routing = { requiresPrivateData: false, allowPaid: false, job: 'synthesis', estimatedInputTokens: 9000, qualifications: qualifications(pool) };
  const result = await gateway.turn({ tools: [], maxOutputTokens: 8000, routing, prepare: async () => ({ system: 'CHIEF', messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthesize.' }] }] }) });
  assert.equal(result.route.id, 'mistral:mistral-medium-latest');
  assert.deepEqual(called.filter((url) => !url.includes('api.mistral.ai')), [], 'exhausted pools and weaker routes were not called');
});

test('without Mistral the same state waits for capacity (the bottleneck this fixes)', async () => {
  const pool = officePool({}, async () => json({}, 500));
  const store = new MemoryProviderStateStore({ now: () => NOW });
  store.rows.set('openrouter:nvidia/nemotron-3-ultra-550b-a55b:free', exhausted('2026-09-29T00:00:00Z'));
  store.rows.set('gemini:gemini-flash-latest', exhausted('2026-09-29T07:00:00Z'));
  const gateway = new AgentTurnGateway({ pool, stateStore: store, now: () => NOW, sleepFn: async () => {} });
  await assert.rejects(gateway.turn({ tools: [], maxOutputTokens: 8000,
    routing: { requiresPrivateData: false, allowPaid: false, job: 'synthesis', estimatedInputTokens: 9000, qualifications: qualifications(pool) },
    prepare: async () => ({ system: 'CHIEF', messages: [] }) }), (error) => {
    assert.equal(capacityDecision(error, { now: NOW })?.kind, 'wait');
    return true;
  });
});

test('Mistral never weakens the gates: unqualified, confidential or paid-by-default stays excluded from synthesis', async () => {
  const store = new MemoryProviderStateStore({ now: () => NOW });
  const reasonsFor = async (env, routing) => {
    const pool = officePool(env, async () => json({}, 500));
    const gateway = new AgentTurnGateway({ pool, stateStore: store, now: () => NOW });
    const view = await gateway.evaluate({ allowPaid: false, job: 'synthesis', estimatedInputTokens: 9000, maxOutputTokens: 8000, ...routing });
    return view.find((entry) => entry.route.provider === 'mistral').reasons;
  };
  const free = { MISTRAL_API_KEY: KEY, MISTRAL_BILLING_CLASS: 'free' };
  assert.ok((await reasonsFor(free, { requiresPrivateData: false, qualifications: new Map() })).includes('NOT_YET_QUALIFIED'), 'critical job needs a passed qualification');
  const qualifiedMap = new Map([['mistral:mistral-medium-latest', qualified()]]);
  assert.ok((await reasonsFor(free, { requiresPrivateData: true, qualifications: qualifiedMap })).includes('PRIVACY_NOT_APPROVED'), 'confidential work never goes to the free plan');
  assert.ok((await reasonsFor({ MISTRAL_API_KEY: KEY }, { requiresPrivateData: false, qualifications: qualifiedMap })).includes('PAID_ROUTE_NOT_ALLOWED'), '[free-only] never reaches a paid Mistral plan');
  assert.deepEqual(await reasonsFor(free, { requiresPrivateData: false, qualifications: qualifiedMap }), []);
});

test('provider metadata contract: every route declares what the router needs (a new provider = one definition)', () => {
  const env = Object.fromEntries(['ANTHROPIC', 'OPENAI', 'DEEPSEEK', 'QWEN', 'KIMI', 'ZHIPU', 'MINIMAX', 'GEMINI', 'OPENROUTER', 'GROQ', 'CEREBRAS', 'MISTRAL', 'GITHUB_MODELS'].map((name) => [`${name}_API_KEY`, KEY]));
  for (const definition of modelPoolDefinitions(env, { openRouterCatalog: null })) {
    const where = `${definition.provider}:${definition.model}`;
    assert.ok(definition.provider && definition.model && definition.protocol, `${where}: identity + protocol`);
    assert.ok(['free', 'included', 'promo', 'paid'].includes(definition.billingClass), `${where}: truthful billing class`);
    assert.ok(Number.isFinite(definition.contextWindow) && definition.contextWindow > 0, `${where}: context window`);
    assert.ok(definition.secretEnv && definition.secretRef === `env://${definition.secretEnv}`, `${where}: secret reference`);
    assert.equal(typeof definition.privacyApproved, 'boolean', `${where}: privacy flag`);
    assert.ok(definition.capabilities && typeof definition.capabilities.reasoning === 'number' && typeof definition.capabilities.toolCalling === 'boolean', `${where}: capability profile`);
    assert.ok(capacityPool(definition).id, `${where}: capacity pool`);
  }
});
