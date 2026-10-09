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
  const until = new Date(at).toISOString();
  const explanation = waitExplanation(evaluations, { until, now });
  return {
    kind: 'wait', until,
    info: {
      reason: 'NO_FREE_CAPACITY', message: WAITING_MESSAGE, detail: explanation.text, summary: explanation.summary,
      routes: recoverable.slice(0, 12).map((entry) => ({ id: entry.id, reasons: entry.reasons, until: entry.cooldownUntil || null })),
      expected_at: known ? new Date(known).toISOString() : null,
    },
  };
}

// Why a step waits, in words the owner can act on (2026-10-09 audit: the old
// "Waiting for free model capacity" hid that healthy routes were excluded by
// policy, and whether paid fallback existed). Counts every route evaluated.
const CATEGORY = [
  ['capability', /^(CAPABILITY_|QUALIFICATION_|NOT_QUALIFIED|NOT_YET_QUALIFIED|EVIDENCE_REQUIRED|CONTEXT_|TOOL_CALLING|STRUCTURED_OUTPUT|VISION_|BELOW_QUALITY_FLOOR|REQUEST_ABOVE_)/],
  ['privacy', /^(PRIVACY_NOT_APPROVED|DATA_CLASS_NOT_ALLOWED)$/],
  ['not set up', /^(CREDENTIAL_MISSING|WORKSPACE_NOT_AUTHORIZED|PROVIDER_CREDENTIAL_BLOCKED|NOT_CONFIGURED|PROTOCOL_)/],
  ['never answers', /^(NEVER_SUCCEEDED|LOW_SUCCESS_RATE)$/],
  ['excluded by routing policy', /^(EXCLUDED_BY_ROUTING_POLICY|ROUTE_BUDGET_EXHAUSTED)$/],
];
const categoryOf = (reasons) => CATEGORY.find(([, pattern]) => reasons.some((reason) => pattern.test(reason)))?.[0] || 'other';
const routeName = (id) => String(id || '').replace(/:free$/, '').replace(/^([a-z]+):/, '$1 ');

export function paidFallbackStatus(evaluations = []) {
  const paid = evaluations.filter((entry) => entry.billingClass === 'paid');
  if (!paid.length) return 'no paid route is configured';
  const has = (code) => paid.some((entry) => entry.reasons?.includes(code));
  if (has('PAID_ROUTE_NOT_ALLOWED')) return 'not allowed for this request (free-only)';
  if (has('BUDGET_INSUFFICIENT')) return 'the workspace budget is used up';
  if (paid.every((entry) => entry.reasons?.some((reason) => /^(WORKSPACE_NOT_AUTHORIZED|CREDENTIAL_MISSING|PROVIDER_CREDENTIAL_BLOCKED)$/.test(reason)))) return 'no paid route is authorized for this workspace';
  if (paid.some((entry) => entry.reasons?.length && entry.reasons.every((reason) => TEMPORARY.has(reason)))) return 'cooling down too';
  return 'no authorized paid route meets this step';
}

export function waitExplanation(evaluations = [], { until = null, now = Date.now(), timeZone = process.env.OFFICE_TIME_ZONE || 'Asia/Dubai' } = {}) {
  const cooling = evaluations.filter((entry) => entry.reasons?.length && entry.reasons.every((reason) => TEMPORARY.has(reason)));
  const excluded = evaluations.filter((entry) => entry.billingClass !== 'paid' && entry.reasons?.length && !entry.reasons.every((reason) => TEMPORARY.has(reason)));
  const byCategory = {};
  for (const entry of excluded) { const category = categoryOf(entry.reasons); byCategory[category] = (byCategory[category] || 0) + 1; }
  const time = (iso) => { const at = Date.parse(iso || ''); return Number.isFinite(at) ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(at)) : null; };
  const coolingText = cooling.slice(0, 3).map((entry) => `${routeName(entry.id)}${time(entry.cooldownUntil) && Date.parse(entry.cooldownUntil) > now ? ` until ${time(entry.cooldownUntil)}` : ''}`).join(', ');
  const excludedText = Object.entries(byCategory).toSorted((left, right) => right[1] - left[1]).map(([category, count]) => `${count} ${category}`).join(', ');
  const paid = paidFallbackStatus(evaluations);
  const parts = [
    cooling.length ? `${coolingText}${cooling.length > 3 ? ` and ${cooling.length - 3} more` : ''} cooling down` : 'every eligible route is cooling down',
    excluded.length ? `${excluded.length} other free route${excluded.length === 1 ? '' : 's'} excluded (${excludedText})` : 'no other free route is configured for this step',
    `paid fallback: ${paid}`,
    until ? `next automatic retry ${time(until)}` : null,
  ].filter(Boolean);
  return {
    text: `${parts.join('; ')}.`,
    summary: { cooling: cooling.map((entry) => ({ id: entry.id, until: entry.cooldownUntil || null })).slice(0, 12), excluded: byCategory, paid, retryAt: until },
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
