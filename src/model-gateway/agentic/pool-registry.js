// Canonical capacity-pool registry (Capacity V2).
//
// A pool is ONE quota that can be exhausted independently (capacity-pools.js
// decides which routes share a pool). This registry holds what is known about
// each pool: its reset cycle, its published limits, its billing and privacy
// class, and where each fact comes from. Honesty rules:
//
//   * A limit is a number only when the provider publishes it (PUBLISHED) or a
//     reliable secondary source reports it (REPORTED, labelled). Otherwise it
//     is null, shown as UNKNOWN — never invented.
//   * Routing never relies on a REPORTED number for correctness: live signals
//     (rate-limit headers, quota errors, cooldowns) decide availability. The
//     numbers here only feed the capacity *estimate*.
//   * Signup credits that do not recur are `one-time` and count as zero
//     recurring capacity.

import { capacityPool } from './capacity-pools.js';

export const POOL_KINDS = Object.freeze(['daily', 'rolling', 'monthly', 'one-time', 'promo', 'rate-only', 'paid']);
export const CONFIDENCE = Object.freeze(['PUBLISHED', 'REPORTED', 'MEASURED', 'UNKNOWN']);

const NO_LIMITS = Object.freeze({
  requestsPerMinute: null, requestsPerHour: null, requestsPerDay: null,
  tokensPerMinute: null, tokensPerDay: null, tokensPerMonth: null, concurrency: null,
});
const limits = (values = {}) => Object.freeze({ ...NO_LIMITS, ...values });

