import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelPool } from '../src/model-gateway/agentic/model-pool.js';
import { classifyProviderError } from '../src/model-gateway/contracts.js';

// Every non-Anthropic route in the Model Pool, built from configuration the
// way production builds it, against a fake network: endpoint, auth header,
// request schema, tool-call normalization and error classification. Live
// verification is the provider canary; this proves the software integration.
const env = {
  OPENAI_API_KEY: 'sk-openai-test-123456', DEEPSEEK_API_KEY: 'sk-deepseek-test-1234', QWEN_API_KEY: 'sk-qwen-test-123456',
  QWEN_API_ENDPOINT: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
  KIMI_API_KEY: 'sk-kimi-test-1234567', ZHIPU_API_KEY: 'zhipu-test-key-1234', MINIMAX_API_KEY: 'minimax-test-key-123',
  GEMINI_API_KEY: 'gemini-test-key-12345', OPENROUTER_API_KEY: 'sk-or-test-123456789', OPENROUTER_MODEL: 'qwen/qwen3-coder:free',
  GROQ_API_KEY: 'gsk-test-key-1234567', GROQ_MODEL: 'openai/gpt-oss-120b',
  GITHUB_MODELS_TOKEN: 'github_pat_models_test_1234567890', CEREBRAS_API_KEY: 'csk-test-key-1234567',
  MISTRAL_API_KEY: 'mistral-test-key-12345', MISTRAL_PRICING_JSON: '{"inputPerMillion":0.4,"outputPerMillion":2}',
};
const tools = [{ name: 'add_numbers', description: 'Add', inputSchema: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] } }];
const messages = [{ role: 'user', content: [{ type: 'text', text: 'Add 17 and 25.' }] }];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function toolCallResponse(protocol) {
  if (protocol === 'openai-responses') {
    return { id: 'r', model: 'm', status: 'completed', output: [{ type: 'function_call', call_id: 'c1', name: 'add_numbers', arguments: '{"a":17,"b":25}' }], usage: { input_tokens: 10, output_tokens: 5 } };
  }
  if (protocol === 'gemini') {
    return { candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'add_numbers', args: { a: 17, b: 25 } } }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };
  }
  return { model: 'm', choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'add_numbers', arguments: '{"a":17,"b":25}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
}

const expected = {
  'openai:gpt-5.3-codex': { url: 'https://api.openai.com/v1/responses' },
  'deepseek:deepseek-flash': { url: 'https://api.deepseek.com/chat/completions', tokens: 'max_tokens' },
  'qwen:qwen3.8-flash': { url: env.QWEN_API_ENDPOINT, tokens: 'max_tokens' },
  'kimi:kimi-k2.7-code': { url: 'https://api.moonshot.ai/v1/chat/completions', tokens: 'max_completion_tokens' },
  'zhipu:glm-5.3-flash': { url: 'https://api.z.ai/api/paas/v4/chat/completions', tokens: 'max_tokens' },
  'zhipu:glm-4.7-flash': { url: 'https://api.z.ai/api/paas/v4/chat/completions', tokens: 'max_tokens' },
  'minimax:MiniMax-M2.7': { url: 'https://api.minimax.io/v1/chat/completions', tokens: 'max_tokens' },
  'gemini:gemini-flash-latest': { url: /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-flash-latest:generateContent$/ },
  'openrouter:qwen/qwen3-coder:free': { url: 'https://openrouter.ai/api/v1/chat/completions', tokens: 'max_tokens' },
  'groq:openai/gpt-oss-120b': { url: 'https://api.groq.com/openai/v1/chat/completions', tokens: 'max_tokens' },
  'groq:qwen/qwen3.8-27b': { url: 'https://api.groq.com/openai/v1/chat/completions', tokens: 'max_tokens' },
  'groq:openai/gpt-oss-20b': { url: 'https://api.groq.com/openai/v1/chat/completions', tokens: 'max_tokens' },
  'gemini:gemini-flash-lite-latest': { url: /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-flash-lite-latest:generateContent$/ },
  'zhipu:glm-4.5-flash': { url: 'https://api.z.ai/api/paas/v4/chat/completions', tokens: 'max_tokens' },
  'cerebras:gpt-oss-120b': { url: 'https://api.cerebras.ai/v1/chat/completions', tokens: 'max_completion_tokens' },
  'cerebras:qwen-3.8-27b': { url: 'https://api.cerebras.ai/v1/chat/completions', tokens: 'max_completion_tokens' },
  'mistral:mistral-medium-latest': { url: 'https://api.mistral.ai/v1/chat/completions', tokens: 'max_tokens' },
};

