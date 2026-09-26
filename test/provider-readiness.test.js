import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretQwen, diagnoseQwen } from '../src/canary/qwen-diagnosis.js';
import { parseCatalog, fetchProviderCatalog, setProviderCatalog, getProviderCatalog } from '../src/model-gateway/agentic/provider-catalogs.js';
import { createModelPool } from '../src/model-gateway/agentic/model-pool.js';
import { providerSummary } from '../src/hub-coding.js';
import { blockerLabel, blockerReason, PROVIDER_FACTS } from '../src/model-gateway/agentic/provider-facts.js';
import { runtimeDiagnostics } from '../src/canary/runtime-diagnostics.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('Qwen diagnosis names the exact blocker from status codes and Model Studio error codes only', async () => {
  const unpurchased = { status: 403, code: 'AccessDenied.Unpurchased' };
  assert.equal(interpretQwen({ models: { status: 200 }, primary: unpurchased, secondary: unpurchased }).blocker, 'ACCOUNT_NOT_ACTIVATED');
  assert.equal(interpretQwen({ models: { status: 200 }, primary: unpurchased, secondary: { status: 200 } }).blocker, 'MODEL_NOT_ENTITLED');
  assert.equal(interpretQwen({ models: { status: 401, code: 'InvalidApiKey' }, primary: { status: 401 } }).blocker, 'CREDENTIAL_INVALID');
  assert.equal(interpretQwen({ models: { status: 200 }, primary: { status: 400, code: 'Arrearage' } }).blocker, 'ACCOUNT_OVERDUE');
  assert.equal(interpretQwen({ models: { status: 200 }, primary: { status: 404, code: 'model_not_found' } }).blocker, 'WRONG_MODEL_ID');
  assert.equal(interpretQwen({ models: { status: 200 }, primary: { status: 200 } }).blocker, null);

  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith('/models')) return json({ data: [{ id: 'qwen3.8-flash' }] });
    return json({ error: { code: 'AccessDenied.Unpurchased', message: 'Access to model denied. secret-ish text' } }, 403);
  };
  const report = await diagnoseQwen({ env: { QWEN_API_KEY: 'sk-qwen-test-1234567890' }, fetchFn });
  assert.equal(report.blocker, 'ACCOUNT_NOT_ACTIVATED');
  assert.equal(report.endpointHost, 'dashscope-intl.aliyuncs.com');
  assert.equal(calls.length, 3, 'model list + two 1-token probes, nothing more');
  assert.ok(calls.slice(1).every((call) => call.body.max_tokens === 1));
  assert.doesNotMatch(JSON.stringify(report), /secret-ish|sk-qwen/, 'no provider text or key in the report');
  assert.deepEqual(await diagnoseQwen({ env: {} }), { configured: false });
});

