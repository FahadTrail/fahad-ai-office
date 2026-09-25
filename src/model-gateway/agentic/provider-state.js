// Durable provider/model health shared by every worker and by the Hub
// dashboard. Only facts are recorded: provider-reported rate-limit headers,
// observed failures and measured usage. Quota is never invented; when a
// provider exposes nothing, the state says so.

import { FAILURE_CLASS } from '../contracts.js';
import { quotaCooldownUntil } from './free-quota.js';

export const HEALTH = Object.freeze({
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  RATE_LIMITED: 'rate_limited',
  QUOTA_EXHAUSTED: 'quota_exhausted',
  UNAVAILABLE: 'unavailable',
  AUTH_ERROR: 'auth_error',
  UNKNOWN: 'unknown',
});

const MINUTE = 60_000;
const ROUTE_LEVEL_REASONS = new Set(['MODEL_NOT_FOUND', 'DATA_POLICY', 'NO_TOOL_SUPPORT', 'PROVIDER_FILTERED', 'PRICE_FILTERED']);

// Stored codes follow provider_status.last_error_code (^[A-Z][A-Z0-9_]{2,80}$).
function errorCode(error) {
  if (error.type === 'paid_on_free_route') return 'PAID_ON_FREE_ROUTE';
  const base = error.code || 'PROVIDER_ERROR';
  return error.reason && /^[A-Z_]{3,40}$/.test(error.reason) ? `${base}_${error.reason}`.slice(0, 80) : base;
}

// Decides the durable consequence of one failed attempt. A used-up daily
// allowance cools the route down until the provider's next reset, after which
// it is eligible again automatically.
export function failureOutcome(error, previous = {}, now = Date.now(), route = null) {
  const consecutive = Number(previous.consecutiveFailures || 0) + 1;
  const retryAfterMs = Number.isFinite(Number(error.retryAfter)) ? Number(error.retryAfter) * 1000 : null;
  const resetAt = parseReset(error.rateLimit?.requestsReset) || parseReset(error.rateLimit?.tokensReset);
  let health = previous.health && previous.health !== HEALTH.UNKNOWN ? previous.health : HEALTH.HEALTHY;
  let cooldownUntil = null;
  if (error.failureClass === FAILURE_CLASS.APPROVAL) {
    health = HEALTH.AUTH_ERROR;
    cooldownUntil = now + 6 * 60 * MINUTE;
  } else if (error.code === 'PROVIDER_RATE_LIMIT' && error.quotaScope === 'day') {
    health = HEALTH.QUOTA_EXHAUSTED;
    cooldownUntil = Date.parse(quotaCooldownUntil(route || { provider: previous.provider }, error, now));
  } else if (error.type === 'paid_on_free_route') {
    // A free-only route reported a cost: quarantine it for a day.
    health = HEALTH.UNAVAILABLE;
    cooldownUntil = now + 24 * 60 * MINUTE;
  } else if (error.code === 'PROVIDER_UNSUITABLE' && ROUTE_LEVEL_REASONS.has(error.reason)) {
    // The model/route itself cannot serve requests (not found, blocked by the
    // account's data policy, no tool support): stop retrying it every turn.
    health = HEALTH.UNAVAILABLE;
    cooldownUntil = now + 6 * 60 * MINUTE;
  } else if (error.code === 'PROVIDER_CAPACITY') {
    health = HEALTH.QUOTA_EXHAUSTED;
    cooldownUntil = resetAt || now + 60 * MINUTE;
  } else if (error.code === 'PROVIDER_RATE_LIMIT') {
    health = HEALTH.RATE_LIMITED;
    cooldownUntil = retryAfterMs != null ? now + clamp(retryAfterMs, 5_000, 6 * 60 * MINUTE)
      : resetAt || now + Math.min(30 * MINUTE, MINUTE * 2 ** Math.max(0, consecutive - 1));
  } else if (error.failureClass === FAILURE_CLASS.RETRY) {
    health = consecutive >= 2 ? HEALTH.UNAVAILABLE : HEALTH.DEGRADED;
    cooldownUntil = consecutive >= 2 ? now + Math.min(30 * MINUTE, MINUTE * 2 ** (consecutive - 2)) : null;
  }
  // PROVIDER_UNSUITABLE / refusals are about one request, not the provider.
  return {
    health,
    consecutiveFailures: consecutive,
    cooldownUntil: cooldownUntil ? new Date(cooldownUntil).toISOString() : null,
    lastErrorCode: errorCode(error),
    lastErrorAt: new Date(now).toISOString(),
    rateLimit: error.rateLimit || previous.rateLimit || null,
  };
}

