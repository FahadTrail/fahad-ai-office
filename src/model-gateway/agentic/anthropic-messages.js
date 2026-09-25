import Anthropic from '@anthropic-ai/sdk';
import { costUsd, parseRateLimitHeaders, providerError } from './http.js';
import { stripForeignReasoning } from './conversation.js';

// One Messages API turn with client-defined tools. The controller owns the
// agent loop, so SDK retries are disabled: retry and failover decisions are
// made by the provider-neutral router with durable checkpoints.
export class AnthropicMessagesProtocol {
  constructor({ apiKey, authToken = null, baseURL, pricing, effort = 'high', client = null, timeoutMs = 600_000 } = {}) {
    this.protocol = 'anthropic-messages';
    this.pricing = pricing;
    this.effort = effort;
    this.client = client || ((apiKey || authToken)
      ? new Anthropic({ apiKey: apiKey || null, authToken: authToken || null, baseURL, maxRetries: 0, timeout: timeoutMs })
      : null);
  }

  get configured() {
    return Boolean(this.client);
  }

  async turn({ provider, model, system, messages, tools, maxOutputTokens = 16_000, effort = null }) {
    if (!this.client) throw providerError(`${provider} credential is unavailable`, { status: 401, type: 'authentication_error' });
    const startedAt = Date.now();
    const params = {
      model,
      max_tokens: maxOutputTokens,
      system,
      messages: toAnthropicMessages(stripForeignReasoning(messages, { provider, model })),
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })),
      // Automatic prompt caching keeps the stable system/tool prefix and the
      // growing transcript cheap across the many turns of one task.
      cache_control: { type: 'ephemeral' },
      ...((effort || this.effort) ? { output_config: { effort: effort || this.effort } } : {}),
    };
    let data;
    let response;
    try {
      ({ data, response } = await this.client.messages.create(params).withResponse());
    } catch (error) {
      throw fromSdkError(provider, error);
    }
    const usage = {
      inputTokens: (data.usage?.input_tokens || 0) + (data.usage?.cache_read_input_tokens || 0) +
        (data.usage?.cache_creation_input_tokens || 0),
      outputTokens: data.usage?.output_tokens || 0,
      cachedInputTokens: data.usage?.cache_read_input_tokens || 0,
      cacheWriteTokens: data.usage?.cache_creation_input_tokens || 0,
      reasoningTokens: 0,
    };
    usage.costUsd = costUsd(usage, this.pricing);
    if (data.stop_reason === 'refusal') {
      throw providerError(`${provider} declined the request`, {
        status: 422, type: 'refusal', usage, providerRequestId: data.id,
      });
    }
    const content = [];
    for (const block of data.content || []) {
      if (block.type === 'text' && block.text) content.push({ type: 'text', text: block.text });
      else if (block.type === 'tool_use') content.push({ type: 'tool_call', id: block.id, name: block.name, arguments: block.input || {} });
      else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        content.push({ type: 'reasoning', provider, model, data: block });
      }
    }
    return {
      message: { role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] },
      stopReason: normalizeStop(data.stop_reason),
      usage,
      requestId: response.headers.get('request-id') || data.id || null,
      rateLimit: parseRateLimitHeaders(response.headers),
      durationMs: Date.now() - startedAt,
      model: data.model || model,
    };
  }
}

export function toAnthropicMessages(messages) {
  const result = [];
  for (const message of messages) {
    const content = [];
    for (const block of message.content) {
      if (block.type === 'text') {
        if (block.text) content.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_call') {
        content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.arguments || {} });
      } else if (block.type === 'tool_result') {
        content.push({ type: 'tool_result', tool_use_id: block.callId, content: block.content || '(empty)', is_error: block.isError || undefined });
      } else if (block.type === 'reasoning') {
        content.push(block.data);
      }
    }
    if (!content.length) continue;
    const previous = result.at(-1);
    if (previous?.role === message.role) previous.content.push(...content);
    else result.push({ role: message.role, content });
  }
  return result;
}

function normalizeStop(reason) {
  if (reason === 'tool_use') return 'tool_calls';
  if (reason === 'max_tokens') return 'max_tokens';
  if (reason === 'pause_turn') return 'pause';
  return 'end';
}

function fromSdkError(provider, error) {
  const status = Number(error?.status || 0) || null;
  const headers = error?.headers;
  const retryAfter = typeof headers?.get === 'function' ? headers.get('retry-after') : headers?.['retry-after'];
  const type = error?.error?.error?.type || error?.error?.type || (status ? null : 'network_error');
  return providerError(`${provider} request failed`, {
    status,
    type,
    retryAfter: retryAfter ?? null,
    providerRequestId: error?.requestID || error?.request_id || null,
    networkCode: status ? null : 'NETWORK',
    rateLimit: typeof headers?.get === 'function' ? parseRateLimitHeaders(headers) : null,
    cause: error,
  });
}
