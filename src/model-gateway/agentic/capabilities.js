// Provider-neutral model capability registry and job profiles.
//
// The router picks a model for a JOB (coding, research, content, …), not for
// a provider. Each route carries a capability profile; each job states the
// minimum profile it needs. A route that is free but not capable enough for
// the job is ineligible for it, so price never outranks competence.
//
// Scores are 1–5 planning estimates from the provider's own model
// documentation and our live sessions; they are not benchmarks. A model that
// is not listed inherits its route's qualityTier for every score and is
// labelled `source: 'route default'` so the dashboard never overstates it.

export const CAPABILITY_SCORES = Object.freeze(['coding', 'reasoning', 'research', 'writing', 'speed']);
export const CAPABILITY_FLAGS = Object.freeze(['toolCalling', 'vision', 'structuredOutput']);

// Writing quality in Arabic (1–5), used when Fahad writes Arabic. Planning
// estimates from provider documentation and live Office answers (a small
// model produced broken Gulf Arabic on 2026-09-27). Unknown models default
// to at most 3 so they never outrank a known strong Arabic writer.
export const ARABIC_MIN = 3;

// Keyed by model id (exact) or by a RegExp source matched against the model
// id. Order matters: the first match wins.
const REGISTRY = [
  ['claude-opus-5', { coding: 5, reasoning: 5, research: 5, writing: 5, speed: 2, vision: true, structuredOutput: true , arabic: 5 }],
  ['claude-sonnet-5', { coding: 5, reasoning: 5, research: 5, writing: 5, speed: 3, vision: true, structuredOutput: true , arabic: 5 }],
  ['gpt-5.3-codex', { coding: 5, reasoning: 5, research: 4, writing: 4, speed: 3, vision: true, structuredOutput: true , arabic: 5 }],
  ['deepseek-flash', { coding: 4, reasoning: 4, research: 4, writing: 4, speed: 4, vision: false, structuredOutput: true , arabic: 4 }],
  [/^qwen3(\.\d+)?-(flash|plus|max|coder)/, { coding: 4, reasoning: 4, research: 4, writing: 4, speed: 4, vision: false, structuredOutput: true , arabic: 4 }],
  [/^kimi-k2\.\d+-code/, { coding: 5, reasoning: 4, research: 4, writing: 4, speed: 3, vision: false, structuredOutput: true , arabic: 3 }],
  // Z.ai's free Flash models are fine for simple text work, below our coding floor.
  [/^glm-4\.\d+v?-flash/, { coding: 3, reasoning: 3, research: 3, writing: 3, speed: 4, vision: false, structuredOutput: true , arabic: 3 }],
  [/^glm-5(\.\d+)?/, { coding: 4, reasoning: 4, research: 4, writing: 4, speed: 4, vision: false, structuredOutput: true , arabic: 4 }],
  [/^MiniMax-M2/, { coding: 4, reasoning: 4, research: 4, writing: 4, speed: 4, vision: false, structuredOutput: true , arabic: 3 }],
  [/^gemini-.*flash-lite/, { coding: 3, reasoning: 3, research: 3, writing: 3, speed: 5, vision: true, structuredOutput: true , arabic: 4 }],
  [/^gemini-.*flash/, { coding: 4, reasoning: 4, research: 4, writing: 4, speed: 4, vision: true, structuredOutput: true , arabic: 5 }],
  [/^gemini-.*pro/, { coding: 5, reasoning: 5, research: 5, writing: 5, speed: 2, vision: true, structuredOutput: true , arabic: 5 }],
  // Open-weight models served by free/low-cost hosts (Groq, Cerebras, GitHub
  // Models, OpenRouter). Strong for text; not trusted with autonomous coding.
  // Qwen 3.8 27B (Groq free plan, Cerebras trial): strong reasoning for its size.
  [/qwen-?3\.8-27b/i, { coding: 3, reasoning: 4, research: 3, writing: 3, speed: 5, vision: false, structuredOutput: true , arabic: 2 }],
  // Capacity V2 routes (planning estimates; qualification corrects them).
  [/gpt-oss:120b/, { coding: 3, reasoning: 4, research: 3, writing: 3, speed: 4, vision: false, structuredOutput: true , arabic: 3 }],
  [/qwen2\.5-coder-32b/i, { coding: 4, reasoning: 3, research: 3, writing: 3, speed: 4, vision: false, structuredOutput: true }],
  [/^big-pickle$|^space-bunny/i, { coding: 3, reasoning: 3, research: 3, writing: 3, speed: 4, vision: false, structuredOutput: false }],
  [/longcat-2\.5/i, { coding: 3, reasoning: 4, research: 3, writing: 3, speed: 4, vision: false, structuredOutput: true }],
  [/mimo-v2\.\d+/i, { coding: 3, reasoning: 3, research: 3, writing: 3, speed: 4, vision: false, structuredOutput: false }],
  [/(^|\/)(openai\/)?gpt-oss-120b/, { coding: 3, reasoning: 4, research: 3, writing: 3, speed: 5, vision: false, structuredOutput: true , arabic: 3 }],
  [/(^|\/)(openai\/)?gpt-oss-20b/, { coding: 2, reasoning: 3, research: 3, writing: 3, speed: 5, vision: false, structuredOutput: true , arabic: 2 }],
  [/llama-3\.3-70b|llama3\.3-70b/i, { coding: 3, reasoning: 3, research: 3, writing: 4, speed: 5, vision: false, structuredOutput: true , arabic: 3 }],
  [/llama-3\.1-8b|llama3\.1-8b/i, { coding: 2, reasoning: 2, research: 2, writing: 3, speed: 5, vision: false, structuredOutput: false , arabic: 2 }],
  [/qwen-?3-(coder|235b)/i, { coding: 4, reasoning: 4, research: 3, writing: 3, speed: 5, vision: false, structuredOutput: true }],
  // Mistral Medium (La Plateforme default route): planning estimate; qualification corrects it.
  [/mistral-medium/i, { coding: 4, reasoning: 4, research: 4, writing: 4, speed: 4, vision: true, structuredOutput: true , arabic: 4 }],
  [/mistral-large|magistral-medium/i, { coding: 4, reasoning: 4, research: 4, writing: 4, speed: 3, vision: false, structuredOutput: true , arabic: 4 }],
  [/codestral|devstral/i, { coding: 4, reasoning: 3, research: 3, writing: 3, speed: 4, vision: false, structuredOutput: true }],
  [/mistral-small|ministral/i, { coding: 3, reasoning: 3, research: 3, writing: 3, speed: 5, vision: false, structuredOutput: true , arabic: 3 }],
  [/(^|\/)gpt-4\.1(-mini)?$/, { coding: 4, reasoning: 3, research: 4, writing: 4, speed: 4, vision: true, structuredOutput: true , arabic: 4 }],
  // Common OpenRouter free (":free") models. Conservative: free OpenRouter
  // endpoints are never used for private code regardless of these scores.
  [/(^|\/)deepseek-(r1|v3|chat)/i, { coding: 4, reasoning: 4, research: 4, writing: 4, speed: 2, vision: false, structuredOutput: true , arabic: 4 }],
  [/(^|\/)kimi-k2/i, { coding: 4, reasoning: 4, research: 4, writing: 4, speed: 3, vision: false, structuredOutput: true }],
  [/(^|\/)qwen3?-?\d*.*coder/i, { coding: 4, reasoning: 3, research: 3, writing: 3, speed: 4, vision: false, structuredOutput: true }],
  [/(^|\/)qwen3/i, { coding: 3, reasoning: 4, research: 3, writing: 3, speed: 4, vision: false, structuredOutput: true }],
  [/(^|\/)glm-4\.\d+-air/i, { coding: 3, reasoning: 3, research: 3, writing: 3, speed: 4, vision: false, structuredOutput: true }],
  [/(^|\/)llama-4/i, { coding: 3, reasoning: 3, research: 3, writing: 4, speed: 4, vision: true, structuredOutput: true }],
  [/(^|\/)gemma-4/i, { coding: 3, reasoning: 3, research: 3, writing: 4, speed: 4, vision: true, structuredOutput: true , arabic: 4 }],
  [/(^|\/)gemma/i, { coding: 2, reasoning: 3, research: 3, writing: 3, speed: 4, vision: true, structuredOutput: false }],
  // Seen in OpenRouter's free catalog (2026-09). Small, safety-only and
  // domain-specialised variants score lower for general Office work.
  [/nemotron.*(safety|guard)/i, { coding: 1, reasoning: 2, research: 1, writing: 1, speed: 5, vision: false, structuredOutput: false }],
  [/nemotron.*nano/i, { coding: 2, reasoning: 3, research: 2, writing: 2, speed: 5, vision: true, structuredOutput: false }],
  [/nemotron-3-ultra/i, { coding: 4, reasoning: 4, research: 4, writing: 4, speed: 2, vision: false, structuredOutput: true }],
  [/nemotron-3-super/i, { coding: 3, reasoning: 4, research: 4, writing: 3, speed: 3, vision: false, structuredOutput: true }],
  [/nemotron/i, { coding: 3, reasoning: 3, research: 3, writing: 3, speed: 4, vision: false, structuredOutput: true }],
  [/ling-[\d.]+-flash-(sante|fin)/i, { coding: 2, reasoning: 3, research: 2, writing: 3, speed: 4, vision: false, structuredOutput: false }],
  [/lfm-[\d.]+-[\d.]+b/i, { coding: 1, reasoning: 2, research: 2, writing: 2, speed: 5, vision: false, structuredOutput: true }],
  [/inkling-small/i, { coding: 2, reasoning: 3, research: 3, writing: 3, speed: 4, vision: false, structuredOutput: false }],
  [/(north-mini-code|laguna-xs)/i, { coding: 3, reasoning: 2, research: 2, writing: 2, speed: 4, vision: false, structuredOutput: false }],
  [/laguna-s/i, { coding: 3, reasoning: 3, research: 2, writing: 2, speed: 4, vision: false, structuredOutput: false }],
];