test('provider catalogs keep chat model ids only and rule out models a provider no longer serves', async () => {
  const groq = parseCatalog('groq', { data: [{ id: 'openai/gpt-oss-120b', context_window: 131072 }, { id: 'whisper-large-v3' }, { id: 'meta-llama/llama-prompt-guard-2-22m' }, { id: 'qwen/qwen3.8-27b', context_window: 131072 }] });
  assert.deepEqual(groq.models, ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b']);
  const gemini = parseCatalog('gemini', { models: [{ name: 'models/gemini-flash-lite-latest', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576 }, { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }] });
  assert.deepEqual(gemini.models, ['gemini-flash-lite-latest']);
  const denied = await fetchProviderCatalog('groq', { env: { GROQ_API_KEY: 'gsk_test_key_1234567890' }, fetchFn: async () => json({ error: { code: 'invalid_api_key', message: 'Invalid API Key gsk_…' } }, 401) });
  assert.deepEqual([denied.ok, denied.status, denied.reason], [false, 401, 'invalid_api_key']);
  assert.equal((await fetchProviderCatalog('cerebras', { env: {} })).reason, 'CREDENTIAL_MISSING');

  setProviderCatalog('groq', { ok: true, models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'] });
  try {
    const pool = createModelPool({ env: { GROQ_API_KEY: 'gsk_test_key_1234567890' } }).filter((route) => route.provider === 'groq');
    const byId = Object.fromEntries(pool.map((route) => [route.id, route]));
    assert.deepEqual(byId['groq:qwen/qwen3.8-27b'].unavailableReasons, ['CATALOG_MODEL_NOT_IN_PROVIDER_CATALOG'], 'a removed/renamed model is never called');
    assert.deepEqual(byId['groq:openai/gpt-oss-120b'].unavailableReasons, []);
    assert.equal(byId['groq:openai/gpt-oss-120b'].requestTokenLimit, 8000, 'Groq free plan: 8K tokens per minute bounds each request');
    assert.equal(byId['groq:openai/gpt-oss-120b'].capabilities.contextWindow, 8000);
  } finally {
    setProviderCatalog('groq', null);
  }
  assert.equal(getProviderCatalog('groq'), null);
});

test('provider classification follows the checked facts: Cerebras promo, GitHub retired, GLM Flash free, Qwen paid', () => {
  const pool = createModelPool({ env: { CEREBRAS_API_KEY: 'csk-test-key-1234567', ZHIPU_API_KEY: 'zhipu-test-key-1234', GITHUB_MODELS_TOKEN: 'github_pat_test_12345678901' } });
  const byId = Object.fromEntries(pool.map((route) => [route.id, route]));
  assert.equal(byId['cerebras:gpt-oss-120b'].billingClass, 'promo');
  assert.equal(byId['cerebras:qwen-3.8-27b'].billingClass, 'promo');
  assert.equal(byId['cerebras:gpt-oss-120b'].contextWindow, 65_000);
  assert.deepEqual(byId['github:openai/gpt-4.1'].unavailableReasons, ['PROVIDER_RETIRED']);
  assert.equal(byId['zhipu:glm-4.7-flash'].billingClass, 'free');
  assert.equal(byId['zhipu:glm-4.7-flash'].contextWindow, 200_000);
  assert.equal(byId['zhipu:glm-4.5-flash'].billingClass, 'free');
  assert.equal(byId['qwen:qwen3.8-flash'].billingClass, 'paid');
  assert.equal(byId['gemini:gemini-flash-lite-latest'].billingClass, 'free');
  for (const route of pool.filter((entry) => entry.billingClass !== 'paid')) assert.equal(route.privacyApproved, false, `${route.id} stays public-data-only`);
  assert.equal(PROVIDER_FACTS.github.offer, 'RETIRED');
});

test('the provider view names real blockers instead of a generic OFFLINE and never invents quota', () => {
  assert.equal(blockerReason('PROVIDER_AUTH_ACCOUNT_NOT_ACTIVATED'), 'ACCOUNT_NOT_ACTIVATED');
  assert.equal(blockerLabel('qwen', 'ACCOUNT_NOT_ACTIVATED'), 'MODEL STUDIO ACTIVATION REQUIRED');
  const route = (provider, extra) => ({ provider, status: 'NOT CONFIGURED', credentialStatus: 'MISSING', billingClass: 'FREE', qualification: { status: 'NOT YET QUALIFIED' }, retired: false, ...extra });
  const summary = Object.fromEntries(providerSummary([
    route('gemini', { status: 'LIVE', credentialStatus: 'PRESENT', qualification: { status: 'QUALIFIED' } }),
    route('gemini', { status: 'CONFIGURED — NOT YET VERIFIED', credentialStatus: 'PRESENT' }),
    route('cerebras', { billingClass: 'PROMO' }),
    route('github', { retired: true, credentialStatus: 'NOT APPLICABLE (RETIRED)' }),
    route('qwen', { status: 'BLOCKED — MODEL STUDIO ACTIVATION REQUIRED', credentialStatus: 'PRESENT', billingClass: 'PAID', accountBlocker: { reason: 'ACCOUNT_NOT_ACTIVATED', label: 'MODEL STUDIO ACTIVATION REQUIRED' } }),
  ]).map((entry) => [entry.provider, entry]));
  assert.equal(summary.gemini.status, 'LIVE');
  assert.equal(summary.gemini.qualifiedModels, 1);
  assert.equal(summary.cerebras.status, 'READY — CREDENTIAL REQUIRED');
  assert.equal(summary.cerebras.offer, 'PROMO');
  assert.equal(summary.github.status, 'RETIRED');
  assert.equal(summary.qwen.status, 'BLOCKED — MODEL STUDIO ACTIVATION REQUIRED');
  assert.equal(summary.qwen.blocker.reason, 'ACCOUNT_NOT_ACTIVATED');
  assert.ok(Object.values(summary).every((entry) => !('percent' in entry)));
});

test('runtime diagnostics report endpoint hosts and credential presence only', async () => {
  const report = await runtimeDiagnostics({
    env: { QWEN_API_ENDPOINT: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', QWEN_API_KEY: 'sk-secret-value-123', CEREBRAS_API_KEY: '' },
    fetchFn: async () => new Response('ok', { status: 200 }), resolve: async () => [{ address: '1.2.3.4' }],
  });
  assert.equal(report.settings.QWEN_API_ENDPOINT_HOST, 'dashscope-intl.aliyuncs.com');
  assert.equal(report.credentials.QWEN_API_KEY, true);
  assert.equal(report.credentials.CEREBRAS_API_KEY, false);
  assert.doesNotMatch(JSON.stringify(report), /sk-secret-value/);
});

test('without CODING_SUPABASE_ACCESS_TOKEN the Supabase tools are never offered; with it they keep their approval rules', async () => {
  const { supabaseTokenConfigured } = await import('../src/coding-agent/controller.js');
  const { modelToolSpecs, CODING_TOOL_DEFINITIONS } = await import('../src/coding-agent/tools.js');
  assert.equal(supabaseTokenConfigured({}), false);
  assert.equal(supabaseTokenConfigured({ CODING_SUPABASE_ACCESS_TOKEN: 'x'.repeat(20) }), true);
  assert.ok(!modelToolSpecs({ supabase: false }).some((tool) => /supabase/.test(tool.name)));
  assert.equal(modelToolSpecs({ supabase: true }).filter((tool) => /supabase/.test(tool.name)).length, 3);
  const byName = Object.fromEntries(CODING_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]));
  assert.equal(byName['supabase.query_read'].action, 'read');
  assert.equal(byName['supabase.query_write'].risk, 'high');
  assert.equal(byName['supabase.migration_apply'].risk, 'high');
});
