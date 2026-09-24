import { calculateCost } from './responses-compatible.js';

const DEFAULT_TIMEOUT_MS = 120000;

export class ChatCompletionsCompatibleAdapter {
  constructor({ name, apiKey, endpoint, model, fetchFn = fetch, pricing = null,
    maxTokensField = 'max_tokens', timeoutMs = DEFAULT_TIMEOUT_MS, capabilities = [] } = {}) {
    this.name = requiredToken(name, 'provider name');
    this.model = requiredToken(model, 'model');
    this.apiKey = normalizeSecret(apiKey);
    this.endpoint = validateHttpsEndpoint(endpoint);
    this.fetchFn = fetchFn;
    this.pricing = pricing;
    this.maxTokensField = maxTokensField;
    this.timeoutMs = timeoutMs;
    this.capabilities = Object.freeze([...new Set(['text', ...capabilities])]);
  }

  async complete({ prompt, systemPrompt, model, maxOutputTokens, allowedTools, clientRequestId }) {
    if (!this.apiKey) throw providerError(`${this.name.toUpperCase()} API key is unavailable`, { status: 401, type: 'authentication_error' });
    if (allowedTools.length) throw providerError(`${this.name} host-tool translation is not enabled`, { status: 422, type: 'unsupported_capability' });
    const startedAt = Date.now();
    const requestBody = {
      model: model || this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      stream: false,
      [this.maxTokensField]: maxOutputTokens,
    };

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

    const requestId = response.headers.get('x-request-id')
      || response.headers.get('x-trace-id')
      || response.headers.get('request-id')
      || null;
    if (!response.ok) {
      let body = {};
      try { body = await response.json(); } catch {}
      throw providerError(`${this.name} request failed`, {
        status: response.status,
        type: body?.error?.type || body?.error?.code || body?.code || null,
        retryAfter: response.headers.get('retry-after'),
        providerRequestId: requestId,
      });
    }

    const body = await response.json();
    const usage = body.usage || {};
    const normalizedUsage = {
      inputTokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
      outputTokens: Number(usage.completion_tokens || usage.output_tokens || 0),
      reasoningTokens: Number(usage.completion_tokens_details?.reasoning_tokens || 0),
      cachedInputTokens: Number(usage.prompt_tokens_details?.cached_tokens || usage.cached_tokens || 0),
    };
    normalizedUsage.costUsd = calculateCost(normalizedUsage, this.pricing);
    return {
      text: extractText(body),
      model: body.model || model || this.model,
      requestId,
      usage: normalizedUsage,
      durationMs: Date.now() - startedAt,
      turns: 1,
    };
  }
}

function extractText(body) {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((item) => item?.type === 'text' && typeof item.text === 'string').map((item) => item.text).join('');
  return '';
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
