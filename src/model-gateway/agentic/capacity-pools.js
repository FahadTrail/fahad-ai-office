// Independent capacity pools.
//
// A "pool" is one quota that a provider actually enforces. Several models can
// sit behind one pool (every OpenRouter `:free` model shares the key's daily
// request allowance), and one account can hold several pools (Gemini and Groq
// enforce their free limits per model). Routing and the owner dashboard count
// pools, not models: twenty free models on one quota are ONE source of
// capacity, and when that quota is used up every model on it is unavailable.
//
// Nothing here states a quota number: pools are structural facts (which
// models share a limit). Live numbers come only from provider_status.

// `shared`: the limit is enforced for the whole pool, so a quota/rate signal
// on one member applies to every member.
// `scarce`: the pool's daily allowance is small (tens of requests), so
// low-value work should use abundant pools first (it is never reserved or
// blocked — only ordered last for low-value jobs).
const RULES = [
  { test: (route) => route.provider === 'openrouter' && (route.freeOnly || /:free$/.test(route.model)), pool: () => 'openrouter:free', label: 'OpenRouter free models (one key-wide daily allowance)', shared: true, scarce: true },
  { test: (route) => route.provider === 'gemini', pool: (route) => `gemini:${route.model}`, label: (route) => `Gemini ${route.model} (per-model quota)`, shared: false, scarce: (route) => /flash(?!-lite)/.test(route.model) && !/lite/.test(route.model) },
  { test: (route) => route.provider === 'groq', pool: (route) => `groq:${route.model}`, label: (route) => `Groq ${route.model} (per-model quota)`, shared: false, scarce: false },
  { test: (route) => route.provider === 'zhipu' && route.billingClass !== 'paid', pool: () => 'zhipu:free', label: 'Z.ai GLM Flash (free, one concurrent request)', shared: true, scarce: false },
  { test: (route) => route.provider === 'cerebras', pool: () => 'cerebras:trial', label: 'Cerebras trial credit', shared: true, scarce: false },
  { test: (route) => route.provider === 'mistral', pool: () => 'mistral:account', label: 'Mistral account', shared: true, scarce: false },
  { test: (route) => route.provider === 'nvidia', pool: () => 'nvidia:account', label: 'NVIDIA build (NIM) account', shared: true, scarce: false },
  { test: (route) => route.provider === 'cloudflare', pool: () => 'cloudflare:neurons', label: 'Cloudflare Workers AI daily neurons', shared: true, scarce: false },
];

const value = (field, route) => (typeof field === 'function' ? field(route) : field);

export function capacityPool(route) {
  const rule = RULES.find((entry) => entry.test(route));
  if (!rule) return Object.freeze({ id: `${route.provider}:${route.model}`, label: `${route.provider} ${route.model}`, account: route.provider, shared: false, scarce: false });
  return Object.freeze({ id: rule.pool(route), label: value(rule.label, route), account: route.provider, shared: Boolean(value(rule.shared, route)), scarce: Boolean(value(rule.scarce, route)) });
}

// Health states that, on a shared pool, make every member unavailable. Only
// an exhausted allowance is key-wide: a per-minute 429 is often one model's
// upstream being busy (OpenRouter `:free` models are served by different
// upstreams), so it rests that model only.
const POOL_WIDE = new Set(['quota_exhausted']);

// { poolId → { health, cooldownUntil, routeId } } for shared pools that are
// cooling down because one member reported the pool's quota or rate limit.
export function poolCooldowns(pool, state, now = Date.now()) {
  const result = new Map();
  for (const route of pool) {
    const info = route.capacityPool || capacityPool(route);
    if (!info.shared) continue;
    const routeState = state.get(route.id);
    if (!routeState?.cooldownUntil || Date.parse(routeState.cooldownUntil) <= now || !POOL_WIDE.has(routeState.health)) continue;
    const previous = result.get(info.id);
    if (!previous || Date.parse(routeState.cooldownUntil) > Date.parse(previous.cooldownUntil)) {
      result.set(info.id, { health: routeState.health, cooldownUntil: routeState.cooldownUntil, routeId: route.id });
    }
  }
  return result;
}

// Owner-facing pool summary from the pool and provider_status rows: one entry
// per independent pool, never one per model.
export function poolSummary(pool, state, { now = Date.now(), usage = new Map() } = {}) {
  const pools = new Map();
  for (const route of pool) {
    if (route.billingClass === 'paid' || route.retired) continue;
    const info = route.capacityPool || capacityPool(route);
    const entry = pools.get(info.id) || { id: info.id, label: info.label, account: info.account, shared: info.shared, scarce: info.scarce,
      billingClass: route.billingClass, models: [], configured: false, state: 'available', nextReset: null, reasons: [] };
    entry.models.push(route.model);
    if (!route.unavailableReasons?.length) entry.configured = true;
    const routeState = state.get(route.id);
    const cooling = routeState?.cooldownUntil && Date.parse(routeState.cooldownUntil) > now;
    if (cooling) {
      const exhausted = routeState.health === 'quota_exhausted';
      entry.reasons.push(routeState.health);
      if (!entry.nextReset || Date.parse(routeState.cooldownUntil) < Date.parse(entry.nextReset)) entry.nextReset = routeState.cooldownUntil;
      entry.coolingMembers = (entry.coolingMembers || 0) + 1;
      if (exhausted) entry.exhaustedMembers = (entry.exhaustedMembers || 0) + 1;
    }
    pools.set(info.id, entry);
  }
  return [...pools.values()].map((entry) => {
    const all = entry.models.length;
    const cooling = entry.coolingMembers || 0;
    const state = !entry.configured ? 'not_configured'
      : cooling === 0 ? 'available'
        : entry.shared || cooling >= all ? ((entry.exhaustedMembers || 0) > 0 ? 'exhausted' : 'degraded') : 'degraded';
    const used = usage.get(entry.id) || { tokensToday: 0, tokensMonth: 0, failedToday: 0 };
    const { coolingMembers, exhaustedMembers, ...rest } = entry;
    return { ...rest, state, ...used, estimatedCapacityLeft: null };
  }).toSorted((left, right) => left.id.localeCompare(right.id));
}
