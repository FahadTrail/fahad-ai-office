// Capacity Expansion V2: pool registry, data classes, provider contract,
// route lifecycle, new providers (catalog-gated) and OmniRoute harvesting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createModelPool, modelPoolDefinitions } from '../src/model-gateway/agentic/model-pool.js';
import { capacityPool, poolSummary } from '../src/model-gateway/agentic/capacity-pools.js';
import { allowsDataClass, DATA_CLASSES, poolFacts, publishedTokenAllowance, requiredDataClass, routeDataClass } from '../src/model-gateway/agentic/pool-registry.js';
import { CONTRACT_FIELDS, contractViolations, routeContract, routeLifecycle } from '../src/model-gateway/agentic/provider-contract.js';
import { MemoryQualificationStore, qualificationBackoffUntil, qualificationCandidates, qualificationGaps, QUALIFICATION_SUITE_VERSION } from '../src/model-gateway/agentic/qualification.js';
import { createCodingRuntime } from '../src/coding-agent/runtime.js';
import { AgentTurnGateway } from '../src/model-gateway/agentic/turn-gateway.js';
import { MemoryProviderStateStore } from '../src/model-gateway/agentic/provider-state.js';
import { catalogChanges, setProviderCatalog, parseCatalog } from '../src/model-gateway/agentic/provider-catalogs.js';
import { harvest, parseTables } from '../tools/omniroute-harvest.mjs';

const KEY = 'test-key-1234567890abcdef';
const ENV = {
  OPENCODE_ZEN_API_KEY: KEY, LLM7_API_KEY: KEY, OLLAMA_API_KEY: KEY, CLOUDFLARE_API_TOKEN: KEY, CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  GROQ_API_KEY: KEY, OPENROUTER_API_KEY: KEY, GEMINI_API_KEY: KEY, ZHIPU_API_KEY: KEY, DEEPSEEK_API_KEY: KEY, ANTHROPIC_API_KEY: KEY,
};
const catalog = (models, contexts = {}) => ({ ok: true, status: 200, fetchedAt: new Date().toISOString(), models, contexts });
function withCatalogs(fn) {
  setProviderCatalog('opencode', catalog(['big-pickle', 'space-bunny-free', 'muse-spark-1.3-contributor-free', 'gpt-5.5', 'longcat-2.5-preview-free'], { 'big-pickle': 200_000 }));
  setProviderCatalog('llm7', catalog(['gpt-oss-120b', 'qwen3-coder-plus', 'mistral-small', 'tiny-model', 'deepseek-v3.2', 'kimi-k2', 'glm-4.6', 'llama-4-scout']));
  setProviderCatalog('ollama', catalog(['gpt-oss:120b', 'qwen3-coder:480b']));
  setProviderCatalog('cloudflare', catalog(['@cf/openai/gpt-oss-120b', '@cf/qwen/qwen2.5-coder-32b-instruct']));
  try { return fn(); } finally { for (const provider of ['opencode', 'llm7', 'ollama', 'cloudflare']) setProviderCatalog(provider, null); }
}
const qualified = (ids, status = 'qualified') => new Map(ids.map((id) => [id, { suiteVersion: QUALIFICATION_SUITE_VERSION, status, testedAt: new Date().toISOString(), skills: { instruction: true, structured: true, reasoning: true, coding: true, writing: true, reading: true, tools: true } }]));

