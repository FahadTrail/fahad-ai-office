import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolBroker } from '../src/tool-broker/broker.js';
import { ToolBrokerError } from '../src/tool-broker/contracts.js';
import { McpClientAdapter, InMemoryMcpTransport } from '../src/tool-broker/mcp-client.js';
import { EnvironmentSecretResolver } from '../src/tool-broker/secret-resolver.js';
import { SAFE_CANARY_TOOL_DEFINITIONS, createSafeCanaryMcpClient } from '../src/tool-broker/canary-tools.js';
import { runSyntheticToolBrokerCanary } from '../src/tool-broker/canary.js';
import { ScopedToolBrokerSession } from '../src/tool-broker/session.js';

const context = Object.freeze({
  workspaceId: 'workspace-1', jobId: 'job-1', taskId: 'task-1', runId: 'run-1', agentId: 'agent-1',
});

test('safe canary proves Agent -> Broker -> Policy -> MCP -> Result and audit', async () => {
  const result = await runSyntheticToolBrokerCanary();
  assert.deepEqual(result, { ok: true, discovered: 2, audited: 1, externalCalls: 1 });
});

test('discovery exposes only controller-catalog tools authorized for both workspace and agent', async () => {
  const { client } = createSafeCanaryMcpClient();
  const store = new MemoryStore({ allowedTools: ['office.echo'] });
  const broker = new ToolBroker({ policyStore: store, auditStore: store, agentStore: store, clients: [client], definitions: SAFE_CANARY_TOOL_DEFINITIONS });
  const tools = await broker.discover(context);
  assert.deepEqual(tools.map(({ name }) => name), ['office.echo']);
  assert.equal(tools[0].decision, 'auto');
});

test('missing agent or workspace grant fails closed before MCP execution', async () => {
  const { client, transport } = createSafeCanaryMcpClient();
  const agentDenied = new MemoryStore({ allowedTools: [] });
  const first = new ToolBroker({ policyStore: agentDenied, auditStore: agentDenied, agentStore: agentDenied, clients: [client], definitions: SAFE_CANARY_TOOL_DEFINITIONS });
  await assert.rejects(first.execute(request()), (error) => error.code === 'TOOL_AGENT_DENIED');
  assert.equal(transport.calls.length, 0);
  assert.equal(agentDenied.executions[0].decision, 'deny');

  const workspaceDenied = new MemoryStore({ grants: [] });
  const second = new ToolBroker({ policyStore: workspaceDenied, auditStore: workspaceDenied, agentStore: workspaceDenied, clients: [client], definitions: SAFE_CANARY_TOOL_DEFINITIONS });
  await assert.rejects(second.execute(request({ idempotencyKey: 'denied-2' })), (error) => error.code === 'WORKSPACE_TOOL_DENIED');
  assert.equal(transport.calls.length, 0);
  assert.equal(workspaceDenied.executions[0].errorCode, 'WORKSPACE_TOOL_DENIED');
});

test('server annotations cannot lower controller risk and high-risk tools require approval', async () => {
  const definition = toolDefinition({ risk: 'high', minimumDecision: 'auto' });
  const { client, transport } = clientFor(definition, () => okResult(), {
    annotations: { readOnlyHint: true, destructiveHint: false },
  });
  const store = new MemoryStore({ definitions: [definition], decision: 'auto' });
  const broker = new ToolBroker({ policyStore: store, auditStore: store, agentStore: store, clients: [client], definitions: [definition] });
  await assert.rejects(broker.execute(request({ tool: definition.name })), (error) => error.code === 'TOOL_APPROVAL_REQUIRED');
  assert.equal(transport.calls.length, 0);
  assert.equal(store.executions[0].decision, 'approval');
});

test('critical tools are denied regardless of a permissive workspace grant', async () => {
  const definition = toolDefinition({ risk: 'critical', minimumDecision: 'auto' });
  const { client, transport } = clientFor(definition, () => okResult());
  const store = new MemoryStore({ definitions: [definition], decision: 'auto' });
  const broker = new ToolBroker({ policyStore: store, auditStore: store, agentStore: store, clients: [client], definitions: [definition] });
  await assert.rejects(broker.execute(request({ tool: definition.name })), (error) => error.code === 'TOOL_EXECUTION_DENIED');
  assert.equal(transport.calls.length, 0);
});

test('idempotency replays a completed audit record without calling MCP twice', async () => {
  const definition = toolDefinition();
  const { client, transport } = clientFor(definition, () => okResult());
  const store = new MemoryStore({ definitions: [definition] });
  const broker = new ToolBroker({ policyStore: store, auditStore: store, agentStore: store, clients: [client], definitions: [definition] });
  const first = await broker.execute(request({ tool: definition.name }));
  const second = await broker.execute(request({ tool: definition.name }));
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.resultSha256, first.resultSha256);
  assert.equal(transport.calls.length, 1);
});

