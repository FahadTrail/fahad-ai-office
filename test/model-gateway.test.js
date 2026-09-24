import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelGateway } from '../src/model-gateway/gateway.js';
import { OpenAIResponsesAdapter } from '../src/model-gateway/adapters/openai.js';
import { DeepSeekResponsesAdapter } from '../src/model-gateway/adapters/deepseek.js';
import { QwenChatAdapter } from '../src/model-gateway/adapters/qwen.js';
import { KimiChatAdapter } from '../src/model-gateway/adapters/kimi.js';
import { ZhipuChatAdapter } from '../src/model-gateway/adapters/zhipu.js';
import { MiniMaxChatAdapter } from '../src/model-gateway/adapters/minimax.js';
import { ActionPolicyEngine, POLICY_DECISION, RoutingPolicy } from '../src/model-gateway/policy.js';
import { CONFIRMED_TARGET_PROVIDERS, PROVIDER_CATALOG, PROVIDER_STATE } from '../src/model-gateway/provider-catalog.js';
import { resolveGatewayRoutingScope } from '../src/model-gateway/factory.js';
import { classifyProviderError } from '../src/model-gateway/contracts.js';

const baseRequest = Object.freeze({
  prompt: 'Return a safe result.',
  systemPrompt: 'Follow the task policy.',
  model: 'claude-test',
  maxTurns: 2,
  stage: 'unit-test',
  idempotencyKey: 'run-1:unit-test',
  capabilities: ['text'],
  context: { jobId: 'job-1', taskId: 'task-1', runId: 'run-1' },
});

test('automatic fallback configuration is scoped to workspace-enforced gateways', () => {
  const configured = {
    defaultProvider: 'anthropic',
    allowedProviders: ['anthropic', 'deepseek'],
    failoverEnabled: true,
    autoSelectEnabled: false,
  };
  assert.deepEqual(resolveGatewayRoutingScope(configured), {
    defaultProvider: 'anthropic',
    allowedProviders: ['anthropic'],
    failoverEnabled: false,
    autoSelectEnabled: false,
  });
  assert.deepEqual(resolveGatewayRoutingScope({ ...configured, workspacePolicyStore: {} }), configured);
});

test('retryable primary failure checkpoints before the same task continues on backup', async () => {
  const order = [];
  const primary = adapter('anthropic', 'claude-test', async () => {
    order.push('anthropic');
    const error = new Error('rate limited');
    error.status = 429;
    throw error;
  });
  const backup = adapter('openai', 'gpt-test', async ({ idempotencyKey }) => {
    order.push('openai');
    assert.equal(idempotencyKey, baseRequest.idempotencyKey);
    return result('continued safely', 'gpt-test');
  });
  const gateway = createGateway([primary, backup], { failoverEnabled: true });
  const checkpoints = [];
  const attempts = [];
  const output = await gateway.execute(baseRequest, {
    onAttempt: async (attempt) => attempts.push(attempt),
    onCheckpoint: async (checkpoint) => { order.push('checkpoint'); checkpoints.push(checkpoint); },
  });

  assert.deepEqual(order, ['anthropic', 'checkpoint', 'openai']);
  assert.equal(output.provider, 'openai');
  assert.equal(output.model, 'gpt-test');
  assert.equal(output.providerSwitches, 1);
  assert.equal(checkpoints[0].context.runId, 'run-1');
  assert.deepEqual(output.attempts.map((attempt) => attempt.status), ['failed', 'succeeded']);
  assert.ok(attempts.every((attempt) => !('prompt' in attempt)));
});

test('untyped provider connection failures are retryable and eligible for fallback', () => {
  const error = classifyProviderError(new Error('fetch failed after provider connection timeout'));
  assert.equal(error.code, 'PROVIDER_TRANSIENT');
  assert.equal(error.failureClass, 'retry');
});

test('authentication failures require approval and never call a backup provider', async () => {
  let backupCalls = 0;
  const primary = adapter('anthropic', 'claude-test', async () => {
    const error = new Error('bad key');
    error.status = 401;
    throw error;
  });
  const backup = adapter('openai', 'gpt-test', async () => { backupCalls += 1; return result('no', 'gpt-test'); });
  const gateway = createGateway([primary, backup], { failoverEnabled: true });
  await assert.rejects(gateway.execute(baseRequest), (error) => {
    assert.equal(error.code, 'NEEDS_HUMAN_APPROVAL');
    return true;
  });
  assert.equal(backupCalls, 0);
});

