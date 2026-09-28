// Waiting for free model capacity instead of failing.
//
// When the gateway finds no model it may use for a step, this decides whether
// that is temporary (every candidate is only cooling down — a daily quota, a
// rate limit, a short outage — so the step waits and resumes by itself) or
// permanent (every candidate is ruled out by policy, capability, privacy, a
// missing credential or a blocked account — so the step fails with the real
// blocker). Nothing here ever widens access: a paid route that the policy
// excludes stays excluded while the step waits.

// Reasons that clear by themselves with time.
const TEMPORARY = new Set(['COOLDOWN_RATE_LIMITED', 'COOLDOWN_QUOTA_EXHAUSTED', 'COOLDOWN_UNAVAILABLE', 'COOLDOWN_DEGRADED', 'FAILED_THIS_TURN',
  'COOLDOWN_POOL_RATE_LIMITED', 'COOLDOWN_POOL_QUOTA_EXHAUSTED']);
const NO_ROUTE_CODES = new Set(['NO_ELIGIBLE_PROVIDER', 'ALL_PROVIDERS_UNAVAILABLE']);

export const CAPACITY_LIMITS = Object.freeze({ maxWaits: 48, minWaitMs: 60_000, maxBackoffMs: 60 * 60_000, maxWaitMs: 24 * 3600_000 });
export const WAITING_MESSAGE = 'Waiting for free model capacity — will resume automatically.';

export function capacityDecision(error, { now = Date.now(), waitCount = 0 } = {}) {
  const evaluations = error?.officeRouting?.evaluations || error?.evaluations || null;
  if (!NO_ROUTE_CODES.has(error?.code) || !Array.isArray(evaluations) || !evaluations.length) return null;
  const recoverable = evaluations.filter((entry) => entry.reasons?.length && entry.reasons.every((reason) => TEMPORARY.has(reason)));
  const summary = blockerSummary(evaluations);
  if (!recoverable.length) return { kind: 'blocked', summary, routes: summary.routes };
  const backoff = Math.min(CAPACITY_LIMITS.maxBackoffMs, CAPACITY_LIMITS.minWaitMs * 2 ** Math.max(0, waitCount));
  const times = recoverable.map((entry) => Date.parse(entry.cooldownUntil || '')).filter((time) => Number.isFinite(time) && time > now);
  // Retry at the earliest known recovery; a route that just failed (no known
  // time) is retried after an exponential backoff.
  const known = times.length ? Math.min(...times) : null;
  const unknown = recoverable.some((entry) => !Number.isFinite(Date.parse(entry.cooldownUntil || '')) || Date.parse(entry.cooldownUntil) <= now);
  const at = Math.min(now + CAPACITY_LIMITS.maxWaitMs, Math.max(now + CAPACITY_LIMITS.minWaitMs, unknown ? Math.min(known ?? Infinity, now + backoff) : known));
  return {
    kind: 'wait', until: new Date(at).toISOString(),
    info: {
      reason: 'NO_FREE_CAPACITY', message: WAITING_MESSAGE,
      routes: recoverable.slice(0, 12).map((entry) => ({ id: entry.id, reasons: entry.reasons, until: entry.cooldownUntil || null })),
      expected_at: known ? new Date(known).toISOString() : null,
    },
  };
}

// "Why nothing can run", per reason, for a clear failure message.
export function blockerSummary(evaluations = []) {
  const counts = new Map();
  for (const entry of evaluations) for (const reason of entry.reasons || []) counts.set(reason, (counts.get(reason) || 0) + 1);
  const top = [...counts.entries()].toSorted((left, right) => right[1] - left[1]).slice(0, 5);
  return {
    text: top.map(([reason, count]) => `${reason} (${count})`).join(', ') || 'no model route',
    routes: evaluations.slice(0, 12).map((entry) => ({ id: entry.id, reasons: entry.reasons })),
  };
}
