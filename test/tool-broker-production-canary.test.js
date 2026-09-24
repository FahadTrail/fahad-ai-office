import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolBroker } from '../src/tool-broker/broker.js';
import { SAFE_CANARY_TOOL_DEFINITIONS, createSafeCanaryMcpClient } from '../src/tool-broker/canary-tools.js';
import { runProductionToolBrokerCanary } from '../src/tool-broker/production-canary.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const chiefId = '00000000-0000-4000-8000-000000000002';
const researchId = '00000000-0000-4000-8000-000000000003';

test('production canary proves real lineage, idempotency, rejections and zero budget delta', async () => {
  const store = new CanaryStore();
  const { client, transport } = createSafeCanaryMcpClient({ now: () => new Date('2026-09-24T00:00:00.000Z') });
  const broker = new ToolBroker({
    policyStore: store,
    auditStore: store,
    agentStore: store,
    clients: [client],
    definitions: SAFE_CANARY_TOOL_DEFINITIONS,
  });
  const result = await runProductionToolBrokerCanary({
    db: new FakeDb(), broker, policyStore: store, transport,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.discovered, ['office.current_time', 'office.echo']);
  assert.equal(result.externalCalls, 2);
  assert.equal(result.replayVerified, true);
  assert.equal(result.agentDenied, true);
  assert.equal(result.missingGrantDenied, true);
  assert.equal(result.crossWorkspaceDenied, true);
  assert.equal(result.budgetDeltaUsd, 0);
  assert.equal(transport.calls.length, 2);
  assert.deepEqual(store.executions.map(({ decision }) => decision), ['auto', 'auto', 'deny', 'deny']);
});

class FakeDb {
  from(table) {
    const data = {
      projects: [{ id: workspaceId, name: 'Fahad AI Office' }],
      agents: [
        { id: chiefId, slug: 'chief-of-staff', is_active: true },
        { id: researchId, slug: 'research-strategy', is_active: true },
      ],
      runs: [
        { id: '00000000-0000-4000-8000-000000000010', job_id: '00000000-0000-4000-8000-000000000020', task_id: '00000000-0000-4000-8000-000000000030', agent_id: chiefId, status: 'succeeded' },
        { id: '00000000-0000-4000-8000-000000000011', job_id: '00000000-0000-4000-8000-000000000021', task_id: '00000000-0000-4000-8000-000000000031', agent_id: researchId, status: 'succeeded' },
      ],
      jobs: [
        { id: '00000000-0000-4000-8000-000000000020', project_id: workspaceId },
        { id: '00000000-0000-4000-8000-000000000021', project_id: workspaceId },
      ],
    }[table];
    if (!data) throw new Error(`unexpected table ${table}`);
    return new FakeQuery(data);
  }
}

class FakeQuery {
  constructor(data) { this.data = structuredClone(data); this.single = false; }
  select() { return this; }
  eq() { return this; }
  in() { return this; }
  order() { return this; }
  limit() { return this; }
  maybeSingle() { this.single = true; return this; }
  then(resolve, reject) {
    const data = this.single ? this.data[0] || null : this.data;
    return Promise.resolve({ data, error: null }).then(resolve, reject);
  }
}

class CanaryStore {
  constructor() { this.executions = []; this.byKey = new Map(); }
  async assertExecutionContext(context) {
    const valid = context.workspaceId === workspaceId && [chiefId, researchId].includes(context.agentId);
    if (!valid) {
      const error = new Error('denied');
      error.code = 'CROSS_WORKSPACE_ACCESS_DENIED';
      throw error;
    }
  }
  async getPolicy() {
    return {
      workspaceId, enabled: true, version: 1,
      budget: { monthlyLimitUsd: 2, maxRequestUsd: 0.1, spentUsd: 0.17, reservedUsd: 0 },
      providers: [],
      tools: SAFE_CANARY_TOOL_DEFINITIONS.map((definition) => ({
        broker: definition.broker, tool: definition.name, action: definition.action,
        scopes: definition.scopes, risk: definition.risk, decision: 'auto', secretRef: null, enabled: true,
      })),
    };
  }
  async getAgentPermissions(agentId) {
    return { allowedTools: agentId === chiefId ? ['office.echo', 'office.current_time'] : [] };
  }
  async reserveBudget() { throw new Error('zero-cost canary cannot reserve budget'); }
  async settleBudget() { throw new Error('zero-cost canary cannot settle budget'); }
  async beginExecution(input) {
    const existing = this.byKey.get(input.idempotencyKey);
    if (existing?.status === 'succeeded') return { disposition: 'replay', executionId: existing.id, resultSha256: existing.resultSha256 };
    const row = { ...structuredClone(input), id: `execution-${this.executions.length + 1}`, status: input.decision === 'auto' ? 'running' : 'denied', attemptCount: input.decision === 'auto' ? 1 : 0 };
    this.executions.push(row);
    this.byKey.set(input.idempotencyKey, row);
    return { disposition: input.decision === 'auto' ? 'execute' : 'blocked', executionId: row.id, attemptCount: row.attemptCount };
  }
  async finishExecution(input) {
    const row = this.executions.find(({ id }) => id === input.executionId);
    Object.assign(row, structuredClone(input), { resultSha256: input.resultSha256 || null });
    return { status: input.status };
  }
}
