import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchOpenRouterCatalog, freeModelVerdict } from '../src/model-gateway/agentic/openrouter-catalog.js';
import { createModelPool } from '../src/model-gateway/agentic/model-pool.js';
import { AgentTurnGateway } from '../src/model-gateway/agentic/turn-gateway.js';
import { MemoryProviderStateStore } from '../src/model-gateway/agentic/provider-state.js';
import { rankFreeModels } from '../src/model-gateway/agentic/capabilities.js';
import { failoverPair, runAgenticCanary } from '../src/canary/agentic-canary.js';
import { providerReasonHint } from '../src/model-gateway/agentic/http.js';

const KEY = ['sk', 'or', 'v1', 'x'.repeat(40)].join('-');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const free = (id, extra = {}) => ({ id, name: id, context_length: 131072, pricing: { prompt: '0', completion: '0', request: '0', image: '0' }, supported_parameters: ['tools', 'tool_choice', 'response_format'], top_provider: { max_completion_tokens: 32768 }, ...extra });
const CATALOG = [
  free('deepseek/deepseek-r1-0528:free'),
  free('openai/gpt-oss-120b:free'),
  free('google/gemma-3-27b-it:free', { supported_parameters: ['temperature'] }),
  free('meta-llama/llama-3.3-70b-instruct:free'),
  free('tiny/model:free', { context_length: 4096 }),
  free('weird/priced:free', { pricing: { prompt: '0', completion: '0.000001' } }),
  { id: 'anthropic/claude-sonnet-5', context_length: 1000000, pricing: { prompt: '0.000002', completion: '0.00001' }, supported_parameters: ['tools'] },
];
const ACCESSIBLE = ['deepseek/deepseek-r1-0528:free', 'openai/gpt-oss-120b:free', 'google/gemma-3-27b-it:free', 'tiny/model:free', 'weird/priced:free'];

function catalogFetch({ userStatus = 200, calls = [] } = {}) {
  return async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.authorization || null });
    if (String(url).endsWith('/models/user')) return userStatus === 200 ? json({ data: CATALOG.filter((model) => ACCESSIBLE.includes(model.id)) }) : json({}, userStatus);
    return json({ data: CATALOG });
  };
}

test('discovery admits only zero-priced, tool-capable, large-context :free models the key can use', async () => {
  const calls = [];
  const catalog = await fetchOpenRouterCatalog({ apiKey: KEY, fetchFn: catalogFetch({ calls }), maxAdmitted: 8, rank: (left, right) => rankFreeModels(left, right) });
  assert.equal(calls.find((call) => call.url.endsWith('/api/v1/models')).auth, null, 'the public catalog is fetched without the key');
  assert.equal(calls.find((call) => call.url.endsWith('/models/user')).auth, `Bearer ${KEY}`);
  assert.doesNotMatch(JSON.stringify(catalog), new RegExp(KEY), 'the key never appears in the stored catalog');
  assert.deepEqual(catalog.admitted, ['deepseek/deepseek-r1-0528:free', 'openai/gpt-oss-120b:free'], 'best Office fit first');
  const why = Object.fromEntries(catalog.models.map((entry) => [entry.id, entry.reasons]));
  assert.deepEqual(why['google/gemma-3-27b-it:free'], ['NO_TOOL_CALLING']);
  assert.deepEqual(why['tiny/model:free'], ['CONTEXT_TOO_SMALL']);
  assert.deepEqual(why['weird/priced:free'], ['NON_ZERO_PRICE:completion']);
  assert.deepEqual(why['meta-llama/llama-3.3-70b-instruct:free'], ['BLOCKED_BY_ACCOUNT_PRIVACY_OR_PROVIDER_SETTINGS']);
  assert.equal(catalog.freeModels, 6);
  assert.equal(catalog.accessibleFreeModels, 5);
  assert.ok(!catalog.models.some((entry) => entry.id.startsWith('anthropic/')), 'paid models are never listed as free');

  const limited = await fetchOpenRouterCatalog({ apiKey: KEY, fetchFn: catalogFetch(), maxAdmitted: 1, rank: (left, right) => rankFreeModels(left, right) });
  assert.deepEqual(limited.admitted, ['deepseek/deepseek-r1-0528:free']);
  assert.deepEqual(limited.models.find((entry) => entry.id === 'openai/gpt-oss-120b:free').reasons, ['ADMISSION_LIMIT']);

  const noUserList = await fetchOpenRouterCatalog({ apiKey: KEY, fetchFn: catalogFetch({ userStatus: 403 }) });
  assert.equal(noUserList.keyScopedList, 'unavailable (HTTP_403)');
  assert.equal(noUserList.accessibleFreeModels, null);
  assert.deepEqual(freeModelVerdict({ id: 'x/y', pricing: {}, supported_parameters: ['tools'], context_length: 100000 }), ['NOT_A_FREE_VARIANT']);
});

