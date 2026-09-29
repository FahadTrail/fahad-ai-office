// Wave 2 harnesses: public coding benchmark / failover config and the 24 h
// burn-in summary. Pure functions only (no network, no credentials).
import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkConfig, failoverVerdict, PUBLIC_REPOSITORY, sessionMetrics, TASKS } from '../tools/coding-benchmark.mjs';
import { burninSummary } from '../tools/burnin-report.mjs';

const ALL = ['gemini:gemma-4-26b-a4b-it', 'openrouter:nvidia/nemotron-3-ultra-550b-a55b:free', 'groq:openai/gpt-oss-120b', 'anthropic:claude-sonnet-5', 'deepseek:deepseek-flash'];

test('benchmark config: public repo, PUBLIC data, $0, nothing pushed, one route pinned', () => {
  assert.equal(PUBLIC_REPOSITORY, 'FahadTrail/fahad-ai-office');
  const config = benchmarkConfig({ routes: ['gemini:gemma-4-26b-a4b-it'], allRouteIds: ALL, task: 'small' });
  assert.equal(config.dataClass, 'PUBLIC');
  assert.equal(config.allowPaid, false);
  assert.equal(config.routing.allowPaid, false);
  assert.equal(config.publish, 'none');
  assert.equal(config.codingTier, 'small');
  assert.equal(config.testCommand, TASKS.small.testCommand);
  assert.deepEqual(config.routing.excludedRoutes.toSorted(), ALL.filter((id) => id !== 'gemini:gemma-4-26b-a4b-it').toSorted());
  assert.equal(config.drill, undefined);
});

test('failover config keeps exactly two routes and arms the drill; bad inputs are refused', () => {
  const routes = ['gemini:gemma-4-26b-a4b-it', 'openrouter:nvidia/nemotron-3-ultra-550b-a55b:free'];
  const config = benchmarkConfig({ routes, allRouteIds: ALL, task: 'small', drillAfterIteration: 3 });
  assert.deepEqual(config.drill, { failoverAfterIteration: 3 });
  assert.equal(config.routing.excludedRoutes.length, ALL.length - 2);
  assert.throws(() => benchmarkConfig({ routes: [], allRouteIds: ALL }));
  assert.throws(() => benchmarkConfig({ routes: ALL.slice(0, 3), allRouteIds: ALL }));
  assert.throws(() => benchmarkConfig({ routes: ['x:y'], allRouteIds: ALL, task: 'huge' }));
});

test('session metrics and failover verdict: switch, continuation, tests, $0', () => {
  const session = {
    id: 's1', status: 'completed', phase: 'done', iteration: 9, provider_switches: 1,
    state: { routesUsed: ['a:1', 'b:2'], drill: { fired: true, route: 'a:1' }, filesChanged: ['test/x.test.js'], lastTest: { exitCode: 0, command: 'node --test' } },
  };
  const attempts = [
    { provider: 'a', model: '1', status: 'succeeded', input_tokens: 20_000, output_tokens: 800, duration_ms: 5000, cost_usd: 0 },
    { provider: 'a', model: '1', status: 'failed', input_tokens: 0, output_tokens: 0, duration_ms: 10, cost_usd: 0 },
    { provider: 'b', model: '2', status: 'succeeded', input_tokens: 25_000, output_tokens: 900, duration_ms: 7000, cost_usd: 0 },
  ];
  const metrics = sessionMetrics(session, attempts);
  assert.equal(metrics.tokensPerJob, 46_700);
  assert.equal(metrics.byRoute['a:1'].failed, 1);
  assert.equal(metrics.costUsd, 0);
  assert.equal(failoverVerdict(metrics, { primary: 'a:1', secondary: 'b:2' }).ok, true);
  const restarted = failoverVerdict({ ...metrics, routesUsed: ['a:1'] }, { primary: 'a:1', secondary: 'b:2' });
  assert.equal(restarted.ok, false);
  assert.equal(restarted.checks.bothRoutesAnswered, false);
  assert.equal(failoverVerdict({ ...metrics, costUsd: 0.01 }, { primary: 'a:1', secondary: 'b:2' }).checks.zeroCost, false);
});

