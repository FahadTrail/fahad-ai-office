// Shared HTTP plumbing for agentic provider protocols. Errors carry only
// status/type/retry metadata; provider response bodies and credentials are
// never copied into messages that reach logs or the database.

export async function postJson({ fetchFn = fetch, url, headers, body, timeoutMs = 180_000, provider }) {
  let response;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw providerError(`${provider} network request failed`, {
      code: 'NETWORK',
      networkCode: String(error?.cause?.code || error?.code || error?.name || '').replace(/[^A-Z0-9_-]/gi, '').slice(0, 64) || 'NETWORK',
      cause: error,
    });
  }
  const requestId = response.headers.get('x-request-id') || response.headers.get('request-id') ||
    response.headers.get('x-goog-request-id') || null;
  const rateLimit = parseRateLimitHeaders(response.headers);
  if (!response.ok) {
    let payload = {};
    try { payload = await response.json(); } catch {}
    const type = payload?.error?.type || payload?.error?.status || payload?.error?.code || payload?.code || null;
    throw providerError(`${provider} request failed`, {
      status: response.status,
      type: typeof type === 'string' ? type : String(type ?? ''),
      retryAfter: response.headers.get('retry-after'),
      providerRequestId: requestId,
      rateLimit,
    });
  }
  return { body: await response.json(), requestId, rateLimit };
}

export function providerError(message, details = {}) {
  const error = new Error(message, details.cause ? { cause: details.cause } : undefined);
  Object.assign(error, details);
  return error;
}

// Normalizes the rate-limit headers documented by Anthropic
// (anthropic-ratelimit-*) and OpenAI-compatible providers (x-ratelimit-*).
// Values a provider does not send stay null; nothing is estimated here.
export function parseRateLimitHeaders(headers) {
  const get = (name) => headers?.get?.(name) ?? null;
  const number = (value) => (value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));
  const anthropic = {
    requestsLimit: number(get('anthropic-ratelimit-requests-limit')),
    requestsRemaining: number(get('anthropic-ratelimit-requests-remaining')),
    requestsReset: get('anthropic-ratelimit-requests-reset'),
    tokensLimit: number(get('anthropic-ratelimit-tokens-limit') ?? get('anthropic-ratelimit-input-tokens-limit')),
    tokensRemaining: number(get('anthropic-ratelimit-tokens-remaining') ?? get('anthropic-ratelimit-input-tokens-remaining')),
    tokensReset: get('anthropic-ratelimit-tokens-reset') ?? get('anthropic-ratelimit-input-tokens-reset'),
  };
  const openai = {
    requestsLimit: number(get('x-ratelimit-limit-requests')),
    requestsRemaining: number(get('x-ratelimit-remaining-requests')),
    requestsReset: durationToIso(get('x-ratelimit-reset-requests')),
    tokensLimit: number(get('x-ratelimit-limit-tokens')),
    tokensRemaining: number(get('x-ratelimit-remaining-tokens')),
    tokensReset: durationToIso(get('x-ratelimit-reset-tokens')),
  };
  const source = Object.values(anthropic).some((value) => value != null) ? anthropic : openai;
  const retryAfterSeconds = number(get('retry-after'));
  const result = { ...source, retryAfterSeconds };
  return Object.values(result).some((value) => value != null) ? Object.freeze(result) : null;
}

// OpenAI-style reset headers are durations such as "1s", "6m0s" or "20ms".
function durationToIso(value, now = Date.now()) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
  let ms = 0;
  let matched = false;
  for (const [, amount, unit] of String(value).matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    ms += Number(amount) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit];
  }
  return matched ? new Date(now + ms).toISOString() : null;
}

export function costUsd(usage, pricing) {
  if (!pricing) return 0;
  const cached = usage.cachedInputTokens || 0;
  const cacheWrite = usage.cacheWriteTokens || 0;
  const uncached = Math.max(0, (usage.inputTokens || 0) - cached - cacheWrite);
  const total = (uncached * pricing.inputPerMillion
    + cached * (pricing.cachedInputPerMillion ?? pricing.inputPerMillion)
    + cacheWrite * (pricing.cacheWritePerMillion ?? pricing.inputPerMillion)
    + ((usage.outputTokens || 0) + (usage.reasoningTokens || 0)) * pricing.outputPerMillion) / 1_000_000;
  return Number(total.toFixed(8));
}

export function safeJsonParse(value) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { __invalid_json: String(value).slice(0, 2000) };
  }
}
