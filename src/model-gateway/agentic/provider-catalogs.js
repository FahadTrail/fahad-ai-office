// Provider model catalogs, read at runtime from each provider's own
// model-list API with the credential the runtime already holds. They answer
// one question for routing: "does this provider still serve this model id?"
// A route whose model disappeared or was renamed is ruled out
// (MODEL_NOT_IN_PROVIDER_CATALOG) instead of being called, and never replaced
// by a guessed model. Only model ids (and published context sizes) are kept;
// credentials and provider text never leave this module.

const CATALOGS = new Map();

// Chat-capable ids only: audio, speech, guard/safety classifiers, embeddings
// and image models are not Office/Coding routes.
const NON_CHAT = /whisper|orpheus|tts|speech|audio|prompt-guard|safeguard|guard|embed|embedding|moderation|image|imagen|veo|vision-only|rerank|ocr/i;

export const PROVIDER_CATALOG_SOURCES = Object.freeze({
  groq: { url: 'https://api.groq.com/openai/v1/models', secretEnv: 'GROQ_API_KEY', auth: 'bearer' },
  cerebras: { url: 'https://api.cerebras.ai/v1/models', secretEnv: 'CEREBRAS_API_KEY', auth: 'bearer' },
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', secretEnv: 'GEMINI_API_KEY', auth: 'goog' },
  mistral: { url: 'https://api.mistral.ai/v1/models', secretEnv: 'MISTRAL_API_KEY', auth: 'bearer' },
  kimi: { url: 'https://api.moonshot.ai/v1/models', secretEnv: 'KIMI_API_KEY', auth: 'bearer' },
  qwen: { url: null, secretEnv: 'QWEN_API_KEY', auth: 'bearer' },
});

// Only these providers' lists are complete enough to rule a configured
// model out. Gemini aliases (…-latest) and Qwen/Kimi lists are shown for
// diagnosis but never block a route.
const AUTHORITATIVE = new Set(['groq', 'cerebras', 'mistral']);

export function getProviderCatalog(provider) {
  const entry = CATALOGS.get(provider);
  if (!entry || !AUTHORITATIVE.has(provider)) return null;
  return entry.ok ? entry : null;
}

export function providerCatalogSnapshot() {
  return Object.fromEntries([...CATALOGS].map(([provider, entry]) => [provider, {
    ok: entry.ok, status: entry.status, fetchedAt: entry.fetchedAt, count: entry.models?.length || 0,
    models: (entry.models || []).slice(0, 80), contexts: entry.contexts || {}, authoritative: AUTHORITATIVE.has(provider), reason: entry.reason || null,
  }]));
}

export function setProviderCatalog(provider, entry) {
  if (entry === null) CATALOGS.delete(provider);
  else CATALOGS.set(provider, entry);
}

function qwenModelsUrl(env) {
  const chat = env.QWEN_API_ENDPOINT || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';
  return chat.replace(/\/chat\/completions$/, '/models');
}

function credential(env, name) {
  const value = env[name];
  return typeof value === 'string' && value.trim().length >= 12 ? value.trim() : null;
}

// Parses the provider's list into chat model ids (+ context when published).
export function parseCatalog(provider, body) {
  const contexts = {};
  let ids = [];
  if (provider === 'gemini') {
    for (const model of body?.models || []) {
      if (!(model.supportedGenerationMethods || []).includes('generateContent')) continue;
      const id = String(model.name || '').replace(/^models\//, '');
      if (!id || NON_CHAT.test(id)) continue;
      ids.push(id);
      if (Number(model.inputTokenLimit) > 0) contexts[id] = Number(model.inputTokenLimit);
    }
  } else {
    for (const model of body?.data || []) {
      const id = String(model.id || '');
      if (!id || NON_CHAT.test(id) || model.active === false) continue;
      ids.push(id);
      const context = Number(model.context_window || model.context_length || model.max_context_length);
      if (context > 0) contexts[id] = context;
    }
  }
  ids = [...new Set(ids.filter((id) => /^[A-Za-z0-9._/:-]{2,160}$/.test(id)))].sort();
  return { models: ids, contexts };
}

export async function fetchProviderCatalog(provider, { env = process.env, fetchFn = fetch, timeoutMs = 15_000, now = () => Date.now() } = {}) {
  const source = PROVIDER_CATALOG_SOURCES[provider];
  if (!source) return null;
  const key = credential(env, source.secretEnv);
  if (!key) return { ok: false, status: null, reason: 'CREDENTIAL_MISSING', fetchedAt: new Date(now()).toISOString(), models: [] };
  const url = provider === 'qwen' ? qwenModelsUrl(env) : source.url;
  const headers = source.auth === 'goog' ? { 'x-goog-api-key': key } : { authorization: `Bearer ${key}` };
  try {
    const response = await fetchFn(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    let body = {};
    try { body = await response.json(); } catch {}
    if (!response.ok) {
      // Only a machine-readable provider error code is kept (e.g.
      // "AccessDenied.Unpurchased"), never the message.
      const code = [body?.error?.code, body?.code, body?.error?.status].find((value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{1,60}$/.test(value)) || null;
      return { ok: false, status: response.status, reason: code, fetchedAt: new Date(now()).toISOString(), models: [] };
    }
    return { ok: true, status: response.status, fetchedAt: new Date(now()).toISOString(), ...parseCatalog(provider, body) };
  } catch (error) {
    return { ok: false, status: null, reason: String(error?.name || 'NETWORK').replace(/[^A-Za-z]/g, '').slice(0, 40) || 'NETWORK', fetchedAt: new Date(now()).toISOString(), models: [] };
  }
}

// Refreshes every provider whose credential is present. A failed fetch keeps
// the previous good list so a provider blip never removes routes.
export async function refreshProviderCatalogs({ env = process.env, fetchFn = fetch, log = () => {} } = {}) {
  const results = {};
  for (const provider of Object.keys(PROVIDER_CATALOG_SOURCES)) {
    const entry = await fetchProviderCatalog(provider, { env, fetchFn });
    if (!entry) continue;
    results[provider] = { ok: entry.ok, status: entry.status, count: entry.models.length, reason: entry.reason || null };
    const previous = CATALOGS.get(provider);
    if (entry.ok || !previous?.ok) CATALOGS.set(provider, entry);
  }
  log('Provider catalogs refreshed:', JSON.stringify(results));
  return results;
}
