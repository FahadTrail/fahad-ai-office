import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelGateway } from '../src/model-gateway/gateway.js';
import { RoutingPolicy } from '../src/model-gateway/policy.js';
import { normalizeSecretReference } from '../src/workspace-policy/contracts.js';
import { WorkspacePolicyEngine } from '../src/workspace-policy/engine.js';
import { WorkspacePolicyGateway } from '../src/workspace-policy/gateway.js';

const context = { workspaceId: 'workspace-1', jobId: 'job-1', taskId: 'task-1', runId: 'run-1' };
const request = {
  prompt: 'safe prompt', systemPrompt: 'safe system', model: 'claude-test', maxTurns: 2,
  allowedTools: ['WebSearch'], capabilities: ['text', 'host_tools'], stage: 'research',
  idempotencyKey: 'run-1:research', context, budget: { limitUsd: 0.08, spentUsd: 0 },
};

test('workspace policy authorizes an exact provider, model, tool, secret reference and budget', async () => {
  let calls = 0;
  const gateway = baseGateway([adapter('anthropic', 'claude-test', async () => {
    calls += 1;
    return result('ok', 'claude-test', 0.01);
  })]);
  const store = new MemoryPolicyStore(policy());
  const scoped = new WorkspacePolicyGateway({
    gateway, policyStore: store, providerSecretRefs: { anthropic: 'env://ANTHROPIC_API_KEY' },
  });
  const output = await scoped.execute(request);
  assert.equal(output.text, 'ok');
  assert.equal(calls, 1);
  assert.equal(store.reservations.length, 1);
  assert.equal(store.reservations[0].amountUsd, 0.08);
  assert.equal(store.settlements[0].actualUsd, 0.01);
});

test('cross-workspace lineage is denied before a provider or budget reservation', async () => {
  let calls = 0;
  const gateway = baseGateway([adapter('anthropic', 'claude-test', async () => { calls += 1; return result('no', 'claude-test'); })]);
  const store = new MemoryPolicyStore(policy(), { workspaceId: 'workspace-2' });
  const scoped = new WorkspacePolicyGateway({ gateway, policyStore: store, providerSecretRefs: { anthropic: 'env://ANTHROPIC_API_KEY' } });
  await assert.rejects(scoped.execute(request), (error) => error.code === 'CROSS_WORKSPACE_ACCESS_DENIED');
  assert.equal(calls, 0);
  assert.equal(store.reservations.length, 0);
});

test('an unauthorized fallback route is rejected before the primary provider runs', async () => {
  let calls = 0;
  const gateway = baseGateway([
    adapter('anthropic', 'claude-test', async () => { calls += 1; return result('primary', 'claude-test'); }),
    adapter('deepseek', 'deepseek-flash', async () => { calls += 1; return result('backup', 'deepseek-flash'); }),
  ], true);
  const store = new MemoryPolicyStore(policy());
  const scoped = new WorkspacePolicyGateway({
    gateway,
    policyStore: store,
    providerSecretRefs: { anthropic: 'env://ANTHROPIC_API_KEY', deepseek: 'env://DEEPSEEK_API_KEY' },
  });
  await assert.rejects(scoped.execute(request), (error) => error.code === 'WORKSPACE_PROVIDER_DENIED');
  assert.equal(calls, 0);
});

test('missing tool grants and mismatched secret references fail closed', async () => {
  const engine = new WorkspacePolicyEngine({ providerSecretRefs: { anthropic: 'env://ANTHROPIC_API_KEY' } });
  assert.throws(() => engine.authorizeExecution({
    policy: policy({ tools: [] }), request: normalizedRequest(), route: [{ provider: 'anthropic', model: 'claude-test' }],
  }), (error) => error.code === 'WORKSPACE_TOOL_DENIED');
  assert.throws(() => engine.authorizeExecution({
    policy: policy({ providers: [{ provider: 'anthropic', models: ['claude-test'], secretRef: 'env://OTHER_KEY', enabled: true }] }),
    request: normalizedRequest(), route: [{ provider: 'anthropic', model: 'claude-test' }],
  }), (error) => error.code === 'WORKSPACE_SECRET_REFERENCE_DENIED');
  assert.throws(() => normalizeSecretReference('sk-secret-value'), /opaque/);
});

test('workspace budget exhaustion blocks before the network', async () => {
  let calls = 0;
  const gateway = baseGateway([adapter('anthropic', 'claude-test', async () => { calls += 1; return result('no', 'claude-test'); })]);
  const store = new MemoryPolicyStore(policy({
    budget: { monthlyLimitUsd: 1, maxRequestUsd: 0.1, spentUsd: 0.95, reservedUsd: 0.05 },
  }));
  const scoped = new WorkspacePolicyGateway({ gateway, policyStore: store, providerSecretRefs: { anthropic: 'env://ANTHROPIC_API_KEY' } });
  await assert.rejects(scoped.execute(request), (error) => error.code === 'WORKSPACE_BUDGET_EXHAUSTED');
  assert.equal(calls, 0);
});

