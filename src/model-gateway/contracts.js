import { randomUUID } from 'node:crypto';

export const FAILURE_CLASS = Object.freeze({
  RETRY: 'retry',
  FAILOVER: 'failover',
  APPROVAL: 'approval',
  FATAL: 'fatal',
});

export class GatewayError extends Error {
  constructor(message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = 'GatewayError';
    Object.assign(this, details);
  }
}

export function normalizeGatewayRequest(input = {}) {
  const prompt = requiredString(input.prompt, 'prompt');
  const systemPrompt = requiredString(input.systemPrompt, 'systemPrompt');
  const model = requiredString(input.model, 'model');
  const stage = requiredString(input.stage || 'model', 'stage');
  const idempotencyKey = requiredString(input.idempotencyKey || `ephemeral:${randomUUID()}`, 'idempotencyKey');
  const maxTurns = boundedInteger(input.maxTurns, 'maxTurns', 1, 100);
  const allowedTools = normalizeStringList(input.allowedTools || []);
  const capabilities = normalizeStringList(input.capabilities || ['text']);
  const context = normalizeContext(input.context || {});
  const budget = normalizeBudget(input.budget);
  const routingHints = normalizeRoutingHints(input.routingHints);

  return Object.freeze({
    prompt,
    systemPrompt,
    model,
    provider: optionalString(input.provider),
    stage,
    idempotencyKey,
    maxTurns,
    maxOutputTokens: input.maxOutputTokens == null
      ? 4000
      : boundedInteger(input.maxOutputTokens, 'maxOutputTokens', 1, 128000),
    allowedTools,
    capabilities,
    context,
    budget,
    routingHints,
    onActivity: typeof input.onActivity === 'function' ? input.onActivity : async () => {},
  });
}

function normalizeRoutingHints(value) {
  if (value == null) return Object.freeze({ requiresPrivateData: true, estimatedContextTokens: 0, healthyProviders: null, preferQuality: false });
  if (typeof value !== 'object' || Array.isArray(value)) throw new GatewayError('routingHints must be an object', { code: 'INVALID_GATEWAY_REQUEST' });
  return Object.freeze({
    requiresPrivateData: value.requiresPrivateData !== false,
    estimatedContextTokens: value.estimatedContextTokens == null ? 0 : nonNegativeNumber(value.estimatedContextTokens, 'routingHints.estimatedContextTokens'),
    healthyProviders: value.healthyProviders == null ? null : normalizeStringList(value.healthyProviders),
    preferQuality: value.preferQuality === true,
  });
}

export function normalizeGatewayResult(result, attempt) {
  const text = requiredString(result?.text, 'provider result text').trim();
  const usage = normalizeUsage(result?.usage);
  const model = requiredString(result?.model || attempt.model, 'provider result model');
  const durationMs = nonNegativeNumber(result?.durationMs ?? attempt.durationMs, 'durationMs');
  const turns = Math.max(0, Number(result?.turns || 0));

  return {
    text,
    provider: attempt.provider,
    model,
    requestId: optionalString(result?.requestId),
    clientRequestId: attempt.clientRequestId,
    durationMs,
    turns,
    usage,
    tokensIn: usage.inputTokens,
    tokensOut: usage.outputTokens,
    costUsd: usage.costUsd,
  };
}

export function normalizeUsage(usage = {}) {
  const inputTokens = nonNegativeNumber(usage.inputTokens ?? usage.input_tokens ?? 0, 'inputTokens');
  const outputTokens = nonNegativeNumber(usage.outputTokens ?? usage.output_tokens ?? 0, 'outputTokens');
  const reasoningTokens = nonNegativeNumber(usage.reasoningTokens ?? usage.reasoning_tokens ?? 0, 'reasoningTokens');
  const cachedInputTokens = nonNegativeNumber(usage.cachedInputTokens ?? usage.cached_input_tokens ?? 0, 'cachedInputTokens');
  const costUsd = nonNegativeNumber(usage.costUsd ?? usage.cost_usd ?? 0, 'costUsd');
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedInputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd,
  };
}

