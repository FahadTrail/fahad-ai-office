export const PROVIDER_STATE = Object.freeze({
  ACTIVE: 'active',
  CANARY: 'canary',
  PREPARED: 'prepared',
  TARGET: 'target',
  DEFERRED: 'deferred',
});

// A catalog entry is architectural metadata, not an enabled integration.
// Only providers with a registered adapter and an allowlisted route can run.
export const PROVIDER_CATALOG = Object.freeze({
  anthropic: Object.freeze({ state: PROVIDER_STATE.ACTIVE, protocol: 'anthropic', privateDataEligible: true, costTier: 4, qualityTier: 5, contextWindow: 200000 }),
  openai: Object.freeze({ state: PROVIDER_STATE.ACTIVE, protocol: 'openai-responses', privateDataEligible: true, costTier: 4, qualityTier: 5, contextWindow: 400000 }),
  google: Object.freeze({ state: PROVIDER_STATE.TARGET, protocol: 'native-or-gateway' }),
  deepseek: Object.freeze({ state: PROVIDER_STATE.CANARY, protocol: 'openai-responses', privateDataEligible: true, costTier: 1, qualityTier: 4, contextWindow: 128000 }),
  kimi: Object.freeze({ state: PROVIDER_STATE.PREPARED, protocol: 'openai-compatible', privateDataEligible: true, costTier: 3, qualityTier: 5, contextWindow: 262144 }),
  zhipu: Object.freeze({ state: PROVIDER_STATE.PREPARED, protocol: 'openai-compatible', privateDataEligible: true, costTier: 1, qualityTier: 4, contextWindow: 200000 }),
  minimax: Object.freeze({ state: PROVIDER_STATE.PREPARED, protocol: 'openai-compatible', privateDataEligible: false, costTier: 1, qualityTier: 4, contextWindow: 204800 }),
  qwen: Object.freeze({ state: PROVIDER_STATE.PREPARED, protocol: 'openai-compatible', privateDataEligible: true, costTier: 2, qualityTier: 4, contextWindow: 1000000 }),
  xai: Object.freeze({ state: PROVIDER_STATE.DEFERRED, protocol: 'openai-compatible' }),
  openrouter: Object.freeze({ state: PROVIDER_STATE.DEFERRED, protocol: 'openai-compatible' }),
  local: Object.freeze({ state: PROVIDER_STATE.DEFERRED, protocol: 'openai-compatible' }),
});

export const CONFIRMED_TARGET_PROVIDERS = Object.freeze([
  'deepseek', 'kimi', 'zhipu', 'minimax', 'qwen',
]);

export function providerDescriptor(name, adapter) {
  const catalog = PROVIDER_CATALOG[name];
  if (!catalog) throw new Error(`Unknown provider: ${name}`);
  return {
    name,
    state: catalog.state,
    protocol: catalog.protocol,
    configured: Boolean(adapter),
    capabilities: [...(adapter?.capabilities || [])],
    model: adapter?.model || null,
    privateDataEligible: catalog.privateDataEligible === true,
    costTier: catalog.costTier || 5,
    qualityTier: catalog.qualityTier || 1,
    contextWindow: catalog.contextWindow || 0,
  };
}
