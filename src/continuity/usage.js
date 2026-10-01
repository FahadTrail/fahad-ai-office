import { findSecretMaterial } from '../coding-agent/policy.js';
import { BASES } from './checkpoint.js';
import { dedupeQuotaSources } from './select.js';

function percentage(value, field) {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new TypeError(`${field} must be between 0 and 100`);
  return value;
}
export class UsageTracker {
  constructor({ store, env = process.env, now = () => new Date() } = {}) {
    if (!store) throw new TypeError('UsageTracker requires a continuity store');
    this.store = store;
    this.env = env;
    this.now = now;
  }

  async capture({ workerKey, quotaSource, sessionId = null, basis = 'UNKNOWN', sessionPct = null, weeklyPct = null, taskTokens = null, resetAt = null, raw = {} }) {
    if (!BASES.includes(basis)) throw new TypeError('Unknown usage basis');
    if (basis === 'UNKNOWN' && (sessionPct != null || weeklyPct != null)) throw new TypeError('UNKNOWN usage cannot contain invented percentages');
    if (findSecretMaterial(JSON.stringify(raw), this.env)) throw new Error('CONTINUITY_USAGE_SECRET_MATERIAL');
    const snapshot = {
      worker_key: workerKey,
      quota_source: quotaSource,
      session_id: sessionId,
      taken_at: this.now().toISOString(),
      session_pct: percentage(sessionPct, 'sessionPct'),
      weekly_pct: percentage(weeklyPct, 'weeklyPct'),
      task_tokens: taskTokens == null ? null : Math.max(0, Math.trunc(taskTokens)),
      reset_at: resetAt,
      basis,
      raw,
    };
    return this.store.writeUsageSnapshot(snapshot);
  }

  capacityBySource(snapshots) {
    return dedupeQuotaSources(snapshots).map((item) => ({
      quotaSource: item.quota_source,
      basis: item.basis,
      usedPct: Math.max(...[item.session_pct, item.weekly_pct].filter(Number.isFinite), 0),
      resetAt: item.reset_at || null,
    }));
  }
}
