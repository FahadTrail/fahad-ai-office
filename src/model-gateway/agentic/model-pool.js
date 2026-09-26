// The Model Pool is the controller-owned list of provider/model routes the
// agentic gateway may use. An entry is only *routable* when its credential is
// present, its privacy review allows the task's data, its pricing is known (or
// it is explicitly free/included) and the workspace policy authorizes it.
// Nothing here claims a provider works: live verification is recorded
// separately in provider_status by real canaries and real traffic.

import { AnthropicMessagesProtocol } from './anthropic-messages.js';
import { OpenAIResponsesProtocol } from './openai-responses.js';
import { ChatCompletionsProtocol } from './chat-completions.js';
import { GeminiProtocol } from './gemini.js';
import { capabilityProfile } from './capabilities.js';
import { getOpenRouterCatalog } from './openrouter-catalog.js';

export const BILLING_CLASS = Object.freeze({
  INCLUDED: 'included',
  FREE: 'free',
  PROMO: 'promo',
  PAID: 'paid',
});

export const DEFAULT_BILLING_PRIORITY = Object.freeze(['free', 'included', 'promo', 'paid']);

const truthy = (value) => /^(1|true|yes)$/i.test(String(value || ''));

// Conservative published list prices (USD per million tokens). Paid routes
// without pricing are excluded rather than recorded as zero cost.
export const PRICING = Object.freeze({
  'claude-opus-5': { inputPerMillion: 5, cachedInputPerMillion: 0.5, cacheWritePerMillion: 6.25, outputPerMillion: 25 },
  'claude-sonnet-5': { inputPerMillion: 2, cachedInputPerMillion: 0.2, cacheWritePerMillion: 2.5, outputPerMillion: 10 },
  // OpenAI API pricing page, standard tier (not "fast" mode), 2026-09.
  'gpt-5.3-codex': { inputPerMillion: 1.75, cachedInputPerMillion: 0.175, outputPerMillion: 14 },
  'deepseek-flash': { inputPerMillion: 0.30, cachedInputPerMillion: 0.006, outputPerMillion: 1.20 },
  'qwen3.8-flash': { inputPerMillion: 0.20, cachedInputPerMillion: 0.03, outputPerMillion: 0.60 },
  'kimi-k2.7-code': { inputPerMillion: 0.95, cachedInputPerMillion: 0.19, outputPerMillion: 4 },
  'glm-5.3-flash': { inputPerMillion: 0.15, cachedInputPerMillion: 0.03, outputPerMillion: 0.50 },
  'MiniMax-M2.7': { inputPerMillion: 0.30, cachedInputPerMillion: 0.06, cacheWritePerMillion: 0.375, outputPerMillion: 1.20 },
});

function readPricing(env, name, fallback) {
  const raw = env[name];
  if (!raw) return fallback || null;
  try {
    const parsed = JSON.parse(raw);
    if (!(Number(parsed.inputPerMillion) >= 0) || !(Number(parsed.outputPerMillion) >= 0)) return fallback || null;
    return Object.freeze(parsed);
  } catch {
    return fallback || null;
  }
}

function billing(env, name, fallback) {
  const value = String(env[name] || fallback).toLowerCase();
  return Object.values(BILLING_CLASS).includes(value) ? value : fallback;
}

