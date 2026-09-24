import { pathToFileURL } from 'node:url';
import { ToolBroker } from './broker.js';
import { SAFE_CANARY_TOOL_DEFINITIONS, createSafeCanaryMcpClient } from './canary-tools.js';

const context = Object.freeze({
  workspaceId: '00000000-0000-4000-8000-000000000001',
  jobId: '00000000-0000-4000-8000-000000000002',
  taskId: '00000000-0000-4000-8000-000000000003',
  runId: '00000000-0000-4000-8000-000000000004',
  agentId: '00000000-0000-4000-8000-000000000005',
});

export async function runSyntheticToolBrokerCanary() {
  const { client, transport } = createSafeCanaryMcpClient({ now: () => new Date('2026-09-24T00:00:00.000Z') });
  const store = new SyntheticCanaryStore();
  const broker = new ToolBroker({
    policyStore: store,
    auditStore: store,
    agentStore: store,
    clients: [client],
    definitions: SAFE_CANARY_TOOL_DEFINITIONS,
  });
  const discovered = await broker.discover(context);
  const result = await broker.execute({
    context,
    broker: 'mcp-office',
    tool: 'office.echo',
    action: 'invoke',
    arguments: { message: 'phase-2e-safe-canary' },
    idempotencyKey: 'phase-2e-safe-canary:v1',
  });
  if (discovered.length !== 2 || result.structuredContent?.message !== 'phase-2e-safe-canary' || transport.calls.length !== 1) {
    throw new Error('Tool Broker synthetic canary failed');
  }
  return Object.freeze({ ok: true, discovered: discovered.length, audited: store.finished.length, externalCalls: transport.calls.length });
}

class SyntheticCanaryStore {
  constructor() {
    this.executions = new Map();
    this.finished = [];
  }
  async assertExecutionContext(received) {
    for (const [key, value] of Object.entries(context)) if (received[key] !== value) throw new Error('lineage mismatch');
  }
  async getPolicy() {
    return {
      workspaceId: context.workspaceId,
      enabled: true,
      version: 1,
      budget: { monthlyLimitUsd: 1, maxRequestUsd: 0.1, spentUsd: 0, reservedUsd: 0 },
      providers: [],
      tools: SAFE_CANARY_TOOL_DEFINITIONS.map((definition) => ({
        broker: definition.broker,
        tool: definition.name,
        action: definition.action,
        scopes: definition.scopes,
        risk: definition.risk,
        decision: 'auto',
        secretRef: definition.secretRef,
        enabled: true,
      })),
    };
  }
  async getAgentPermissions(agentId) {
    if (agentId !== context.agentId) return { allowedTools: [] };
    return { allowedTools: SAFE_CANARY_TOOL_DEFINITIONS.map((definition) => definition.agentPermission) };
  }
  async reserveBudget() { throw new Error('zero-cost canary must not reserve budget'); }
  async settleBudget() { throw new Error('zero-cost canary must not settle budget'); }
  async beginExecution(input) {
    const existing = this.executions.get(input.idempotencyKey);
    if (existing?.status === 'succeeded') return { disposition: 'replay', executionId: existing.id, resultSha256: existing.resultSha256 };
    if (input.decision !== 'auto') return { disposition: 'blocked', executionId: `execution-${this.executions.size + 1}` };
    const execution = { id: `execution-${this.executions.size + 1}`, status: 'running' };
    this.executions.set(input.idempotencyKey, execution);
    return { disposition: 'execute', executionId: execution.id };
  }
  async finishExecution(input) {
    const execution = [...this.executions.values()].find((candidate) => candidate.id === input.executionId);
    Object.assign(execution, input);
    this.finished.push(structuredClone(input));
  }
}

async function main() {
  const result = await runSyntheticToolBrokerCanary();
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
