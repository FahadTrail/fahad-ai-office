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
import { capabilityGaps, jobFit } from './capabilities.js';
import { assertFreeRouteHonest, FREE_ROUTE_INCIDENTS } from './free-guard.js';
import { qualificationGaps, evidenceScore } from './qualification.js';

export { assertFreeRouteHonest, sameModelFamily, FREE_ROUTE_INCIDENTS } from './free-guard.js';

const CODING_JOBS = new Set(['coding', 'qa_security']);
const KEY_WIDE_BLOCKERS = /_(CREDENTIAL_INVALID|ACCOUNT_NOT_ACTIVATED|ACCOUNT_OVERDUE|PERMISSION_MISSING|REGION_NOT_SUPPORTED)$/;
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
    job = null,
    qualifications = null,
  } = {}) {
    const state = await this.stateStore.snapshot();
    const now = this.now();
    // A rejected credential or blocked account affects every model behind
    // the same key: one failure rests them all instead of each being tried.
    const blockedSecrets = new Set(this.pool.filter((route) => {
      const routeState = state.get(route.id);
      return routeState?.health === 'auth_error' && isCoolingDown(routeState, now) && KEY_WIDE_BLOCKERS.test(String(routeState.lastErrorCode || ''));
    }).map((route) => route.secretRef).filter(Boolean));
    return this.pool.map((route) => {
      const reasons = [...route.unavailableReasons];
      const routeState = state.get(route.id) || null;
      if (authorizedRouteIds && !authorizedRouteIds.includes(route.id)) reasons.push('WORKSPACE_NOT_AUTHORIZED');
      if (requiresPrivateData && !route.privacyApproved) reasons.push('PRIVACY_NOT_APPROVED');
      // The quality floor guards autonomous coding. Other jobs are governed by
      // their own capability minimums (capabilities.js JOB_PROFILES).
      if ((!job || CODING_JOBS.has(typeof job === 'string' ? job : '')) && route.qualityTier < minQualityTier) reasons.push('BELOW_QUALITY_FLOOR');
      // Capability before price: a free model that cannot do the job is not
      // offered the job.
      reasons.push(...capabilityGaps(route.capabilities, job));
      // Evidence before claims: a free model's own qualification results can
      // rule it out of a job, and critical jobs need a passed qualification.
      reasons.push(...qualificationGaps(route, job, qualifications, now));
      const outputTokens = routeOutputTokens(route, maxOutputTokens, estimatedInputTokens);
      if (estimatedInputTokens + outputTokens > route.contextWindow) reasons.push('CONTEXT_TOO_LARGE');
      if (route.requestTokenLimit && outputTokens < Math.min(maxOutputTokens, MIN_USEFUL_OUTPUT_TOKENS)) reasons.push('REQUEST_ABOVE_FREE_TIER_LIMIT');
      if (isCoolingDown(routeState, now)) reasons.push(`COOLDOWN_${String(routeState.health || 'unavailable').toUpperCase()}`);
      else if (route.secretRef && blockedSecrets.has(route.secretRef)) reasons.push('PROVIDER_CREDENTIAL_BLOCKED');
      if (excludedRouteIds.includes(route.id)) reasons.push('FAILED_THIS_TURN');
      if (policyExcludedRouteIds.includes(route.id)) reasons.push('EXCLUDED_BY_ROUTING_POLICY');
      if (budgetExhaustedRouteIds.includes(route.id)) reasons.push('ROUTE_BUDGET_EXHAUSTED');
      const estimateUsd = estimateTurnCost(route, estimatedInputTokens, outputTokens);
      if (route.billingClass === 'paid' && !allowPaid) reasons.push('PAID_ROUTE_NOT_ALLOWED');
      if (route.billingClass === 'paid' && estimateUsd > remainingBudgetUsd) reasons.push('BUDGET_INSUFFICIENT');
      return Object.freeze({ route, state: routeState, eligible: reasons.length === 0, reasons, estimateUsd });
    });
  }

  // Billing class first (free → included → promo → paid by default), then the
  // strategy: economy = cheapest first, balanced/quality = best first. A
  // preferred route (the task's current model) keeps ownership while eligible.
  // With a job, "quality" means fit for that job (capability registry).
  //
  // Within the non-paid classes cost is zero, so price tiers do not matter:
  // when qualification evidence is available the order is job-specific —
  // capability fit plus evidence (passed skills for this job, observed
  // reliability, recent limits) — so each job has its own free preference.
  order(evaluations, { preferredRouteId = null, billingPriority = this.billingPriority, strategy = this.strategy, job = null, qualifications = null } = {}) {
    const rank = (route) => {
      const index = billingPriority.indexOf(route.billingClass);
      return index < 0 ? billingPriority.length : index;
    };
    const fit = (route) => (job ? jobFit(route, job) : route.qualityTier);
    const within = strategy === 'economy'
      ? (left, right) => left.costTier - right.costTier || fit(right) - fit(left)
      : strategy === 'quality'
        ? (left, right) => fit(right) - fit(left) || right.contextWindow - left.contextWindow || left.costTier - right.costTier
        : (left, right) => fit(right) - fit(left) || left.costTier - right.costTier;
    const now = this.now();
    const evidence = new Map(evaluations.map((entry) => [entry.route.id, qualifications ? evidenceScore(entry, job, qualifications, now) : 0]));
    const freePreference = (left, right) => (fit(right) + evidence.get(right.id)) - (fit(left) + evidence.get(left.id))
      || right.contextWindow - left.contextWindow || left.id.localeCompare(right.id);
    return evaluations.filter((entry) => entry.eligible)
      .map((entry) => entry.route)
      .toSorted((left, right) => {
        if (left.id === preferredRouteId) return -1;
        if (right.id === preferredRouteId) return 1;
        const byClass = rank(left) - rank(right);
        if (byClass) return byClass;
        if (qualifications && left.billingClass !== 'paid' && right.billingClass !== 'paid') return freePreference(left, right);
        return within(left, right);
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
    // Charges a cost that had no reservation (a free route that was billed
    // anyway) to the workspace budget ledger.
    const charge = hooks.charge || (async () => {});
    const onIncident = hooks.onIncident || (async () => {});
    // Test hook at the routing boundary (controlled failover drills). An error
    // it throws with `injected: true` is handled exactly like a provider
    // failure but is never recorded as real provider health.
    const beforeCall = hooks.beforeCall || (async () => {});
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
        job: routing.job || null,
        qualifications: routing.qualifications || null,
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
          reason: lastError
            ? { code: lastError.code, failureClass: lastError.failureClass, status: lastError.status || null, ...(lastError.injected ? { injected: true } : {}) }
            : { code: 'ROUTE_UNAVAILABLE' },
        });
      }
      const input = await prepare(route, { switching, from: previousRoute?.id || preferredRouteId });

      for (let attempt = 1; attempt <= this.maxAttemptsPerRoute; attempt += 1) {
        const attemptId = randomUUID();
        const startedAt = this.now();
        const outputTokens = routeOutputTokens(route, maxOutputTokens, routing.estimatedInputTokens || 0);
        const estimateUsd = estimateTurnCost(route, routing.estimatedInputTokens || 0, outputTokens);
        const reservation = await reserve({ route, estimateUsd, attemptId });
        await onAttempt({ id: attemptId, route, attempt, status: 'started', startedAt: new Date(startedAt).toISOString() });
        let hookFailure = null;
        try {
          try {
            await beforeCall({ route, attempt, attemptId });
          } catch (hookError) {
            if (!hookError?.injected) hookFailure = hookError;
            throw hookError;
          }
          const result = await route.protocolClient.turn({
            provider: route.provider,
            model: route.model,
            system: input.system,
            messages: input.messages,
            tools,
            maxOutputTokens: outputTokens,
            clientRequestId: attemptId,
            ...(routing.effort ? { effort: routing.effort } : {}),
          });
          // Free-route guarantee: a free route never silently becomes paid
          // or silently serves another model.
          assertFreeRouteHonest(route, result);
          await settle(reservation, result.usage.costUsd || 0);
          await this.stateStore.recordSuccess(route, result);
          const record = { id: attemptId, route, attempt, status: 'succeeded', usage: result.usage, requestId: result.requestId, durationMs: result.durationMs };
          attempts.push(record);
          await onAttempt(record);
          return { ...result, route, attempts, switched: switching };
        } catch (caught) {
          if (hookFailure) {
            // A controller-side hook failed: never blame the provider for it.
            await settle(reservation, 0);
            throw hookFailure;
          }
          const error = classifyProviderError(caught);
          if (!error.rateLimit && caught?.rateLimit) error.rateLimit = caught.rateLimit;
          if (caught?.quotaScope) error.quotaScope = caught.quotaScope;
          if (caught?.reason) error.reason = caught.reason;
          if (caught?.injected) {
            error.code = caught.code || 'DRILL_INJECTED_FAILURE';
            error.injected = true;
          }
          const incurredUsd = Number(error.usage?.costUsd || 0);
          await settle(reservation, incurredUsd);
          if (!reservation && incurredUsd > 0) await charge({ route, amountUsd: incurredUsd, attemptId });
          if (FREE_ROUTE_INCIDENTS.has(error.type)) {
            await onIncident({ route, kind: error.type, costUsd: incurredUsd, reportedModel: caught?.reportedModel || null, attemptId });
          }
          if (!error.injected) await this.stateStore.recordFailure(route, error);
          const record = { id: attemptId, route, attempt, status: 'failed', usage: error.usage || null,
            error: { code: error.code, failureClass: error.failureClass, status: error.status || null, ...(error.reason ? { reason: error.reason } : {}), ...(error.injected ? { injected: true } : {}) } };
          attempts.push(record);
          await onAttempt(record);
          lastError = error;
          const retryAfterMs = Number.isFinite(Number(error.retryAfter)) ? Number(error.retryAfter) * 1000 : 1000 * attempt;
          // A used-up daily allowance will not recover in seconds: rotate now.
          // A request that already ran into its timeout is not retried on the same route.
          const timedOut = /timeout/i.test(String(caught?.networkCode || ''));
          const retryHere = error.failureClass === FAILURE_CLASS.RETRY && error.quotaScope !== 'day' && !timedOut && attempt < this.maxAttemptsPerRoute &&
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

// A route may declare the largest output its model accepts; requests are
// clamped to it so a provider limit never turns into a failed turn.
export function routeOutputTokens(route, requested, estimatedInputTokens = 0) {
  const cap = Number(route.maxOutputTokens);
  let tokens = Number.isFinite(cap) && cap > 0 ? Math.min(requested, cap) : requested;
  // Free tiers that count input + max output per request/minute (Groq free
  // TPM, …): shrink the output reservation to what fits.
  const limit = Number(route.requestTokenLimit);
  if (Number.isFinite(limit) && limit > 0) tokens = Math.min(tokens, Math.max(0, limit - estimatedInputTokens));
  return tokens;
}

// Smallest useful answer on a request-limited free route.
const MIN_USEFUL_OUTPUT_TOKENS = 1024;

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
