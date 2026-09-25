// In-memory policy and audit stores with the same contracts as the Supabase
// implementations. They let the complete Agent -> Tool Broker -> policy ->
// tool -> audit path run in automated tests and local development without a
// database. They are never used by the production worker.

import { randomUUID } from 'node:crypto';
import { CODING_TOOL_DEFINITIONS } from '../coding-agent/tools.js';

export const DEFAULT_CODING_GRANTS = Object.freeze(CODING_TOOL_DEFINITIONS.map((definition) => Object.freeze({
  broker: definition.broker,
  tool: definition.name,
  action: definition.action,
  scopes: definition.scopes,
  risk: definition.risk,
  secretRef: definition.secretRef,
  enabled: true,
  decision: ['github.pr_merge', 'supabase.query_write', 'supabase.migration_apply'].includes(definition.name) ? 'approval' : 'auto',
})));

export class LocalPolicyStore {
  constructor({ workspaceId, grants = DEFAULT_CODING_GRANTS, providers = [], monthlyLimitUsd = 50, maxRequestUsd = 5 } = {}) {
    this.policy = {
      workspaceId, enabled: true, version: 1,
      budget: { monthlyLimitUsd, maxRequestUsd, spentUsd: 0, reservedUsd: 0 },
      providers, tools: grants.map((grant) => ({ ...grant })),
    };
    this.reservations = new Map();
  }

  setDecision(tool, decision) {
    this.policy.tools.find((grant) => grant.tool === tool).decision = decision;
  }

  async getPolicy(workspaceId) {
    if (workspaceId !== this.policy.workspaceId) throw Object.assign(new Error('CROSS_WORKSPACE_ACCESS_DENIED'), { code: 'CROSS_WORKSPACE_ACCESS_DENIED' });
    return structuredClone(this.policy);
  }

  async assertExecutionContext({ workspaceId }) {
    if (workspaceId !== this.policy.workspaceId) throw Object.assign(new Error('CROSS_WORKSPACE_ACCESS_DENIED'), { code: 'CROSS_WORKSPACE_ACCESS_DENIED' });
  }

  async reserveBudget({ idempotencyKey, amountUsd }) {
    const existing = this.reservations.get(idempotencyKey);
    if (existing) return existing;
    const budget = this.policy.budget;
    if (budget.spentUsd + budget.reservedUsd + amountUsd > budget.monthlyLimitUsd) {
      throw Object.assign(new Error('Workspace budget exhausted'), { code: 'WORKSPACE_BUDGET_EXHAUSTED' });
    }
    budget.reservedUsd += amountUsd;
    const reservation = { reservationId: randomUUID(), reservedUsd: amountUsd };
    this.reservations.set(idempotencyKey, reservation);
    return reservation;
  }

  async settleBudget({ idempotencyKey, actualUsd }) {
    const reservation = this.reservations.get(idempotencyKey);
    if (!reservation || reservation.settled) return;
    reservation.settled = true;
    this.policy.budget.reservedUsd = Math.max(0, this.policy.budget.reservedUsd - reservation.reservedUsd);
    this.policy.budget.spentUsd += Number(actualUsd || 0);
  }
}

export class LocalToolAuditStore {
  constructor({ allowedTools = CODING_TOOL_DEFINITIONS.map((definition) => definition.name) } = {}) {
    this.allowedTools = allowedTools;
    this.executions = new Map();
  }

  async getAgentPermissions(agentId) {
    return { id: agentId, slug: 'coding-agent', allowedTools: this.allowedTools };
  }

  async beginExecution(input) {
    const key = `${input.context.workspaceId}:${input.idempotencyKey}`;
    const existing = this.executions.get(key);
    if (existing) {
      if (existing.status === 'succeeded') return { executionId: existing.id, status: existing.status, disposition: 'replay', attemptCount: 1, retryCount: 0, resultSha256: existing.resultSha256 };
      return { executionId: existing.id, status: existing.status, disposition: existing.status === 'running' ? 'in_progress' : 'blocked', attemptCount: 1, retryCount: 0 };
    }
    const status = input.decision === 'auto' ? 'running' : input.decision === 'approval' ? 'approval_required' : 'denied';
    const row = { id: randomUUID(), key, tool: input.tool, decision: input.decision, status, errorCode: input.errorCode || null, startedAt: Date.now() };
    this.executions.set(key, row);
    return { executionId: row.id, status, disposition: status === 'running' ? 'execute' : 'blocked', attemptCount: 1, retryCount: 0 };
  }

  async finishExecution(input) {
    const row = [...this.executions.values()].find((entry) => entry.id === input.executionId);
    Object.assign(row, { status: input.status, errorCode: input.errorCode || null, resultSha256: input.resultSha256 || null, durationMs: input.durationMs });
    return { status: row.status, endedAt: new Date().toISOString() };
  }

  rows() {
    return [...this.executions.values()];
  }
}
