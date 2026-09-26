// Free-tier allowance knowledge and reset schedules.
//
// Honesty rules (AGENTS.md): a number is only shown as exact when the
// provider reports it (rate-limit headers on the response). Published free
// allowances below are labelled "published", they can change without notice
// and are never turned into a percentage. Our own audited usage is counted
// separately; the key may also be used elsewhere, so "remaining" derived from
// it is always an estimate.
//
// Reset schedules drive automatic re-eligibility: when a provider says its
// daily free allowance is used up, the route cools down until the next reset
// and then becomes eligible again without anyone intervening.

// kind: 'daily' (fixed wall-clock reset in `timeZone`), 'rolling' (provider
// counts a sliding 24 h window; retry-after decides), 'monthly', 'one-time'
// (a trial quota that does not renew) or 'none'.
export const FREE_ALLOWANCES = Object.freeze({
  gemini: {
    reset: { kind: 'daily', timeZone: 'America/Los_Angeles' },
    requestsPerDay: null,
    note: 'Per project and model; Google shows current limits only in AI Studio (Usage & limits). Reported in 2026: Flash ≈20 requests/day, Flash-Lite ≈500/day. Daily limits reset at midnight Pacific.',
    source: 'https://ai.google.dev/gemini-api/docs/rate-limits',
  },
  groq: {
    reset: { kind: 'rolling' },
    requestsPerDay: 1_000,
    tokensPerDay: 200_000,
    requestsPerDayEnv: 'GROQ_FREE_DAILY_REQUESTS',
    note: 'Free plan, per model and organization: 30 requests/min, 1,000 requests/day, 8,000 tokens/min, 200,000 tokens/day (gpt-oss-120b, gpt-oss-20b, qwen3.8-27b). Groq reports the live window in x-ratelimit headers.',
    source: 'https://console.groq.com/docs/rate-limits',
  },
  openrouter: {
    reset: { kind: 'daily', timeZone: 'UTC' },
    requestsPerDay: 50,
    requestsPerDayEnv: 'OPENROUTER_FREE_DAILY_REQUESTS',
    note: ':free models: 20 requests/minute; 50 requests/day for the whole key, or 1,000/day once the account has bought at least $10 of credits.',
    source: 'https://openrouter.ai/docs/api-reference/limits',
  },
  cerebras: {
    reset: { kind: 'one-time' },
    requestsPerDay: null,
    tokensPerDay: 1_000_000,
    note: 'Free Trial only (no permanent free tier since 2026-08-17): $5 of credits, granted after adding a verified payment method, expiring after 30 days; token-bucket limits (gpt-oss-120b: 5 requests/min, 1M tokens/day). Access stops when the credits end.',
    source: 'https://inference-docs.cerebras.ai/support/rate-limits',
  },
  zhipu: {
    reset: { kind: 'none' },
    requestsPerDay: null,
    note: 'GLM-4.7-Flash and GLM-4.5-Flash are priced at $0; free use is limited to 1 concurrent request; no daily cap is published.',
    source: 'https://docs.z.ai/guides/overview/pricing',
  },
  mistral: {
    reset: { kind: 'monthly' },
    requestsPerDay: null,
    note: 'A free Experiment API allowance could not be confirmed on official pages (2026-09). If the owner states a free plan, limits are shown only in the Admin Console → Limits; free-plan prompts may be used for training.',
    source: 'https://docs.mistral.ai/getting-started/models/models_overview/',
  },
  qwen: {
    reset: { kind: 'one-time' },
    requestsPerDay: null,
    note: 'Singapore (International) region only: 1M free tokens per model for 90 days after activating Model Studio; does not renew. Afterwards pay-as-you-go.',
    source: 'https://www.alibabacloud.com/help/en/model-studio/new-free-quota',
  },
});

export function freeAllowance(route, env = {}) {
  if (!route || !['free', 'included', 'promo'].includes(route.billingClass)) return null;
  const allowance = FREE_ALLOWANCES[route.provider];
  if (!allowance) return null;
  const configured = allowance.requestsPerDayEnv ? Number(env[allowance.requestsPerDayEnv]) : NaN;
  return Object.freeze({
    ...allowance,
    requestsPerDay: Number.isFinite(configured) && configured > 0 ? configured : allowance.requestsPerDay,
    exact: false,
    basis: 'published',
  });
}

