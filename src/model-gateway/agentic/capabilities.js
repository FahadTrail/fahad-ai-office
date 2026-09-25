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

// Keyed by model id (exact) or by a RegExp source matched against the model
// id. Order matters: the first match wins.
const REGISTRY = [
  ['claude-opus-5', { coding: 5, reasoning: 5, research: 5, writing: 5, speed: 2, vision: true, structuredOutput: true }],
  ['claude-sonnet-5', { coding: 5, reasoning: 5, research: 5, writing: 5, speed: 3, vision: true, structuredOutput: true }],
  ['gpt-5.3-codex', { coding: 5, reasoning: 5, research: 4, writing: 4, speed: 3, vision: true, structuredOutput: true }],
  ['deepseek-flash', { coding: 4, reasoning: 4, research: 4, writing: 4, speed: 4, vision: false, structuredOutput: true }],
  [/^qwen3(\.\d+)?-(flash|plus|max|coder)/, { coding: 4, reasoning: 4, research: 4, writing: 4, speed: 4, vision: false, structuredOutput: true }],
  [/^kimi-k2\.\d+-code/, { coding: 5, reasoning: 4, research: 4, writing: 4, speed: 3, vision: false, structuredOutput: true }],
  // Z.ai's free Flash models are fine for simple text work, below our coding floor.
  [/^glm-4\.\d+v?-flash/, { coding: 3, reasoning: 3, research: 3, writing: 3, speed: 4, vision: false, structuredOutput: true }],
  [/^glm-5(\.\d+)?/, { coding: 4, reasoning: 4, research: 4, writing: 4, speed: 4, vision: false, structuredOutput: true }],
  [/^MiniMax-M2/, { coding: 4, reasoning: 4, research: 4, writing: 4, speed: 4, vision: false, structuredOutput: true }],
  [/^gemini-.*flash-lite/, { coding: 3, reasoning: 3, research: 3, writing: 3, speed: 5, vision: true, structuredOutput: true }],
  [/^gemini-.*flash/, { coding: 4, reasoning: 4, research: 4, writing: 4, speed: 4, vision: true, structuredOutput: true }],
  [/^gemini-.*pro/, { coding: 5, reasoning: 5, research: 5, writing: 5, speed: 2, vision: true, structuredOutput: true }],
  // Open-weight models served by free/low-cost hosts (Groq, Cerebras, GitHub
  // Models, OpenRouter). Strong for text; not trusted with autonomous coding.
  [/(^|\/)(openai\/)?gpt-oss-120b/, { coding: 3, reasoning: 4, research: 3, writing: 3, speed: 5, vision: false, structuredOutput: true }],
  [/(^|\/)(openai\/)?gpt-oss-20b/, { coding: 2, reasoning: 3, research: 3, writing: 3, speed: 5, vision: false, structuredOutput: true }],
  [/llama-3\.3-70b|llama3\.3-70b/i, { coding: 3, reasoning: 3, research: 3, writing: 4, speed: 5, vision: false, structuredOutput: true }],
  [/llama-3\.1-8b|llama3\.1-8b/i, { coding: 2, reasoning: 2, research: 2, writing: 3, speed: 5, vision: false, structuredOutput: false }],
  [/qwen-?3-(coder|235b)/i, { coding: 4, reasoning: 4, research: 3, writing: 3, speed: 5, vision: false, structuredOutput: true }],
  [/mistral-large|magistral-medium/i, { coding: 4, reasoning: 4, research: 4, writing: 4, speed: 3, vision: false, structuredOutput: true }],
  [/codestral|devstral/i, { coding: 4, reasoning: 3, research: 3, writing: 3, speed: 4, vision: false, structuredOutput: true }],
  [/mistral-small|ministral/i, { coding: 3, reasoning: 3, research: 3, writing: 3, speed: 5, vision: false, structuredOutput: true }],
  [/(^|\/)gpt-4\.1(-mini)?$/, { coding: 4, reasoning: 3, research: 4, writing: 4, speed: 4, vision: true, structuredOutput: true }],
  // Common OpenRouter free (":free") models. Conservative: free OpenRouter
  // endpoints are never used for private code regardless of these scores.
  [/(^|\/)deepseek-(r1|v3|chat)/i, { coding: 4, reasoning: 4, research: 4, writing: 4, speed: 2, vision: false, structuredOutput: true }],
  [/(^|\/)kimi-k2/i, { coding: 4, reasoning: 4, research: 4, writing: 4, speed: 3, vision: false, structuredOutput: true }],
  [/(^|\/)qwen3?-?\d*.*coder/i, { coding: 4, reasoning: 3, research: 3, writing: 3, speed: 4, vision: false, structuredOutput: true }],
  [/(^|\/)qwen3/i, { coding: 3, reasoning: 4, research: 3, writing: 3, speed: 4, vision: false, structuredOutput: true }],
  [/(^|\/)glm-4\.\d+-air/i, { coding: 3, reasoning: 3, research: 3, writing: 3, speed: 4, vision: false, structuredOutput: true }],
  [/(^|\/)llama-4/i, { coding: 3, reasoning: 3, research: 3, writing: 4, speed: 4, vision: true, structuredOutput: true }],
  [/(^|\/)gemma-4/i, { coding: 3, reasoning: 3, research: 3, writing: 4, speed: 4, vision: true, structuredOutput: true }],
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
  profile.toolCalling = definition.toolCalling !== false && override?.toolCalling !== false;
  // Provider catalog flags (e.g. OpenRouter supported_parameters) fill in
  // what the registry does not know.
  const flags = definition.catalogFlags || {};
  profile.vision = typeof override?.vision === 'boolean' ? override.vision : known ? Boolean(known.vision) : Boolean(flags.vision);
  profile.structuredOutput = typeof override?.structuredOutput === 'boolean' ? override.structuredOutput : known ? Boolean(known.structuredOutput) : Boolean(flags.structuredOutput);
  profile.contextWindow = definition.contextWindow;
  profile.longContext = definition.contextWindow >= 200_000;
  profile.costClass = definition.billingClass === 'paid' ? ['low', 'low', 'medium', 'high', 'premium'][Math.max(0, Math.min(4, (definition.costTier || 1) - 1))] : definition.billingClass;
  profile.privacyClass = definition.privacyApproved ? 'private-data-approved' : 'public-data-only';
  profile.source = override ? 'owner override' : known ? 'registry' : 'route default';
  return Object.freeze(profile);
}

