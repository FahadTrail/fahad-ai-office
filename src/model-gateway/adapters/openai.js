export class OpenAIResponsesAdapter {
  constructor({ apiKey, model = 'gpt-5.3-codex', fetchFn = fetch, pricing = null } = {}) {
    this.name = 'openai';
    this.model = model;
    this.apiKey = normalizeSecret(apiKey);
    this.fetchFn = fetchFn;
    this.pricing = pricing;
    this.capabilities = Object.freeze(['text']);
  }

  async complete({ prompt, systemPrompt, model, maxOutputTokens, allowedTools, context, stage, clientRequestId }) {
    if (!this.apiKey) throw providerError('OPENAI_API_KEY is unavailable', { status: 401, type: 'authentication_error' });
    if (allowedTools.length) throw providerError('OpenAI host-tool translation is not enabled in Phase 2B', { status: 422, type: 'unsupported_capability' });
    const startedAt = Date.now();
    let response;
    try {
      response = await this.fetchFn('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          'x-client-request-id': clientRequestId,
        },
        body: JSON.stringify({
          model: model || this.model,
          instructions: systemPrompt,
          input: prompt,
          max_output_tokens: maxOutputTokens,
          store: false,
          metadata: compactMetadata({ ...context, stage }),
        }),
        signal: AbortSignal.timeout(120000),
      });
    } catch (error) {
      throw providerError('OpenAI network request failed', {
        cause: error,
        code: 'NETWORK',
        networkCode: String(error?.cause?.code || error?.code || '').replace(/[^A-Z0-9_-]/gi, '').slice(0, 64) || null,
      });
    }

    const requestId = response.headers.get('x-request-id') || null;
    if (!response.ok) {
      let body = {};
      try { body = await response.json(); } catch {}
      throw providerError('OpenAI request failed', {
        status: response.status,
        type: body?.error?.type || body?.error?.code || null,
        retryAfter: response.headers.get('retry-after'),
        providerRequestId: requestId,
      });
    }

    const body = await response.json();
    const text = body.output_text || (body.output || [])
      .flatMap((item) => item.content || [])
      .filter((item) => item.type === 'output_text')
      .map((item) => item.text)
      .join('');
    const usage = body.usage || {};
    const normalizedUsage = {
      inputTokens: Number(usage.input_tokens || 0),
      outputTokens: Number(usage.output_tokens || 0),
      reasoningTokens: Number(usage.output_tokens_details?.reasoning_tokens || 0),
      cachedInputTokens: Number(usage.input_tokens_details?.cached_tokens || 0),
    };
    normalizedUsage.costUsd = calculateCost(normalizedUsage, this.pricing);
    return {
      text,
      model: body.model || model || this.model,
      requestId,
      usage: normalizedUsage,
      durationMs: Date.now() - startedAt,
      turns: 1,
    };
  }
}

function calculateCost(usage, pricing) {
  if (!pricing) return 0;
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (
    uncached * Number(pricing.inputPerMillion || 0) +
    usage.cachedInputTokens * Number(pricing.cachedInputPerMillion || 0) +
    usage.outputTokens * Number(pricing.outputPerMillion || 0)
  ) / 1_000_000;
}

function compactMetadata(values) {
  return Object.fromEntries(Object.entries(values)
    .filter(([, value]) => typeof value === 'string' && value)
    .map(([key, value]) => [key, value.slice(0, 512)]));
}

function normalizeSecret(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function providerError(message, details) {
  const error = new Error(message, details?.cause ? { cause: details.cause } : undefined);
  Object.assign(error, details);
  return error;
}
