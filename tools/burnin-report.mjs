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
export function burninSummary({ attempts = [], sessions = [], jobs = [], tasks = [], statuses = [], snapshots = [], events = [], from, to }) {
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
    ...derived({ attempts, sessions, jobs, events, snapshots, statuses, from, to, providers }),
  };
}

// Every reported number carries its basis (docs/capacity-v2.md):
// MEASURED (observed in this window), ESTIMATED (derived from measurements),
// REPORTED (provider or third-party statement), UNKNOWN (no basis: never a number).
const label = (value, basis, note = null) => ({ value: value ?? null, basis: value == null ? 'UNKNOWN' : basis, ...(note ? { note } : {}) });
const sum = (rows, pick) => rows.reduce((total, row) => total + Number(pick(row) || 0), 0);

function derived({ attempts, sessions, jobs, events, snapshots, statuses = [], from, to, providers }) {
  const hours = Math.max(1 / 60, (Date.parse(to) - Date.parse(from)) / 3_600_000);
  const fullDay = hours >= 23;
  const ok = attempts.filter((row) => row.status === 'succeeded');
  const failed = attempts.filter((row) => row.status !== 'succeeded');
  const isPaid = (row) => Number(row.cost_usd || 0) > 0;
  const okTokens = sum(ok, (row) => Number(row.input_tokens || 0) + Number(row.output_tokens || 0));
  const freeOk = ok.filter((row) => !isPaid(row));
  const perDay = Math.round(okTokens * 24 / hours);
  // Coding jobs by size, from completed sessions in the window.
  const coding = {};
  for (const session of sessions) {
    const size = session.config?.codingTier || 'unknown';
    const entry = coding[size] ||= { sessions: 0, completed: 0, tokens: [], minutes: [], privateCompleted: 0 };
    entry.sessions += 1;
    if (session.status === 'completed') {
      entry.completed += 1;
      entry.tokens.push(Number(session.tokens_in || 0) + Number(session.tokens_out || 0));
      if (session.started_at && session.completed_at) entry.minutes.push((Date.parse(session.completed_at) - Date.parse(session.started_at)) / 60_000);
      if (['PRIVATE', 'CONFIDENTIAL'].includes(String(session.config?.dataClass || '').toUpperCase()) && !(Number(session.spent_usd || 0) > 0)) entry.privateCompleted += 1;
    }
  }
  const median = (values) => (values.length ? values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] : null);
  // Serial throughput ceiling: one coding worker, measured wall time per job;
  // daily provider caps are not published for the coding pools (UNKNOWN), so
  // this is an upper bound, never a quota.
  const perDayCeiling = (size) => (median(coding[size]?.minutes || []) ? Math.floor(1_440 / median(coding[size].minutes)) : null);
  const waits = events.filter((row) => row.type === 'guard' && Number(row.payload?.waitMs) > 0);
  const waitSeconds = Math.round(sum(waits, (row) => row.payload.waitMs) / 1000);
  const switches = events.filter((row) => row.type === 'provider_switch' && !row.payload?.drill);
  const latestSnapshot = snapshots[0]?.summary || null;
  const completedJobs = jobs.filter((row) => row.status === 'completed').length;
  return {
    measuredHours: Number(hours.toFixed(2)),
    tokens: {
      total: label(sum(attempts, (row) => Number(row.input_tokens || 0) + Number(row.output_tokens || 0)), 'MEASURED'),
      successful: label(okTokens, 'MEASURED'),
      failedOrRetry: label(sum(failed, (row) => Number(row.input_tokens || 0) + Number(row.output_tokens || 0)), 'MEASURED', 'tokens a failed attempt consumed (usually 0: rejected before generation)'),
      cached: label(sum(attempts, (row) => row.cached_input_tokens), 'MEASURED'),
      reasoning: label(sum(attempts, (row) => row.reasoning_tokens), 'MEASURED'),
      free: label(sum(freeOk, (row) => Number(row.input_tokens || 0) + Number(row.output_tokens || 0)), 'MEASURED'),
      perDay: label(perDay, fullDay ? 'MEASURED' : 'ESTIMATED', fullDay ? null : `scaled from ${hours.toFixed(1)} h`),
      projectedPerMonth: label(perDay * 30, 'ESTIMATED', 'measured per-day × 30; actual use, not capacity'),
      freeCapacityPerDay: label(latestSnapshot?.freeTokensPerDay ?? null, 'ESTIMATED', 'capacity model (snapshot)'),
    },
    coverage: {
      freeCallsPct: label(ok.length ? Number((100 * freeOk.length / ok.length).toFixed(1)) : null, 'MEASURED'),
      paidFallbackPct: label(ok.length ? Number((100 * (ok.length - freeOk.length) / ok.length).toFixed(1)) : null, 'MEASURED'),
      failureRatePct: label(attempts.length ? Number((100 * failed.length / attempts.length).toFixed(1)) : null, 'MEASURED'),
      retryOverheadPct: label(ok.length ? Number((100 * failed.length / ok.length).toFixed(1)) : null, 'MEASURED', 'failed attempts per successful call'),
    },
    codingCapacity: {
      bySize: Object.fromEntries(Object.entries(coding).map(([size, entry]) => [size, {
        sessions: entry.sessions, completed: entry.completed,
        tokensPerJob: label(median(entry.tokens), 'MEASURED'), minutesPerJob: label(median(entry.minutes) && Number(median(entry.minutes).toFixed(1)), 'MEASURED'),
      }])),
      publicSmallPerDay: label(perDayCeiling('small'), 'ESTIMATED', 'serial throughput ceiling; daily provider caps UNKNOWN'),
      publicMediumPerDay: label(perDayCeiling('medium'), 'ESTIMATED', 'serial throughput ceiling; daily provider caps UNKNOWN'),
      publicLargePerMonth: label(coding.large?.completed ? perDayCeiling('large') * 30 : null, 'ESTIMATED', 'no large free job completed: UNKNOWN until one does'),
      privatePerDay: label(sum(Object.values(coding), (entry) => entry.privateCompleted) * 24 / hours || 0, 'MEASURED', 'free PRIVATE coding needs an owner privacy flag'),
    },
    officeCapacity: {
      completedJobs: label(completedJobs, 'MEASURED'),
      mixedProjectsPerDay: label(latestSnapshot?.projectsPerDay?.freeOnly?.p50 ?? null, 'ESTIMATED', 'capacity model, p50 project size'),
    },
    resilience: {
      providerSwitches: label(switches.length, 'MEASURED'),
      codingFailovers: label(switches.filter((row) => row.session_id).length, 'MEASURED'),
      backoffWaitSeconds: label(waitSeconds, 'MEASURED'),
    },
    bottlenecks: bottlenecks({ providers, attempts, waitSeconds, hours, coding, statuses }),
  };
}

