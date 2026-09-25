import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatCompletionsProtocol, toChatMessages } from '../src/model-gateway/agentic/chat-completions.js';
import { OpenAIResponsesProtocol, toResponsesInput } from '../src/model-gateway/agentic/openai-responses.js';
import { GeminiProtocol, toGeminiContents } from '../src/model-gateway/agentic/gemini.js';
import { AnthropicMessagesProtocol, toAnthropicMessages } from '../src/model-gateway/agentic/anthropic-messages.js';
import { parseRateLimitHeaders } from '../src/model-gateway/agentic/http.js';
import { renderRecentActivity, validateConversation, portableSchema } from '../src/model-gateway/agentic/conversation.js';

const tools = [{ name: 'read_file', description: 'Read a file', inputSchema: {
  type: 'object', properties: { path: { type: 'string', maxLength: 10 } }, required: ['path'], additionalProperties: false,
} }];
const transcript = [
  { role: 'user', content: [{ type: 'text', text: 'Fix the bug' }] },
  { role: 'assistant', content: [
    { type: 'reasoning', provider: 'anthropic', model: 'claude-opus-5', data: { type: 'thinking', thinking: '', signature: 'sig' } },
    { type: 'text', text: 'Reading.' },
    { type: 'tool_call', id: 'call_1', name: 'read_file', arguments: { path: 'a.js' } },
  ] },
  { role: 'user', content: [{ type: 'tool_result', callId: 'call_1', name: 'read_file', content: 'export const a = 1;', isError: false }] },
];

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('neutral conversations validate tool call/result pairing', () => {
  assert.equal(validateConversation(transcript), transcript);
  assert.throws(() => validateConversation([transcript[0], transcript[2]]), /no matching call/);
});

test('portable schemas drop keywords some providers reject', () => {
  assert.deepEqual(portableSchema(tools[0].inputSchema), {
    type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
  });
});

test('chat-completions translation round-trips tool calls and results', async () => {
  const messages = toChatMessages('SYS', transcript);
  assert.deepEqual(messages.map((message) => message.role), ['system', 'user', 'assistant', 'tool']);
  assert.equal(messages[2].tool_calls[0].function.arguments, '{"path":"a.js"}');
  assert.equal(messages[3].tool_call_id, 'call_1');
  let sent;
  const protocol = new ChatCompletionsProtocol({
    apiKey: 'test-key-123456', endpoint: 'https://example.test/v1/chat/completions',
    pricing: { inputPerMillion: 1, outputPerMillion: 2 },
    fetchFn: async (url, init) => {
      sent = JSON.parse(init.body);
      return jsonResponse({ model: 'm', choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
        { id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.js"}' } },
      ] } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }, { headers: { 'x-ratelimit-remaining-requests': '42' } });
    },
  });
  const result = await protocol.turn({ provider: 'deepseek', model: 'm', system: 'SYS', messages: transcript, tools });
  assert.equal(sent.tools[0].function.name, 'read_file');
  assert.equal(result.stopReason, 'tool_calls');
  assert.deepEqual(result.message.content[0], { type: 'tool_call', id: 'call_2', name: 'read_file', arguments: { path: 'b.js' } });
  assert.equal(result.usage.costUsd, 0.0012);
  assert.equal(result.rateLimit.requestsRemaining, 42);
});

test('chat-completions surfaces 429 with retry metadata and no body text', async () => {
  const protocol = new ChatCompletionsProtocol({
    apiKey: 'test-key-123456', endpoint: 'https://example.test/v1/chat/completions',
    fetchFn: async () => jsonResponse({ error: { type: 'rate_limit_exceeded', message: 'secret detail' } }, { status: 429, headers: { 'retry-after': '7' } }),
  });
  await assert.rejects(protocol.turn({ provider: 'x', model: 'm', system: 'S', messages: transcript, tools }), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.retryAfter, '7');
    assert.doesNotMatch(error.message, /secret detail/);
    return true;
  });
});

