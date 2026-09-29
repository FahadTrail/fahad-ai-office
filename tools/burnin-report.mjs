#!/usr/bin/env node
// 24-hour capacity burn-in collector (Capacity V2 wave 2).
//
// Reads production telemetry for a window and prints one JSON report:
// tokens per provider and per capacity pool (successful vs failed), coding
// sessions and Office jobs, latency, rate-limit / quota signals, capacity
// waits (WAITING_FOR_CAPACITY), paid fallbacks, cost and provider uptime.
// Read-only. Metadata only (no prompts, no model output).
//
//   node tools/burnin-report.mjs [--hours=24] [--since=2026-09-29T20:00:00Z]
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (e.g. on the VPS). The
// same numbers can be read with SQL; see docs/capacity-v2.md §9.

import { capacityPool } from '../src/model-gateway/agentic/capacity-pools.js';

const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

// Pure summary of one window (unit-tested).
export function burninSummary({ attempts = [], sessions = [], jobs = [], tasks = [], statuses = [], snapshots = [], from, to }) {
  const providers = {};
  const pools = {};
  const latencies = [];
  let paidFallbackCalls = 0;
  for (const row of attempts) {
    const ok = row.status === 'succeeded';
    const tokens = Number(row.input_tokens || 0) + Number(row.output_tokens || 0);
    const paid = Number(row.cost_usd || 0) > 0;
    const pool = capacityPool({ provider: row.provider, model: row.model, billingClass: paid ? 'paid' : 'free', freeOnly: /:free$/.test(row.model) }).id;
    for (const [bucket, key] of [[providers, row.provider], [pools, pool]]) {
      const entry = bucket[key] ||= { calls: 0, succeeded: 0, failed: 0, okTokens: 0, failedTokens: 0, rateLimited: 0, costUsd: 0 };
      entry.calls += 1;
      if (ok) { entry.succeeded += 1; entry.okTokens += tokens; } else { entry.failed += 1; entry.failedTokens += tokens; }
      if (/RATE|QUOTA/i.test(String(row.error_code || ''))) entry.rateLimited += 1;
      entry.costUsd = Number((entry.costUsd + Number(row.cost_usd || 0)).toFixed(6));
    }
    if (ok && row.duration_ms) latencies.push(Number(row.duration_ms));
    if (paid) paidFallbackCalls += 1;
  }
  for (const entry of [...Object.values(providers), ...Object.values(pools)]) entry.uptime = entry.calls ? Number((entry.succeeded / entry.calls).toFixed(3)) : null;
  const byStatus = (rows) => rows.reduce((all, row) => ({ ...all, [row.status]: (all[row.status] || 0) + 1 }), {});
  const cost = attempts.reduce((sum, row) => sum + Number(row.cost_usd || 0), 0);
  const free = attempts.filter((row) => !(Number(row.cost_usd || 0) > 0));
  return {
    window: { from, to },
    providers, pools,
    totals: {
      calls: attempts.length,
      okTokens: attempts.filter((row) => row.status === 'succeeded').reduce((sum, row) => sum + Number(row.input_tokens || 0) + Number(row.output_tokens || 0), 0),
      failedCalls: attempts.filter((row) => row.status !== 'succeeded').length,
      freeShareOfCalls: attempts.length ? Number((free.length / attempts.length).toFixed(3)) : null,
      paidFallbackCalls,
      costUsd: Number(cost.toFixed(6)),
    },
    latencyMs: { p50: quantile(latencies, 0.5), p90: quantile(latencies, 0.9), max: latencies.length ? Math.max(...latencies) : null },
    coding: { sessions: sessions.length, byStatus: byStatus(sessions) },
    office: { jobs: jobs.length, byStatus: byStatus(jobs) },
    capacityWaits: {
      tasksThatWaited: tasks.filter((row) => Number(row.wait_count || 0) > 0).length,
      totalWaits: tasks.reduce((sum, row) => sum + Number(row.wait_count || 0), 0),
      // defer_task allows 48 waits; a failed task at the cap ran out of capacity.
      exhausted: tasks.filter((row) => row.status === 'failed' && Number(row.wait_count || 0) >= 48).length,
    },
    quotaResets: statuses.filter((row) => row.cooldown_until && Date.parse(row.cooldown_until) >= Date.parse(from) && Date.parse(row.cooldown_until) <= Date.parse(to))
      .map((row) => ({ route: `${row.provider}:${row.model}`, until: row.cooldown_until, health: row.health })),
    snapshots: snapshots.map((row) => ({ date: row.snapshot_date, freeTokensPerDay: row.summary?.freeTokensPerDay ?? null, codingJobsPerDay: row.summary?.codingJobsPerDay ?? null })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const hours = Number(args.find((arg) => arg.startsWith('--hours='))?.slice(8) || 24);
  const since = args.find((arg) => arg.startsWith('--since='))?.slice(8);
  const to = new Date();
  const from = since ? new Date(since) : new Date(to.getTime() - hours * 3600_000);
  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const range = (query, column) => query.gte(column, from.toISOString()).lte(column, to.toISOString());
  const [attempts, sessions, jobs, tasks, statuses, snapshots] = await Promise.all([
    range(db.from('model_attempts').select('provider,model,status,input_tokens,output_tokens,cost_usd,duration_ms,error_code'), 'started_at').limit(50_000),
    range(db.from('agent_sessions').select('id,status'), 'created_at'),
    range(db.from('jobs').select('id,status'), 'created_at'),
    range(db.from('tasks').select('id,status,wait_count'), 'created_at'),
    db.from('provider_status').select('provider,model,health,cooldown_until'),
    db.from('capacity_snapshots').select('snapshot_date,summary').order('snapshot_date', { ascending: false }).limit(3),
  ]);
  console.log(JSON.stringify(burninSummary({
    attempts: attempts.data || [], sessions: sessions.data || [], jobs: jobs.data || [], tasks: tasks.data || [],
    statuses: statuses.data || [], snapshots: snapshots.data || [], from: from.toISOString(), to: to.toISOString(),
  }), null, 2));
}
