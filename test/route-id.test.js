import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRouteId, formatRouteId } from '../src/model-gateway/agentic/route-id.js';

// A route id is `provider:model`. The model part may itself contain colons
// (`openrouter:qwen/qwen3-coder:free`), so only the first colon separates.

test('parseRouteId splits a simple provider:model id', () => {
  assert.deepEqual(parseRouteId('anthropic:claude-opus-5'), { provider: 'anthropic', model: 'claude-opus-5' });
});

test('parseRouteId keeps colons inside the model part', () => {
  assert.deepEqual(parseRouteId('openrouter:qwen/qwen3-coder:free'), { provider: 'openrouter', model: 'qwen/qwen3-coder:free' });
});

test('formatRouteId joins provider and model', () => {
  assert.equal(formatRouteId('openrouter', 'qwen/qwen3-coder:free'), 'openrouter:qwen/qwen3-coder:free');
});

test('formatRouteId and parseRouteId round-trip', () => {
  assert.deepEqual(parseRouteId(formatRouteId('anthropic', 'claude-opus-5')), { provider: 'anthropic', model: 'claude-opus-5' });
  assert.deepEqual(parseRouteId(formatRouteId('openrouter', 'qwen/qwen3-coder:free')), { provider: 'openrouter', model: 'qwen/qwen3-coder:free' });
});

test('parseRouteId rejects malformed ids with a TypeError', () => {
  for (const id of ['', 'nocolon', ':model', 'provider:', 42, null, undefined, {}]) {
    assert.throws(() => parseRouteId(id), TypeError, `expected ${String(id)} to be rejected`);
  }
});

test('formatRouteId rejects missing provider or model with a TypeError', () => {
  for (const [provider, model] of [['', 'model'], ['provider', ''], [null, 'model'], ['provider', undefined], ['provider', 7]]) {
    assert.throws(() => formatRouteId(provider, model), TypeError);
  }
});