test('concurrent duplicate execution reserves and bills only once', async () => {
  let calls = 0;
  const gateway = baseGateway([adapter('anthropic', 'claude-test', async () => {
    calls += 1;
    await Promise.resolve();
    return result('once', 'claude-test', 0.02);
  })]);
  const store = new MemoryPolicyStore(policy());
  const scoped = new WorkspacePolicyGateway({ gateway, policyStore: store, providerSecretRefs: { anthropic: 'env://ANTHROPIC_API_KEY' } });
  const [first, second] = await Promise.all([scoped.execute(request), scoped.execute(request)]);
  assert.equal(first.text, second.text);
  assert.equal(calls, 1);
  assert.equal(store.reservations.length, 1);
  assert.equal(store.settlements.length, 1);
});

test('actual provider cost settles even when durable attempt persistence fails', async () => {
  const gateway = baseGateway([adapter('anthropic', 'claude-test', async () => result('billed', 'claude-test', 0.03))]);
  const store = new MemoryPolicyStore(policy());
  const scoped = new WorkspacePolicyGateway({ gateway, policyStore: store, providerSecretRefs: { anthropic: 'env://ANTHROPIC_API_KEY' } });
  await assert.rejects(scoped.execute(request, {
    onAttempt: async (attempt) => { if (attempt.status === 'succeeded') throw new Error('attempt store unavailable'); },
  }), (error) => /attempt store unavailable/.test(String(error.cause?.message)));
  assert.equal(store.settlements[0].actualUsd, 0.03);
});

test('future Tool Broker grants require exact action and scopes', () => {
  const engine = new WorkspacePolicyEngine();
  const grantPolicy = policy({
    tools: [{ broker: 'mcp-office', tool: 'read_file', action: 'invoke', scopes: ['workspace:read'], risk: 'low', decision: 'auto', enabled: true }],
  });
  assert.equal(engine.authorizeTool(grantPolicy, {
    broker: 'mcp-office', tool: 'read_file', action: 'invoke', scopes: ['workspace:read'],
  }).decision, 'auto');
  assert.throws(() => engine.authorizeTool(grantPolicy, {
    broker: 'mcp-office', tool: 'read_file', action: 'invoke', scopes: ['workspace:write'],
  }), (error) => error.code === 'WORKSPACE_TOOL_SCOPE_DENIED');
  assert.throws(() => engine.authorizeTool(grantPolicy, {
    broker: 'mcp-office', tool: 'read_file', action: 'invoke', scopes: ['workspace:read'], risk: 'high',
  }), (error) => error.code === 'WORKSPACE_TOOL_RISK_DENIED');
});

function normalizedRequest() {
  return { ...request, context: { ...context }, budget: { ...request.budget } };
}

function policy(overrides = {}) {
  return {
    workspaceId: 'workspace-1', enabled: true, version: 1,
    budget: { monthlyLimitUsd: 1, maxRequestUsd: 0.1, spentUsd: 0, reservedUsd: 0 },
    providers: [{ provider: 'anthropic', models: ['claude-test'], secretRef: 'env://ANTHROPIC_API_KEY', enabled: true }],
    tools: [{ broker: 'model-host', tool: 'WebSearch', action: 'invoke', scopes: [], risk: 'low', decision: 'auto', enabled: true }],
    ...overrides,
  };
}

function baseGateway(adapters, failoverEnabled = false) {
  return new ModelGateway({
    adapters,
    routingPolicy: new RoutingPolicy({
      defaultProvider: 'anthropic', allowedProviders: adapters.map(({ name }) => name), failoverEnabled,
    }),
    maxAttemptsPerProvider: 1,
    sleepFn: async () => {},
  });
}

function adapter(name, model, complete) {
  return { name, model, capabilities: ['text', 'host_tools'], complete };
}

function result(text, model, costUsd = 0.01) {
  return { text, model, usage: { inputTokens: 10, outputTokens: 5, costUsd }, durationMs: 4, turns: 1 };
}

class MemoryPolicyStore {
  constructor(value, expected = context) {
    this.value = value;
    this.expected = expected;
    this.reservations = [];
    this.settlements = [];
  }
  async getPolicy() { return structuredClone(this.value); }
  async assertExecutionContext(received) {
    for (const [key, value] of Object.entries(this.expected)) {
      if (received[key] !== value) {
        const error = new Error('cross-workspace access denied');
        error.code = 'CROSS_WORKSPACE_ACCESS_DENIED';
        throw error;
      }
    }
  }
  async reserveBudget(input) {
    this.reservations.push(structuredClone(input));
    return { reservationId: 'reservation-1', reservedUsd: input.amountUsd };
  }
  async settleBudget(input) { this.settlements.push(structuredClone(input)); }
}
