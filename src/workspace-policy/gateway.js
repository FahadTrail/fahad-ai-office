import { normalizeGatewayRequest } from '../model-gateway/contracts.js';
import { providerDescriptor } from '../model-gateway/provider-catalog.js';
import { WorkspacePolicyError } from './contracts.js';
import { WorkspacePolicyEngine } from './engine.js';

export class WorkspacePolicyGateway {
  constructor({ gateway, policyStore, providerSecretRefs = {}, completedCacheSize = 1000 } = {}) {
    if (!gateway?.execute || !gateway?.routingPolicy || !gateway?.adapters) {
      throw new TypeError('WorkspacePolicyGateway requires a ModelGateway');
    }
    for (const method of ['getPolicy', 'assertExecutionContext', 'reserveBudget', 'settleBudget']) {
      if (typeof policyStore?.[method] !== 'function') throw new TypeError(`policyStore.${method} is required`);
    }
    this.gateway = gateway;
    this.policyStore = policyStore;
    this.engine = new WorkspacePolicyEngine({ providerSecretRefs });
    this.completedCacheSize = completedCacheSize;
    this.executions = new Map();
  }

  execute(input, hooks = {}) {
    const request = normalizeGatewayRequest(input);
    if (this.executions.has(request.idempotencyKey)) return this.executions.get(request.idempotencyKey);
    const execution = this.run(request, hooks).catch((error) => {
      this.executions.delete(request.idempotencyKey);
      throw error;
    });
    this.executions.set(request.idempotencyKey, execution);
    this.evictCompletedEntries();
    return execution;
  }

  async run(request, hooks) {
    const workspaceId = request.context.workspaceId;
    if (!workspaceId) throw blocked('WORKSPACE_CONTEXT_REQUIRED', 'Workspace context is required');
    await this.policyStore.assertExecutionContext({
      workspaceId,
      jobId: request.context.jobId,
      taskId: request.context.taskId,
      runId: request.context.runId,
    });
    const policy = await this.policyStore.getPolicy(workspaceId);
    const route = this.describeRoute(request);
    const authorization = this.engine.authorizeExecution({ policy, request, route });
    const reservation = await this.policyStore.reserveBudget({
      workspaceId,
      idempotencyKey: request.idempotencyKey,
      amountUsd: authorization.reservationUsd,
    });
    if (!reservation?.reservationId || !(Number(reservation.reservedUsd) > 0)) {
      throw blocked('WORKSPACE_BUDGET_RESERVATION_FAILED', 'Workspace budget reservation failed');
    }

    const originalAttempt = typeof hooks.onAttempt === 'function' ? hooks.onAttempt : async () => {};
    const billedAttempts = new Set();
    let actualUsd = 0;
    let result;
    try {
      result = await this.gateway.execute({
        ...request,
        budget: {
          spentUsd: request.budget?.spentUsd || 0,
          limitUsd: (request.budget?.spentUsd || 0) + Number(reservation.reservedUsd),
        },
      }, {
        ...hooks,
        onAttempt: async (attempt) => {
          if (attempt.status === 'succeeded' && !billedAttempts.has(attempt.id)) {
            billedAttempts.add(attempt.id);
            actualUsd += Number(attempt.usage?.costUsd || 0);
          }
          await originalAttempt(attempt);
        },
      });
      actualUsd = Math.max(actualUsd, Number(result.costUsd || 0));
      return result;
    } finally {
      await this.policyStore.settleBudget({
        workspaceId,
        reservationId: reservation.reservationId,
        idempotencyKey: request.idempotencyKey,
        actualUsd,
      });
    }
  }

  describeRoute(request) {
    const descriptors = [...this.gateway.adapters.entries()]
      .map(([name, adapter]) => providerDescriptor(name, adapter));
    return this.gateway.routingPolicy.route(request, descriptors).map((descriptor, index) => ({
      provider: descriptor.name,
      model: index === 0 && descriptor.name === this.gateway.routingPolicy.defaultProvider
        ? request.model
        : descriptor.model,
    }));
  }

  evictCompletedEntries() {
    while (this.executions.size > this.completedCacheSize) {
      this.executions.delete(this.executions.keys().next().value);
    }
  }
}

function blocked(code, message) {
  return new WorkspacePolicyError(message, { code });
}
