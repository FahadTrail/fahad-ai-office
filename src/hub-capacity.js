// Read-only capacity view for a future simple dashboard: independent free
// pools (never "N free models"), their state and next reset, and token usage
// today / this month from model_attempts. No quota number is invented:
// `estimatedCapacityLeft` is null unless a provider reported one.
import { createModelPool } from './model-gateway/agentic/model-pool.js';
import { capacityHeadline, capacityPool, poolSummary } from './model-gateway/agentic/capacity-pools.js';
import { modelUsage } from './model-gateway/agentic/usage-telemetry.js';
import { searchBreaker } from './office/web-tools.js';
import { capacityModel } from './model-gateway/agentic/capacity-model.js';
import { QualificationStore } from './model-gateway/agentic/qualification.js';
import { routeLifecycle } from './model-gateway/agentic/provider-contract.js';
import { ownerActions } from './model-gateway/agentic/owner-actions.js';

export async function capacityView({ db, env = process.env, now = Date.now() }) {
  const pool = createModelPool({ env });
  const monthStart = new Date(now);
  monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  const [{ data: statusRows }, { data: attemptRows }, qualifications, { data: policyRows }, { data: snapshotRows }] = await Promise.all([
    db.from('provider_status').select('provider,model,health,cooldown_until,rate_limit'),
    db.from('model_attempts').select('provider,model,status,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,cost_usd,attempt_no,task_id,started_at')
      .gte('started_at', monthStart.toISOString()).limit(20_000),
    new QualificationStore(db, { now: () => now }).snapshot().catch(() => null),
    Promise.resolve(db.from('workspace_policies').select('monthly_budget_usd,spent_usd,reserved_usd')).catch(() => ({ data: null })),
    // Daily snapshots (capacity over time); absent table → empty history.
    Promise.resolve(db.from('capacity_snapshots').select('snapshot_date,taken_at,summary').order('snapshot_date', { ascending: false }).limit(30)).catch(() => ({ data: null })),
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
    return [id, { tokensToday: today.totalTokens, tokensMonth: modelUsage(rows.month).totalTokens, failedToday: today.failed.calls, requestsToday: today.successful.calls }];
  }));
  const pools = poolSummary(pool, state, { now, usage });
  const all = modelUsage(attemptRows || []);
  const today = modelUsage((attemptRows || []).filter((row) => Date.parse(row.started_at) >= dayStart.getTime()));
  const configured = pools.filter((entry) => entry.state !== 'not_configured');
  const monthUsd = all.costUsd;
  const budget = (policyRows || []).reduce((sum, row) => ({
    monthly: sum.monthly + Number(row.monthly_budget_usd || 0),
    remaining: sum.remaining + Math.max(0, Number(row.monthly_budget_usd || 0) - Number(row.spent_usd || 0) - Number(row.reserved_usd || 0)),
  }), { monthly: 0, remaining: 0 });
  const nextMonth = new Date(monthStart); nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  // Cheapest configured paid route approved for private data: the fallback
  // that a free-first project would use once free capacity is exhausted.
  // A blocked account (auth_error: not activated, no credit, rejected key)
  // is not a fallback, whatever its cooldown says.
  const fallback = pool.filter((route) => route.billingClass === 'paid' && route.privacyApproved && !route.unavailableReasons.length && route.pricing
    && state.get(route.id)?.health !== 'auth_error')
    .toSorted((left, right) => (left.pricing.inputPerMillion + left.pricing.outputPerMillion) - (right.pricing.inputPerMillion + right.pricing.outputPerMillion))[0] || null;
  const model = capacityModel({
    routes: pool, pools, qualifications, now, states: state,
    attemptsByPool: new Map([...byPool].map(([id, rows]) => [id, rows.month])),
    paid: fallback ? { routeId: fallback.id, pricing: fallback.pricing, remainingUsd: budget.remaining, daysLeftInMonth: Math.ceil((nextMonth.getTime() - now) / 86_400_000) } : null,
  });
  const freeTokensToday = (attemptRows || []).filter((row) => Date.parse(row.started_at) >= dayStart.getTime() && Number(row.cost_usd || 0) === 0)
    .reduce((sum, row) => sum + Number(row.input_tokens || 0) + Number(row.output_tokens || 0), 0);
  const lifecycle = {};
  for (const route of pool) {
    if (route.billingClass === 'paid') continue;
    const stage = routeLifecycle(route, { qualifications, state, now });
    lifecycle[stage] = (lifecycle[stage] || 0) + 1;
  }
  return {
    headline: capacityHeadline(pools, { now }),
    summary: {
      freeCapacityNow: configured.some((entry) => entry.state === 'available') ? 'available' : configured.length ? 'waiting for a reset' : 'none configured',
      healthyPools: configured.filter((entry) => entry.state === 'available').length,
      degradedPools: configured.filter((entry) => entry.state === 'degraded').length,
      exhaustedPools: configured.filter((entry) => entry.state === 'exhausted').length,
      nextReset: configured.map((entry) => entry.nextReset).filter(Boolean).toSorted()[0] || null,
      tokensToday: today.totalTokens,
      failedAttemptsToday: today.failed.calls,
      estimatedRemainingRequests: configured.every((entry) => entry.estimatedCapacityLeft) ? configured.reduce((sum, entry) => sum + entry.estimatedCapacityLeft.requests, 0) : null,
      estimatedRemainingBasis: 'Sum of per-pool estimates; null when any pool has no published limit (never invented).',
    },
    freeCapacity: {
      pools: pools.length,
      available: pools.filter((entry) => entry.state === 'available').length,
      degraded: pools.filter((entry) => entry.state === 'degraded').length,
      exhausted: pools.filter((entry) => entry.state === 'exhausted').length,
      nextReset: pools.map((entry) => entry.nextReset).filter(Boolean).toSorted()[0] || null,
    },
    // Capacity V2 (Part 25): effective free capacity per job class.
    capacity: {
      freeTokensPerDay: model.perClass.general.tokensPerDay,
      freeTokensPerMonth: model.perClass.general.tokensPerMonth,
      freeTokensToday: model.perClass.general.tokensToday,
      coding: { ...model.perClass.coding, jobsPerDay: model.codingJobsPerDay, dataClass: model.codingDataClass },
      // PUBLIC code only (public repositories): never used for private code.
      publicCoding: { ...model.perClass.coding_public, jobsPerDay: model.publicCodingJobsPerDay, dataClass: 'PUBLIC' },
      strongReasoning: model.perClass.strong_reasoning,
      research: model.perClass.research,
      finance: model.perClass.finance,
      projectsPerDay: model.projectsPerDay,
      healthyPools: configured.filter((entry) => entry.state === 'available').length,
      exhaustedPools: configured.filter((entry) => entry.state === 'exhausted').length,
      independentFreePools: model.independentFreePools,
      unknownAllowancePools: model.unknownAllowancePools,
      nextReset: configured.map((entry) => entry.nextReset).filter(Boolean).toSorted()[0] || null,
      freeUtilizationToday: model.perClass.general.tokensPerDay ? Number((freeTokensToday / model.perClass.general.tokensPerDay).toFixed(4)) : null,
      paidFallback: { route: fallback?.id || null, monthlyBudgetUsd: budget.monthly, remainingUsd: Number(budget.remaining.toFixed(4)), silent: false },
      costUsd: { today: today.costUsd, month: monthUsd },
      lifecycle,
      pools: model.pools,
      method: model.method,
      jobSizes: model.jobSizes,
      // Stored daily snapshots, newest first (compact per-day totals).
      history: (snapshotRows || []).map((row) => ({
        date: row.snapshot_date, takenAt: row.taken_at,
        freeTokensPerDay: row.summary?.freeTokensPerDay ?? null, strongReasoningPerDay: row.summary?.strongReasoning?.tokensPerDay ?? null,
        codingTokensPerDay: row.summary?.coding?.tokensPerDay ?? null, codingJobsPerDay: row.summary?.codingJobsPerDay || null,
        publicCodingJobsPerDay: row.summary?.publicCodingJobsPerDay || null,
        independentFreePools: row.summary?.independentFreePools ?? null, healthyPools: row.summary?.healthyPools ?? null,
        tokensUsed: row.summary?.tokensToday ?? null, costUsd: row.summary?.costUsd || null,
      })),
    },
    ownerActions: ownerActions({ env, pools: model.pools, qualifications, now }),
    pools,
    usage: { today, month: all, definition: 'TOTAL MODEL USAGE = input + output tokens of every model attempt (successful and failed); see usage-telemetry.js' },
    search: searchBreaker.status(),
  };
}