test('new providers exist only while their own catalog lists the model (promotion expiry removes the route)', () => {
  assert.equal(modelPoolDefinitions(ENV).filter((route) => ['opencode', 'llm7', 'ollama', 'cloudflare'].includes(route.provider)).length, 0, 'no catalog → no routes (never a guess)');
  withCatalogs(() => {
    const routes = modelPoolDefinitions(ENV);
    const zen = routes.filter((route) => route.provider === 'opencode').map((route) => route.model).sort();
    assert.deepEqual(zen, ['big-pickle', 'longcat-2.5-preview-free', 'space-bunny-free'], 'only free-listed ids; paid gpt-5.5 and prompt-training contributor models are never routes');
    assert.equal(routes.find((route) => route.id === 'opencode:space-bunny-free').dataClass, 'NORMAL');
    assert.equal(routes.find((route) => route.id === 'opencode:big-pickle').dataClass, 'PUBLIC');
    assert.equal(routes.find((route) => route.id === 'opencode:big-pickle').contextWindow, 200_000);
    const llm7 = routes.filter((route) => route.provider === 'llm7').map((route) => route.model);
    assert.ok(llm7.length <= 4 && llm7.includes('gpt-oss-120b') && !llm7.includes('tiny-model') && !llm7.includes('mistral-small'));
    assert.deepEqual(routes.filter((route) => route.provider === 'ollama').map((route) => route.model), ['gpt-oss:120b', 'qwen3-coder:480b']);
    assert.match(routes.find((route) => route.provider === 'cloudflare').endpoint, /accounts\/a{32}\/ai\/v1\/chat\/completions$/);
    for (const route of routes.filter((entry) => ['opencode', 'llm7', 'ollama', 'cloudflare'].includes(entry.provider))) {
      assert.equal(route.billingClass, 'free');
      assert.equal(route.requiresQualification, true, route.id);
      assert.equal(route.privacyApproved, false, `${route.id}: PRIVATE only with the owner flag`);
    }
  });
  // The promotion ends: the id leaves Zen's list → the route disappears.
  setProviderCatalog('opencode', catalog(['space-bunny-free']));
  try { assert.deepEqual(modelPoolDefinitions(ENV).filter((route) => route.provider === 'opencode').map((route) => route.model), ['space-bunny-free']); }
  finally { setProviderCatalog('opencode', null); }
});

test('capacity pools deduplicate shared quotas; each route has one pool id', () => {
  withCatalogs(() => {
    const pool = createModelPool({ env: ENV, protocolFactory: () => ({}) });
    const zenPools = new Set(pool.filter((route) => route.provider === 'opencode').map((route) => route.capacityPool.id));
    assert.deepEqual([...zenPools], ['opencode:free'], 'three Zen models, ONE pool');
    assert.deepEqual([...new Set(pool.filter((route) => route.provider === 'llm7').map((route) => route.capacityPool.id))], ['llm7:free']);
    assert.deepEqual([...new Set(pool.filter((route) => route.provider === 'cloudflare').map((route) => route.capacityPool.id))], ['cloudflare:neurons']);
    const groq = pool.filter((route) => route.provider === 'groq').map((route) => route.capacityPool.id);
    assert.equal(new Set(groq).size, groq.length, 'Groq limits are per model: separate pools');
    const summary = poolSummary(pool, new Map());
    assert.equal(summary.filter((entry) => entry.id === 'opencode:free').length, 1);
    assert.equal(summary.find((entry) => entry.id === 'opencode:free').models.length, 3);
  });
});

