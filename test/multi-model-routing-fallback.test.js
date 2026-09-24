import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelGateway } from '../src/model-gateway/gateway.js';
import { RoutingPolicy } from '../src/model-gateway/policy.js';
import { WorkspacePolicyGateway } from '../src/workspace-policy/gateway.js';

const context = Object.freeze({
  workspaceId: 'workspace-routing',
  jobId: 'job-routing',
  taskId: 'task-routing',
  runId: 'run-routing',
  agentId: 'chief-routing',
});

test('capacity failure checkpoints, falls back, resumes once, accounts cost, and quarantines the unhealthy primary', async () => {
  let clock = 100_000;
  let primaryCalls = 0;
  let backupCalls = 0;
  const callOrder = [];
  const primary = adapter('anthropic', 'claude-sonnet-5', async () => {
    primaryCalls += 1;
    callOrder.push('anthropic');
    if (primaryCalls === 1) {
      const error = new Error('primary capacity exhausted');
      error.status = 402;
      error.type = 'quota_exhausted';
      error.usage = { inputTokens: 40, outputTokens: 0, cachedInputTokens: 10, costUsd: 0.001 };
      throw error;
    }
    return result('primary recovered', 'claude-sonnet-5', 0.006);
  });
  const backup = adapter('deepseek', 'deepseek-flash', async ({ idempotencyKey }) => {
    backupCalls += 1;
    callOrder.push('deepseek');
    assert.match(idempotencyKey, /^routing:/);
    return result('resumed on backup', 'deepseek-flash', 0.0042);
  });
  const gateway = new ModelGateway({
    adapters: [primary, backup],
    routingPolicy: new RoutingPolicy({
      defaultProvider: 'anthropic',
      allowedProviders: ['anthropic', 'deepseek'],
      failoverEnabled: true,
      autoSelectEnabled: true,
    }),
    maxAttemptsPerProvider: 2,
    providerFailureThreshold: 1,
    providerCooldownMs: 60_000,
    sleepFn: async () => {},
    now: () => clock,
  });
  const store = new MemoryPolicyStore(policy());
  const scoped = new WorkspacePolicyGateway({
    gateway,
    policyStore: store,
    providerSecretRefs: {
      anthropic: 'env://ANTHROPIC_API_KEY',
      deepseek: 'env://DEEPSEEK_API_KEY',
    },
  });
  const attempts = [];
  const checkpoints = [];
  const switches = [];
  const request = routingRequest('routing:first');
  const hooks = {
    onAttempt: async (attempt) => attempts.push(structuredClone(attempt)),
    onCheckpoint: async (checkpoint) => {
      callOrder.push('checkpoint');
      checkpoints.push(structuredClone(checkpoint));
    },
    onProviderSwitch: async (checkpoint) => switches.push(structuredClone(checkpoint)),
  };

  const first = await scoped.execute(request, hooks);
  const replay = await scoped.execute(request, hooks);

  assert.deepEqual(callOrder, ['anthropic', 'checkpoint', 'deepseek']);
  assert.equal(primaryCalls, 1);
  assert.equal(backupCalls, 1);
  assert.deepEqual(replay, first);
  assert.equal(first.provider, 'deepseek');
  assert.equal(first.model, 'deepseek-flash');
  assert.equal(first.providerSwitches, 1);
  assert.equal(first.costUsd, 0.0042);
  assert.equal(first.spentUsd, 0.0052);
  assert.equal(first.tokensIn, 120);
  assert.equal(first.tokensOut, 30);
  assert.equal(checkpoints.length, 1);
  assert.equal(switches.length, 1);
  assert.equal(checkpoints[0].context.taskId, context.taskId);
  assert.deepEqual(checkpoints[0].resume, { sameTask: true, nextAttemptNo: 2 });
  assert.equal(checkpoints[0].lastError.code, 'PROVIDER_CAPACITY');
  assert.equal(store.reservations.length, 1);
  assert.equal(store.settlements.length, 1);
  assert.equal(store.settlements[0].actualUsd, 0.0052);
  assert.deepEqual(attempts.filter(({ status }) => status !== 'started').map(({ provider, status }) => ({ provider, status })), [
    { provider: 'anthropic', status: 'failed' },
    { provider: 'deepseek', status: 'succeeded' },
  ]);
  assert.equal(attempts.find(({ provider, status }) => provider === 'anthropic' && status === 'failed').usage.costUsd, 0.001);
  assert.ok(attempts.every((attempt) => !('prompt' in attempt) && !('systemPrompt' in attempt)));
  assert.equal(first.route[0].selectionReason, 'automatic-capability-cost-health-policy');
  assert.equal(first.route[0].health, 'healthy');

  await scoped.execute(routingRequest('routing:during-cooldown'));
  assert.deepEqual(callOrder, ['anthropic', 'checkpoint', 'deepseek', 'deepseek']);
  assert.equal(primaryCalls, 1);
  assert.equal(backupCalls, 2);

  clock += 60_001;
  const recovered = await scoped.execute(routingRequest('routing:after-cooldown'));
  assert.equal(recovered.provider, 'anthropic');
  assert.deepEqual(callOrder, ['anthropic', 'checkpoint', 'deepseek', 'deepseek', 'anthropic']);
  assert.equal(store.reservations.length, 3);
  assert.equal(store.settlements.length, 3);
});

function routingRequest(idempotencyKey) {
  return {
    prompt: 'Continue the authorized task from its durable workflow context.',
    systemPrompt: 'Return a concise safe result.',
    model: 'claude-sonnet-5',
    maxTurns: 2,
    allowedTools: [],
    capabilities: ['text'],
    stage: 'chief-plan',
    idempotencyKey,
    context,
    budget: { limitUsd: 0.05, spentUsd: 0 },
    routingHints: { requiresPrivateData: true, preferQuality: true },
  };
}

function policy() {
  return {
    workspaceId: context.workspaceId,
    enabled: true,
    version: 1,
    budget: { monthlyLimitUsd: 2, maxRequestUsd: 0.1, spentUsd: 0, reservedUsd: 0 },
    providers: [
      { provider: 'anthropic', models: ['claude-sonnet-5'], secretRef: 'env://ANTHROPIC_API_KEY', enabled: true },
      { provider: 'deepseek', models: ['deepseek-flash'], secretRef: 'env://DEEPSEEK_API_KEY', enabled: true },
    ],
    tools: [],
  };
}

function adapter(name, model, complete) {
  return { name, model, capabilities: ['text'], complete };
}

function result(text, model, costUsd) {
  return {
    text,
    model,
    usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, costUsd },
    durationMs: 12,
    turns: 1,
  };
}

class MemoryPolicyStore {
  constructor(value) {
    this.value = value;
    this.reservations = [];
    this.settlements = [];
  }

  async getPolicy() { return structuredClone(this.value); }

  async assertExecutionContext(received) {
    for (const key of ['workspaceId', 'jobId', 'taskId', 'runId']) {
      if (received[key] !== context[key]) throw new Error('cross-workspace access denied');
    }
  }

  async reserveBudget(input) {
    this.reservations.push(structuredClone(input));
    return { reservationId: `reservation-${this.reservations.length}`, reservedUsd: input.amountUsd };
  }

  async settleBudget(input) { this.settlements.push(structuredClone(input)); }
}