// Facts per provider (and optionally per pool id). `resetTimeZone` applies to
// daily pools. `ownerAction` explains what unlocks a pool that needs one.
const FACTS = {
  gemini: {
    kind: 'daily', resetTimeZone: 'America/Los_Angeles', billingClass: 'free', privacyClass: 'PUBLIC', confidence: 'REPORTED',
    source: 'https://ai.google.dev/gemini-api/docs/rate-limits', checked: '2026-09-27',
    // Per-model free quotas; Google shows exact numbers only in AI Studio.
    perPool: {
      'gemini:gemini-flash-latest': { limits: limits({ requestsPerDay: 20 }), note: 'Flash ≈20 requests/day (REPORTED; exact limit only in AI Studio).' },
      'gemini:gemini-flash-lite-latest': { limits: limits({ requestsPerDay: 500 }), note: 'Flash-Lite ≈500 requests/day (REPORTED).' },
    },
    note: 'Free tier per project and model; resets at midnight Pacific. Free-tier prompts may be used to improve Google products.',
  },
  groq: {
    kind: 'rolling', billingClass: 'free', privacyClass: 'PUBLIC', confidence: 'PUBLISHED',
    limits: limits({ requestsPerMinute: 30, requestsPerDay: 1_000, tokensPerMinute: 8_000, tokensPerDay: 200_000 }),
    source: 'https://console.groq.com/docs/rate-limits', checked: '2026-09-26',
    note: 'Per model and organization on the free plan; Groq reports the live window in x-ratelimit headers.',
  },
  openrouter: {
    kind: 'daily', resetTimeZone: 'UTC', billingClass: 'free', privacyClass: 'PUBLIC', confidence: 'PUBLISHED',
    limits: limits({ requestsPerMinute: 20, requestsPerDay: 50 }),
    source: 'https://openrouter.ai/docs/api-reference/limits', checked: '2026-09-27',
    note: 'All :free models share one key-wide daily allowance (1,000/day after a one-time $10 credit purchase — an owner option).',
  },
  zhipu: {
    kind: 'rate-only', billingClass: 'free', privacyClass: 'PUBLIC', confidence: 'PUBLISHED',
    limits: limits({ concurrency: 1 }),
    source: 'https://docs.z.ai/guides/overview/pricing', checked: '2026-09-27',
    note: 'GLM Flash models are priced at $0; one concurrent request; no daily cap is published.',
  },
  cerebras: {
    kind: 'one-time', billingClass: 'promo', privacyClass: 'PUBLIC', confidence: 'PUBLISHED',
    limits: limits({ requestsPerMinute: 5, tokensPerDay: 1_000_000 }),
    source: 'https://inference-docs.cerebras.ai/support/rate-limits', checked: '2026-09-27',
    note: 'Free Trial credit only (expires 30 days after grant); production shows it used up since 2026-09-26.',
  },
  mistral: {
    kind: 'monthly', billingClass: 'free', privacyClass: 'PUBLIC', confidence: 'REPORTED',
    limits: limits({ tokensPerMonth: 1_000_000_000 }),
    source: 'https://github.com/diegosouzapw/OmniRoute/blob/main/docs/reference/FREE_TIERS.md', checked: '2026-09-29',
    note: 'Free mode (default on): the exact monthly limit is shown only in the Mistral console (Admin → Limits). ≈1B tokens/month is REPORTED by OmniRoute\'s catalog. Free-mode prompts may be used for training.',
    ownerAction: 'MISTRAL_API_KEY',
  },
  llm7: {
    kind: 'rolling', billingClass: 'free', privacyClass: 'PUBLIC', confidence: 'PUBLISHED',
    limits: limits({ requestsPerMinute: 60, requestsPerHour: 250, tokensPerDay: 1_000_000 }),
    source: 'https://github.com/chigwell/llm7.io/blob/main/TERMS.md', checked: '2026-09-29',
    note: 'Free token: 1M tokens (input + output) per rolling 24 h, 60 requests/min, 250 requests/hour. Best-effort service ("not for production … where guaranteed access is required"): always behind fallback.',
    ownerAction: 'LLM7_API_KEY',
  },
  opencode: {
    kind: 'promo', billingClass: 'free', privacyClass: 'PUBLIC', confidence: 'UNKNOWN',
    source: 'https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/zen.mdx', checked: '2026-09-29',
    note: 'OpenCode Zen limited-time free models; no numeric limit is published (rate-limited). A model is removed when its promotion ends.',
    ownerAction: 'OPENCODE_ZEN_API_KEY',
  },
  ollama: {
    kind: 'monthly', billingClass: 'free', privacyClass: 'NORMAL', confidence: 'UNKNOWN',
    limits: limits({ concurrency: 1 }),
    source: 'https://ollama.com/pricing', checked: '2026-09-29',
    note: 'Free plan: a small monthly usage allowance on starter cloud models (not published), 1 concurrent request, resets monthly from signup. Prompts and responses are not logged or trained on.',
    ownerAction: 'OLLAMA_API_KEY',
  },
  cloudflare: {
    kind: 'daily', resetTimeZone: 'UTC', billingClass: 'free', privacyClass: 'NORMAL', confidence: 'PUBLISHED',
    limits: limits(),
    neuronsPerDay: 10_000,
    source: 'https://developers.cloudflare.com/workers-ai/platform/pricing/', checked: '2026-09-29',
    note: '10,000 neurons/day shared by every Workers AI model, reset 00:00 UTC; tokens per neuron depend on the model (not a token number). On the Workers Free plan a used-up allowance returns error 4006 (no billing). Cloudflare does not train on or retain inference data.',
    ownerAction: 'CLOUDFLARE_API_TOKEN',
  },
  qwen: {
    kind: 'one-time', billingClass: 'paid', privacyClass: 'PUBLIC', confidence: 'PUBLISHED',
    source: 'https://www.alibabacloud.com/help/en/model-studio/new-free-quota', checked: '2026-09-27',
    note: 'One-time 1M free tokens per model for 90 days (Singapore region), then pay-as-you-go. Account not activated.',
  },
};

const PAID = Object.freeze({ kind: 'paid', billingClass: 'paid', confidence: 'PUBLISHED', limits: NO_LIMITS, note: 'Paid account: capacity is bounded by budget, not by a free quota.' });