test('pool registry: published limits, reset kinds, UNKNOWN stays unknown, one-time is not recurring', () => {
  const groq = poolFacts({ provider: 'groq', model: 'openai/gpt-oss-120b', billingClass: 'free' });
  assert.equal(groq.limits.tokensPerDay, 200_000);
  assert.equal(groq.confidence, 'PUBLISHED');
  assert.deepEqual(publishedTokenAllowance(groq), { perDay: 200_000, perMonth: 6_000_000, basis: 'PUBLISHED' });
  const llm7 = poolFacts({ provider: 'llm7', model: 'x', billingClass: 'free', quotaPool: { id: 'llm7:free', shared: true } });
  assert.equal(llm7.limits.tokensPerDay, 1_000_000);
  const zen = poolFacts({ provider: 'opencode', model: 'big-pickle', billingClass: 'free', quotaPool: { id: 'opencode:free', shared: true } });
  assert.equal(zen.kind, 'promo');
  assert.equal(zen.limits.tokensPerDay, null, 'no published number → UNKNOWN, never invented');
  assert.deepEqual(publishedTokenAllowance(zen), { perDay: null, perMonth: null, basis: 'UNKNOWN' });
  const cerebras = poolFacts({ provider: 'cerebras', model: 'gpt-oss-120b', billingClass: 'promo' });
  assert.deepEqual(publishedTokenAllowance(cerebras), { perDay: 0, perMonth: 0, basis: 'one-time' }, 'trial credit is not recurring capacity');
  assert.equal(poolFacts({ provider: 'deepseek', model: 'deepseek-flash', billingClass: 'paid' }).kind, 'paid');
  assert.equal(poolFacts({ provider: 'gemini', model: 'gemini-flash-lite-latest', billingClass: 'free' }).limits.requestsPerDay, 500);
  assert.equal(poolFacts({ provider: 'gemini', model: 'gemini-flash-latest', billingClass: 'free' }).resetTimeZone, 'America/Los_Angeles');
});

test('data classes: PUBLIC < NORMAL < PRIVATE < CONFIDENTIAL, enforced by the gateway', async () => {
  assert.deepEqual(DATA_CLASSES, ['PUBLIC', 'NORMAL', 'PRIVATE', 'CONFIDENTIAL']);
  const publicFree = { provider: 'openrouter', billingClass: 'free', privacyApproved: false };
  const normalFree = { provider: 'cloudflare', billingClass: 'free', privacyApproved: false, dataClass: 'NORMAL' };
  const approvedFree = { provider: 'ollama', billingClass: 'free', privacyApproved: true, dataClass: 'NORMAL' };
  const anthropic = { provider: 'anthropic', billingClass: 'paid', privacyApproved: true };
  const deepseek = { provider: 'deepseek', billingClass: 'paid', privacyApproved: true };
  assert.deepEqual([publicFree, normalFree, approvedFree, anthropic, deepseek].map(routeDataClass), ['PUBLIC', 'NORMAL', 'PRIVATE', 'CONFIDENTIAL', 'PRIVATE']);
  assert.equal(routeDataClass({ ...publicFree, dataClass: 'CONFIDENTIAL' }), 'PUBLIC', 'a route cannot declare itself above NORMAL');
  assert.equal(allowsDataClass(normalFree, 'NORMAL'), true);
  assert.equal(allowsDataClass(normalFree, 'PRIVATE'), false);
  assert.equal(allowsDataClass(deepseek, 'CONFIDENTIAL'), false);
  assert.equal(requiredDataClass({ requiresPrivateData: true }), 'PRIVATE', 'legacy boolean keeps its meaning');
  assert.equal(requiredDataClass({ requiresPrivateData: false }), 'PUBLIC');
  withCatalogs(() => {});
  // Gateway: a NORMAL task may use a NORMAL route but never a PUBLIC one.
  const pool = await withCatalogs(() => createModelPool({ env: ENV, protocolFactory: () => ({}) }));
  const gateway = new AgentTurnGateway({ pool, stateStore: new MemoryProviderStateStore() });
  const all = pool.map((route) => route.id);
  const verdicts = await gateway.evaluate({ dataClass: 'NORMAL', job: 'content', qualifications: qualified(all) });
  const byId = new Map(verdicts.map((entry) => [entry.route.id, entry]));
  assert.ok(byId.get('openrouter:openai/gpt-oss-120b:free').reasons.includes('DATA_CLASS_NOT_ALLOWED'));
  assert.ok(!byId.get('cloudflare:@cf/openai/gpt-oss-120b').reasons.includes('DATA_CLASS_NOT_ALLOWED'));
  const privateTask = await gateway.evaluate({ requiresPrivateData: true, job: 'content', qualifications: qualified(all) });
  assert.ok(privateTask.find((entry) => entry.route.id === 'cloudflare:@cf/openai/gpt-oss-120b').reasons.includes('PRIVACY_NOT_APPROVED'), 'free NORMAL routes never get private code without the owner flag');
});

