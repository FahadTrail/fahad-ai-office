// Provider-neutral, turn-level execution for long-running tool-using agents.
//
// The controller owns the loop and the durable state; this gateway executes
// exactly one model turn. It chooses an eligible route by policy and live
// provider health, retries briefly on transient errors, and — when the active
// route cannot continue — asks the controller to checkpoint and render a
// handoff for the next route before any other provider is called.

import { randomUUID } from 'node:crypto';
import { FAILURE_CLASS, GatewayError, classifyProviderError } from '../contracts.js';
import { DEFAULT_BILLING_PRIORITY } from './model-pool.js';
import { isCoolingDown } from './provider-state.js';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class AgentTurnGateway {
  constructor({
    pool,
    stateStore,
    billingPriority = DEFAULT_BILLING_PRIORITY,
    strategy = 'balanced',
    minQualityTier = 4,
    maxAttemptsPerRoute = 2,
    maxInlineRetryMs = 20_000,
    sleepFn = defaultSleep,
    now = () => Date.now(),
  } = {}) {
    if (!Array.isArray(pool)) throw new TypeError('A model pool is required');
    if (typeof stateStore?.snapshot !== 'function') throw new TypeError('A provider state store is required');
    this.pool = pool;
    this.stateStore = stateStore;
    this.billingPriority = [...billingPriority];
    this.strategy = strategy;
    this.minQualityTier = minQualityTier;
    this.maxAttemptsPerRoute = maxAttemptsPerRoute;
    this.maxInlineRetryMs = maxInlineRetryMs;
    this.sleepFn = sleepFn;
    this.now = now;
  }

  // Returns every route with an eligibility verdict. The dashboard and the
  // router share this so the UI shows exactly why a model is (not) used.
  async evaluate({
    requiresPrivateData = true,
    estimatedInputTokens = 0,
    maxOutputTokens = 16_000,
    remainingBudgetUsd = Infinity,
    allowPaid = true,
    authorizedRouteIds = null,
    excludedRouteIds = [],
    policyExcludedRouteIds = [],
    budgetExhaustedRouteIds = [],
    minQualityTier = this.minQualityTier,
  } = {}) {
    const state = await this.stateStore.snapshot();
    const now = this.now();
    return this.pool.map((route) => {
      const reasons = [...route.unavailableReasons];
      const routeState = state.get(route.id) || null;
      if (authorizedRouteIds && !authorizedRouteIds.includes(route.id)) reasons.push('WORKSPACE_NOT_AUTHORIZED');
      if (requiresPrivateData && !route.privacyApproved) reasons.push('PRIVACY_NOT_APPROVED');
      if (route.qualityTier < minQualityTier) reasons.push('BELOW_QUALITY_FLOOR');
      if (estimatedInputTokens + maxOutputTokens > route.contextWindow) reasons.push('CONTEXT_TOO_LARGE');
      if (isCoolingDown(routeState, now)) reasons.push(`COOLDOWN_${String(routeState.health || 'unavailable').toUpperCase()}`);
      if (excludedRouteIds.includes(route.id)) reasons.push('FAILED_THIS_TURN');
      if (policyExcludedRouteIds.includes(route.id)) reasons.push('EXCLUDED_BY_ROUTING_POLICY');
      if (budgetExhaustedRouteIds.includes(route.id)) reasons.push('ROUTE_BUDGET_EXHAUSTED');
      const estimateUsd = estimateTurnCost(route, estimatedInputTokens, maxOutputTokens);
      if (route.billingClass === 'paid' && !allowPaid) reasons.push('PAID_ROUTE_NOT_ALLOWED');
      if (route.billingClass === 'paid' && estimateUsd > remainingBudgetUsd) reasons.push('BUDGET_INSUFFICIENT');
      return Object.freeze({ route, state: routeState, eligible: reasons.length === 0, reasons, estimateUsd });
    });
  }

  // Billing class first (free → included → promo → paid by default), then the
  // strategy: economy = cheapest first, balanced/quality = best first. A
  // preferred route (the task's current model) keeps ownership while eligible.
  order(evaluations, { preferredRouteId = null, billingPriority = this.billingPriority, strategy = this.strategy } = {}) {
    const rank = (route) => {
      const index = billingPriority.indexOf(route.billingClass);
      return index < 0 ? billingPriority.length : index;
    };
    const within = strategy === 'economy'
      ? (left, right) => left.costTier - right.costTier || right.qualityTier - left.qualityTier
      : strategy === 'quality'
        ? (left, right) => right.qualityTier - left.qualityTier || right.contextWindow - left.contextWindow || left.costTier - right.costTier
        : (left, right) => right.qualityTier - left.qualityTier || left.costTier - right.costTier;
    return evaluations.filter((entry) => entry.eligible)
      .map((entry) => entry.route)
      .toSorted((left, right) => {
        if (left.id === preferredRouteId) return -1;
        if (right.id === preferredRouteId) return 1;
        return rank(left) - rank(right) || within(left, right);
      });
  }

  // Executes one turn. `prepare(route, handoff)` must return the system prompt
  // and messages for that route; `hooks.onSwitch` must durably checkpoint
  // before it resolves, because the next provider is only called afterwards.
  async turn({
    tools,
    prepare,
    routing = {},
    preferredRouteId = null,
    maxOutputTokens = 16_000,
    hooks = {},
  }) {
    const onAttempt = hooks.onAttempt || (async () => {});
    const onSwitch = hooks.onSwitch || (async () => {});
    const authorize = hooks.authorize || (async () => {});
    const reserve = hooks.reserve || (async () => null);
    const settle = hooks.settle || (async () => {});
    const failed = [];
    const attempts = [];
    let previousRoute = null;
    let lastError = null;

    for (let hop = 0; hop < this.pool.length; hop += 1) {
      const evaluations = await this.evaluate({ ...routing, maxOutputTokens, excludedRouteIds: failed });
      const [route] = this.order(evaluations, {
        preferredRouteId,
        billingPriority: routing.billingPriority || this.billingPriority,
        strategy: routing.strategy || this.strategy,
      });
      if (!route) {
        throw new GatewayError(lastError ? 'All eligible model routes are unavailable' : 'No model route satisfies the task policy', {
          code: lastError ? 'ALL_PROVIDERS_UNAVAILABLE' : 'NO_ELIGIBLE_PROVIDER',
          failureClass: FAILURE_CLASS.APPROVAL,
          attempts,
          evaluations: evaluations.map(({ route: candidate, reasons }) => ({ id: candidate.id, reasons })),
          cause: lastError || undefined,
        });
      }
      try {
        await authorize(route);
      } catch (error) {
        failed.push(route.id);
        attempts.push({ id: randomUUID(), route, attempt: 0, status: 'blocked', error: { code: error.code || 'WORKSPACE_ROUTE_DENIED' } });
        continue;
      }
      const switching = Boolean(previousRoute) || (preferredRouteId != null && route.id !== preferredRouteId);
      if (switching) {
        await onSwitch({
          from: previousRoute ? previousRoute.id : preferredRouteId,
          to: route.id,
          reason: lastError ? { code: lastError.code, failureClass: lastError.failureClass, status: lastError.status || null } : { code: 'ROUTE_UNAVAILABLE' },
        });
      }
      const input = await prepare(route, { switching, from: previousRoute?.id || preferredRouteId });

      for (let attempt = 1; attempt <= this.maxAttemptsPerRoute; attempt += 1) {
        const attemptId = randomUUID();
        const startedAt = this.now();
        const estimateUsd = estimateTurnCost(route, routing.estimatedInputTokens || 0, maxOutputTokens);
        const reservation = await reserve({ route, estimateUsd, attemptId });
        await onAttempt({ id: attemptId, route, attempt, status: 'started', startedAt: new Date(startedAt).toISOString() });
        try {
          const result = await route.protocolClient.turn({
            provider: route.provider,
            model: route.model,
            system: input.system,
            messages: input.messages,
            tools,
            maxOutputTokens,
            clientRequestId: attemptId,
          });
          await settle(reservation, result.usage.costUsd || 0);
          await this.stateStore.recordSuccess(route, result);
          const record = { id: attemptId, route, attempt, status: 'succeeded', usage: result.usage, requestId: result.requestId, durationMs: result.durationMs };
          attempts.push(record);
          await onAttempt(record);
          return { ...result, route, attempts, switched: switching };
        } catch (caught) {
          const error = classifyProviderError(caught);
          if (!error.rateLimit && caught?.rateLimit) error.rateLimit = caught.rateLimit;
          await settle(reservation, Number(error.usage?.costUsd || 0));
          await this.stateStore.recordFailure(route, error);
          const record = { id: attemptId, route, attempt, status: 'failed', usage: error.usage || null,
            error: { code: error.code, failureClass: error.failureClass, status: error.status || null } };
          attempts.push(record);
          await onAttempt(record);
          lastError = error;
          const retryAfterMs = Number.isFinite(Number(error.retryAfter)) ? Number(error.retryAfter) * 1000 : 1000 * attempt;
          const retryHere = error.failureClass === FAILURE_CLASS.RETRY && attempt < this.maxAttemptsPerRoute &&
            retryAfterMs <= this.maxInlineRetryMs;
          if (retryHere) {
            await this.sleepFn(retryAfterMs);
            continue;
          }
          break;
        }
      }
      failed.push(route.id);
      previousRoute = route;
    }
    throw new GatewayError('All eligible model routes are unavailable', {
      code: 'ALL_PROVIDERS_UNAVAILABLE', failureClass: FAILURE_CLASS.APPROVAL, attempts, cause: lastError || undefined,
    });
  }
}

export function estimateTurnCost(route, inputTokens, outputTokens) {
  if (!route.pricing || route.billingClass !== 'paid') return 0;
  return Number(((inputTokens * route.pricing.inputPerMillion + outputTokens * route.pricing.outputPerMillion) / 1_000_000).toFixed(8));
}

export function estimateTokens(system, messages, tools) {
  // ~4 characters per token is a conservative planning estimate; it is used
  // only for routing and budget reservation, never reported as usage.
  const chars = String(system || '').length + JSON.stringify(messages || []).length + JSON.stringify(tools || []).length;
  return Math.ceil(chars / 3.5);
}