test('a failed durable checkpoint prevents a second billable provider call', async () => {
  let backupCalls = 0;
  const primary = adapter('anthropic', 'claude-test', async () => {
    const error = new Error('unavailable');
    error.status = 503;
    throw error;
  });
  const backup = adapter('openai', 'gpt-test', async () => { backupCalls += 1; return result('no', 'gpt-test'); });
  const gateway = createGateway([primary, backup], { failoverEnabled: true });
  await assert.rejects(gateway.execute(baseRequest, {
    onCheckpoint: async () => { throw new Error('checkpoint store unavailable'); },
  }), /checkpoint store unavailable/);
  assert.equal(backupCalls, 0);
});

test('attempt-store failure after a successful call never bills a backup provider', async () => {
  let primaryCalls = 0;
  let backupCalls = 0;
  const primary = adapter('anthropic', 'claude-test', async () => { primaryCalls += 1; return result('done', 'claude-test'); });
  const backup = adapter('openai', 'gpt-test', async () => { backupCalls += 1; return result('no', 'gpt-test'); });
  const gateway = createGateway([primary, backup], { failoverEnabled: true });
  await assert.rejects(gateway.execute({ ...baseRequest, idempotencyKey: 'run-3:store-failure' }, {
    onAttempt: async (attempt) => {
      if (attempt.status === 'succeeded') throw new Error('attempt store unavailable');
    },
  }), /Provider request failed/);
  assert.equal(primaryCalls, 1);
  assert.equal(backupCalls, 0);
});

test('idempotent concurrent execution produces one provider call', async () => {
  let calls = 0;
  const primary = adapter('anthropic', 'claude-test', async () => {
    calls += 1;
    await Promise.resolve();
    return result('one result', 'claude-test');
  });
  const gateway = createGateway([primary]);
  const [first, second] = await Promise.all([gateway.execute(baseRequest), gateway.execute(baseRequest)]);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
});

test('budget hard stop happens before network access at 100 percent', async () => {
  let calls = 0;
  const thresholds = [];
  const gateway = createGateway([adapter('anthropic', 'claude-test', async () => { calls += 1; return result('no', 'claude-test'); })]);
  await assert.rejects(gateway.execute({
    ...baseRequest,
    idempotencyKey: 'run-2:budget',
    budget: { limitUsd: 1, spentUsd: 1 },
  }, { onBudgetThreshold: async (event) => thresholds.push(event.threshold) }), (error) => {
    assert.equal(error.code, 'BUDGET_EXHAUSTED');
    return true;
  });
  assert.equal(calls, 0);
  assert.deepEqual(thresholds, [0.7, 0.9, 1]);
});

test('merge and deployment are approval-gated now but policy can authorize safe automation later', () => {
  const current = new ActionPolicyEngine();
  assert.equal(current.evaluate({ action: 'merge_main', risk: 'low', testsPassed: true, reversible: true }).decision, POLICY_DECISION.APPROVAL);
  assert.equal(current.evaluate({ action: 'deploy_production', risk: 'low', testsPassed: true, reversible: true }).decision, POLICY_DECISION.APPROVAL);

  const future = new ActionPolicyEngine({
    ruleSource: () => ({ decision: POLICY_DECISION.AUTO, maxRisk: 'low', requiresTests: true, requiresReversible: true }),
  });
  assert.equal(future.evaluate({ action: 'merge_main', risk: 'low', testsPassed: true, reversible: true }).decision, POLICY_DECISION.AUTO);
  assert.equal(future.evaluate({ action: 'merge_main', risk: 'low', testsPassed: false, reversible: true }).decision, POLICY_DECISION.APPROVAL);
});

test('confirmed providers remain explicit and Phase 2C.1 adapters are prepared without activation', () => {
  assert.deepEqual(CONFIRMED_TARGET_PROVIDERS, ['deepseek', 'kimi', 'zhipu', 'minimax', 'qwen']);
  for (const provider of CONFIRMED_TARGET_PROVIDERS) {
    assert.equal(PROVIDER_CATALOG[provider].state, provider === 'deepseek' ? PROVIDER_STATE.CANARY : PROVIDER_STATE.PREPARED);
  }
  assert.equal(PROVIDER_CATALOG.minimax.privateDataEligible, false);
});