test('every configured non-Anthropic route calls its endpoint with its key and normalizes tool calls', async () => {
  let current = null;
  const fetchFn = async (url, init) => { current.calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) }); return json(toolCallResponse(current.protocol)); };
  const all = createModelPool({ env, fetchFn });
  const github = all.find((route) => route.provider === 'github');
  assert.deepEqual(github.unavailableReasons, ['PROVIDER_RETIRED'], 'GitHub Models was retired on 2026-07-30 and is never called');
  assert.equal(github.protocolClient, null);
  const pool = all.filter((route) => route.provider !== 'anthropic' && !route.retired);
  assert.deepEqual(pool.map((route) => route.id).toSorted(), Object.keys(expected).toSorted());
  for (const route of pool) {
    assert.deepEqual(route.unavailableReasons, [], `${route.id} is routable once configured`);
    current = { protocol: route.protocol, calls: [] };
    const result = await route.protocolClient.turn({ provider: route.provider, model: route.model, system: 'S', messages, tools, maxOutputTokens: 500 });
    const [call] = current.calls;
    const want = expected[route.id];
    if (want.url instanceof RegExp) assert.match(call.url, want.url, route.id); else assert.equal(call.url, want.url, route.id);
    const secret = env[route.secretEnv];
    const auth = call.headers.authorization || call.headers.Authorization || call.headers['x-goog-api-key'];
    assert.ok(auth === `Bearer ${secret}` || auth === secret, `${route.id} sends its own credential`);
    if (want.tokens) {
      assert.equal(call.body[want.tokens], 500, `${route.id} uses ${want.tokens}`);
      assert.equal(call.body.model, route.model);
      assert.equal(call.body.tools[0].function.name, 'add_numbers');
    }
    assert.deepEqual(result.message.content.find((block) => block.type === 'tool_call')?.arguments, { a: 17, b: 25 }, route.id);
    assert.equal(result.stopReason, 'tool_calls', route.id);
    assert.ok(result.usage.inputTokens === 10 && result.usage.outputTokens === 5, `${route.id} usage`);
    if (route.pricing) assert.ok(result.usage.costUsd > 0, `${route.id} priced`);
  }
});

test('provider HTTP errors classify into retry, failover or approval without leaking bodies', async () => {
  const cases = [[401, 'PROVIDER_AUTH', 'approval'], [403, 'PROVIDER_AUTH', 'approval'], [402, 'PROVIDER_CAPACITY', 'failover'],
    [404, 'PROVIDER_UNSUITABLE', 'failover'], [429, 'PROVIDER_RATE_LIMIT', 'retry'], [503, 'PROVIDER_TRANSIENT', 'retry']];
  for (const route of createModelPool({ env, fetchFn: async () => json({}) }).filter((entry) => entry.provider !== 'anthropic' && !entry.retired)) {
    for (const [status, code, failureClass] of cases) {
      const client = createModelPool({ env, fetchFn: async () => json({ error: { message: 'body with sk-live-secret', type: 'x' } }, status) })
        .find((entry) => entry.id === route.id).protocolClient;
      await assert.rejects(client.turn({ provider: route.provider, model: route.model, system: 'S', messages, tools, maxOutputTokens: 100 }), (error) => {
        const classified = classifyProviderError(error);
        assert.equal(classified.code, code, `${route.id} HTTP ${status}`);
        assert.equal(classified.failureClass, failureClass, `${route.id} HTTP ${status}`);
        assert.doesNotMatch(`${classified.message} ${error.message}`, /sk-live-secret/);
        return true;
      });
    }
  }
});

test('private code only reaches providers whose data-use review is recorded', () => {
  const pool = createModelPool({ env });
  const privacy = Object.fromEntries(pool.map((route) => [route.provider, route.privacyApproved]));
  assert.equal(privacy.anthropic, true);
  assert.equal(privacy.openai, true);
  for (const provider of ['deepseek', 'qwen', 'kimi', 'zhipu', 'gemini', 'openrouter', 'groq', 'minimax', 'github', 'cerebras', 'mistral']) assert.equal(privacy[provider], false, provider);
  const flagged = createModelPool({ env: { ...env, DEEPSEEK_API_TRAINING_OPTOUT_VERIFIED: 'true', MINIMAX_API_PRIVATE_DATA_APPROVED: 'true' } });
  assert.equal(flagged.find((route) => route.provider === 'deepseek').privacyApproved, true);
  assert.equal(flagged.find((route) => route.provider === 'minimax').privacyApproved, false, 'MiniMax stays blocked in code');
});

test('requests are clamped to a route\'s declared output limit', async () => {
  let sent = null;
  const pool = createModelPool({ env, fetchFn: async (url, init) => { sent = JSON.parse(init.body); return json(toolCallResponse('chat-completions')); } });
  const { AgentTurnGateway } = await import('../src/model-gateway/agentic/turn-gateway.js');
  const { MemoryProviderStateStore } = await import('../src/model-gateway/agentic/provider-state.js');
  const deepseek = pool.find((route) => route.provider === 'deepseek');
  assert.equal(deepseek.maxOutputTokens, 8192);
  const gateway = new AgentTurnGateway({ pool: [deepseek], stateStore: new MemoryProviderStateStore(), minQualityTier: 1 });
  await gateway.turn({ tools, maxOutputTokens: 16_000, routing: { requiresPrivateData: false }, prepare: async () => ({ system: 'S', messages }) });
  assert.equal(sent.max_tokens, 8192);
});
