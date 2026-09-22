export const PROVIDER_STATE = Object.freeze({
  ACTIVE: 'active',
  TARGET: 'target',
  DEFERRED: 'deferred',
});

// A catalog entry is architectural metadata, not an enabled integration.
// Only providers with a registered adapter and an allowlisted route can run.
export const PROVIDER_CATALOG = Object.freeze({
  anthropic: Object.freeze({ state: PROVIDER_STATE.ACTIVE, protocol: 'anthropic' }),
  openai: Object.freeze({ state: PROVIDER_STATE.ACTIVE, protocol: 'openai-responses' }),
  google: Object.freeze({ state: PROVIDER_STATE.TARGET, protocol: 'native-or-gateway' }),
  deepseek: Object.freeze({ state: PROVIDER_STATE.TARGET, protocol: 'openai-compatible' }),
  kimi: Object.freeze({ state: PROVIDER_STATE.TARGET, protocol: 'openai-compatible' }),
  zhipu: Object.freeze({ state: PROVIDER_STATE.TARGET, protocol: 'openai-compatible' }),
  minimax: Object.freeze({ state: PROVIDER_STATE.TARGET, protocol: 'provider-adapter' }),
  qwen: Object.freeze({ state: PROVIDER_STATE.TARGET, protocol: 'openai-compatible' }),
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
  };
}