// The next wall-clock reset for a daily schedule, as an ISO string, or null
// when the provider's window is rolling / not daily.
export function nextResetAt(reset, now = Date.now()) {
  if (!reset) return null;
  if (reset.kind === 'daily') return nextMidnight(reset.timeZone || 'UTC', now);
  if (reset.kind === 'monthly') {
    const date = new Date(now);
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString();
  }
  return null;
}

function zoneOffsetMs(timeZone, instant) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant)).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

function nextMidnight(timeZone, now) {
  const offset = zoneOffsetMs(timeZone, now);
  const local = new Date(now + offset);
  const localMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1);
  // Re-evaluate the offset at the target (DST changes between now and then).
  const guess = localMidnight - offset;
  const corrected = localMidnight - zoneOffsetMs(timeZone, guess);
  return new Date(corrected).toISOString();
}

// Daily-allowance exhaustion is recognised from the provider's own error
// wording (Gemini "PerDay" quota ids, Groq "requests per day (RPD)",
// OpenRouter "free-models-per-day", GitHub "UserByModelByDay", …). Only a
// boolean leaves this function; provider text is never stored.
const DAILY_PATTERN = /per.?day|perday|daily|\bRPD\b|\bTPD\b|by.?day|per 86400s/i;
export function isDailyQuotaText(text) {
  return DAILY_PATTERN.test(String(text || ''));
}

// When the provider's daily free allowance is used up, the route becomes
// eligible again at the next reset (or after the provider's retry-after).
export function quotaCooldownUntil(route, error, now = Date.now()) {
  const retryAfterMs = Number.isFinite(Number(error?.retryAfter)) ? Number(error.retryAfter) * 1000 : null;
  const reset = FREE_ALLOWANCES[route?.provider]?.reset || null;
  const scheduled = nextResetAt(reset, now);
  if (scheduled) return scheduled;
  if (retryAfterMs != null && retryAfterMs > 0) return new Date(now + retryAfterMs).toISOString();
  // Rolling window without a hint: probe again in an hour.
  return new Date(now + 60 * 60_000).toISOString();
}

// Dashboard view of one route's free capacity. `usedToday` comes from the
// model_attempts audit; `rateLimit` from the provider's response headers.
export function freeQuotaStatus(route, { env = {}, usedToday = null, rateLimit = null, now = Date.now() } = {}) {
  const allowance = freeAllowance(route, env);
  if (!allowance) return null;
  const requests = usedToday?.requests ?? null;
  const reported = rateLimit?.requestsLimit != null && rateLimit?.requestsRemaining != null;
  let remaining = null;
  let basis = 'EXACT QUOTA NOT AVAILABLE';
  if (reported) {
    remaining = rateLimit.requestsRemaining;
    basis = 'PROVIDER-REPORTED';
  } else if (allowance.requestsPerDay && requests != null) {
    remaining = Math.max(0, allowance.requestsPerDay - requests);
    basis = 'ESTIMATED — published limit minus our audited use';
  }
  let estimatedExhaustionAt = null;
  const perDay = reported ? rateLimit.requestsLimit : allowance.requestsPerDay;
  if (perDay && requests > 0 && remaining != null) {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    const elapsedMs = Math.max(60_000, now - start.getTime());
    const perMs = requests / elapsedMs;
    const eta = now + remaining / perMs;
    const reset = nextResetAt(allowance.reset, now);
    if (!reset || eta < Date.parse(reset)) estimatedExhaustionAt = new Date(eta).toISOString();
  }
  return {
    published: {
      requestsPerDay: allowance.requestsPerDay,
      tokensPerDay: allowance.tokensPerDay ?? null,
      note: allowance.note,
      source: allowance.source,
    },
    resetKind: allowance.reset.kind,
    nextResetAt: nextResetAt(allowance.reset, now),
    requestsRemaining: remaining,
    basis,
    percentRemaining: reported && rateLimit.requestsLimit ? Math.round((rateLimit.requestsRemaining / rateLimit.requestsLimit) * 100) : null,
    estimatedExhaustionAt,
  };
}