test('owner privacy flags lift only zero-retention routes to PRIVATE', () => {
  withCatalogs(() => {
    const routes = modelPoolDefinitions({ ...ENV, OPENCODE_ZEN_PRIVATE_DATA_APPROVED: 'true', OLLAMA_API_PRIVATE_DATA_APPROVED: 'true' });
    assert.equal(routes.find((route) => route.id === 'opencode:space-bunny-free').privacyApproved, true);
    assert.equal(routes.find((route) => route.id === 'opencode:big-pickle').privacyApproved, false, 'a model that may train on data stays PUBLIC even with the flag');
    assert.equal(routes.find((route) => route.id === 'ollama:gpt-oss:120b').privacyApproved, true);
    assert.equal(routes.filter((route) => route.provider === 'llm7').every((route) => route.privacyApproved === false), true);
  });
});

test('lifecycle: discovered routes take no job until qualified (fail closed, even without a qualification store)', () => {
  withCatalogs(() => {
    const [route] = createModelPool({ env: ENV, protocolFactory: () => ({}) }).filter((entry) => entry.id === 'ollama:gpt-oss:120b');
    assert.deepEqual(qualificationGaps(route, 'content', null), ['NOT_YET_QUALIFIED']);
    assert.deepEqual(qualificationGaps(route, null, new Map()), ['NOT_YET_QUALIFIED']);
    assert.deepEqual(qualificationGaps(route, 'content', qualified([route.id], 'failed')), ['NOT_YET_QUALIFIED']);
    assert.deepEqual(qualificationGaps(route, 'content', qualified([route.id])), []);
    assert.equal(routeLifecycle(route, {}), 'DISCOVERED');
    assert.equal(routeLifecycle(route, { state: new Map([[route.id, { health: 'healthy', requests: 2 }]]) }), 'CANARY');
    assert.equal(routeLifecycle(route, { qualifications: qualified([route.id]) }), 'QUALIFIED');
    assert.equal(routeLifecycle(route, { qualifications: qualified([route.id]), state: new Map([[route.id, { health: 'healthy', requests: 5 }]]) }), 'ACTIVE');
    assert.equal(routeLifecycle(route, { state: new Map([[route.id, { health: 'auth_error' }]]) }), 'BLOCKED');
  });
  const [unconfigured] = createModelPool({ env: {}, protocolFactory: () => ({}) });
  assert.equal(routeLifecycle(unconfigured, {}), 'NOT_CONFIGURED');
});

test('provider contract: every route definition declares the required fields', () => {
  withCatalogs(() => {
    const routes = modelPoolDefinitions({ ...ENV, MISTRAL_PRICING_JSON: '{"inputPerMillion":1,"outputPerMillion":2}', OPENAI_PRICING_JSON: '{"inputPerMillion":1,"outputPerMillion":2}' });
    for (const route of routes) assert.deepEqual(contractViolations(route), [], route.id);
    const contract = routeContract(routes.find((route) => route.id === 'opencode:big-pickle'));
    assert.deepEqual(Object.keys(contract).sort(), [...CONTRACT_FIELDS].sort());
    assert.equal(contract.capacity_pool_id, 'opencode:free');
    assert.equal(contract.privacy_class, 'PUBLIC');
    assert.deepEqual(contract.cost, { inputPerMillion: 0, outputPerMillion: 0 });
    assert.equal(contract.reset.kind, 'promo');
  });
  assert.ok(contractViolations({ provider: 'x', model: 'm', billingClass: 'paid', contextWindow: 1000, secretEnv: 'X', protocol: 'chat-completions' }).includes('cost'), 'a paid route without pricing is incomplete');
  assert.ok(contractViolations({ provider: 'x', model: 'm', billingClass: 'free', contextWindow: 1000, secretEnv: 'X', protocol: 'chat-completions', dataClass: 'PRIVATE' }).includes('privacy_class'));
});

