import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentTurnGateway } from '../src/model-gateway/agentic/turn-gateway.js';
import { MemoryProviderStateStore } from '../src/model-gateway/agentic/provider-state.js';
import { exhaustedRoutes, MemoryRoutingPolicyStore, normalizeRouting, resolveRouting } from '../src/model-gateway/agentic/routing-policy.js';
import { createCodingRuntime } from '../src/coding-agent/runtime.js';

const route = (id, extra = {}) => ({
  id, provider: id.split(':')[0], model: id.split(':')[1], billingClass: 'paid', qualityTier: 4, costTier: 2, contextWindow: 200_000,
  toolCalling: true, privacyApproved: true, unavailableReasons: [], pricing: { inputPerMillion: 1, outputPerMillion: 1 }, ...extra,
});
const pool = [
  route('anthropic:claude-opus-5', { qualityTier: 5, costTier: 4 }),
  route('anthropic:claude-sonnet-5', { qualityTier: 5, costTier: 3 }),
  route('deepseek:deepseek-flash', { costTier: 1 }),
  route('gemini:gemini-2.5-flash', { billingClass: 'free', costTier: 2 }),
  route('promo:model', { billingClass: 'promo', costTier: 3 }),
];

async function ordered(routing = {}, evaluate = {}) {
  const gateway = new AgentTurnGateway({ pool, stateStore: new MemoryProviderStateStore(), minQualityTier: 4 });
  const evaluations = await gateway.evaluate({ requiresPrivateData: true, ...evaluate });
  return gateway.order(evaluations, routing).map((entry) => entry.id);
}

test('default routing is free-first, then included/promo, then the cheapest paid route', async () => {
  const routing = resolveRouting({ env: {} });
  assert.deepEqual([...routing.billingPriority], ['free', 'included', 'promo', 'paid']);
  assert.equal(routing.strategy, 'economy');
  assert.deepEqual(await ordered(routing), ['gemini:gemini-2.5-flash', 'promo:model', 'deepseek:deepseek-flash', 'anthropic:claude-sonnet-5', 'anthropic:claude-opus-5']);
});

test('quality strategy keeps billing classes first but prefers the best paid model', async () => {
  // Equal quality ties go to the cheaper route.
  assert.deepEqual((await ordered({ strategy: 'quality', billingPriority: ['paid'] })).slice(0, 3), ['anthropic:claude-sonnet-5', 'anthropic:claude-opus-5', 'deepseek:deepseek-flash']);
});

test('task routing overrides workspace routing, which overrides the environment', () => {
  const routing = resolveRouting({
    env: { CODING_ROUTING_STRATEGY: 'quality', CODING_BILLING_PRIORITY: 'paid,free' },
    workspace: { strategy: 'balanced', allow_paid: false, excluded_routes: ['anthropic:claude-opus-5'] },
    task: { strategy: 'economy' },
  });
  assert.equal(routing.strategy, 'economy');
  assert.deepEqual(routing.billingPriority, ['paid', 'free']);
  assert.equal(routing.allowPaid, false);
  assert.deepEqual(routing.excludedRoutes, ['anthropic:claude-opus-5']);
});

test('untrusted routing input is sanitized, never widened', () => {
  assert.deepEqual(normalizeRouting({ strategy: 'yolo', billingPriority: ['paid', 'bogus', 'paid'], allowPaid: 'yes', excludedRoutes: ['bad id', 'x:y'], routeMonthlyBudgetUsd: { 'x:y': 2, 'x:z': -1, 'x:w': 'NaN' } }),
    { billingPriority: ['paid'], excludedRoutes: ['x:y'], routeMonthlyBudgetUsd: { 'x:y': 2 } });
});

test('excluded, capped and paid-disallowed routes are ineligible with a visible reason', async () => {
  const gateway = new AgentTurnGateway({ pool, stateStore: new MemoryProviderStateStore(), minQualityTier: 4 });
  const evaluations = await gateway.evaluate({
    requiresPrivateData: true, allowPaid: false,
    policyExcludedRouteIds: ['gemini:gemini-2.5-flash'],
    budgetExhaustedRouteIds: exhaustedRoutes({ routeMonthlyBudgetUsd: { 'promo:model': 1 } }, new Map([['promo:model', 1.2]])),
  });
  const reasons = Object.fromEntries(evaluations.map((entry) => [entry.route.id, entry.reasons]));
  assert.ok(reasons['gemini:gemini-2.5-flash'].includes('EXCLUDED_BY_ROUTING_POLICY'));
  assert.ok(reasons['promo:model'].includes('ROUTE_BUDGET_EXHAUSTED'));
  assert.ok(reasons['deepseek:deepseek-flash'].includes('PAID_ROUTE_NOT_ALLOWED'));
  assert.equal(evaluations.filter((entry) => entry.eligible).length, 0);
});

test('the runtime resolves workspace routing and per-route caps for each turn', async () => {
  const routingStore = new MemoryRoutingPolicyStore({
    policies: { w1: normalizeRouting({ strategy: 'quality', routeMonthlyBudgetUsd: { 'anthropic:claude-opus-5': 0.5 } }) },
    spend: { w1: { 'anthropic:claude-opus-5': 0.51 } },
  });
  const runtime = createCodingRuntime({
    env: {}, pool, sessionStore: {}, providerStateStore: new MemoryProviderStateStore(), policyStore: {}, auditStore: {}, routingStore, sandboxMode: 'unisolated',
  });
  const routing = await runtime.controller.routingFor({ workspaceId: 'w1' }, { allowPaid: true });
  assert.equal(routing.strategy, 'quality');
  assert.deepEqual(routing.exhaustedRoutes, ['anthropic:claude-opus-5']);
});

test('a task can lower reasoning effort, which reaches the provider request', async () => {
  assert.equal(resolveRouting({ env: {}, task: { effort: 'low' } }).effort, 'low');
  assert.equal(normalizeRouting({ effort: 'extreme' }).effort, undefined);
  const { AnthropicMessagesProtocol } = await import('../src/model-gateway/agentic/anthropic-messages.js');
  const { OpenAIResponsesProtocol } = await import('../src/model-gateway/agentic/openai-responses.js');
  let anthropicParams = null;
  const client = { messages: { create: (params) => { anthropicParams = params; return { withResponse: async () => ({ data: { id: 'm', model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }, response: { headers: new Headers() } }) }; } } };
  const anthropic = new AnthropicMessagesProtocol({ client, pricing: null, effort: 'high' });
  await anthropic.turn({ provider: 'anthropic', model: 'claude-sonnet-5', system: 'S', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], effort: 'low' });
  assert.deepEqual(anthropicParams.output_config, { effort: 'low' });
  await anthropic.turn({ provider: 'anthropic', model: 'claude-sonnet-5', system: 'S', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] });
  assert.deepEqual(anthropicParams.output_config, { effort: 'high' }, 'route default when the task sets none');
  let openaiBody = null;
  const openai = new OpenAIResponsesProtocol({ apiKey: 'sk-test-123456789', fetchFn: async (url, init) => { openaiBody = JSON.parse(init.body); return new Response(JSON.stringify({ id: 'r', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } }); } });
  await openai.turn({ provider: 'openai', model: 'gpt', system: 'S', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], effort: 'max' });
  assert.deepEqual(openaiBody.reasoning, { effort: 'high' });
});
