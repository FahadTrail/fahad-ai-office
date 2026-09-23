import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runQwenCanary } from '../src/canary/qwen-canary.js';

const qwenEnv = {
  QWEN_API_KEY: 'test-only-qwen-key-1234',
  QWEN_API_PRIVATE_DATA_APPROVED: 'true',
  QWEN_API_ENDPOINT: 'https://workspace-123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
};

test('live Qwen canary records usage without returning provider text', async () => {
  let receivedBody;
  const output = await runQwenCanary({
    env: qwenEnv,
    fetchFn: async (_url, init) => {
      receivedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'x-request-id': 'request-secret-not-returned' }),
        json: async () => ({
          model: 'qwen3.8-flash',
          choices: [{ message: { content: '{"canary":"ok"}' } }],
          usage: { prompt_tokens: 12, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } },
        }),
      };
    },
  });
  assert.equal(output.ok, true);
  assert.equal(output.provider, 'qwen');
  assert.equal(output.model, 'qwen3.8-flash');
  assert.equal(receivedBody.model, 'qwen3.8-flash');
  assert.equal(output.inputTokens, 12);
  assert.equal(output.cachedInputTokens, 2);
  assert.equal('text' in output, false);
  assert.equal(JSON.stringify(output).includes('request-secret'), false);
});

test('Qwen canary rejects missing approval and legacy shared endpoint before network access', async () => {
  let calls = 0;
  const fetchFn = async () => { calls += 1; throw new Error('must not call'); };
  await assert.rejects(runQwenCanary({ env: { ...qwenEnv, QWEN_API_PRIVATE_DATA_APPROVED: '' }, fetchFn }), /authorization/);
  await assert.rejects(runQwenCanary({ env: { ...qwenEnv, QWEN_API_ENDPOINT: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions' }, fetchFn }), /QWEN_API_ENDPOINT/);
  assert.equal(calls, 0);
});

test('simulated Qwen outage checkpoints before Anthropic takeover', async () => {
  const checkpointDirectory = await mkdtemp(join(tmpdir(), 'phase2c1-qwen-canary-test-'));
  async function* queryFn() {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: '{"canary":"ok"}' }] } };
    yield { type: 'result', subtype: 'success', result: '{"canary":"ok"}', usage: { input_tokens: 20, output_tokens: 6 }, total_cost_usd: 0.02 };
  }
  const output = await runQwenCanary({
    env: { ...qwenEnv, ANTHROPIC_API_KEY: 'test-only-anthropic-key' },
    queryFn,
    forceFailover: true,
    checkpointDirectory,
  });
  assert.equal(output.provider, 'anthropic');
  assert.equal(output.providerSwitches, 1);
  assert.equal(output.checkpointPreserved, true);
  assert.deepEqual(output.attempts.map(({ provider, status }) => ({ provider, status })), [
    { provider: 'qwen', status: 'failed' },
    { provider: 'anthropic', status: 'succeeded' },
  ]);
  const files = await readdir(checkpointDirectory);
  const checkpoint = JSON.parse(await readFile(join(checkpointDirectory, files[0]), 'utf8'));
  assert.equal(checkpoint.fromProvider, 'qwen');
  assert.equal(checkpoint.toProvider, 'anthropic');
  assert.equal('prompt' in checkpoint, false);
});
