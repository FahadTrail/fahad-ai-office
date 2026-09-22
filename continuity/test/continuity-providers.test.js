import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIAdapter } from '../src/continuity-providers.js';

test('provider credentials discard surrounding control whitespace before authorization', async () => {
  let authorization;
  const fetchFn = async (_url, init) => {
    authorization = init.headers.authorization;
    return new Response(JSON.stringify({
      model: 'gpt-5.3-codex',
      output_text: '{"ok":true}',
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const adapter = new OpenAIAdapter({ apiKey: '  test-key\r\n', fetchFn });
  const result = await adapter.complete({ instructions: 'test', input: 'test' });
  assert.equal(authorization, 'Bearer test-key');
  assert.deepEqual(result.data, { ok: true });
});