// The registry entry for a pool (or for the pool of a route).
export function poolFacts(poolOrRoute) {
  const pool = poolOrRoute?.capacityPool || (poolOrRoute?.provider && poolOrRoute?.model && !poolOrRoute.account ? capacityPool(poolOrRoute) : poolOrRoute);
  const account = pool?.account || String(pool?.id || '').split(':')[0];
  const route = poolOrRoute?.provider ? poolOrRoute : null;
  if (route?.billingClass === 'paid') return Object.freeze({ id: pool.id, account, ...PAID, privacyClass: null });
  const base = FACTS[account];
  if (!base) {
    return Object.freeze({ id: pool?.id || null, account, kind: route?.billingClass === 'paid' ? 'paid' : 'rate-only', billingClass: route?.billingClass || 'free',
      privacyClass: 'PUBLIC', confidence: 'UNKNOWN', limits: NO_LIMITS, source: null, checked: null, note: 'No published free-tier facts recorded.' });
  }
  const specific = base.perPool?.[pool?.id] || {};
  return Object.freeze({
    id: pool?.id || null, account, kind: base.kind, resetTimeZone: base.resetTimeZone || null,
    billingClass: base.billingClass, privacyClass: base.privacyClass, confidence: base.confidence,
    limits: specific.limits || base.limits || NO_LIMITS, neuronsPerDay: base.neuronsPerDay ?? null,
    source: base.source, checked: base.checked, note: specific.note || base.note, ownerAction: base.ownerAction || null,
  });
}

// Recurring free tokens a pool may provide per day / per month, from
// PUBLISHED or REPORTED limits only. null = UNKNOWN (never guessed here).
// A requests-only limit is not converted into tokens here; the capacity model
// does that with measured request sizes and labels it ESTIMATED.
export function publishedTokenAllowance(facts) {
  if (!facts || ['paid', 'one-time'].includes(facts.kind)) return { perDay: facts?.kind === 'one-time' ? 0 : null, perMonth: facts?.kind === 'one-time' ? 0 : null, basis: facts?.kind || 'unknown' };
  const { tokensPerDay, tokensPerMonth } = facts.limits || {};
  if (tokensPerDay) return { perDay: tokensPerDay, perMonth: tokensPerDay * 30, basis: facts.confidence };
  if (tokensPerMonth) return { perDay: Math.round(tokensPerMonth / 30), perMonth: tokensPerMonth, basis: facts.confidence };
  return { perDay: null, perMonth: null, basis: 'UNKNOWN' };
}

// ------------------------------------------------------------------ privacy
// Data classes, least to most sensitive. A route may receive data up to its
// class and nothing above it:
//   PUBLIC        free endpoints that may log or train on prompts
//   NORMAL        providers that do not train on or retain inference data
//                 (business data that is not source code or personal data)
//   PRIVATE       private repositories and internal documents — only after the
//                 owner's review flag for that provider
//   CONFIDENTIAL  secrets-adjacent / regulated data — reviewed paid providers
export const DATA_CLASSES = Object.freeze(['PUBLIC', 'NORMAL', 'PRIVATE', 'CONFIDENTIAL']);
const rankOf = (value) => { const index = DATA_CLASSES.indexOf(String(value || '').toUpperCase()); return index < 0 ? 0 : index; };

// Providers whose API terms were reviewed for confidential data (existing
// production providers). Everything else tops out at PRIVATE with a flag.
const CONFIDENTIAL_PROVIDERS = new Set(['anthropic', 'openai']);

// The highest data class a route may receive. `privacyApproved` (the owner's
// reviewed flag) is still the only way to PRIVATE; a route's declared
// `privacyClass` can only lower that or lift PUBLIC to NORMAL.
export function routeDataClass(route) {
  if (!route) return 'PUBLIC';
  if (route.privacyApproved) return route.billingClass === 'paid' && CONFIDENTIAL_PROVIDERS.has(route.provider) ? 'CONFIDENTIAL' : 'PRIVATE';
  const declared = String(route.dataClass || '').toUpperCase();
  return declared === 'NORMAL' ? 'NORMAL' : 'PUBLIC';
}

export function allowsDataClass(route, dataClass) {
  return rankOf(routeDataClass(route)) >= rankOf(dataClass);
}

// The data class a task needs from the legacy boolean: private-data tasks
// need PRIVATE, everything else is PUBLIC-safe.
export function requiredDataClass({ dataClass = null, requiresPrivateData = true } = {}) {
  if (dataClass) return DATA_CLASSES[rankOf(dataClass)];
  return requiresPrivateData ? 'PRIVATE' : 'PUBLIC';
}
