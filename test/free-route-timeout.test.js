import test from 'node:test';
import assert from 'node:assert/strict';
import { routeTimeoutMs, FREE_ROUTE_TIMEOUT_MS, defaultProtocolFactory } from '../src/model-gateway/agentic/model-pool.js';

test('free routes get a bounded request timeout; paid routes keep their default', () => {
  assert.equal(routeTimeoutMs({ billingClass: 'free' }), FREE_ROUTE_TIMEOUT_MS);
  assert.equal(routeTimeoutMs({ billingClass: 'paid', freeOnly: true }), FREE_ROUTE_TIMEOUT_MS);
  assert.equal(routeTimeoutMs({ billingClass: 'paid' }), undefined);
  assert.equal(routeTimeoutMs({ billingClass: 'free' }, { FREE_ROUTE_TIMEOUT_MS: '60000' }), 60_000);
  assert.equal(routeTimeoutMs({ billingClass: 'free' }, { FREE_ROUTE_TIMEOUT_MS: '5' }), FREE_ROUTE_TIMEOUT_MS);
});

test('the protocol factory applies the free-route timeout', () => {
  const free = defaultProtocolFactory({ protocol: 'chat-completions', billingClass: 'free', endpoint: 'https://example.invalid/v1/chat/completions', pricing: {} }, { apiKey: 'k', fetchFn: fetch, env: {} });
  assert.equal(free.timeoutMs, FREE_ROUTE_TIMEOUT_MS);
  const gemini = defaultProtocolFactory({ protocol: 'gemini', billingClass: 'free', pricing: {} }, { apiKey: 'k', fetchFn: fetch, env: {} });
  assert.equal(gemini.timeoutMs, FREE_ROUTE_TIMEOUT_MS);
  const paid = defaultProtocolFactory({ protocol: 'chat-completions', billingClass: 'paid', endpoint: 'https://example.invalid/v1/chat/completions', pricing: {} }, { apiKey: 'k', fetchFn: fetch, env: {} });
  assert.equal(paid.timeoutMs, 600_000);
});
