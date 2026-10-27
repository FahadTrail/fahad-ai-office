import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatCompletionsProtocol } from '../src/model-gateway/agentic/chat-completions.js';
import { qualifyRoute, QualificationStore } from '../src/model-gateway/agentic/qualification.js';

const GOOD = JSON.stringify({ echo: 'BLUE-HARBOR-42', total: 36, code: 10, tagline: 'Fresh bread every morning', city: 'Porto' });
const route = (client) => ({ id: 'cloudflare:test', provider: 'cloudflare', model: 'test', billingClass: 'free', protocolClient: client });
const response = (body) => new Response(JSON.stringify(body), { status: 200 });
const protocol = (body) => new ChatCompletionsProtocol({
  apiKey: 'offline-placeholder', endpoint: 'https://provider.invalid/chat/completions',
  omitEmptyTools: true, fetchFn: async () => response(body),
});

for (const [label, choices, messagePresent] of [
  ['missing choice', [], false],
  ['empty message', [{ message: { content: '', reasoning_content: 'PRIVATE-REASONING' }, finish_reason: 'length' }], true],
]) {
  test(`HTTP 200 ${label} remains a failure and preserves upstream status and usage through qualification storage`, async () => {
    const result = await qualifyRoute(route(protocol({ choices, usage: { prompt_tokens: 73, completion_tokens: 11 } })));
    assert.equal(result.status, 'error');
    assert.equal(result.errorCode, 'HTTP_502');
    assert.deepEqual(result.usage, { inputTokens: 73, outputTokens: 11, costUsd: 0 });
    assert.equal(result.diagnostics.status, 502);
    assert.equal(result.diagnostics.providerStatus, 200);
    assert.equal(result.diagnostics.type, 'empty_response');
    assert.equal(result.diagnostics.response.messagePresent, messagePresent);
    assert.equal(result.diagnostics.response.finishReason, messagePresent ? 'length' : 'unknown');
    let saved;
    await new QualificationStore({ from() { return { async insert(row) { saved = row; return {}; } }; } }).save([result]);
    const stored = saved.report.results[0];
    assert.equal(stored.error, undefined);
    assert.equal(stored.diagnostics.providerStatus, 200);
    assert.equal(stored.usage.outputTokens, 11);
    assert.ok(!JSON.stringify(saved).includes('PRIVATE-REASONING'));
    assert.ok(!JSON.stringify(saved).includes('offline-placeholder'));
  });
}

test('a failed follow-up includes prior successes and failed-turn usage exactly once', async () => {
  let calls = 0;
  const result = await qualifyRoute(route({ async turn() {
    calls++;
    if (calls === 3) throw Object.assign(new Error('PRIVATE-ERROR'), {
      status: 502, providerStatus: 200, type: 'empty_response',
      usage: { inputTokens: 7, outputTokens: 3, costUsd: 0 },
      responseDiagnostics: { messagePresent: true, finishReason: 'PRIVATE-TEXT', contentKind: 'PRIVATE-TEXT', toolCallsPresent: false, raw: 'PRIVATE-ERROR' },
    });
    return { model: 'test', usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 }, message: { content: calls === 1
      ? [{ type: 'text', text: GOOD }]
      : [{ type: 'tool_call', id: 'call1', name: 'lookup_price', arguments: { item: 'widget' } }] } };
  } }));
  assert.equal(calls, 3);
  assert.deepEqual(result.usage, { inputTokens: 27, outputTokens: 13, costUsd: 0 });
  assert.equal(result.toolCheck.stage, 'requesting_answer');
  assert.equal(result.toolCheck.toolCalled, true);
  const { error, ...clean } = result;
  assert.ok(!JSON.stringify(clean).includes('PRIVATE'));
});

for (const [answer, truncated, stage] of [['29', false, 'passed'], ['7.25', false, 'answer_mismatch'], ['', true, 'answer_mismatch']]) {
  test(`tool-answer diagnostics identify ${stage}, truncated=${truncated}, without storing answers or changing grading`, async () => {
    let calls = 0;
    const result = await qualifyRoute(route({ async turn(input) {
      calls++;
      if (calls === 3) {
        assert.equal(input.messages.at(-1).content[0].callId, 'call1');
        assert.deepEqual(JSON.parse(input.messages.at(-1).content[0].content), { item: 'widget', unit_price_usd: 7.25 });
      }
      return { model: 'test', usage: {}, stopReason: truncated && calls === 3 ? 'max_tokens' : 'end', message: { content: calls === 1
        ? [{ type: 'text', text: GOOD }]
        : calls === 2 ? [{ type: 'tool_call', id: 'call1', name: 'lookup_price', arguments: { item: 'widget' } }]
          : answer ? [{ type: 'text', text: answer }] : [{ type: 'tool_call', name: 'lookup_price' }] } };
    } }));
    assert.equal(result.toolCheck.stage, stage);
    assert.equal(result.toolCheck.answerTruncated, truncated);
    assert.equal(result.toolCheck.answerHasToolCalls, !answer);
    assert.equal(result.skills.tools, stage === 'passed');
    assert.deepEqual(Object.keys(result.toolCheck).sort(), ['stage', 'toolCalled', 'argumentsMatched', 'answerHasText', 'answerHasToolCalls', 'answerTruncated'].sort());
  });
}

test('unknown provider finish reasons never enter empty-response diagnostics', async () => {
  const result = await qualifyRoute(route(protocol({ choices: [{ message: { content: [] }, finish_reason: 'PRIVATE-TEXT' }] })));
  assert.equal(result.diagnostics.response.finishReason, 'unknown');
  assert.equal(result.diagnostics.response.contentKind, 'array');
  assert.ok(!JSON.stringify(result.diagnostics).includes('PRIVATE'));
});