test('prepared Chat Completions adapters normalize usage without leaking gateway metadata', async () => {
  const cases = [
    [QwenChatAdapter, 'qwen', 'https://qwen.invalid/compatible-mode/v1/chat/completions'],
    [KimiChatAdapter, 'kimi', 'https://api.moonshot.ai/v1/chat/completions'],
    [ZhipuChatAdapter, 'zhipu', 'https://api.z.ai/api/paas/v4/chat/completions'],
    [MiniMaxChatAdapter, 'minimax', 'https://api.minimax.io/v1/chat/completions'],
  ];
  for (const [Adapter, provider, expectedUrl] of cases) {
    let received;
    const adapter = new Adapter({ apiKey: `${provider}-test-key-123456`, fetchFn: async (url, init) => {
      received = { url, body: JSON.parse(init.body), headers: init.headers };
      return { ok: true, status: 200, headers: new Headers({ 'x-request-id': `${provider}-request` }), json: async () => ({
        model: adapter.model,
        choices: [{ message: { content: `${provider} ok` } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 10 } },
      }) };
    } });
    const output = await adapter.complete({ prompt: 'safe', systemPrompt: 'safe', maxOutputTokens: 100,
      allowedTools: [], context: { taskId: 'must-not-leak' }, clientRequestId: 'client-test' });
    assert.equal(received.url, expectedUrl);
    assert.equal(received.body.messages.length, 2);
    assert.equal(JSON.stringify(received.body).includes('must-not-leak'), false);
    assert.equal(received.headers.authorization, `Bearer ${provider}-test-key-123456`);
    assert.equal(output.text, `${provider} ok`);
    assert.ok(output.usage.costUsd > 0);
  }
});

test('automatic routing considers privacy, health, context, quality and cost without changing ordered default', () => {
  const descriptors = [
    { name: 'anthropic', configured: true, capabilities: ['text'], privateDataEligible: true, contextWindow: 200000, qualityTier: 5, costTier: 4 },
    { name: 'zhipu', configured: true, capabilities: ['text'], privateDataEligible: true, contextWindow: 200000, qualityTier: 4, costTier: 1 },
    { name: 'minimax', configured: true, capabilities: ['text'], privateDataEligible: false, contextWindow: 1000000, qualityTier: 5, costTier: 1 },
  ];
  const ordered = new RoutingPolicy({ defaultProvider: 'anthropic', allowedProviders: ['anthropic', 'zhipu', 'minimax'], failoverEnabled: true });
  assert.equal(ordered.route({ ...baseRequest, routingHints: { requiresPrivateData: true, estimatedContextTokens: 0, healthyProviders: null, preferQuality: false } }, descriptors)[0].name, 'anthropic');
  const automatic = new RoutingPolicy({ defaultProvider: 'anthropic', allowedProviders: ['anthropic', 'zhipu', 'minimax'], failoverEnabled: true, autoSelectEnabled: true });
  const route = automatic.route({ ...baseRequest, routingHints: { requiresPrivateData: true, estimatedContextTokens: 100000, healthyProviders: ['anthropic', 'zhipu', 'minimax'], preferQuality: false } }, descriptors);
  assert.deepEqual(route.map(({ name }) => name), ['zhipu', 'anthropic']);
});

test('OpenAI adapter uses the Responses API without storing server-side state', async () => {
  let received;
  const fetchFn = async (url, init) => {
    received = { url, init, body: JSON.parse(init.body) };
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'x-request-id': 'req-test' }),
      json: async () => ({
        model: 'gpt-test',
        output_text: 'safe response',
        usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 2 } },
      }),
    };
  };
  const adapter = new OpenAIResponsesAdapter({
    apiKey: '  test-openai-key  ',
    model: 'gpt-test',
    fetchFn,
    pricing: { inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 10 },
  });
  const output = await adapter.complete({
    prompt: 'safe', systemPrompt: 'safe', model: 'gpt-test', maxOutputTokens: 100,
    allowedTools: [], context: { runId: 'run-1' }, stage: 'test', clientRequestId: 'client-1',
  });
  assert.equal(received.url, 'https://api.openai.com/v1/responses');
  assert.equal(received.init.headers.authorization, 'Bearer test-openai-key');
  assert.equal(received.init.headers['x-client-request-id'], 'client-1');
  assert.equal(received.body.store, false);
  assert.equal(received.body.metadata.runId, 'run-1');
  assert.equal(output.requestId, 'req-test');
  assert.ok(output.usage.costUsd > 0);
});

