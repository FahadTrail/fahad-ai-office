import { costUsd, postJson, providerError, safeJsonParse } from './http.js';
import { portableSchema } from './conversation.js';

// OpenAI-style Responses API turn with function tools. Requests are
// stateless (store: false): the durable transcript lives in Fahad AI Office,
// never in provider-side conversation state.
export class OpenAIResponsesProtocol {
  constructor({ apiKey, endpoint = 'https://api.openai.com/v1/responses', pricing, fetchFn = fetch, timeoutMs = 600_000, reasoningEffort = null } = {}) {
    this.protocol = 'openai-responses';
    this.apiKey = apiKey || null;
    this.endpoint = endpoint;
    this.pricing = pricing;
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
    this.reasoningEffort = reasoningEffort;
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  async turn({ provider, model, system, messages, tools, maxOutputTokens = 16_000, clientRequestId }) {
    if (!this.apiKey) throw providerError(`${provider} credential is unavailable`, { status: 401, type: 'authentication_error' });
    const startedAt = Date.now();
    const { body, requestId, rateLimit } = await postJson({
      fetchFn: this.fetchFn,
      url: this.endpoint,
      provider,
      timeoutMs: this.timeoutMs,
      headers: { authorization: `Bearer ${this.apiKey}`, ...(clientRequestId ? { 'x-client-request-id': clientRequestId } : {}) },
      body: {
        model,
        instructions: system,
        input: toResponsesInput(messages),
        tools: tools.map((tool) => ({
          type: 'function', name: tool.name, description: tool.description, parameters: portableSchema(tool.inputSchema), strict: false,
        })),
        store: false,
        max_output_tokens: maxOutputTokens,
        ...(this.reasoningEffort ? { reasoning: { effort: this.reasoningEffort } } : {}),
      },
    });
    const usage = {
      inputTokens: body.usage?.input_tokens || 0,
      outputTokens: body.usage?.output_tokens || 0,
      cachedInputTokens: body.usage?.input_tokens_details?.cached_tokens || 0,
      reasoningTokens: 0,
    };
    usage.costUsd = costUsd(usage, this.pricing);
    const content = [];
    for (const item of body.output || []) {
      if (item.type === 'message') {
        for (const part of item.content || []) {
          if ((part.type === 'output_text' || part.type === 'text') && part.text) content.push({ type: 'text', text: part.text });
          if (part.type === 'refusal') throw providerError(`${provider} declined the request`, { status: 422, type: 'refusal', usage });
        }
      } else if (item.type === 'function_call') {
        content.push({ type: 'tool_call', id: item.call_id || item.id, name: item.name, arguments: safeJsonParse(item.arguments) });
      }
    }
    const incomplete = body.status === 'incomplete' && body.incomplete_details?.reason === 'max_output_tokens';
    return {
      message: { role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] },
      stopReason: content.some((block) => block.type === 'tool_call') ? 'tool_calls' : incomplete ? 'max_tokens' : 'end',
      usage,
      requestId: requestId || body.id || null,
      rateLimit,
      durationMs: Date.now() - startedAt,
      model: body.model || model,
    };
  }
}

export function toResponsesInput(messages) {
  const input = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text' && block.text) {
        input.push(message.role === 'assistant'
          ? { role: 'assistant', content: [{ type: 'output_text', text: block.text }] }
          : { role: 'user', content: [{ type: 'input_text', text: block.text }] });
      } else if (block.type === 'tool_call') {
        input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.arguments || {}) });
      } else if (block.type === 'tool_result') {
        input.push({ type: 'function_call_output', call_id: block.callId, output: block.content || '(empty)' });
      }
    }
  }
  return input;
}