export function classifyProviderError(error) {
  if (error instanceof GatewayError && error.failureClass) return error;
  const status = Number(error?.status || 0) || null;
  const type = String(error?.type || error?.code || '').toLowerCase();
  const networkCode = optionalString(error?.networkCode || error?.cause?.code);
  let failureClass = FAILURE_CLASS.FATAL;
  let code = 'PROVIDER_ERROR';
  let usage = null;
  try { if (error?.usage) usage = normalizeUsage(error.usage); } catch {}

  if (status === 401 || status === 403 || /auth|api.?key|permission/.test(type)) {
    failureClass = FAILURE_CLASS.APPROVAL;
    code = 'PROVIDER_AUTH';
  } else if (status === 402 || /billing|credit|quota_exhausted|capacity_exhausted/.test(type)) {
    // Provider-specific credit or capacity exhaustion is safe to route around.
    // Workspace budget exhaustion remains a separate approval-class error.
    failureClass = FAILURE_CLASS.FAILOVER;
    code = 'PROVIDER_CAPACITY';
  } else if (status === 429 || /rate.?limit|overloaded/.test(type)) {
    failureClass = FAILURE_CLASS.RETRY;
    code = 'PROVIDER_RATE_LIMIT';
  } else if (status === 404 || status === 422 || /unsupported|model.?not.?found|not.?available/.test(type)) {
    failureClass = FAILURE_CLASS.FAILOVER;
    code = 'PROVIDER_UNSUITABLE';
  } else if (networkCode || /network|timeout|timed.?out|fetch.?failed|econn|enotfound|socket|connection|aborted/.test(type) || /network|timeout|timed.?out|fetch.?failed|socket|connection|aborted/.test(String(error?.message || '').toLowerCase()) || status === 408 || status === 409 || status >= 500) {
    failureClass = FAILURE_CLASS.RETRY;
    code = networkCode ? 'PROVIDER_NETWORK' : 'PROVIDER_TRANSIENT';
  } else if (status === 400 || /invalid/.test(type)) {
    code = 'PROVIDER_INVALID_REQUEST';
  }

  return new GatewayError(safeProviderMessage(error), {
    cause: error,
    code,
    failureClass,
    status,
    type: optionalString(error?.type),
    networkCode,
    retryAfter: optionalString(error?.retryAfter),
    ...(error?.reason ? { reason: optionalString(error.reason) } : {}),
    providerRequestId: optionalString(error?.providerRequestId || error?.requestId),
    usage,
  });
}

export function retryDelayMs(error, attempt) {
  const seconds = Number(error?.retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1000);
  return Math.min(10_000, 250 * (2 ** Math.max(0, attempt - 1)));
}

export function attemptErrorRecord(error) {
  return {
    code: error.code || 'PROVIDER_ERROR',
    failureClass: error.failureClass || FAILURE_CLASS.FATAL,
    status: error.status || null,
    type: error.type || null,
    networkCode: error.networkCode || null,
    providerRequestId: error.providerRequestId || null,
  };
}

function normalizeContext(context) {
  return {
    workspaceId: optionalString(context.workspaceId),
    jobId: optionalString(context.jobId),
    taskId: optionalString(context.taskId),
    runId: optionalString(context.runId),
    agentId: optionalString(context.agentId),
  };
}

function normalizeBudget(budget) {
  if (budget == null) return null;
  const limitUsd = nonNegativeNumber(budget.limitUsd, 'budget.limitUsd');
  const spentUsd = nonNegativeNumber(budget.spentUsd || 0, 'budget.spentUsd');
  if (limitUsd <= 0) throw new GatewayError('budget.limitUsd must be greater than zero', { code: 'INVALID_GATEWAY_REQUEST' });
  return { limitUsd, spentUsd };
}

function normalizeStringList(values) {
  if (!Array.isArray(values)) throw new GatewayError('Expected an array of strings', { code: 'INVALID_GATEWAY_REQUEST' });
  return [...new Set(values.map((value) => requiredString(value, 'list item').trim()))];
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GatewayError(`${name} must be a non-empty string`, { code: 'INVALID_GATEWAY_REQUEST' });
  }
  return value;
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function boundedInteger(value, name, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new GatewayError(`${name} must be an integer from ${minimum} to ${maximum}`, { code: 'INVALID_GATEWAY_REQUEST' });
  }
  return number;
}

function nonNegativeNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new GatewayError(`${name} must be a non-negative number`, { code: 'INVALID_PROVIDER_RESULT' });
  }
  return number;
}

function safeProviderMessage(error) {
  const status = Number(error?.status || 0);
  return status ? `Provider request failed with HTTP ${status}` : 'Provider request failed';
}