test('Cloudflare catalog parsing and a missing account id keep the route unconfigured', () => {
  const parsed = parseCatalog('cloudflare', { result: [{ name: '@cf/openai/gpt-oss-120b', properties: [{ property_id: 'context_window', value: '128000' }] }, { name: '@cf/baai/bge-large-en-v1.5' }] });
  assert.deepEqual(parsed.models, ['@cf/openai/gpt-oss-120b'], 'embeddings are not chat routes');
  assert.equal(parsed.contexts['@cf/openai/gpt-oss-120b'], 128_000);
  setProviderCatalog('cloudflare', catalog(['@cf/openai/gpt-oss-120b']));
  try {
    const [route] = createModelPool({ env: { CLOUDFLARE_API_TOKEN: KEY }, protocolFactory: () => ({}) }).filter((entry) => entry.provider === 'cloudflare');
    assert.ok(route.unavailableReasons.includes('ENDPOINT_NOT_CONFIGURED'));
  } finally { setProviderCatalog('cloudflare', null); }
});

test('secret setup knows every new provider credential', () => {
  const script = readFileSync(new URL('../ops/set-secret.sh', import.meta.url), 'utf8');
  for (const name of ['LLM7_API_KEY', 'OPENCODE_ZEN_API_KEY', 'OLLAMA_API_KEY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) assert.match(script, new RegExp(name));
});

test('OmniRoute harvest: consumer logins, cookies and reverse-engineered apps are rejected; recurring API-key tiers are candidates', () => {
  const reference = [
    '## No-auth Providers (no key required) (2)', '| ID | Alias | Name | Tags | Website | Notes | Tool calling |', '|----|----|----|----|----|----|----|',
    '| `chipotle` | `p` | Chipotle | No-auth | [link](https://x) | Uses the public support chatbot via reverse-engineered SockJS protocol. | — |',
    '| `aihorde` | `h` | AI Horde | No-auth | [link](https://aihorde.net) | Uses the documented anonymous key. | — |',
    '## OAuth Providers (1)', '| ID | Alias | Name | Tags | Website | Notes |', '|---|---|---|---|---|---|',
    '| `kiro` | `k` | Kiro | OAuth | [link](https://kiro.dev) | Sign in with your account. |',
    '## Web Cookie Providers (1)', '| ID | Alias | Name | Tags | Website | Notes |', '|---|---|---|---|---|---|',
    '| `qwen-web` | `q` | Qwen Web | Web cookie | [link](https://chat.qwen.ai) | Session cookie. |',
    '## API Key Providers (paid / paid-with-free-credits) (4)', '| ID | Alias | Name | Tags | Website | Notes |', '|---|---|---|---|---|---|',
    '| `llm7` | `l` | LLM7 | API key | [link](https://llm7.io) | Free token. |',
    '| `together` | `t` | Together | API key | [link](https://together.ai) | $25 free credits on signup |',
    '| `freebuff` | `f` | Freebuff | API key | [link](https://freebuff.com) | Auth token obtained via CLI login or automated harvester. |',
    '| `aimlapi` | `a` | AI/ML | API key | [link](https://aimlapi.com) | Free tier paused (2026) — pay-as-you-go only. |',
  ].join('\n');
  const tiers = ['| Provider | Free type | Steady tokens/mo | First-month credit | ToS | Models |', '|---|---|---|---|---|---|',
    '| `llm7` | recurring | ~150M | — | caution | 4 |', '| `together` | signup credit | — | ~25M | caution | 1 |', '| `kiro` | recurring | ~25K | — | avoid | 12 |'].join('\n');
  assert.equal(parseTables(reference).length, 8);
  const verdicts = Object.fromEntries(harvest(reference, tiers).map((entry) => [entry.id, entry.verdict]));
  assert.deepEqual(verdicts, {
    chipotle: 'REJECTED_WEB_SCRAPING', aihorde: 'REJECTED_WEB_SCRAPING', kiro: 'REJECTED_CONSUMER_LOGIN', 'qwen-web': 'REJECTED_WEB_SCRAPING',
    llm7: 'CANDIDATE', together: 'NO_RECURRING_FREE', freebuff: 'REJECTED_CONSUMER_LOGIN', aimlapi: 'NO_RECURRING_FREE',
  });
});

test('qualification back-off: a refused model waits a day, a transient failure an hour (no 20-minute re-probing)', async () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
  assert.ok(qualificationBackoffUntil({ errorCode: 'HTTP_404', testedAt: at(60) }, now));
  assert.equal(qualificationBackoffUntil({ errorCode: 'HTTP_404', testedAt: at(25 * 60) }, now), null);
  assert.ok(qualificationBackoffUntil({ errorCode: 'HTTP_429', testedAt: at(30) }, now));
  assert.equal(qualificationBackoffUntil({ errorCode: 'HTTP_429', testedAt: at(61) }, now), null);
  assert.equal(qualificationBackoffUntil(null, now), null);

  const store = new MemoryQualificationStore();
  const route = (id) => ({ id, provider: id.split(':')[0], model: id.split(':')[1], billingClass: 'free', protocolClient: {}, unavailableReasons: [], qualityTier: 1 });
  const pool = [route('gemini:dead'), route('groq:busy'), route('zhipu:fresh')];
  await store.save([
    { routeId: 'gemini:dead', status: 'error', errorCode: 'HTTP_404', testedAt: at(120) },
    { routeId: 'groq:busy', status: 'error', errorCode: 'HTTP_429', testedAt: at(90) },
  ]);
  const ids = qualificationCandidates(pool, { qualifications: await store.snapshot(), now, maxPerProvider: null }).map((r) => r.id);
  assert.deepEqual(ids.toSorted(), ['groq:busy', 'zhipu:fresh']);
  // A later success clears the error record.
  await store.save([{ routeId: 'gemini:dead', status: 'qualified', suiteVersion: QUALIFICATION_SUITE_VERSION, testedAt: at(1) }]);
  assert.equal((await store.snapshot()).errors.has('gemini:dead'), false);
});

test('coding runtime hands qualification evidence to routing (and tolerates a failing store)', async () => {
  const evidence = qualified(['ollama:gpt-oss:120b']);
  const base = { sessionStore: {}, providerStateStore: new MemoryProviderStateStore(), policyStore: null, auditStore: {}, pool: [], sandboxMode: 'unisolated' };
  const ok = createCodingRuntime({ ...base, qualificationStore: { snapshot: async () => evidence } });
  const policy = await ok.routingFor({ workspaceId: 'w' }, {});
  assert.equal(policy.qualifications, evidence);
  const broken = createCodingRuntime({ ...base, qualificationStore: { snapshot: async () => { throw new Error('db down'); } } });
  assert.equal((await broken.routingFor({ workspaceId: 'w' }, {})).qualifications, null);
  const none = createCodingRuntime(base);
  assert.equal((await none.routingFor({ workspaceId: 'w' }, {})).qualifications, null);
});

test('catalog change detection: added, removed and context-window changes (null when unchanged)', () => {
  const before = catalog(['a', 'b', 'c'], { a: 8_000, b: 32_000 });
  assert.equal(catalogChanges(before, catalog(['c', 'b', 'a'], { a: 8_000, b: 32_000 })), null);
  const changes = catalogChanges(before, catalog(['a', 'b', 'd'], { a: 16_000, b: 32_000 }));
  assert.deepEqual(changes, { added: ['d'], removed: ['c'], contextChanged: [{ model: 'a', from: 8_000, to: 16_000 }] });
});

test('Cloudflare error 4006 (daily neurons used up) is a daily quota until 00:00 UTC; new providers have reset schedules', async () => {
  const { postJson } = await import('../src/model-gateway/agentic/http.js');
  const { FREE_ALLOWANCES, nextResetAt } = await import('../src/model-gateway/agentic/free-quota.js');
  const fetchFn = async () => new Response(JSON.stringify({ success: false, errors: [{ code: 4006, message: 'you have used up your daily free allocation of 10,000 neurons' }] }), { status: 400, headers: { 'content-type': 'application/json' } });
  const error = await postJson({ fetchFn, url: 'https://api.cloudflare.com/x', headers: {}, body: {}, provider: 'cloudflare' }).catch((caught) => caught);
  assert.equal(error.status, 429);
  assert.equal(error.quotaScope, 'day');
  assert.equal(nextResetAt(FREE_ALLOWANCES.cloudflare.reset, Date.parse('2026-09-29T20:00:00Z')), '2026-09-30T00:00:00.000Z');
  for (const provider of ['cloudflare', 'llm7', 'ollama', 'opencode']) assert.ok(FREE_ALLOWANCES[provider]?.reset, provider);
});

test('a timeout while reading the response body is a NETWORK failure, not DOMException code 23', async () => {
  const { postJson } = await import('../src/model-gateway/agentic/http.js');
  const { classifyProviderError } = await import('../src/model-gateway/contracts.js');
  const fetchFn = async () => ({
    ok: true, status: 200, headers: new Headers(),
    json: async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); },
  });
  const error = await postJson({ fetchFn, url: 'https://openrouter.ai/x', headers: {}, body: {}, provider: 'openrouter' }).catch((caught) => caught);
  assert.equal(error.code, 'NETWORK');
  assert.equal(error.networkCode, 'TimeoutError');
  assert.equal(classifyProviderError(error).code, 'PROVIDER_NETWORK');
});