test('burn-in summary: tokens per provider and pool, uptime, waits, paid fallbacks, resets', () => {
  const from = '2026-09-29T20:00:00Z';
  const to = '2026-09-30T20:00:00Z';
  const summary = burninSummary({
    from, to,
    attempts: [
      { provider: 'openrouter', model: 'a:free', status: 'succeeded', input_tokens: 5000, output_tokens: 500, cost_usd: 0, duration_ms: 2000 },
      { provider: 'openrouter', model: 'b:free', status: 'failed', input_tokens: 0, output_tokens: 0, cost_usd: 0, error_code: 'PROVIDER_RATE_LIMIT' },
      { provider: 'deepseek', model: 'deepseek-flash', status: 'succeeded', input_tokens: 30_000, output_tokens: 1000, cost_usd: 0.004, duration_ms: 4000 },
    ],
    sessions: [{ status: 'completed' }], jobs: [{ status: 'completed' }, { status: 'failed' }],
    tasks: [{ wait_count: 2 }, { wait_count: 0 }, { wait_count: 48, status: 'failed' }],
    statuses: [{ provider: 'gemini', model: 'x', health: 'quota_exhausted', cooldown_until: '2026-09-30T07:00:00Z' }],
  });
  assert.equal(summary.pools['openrouter:free'].calls, 2, 'OpenRouter :free models are one pool');
  assert.equal(summary.pools['openrouter:free'].rateLimited, 1);
  assert.equal(summary.providers.openrouter.uptime, 0.5);
  assert.equal(summary.totals.paidFallbackCalls, 1);
  assert.equal(summary.totals.costUsd, 0.004);
  assert.equal(summary.totals.okTokens, 36_500);
  assert.equal(summary.capacityWaits.totalWaits, 50);
  assert.equal(summary.capacityWaits.exhausted, 1);
  assert.equal(summary.quotaResets.length, 1);
  assert.deepEqual(summary.office.byStatus, { completed: 1, failed: 1 });
});

test('coding runtime rebuilds its pool from refreshed provider catalogs (discovered Gemma becomes routable)', async () => {
  const { createCodingRuntime } = await import('../src/coding-agent/runtime.js');
  const { setProviderCatalog } = await import('../src/model-gateway/agentic/provider-catalogs.js');
  const { MemoryProviderStateStore } = await import('../src/model-gateway/agentic/provider-state.js');
  const env = { GEMINI_API_KEY: 'test-key-1234567890abcdef' };
  setProviderCatalog('gemini', null);
  const runtime = createCodingRuntime({ env, sessionStore: {}, providerStateStore: new MemoryProviderStateStore(), policyStore: null, auditStore: {}, sandboxMode: 'unisolated' });
  const gemma = 'gemini:gemma-4-26b-a4b-it';
  assert.ok(!runtime.pool.some((route) => route.id === gemma), 'no catalog yet: no discovered route');
  setProviderCatalog('gemini', { ok: true, status: 200, fetchedAt: new Date().toISOString(), models: ['gemini-flash-latest', 'gemma-4-26b-a4b-it'], contexts: {} });
  try {
    runtime.refreshPool();
    assert.ok(runtime.pool.some((route) => route.id === gemma));
    assert.ok(runtime.gateway.pool.some((route) => route.id === gemma), 'the gateway routes over the refreshed pool');
  } finally {
    setProviderCatalog('gemini', null);
  }
});

test('a job summary skips markdown headings, rules and tables (load test 668ad9a5 saved only "## Executive summary")', async () => {
  const { summarize } = await import('../src/workflow.js');
  assert.equal(summarize('## Executive summary\n\nOpen the kiosk: break-even is **1,325 cups/month**.\n| a | b |'), 'Open the kiosk: break-even is 1,325 cups/month.');
  assert.equal(summarize('---\n| x | y |\n- First point'), 'First point');
  assert.equal(summarize('# Only a heading'), '# Only a heading', 'falls back to the first line');
  assert.equal(summarize(''), '');
});