// Each definition describes one route. `privacy` names the server-side flag
// that records a human review of the provider's API data-use terms; routes
// that lack it are never given private repository data.
export function modelPoolDefinitions(env = process.env, { openRouterCatalog = getOpenRouterCatalog() } = {}) {
  const defs = [
    {
      provider: 'anthropic', model: env.CODING_ANTHROPIC_MODEL || 'claude-opus-5', protocol: 'anthropic-messages',
      secretEnv: 'ANTHROPIC_API_KEY', secretRef: 'env://ANTHROPIC_API_KEY', qualityTier: 5, costTier: 4, contextWindow: 1_000_000,
      billingClass: billing(env, 'ANTHROPIC_BILLING_CLASS', 'paid'), privacyApproved: true, privacyNote: 'Existing production provider',
    },
    {
      provider: 'anthropic', model: env.CODING_ANTHROPIC_FALLBACK_MODEL || 'claude-sonnet-5', protocol: 'anthropic-messages',
      secretEnv: 'ANTHROPIC_API_KEY', secretRef: 'env://ANTHROPIC_API_KEY', qualityTier: 5, costTier: 3, contextWindow: 1_000_000,
      billingClass: billing(env, 'ANTHROPIC_BILLING_CLASS', 'paid'), privacyApproved: true, privacyNote: 'Existing production provider',
    },
    {
      provider: 'openai', model: env.CODING_OPENAI_MODEL || env.OPENAI_MODEL || 'gpt-5.3-codex', protocol: 'openai-responses',
      secretEnv: 'OPENAI_API_KEY', secretRef: 'env://OPENAI_API_KEY', qualityTier: 5, costTier: 4, contextWindow: 400_000,
      billingClass: billing(env, 'OPENAI_BILLING_CLASS', 'paid'), privacyApproved: true,
      pricing: readPricing(env, 'OPENAI_PRICING_JSON'), privacyNote: 'API data is not used for training by default',
    },
    {
      provider: 'deepseek', model: env.DEEPSEEK_MODEL || 'deepseek-flash', protocol: 'chat-completions',
      endpoint: 'https://api.deepseek.com/chat/completions', secretEnv: 'DEEPSEEK_API_KEY', secretRef: 'env://DEEPSEEK_API_KEY',
      qualityTier: 4, costTier: 1, contextWindow: 128_000, maxOutputTokens: Number(env.DEEPSEEK_MAX_OUTPUT_TOKENS || 8192),
      billingClass: billing(env, 'DEEPSEEK_BILLING_CLASS', 'paid'),
      privacyApproved: truthy(env.DEEPSEEK_API_TRAINING_OPTOUT_VERIFIED), privacyFlag: 'DEEPSEEK_API_TRAINING_OPTOUT_VERIFIED',
    },
    {
      provider: 'qwen', model: env.QWEN_MODEL || 'qwen3.8-flash', protocol: 'chat-completions',
      endpoint: env.QWEN_API_ENDPOINT || 'https://qwen.invalid/compatible-mode/v1/chat/completions',
      secretEnv: 'QWEN_API_KEY', secretRef: 'env://QWEN_API_KEY', qualityTier: 4, costTier: 2, contextWindow: 1_000_000,
      billingClass: billing(env, 'QWEN_BILLING_CLASS', 'paid'),
      privacyApproved: truthy(env.QWEN_API_PRIVATE_DATA_APPROVED), privacyFlag: 'QWEN_API_PRIVATE_DATA_APPROVED',
    },
    {
      provider: 'kimi', model: env.KIMI_MODEL || 'kimi-k2.7-code', protocol: 'chat-completions',
      endpoint: 'https://api.moonshot.ai/v1/chat/completions', maxTokensField: 'max_completion_tokens',
      secretEnv: 'KIMI_API_KEY', secretRef: 'env://KIMI_API_KEY', qualityTier: 5, costTier: 3, contextWindow: 262_144,
      billingClass: billing(env, 'KIMI_BILLING_CLASS', 'paid'),
      privacyApproved: truthy(env.KIMI_API_PRIVATE_DATA_APPROVED), privacyFlag: 'KIMI_API_PRIVATE_DATA_APPROVED',
    },
    {
      provider: 'zhipu', model: env.ZHIPU_MODEL || 'glm-5.3-flash', protocol: 'chat-completions',
      endpoint: 'https://api.z.ai/api/paas/v4/chat/completions', secretEnv: 'ZHIPU_API_KEY', secretRef: 'env://ZHIPU_API_KEY',
      qualityTier: 4, costTier: 1, contextWindow: 200_000, billingClass: billing(env, 'ZHIPU_BILLING_CLASS', 'paid'),
      privacyApproved: truthy(env.ZHIPU_API_PRIVATE_DATA_APPROVED), privacyFlag: 'ZHIPU_API_PRIVATE_DATA_APPROVED',
    },
    {
      // Z.ai lists its Flash models at $0 (rate-limited). Below the coding
      // floor: used for simple text jobs, never for autonomous coding.
      provider: 'zhipu', model: env.ZHIPU_FREE_MODEL || 'glm-4.7-flash', protocol: 'chat-completions',
      endpoint: 'https://api.z.ai/api/paas/v4/chat/completions', secretEnv: 'ZHIPU_API_KEY', secretRef: 'env://ZHIPU_API_KEY',
      qualityTier: 3, costTier: 1, contextWindow: 128_000, billingClass: billing(env, 'ZHIPU_FREE_BILLING_CLASS', 'free'),
      privacyApproved: truthy(env.ZHIPU_API_PRIVATE_DATA_APPROVED), privacyFlag: 'ZHIPU_API_PRIVATE_DATA_APPROVED',
    },
    {
      provider: 'minimax', model: env.MINIMAX_MODEL || 'MiniMax-M2.7', protocol: 'chat-completions',
      endpoint: 'https://api.minimax.io/v1/chat/completions', secretEnv: 'MINIMAX_API_KEY', secretRef: 'env://MINIMAX_API_KEY',
      qualityTier: 4, costTier: 1, contextWindow: 204_800, billingClass: billing(env, 'MINIMAX_BILLING_CLASS', 'paid'),
      // Written API data-use confirmation is still missing; a flag cannot override it.
      privacyApproved: false, privacyNote: 'Blocked for private data pending an API data-use policy review',
    },
    {
      // `gemini-flash-latest` is Google's documented alias for the current
      // Flash model, so the route survives model generations.
      provider: 'gemini', model: env.GEMINI_MODEL || 'gemini-flash-latest', protocol: 'gemini',
      secretEnv: 'GEMINI_API_KEY', secretRef: 'env://GEMINI_API_KEY', qualityTier: 4, costTier: 2, contextWindow: 1_000_000,
      billingClass: billing(env, 'GEMINI_BILLING_CLASS', 'free'), pricing: readPricing(env, 'GEMINI_PRICING_JSON'),
      // Free-tier Gemini API traffic may be used to improve Google products; private
      // data requires a reviewed paid project and this explicit flag.
      privacyApproved: truthy(env.GEMINI_API_PRIVATE_DATA_APPROVED), privacyFlag: 'GEMINI_API_PRIVATE_DATA_APPROVED',
    },
    // Static OpenRouter route: an explicitly configured OPENROUTER_MODEL, or the
    // default free model until the free-model catalog has been discovered.
    ...(openRouterCatalog?.admitted?.length && !env.OPENROUTER_MODEL ? [] : [{
      provider: 'openrouter', model: env.OPENROUTER_MODEL || 'openai/gpt-oss-120b:free', protocol: 'chat-completions',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions', secretEnv: 'OPENROUTER_API_KEY', secretRef: 'env://OPENROUTER_API_KEY',
      qualityTier: Number(env.OPENROUTER_QUALITY_TIER || 3), costTier: 1, contextWindow: Number(env.OPENROUTER_CONTEXT_WINDOW || 128_000),
      billingClass: billing(env, 'OPENROUTER_BILLING_CLASS', /:free$/.test(env.OPENROUTER_MODEL || 'openai/gpt-oss-120b:free') ? 'free' : 'paid'),
      pricing: readPricing(env, 'OPENROUTER_PRICING_JSON'),
      privacyApproved: /:free$/.test(env.OPENROUTER_MODEL || 'openai/gpt-oss-120b:free') ? false : truthy(env.OPENROUTER_API_PRIVATE_DATA_APPROVED),
      privacyFlag: 'OPENROUTER_API_PRIVATE_DATA_APPROVED',
      freeOnly: /:free$/.test(env.OPENROUTER_MODEL || 'openai/gpt-oss-120b:free'),
      catalogBlocked: catalogVerdict(openRouterCatalog, env.OPENROUTER_MODEL || 'openai/gpt-oss-120b:free'),
      extraHeaders: { 'x-title': 'Fahad AI Office' },
    }]),
    ...openRouterFreeRoutes(env, openRouterCatalog),
    {
      provider: 'groq', model: env.GROQ_MODEL || 'openai/gpt-oss-120b', protocol: 'chat-completions',
      endpoint: 'https://api.groq.com/openai/v1/chat/completions', secretEnv: 'GROQ_API_KEY', secretRef: 'env://GROQ_API_KEY',
      qualityTier: Number(env.GROQ_QUALITY_TIER || 3), costTier: 1, contextWindow: Number(env.GROQ_CONTEXT_WINDOW || 128_000),
      billingClass: billing(env, 'GROQ_BILLING_CLASS', 'free'), pricing: readPricing(env, 'GROQ_PRICING_JSON'),
      privacyApproved: truthy(env.GROQ_API_PRIVATE_DATA_APPROVED), privacyFlag: 'GROQ_API_PRIVATE_DATA_APPROVED',
    },
    {
      // GitHub Models (official inference API). Free, rate-limited, 8K input /
      // 4K output per request: suited to short Office jobs, not to coding.
      // Needs its own token (fine-grained PAT with "Models: read"); the Coding
      // Agent's repository token is never reused for inference.
      provider: 'github', model: env.GITHUB_MODELS_MODEL || 'openai/gpt-4.1', protocol: 'chat-completions',
      endpoint: 'https://models.github.ai/inference/chat/completions', secretEnv: 'GITHUB_MODELS_TOKEN', secretRef: 'env://GITHUB_MODELS_TOKEN',
      qualityTier: 4, costTier: 1, contextWindow: 8_000, maxOutputTokens: 4_000,
      billingClass: billing(env, 'GITHUB_MODELS_BILLING_CLASS', 'free'), pricing: readPricing(env, 'GITHUB_MODELS_PRICING_JSON'),
      privacyApproved: truthy(env.GITHUB_MODELS_PRIVATE_DATA_APPROVED), privacyFlag: 'GITHUB_MODELS_PRIVATE_DATA_APPROVED',
      extraHeaders: { 'x-github-api-version': '2022-11-28' },
    },
    {
      // Cerebras free tier: fast open-weight models, daily token allowance,
      // small free context window.
      provider: 'cerebras', model: env.CEREBRAS_MODEL || 'gpt-oss-120b', protocol: 'chat-completions',
      endpoint: 'https://api.cerebras.ai/v1/chat/completions', maxTokensField: 'max_completion_tokens',
      secretEnv: 'CEREBRAS_API_KEY', secretRef: 'env://CEREBRAS_API_KEY',
      qualityTier: Number(env.CEREBRAS_QUALITY_TIER || 3), costTier: 1, contextWindow: Number(env.CEREBRAS_CONTEXT_WINDOW || 8_192),
      billingClass: billing(env, 'CEREBRAS_BILLING_CLASS', 'free'), pricing: readPricing(env, 'CEREBRAS_PRICING_JSON'),
      privacyApproved: truthy(env.CEREBRAS_API_PRIVATE_DATA_APPROVED), privacyFlag: 'CEREBRAS_API_PRIVATE_DATA_APPROVED',
    },
    {
      // Mistral: free only on the Experiment plan (whose prompts may be used
      // for training). Treated as paid until the owner states the plan
      // (MISTRAL_BILLING_CLASS=free) or supplies MISTRAL_PRICING_JSON.
      provider: 'mistral', model: env.MISTRAL_MODEL || 'mistral-medium-latest', protocol: 'chat-completions',
      endpoint: 'https://api.mistral.ai/v1/chat/completions', secretEnv: 'MISTRAL_API_KEY', secretRef: 'env://MISTRAL_API_KEY',
      qualityTier: 4, costTier: 2, contextWindow: 128_000,
      billingClass: billing(env, 'MISTRAL_BILLING_CLASS', 'paid'), pricing: readPricing(env, 'MISTRAL_PRICING_JSON'),
      privacyApproved: truthy(env.MISTRAL_API_PRIVATE_DATA_APPROVED), privacyFlag: 'MISTRAL_API_PRIVATE_DATA_APPROVED',
    },
  ];
  return defs.map((definition) => {
    const route = { ...definition, id: `${definition.provider}:${definition.model}`, pricing: definition.pricing || PRICING[definition.model] || null, toolCalling: definition.toolCalling !== false };
    return Object.freeze({ ...route, capabilities: capabilityProfile(route, env) });
  });
}