test('retry-safe transient failures retry within bounds and invalid output fails audited', async () => {
  const retryDefinition = toolDefinition({ maxRetries: 1, retrySafe: true });
  let attempts = 0;
  const retryClient = clientFor(retryDefinition, () => {
    attempts += 1;
    if (attempts === 1) throw new ToolBrokerError('temporary', { code: 'TEMPORARY', retryable: true });
    return okResult();
  });
  const retryStore = new MemoryStore({ definitions: [retryDefinition] });
  const broker = new ToolBroker({ policyStore: retryStore, auditStore: retryStore, agentStore: retryStore, clients: [retryClient.client], definitions: [retryDefinition] });
  await broker.execute(request({ tool: retryDefinition.name }));
  assert.equal(attempts, 2);
  assert.equal(retryStore.finished[0].retryCount, 1);

  const invalidDefinition = toolDefinition({ name: 'office.invalid' });
  const invalidClient = clientFor(invalidDefinition, () => ({ content: [], structuredContent: { unexpected: true } }));
  const invalidStore = new MemoryStore({ definitions: [invalidDefinition] });
  const invalidBroker = new ToolBroker({ policyStore: invalidStore, auditStore: invalidStore, agentStore: invalidStore, clients: [invalidClient.client], definitions: [invalidDefinition] });
  await assert.rejects(invalidBroker.execute(request({ tool: invalidDefinition.name, idempotencyKey: 'invalid-output' })), (error) => error.code === 'INVALID_TOOL_BROKER_INPUT');
  assert.equal(invalidStore.finished[0].status, 'failed');
  assert.equal(invalidStore.finished[0].outputBytes, 0);
});

test('an uncooperative MCP transport is still bounded by the broker timeout', async () => {
  const definition = toolDefinition({ name: 'office.slow', timeoutMs: 100 });
  const slowClient = clientFor(definition, () => new Promise(() => {}));
  const store = new MemoryStore({ definitions: [definition] });
  const broker = new ToolBroker({ policyStore: store, auditStore: store, agentStore: store, clients: [slowClient.client], definitions: [definition] });
  const started = Date.now();
  await assert.rejects(broker.execute(request({ tool: definition.name, idempotencyKey: 'slow-call' })), (error) => error.code === 'TOOL_TIMEOUT');
  assert.ok(Date.now() - started < 1_000);
  assert.equal(store.finished[0].status, 'failed');
});

test('secrets stay inside transport while costed calls reserve and settle budget', async () => {
  const secret = 'test-only-controller-secret';
  const definition = toolDefinition({ secretRef: 'env://CANARY_TOOL_KEY', estimatedCostUsd: 0.02 });
  let receivedCredential;
  const { client, transport } = clientFor(definition, (_arguments, options) => {
    receivedCredential = options.credential;
    return { ...okResult(), _meta: { costUsd: 0.0125 } };
  });
  const store = new MemoryStore({ definitions: [definition] });
  const broker = new ToolBroker({
    policyStore: store, auditStore: store, agentStore: store, clients: [client], definitions: [definition],
    secretResolver: new EnvironmentSecretResolver({ env: { CANARY_TOOL_KEY: secret }, allowedReferences: ['env://CANARY_TOOL_KEY'] }),
  });
  const result = await broker.execute(request({ tool: definition.name }));
  assert.equal(receivedCredential, secret);
  assert.equal(transport.calls[0].hasCredential, true);
  assert.equal(store.reservations[0].amountUsd, 0.02);
  assert.equal(store.settlements[0].actualUsd, 0.0125);
  assert.equal(JSON.stringify({ result, audit: store.executions, finished: store.finished }).includes(secret), false);
});

test('a zero-cost catalog entry cannot introduce unreserved runtime cost', async () => {
  const definition = toolDefinition();
  const pricedClient = clientFor(definition, () => ({ ...okResult(), _meta: { costUsd: 0.001 } }));
  const store = new MemoryStore({ definitions: [definition] });
  const broker = new ToolBroker({ policyStore: store, auditStore: store, agentStore: store, clients: [pricedClient.client], definitions: [definition] });
  await assert.rejects(broker.execute(request({ tool: definition.name })), (error) => error.code === 'TOOL_UNBUDGETED_COST');
  assert.equal(store.reservations.length, 0);
  assert.equal(store.finished[0].status, 'failed');
});

