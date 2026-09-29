// Read-only capacity view for a future simple dashboard: independent free
// pools (never "N free models"), their state and next reset, and token usage
// today / this month from model_attempts. No quota number is invented:
// `estimatedCapacityLeft` is null unless a provider reported one.
import { createModelPool } from './model-gateway/agentic/model-pool.js';
import { capacityPool, poolSummary } from './model-gateway/agentic/capacity-pools.js';
import { modelUsage } from './model-gateway/agentic/usage-telemetry.js';
import { searchBreaker } from './office/web-tools.js';

export async function capacityView({ db, env = process.env, now = Date.now() }) {
  const pool = createModelPool({ env });
  const monthStart = new Date(now);
  monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  const [{ data: statusRows }, { data: attemptRows }] = await Promise.all([
    db.from('provider_status').select('provider,model,health,cooldown_until,rate_limit'),
    db.from('model_attempts').select('provider,model,status,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,cost_usd,attempt_no,task_id,started_at')
      .gte('started_at', monthStart.toISOString()).limit(20_000),
  ]);
  const state = new Map((statusRows || []).map((row) => [`${row.provider}:${row.model}`, { health: row.health, cooldownUntil: row.cooldown_until, rateLimit: row.rate_limit }]));
  const routeById = new Map(pool.map((route) => [route.id, route]));
  const poolOf = (row) => (routeById.get(`${row.provider}:${row.model}`)?.capacityPool
    || capacityPool({ provider: row.provider, model: row.model, billingClass: /:free$/.test(row.model) ? 'free' : 'paid', freeOnly: /:free$/.test(row.model) })).id;
  const byPool = new Map();
  for (const row of attemptRows || []) {
    const id = poolOf(row);
    const entry = byPool.get(id) || { month: [], today: [] };
    entry.month.push(row);
    if (Date.parse(row.started_at) >= dayStart.getTime()) entry.today.push(row);
    byPool.set(id, entry);
  }
  const usage = new Map([...byPool].map(([id, rows]) => {
    const today = modelUsage(rows.today);
    return [id, { tokensToday: today.totalTokens, tokensMonth: modelUsage(rows.month).totalTokens, failedToday: today.failed.calls }];
  }));
  const pools = poolSummary(pool, state, { now, usage });
  const all = modelUsage(attemptRows || []);
  const today = modelUsage((attemptRows || []).filter((row) => Date.parse(row.started_at) >= dayStart.getTime()));
  return {
    freeCapacity: {
      pools: pools.length,
      available: pools.filter((entry) => entry.state === 'available').length,
      degraded: pools.filter((entry) => entry.state === 'degraded').length,
      exhausted: pools.filter((entry) => entry.state === 'exhausted').length,
      nextReset: pools.map((entry) => entry.nextReset).filter(Boolean).toSorted()[0] || null,
    },
    pools,
    usage: { today, month: all, definition: 'TOTAL MODEL USAGE = input + output tokens of every model attempt (successful and failed); see usage-telemetry.js' },
    search: searchBreaker.status(),
  };
}