test('Gemini 429 quota details: the reported per-minute input-token quota and retry delay are kept as numbers', async () => {
  const { postJson, googleQuotaDetails } = await import('../src/model-gateway/agentic/http.js');
  const body = { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota', details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count', quotaId: 'GenerateContentInputTokensPerModelPerMinute-FreeTier', quotaValue: '15000' }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' },
  ] } };
  assert.deepEqual(googleQuotaDetails(body), { retryAfterSeconds: 37, inputTokensPerMinute: 15_000, requestsPerMinute: null });
  assert.deepEqual(googleQuotaDetails({ error: { message: 'x' } }), { retryAfterSeconds: null, inputTokensPerMinute: null, requestsPerMinute: null });
  const fetchFn = async () => new Response(JSON.stringify(body), { status: 429, headers: { 'content-type': 'application/json' } });
  const error = await postJson({ fetchFn, url: 'https://generativelanguage.googleapis.com/x', headers: {}, body: {}, provider: 'gemini' }).catch((caught) => caught);
  assert.equal(error.status, 429);
  assert.equal(error.retryAfter, 37);
  assert.equal(error.rateLimit.inputTokensPerMinute, 15_000);
  assert.equal(error.quotaScope, undefined, 'a per-minute quota is not a daily one');
  assert.ok(!JSON.stringify(error.rateLimit).includes('exceeded'), 'no provider text kept');
});

