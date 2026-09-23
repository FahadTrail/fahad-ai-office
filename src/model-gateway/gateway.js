import { randomUUID } from 'node:crypto';
import {
  FAILURE_CLASS,
  GatewayError,
  attemptErrorRecord,
  classifyProviderError,
  normalizeGatewayRequest,
  normalizeGatewayResult,
  retryDelayMs,
} from './contracts.js';
import { providerDescriptor } from './provider-catalog.js';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ModelGateway {
  constructor({
    adapters,
    routingPolicy,
    maxAttemptsPerProvider = 2,
    sleepFn = defaultSleep,
    now = () => Date.now(),
    completedCacheSize = 1000,
  } = {}) {
    this.adapters = new Map((adapters || []).map((adapter) => [adapter.name, adapter]));
    this.routingPolicy = routingPolicy;
    this.maxAttemptsPerProvider = maxAttemptsPerProvider;
    this.sleepFn = sleepFn;
    this.now = now;
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
    const onAttempt = typeof hooks.onAttempt === 'function' ? hooks.onAttempt : async () => {};
    const onCheckpoint = typeof hooks.onCheckpoint === 'function' ? hooks.onCheckpoint : async () => {};
    const onProviderSwitch = typeof hooks.onProviderSwitch === 'function' ? hooks.onProviderSwitch : async () => {};
    const onBudgetThreshold = typeof hooks.onBudgetThreshold === 'function' ? hooks.onBudgetThreshold : async () => {};
    const descriptors = [...this.adapters.entries()].map(([name, adapter]) => providerDescriptor(name, adapter));
    const route = this.routingPolicy.route(request, descriptors);
    const attempts = [];
    let spentUsd = request.budget?.spentUsd || 0;
    const emittedThresholds = new Set();

    await this.emitBudgetThresholds(request.budget, spentUsd, emittedThresholds, onBudgetThreshold);
    this.assertBudget(request.budget, spentUsd);

    for (let providerIndex = 0; providerIndex < route.length; providerIndex += 1) {
      const descriptor = route[providerIndex];
      const adapter = this.adapters.get(descriptor.name);
      for (let providerAttempt = 1; providerAttempt <= this.maxAttemptsPerProvider; providerAttempt += 1) {
        this.assertBudget(request.budget, spentUsd);
        const startedAt = this.now();
        const attempt = {
          id: randomUUID(),
          clientRequestId: randomUUID(),
          provider: descriptor.name,
          // Office role models belong to the proven default provider. An
          // explicit canary route or failover always uses that adapter's own
          // model so a Claude model name is never sent to another provider.
          model: providerIndex === 0 && descriptor.name === this.routingPolicy.defaultProvider
            ? request.model
            : descriptor.model,
          providerAttempt,
          routeIndex: providerIndex,
          attemptNo: attempts.length + 1,
          stage: request.stage,
          idempotencyKey: request.idempotencyKey,
          context: request.context,
          route: route.map(({ name, model }) => ({ provider: name, model })),
          startedAt: new Date(startedAt).toISOString(),
        };
        await onAttempt({ ...attempt, status: 'started' });

        try {
          const raw = await adapter.complete({ ...request, model: attempt.model, clientRequestId: attempt.clientRequestId });
          const durationMs = Math.max(0, this.now() - startedAt);
          const result = normalizeGatewayResult(raw, { ...attempt, durationMs });
          spentUsd += result.usage.costUsd;
          const record = {
            ...attempt,
            status: 'succeeded',
            endedAt: new Date(this.now()).toISOString(),
            durationMs,
            providerRequestId: result.requestId,
            usage: result.usage,
          };
          attempts.push(record);
          await onAttempt(record);
          await this.emitBudgetThresholds(request.budget, spentUsd, emittedThresholds, onBudgetThreshold);
          this.assertBudget(request.budget, spentUsd, result.usage);
          return {
            ...result,
            spentUsd,
            attempts,
            route: attempt.route,
            providerSwitches: providerIndex,
          };
        } catch (caught) {
          const error = classifyProviderError(caught);
          const durationMs = Math.max(0, this.now() - startedAt);
          const record = {
            ...attempt,
            status: error.code === 'BUDGET_EXHAUSTED' ? 'blocked' : 'failed',
            endedAt: new Date(this.now()).toISOString(),
            durationMs,
            providerRequestId: error.providerRequestId || null,
            error: attemptErrorRecord(error),
          };
          if (!attempts.some((existing) => existing.id === attempt.id)) {
            attempts.push(record);
            await onAttempt(record);
          }

          if (error.failureClass === FAILURE_CLASS.APPROVAL || error.code === 'BUDGET_EXHAUSTED') {
            throw new GatewayError('NEEDS HUMAN APPROVAL: provider or budget policy blocked execution', {
              cause: error,
              code: error.code === 'BUDGET_EXHAUSTED' ? error.code : 'NEEDS_HUMAN_APPROVAL',
              failureClass: FAILURE_CLASS.APPROVAL,
              provider: descriptor.name,
              attempts,
            });
          }
          if (error.failureClass === FAILURE_CLASS.FATAL) {
            error.attempts = attempts;
            throw error;
          }
          if (providerAttempt < this.maxAttemptsPerProvider) {
            await this.sleepFn(retryDelayMs(error, providerAttempt));
            continue;
          }
        }
      }

      const next = route[providerIndex + 1];
      if (next) {
        const checkpoint = {
          idempotencyKey: request.idempotencyKey,
          stage: request.stage,
          fromProvider: descriptor.name,
          toProvider: next.name,
          context: request.context,
          attemptCount: attempts.length,
          lastError: attempts.at(-1)?.error || null,
          createdAt: new Date(this.now()).toISOString(),
        };
        // This durable hook must succeed before a backup provider can be billed.
        await onCheckpoint(checkpoint);
        await onProviderSwitch(checkpoint);
      }
    }

    throw new GatewayError('All eligible providers are unavailable', {
      code: 'ALL_PROVIDERS_UNAVAILABLE',
      failureClass: FAILURE_CLASS.FAILOVER,
      attempts,
    });
  }

  assertBudget(budget, spentUsd, usage = null) {
    if (!budget || spentUsd < budget.limitUsd || (usage && spentUsd <= budget.limitUsd)) return;
    throw new GatewayError('Model execution budget exhausted', {
      code: 'BUDGET_EXHAUSTED',
      failureClass: FAILURE_CLASS.APPROVAL,
      spentUsd,
      limitUsd: budget.limitUsd,
      usage,
    });
  }

  async emitBudgetThresholds(budget, spentUsd, emitted, callback) {
    if (!budget) return;
    const ratio = spentUsd / budget.limitUsd;
    for (const threshold of [0.7, 0.9, 1]) {
      if (ratio + Number.EPSILON * 8 >= threshold && !emitted.has(threshold)) {
        emitted.add(threshold);
        await callback({ threshold, spentUsd, limitUsd: budget.limitUsd });
      }
    }
  }

  evictCompletedEntries() {
    while (this.executions.size > this.completedCacheSize) {
      this.executions.delete(this.executions.keys().next().value);
    }
  }
}