// What each kind of work needs. `min` scores are hard floors; `weights`
// rank eligible routes by fit. Office roles map onto these jobs.
export const JOB_PROFILES = Object.freeze({
  coding: { label: 'Autonomous coding', min: { coding: 4, reasoning: 4 }, toolCalling: true, minContext: 100_000, weights: { coding: 3, reasoning: 2 } },
  qa_security: { label: 'QA / security review', min: { coding: 4, reasoning: 4 }, toolCalling: true, minContext: 100_000, weights: { reasoning: 3, coding: 2 } },
  research: { label: 'Research & analysis', min: { research: 3, reasoning: 3 }, toolCalling: true, minContext: 32_000, weights: { research: 3, reasoning: 2, writing: 1 } },
  finance: { label: 'Finance & numbers', min: { reasoning: 4 }, structuredOutput: true, minContext: 32_000, weights: { reasoning: 3, research: 1 } },
  content: { label: 'Content writing', min: { writing: 3 }, minContext: 16_000, weights: { writing: 3, research: 1 } },
  branding: { label: 'Branding', min: { writing: 3, reasoning: 3 }, minContext: 16_000, weights: { writing: 3, reasoning: 1 } },
  seo: { label: 'SEO', min: { research: 3, writing: 3 }, minContext: 16_000, weights: { research: 2, writing: 2 } },
  classification: { label: 'Classification / routing', min: { reasoning: 2 }, structuredOutput: true, minContext: 8_000, weights: { speed: 2, reasoning: 1 } },
});

export function jobProfile(job) {
  if (!job) return null;
  if (typeof job === 'object') return job;
  return JOB_PROFILES[job] || null;
}

// Reasons this route cannot do the job ([] when it can).
export function capabilityGaps(capabilities, job) {
  const profile = jobProfile(job);
  if (!profile || !capabilities) return [];
  const gaps = [];
  for (const [score, minimum] of Object.entries(profile.min || {})) {
    if ((capabilities[score] || 0) < minimum) gaps.push(`CAPABILITY_${score.toUpperCase()}_BELOW_${minimum}`);
  }
  if (profile.toolCalling && !capabilities.toolCalling) gaps.push('TOOL_CALLING_REQUIRED');
  if (profile.structuredOutput && !capabilities.structuredOutput) gaps.push('STRUCTURED_OUTPUT_REQUIRED');
  if (profile.vision && !capabilities.vision) gaps.push('VISION_REQUIRED');
  if (profile.minContext && capabilities.contextWindow < profile.minContext) gaps.push('CONTEXT_WINDOW_TOO_SMALL');
  return gaps;
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