// Why the discovered catalog rules out a statically configured OpenRouter
// model (null when it is fine or no catalog has been fetched yet).
function catalogVerdict(catalog, id) {
  if (!catalog?.models) return null;
  if (!/:free$/.test(id)) return null;
  const entry = catalog.models.find((model) => model.id === id);
  if (!entry) return 'NOT_IN_OPENROUTER_FREE_CATALOG';
  return entry.eligible ? null : String(entry.reasons[0] || 'NOT_ELIGIBLE').replace(/[^A-Z_]/g, '_').slice(0, 60);
}

// One OpenRouter key exposes many free models. Each admitted catalog model is
// its own route: FREE, free-only guarded, never approved for private data
// (OpenRouter free endpoints may log or train on prompts), capability-ranked.
function openRouterFreeRoutes(env, catalog) {
  if (!catalog?.models?.length) return [];
  const explicit = env.OPENROUTER_MODEL || null;
  return catalog.models.filter((entry) => entry.admitted && entry.id !== explicit).map((entry) => ({
    provider: 'openrouter', model: entry.id, protocol: 'chat-completions',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions', secretEnv: 'OPENROUTER_API_KEY', secretRef: 'env://OPENROUTER_API_KEY',
    qualityTier: Number(env.OPENROUTER_QUALITY_TIER || 3), costTier: 1, contextWindow: entry.contextLength,
    ...(entry.maxOutputTokens ? { maxOutputTokens: Math.min(entry.maxOutputTokens, 16_000) } : {}),
    billingClass: BILLING_CLASS.FREE, pricing: null, freeOnly: true, discovered: true,
    privacyApproved: false, privacyNote: 'OpenRouter free endpoints may log or train on prompts: public/non-private data only',
    extraHeaders: { 'x-title': 'Fahad AI Office' },
    catalogFlags: { structuredOutput: entry.structuredOutput, vision: entry.vision },
  }));
}

