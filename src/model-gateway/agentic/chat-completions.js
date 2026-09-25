import { costUsd, postJson, providerError, safeJsonParse } from './http.js';
import { portableSchema } from './conversation.js';

// OpenAI-compatible Chat Completions turn with function tools. Used by
// DeepSeek, Qwen, Kimi, GLM/Zhipu, MiniMax, OpenRouter, Groq and any other
// provider that officially documents this protocol.
export class ChatCompletionsProtocol {
  constructor({ apiKey, endpoint, pricing, fetchFn = fetch, timeoutMs = 600_000, maxTokensField = 'max_tokens', extraHeaders = {}, extraBody = {}, freeOnly = false } = {}) {
    this.freeOnly = freeOnly;
    if (!/^https:\/\//.test(String(endpoint || ''))) throw new TypeError('Chat Completions endpoint must be an HTTPS URL');
    this.protocol = 'chat-completions';
    this.apiKey = apiKey || null;
    this.endpoint = endpoint;
    this.pricing = pricing;
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
    this.maxTokensField = maxTokensField;
    this.extraHeaders = extraHeaders;
    this.extraBody = extraBody;
  }

  get configured() {
    return Boolean(this.apiKey) && !/\.invalid\//.test(this.endpoint);
  }

  async turn({ provider, model, system, messages, tools, maxOutputTokens = 16_000, clientRequestId }) {
    if (!this.apiKey) throw providerError(`${provider} credential is unavailable`, { status: 401, type: 'authentication_error' });
    const startedAt = Date.now();
    const { body, requestId, rateLimit } = await postJson({
      fetchFn: this.fetchFn,
      url: this.endpoint,
      provider,
      timeoutMs: this.timeoutMs,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(clientRequestId ? { 'x-client-request-id': clientRequestId } : {}),
        ...this.extraHeaders,
      },
      body: {
        model,
        messages: toChatMessages(system, messages),
        tools: tools.map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: portableSchema(tool.inputSchema) },
        })),
        tool_choice: 'auto',
        stream: false,
        [this.maxTokensField]: maxOutputTokens,
        ...this.extraBody,
      },
    });
    const choice = body.choices?.[0];
    if (!choice?.message) throw providerError(`${provider} returned no choice`, { status: 502, type: 'empty_response' });
    const usage = {
      inputTokens: body.usage?.prompt_tokens || 0,
      outputTokens: body.usage?.completion_tokens || 0,
      cachedInputTokens: body.usage?.prompt_tokens_details?.cached_tokens || body.usage?.prompt_cache_hit_tokens || 0,
      reasoningTokens: 0,
    };
    usage.costUsd = costUsd(usage, this.pricing);
    // Free-only guard: a provider-reported cost on a free route means the
    // request was billed. Record the real cost, refuse the result and let the
    // gateway quarantine the route and fail over.
    const reportedCost = Number(body.usage?.cost ?? body.usage?.total_cost ?? 0);
    if (this.freeOnly && Number.isFinite(reportedCost) && reportedCost > 0) {
      throw providerError(`${provider} billed a free-only route`, { status: 402, type: 'paid_on_free_route', usage: { ...usage, costUsd: Number(reportedCost.toFixed(8)) } });
    }
    if (choice.finish_reason === 'content_filter') {
      throw providerError(`${provider} filtered the request`, { status: 422, type: 'refusal', usage });
    }
    const content = [];
    const textValue = typeof choice.message.content === 'string'
      ? choice.message.content
      : Array.isArray(choice.message.content)
        ? choice.message.content.map((part) => part?.text || '').join('')
        : '';
    if (textValue.trim()) content.push({ type: 'text', text: textValue });
    for (const call of choice.message.tool_calls || []) {
      if (call.type && call.type !== 'function') continue;
      content.push({ type: 'tool_call', id: call.id, name: call.function?.name, arguments: safeJsonParse(call.function?.arguments) });
    }
    return {
      message: { role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] },
      stopReason: content.some((block) => block.type === 'tool_call') ? 'tool_calls'
        : choice.finish_reason === 'length' ? 'max_tokens' : 'end',
      usage,
      requestId: requestId || body.id || null,
      rateLimit,
      durationMs: Date.now() - startedAt,
      model: body.model || model,
    };
  }
}

export function toChatMessages(system, messages) {
  const result = [{ role: 'system', content: system }];
  for (const message of messages) {
    if (message.role === 'assistant') {
      const textValue = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
      const calls = message.content.filter((block) => block.type === 'tool_call').map((block) => ({
        id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.arguments || {}) },
      }));
      if (!textValue && !calls.length) continue;
      result.push({ role: 'assistant', content: textValue || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const block of message.content.filter((item) => item.type === 'tool_result')) {
      result.push({ role: 'tool', tool_call_id: block.callId, content: block.content || '(empty)' });
    }
    const textValue = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    if (textValue) result.push({ role: 'user', content: textValue });
  }
  return result;
}
