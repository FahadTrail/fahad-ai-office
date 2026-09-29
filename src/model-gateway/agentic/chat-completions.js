import { createHash } from 'node:crypto';
import { costUsd, postJson, providerError, safeJsonParse } from './http.js';
import { portableSchema } from './conversation.js';

// OpenAI-compatible Chat Completions turn with function tools. Used by
// DeepSeek, Qwen, Kimi, GLM/Zhipu, MiniMax, OpenRouter, Groq and any other
// provider that officially documents this protocol.
export class ChatCompletionsProtocol {
  // Provider quirks are route metadata (model-pool.js `protocolOptions`), not
  // router code:
  //   toolCallIds: 'alnum9' — the provider accepts only 9-character [A-Za-z0-9]
  //     tool-call ids (Mistral). Ids are mapped deterministically, so an
  //     assistant tool call and its tool result always keep matching ids.
  //   omitEmptyTools — send no `tools` / `tool_choice` when there are no tools.
  constructor({ apiKey, endpoint, pricing, fetchFn = fetch, timeoutMs = 600_000, maxTokensField = 'max_tokens', extraHeaders = {}, extraBody = {}, freeOnly = false, toolCallIds = null, omitEmptyTools = false } = {}) {
    this.freeOnly = freeOnly;
    this.toolCallIds = toolCallIds;
    this.omitEmptyTools = omitEmptyTools;
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
        messages: toChatMessages(system, messages, { toolCallIds: this.toolCallIds }),
        ...(this.omitEmptyTools && !tools.length ? {} : {
          tools: tools.map((tool) => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: portableSchema(tool.inputSchema) },
          })),
          tool_choice: 'auto',
        }),
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
    // A cost the provider itself reports (OpenRouter usage accounting). The
    // gateway's free-route guard refuses any billed response on a free route.
    const reportedCost = Number(body.usage?.cost ?? body.usage?.total_cost ?? 0);
    if (Number.isFinite(reportedCost) && reportedCost > 0) usage.reportedCostUsd = Number(reportedCost.toFixed(8));
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

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// A stable 9-character [A-Za-z0-9] id for providers that require one.
export function alnum9(id) {
  const value = String(id ?? '');
  if (/^[A-Za-z0-9]{9}$/.test(value)) return value;
  const digest = createHash('sha256').update(value).digest();
  let out = '';
  for (let index = 0; index < 9; index += 1) out += ALNUM[digest[index] % ALNUM.length];
  return out;
}

export function toChatMessages(system, messages, { toolCallIds = null } = {}) {
  const mapId = toolCallIds === 'alnum9' ? alnum9 : (id) => id;
  const result = [{ role: 'system', content: system }];
  for (const message of messages) {
    if (message.role === 'assistant') {
      const textValue = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
      const calls = message.content.filter((block) => block.type === 'tool_call').map((block) => ({
        id: mapId(block.id), type: 'function', function: { name: block.name, arguments: JSON.stringify(block.arguments || {}) },
      }));
      if (!textValue && !calls.length) continue;
      result.push({ role: 'assistant', content: textValue || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const block of message.content.filter((item) => item.type === 'tool_result')) {
      result.push({ role: 'tool', tool_call_id: mapId(block.callId), content: block.content || '(empty)' });
    }
    const textValue = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    if (textValue) result.push({ role: 'user', content: textValue });
  }
  return result;
}
