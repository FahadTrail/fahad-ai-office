import { randomUUID } from 'node:crypto';
import { costUsd, postJson, providerError } from './http.js';
import { portableSchema, stripForeignReasoning } from './conversation.js';

// Gemini generateContent turn with function declarations. Gemini thought
// signatures are attached to function-call parts and must be echoed back to
// the same model, so they travel in the neutral block's providerData.
export class GeminiProtocol {
  constructor({ apiKey, baseUrl = 'https://generativelanguage.googleapis.com/v1beta', pricing, fetchFn = fetch, timeoutMs = 600_000 } = {}) {
    this.protocol = 'gemini';
    this.apiKey = apiKey || null;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.pricing = pricing;
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  async turn({ provider, model, system, messages, tools, maxOutputTokens = 16_000 }) {
    if (!this.apiKey) throw providerError(`${provider} credential is unavailable`, { status: 401, type: 'authentication_error' });
    if (!/^[A-Za-z0-9._-]+$/.test(model)) throw providerError(`${provider} model id is invalid`, { status: 400, type: 'invalid_model' });
    const startedAt = Date.now();
    const { body, requestId, rateLimit } = await postJson({
      fetchFn: this.fetchFn,
      url: `${this.baseUrl}/models/${model}:generateContent`,
      provider,
      timeoutMs: this.timeoutMs,
      headers: { 'x-goog-api-key': this.apiKey },
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: toGeminiContents(stripForeignReasoning(messages, { provider, model }), { provider, model }),
        tools: [{ functionDeclarations: tools.map((tool) => ({
          name: tool.name, description: tool.description, parameters: portableSchema(tool.inputSchema),
        })) }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        generationConfig: { maxOutputTokens },
      },
    });
    const usage = {
      inputTokens: body.usageMetadata?.promptTokenCount || 0,
      outputTokens: body.usageMetadata?.candidatesTokenCount || 0,
      cachedInputTokens: body.usageMetadata?.cachedContentTokenCount || 0,
      reasoningTokens: body.usageMetadata?.thoughtsTokenCount || 0,
    };
    usage.costUsd = costUsd(usage, this.pricing);
    const candidate = body.candidates?.[0];
    if (!candidate) {
      const blocked = body.promptFeedback?.blockReason;
      throw providerError(`${provider} returned no candidate`, { status: blocked ? 422 : 502, type: blocked ? 'refusal' : 'empty_response', usage });
    }
    if (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(candidate.finishReason)) {
      throw providerError(`${provider} blocked the response`, { status: 422, type: 'refusal', usage });
    }
    const content = [];
    for (const part of candidate.content?.parts || []) {
      if (part.thought) continue;
      if (part.functionCall) {
        content.push({
          type: 'tool_call',
          id: part.functionCall.id || `gemini_${randomUUID()}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args || {},
          ...(part.thoughtSignature ? { providerData: { provider, model, thoughtSignature: part.thoughtSignature } } : {}),
        });
      } else if (typeof part.text === 'string' && part.text) {
        content.push({ type: 'text', text: part.text });
      }
    }
    return {
      message: { role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] },
      stopReason: content.some((block) => block.type === 'tool_call') ? 'tool_calls'
        : candidate.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end',
      usage,
      requestId,
      rateLimit,
      durationMs: Date.now() - startedAt,
      model: body.modelVersion || model,
    };
  }
}

export function toGeminiContents(messages, { provider, model } = {}) {
  const contents = [];
  for (const message of messages) {
    const parts = [];
    for (const block of message.content) {
      if (block.type === 'text' && block.text) parts.push({ text: block.text });
      else if (block.type === 'tool_call') {
        const part = { functionCall: { name: block.name, args: block.arguments || {} } };
        if (block.providerData?.thoughtSignature && block.providerData.provider === provider && block.providerData.model === model) {
          part.thoughtSignature = block.providerData.thoughtSignature;
        }
        parts.push(part);
      } else if (block.type === 'tool_result') {
        parts.push({ functionResponse: { name: block.name, response: { content: block.content || '(empty)', isError: Boolean(block.isError) } } });
      }
    }
    if (!parts.length) continue;
    const role = message.role === 'assistant' ? 'model' : 'user';
    const previous = contents.at(-1);
    if (previous?.role === role) previous.parts.push(...parts);
    else contents.push({ role, parts });
  }
  return contents;
}