test('DeepSeek canary uses the stateless Responses endpoint with conservative cost accounting', async () => {
  let received;
  const adapter = new DeepSeekResponsesAdapter({
    apiKey: '  test-deepseek-key  ',
    fetchFn: async (url, init) => {
      received = { url, init, body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'x-ds-trace-id': 'ds-test' }),
        json: async () => ({
          model: 'deepseek-flash',
          output: [{ content: [{ type: 'output_text', text: 'canary ok' }] }],
          usage: { input_tokens: 1000, output_tokens: 500, input_tokens_details: { cached_tokens: 200 } },
        }),
      };
    },
  });
  const output = await adapter.complete({
    prompt: 'safe', systemPrompt: 'safe', model: 'deepseek-flash', maxOutputTokens: 100,
    allowedTools: [], context: { runId: 'private-run-id' }, stage: 'canary', clientRequestId: 'client-2',
  });
  assert.equal(received.url, 'https://api.deepseek.com/responses');
  assert.equal(received.init.headers.authorization, 'Bearer test-deepseek-key');
  assert.equal(received.body.store, undefined);
  assert.equal(received.body.metadata, undefined);
  assert.equal(output.requestId, 'ds-test');
  assert.equal(output.text, 'canary ok');
  assert.ok(Math.abs(output.usage.costUsd - 0.0008412) < 1e-12);
});

test('Responses adapter accepts DeepSeek message text output blocks', async () => {
  const adapter = new DeepSeekResponsesAdapter({
    apiKey: 'test-deepseek-key',
    fetchFn: async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        model: 'deepseek-flash',
        output: [{ type: 'message', content: [{ type: 'text', text: 'message text' }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    }),
  });
  const output = await adapter.complete({
    prompt: 'safe', systemPrompt: 'safe', model: 'deepseek-flash', maxOutputTokens: 16,
    allowedTools: [], context: {}, stage: 'canary', clientRequestId: 'client-text-block',
  });
  assert.equal(output.text, 'message text');
});

test('an explicit DeepSeek canary route uses its own model and checkpoints before Anthropic fallback', async () => {
  const calls = [];
  const deepseek = adapter('deepseek', 'deepseek-flash', async ({ model }) => {
    calls.push(['deepseek', model]);
    const error = new Error('temporary outage');
    error.status = 503;
    throw error;
  });
  const anthropic = adapter('anthropic', 'claude-test', async ({ model }) => {
    calls.push(['anthropic', model]);
    return result('fallback ok', model);
  });
  const gateway = new ModelGateway({
    adapters: [anthropic, deepseek],
    routingPolicy: new RoutingPolicy({
      defaultProvider: 'anthropic', allowedProviders: ['anthropic', 'deepseek'], failoverEnabled: true,
    }),
    maxAttemptsPerProvider: 1,
    sleepFn: async () => {},
  });
  const checkpoints = [];
  const output = await gateway.execute({ ...baseRequest, provider: 'deepseek', idempotencyKey: 'run-deepseek' }, {
    onCheckpoint: async (checkpoint) => checkpoints.push(checkpoint),
  });
  assert.deepEqual(calls, [['deepseek', 'deepseek-flash'], ['anthropic', 'claude-test']]);
  assert.equal(output.provider, 'anthropic');
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].fromProvider, 'deepseek');
});

function createGateway(adapters, { failoverEnabled = false } = {}) {
  return new ModelGateway({
    adapters,
    routingPolicy: new RoutingPolicy({
      defaultProvider: 'anthropic',
      allowedProviders: adapters.map(({ name }) => name),
      failoverEnabled,
    }),
    maxAttemptsPerProvider: 1,
    sleepFn: async () => {},
  });
}

function adapter(name, model, complete) {
  return { name, model, capabilities: ['text'], complete };
}

function result(text, model) {
  return { text, model, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 }, durationMs: 4, turns: 1 };
}