function lookup(model) {
  const id = String(model || '');
  for (const [key, profile] of REGISTRY) {
    if (typeof key === 'string' ? key === id : key.test(id)) return profile;
  }
  return null;
}

// Owner overrides: MODEL_CAPABILITIES_JSON={"model-id":{"coding":4,...}}.
function overrides(env) {
  try {
    const parsed = JSON.parse(env.MODEL_CAPABILITIES_JSON || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const clampScore = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.min(5, Math.round(number))) : fallback;
};

export function capabilityProfile(definition, env = {}) {
  const known = lookup(definition.model);
  const override = overrides(env)[definition.model] || null;
  const base = definition.qualityTier || 3;
  const profile = {};
  for (const score of CAPABILITY_SCORES) {
    profile[score] = clampScore(override?.[score], clampScore(known?.[score], score === 'speed' ? 3 : base));
  }
  profile.arabic = clampScore(override?.arabic, clampScore(known?.arabic, Math.min(profile.writing, 3)));
  profile.toolCalling = definition.toolCalling !== false && override?.toolCalling !== false;
  // Provider catalog flags (e.g. OpenRouter supported_parameters) fill in
  // what the registry does not know.
  const flags = definition.catalogFlags || {};
  profile.vision = typeof override?.vision === 'boolean' ? override.vision : known ? Boolean(known.vision) : Boolean(flags.vision);
  profile.structuredOutput = typeof override?.structuredOutput === 'boolean' ? override.structuredOutput : known ? Boolean(known.structuredOutput) : Boolean(flags.structuredOutput);
  // The context window is the MODEL's window. A provider's tokens-per-minute
  // limit (Groq free: 8K TPM) is a RATE, not a window: it is kept apart and
  // checked per request by the gateway (REQUEST_ABOVE_FREE_TIER_LIMIT).
  const requestLimit = Number(definition.requestTokenLimit);
  profile.modelContextWindow = definition.contextWindow;
  profile.contextWindow = definition.contextWindow;
  profile.tokensPerMinute = Number.isFinite(requestLimit) && requestLimit > 0 ? requestLimit : null;
  profile.longContext = profile.contextWindow >= 200_000;
  profile.costClass = definition.billingClass === 'paid' ? ['low', 'low', 'medium', 'high', 'premium'][Math.max(0, Math.min(4, (definition.costTier || 1) - 1))] : definition.billingClass;
  profile.privacyClass = definition.privacyApproved ? 'private-data-approved' : 'public-data-only';
  profile.source = override ? 'owner override' : known ? 'registry' : 'route default';
  return Object.freeze(profile);
}

// What each kind of work needs. `min` scores are hard floors; `weights`
// rank eligible routes by fit. Office roles map onto these jobs.
// `minContext` is a planning default. When the request size is known the
// gateway requires the ACTUAL request (input + output) plus a safety margin
// instead — except for `growingContext` jobs, whose transcript keeps growing
// during a session (autonomous coding), where the fixed floor stays.
// `strictEvidence`: qualification evidence may never raise a score for this
// job (high-stakes work keeps its documented floor).
export const JOB_PROFILES = Object.freeze({
  coding: { label: 'Autonomous coding', min: { coding: 4, reasoning: 4 }, toolCalling: true, minContext: 100_000, growingContext: true, strictEvidence: true, weights: { coding: 3, reasoning: 2 } },
  qa_security: { label: 'QA / security review', min: { coding: 4, reasoning: 4 }, toolCalling: true, minContext: 100_000, growingContext: true, strictEvidence: true, weights: { reasoning: 3, coding: 2 } },
  research: { label: 'Research & analysis', min: { research: 3, reasoning: 3 }, toolCalling: true, minContext: 32_000, weights: { research: 3, reasoning: 2, writing: 1 } },
  // FINANCE after V4.1: arithmetic is deterministic code (office/finance.js)
  // and every figure is validated before use, so routine interpretation
  // (cost model, P&L, break-even, scenarios) needs a solid, qualified model,
  // not the strongest one. High-risk financial judgment keeps the top floor.
  finance: { label: 'Finance interpretation (arithmetic by code)', min: { reasoning: 3 }, structuredOutput: true, minContext: 16_000, weights: { reasoning: 3, research: 1 } },
  finance_critical: { label: 'High-risk financial judgment', min: { reasoning: 4, writing: 4 }, structuredOutput: true, minContext: 32_000, strictEvidence: true, weights: { reasoning: 3, writing: 1 } },
  content: { label: 'Content writing', min: { writing: 3 }, minContext: 16_000, weights: { writing: 3, research: 1 } },
  branding: { label: 'Branding', min: { writing: 3, reasoning: 3 }, minContext: 16_000, weights: { writing: 3, reasoning: 1 } },
  seo: { label: 'SEO', min: { research: 3, writing: 3 }, minContext: 16_000, weights: { research: 2, writing: 2 } },
  classification: { label: 'Classification / routing', min: { reasoning: 2 }, structuredOutput: true, minContext: 8_000, weights: { speed: 2, reasoning: 1 } },
  // Chief of Staff. Simple orchestration (classify, choose agent, write the
  // handoff) can run on capable free models; high-stakes synthesis (final
  // review, critical decisions) needs stronger reasoning and writing and
  // escalates automatically when no free model qualifies.
  orchestration: { label: 'Chief orchestration', min: { reasoning: 3, writing: 3 }, minContext: 8_000, weights: { reasoning: 2, writing: 1, speed: 1 } },
  synthesis: { label: 'High-stakes synthesis / final review', min: { reasoning: 4, writing: 4 }, minContext: 32_000, strictEvidence: true, weights: { reasoning: 3, writing: 2 } },
});

// Low-risk jobs that may drop one capability level when every normal route
// is unavailable (instead of waiting). Legal, security, finance, synthesis
// and orchestration (CHIEF and AUDIT) are never relaxed.
export const TOLERANT_JOBS = Object.freeze(new Set(['content', 'branding', 'seo', 'classification']));
export function relaxedJob(job) {
  const name = typeof job === 'string' ? job : null;
  if (!name || !TOLERANT_JOBS.has(name)) return null;
  const base = JOB_PROFILES[name];
  return Object.freeze({ ...base, name: `${name}:relaxed`, baseJob: name, label: `${base.label} (lower tier)`,
    min: Object.fromEntries(Object.entries(base.min || {}).map(([score, value]) => [score, Math.max(2, value - 1)])) });
}

// High-risk financial work: investment, valuation, funding, debt, tax or an
// explicit [critical] marker. Everything else is routine interpretation of
// numbers the finance engine calculates.
const FINANCE_CRITICAL = /\[critical\]|\b(invest(ment|or)?s?|valuation|fund ?rais|equity|cap table|acquisition|merger|loan|debt|tax(es|ation)?|vat|ipo|due diligence|bankrupt|insolven)\b|استثمار|تقييم|قرض|ديون|ضريب|استحواذ|تمويل/i;
export function financeJob(text) {
  return FINANCE_CRITICAL.test(String(text || '')) ? 'finance_critical' : 'finance';
}

export function jobProfile(job) {
  if (!job) return null;
  if (typeof job === 'object') return job;
  if (JOB_PROFILES[job]) return JOB_PROFILES[job];
  if (typeof job === 'string' && job.endsWith(':relaxed')) return relaxedJob(job.slice(0, -':relaxed'.length));
  return null;
}

// Name of the job family ("content:relaxed" → "content").
export function baseJobName(job) {
  if (!job) return null;
  if (typeof job === 'object') return job.baseJob || job.name || null;
  return String(job).replace(/:relaxed$/, '');
}

export const CONTEXT_MARGIN = 1.25;
export const CONTEXT_FLOOR = 8_000;

// Context the request really needs: input + output with a safety margin.
export function requiredContext(estimatedInputTokens, outputTokens) {
  const need = Number(estimatedInputTokens || 0) + Number(outputTokens || 0);
  return need > 0 ? Math.max(CONTEXT_FLOOR, Math.ceil(need * CONTEXT_MARGIN)) : null;
}

// Reasons this route cannot do the job ([] when it can). With `needContext`
// (the actual request size), a non-growing job needs only that much window.
export function capabilityGaps(capabilities, job, { needContext = null } = {}) {
  const profile = jobProfile(job);
  if (!profile || !capabilities) return [];
  const gaps = [];
  for (const [score, minimum] of Object.entries(profile.min || {})) {
    if ((capabilities[score] || 0) < minimum) gaps.push(`CAPABILITY_${score.toUpperCase()}_BELOW_${minimum}`);
  }
  if (profile.toolCalling && !capabilities.toolCalling) gaps.push('TOOL_CALLING_REQUIRED');
  if (profile.structuredOutput && !capabilities.structuredOutput) gaps.push('STRUCTURED_OUTPUT_REQUIRED');
  if (profile.vision && !capabilities.vision) gaps.push('VISION_REQUIRED');
  const floor = profile.growingContext || !needContext ? Math.max(profile.minContext || 0, needContext || 0) : needContext;
  if (floor && capabilities.contextWindow < floor) gaps.push('CONTEXT_WINDOW_TOO_SMALL');
  return gaps;
}

// Output language: Arabic needs a model that writes Arabic well.
export function languageGaps(capabilities, language) {
  if (language !== 'ar' || !capabilities) return [];
  return (capabilities.arabic || 0) < ARABIC_MIN ? [`CAPABILITY_ARABIC_BELOW_${ARABIC_MIN}`] : [];
}

// Bonus added to job fit when the answer is in Arabic (0 for other languages).
export function languageFit(route, language) {
  if (language !== 'ar' || !route.capabilities) return 0;
  return ((route.capabilities.arabic || 0) - ARABIC_MIN) * 0.75;
}

// Weighted fit on the 1–5 scale; used to rank routes within a billing class.
export function jobFit(route, job) {
  const profile = jobProfile(job);
  const capabilities = route.capabilities;
  if (!profile || !capabilities) return route.qualityTier || 0;
  const weights = Object.entries(profile.weights || {});
  if (!weights.length) return route.qualityTier || 0;
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  return weights.reduce((sum, [score, weight]) => sum + (capabilities[score] || 0) * weight, 0) / total;
}

// Orders discovered free models for admission: best average Office-job fit
// first (research, content, reasoning), then the larger context window.
export function rankFreeModels(left, right, env = {}) {
  const score = (entry) => {
    const profile = capabilityProfile({ model: entry.id, qualityTier: Number(env.OPENROUTER_QUALITY_TIER || 3), contextWindow: entry.contextLength, billingClass: 'free', catalogFlags: entry }, env);
    return profile.research + profile.reasoning + profile.writing + profile.coding * 0.5;
  };
  return score(right) - score(left) || right.contextLength - left.contextLength || left.id.localeCompare(right.id);
}
