const DEFAULT_TIMEOUT_MS = 120000;

export class ResponsesCompatibleAdapter {
  constructor({ name, apiKey, endpoint, model, fetchFn = fetch, pricing = null,
    includeStore = false, includeMetadata = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.name = requiredToken(name, 'provider name');
    this.model = requiredToken(model, 'model');
    this.apiKey = normalizeSecret(apiKey);
    this.endpoint = validateHttpsEndpoint(endpoint);
    this.fetchFn = fetchFn;
    this.pricing = pricing;
    this.includeStore = includeStore;
    this.includeMetadata = includeMetadata;
    this.timeoutMs = timeoutMs;
    this.capabilities = Object.freeze(['text']);
  }

  async complete({ prompt, systemPrompt, model, maxOutputTokens, allowedTools, context, stage, clientRequestId }) {
    if (!this.apiKey) throw providerError(`${this.name.toUpperCase()} API key is unavailable`, { status: 401, type: 'authentication_error' });
    if (allowedTools.length) throw providerError(`${this.name} host-tool translation is not enabled`, { status: 422, type: 'unsupported_capability' });
    const startedAt = Date.now();
    const requestBody = { model: model || this.model, instructions: systemPrompt, input: prompt, max_output_tokens: maxOutputTokens };
    if (this.includeStore) requestBody.store = false;
    if (this.includeMetadata) requestBody.metadata = compactMetadata({ ...context, stage });

    let response;
    try {
      response = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', 'x-client-request-id': clientRequestId },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw providerError(`${this.name} network request failed`, {
        cause: error,
        code: 'NETWORK',
        networkCode: String(error?.cause?.code || error?.code || '').replace(/[^A-Z0-9_-]/gi, '').slice(0, 64) || null,
      });
    }

    const requestId = response.headers.get('x-request-id') || response.headers.get('x-ds-trace-id') || null;
    if (!response.ok) {
      let body = {};
      try { body = await response.json(); } catch {}
      throw providerError(`${this.name} request failed`, {
        status: response.status,
        type: body?.error?.type || body?.error?.code || null,
        retryAfter: response.headers.get('retry-after'),
        providerRequestId: requestId,
      });
    }

    const body = await response.json();
    const usage = body.usage || {};
    const normalizedUsage = {
      inputTokens: Number(usage.input_tokens || 0),
      outputTokens: Number(usage.output_tokens || 0),
      reasoningTokens: Number(usage.output_tokens_details?.reasoning_tokens || 0),
      cachedInputTokens: Number(usage.input_tokens_details?.cached_tokens || 0),
    };
    normalizedUsage.costUsd = calculateCost(normalizedUsage, this.pricing);
    return {
      text: extractOutputText(body),
      model: body.model || model || this.model,
      requestId,
      usage: normalizedUsage,
      durationMs: Date.now() - startedAt,
      turns: 1,
    };
  }
}

export function calculateCost(usage, pricing) {
  if (!pricing) return 0;
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (uncached * Number(pricing.inputPerMillion || 0) + usage.cachedInputTokens * Number(pricing.cachedInputPerMillion || 0) + usage.outputTokens * Number(pricing.outputPerMillion || 0)) / 1_000_000;
}

function extractOutputText(body) {
  if (typeof body.output_text === 'string') return body.output_text;
  return (body.output || []).flatMap((item) => item.content || [])
    .filter((item) => ['output_text', 'text'].includes(item.type) && typeof item.text === 'string')
    .map((item) => item.text).join('');
}

function compactMetadata(values) {
  return Object.fromEntries(Object.entries(values)
    .filter(([, value]) => typeof value === 'string' && value)
    .map(([key, value]) => [key, value.slice(0, 512)]));
}

function normalizeSecret(value) { return typeof value === 'string' ? value.trim() : value; }

function requiredToken(value, name) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}

function validateHttpsEndpoint(value) {
  const endpoint = new URL(value);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('Provider endpoint must be HTTPS');
  return endpoint.href;
}

function providerError(message, details) {
  const error = new Error(message, details?.cause ? { cause: details.cause } : undefined);
  Object.assign(error, details);
  return error;
}