function parseReset(value) {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function isCoolingDown(state, now = Date.now()) {
  return Boolean(state?.cooldownUntil && Date.parse(state.cooldownUntil) > now);
}

export class MemoryProviderStateStore {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.rows = new Map();
  }

  async snapshot() {
    return new Map(this.rows);
  }

  async recordSuccess(route, { usage = {}, rateLimit = null } = {}) {
    const previous = this.rows.get(route.id) || {};
    this.rows.set(route.id, {
      ...previous,
      provider: route.provider,
      model: route.model,
      billingClass: route.billingClass,
      health: HEALTH.HEALTHY,
      consecutiveFailures: 0,
      cooldownUntil: null,
      lastSuccessAt: new Date(this.now()).toISOString(),
      rateLimit: rateLimit || previous.rateLimit || null,
      requests: (previous.requests || 0) + 1,
      inputTokens: (previous.inputTokens || 0) + (usage.inputTokens || 0),
      outputTokens: (previous.outputTokens || 0) + (usage.outputTokens || 0),
      costUsd: Number(((previous.costUsd || 0) + (usage.costUsd || 0)).toFixed(8)),
    });
  }

  async recordFailure(route, error) {
    const previous = this.rows.get(route.id) || {};
    this.rows.set(route.id, {
      ...previous,
      provider: route.provider,
      model: route.model,
      billingClass: route.billingClass,
      ...failureOutcome(error, previous, this.now(), route),
      failures: (previous.failures || 0) + 1,
      costUsd: Number(((previous.costUsd || 0) + Number(error.usage?.costUsd || 0)).toFixed(8)),
    });
  }
}

export class SupabaseProviderStateStore {
  constructor(db, { now = () => Date.now() } = {}) {
    this.db = db;
    this.now = now;
  }

  async snapshot() {
    const { data, error } = await this.db.from('provider_status').select('*');
    if (error) throw new Error(`Provider status unavailable: ${error.message}`);
    return new Map((data || []).map((row) => [`${row.provider}:${row.model}`, fromRow(row)]));
  }

  async recordSuccess(route, { usage = {}, rateLimit = null } = {}) {
    await this.#record(route, {
      p_success: true,
      p_health: HEALTH.HEALTHY,
      p_cooldown_until: null,
      p_error_code: null,
      p_rate_limit: rateLimit,
      p_input_tokens: Math.round(usage.inputTokens || 0),
      p_output_tokens: Math.round(usage.outputTokens || 0),
      p_cost_usd: Number(usage.costUsd || 0),
    });
  }

  async recordFailure(route, error) {
    const current = (await this.snapshot()).get(route.id) || {};
    const outcome = failureOutcome(error, current, this.now(), route);
    await this.#record(route, {
      p_success: false,
      p_health: outcome.health,
      p_cooldown_until: outcome.cooldownUntil,
      p_error_code: outcome.lastErrorCode,
      p_rate_limit: outcome.rateLimit,
      p_input_tokens: 0,
      p_output_tokens: 0,
      p_cost_usd: Number(error.usage?.costUsd || 0),
    });
  }

  async #record(route, values) {
    const { error } = await this.db.rpc('record_provider_outcome', {
      p_provider: route.provider,
      p_model: route.model,
      p_billing_class: route.billingClass,
      ...values,
    });
    // Health bookkeeping must never block model execution.
    if (error && !this.warned) {
      this.warned = true;
      console.warn('[provider-state] could not record outcome (further warnings suppressed):', error.message);
    }
  }
}

function fromRow(row) {
  return {
    provider: row.provider,
    model: row.model,
    billingClass: row.billing_class,
    health: row.health,
    consecutiveFailures: row.consecutive_failures,
    cooldownUntil: row.cooldown_until,
    lastSuccessAt: row.last_success_at,
    lastErrorAt: row.last_error_at,
    lastErrorCode: row.last_error_code,
    rateLimit: row.rate_limit,
    requests: Number(row.requests_total || 0),
    failures: Number(row.failures_total || 0),
    inputTokens: Number(row.input_tokens_total || 0),
    outputTokens: Number(row.output_tokens_total || 0),
    costUsd: Number(row.cost_usd_total || 0),
  };
}