// Ranked constraints on free capacity. Impact is ESTIMATED tokens/day of
// work that could not run: time spent waiting × measured throughput, or
// failed (non-rate-limit) calls × average call size. A 429 defers a call; it
// is not counted as lost tokens by itself.
export function bottlenecks({ providers = {}, attempts = [], waitSeconds = 0, hours = 24, coding = {}, statuses = [] }) {
  const out = [];
  const okCalls = attempts.filter((row) => row.status === 'succeeded');
  const okTokens = sum(okCalls, (row) => Number(row.input_tokens || 0) + Number(row.output_tokens || 0));
  const avgTokens = okCalls.length ? okTokens / okCalls.length : 0;
  const activeMinutes = Math.max(1, sum(okCalls, (row) => row.duration_ms) / 60_000);
  // A route cannot process more than its REPORTED per-minute quota.
  const tpmCap = Math.max(0, ...statuses.map((row) => Number(row.rate_limit?.inputTokensPerMinute || 0)));
  const tokensPerMinute = tpmCap ? Math.min(tpmCap, okTokens / activeMinutes) : okTokens / activeMinutes;
  const scale = 24 / Math.max(hours, 1 / 60);
  const reportedTpm = (provider) => statuses.filter((row) => row.provider === provider && row.rate_limit?.inputTokensPerMinute).map((row) => `${row.model} ${row.rate_limit.inputTokensPerMinute / 1000}K/min`);
  if (waitSeconds > 0) {
    const limited = Object.entries(providers).filter(([, entry]) => entry.rateLimited > 0).map(([provider, entry]) => `${provider} (${entry.rateLimited} × 429${reportedTpm(provider).length ? `; ${reportedTpm(provider).join(', ')}` : ''})`);
    out.push({ bottleneck: `per-minute quotas and backoff waits: ${limited.join(', ') || 'rate limits'}`,
      impactTokensPerDay: Math.round((waitSeconds / 60) * tokensPerMinute * scale),
      evidence: `${Math.round(waitSeconds / 60)} min waiting in ${hours.toFixed(1)} h (upper bound: waiting time × throughput, scaled to a day)`,
      engineeringFix: 'reset-aware backoff (PR "Reset-aware rate-limit backoff": per-minute windows ≤ 65 s, no doubling); spread coding turns over two pools',
      ownerAction: null, expectedGain: 'replay estimate: −15 % (medium) to −49 % (small) coding wall time' });
  }
  for (const [provider, entry] of Object.entries(providers)) {
    const broken = entry.failed - entry.rateLimited;
    if (entry.calls >= 5 && broken / entry.calls > 0.3) {
      out.push({ bottleneck: `${provider}: reliability (${Math.round(100 * broken / entry.calls)} % of calls failed, not counting rate limits)`,
        impactTokensPerDay: Math.round(broken * avgTokens * scale), evidence: `${broken} of ${entry.calls} calls`,
        engineeringFix: 'demotion skips routes that never succeed; inspect error codes', ownerAction: null, expectedGain: 'fewer failover hops' });
    }
  }
  const openrouter = providers.openrouter;
  if (openrouter && openrouter.rateLimited >= 3) {
    out.push({ bottleneck: 'shared quota: OpenRouter :free (50 requests/day key-wide)', impactTokensPerDay: Math.round(openrouter.rateLimited * avgTokens * scale),
      evidence: `${openrouter.rateLimited} × 429`, engineeringFix: 'keep OpenRouter for strong-reasoning stages only',
      ownerAction: 'one-time $10 credit raises the pool to 1,000/day (a purchase: Fahad decides)', expectedGain: '≈20× OpenRouter requests' });
  }
  const privateDone = sum(Object.values(coding), (entry) => entry.privateCompleted || 0);
  if (!privateDone) {
    out.push({ bottleneck: 'privacy: no free route may take PRIVATE code', impactTokensPerDay: null, evidence: 'no free route has verified no-training + no-retention terms and coding capacity',
      engineeringFix: 'none (policy)', ownerAction: 'docs/private-coding-policy.md: review Z.ai terms or add Cloudflare (NORMAL class)',
      expectedGain: 'free PRIVATE small coding becomes possible' });
  }
  if (!coding.large?.completed) {
    out.push({ bottleneck: 'context/TPM: large coding turns (≈25–63K) exceed free per-minute quotas (Gemma 16K/min)', impactTokensPerDay: null, evidence: 'no large free job completed',
      engineeringFix: 'size compaction (live since #87) keeps turns under the quota; large jobs still need a bigger pool',
      ownerAction: 'Mistral key (≈1B tokens/month REPORTED) is the only free pool that could carry large jobs', expectedGain: 'large PUBLIC coding: UNKNOWN until measured' });
  }
  return out.toSorted((a, b) => (b.impactTokensPerDay ?? -1) - (a.impactTokensPerDay ?? -1)).slice(0, 8);
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
  const [attempts, sessions, jobs, tasks, statuses, snapshots, events] = await Promise.all([
    range(db.from('model_attempts').select('provider,model,status,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,cost_usd,duration_ms,error_code'), 'started_at').limit(50_000),
    range(db.from('agent_sessions').select('id,status,config,tokens_in,tokens_out,spent_usd,started_at,completed_at'), 'created_at'),
    range(db.from('jobs').select('id,status'), 'created_at'),
    range(db.from('tasks').select('id,status,wait_count'), 'created_at'),
    db.from('provider_status').select('provider,model,health,cooldown_until,rate_limit'),
    db.from('capacity_snapshots').select('snapshot_date,summary').order('snapshot_date', { ascending: false }).limit(3),
    range(db.from('agent_events').select('session_id,type,payload').in('type', ['guard', 'provider_switch']), 'created_at').limit(20_000),
  ]);
  console.log(JSON.stringify(burninSummary({
    attempts: attempts.data || [], sessions: sessions.data || [], jobs: jobs.data || [], tasks: tasks.data || [],
    statuses: statuses.data || [], snapshots: snapshots.data || [], events: events.data || [], from: from.toISOString(), to: to.toISOString(),
  }), null, 2));
}
