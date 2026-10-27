// Cloudflare Workers AI repair (2026-10-26): the OpenAI-compatible route
// (/accounts/{id}/ai/v1/chat/completions) validates the tool fields against the
// model's own schema, so a no-tool request must not carry `tools: []` with
// `tool_choice: "auto"`. These tests pin the request shape, the qualification
// outcome it produces, and the unchanged shape of every other provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelPool } from '../src/model-gateway/agentic/model-pool.js';
import { setProviderCatalog } from '../src/model-gateway/agentic/provider-catalogs.js';
import { ChatCompletionsProtocol } from '../src/model-gateway/agentic/chat-completions.js';
import { qualifyRoute } from '../src/model-gateway/agentic/qualification.js';

const ACCOUNT = 'a'.repeat(32);
const KEY = 'placeholder0test0key0000000000000';
const MODELS = ['@cf/openai/gpt-oss-120b', '@cf/qwen/qwen2.5-coder-32b-instruct', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'];
const GOOD = JSON.stringify({ echo: 'BLUE-HARBOR-42', total: 36, code: 10, tagline: 'Fresh bread every morning', city: 'Porto' });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function cloudflarePool(fetchFn) {
  setProviderCatalog('cloudflare', { ok: true, models: MODELS, contexts: {} });
  try {
    return createModelPool({
      // CLOUDFLARE_PLAN=free is required for the route to run: an unstated plan
      // could be a Workers Paid plan, where neuron overage is billed.
      env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: KEY, CLOUDFLARE_PLAN: 'free' },
      fetchFn,
    });
  } finally {
    setProviderCatalog('cloudflare', null);
  }
}

// Emulates the observed Workers AI behaviour: an empty tools array with
// tool_choice "auto" is an invalid body (400), while a real tools array is
// answered, first with a tool call and then with the final answer.
function workersAiFetch(bodies) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push({ url, body });
    if (Array.isArray(body.tools) && body.tools.length === 0) {
      return json({ error: { type: 'invalid_request_error', message: 'invalid request body' } }, 400);
    }
    if (body.messages.some((message) => message.content === null)) return json({ success: false, errors: [{ code: 5006, message: 'null message content' }] }, 400);
    const usage = { prompt_tokens: 60, completion_tokens: 12 };
    if (body.tools?.length) {
      const answered = body.messages.some((message) => message.role === 'tool');
      return answered
        ? json({ choices: [{ finish_reason: 'stop', message: { content: '29' } }], usage })
        : json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'lookup_price', arguments: '{"item":"widget"}' } },
        ] } }], usage });
    }
    return json({ choices: [{ finish_reason: 'stop', message: { content: GOOD } }], usage });
  };
}

