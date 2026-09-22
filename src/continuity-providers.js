import { ContinuityError } from './continuity-core.js';

function parseJsonObject(text) {
  const source = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(source); } catch {
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(source.slice(start, end + 1));
    throw new ContinuityError('Provider did not return a JSON object', { code: 'INVALID_PROVIDER_OUTPUT' });
  }
}

async function requestJson(url, init, fetchFn) {
  let response;
  try { response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(120000) }); }
  catch (error) {
    const networkCode = String(error?.cause?.code || error?.code || '').replace(/[^A-Z0-9_-]/gi, '').slice(0, 64) || null;
    throw new ContinuityError('Provider network request failed', { cause: error, code: 'NETWORK', networkCode });
  }
  const requestId = response.headers.get('x-request-id') || response.headers.get('request-id') || null;
  if (!response.ok) {
    let body = {};
    try { body = await response.json(); } catch {}
    const error = new ContinuityError(`Provider request failed with HTTP ${response.status}`, {
      status: response.status,
      type: body?.error?.type || body?.error?.code,
      retryAfter: response.headers.get('retry-after'),
      requestId,
    });
    throw error;
  }
  return { body: await response.json(), requestId };
}

export class OpenAIAdapter {
  constructor({ apiKey, model = 'gpt-5.3-codex', fetchFn = fetch } = {}) {
    if (model !== 'gpt-5.3-codex') throw new ContinuityError('Only gpt-5.3-codex is approved for the primary provider');
    this.name = 'openai'; this.model = model; this.apiKey = apiKey; this.fetchFn = fetchFn;
  }
  async complete({ instructions, input, metadata = {} }) {
    if (!this.apiKey) throw new ContinuityError('OPENAI_API_KEY is unavailable', { status: 401, type: 'authentication_error' });
    const { body, requestId } = await requestJson('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, instructions, input, reasoning: { effort: 'medium' }, max_output_tokens: 4000, store: false, metadata }),
    }, this.fetchFn);
    const text = body.output_text || (body.output || []).flatMap((item) => item.content || []).filter((item) => item.type === 'output_text').map((item) => item.text).join('');
    const usage = body.usage || {};
    const inputTokens = Number(usage.input_tokens || 0);
    const outputTokens = Number(usage.output_tokens || 0);
    const cached = Number(usage.input_tokens_details?.cached_tokens || 0);
    const costUsd = ((inputTokens - cached) * 1.75 + cached * 0.175 + outputTokens * 14) / 1_000_000;
    return { data: parseJsonObject(text), rawText: text, usage: { inputTokens, outputTokens, cachedInputTokens: cached, costUsd, requestId }, model: body.model || this.model };
  }
}

export class AnthropicAdapter {
  constructor({ apiKey, model = 'claude-sonnet-5', fetchFn = fetch } = {}) {
    if (model !== 'claude-sonnet-5') throw new ContinuityError('Only claude-sonnet-5 is approved for the backup provider');
    this.name = 'anthropic'; this.model = model; this.apiKey = apiKey; this.fetchFn = fetchFn;
  }
  async complete({ instructions, input }) {
    if (!this.apiKey) throw new ContinuityError('ANTHROPIC_API_KEY is unavailable', { status: 401, type: 'authentication_error' });
    const { body, requestId } = await requestJson('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, max_tokens: 4000, system: instructions, messages: [{ role: 'user', content: input }] }),
    }, this.fetchFn);
    const text = (body.content || []).filter((item) => item.type === 'text').map((item) => item.text).join('');
    const usage = body.usage || {};
    const cached = usage.cache_read_input_tokens || 0;
    const costUsd = ((usage.input_tokens || 0) * 2 + (usage.output_tokens || 0) * 10 + cached * 0.2) / 1_000_000;
    return { data: parseJsonObject(text), rawText: text, usage: { inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0, cachedInputTokens: cached, costUsd, requestId }, model: body.model || this.model };
  }
}

export class SimulatedFailureAdapter {
  constructor(adapter, { stage, count = 2, status = 429, retryAfter = '0' }) {
    this.adapter = adapter; this.name = adapter.name; this.model = adapter.model; this.stage = stage; this.remaining = count; this.status = status; this.retryAfter = retryAfter;
  }
  async complete(request) {
    if (request.stage === this.stage && this.remaining-- > 0) throw new ContinuityError('Simulated provider failure', { status: this.status, type: 'rate_limit_error', retryAfter: this.retryAfter, simulated: true });
    return this.adapter.complete(request);
  }
}
