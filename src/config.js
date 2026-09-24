// Runtime configuration is deliberately small and provider-neutral at the
// workflow boundary. A future model router can replace this module without
// changing task ownership or persisted workflow state.

export const MODEL_PROVIDER = 'anthropic';
export const CHIEF_MODEL = process.env.CHIEF_MODEL || 'claude-sonnet-5';
export const RESEARCH_MODEL = process.env.RESEARCH_MODEL || CHIEF_MODEL;
export const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.3-codex';
export const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
export const QWEN_MODEL = process.env.QWEN_MODEL || 'qwen3.8-flash';
export const KIMI_MODEL = process.env.KIMI_MODEL || 'kimi-k2.7-code';
export const ZHIPU_MODEL = process.env.ZHIPU_MODEL || 'glm-5.3-flash';
export const MINIMAX_MODEL = process.env.MINIMAX_MODEL || 'MiniMax-M2.7';
// Qwen's current Singapore endpoint is workspace-specific. The reserved
// fallback keeps the inactive adapter constructible but can never reach a
// provider; health checks require an explicit endpoint before activation.
export const QWEN_API_ENDPOINT = process.env.QWEN_API_ENDPOINT || 'https://qwen.invalid/compatible-mode/v1/chat/completions';
export const MODEL_GATEWAY_FAILOVER_ENABLED = readBoolean('MODEL_GATEWAY_FAILOVER_ENABLED', false);
export const MODEL_GATEWAY_AUTO_SELECT_ENABLED = readBoolean('MODEL_GATEWAY_AUTO_SELECT_ENABLED', false);
export const MODEL_GATEWAY_ALLOWED_PROVIDERS = readProviderList(
  process.env.MODEL_GATEWAY_ALLOWED_PROVIDERS || MODEL_PROVIDER,
);
export const MODEL_GATEWAY_MAX_ATTEMPTS = readInteger('MODEL_GATEWAY_MAX_ATTEMPTS', 2, 1, 5);
export const WORKSPACE_POLICY_ENFORCEMENT_ENABLED = readBoolean('WORKSPACE_POLICY_ENFORCEMENT_ENABLED', false);
export const CHIEF_MAX_TURNS = readInteger('CHIEF_MAX_TURNS', 6, 1, 20);
export const RESEARCH_MAX_TURNS = readInteger('RESEARCH_MAX_TURNS', 10, 1, 30);
export const TASK_MAX_ATTEMPTS = readInteger('MAX_ATTEMPTS', 3, 1, 10);
export const STALE_TASK_MINUTES = readInteger('STALE_TASK_MINUTES', 20, 2, 120);

function readInteger(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid ${name}; expected an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function readBoolean(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  if (/^(1|true|yes)$/i.test(value)) return true;
  if (/^(0|false|no)$/i.test(value)) return false;
  throw new Error(`Invalid ${name}; expected true or false`);
}

function readProviderList(value) {
  const providers = [...new Set(String(value).split(',').map((item) => item.trim()).filter(Boolean))];
  if (!providers.includes(MODEL_PROVIDER)) providers.unshift(MODEL_PROVIDER);
  return Object.freeze(providers);
}
