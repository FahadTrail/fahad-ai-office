import { redact } from '../coding-agent/policy.js';

export function sanitizeContinuityValue(value, env = process.env, depth = 0) {
  if (depth > 12) return '[TRUNCATED]';
  if (typeof value === 'string') return redact(value, env, 20_000);
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizeContinuityValue(item, env, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 200)
      .map(([key, item]) => [redact(key, env, 500), sanitizeContinuityValue(item, env, depth + 1)]));
  }
  return redact(String(value), env, 20_000);
}