test('responses translation uses stateless function-call items', async () => {
  const input = toResponsesInput(transcript);
  assert.deepEqual(input.map((item) => item.type || item.role), ['user', 'assistant', 'function_call', 'function_call_output']);
  let sent;
  const protocol = new OpenAIResponsesProtocol({
    apiKey: 'test-key-123456', pricing: { inputPerMillion: 1, outputPerMillion: 1 },
    fetchFn: async (url, init) => {
      sent = JSON.parse(init.body);
      return jsonResponse({ id: 'r1', model: 'gpt', status: 'completed', output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', content: [{ type: 'output_text', text: 'Done.' }] },
      ], usage: { input_tokens: 10, output_tokens: 5 } });
    },
  });
  const result = await protocol.turn({ provider: 'openai', model: 'gpt', system: 'S', messages: transcript, tools });
  assert.equal(sent.store, false);
  assert.equal(sent.instructions, 'S');
  assert.equal(result.stopReason, 'end');
  assert.equal(result.message.content[0].text, 'Done.');
});

test('gemini translation echoes thought signatures only to the same model', async () => {
  const withSignature = [transcript[0], { role: 'assistant', content: [
    { type: 'tool_call', id: 'g1', name: 'read_file', arguments: { path: 'a' }, providerData: { provider: 'gemini', model: 'gm', thoughtSignature: 'TS' } },
  ] }, { role: 'user', content: [{ type: 'tool_result', callId: 'g1', name: 'read_file', content: 'x' }] }];
  assert.equal(toGeminiContents(withSignature, { provider: 'gemini', model: 'gm' })[1].parts[0].thoughtSignature, 'TS');
  assert.equal(toGeminiContents(withSignature, { provider: 'gemini', model: 'other' })[1].parts[0].thoughtSignature, undefined);
  const protocol = new GeminiProtocol({
    apiKey: 'test-key-123456',
    fetchFn: async (url) => {
      assert.match(String(url), /models\/gm:generateContent$/);
      return jsonResponse({ candidates: [{ finishReason: 'STOP', content: { parts: [
        { functionCall: { name: 'read_file', args: { path: 'c' } }, thoughtSignature: 'NEW' },
      ] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } });
    },
  });
  const result = await protocol.turn({ provider: 'gemini', model: 'gm', system: 'S', messages: transcript, tools });
  assert.equal(result.message.content[0].providerData.thoughtSignature, 'NEW');
  assert.equal(result.stopReason, 'tool_calls');
});

test('anthropic translation keeps same-model thinking blocks and maps tool use', async () => {
  const native = toAnthropicMessages(transcript);
  assert.equal(native[1].content[0].type, 'thinking');
  assert.equal(native[1].content[2].type, 'tool_use');
  assert.equal(native[2].content[0].tool_use_id, 'call_1');
  const headers = new Headers({ 'request-id': 'req_1', 'anthropic-ratelimit-requests-remaining': '9' });
  let params;
  const client = { messages: { create: (body) => {
    params = body;
    return { withResponse: async () => ({ response: { headers }, data: {
      id: 'msg', model: 'claude-sonnet-5', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu', name: 'read_file', input: { path: 'z' } }],
      usage: { input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 10 },
    } }) };
  } } };
  const protocol = new AnthropicMessagesProtocol({ client, pricing: { inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 10 } });
  const result = await protocol.turn({ provider: 'anthropic', model: 'claude-sonnet-5', system: 'S', messages: transcript, tools });
  // Thinking produced by another model is not replayed.
  assert.equal(params.messages[1].content[0].type, 'text');
  assert.deepEqual(params.cache_control, { type: 'ephemeral' });
  assert.equal(result.usage.inputTokens, 1100);
  assert.equal(result.usage.costUsd, 0.0005);
  assert.equal(result.rateLimit.requestsRemaining, 9);
});

test('rate-limit headers are parsed without inventing values', () => {
  assert.equal(parseRateLimitHeaders(new Headers({})), null);
  const parsed = parseRateLimitHeaders(new Headers({ 'x-ratelimit-reset-requests': '2s', 'x-ratelimit-limit-requests': '60' }));
  assert.equal(parsed.requestsLimit, 60);
  assert.equal(parsed.requestsRemaining, null);
  assert.ok(Date.parse(parsed.requestsReset) > Date.now());
});

test('handoff rendering keeps recent facts and bounds size', () => {
  const rendered = renderRecentActivity(transcript);
  assert.match(rendered, /TOOL CALL read_file/);
  assert.match(rendered, /TOOL RESULT read_file: export const a = 1;/);
  assert.ok(renderRecentActivity(transcript, { maxChars: 40 }).includes('omitted'));
});
