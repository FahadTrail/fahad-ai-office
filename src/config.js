// Runtime configuration is deliberately small and provider-neutral at the
// workflow boundary. A future model router can replace this module without
// changing task ownership or persisted workflow state.

export const MODEL_PROVIDER = 'anthropic';
export const CHIEF_MODEL = process.env.CHIEF_MODEL || 'claude-sonnet-5';
export const RESEARCH_MODEL = process.env.RESEARCH_MODEL || CHIEF_MODEL;
export const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.3-codex';
export const MODEL_GATEWAY_FAILOVER_ENABLED = readBoolean('MODEL_GATEWAY_FAILOVER_ENABLED', false);
export const MODEL_GATEWAY_ALLOWED_PROVIDERS = readProviderList(
  process.env.MODEL_GATEWAY_ALLOWED_PROVIDERS || MODEL_PROVIDER,
);
export const MODEL_GATEWAY_MAX_ATTEMPTS = readInteger('MODEL_GATEWAY_MAX_ATTEMPTS', 2, 1, 5);
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

function readBoolean(name, fallback) {
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