test('each admitted free model is its own FREE, free-only, public-data-only route; coding never reaches them', async () => {
  const catalog = await fetchOpenRouterCatalog({ apiKey: KEY, fetchFn: catalogFetch(), rank: (left, right) => rankFreeModels(left, right) });
  const env = { OPENROUTER_API_KEY: KEY, OPENROUTER_API_PRIVATE_DATA_APPROVED: 'true', DEEPSEEK_API_KEY: 'sk-deepseek-test-1234', DEEPSEEK_API_TRAINING_OPTOUT_VERIFIED: 'true' };
  const pool = createModelPool({ env, openRouterCatalog: catalog });
  const routes = pool.filter((route) => route.provider === 'openrouter');
  assert.deepEqual(routes.map((route) => route.id), ['openrouter:deepseek/deepseek-r1-0528:free', 'openrouter:openai/gpt-oss-120b:free']);
  for (const route of routes) {
    assert.deepEqual(route.unavailableReasons, []);
    assert.equal(route.billingClass, 'free');
    assert.equal(route.freeOnly, true);
    assert.equal(route.privacyApproved, false, 'free OpenRouter endpoints never get private data, whatever the flag says');
  }
  const gateway = new AgentTurnGateway({ pool, stateStore: new MemoryProviderStateStore() });
  const coding = await gateway.evaluate({ requiresPrivateData: true, job: 'coding' });
  for (const entry of coding.filter((item) => item.route.provider === 'openrouter')) assert.ok(entry.reasons.includes('PRIVACY_NOT_APPROVED'), entry.route.id);
  const research = await gateway.evaluate({ requiresPrivateData: false, job: 'research' });
  const order = gateway.order(research, { job: 'research', strategy: 'economy' }).map((route) => route.id);
  assert.deepEqual(order.slice(0, 2), ['openrouter:deepseek/deepseek-r1-0528:free', 'openrouter:openai/gpt-oss-120b:free'], 'free first');
  assert.equal(order.at(-1), 'deepseek:deepseek-flash', 'paid last');
});

test('a statically configured OpenRouter model the catalog rules out is shown as unsuitable and never called', () => {
  const catalog = { fetchedAt: 'x', models: [{ id: 'openai/gpt-oss-120b:free', eligible: false, admitted: false, reasons: ['BLOCKED_BY_ACCOUNT_PRIVACY_OR_PROVIDER_SETTINGS'] }], admitted: [] };
  const route = createModelPool({ env: { OPENROUTER_API_KEY: KEY }, openRouterCatalog: catalog }).find((entry) => entry.provider === 'openrouter');
  assert.deepEqual(route.unavailableReasons, ['CATALOG_BLOCKED_BY_ACCOUNT_PRIVACY_OR_PROVIDER_SETTINGS']);
  assert.equal(route.protocolClient, null);
  const missing = createModelPool({ env: { OPENROUTER_API_KEY: KEY }, openRouterCatalog: { models: [], admitted: [] } }).find((entry) => entry.provider === 'openrouter');
  assert.deepEqual(missing.unavailableReasons, ['CATALOG_NOT_IN_OPENROUTER_FREE_CATALOG']);
});