test('a request above the provider-reported input TPM is not offered to that route; a coding turn above it is not coding capacity', async () => {
  const { AgentTurnGateway } = await import('../src/model-gateway/agentic/turn-gateway.js');
  const { MemoryProviderStateStore } = await import('../src/model-gateway/agentic/provider-state.js');
  const { routeClasses } = await import('../src/model-gateway/agentic/capacity-model.js');
  const route = {
    id: 'gemini:gemma', provider: 'gemini', model: 'gemma', billingClass: 'free', qualityTier: 4, contextWindow: 256_000, unavailableReasons: [],
    capabilities: { coding: 4, reasoning: 4, toolCalling: true, structuredOutput: true, contextWindow: 256_000 }, protocolClient: {},
  };
  const store = new MemoryProviderStateStore();
  await store.recordFailure(route, Object.assign(new Error('x'), { code: 'PROVIDER_RATE_LIMIT', failureClass: 'retry', retryAfter: 37, rateLimit: { inputTokensPerMinute: 15_000 } }));
  const gateway = new AgentTurnGateway({ pool: [route], stateStore: store, now: () => Date.now() + 60_000 });
  const reasons = async (estimatedInputTokens) => (await gateway.evaluate({ dataClass: 'PUBLIC', estimatedInputTokens, maxOutputTokens: 2_000 }))[0].reasons;
  assert.ok((await reasons(20_000)).includes('REQUEST_ABOVE_PROVIDER_TPM'));
  assert.deepEqual(await reasons(10_000), [], 'a smaller request still fits');
  const general = { status: 'qualified', suiteVersion: 'q1-2026-09', testedAt: new Date().toISOString(), skills: { coding: true, tools: true, reasoning: true, structured: true, instruction: true, reading: true, writing: true } };
  const coding = { status: 'qualified', grade: 'CODING_PRIMARY', suiteVersion: 'c2-2026-09', testedAt: new Date().toISOString() };
  const qualifications = Object.assign(new Map([[route.id, general]]), { coding: new Map([[route.id, coding]]) });
  assert.ok(routeClasses({ ...route, dataClass: 'PUBLIC' }, qualifications, {}).has('coding_public'));
  // Production 2026-09-29: Gemini reported Gemma's quota as 16K input tokens/min.
  assert.ok(routeClasses({ ...route, dataClass: 'PUBLIC' }, qualifications, { state: { rateLimit: { inputTokensPerMinute: 16_000 } } }).has('coding_public'), '16K/min holds a small job turn (p90 9.1K)');
  assert.ok(!routeClasses({ ...route, dataClass: 'PUBLIC' }, qualifications, { state: { rateLimit: { inputTokensPerMinute: 8_000 } } }).has('coding_public'), '8K/min (Groq free) does not');
  const { capacityModel, codingTurnLimit, CODING_TURN_TOKENS_BY_SIZE } = await import('../src/model-gateway/agentic/capacity-model.js');
  assert.equal(codingTurnLimit(route, { rateLimit: { inputTokensPerMinute: 16_000 } }), 16_000);
  assert.equal(codingTurnLimit({ ...route, requestTokenLimit: 8_000 }), 8_000);
  assert.equal(codingTurnLimit({ ...route, contextWindow: 32_000 }), 24_000);
  const facts = { ...route, dataClass: 'PUBLIC', quotaPool: 'test:pool', requestsPerDay: 1_000 };
  const model = capacityModel({ routes: [facts], pools: [{ id: 'test:pool', state: 'available' }], qualifications, states: new Map([[route.id, { rateLimit: { inputTokensPerMinute: 16_000 } }]]) });
  assert.equal(model.pools[0].codingTurnLimit, 16_000);
  if (model.pools[0].allowance.perDay == null) assert.equal(model.pools[0].rateCeilingPerDay, 16_000 * 1_440, 'rate ceiling, never summed');
  assert.equal(model.perClass.general.tokensPerDay, model.pools[0].effectivePerDay ?? 0, 'the ceiling is not added to totals');
  assert.equal(model.publicCodingJobsPerDay.small.turnTokens, CODING_TURN_TOKENS_BY_SIZE.small);
  assert.equal(model.publicCodingJobsPerDay.small.pools, 1, 'small jobs: counted');
  assert.equal(model.publicCodingJobsPerDay.medium.pools, 1, 'medium turns (16K) fit exactly');
  assert.equal(model.publicCodingJobsPerDay.large.pools, 0, 'large turns (30K) do not fit a 16K/min quota');
});