test('Chief orchestration receives a lineage-bound broker session with deterministic idempotency', async () => {
  const calls = [];
  const broker = {
    async discover(received) { calls.push({ type: 'discover', received }); return []; },
    async execute(received) { calls.push({ type: 'execute', received }); return { ok: true }; },
  };
  const session = new ScopedToolBrokerSession({ broker, context, idempotencyPrefix: 'run-1:research:tool' });
  await session.discover();
  await session.execute({ broker: 'mcp-office', tool: 'office.echo', action: 'invoke', arguments: { message: 'safe' }, callId: 'step-1' });
  assert.deepEqual(calls[0].received, context);
  assert.deepEqual(calls[1].received.context, context);
  assert.equal(calls[1].received.idempotencyKey, 'run-1:research:tool:step-1');
  await assert.rejects(async () => session.execute({ callId: '../unsafe' }), (error) => error.code === 'TOOL_CALL_ID_REQUIRED');
});

function request(overrides = {}) {
  return {
    context,
    broker: 'mcp-office',
    tool: 'office.echo',
    action: 'invoke',
    arguments: { message: 'hello' },
    idempotencyKey: 'tool-call-1',
    ...overrides,
  };
}

function toolDefinition(overrides = {}) {
  return {
    broker: 'mcp-office', name: 'office.test', action: 'invoke', server: 'test-server',
    description: 'A bounded test tool.', risk: 'low', minimumDecision: 'auto', scopes: ['canary:read'],
    agentPermission: 'office.test', secretRef: null,
    inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
    timeoutMs: 1_000, maxRetries: 0, retrySafe: false, estimatedCostUsd: 0,
    ...overrides,
  };
}

function clientFor(definition, handler, additions = {}) {
  const transport = new InMemoryMcpTransport({
    serverInfo: { name: definition.server, version: '1.0.0' },
    tools: [{ name: definition.name, description: definition.description, inputSchema: definition.inputSchema, outputSchema: definition.outputSchema, ...additions }],
    handlers: { [definition.name]: handler },
  });
  return { client: new McpClientAdapter({ name: definition.server, transport }), transport };
}

function okResult() {
  return { content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true } };
}

class MemoryStore {
  constructor({ definitions = SAFE_CANARY_TOOL_DEFINITIONS, grants, allowedTools, decision = 'auto' } = {}) {
    this.definitions = definitions;
    this.grants = grants ?? definitions.map((definition) => ({
      broker: definition.broker, tool: definition.name, action: definition.action, scopes: definition.scopes,
      risk: definition.risk, decision, secretRef: definition.secretRef, enabled: true,
    }));
    this.allowedTools = allowedTools ?? definitions.map((definition) => definition.agentPermission);
    this.executions = [];
    this.finished = [];
    this.reservations = [];
    this.settlements = [];
    this.byKey = new Map();
  }
  async assertExecutionContext(received) {
    for (const [key, value] of Object.entries(context)) if (received[key] !== value) {
      const error = new Error('lineage denied'); error.code = 'CROSS_WORKSPACE_ACCESS_DENIED'; throw error;
    }
  }
  async getPolicy() {
    return {
      workspaceId: context.workspaceId, enabled: true, version: 1,
      budget: { monthlyLimitUsd: 1, maxRequestUsd: 0.1, spentUsd: 0, reservedUsd: 0 },
      providers: [], tools: structuredClone(this.grants),
    };
  }
  async getAgentPermissions() { return { allowedTools: [...this.allowedTools] }; }
  async reserveBudget(input) {
    this.reservations.push(structuredClone(input));
    return { reservationId: 'reservation-1', reservedUsd: input.amountUsd };
  }
  async settleBudget(input) { this.settlements.push(structuredClone(input)); }
  async beginExecution(input) {
    const existing = this.byKey.get(input.idempotencyKey);
    if (existing?.status === 'succeeded') return { disposition: 'replay', executionId: existing.id, resultSha256: existing.resultSha256, attemptCount: existing.attemptCount };
    if (existing?.status === 'running') return { disposition: 'in_progress', executionId: existing.id, attemptCount: existing.attemptCount };
    const row = { ...structuredClone(input), id: `execution-${this.executions.length + 1}`, status: input.decision === 'auto' ? 'running' : input.decision === 'approval' ? 'approval_required' : 'denied', attemptCount: input.decision === 'auto' ? 1 : 0 };
    this.executions.push(row);
    this.byKey.set(input.idempotencyKey, row);
    return { disposition: input.decision === 'auto' ? 'execute' : 'blocked', executionId: row.id, attemptCount: row.attemptCount };
  }
  async finishExecution(input) {
    const row = this.executions.find((candidate) => candidate.id === input.executionId);
    Object.assign(row, structuredClone(input), { resultSha256: input.resultSha256 || null });
    this.finished.push(structuredClone(input));
    return { status: input.status };
  }
}