test('free-only guard: a billed response is refused, costed honestly, quarantined for a day and the turn fails over', async () => {
  const catalog = await fetchOpenRouterCatalog({ apiKey: KEY, fetchFn: catalogFetch(), maxAdmitted: 2, rank: (left, right) => rankFreeModels(left, right) });
  const bodies = [];
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const billed = body.model === 'deepseek/deepseek-r1-0528:free';
    return json({ model: body.model, choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: { prompt_tokens: 5, completion_tokens: 1, ...(billed ? { cost: 0.0042 } : { cost: 0 }) } });
  };
  const pool = createModelPool({ env: { OPENROUTER_API_KEY: KEY }, openRouterCatalog: catalog, fetchFn }).filter((route) => route.provider === 'openrouter');
  const now = { value: Date.parse('2026-09-26T00:00:00Z') };
  const store = new MemoryProviderStateStore({ now: () => now.value });
  const settled = [];
  const gateway = new AgentTurnGateway({ pool, stateStore: store, minQualityTier: 1, now: () => now.value, sleepFn: async () => {} });
  const result = await gateway.turn({ tools: [], prepare: async () => ({ system: 'S', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
    routing: { requiresPrivateData: false, strategy: 'quality', job: 'research' }, hooks: { settle: async (reservation, usd) => settled.push(usd) } });
  assert.equal(result.route.id, 'openrouter:openai/gpt-oss-120b:free');
  assert.ok(bodies.every((body) => body.usage?.include === true), 'usage accounting requested on every free-only call');
  assert.ok(bodies.every((body) => !('models' in body) && !('route' in body)), 'no paid fallback list is ever sent');
  assert.ok(settled.includes(0.0042), 'the real reported cost is settled against the budget');
  const quarantined = (await store.snapshot()).get('openrouter:deepseek/deepseek-r1-0528:free');
  assert.equal(quarantined.lastErrorCode, 'PAID_ON_FREE_ROUTE');
  assert.equal(Date.parse(quarantined.cooldownUntil) - now.value, 24 * 3600_000);
  const again = await gateway.evaluate({ requiresPrivateData: false });
  assert.ok(again.find((entry) => entry.route.id === 'openrouter:deepseek/deepseek-r1-0528:free').reasons.some((reason) => reason.startsWith('COOLDOWN_')));
});

test('an OpenRouter 404 records WHY (data policy, no tools, unknown model) without storing provider text', async () => {
  assert.equal(providerReasonHint(404, '{"message":"No endpoints found matching your data policy (Free model publication). Configure: https://openrouter.ai/settings/privacy","code":404}'), 'DATA_POLICY');
  assert.equal(providerReasonHint(404, '{"message":"No endpoints found that support tool use.","code":404}'), 'NO_TOOL_SUPPORT');
  assert.equal(providerReasonHint(404, '{"message":"No endpoints found for openai/gpt-oss-120b:free.","code":404}'), 'MODEL_NOT_FOUND');
  assert.equal(providerReasonHint(400, '{"message":"x is not a valid model ID"}'), 'MODEL_NOT_FOUND');
  assert.equal(providerReasonHint(404, 'something else'), null);
  assert.equal(providerReasonHint(200, 'data policy'), null);

  const pool = createModelPool({ env: { OPENROUTER_API_KEY: KEY, GROQ_API_KEY: 'gsk_test_key_12345678901234' }, openRouterCatalog: null, fetchFn: async (url) => (String(url).includes('openrouter')
    ? json({ error: { message: 'No endpoints found matching your data policy (Free model publication).', code: 404 } }, 404)
    : json({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })) })
    .filter((route) => ['openrouter', 'groq'].includes(route.provider));
  const now = { value: Date.parse('2026-09-26T00:00:00Z') };
  const store = new MemoryProviderStateStore({ now: () => now.value });
  const gateway = new AgentTurnGateway({ pool, stateStore: store, minQualityTier: 1, now: () => now.value, sleepFn: async () => {} });
  const result = await gateway.turn({ tools: [], preferredRouteId: 'openrouter:openai/gpt-oss-120b:free', prepare: async () => ({ system: 'S', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }), routing: { requiresPrivateData: false } });
  assert.equal(result.route.provider, 'groq', 'work moved to the next free provider');
  const state = (await store.snapshot()).get('openrouter:openai/gpt-oss-120b:free');
  assert.equal(state.lastErrorCode, 'PROVIDER_UNSUITABLE_DATA_POLICY');
  assert.equal(state.health, 'unavailable');
  assert.equal(Date.parse(state.cooldownUntil) - now.value, 6 * 3600_000, 'not retried every turn');
  assert.doesNotMatch(JSON.stringify(state), /endpoints found/);
});

test('transient 5xx/overload: cooldown (never an auth error), checkpointed handoff, and return to rotation after the cooldown', async () => {
  const now = { value: Date.parse('2026-09-26T00:00:00Z') };
  let geminiUp = false;
  const fetchFn = async (url) => (String(url).includes('generativelanguage')
    ? (geminiUp
      ? json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } })
      : json({ error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded. Please try again later.' } }, 503))
    : json({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  const pool = createModelPool({ env: { GEMINI_API_KEY: 'AIzaTestKey_0123456789abcdefghijklmn', GROQ_API_KEY: 'gsk_test_key_12345678901234' }, openRouterCatalog: null, fetchFn })
    .filter((route) => route.id === 'gemini:gemini-flash-latest' || route.id === 'groq:openai/gpt-oss-120b');
  const store = new MemoryProviderStateStore({ now: () => now.value });
  const gateway = new AgentTurnGateway({ pool, stateStore: store, minQualityTier: 1, now: () => now.value, sleepFn: async () => {} });
  const events = [];
  const turn = () => gateway.turn({ tools: [], preferredRouteId: 'gemini:gemini-flash-latest',
    prepare: async (route, info) => { events.push(`prepare:${route.provider}:${info.switching ? 'handoff' : 'same'}`); return { system: 'S', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }; },
    routing: { requiresPrivateData: false }, hooks: { onSwitch: async (change) => events.push(`checkpoint:${change.from}->${change.to}:${change.reason.code}`) } });
  const first = await turn();
  assert.equal(first.route.provider, 'groq');
  assert.deepEqual(events, ['prepare:gemini:same', 'checkpoint:gemini:gemini-flash-latest->groq:openai/gpt-oss-120b:PROVIDER_TRANSIENT', 'prepare:groq:handoff'], 'checkpoint before the next provider is prompted');
  const state = (await store.snapshot()).get('gemini:gemini-flash-latest');
  assert.equal(state.health, 'unavailable');
  assert.notEqual(state.health, 'auth_error', 'overload never marks the credential invalid');
  assert.equal(state.lastErrorCode, 'PROVIDER_TRANSIENT');
  assert.ok(Date.parse(state.cooldownUntil) > now.value);
  const cooling = await gateway.evaluate({ requiresPrivateData: false });
  assert.ok(cooling.find((entry) => entry.route.provider === 'gemini').reasons.includes('COOLDOWN_UNAVAILABLE'), 'not hammered during the cooldown');
  now.value = Date.parse(state.cooldownUntil) + 1000;
  geminiUp = true;
  const back = await gateway.turn({ tools: [], prepare: async () => ({ system: 'S', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }), routing: { requiresPrivateData: false, strategy: 'quality' } });
  assert.equal(back.route.provider, 'gemini', 'back in rotation after the cooldown, without intervention');
  assert.equal((await store.snapshot()).get('gemini:gemini-flash-latest').health, 'healthy');
});

test('canary skips routes in cooldown, samples discovered OpenRouter models and drills free → free', async () => {
  const route = (id, extra = {}) => ({ id, provider: id.split(':')[0], model: id.split(':').slice(1).join(':'), billingClass: 'free', costTier: 1, qualityTier: 3, unavailableReasons: [], ...extra });
  assert.deepEqual(Object.values(failoverPair([route('deepseek:deepseek-flash', { billingClass: 'paid', qualityTier: 4 }), route('groq:openai/gpt-oss-120b'), route('gemini:gemini-flash-latest', { costTier: 2 })])).slice(0, 2).map((entry) => entry.id),
    ['groq:openai/gpt-oss-120b', 'gemini:gemini-flash-latest'], 'free primary and free backup of another provider');

  const calls = [];
  const client = (id) => ({ turn: async (input) => {
    calls.push(id);
    const hasResult = input.messages.some((message) => message.content.some((block) => block.type === 'tool_result'));
    return hasResult
      ? { message: { role: 'assistant', content: [{ type: 'text', text: '42' }] }, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, stopReason: 'end' }
      : { message: { role: 'assistant', content: [{ type: 'tool_call', id: 'c', name: 'add_numbers', arguments: { a: 17, b: 25 } }] }, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, stopReason: 'tool_calls' };
  } });
  const pool = [
    { ...route('gemini:gemini-flash-latest'), protocolClient: client('gemini'), contextWindow: 1e6 },
    { ...route('groq:openai/gpt-oss-120b'), protocolClient: client('groq'), contextWindow: 131072 },
    ...['a', 'b', 'c', 'd', 'e'].map((name) => ({ ...route(`openrouter:${name}/m:free`), discovered: true, protocolClient: client(`openrouter-${name}`), contextWindow: 131072 })),
  ];
  const stateStore = new MemoryProviderStateStore();
  stateStore.rows.set('gemini:gemini-flash-latest', { health: 'unavailable', cooldownUntil: new Date(Date.now() + 60_000).toISOString() });
  stateStore.rows.set('openrouter:a/m:free', { health: 'healthy', lastSuccessAt: '2026-09-25T00:00:00Z' });
  const report = await runAgenticCanary({ pool, stateStore, log: () => {}, env: { CANARY_OPENROUTER_SAMPLE: '2' } });
  assert.ok(!calls.includes('gemini'), 'a provider in cooldown is not probed');
  assert.deepEqual(report.skipped.find((entry) => entry.id === 'gemini:gemini-flash-latest').reason, 'COOLDOWN');
  const probedOpenRouter = report.routes.filter((entry) => entry.id.startsWith('openrouter:')).map((entry) => entry.id);
  assert.equal(probedOpenRouter.length, 2, 'only a sample of the shared OpenRouter allowance is used');
  assert.ok(!probedOpenRouter.includes('openrouter:a/m:free'), 'never-verified models are probed first');
  assert.equal(report.skipped.filter((entry) => entry.reason === 'NOT_SAMPLED_THIS_RUN').length, 3);

  const paidCalls = [];
  const paidPool = [
    { ...route('deepseek:deepseek-flash', { billingClass: 'paid' }), protocolClient: { turn: async (input) => { paidCalls.push('fresh'); return client('x').turn(input); } }, contextWindow: 131072 },
    { ...route('anthropic:claude-sonnet-5', { billingClass: 'paid' }), protocolClient: { turn: async (input) => { paidCalls.push('stale'); return client('y').turn(input); } }, contextWindow: 131072 },
  ];
  const paidState = new MemoryProviderStateStore();
  paidState.rows.set('deepseek:deepseek-flash', { health: 'healthy', lastSuccessAt: new Date(Date.now() - 3600_000).toISOString() });
  paidState.rows.set('anthropic:claude-sonnet-5', { health: 'healthy', lastSuccessAt: new Date(Date.now() - 48 * 3600_000).toISOString() });
  const paidReport = await runAgenticCanary({ pool: paidPool, stateStore: paidState, log: () => {}, env: {} });
  assert.ok(!paidCalls.includes('fresh'), 'a paid route verified within 24 h is not re-probed');
  assert.ok(paidCalls.includes('stale'));
  assert.equal(paidReport.skipped.find((entry) => entry.id === 'deepseek:deepseek-flash').reason, 'PAID_RECENTLY_VERIFIED');
});
