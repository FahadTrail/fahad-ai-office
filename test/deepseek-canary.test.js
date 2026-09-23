import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDeepSeekCanary } from '../src/canary/deepseek-canary.js';

test('live DeepSeek canary records usage without returning provider text', async () => {
  const output = await runDeepSeekCanary({
    env: { DEEPSEEK_API_KEY: 'test-only-deepseek-key' },
    fetchFn: async () => ({
      ok: true,
      headers: new Headers({ 'x-request-id': 'request-secret-not-returned' }),
      json: async () => ({ model: 'deepseek-flash', output_text: '{"canary":"ok"}', usage: { input_tokens: 12, output_tokens: 5 } }),
    }),
  });
  assert.equal(output.ok, true);
  assert.equal(output.provider, 'deepseek');
  assert.equal(output.inputTokens, 12);
  assert.equal('text' in output, false);
  assert.equal(JSON.stringify(output).includes('request-secret'), false);
});

test('simulated DeepSeek outage preserves a checkpoint before Anthropic takeover', async () => {
  const checkpointDirectory = await mkdtemp(join(tmpdir(), 'phase2c-canary-test-'));
  async function* queryFn() {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: '{"canary":"ok"}' }] } };
    // Deliberately above the $0.01 live-provider ceiling: the controlled
    // Anthropic drill has a separate, still-low allowance for SDK context.
    yield { type: 'result', subtype: 'success', result: '{"canary":"ok"}', usage: { input_tokens: 20, output_tokens: 6 }, total_cost_usd: 0.02 };
  }
  const output = await runDeepSeekCanary({
    env: { DEEPSEEK_API_KEY: 'test-only-deepseek-key', ANTHROPIC_API_KEY: 'test-only-anthropic-key' },
    queryFn,
    forceFailover: true,
    checkpointDirectory,
  });
  assert.equal(output.provider, 'anthropic');
  assert.equal(output.providerSwitches, 1);
  assert.equal(output.checkpointPreserved, true);
  assert.equal(output.costUsd, 0.02);
  assert.deepEqual(output.attempts.map(({ provider, status }) => ({ provider, status })), [
    { provider: 'deepseek', status: 'failed' },
    { provider: 'anthropic', status: 'succeeded' },
  ]);
  const files = await import('node:fs/promises').then(({ readdir }) => readdir(checkpointDirectory));
  const checkpoint = JSON.parse(await readFile(join(checkpointDirectory, files[0]), 'utf8'));
  assert.equal(checkpoint.fromProvider, 'deepseek');
  assert.equal(checkpoint.toProvider, 'anthropic');
  assert.equal('prompt' in checkpoint, false);
});