function credential(env, name) {
  const value = env[name];
  return typeof value === 'string' && value.trim().length >= 12 && !/PASTE_HERE|YOUR_.*KEY/i.test(value) ? value.trim() : null;
}

// Builds the executable pool. Unavailable routes are kept with an explicit
// reason so the dashboard can say why a provider is not being used.
export function createModelPool({ env = process.env, fetchFn = fetch, protocolFactory = defaultProtocolFactory, openRouterCatalog = getOpenRouterCatalog() } = {}) {
  return modelPoolDefinitions(env, { openRouterCatalog }).map((definition) => {
    const reasons = [];
    const apiKey = credential(env, definition.secretEnv);
    if (!definition.model) reasons.push('MODEL_NOT_CONFIGURED');
    if (!apiKey) reasons.push('CREDENTIAL_MISSING');
    if (definition.billingClass === BILLING_CLASS.PAID && !definition.pricing) reasons.push('PRICING_UNKNOWN');
    if (definition.endpoint && /\.invalid\//.test(definition.endpoint)) reasons.push('ENDPOINT_NOT_CONFIGURED');
    if (definition.catalogBlocked) reasons.push(`CATALOG_${definition.catalogBlocked}`);
    const protocol = reasons.length ? null : protocolFactory(definition, { apiKey, fetchFn, env });
    return Object.freeze({ ...definition, protocolClient: protocol, unavailableReasons: Object.freeze(reasons) });
  });
}

// Free routes get a shorter per-request timeout so one slow free model cannot
// hold an Office stage (or a canary) for ten minutes; a timeout is a network
// failure and the gateway fails over to the next eligible route.
export const FREE_ROUTE_TIMEOUT_MS = 150_000;

export function routeTimeoutMs(definition, env = {}) {
  if (definition.billingClass !== 'free' && !definition.freeOnly) return undefined;
  const configured = Number(env.FREE_ROUTE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 10_000 && configured <= 600_000 ? configured : FREE_ROUTE_TIMEOUT_MS;
}

export function defaultProtocolFactory(definition, { apiKey, fetchFn, env }) {
  const pricing = definition.pricing;
  const timeout = routeTimeoutMs(definition, env);
  const timeoutOption = timeout ? { timeoutMs: timeout } : {};
  if (definition.protocol === 'anthropic-messages') {
    return new AnthropicMessagesProtocol({ apiKey, pricing, effort: env.CODING_ANTHROPIC_EFFORT || 'high' });
  }
  if (definition.protocol === 'openai-responses') return new OpenAIResponsesProtocol({ apiKey, pricing, fetchFn, ...timeoutOption });
  if (definition.protocol === 'gemini') return new GeminiProtocol({ apiKey, pricing, fetchFn, ...timeoutOption });
  return new ChatCompletionsProtocol({
    apiKey, pricing, fetchFn, endpoint: definition.endpoint, ...timeoutOption,
    maxTokensField: definition.maxTokensField || 'max_tokens', extraHeaders: definition.extraHeaders || {},
    // Free-only routes ask OpenRouter for usage accounting and refuse any
    // response that reports a cost (see ChatCompletionsProtocol).
    ...(definition.freeOnly ? { freeOnly: true, extraBody: { usage: { include: true } } } : {}),
  });
}
