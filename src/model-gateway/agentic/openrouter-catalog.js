// OpenRouter free-model discovery. One OpenRouter key exposes many models;
// the free ones change often, so they are discovered from OpenRouter's own
// API instead of being hard-coded.
//
// Admission rules (all must hold; anything else is listed as "not admitted"
// with the reason, never silently used):
//   * the id ends with ":free" (OpenRouter's free variant; it never bills);
//   * every published price field is exactly zero;
//   * the model supports tool calling (all agentic jobs send tools);
//   * the context window is at least MIN_CONTEXT tokens;
//   * when the key-scoped list (/models/user, filtered by the account's
//     provider and privacy settings) is available, the model is in it.
// Admitted routes are FREE, never approved for private data (OpenRouter free
// endpoints may log or train on prompts), and are ranked by the capability
// registry so only suitable jobs reach them.

const API = 'https://openrouter.ai/api/v1';
export const MIN_CONTEXT = 16_000;
export const DEFAULT_MAX_ADMITTED = 8;

let cache = null;

export function getOpenRouterCatalog() {
  return cache;
}

export function setOpenRouterCatalog(catalog) {
  cache = catalog || null;
  return cache;
}

const isZero = (value) => value === undefined || value === null || value === '' || Number(value) === 0;

export function freeModelVerdict(model, { accessibleIds = null } = {}) {
  const id = String(model?.id || '');
  const pricing = model?.pricing || {};
  const reasons = [];
  if (!id.endsWith(':free')) reasons.push('NOT_A_FREE_VARIANT');
  const priced = Object.entries(pricing).filter(([, value]) => !isZero(value)).map(([key]) => key);
  if (priced.length) reasons.push(`NON_ZERO_PRICE:${priced.join('+')}`);
  const parameters = Array.isArray(model?.supported_parameters) ? model.supported_parameters : [];
  if (!parameters.includes('tools')) reasons.push('NO_TOOL_CALLING');
  const context = Number(model?.context_length || model?.top_provider?.context_length || 0);
  if (context < MIN_CONTEXT) reasons.push('CONTEXT_TOO_SMALL');
  if (accessibleIds && !accessibleIds.has(id)) reasons.push('BLOCKED_BY_ACCOUNT_PRIVACY_OR_PROVIDER_SETTINGS');
  return reasons;
}

// Fetches the public catalog and, with a key, the key-scoped list. Returns a
// summary safe to store and show (ids, context, flags, verdicts; no secrets).
export async function fetchOpenRouterCatalog({ apiKey = null, fetchFn = fetch, timeoutMs = 15_000, now = () => Date.now(), maxAdmitted = DEFAULT_MAX_ADMITTED, rank = null } = {}) {
  const get = async (path, auth) => {
    const response = await fetchFn(`${API}${path}`, {
      method: 'GET',
      headers: { accept: 'application/json', ...(auth && apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw Object.assign(new Error(`OpenRouter catalog request failed (HTTP ${response.status})`), { status: response.status });
    const body = await response.json();
    return Array.isArray(body?.data) ? body.data : [];
  };
  const all = await get('/models', false);
  let accessibleIds = null;
  let accessError = null;
  if (apiKey) {
    try {
      accessibleIds = new Set((await get('/models/user', true)).map((model) => String(model.id)));
    } catch (error) {
      accessError = `HTTP_${error.status || 'ERROR'}`;
    }
  }
  const free = all.filter((model) => String(model.id || '').endsWith(':free'));
  const entries = free.map((model) => {
    const reasons = freeModelVerdict(model, { accessibleIds });
    return {
      id: String(model.id).slice(0, 120),
      name: String(model.name || '').slice(0, 120),
      contextLength: Number(model.context_length || 0),
      maxOutputTokens: Number(model.top_provider?.max_completion_tokens || 0) || null,
      tools: Array.isArray(model.supported_parameters) && model.supported_parameters.includes('tools'),
      structuredOutput: Array.isArray(model.supported_parameters) && (model.supported_parameters.includes('structured_outputs') || model.supported_parameters.includes('response_format')),
      vision: Array.isArray(model.architecture?.input_modalities) && model.architecture.input_modalities.includes('image'),
      eligible: reasons.length === 0,
      reasons,
    };
  });
  const eligible = entries.filter((entry) => entry.eligible);
  const ranked = rank ? eligible.toSorted(rank) : eligible.toSorted((left, right) => right.contextLength - left.contextLength);
  const admitted = new Set(ranked.slice(0, maxAdmitted).map((entry) => entry.id));
  for (const entry of entries) {
    entry.admitted = admitted.has(entry.id);
    if (entry.eligible && !entry.admitted) entry.reasons = ['ADMISSION_LIMIT'];
  }
  return {
    fetchedAt: new Date(now()).toISOString(),
    source: accessibleIds ? 'openrouter /models + key-scoped /models/user' : 'openrouter /models (public)',
    keyScopedList: accessibleIds ? 'available' : (apiKey ? `unavailable (${accessError})` : 'no key'),
    totalModels: all.length,
    freeModels: entries.length,
    accessibleFreeModels: accessibleIds ? entries.filter((entry) => accessibleIds.has(entry.id)).length : null,
    admitted: entries.filter((entry) => entry.admitted).map((entry) => entry.id),
    models: entries.toSorted((left, right) => Number(right.admitted) - Number(left.admitted) || left.id.localeCompare(right.id)),
  };
}

// Refreshes the in-process cache; failures keep the previous catalog.
export async function refreshOpenRouterCatalog({ env = process.env, fetchFn = fetch, log = () => {}, rank = null } = {}) {
  const apiKey = String(env.OPENROUTER_API_KEY || '').trim() || null;
  if (!apiKey || /^(0|false|no)$/i.test(String(env.OPENROUTER_DISCOVERY || ''))) return cache;
  try {
    const catalog = await fetchOpenRouterCatalog({ apiKey, fetchFn, maxAdmitted: Number(env.OPENROUTER_MAX_FREE_MODELS || DEFAULT_MAX_ADMITTED), rank });
    setOpenRouterCatalog(catalog);
    log(`OpenRouter catalog: ${catalog.freeModels} free models, ${catalog.accessibleFreeModels ?? 'unknown'} accessible, ${catalog.admitted.length} admitted`);
  } catch (error) {
    log(`WARN OpenRouter catalog refresh failed: ${error.status ? `HTTP ${error.status}` : (error.name || 'error')}`);
  }
  return cache;
}