test('Cloudflare routes declare the no-empty-tools quirk and stay credential-gated', () => {
  const pool = cloudflarePool(workersAiFetch([]));
  const routes = pool.filter((route) => route.provider === 'cloudflare');
  assert.deepEqual(routes.map((route) => route.model), MODELS);
  for (const route of routes) {
    assert.deepEqual(route.protocolOptions, { omitEmptyTools: true, omitToolChoice: true, stringAssistantContent: true }, `${route.model}: empty tools and tool_choice are omitted`);
    assert.equal(route.endpoint, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1/chat/completions`);
    assert.equal(route.billingClass, 'free');
    assert.deepEqual(route.unavailableReasons, []);
  }
  setProviderCatalog('cloudflare', { ok: true, models: MODELS, contexts: {} });
  try {
    const unconfigured = createModelPool({ env: {} }).filter((route) => route.provider === 'cloudflare');
    assert.equal(unconfigured.length, MODELS.length);
    assert.ok(unconfigured.every((route) => route.unavailableReasons.includes('CREDENTIAL_MISSING')));
  } finally {
    setProviderCatalog('cloudflare', null);
  }
});

test('the qualification suite passes on Cloudflare because no call sends an empty tools array', async () => {
  const bodies = [];
  const route = cloudflarePool(workersAiFetch(bodies)).find((entry) => entry.model === '@cf/openai/gpt-oss-120b');
  const result = await qualifyRoute(route);
  assert.equal(result.status, 'qualified', JSON.stringify({ errorCode: result.errorCode, skills: result.skills }));
  assert.equal(result.passed, 7);
  assert.equal(bodies.length, 3, 'combined prompt, tool call, tool answer');
  const [combined] = bodies;
  assert.ok(!('tools' in combined.body) && !('tool_choice' in combined.body), 'the no-tool prompt sends neither field');
  for (const { body } of bodies) {
    if ('tools' in body) assert.ok(body.tools.length > 0, 'a tools field is only sent with actual tools');
  }
  assert.equal(bodies[1].body.tools[0].function.name, 'lookup_price');
  // The tool probe keeps the schema but sends no `tool_choice`: a live canary
  // on 2026-10-26 was refused with HTTP 400 / code 5006 (a model-input schema
  // rejection), and that field was the only difference from the passing call.
  assert.ok(!('tool_choice' in bodies[1].body), 'the tool probe sends no tool_choice');
  for (const { body } of bodies) assert.ok(!('tool_choice' in body), 'no Cloudflare call sends tool_choice');
});

test('a Cloudflare tool request sends tools without tool_choice, and other providers keep auto', async () => {
  const bodies = [];
  const capture = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'lookup_price', arguments: '{"item":"widget"}' } },
    ] } }], usage: { prompt_tokens: 50, completion_tokens: 10 } });
  };
  const tool = { name: 'lookup_price', description: 'Look up a price.', inputSchema: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] } };

  const route = cloudflarePool(capture).find((entry) => entry.provider === 'cloudflare');
  await route.protocolClient.turn({ provider: 'cloudflare', model: MODELS[0], system: 'S', messages: [{ role: 'user', content: [{ type: 'text', text: 'price of a widget?' }] }], tools: [tool] });
  const cloudflare = bodies.at(-1);
  assert.equal(cloudflare.tools[0].function.name, 'lookup_price');
  assert.equal(cloudflare.tools[0].function.parameters.type, 'object');
  assert.ok(!('tool_choice' in cloudflare), 'Workers AI refuses the field; auto is its default anyway');

  const other = new ChatCompletionsProtocol({ apiKey: KEY, endpoint: 'https://api.deepseek.com/v1/chat/completions', fetchFn: capture });
  await other.turn({ provider: 'deepseek', model: 'deepseek-flash', system: 'S', messages: [{ role: 'user', content: [{ type: 'text', text: 'price of a widget?' }] }], tools: [tool] });
  assert.equal(bodies.at(-1).tool_choice, 'auto', 'unchanged for every other provider');
});

test('the pre-fix body is exactly what Workers AI refused with HTTP 400', async () => {
  const bodies = [];
  const protocol = new ChatCompletionsProtocol({
    apiKey: KEY,
    endpoint: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1/chat/completions`,
    fetchFn: workersAiFetch(bodies),
  });
  await assert.rejects(
    protocol.turn({ provider: 'cloudflare', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', system: 'S', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] }),
    (error) => {
      assert.equal(error.status, 400);
      assert.doesNotMatch(error.message, /invalid request body/, 'provider text is never copied into the error');
      return true;
    },
  );
  assert.deepEqual(bodies[0].body.tools, []);
  assert.equal(bodies[0].body.tool_choice, 'auto');
});

test('every other Chat Completions provider keeps its existing wire format', async () => {
  const bodies = [];
  const protocol = new ChatCompletionsProtocol({
    apiKey: KEY,
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    fetchFn: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return json({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
    },
  });
  await protocol.turn({ provider: 'deepseek', model: 'deepseek-flash', system: 'S', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] });
  assert.deepEqual(bodies[0].tools, [], 'unchanged default');
  assert.equal(bodies[0].tool_choice, 'auto');
});

test('an empty assistant message is an error, not a successful turn that grades 0/7', async () => {
  const empty = () => json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [] } }], usage: { prompt_tokens: 40, completion_tokens: 0 } });
  const protocol = new ChatCompletionsProtocol({ apiKey: KEY, endpoint: 'https://example.test/v1/chat/completions', fetchFn: async () => empty() });
  await assert.rejects(
    protocol.turn({ provider: 'cloudflare', model: '@cf/qwen/qwen2.5-coder-32b-instruct', system: 'S', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] }),
    (error) => {
      assert.equal(error.status, 502);
      assert.equal(error.type, 'empty_response');
      return true;
    },
  );
  const route = cloudflarePool(workersAiFetch([])).find((entry) => entry.model === '@cf/qwen/qwen2.5-coder-32b-instruct');
  const result = await qualifyRoute({ ...route, protocolClient: protocol });
  assert.equal(result.status, 'error', 'a silent empty answer is recorded as a named failure');
  assert.equal(result.errorCode, 'HTTP_502');
  assert.equal(result.passed, undefined);
});

for (const provider of ['cloudflare', 'deepseek']) {
  test(`${provider} full tool round trip preserves call ids, arguments, results and assistant text`, async () => {
    const bodies = [];
    let expectedText = provider === 'cloudflare' ? '' : null;
    const fetchFn = async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.messages.some((message) => message.role === 'tool')) {
        const assistant = body.messages.find((message) => message.role === 'assistant');
        assert.equal(assistant.content, expectedText);
        assert.deepEqual(assistant.tool_calls, [{ id: 'call_1', type: 'function', function: { name: 'lookup_price', arguments: '{"item":"widget"}' } }]);
        assert.deepEqual(body.messages.at(-1), { role: 'tool', tool_call_id: 'call_1', content: '29' });
        return json({ choices: [{ finish_reason: 'stop', message: { content: '29' } }] });
      }
      return json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'lookup_price', arguments: '{"item":"widget"}' } },
      ] } }] });
    };
    const protocol = provider === 'cloudflare'
      ? cloudflarePool(fetchFn).find((route) => route.model === MODELS[0]).protocolClient
      : new ChatCompletionsProtocol({ apiKey: KEY, endpoint: 'https://api.deepseek.com/v1/chat/completions', fetchFn });
    const turn = { provider, model: provider === 'cloudflare' ? MODELS[0] : 'deepseek-flash', system: 'S',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'price?' }] }],
      tools: [{ name: 'lookup_price', description: 'Price', inputSchema: { type: 'object', properties: { item: { type: 'string' } } } }] };
    const first = await protocol.turn(turn);
    const followup = { ...turn, messages: [...turn.messages, first.message,
      { role: 'user', content: [{ type: 'tool_result', callId: 'call_1', content: '29' }] }] };
    const final = await protocol.turn(followup);
    assert.equal(final.message.content[0].text, '29');
    assert.equal(bodies.length, 2);
    for (const body of bodies) {
      assert.equal(body.tools[0].function.name, 'lookup_price');
      assert.equal(body.tool_choice, provider === 'cloudflare' ? undefined : 'auto');
    }
    // Nonempty assistant text must survive even with the compatibility option.
    first.message.content.unshift({ type: 'text', text: 'Checking the price.' });
    expectedText = 'Checking the price.';
    await protocol.turn(followup);
  });
}
