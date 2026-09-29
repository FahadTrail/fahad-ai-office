#!/usr/bin/env node
// Public coding benchmark and two-pool failover harness (Capacity V2 wave 2).
//
// Runs REAL Coding Agent sessions on the PUBLIC repository
// FahadTrail/fahad-ai-office at $0:
//   * dataClass PUBLIC (the repository is public; private code is never used);
//   * allowPaid false (no paid route can be chosen);
//   * publish "none" (nothing is pushed: the work stays in the sandbox);
//   * one route pinned per run by excluding every other route
//     (routing.excludedRoutes), or two routes for the failover drill.
//
// Usage (needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, e.g. on the VPS):
//   node tools/coding-benchmark.mjs start --route=gemini:gemma-4-26b-a4b-it --task=small
//   node tools/coding-benchmark.mjs failover --primary=<routeId> --secondary=<routeId> --task=small
//   node tools/coding-benchmark.mjs report --session=<uuid>
//
// The pure builders below are unit-tested and are also what the SQL runbook
// in docs/capacity-v2.md uses (create_coding_session with the same config).

export const PUBLIC_REPOSITORY = 'FahadTrail/fahad-ai-office';
export const WORKSPACE_ID = '2ae856da-00cb-4594-a7e6-710f2011d0c3';

// Representative tasks, sized like the measured job classes (docs §1).
export const TASKS = Object.freeze({
  small: {
    title: 'Benchmark (small): unit tests for publishedTokenAllowance',
    objective: [
      'Add a new test file test/pool-registry-allowance.test.js for publishedTokenAllowance in src/model-gateway/agentic/pool-registry.js.',
      'Cover: a PUBLISHED tokensPerDay limit gives perDay and perMonth = perDay × 30; a tokensPerMonth-only limit gives perDay = round(month / 30);',
      'kind one-time gives 0/0; kind paid gives null/null; no limits gives null/null with basis UNKNOWN.',
      'Do not modify any file under src/. Run the new test file and make it pass.',
    ].join(' '),
    testCommand: 'node --test test/pool-registry-allowance.test.js',
  },
  medium: {
    title: 'Benchmark (medium): contract check for owner actions',
    objective: [
      'In src/model-gateway/agentic/owner-actions.js add an exported function ownerActionIssues(actions) that returns a list of problems:',
      'an action without steps, a set-secret step that does not match "sudo bash ops/set-secret.sh NAME", or a duplicate id.',
      'Add tests in a new file test/owner-actions-contract.test.js that call it on ownerActions() (expect no issues) and on three broken fixtures.',
      'Keep the existing behaviour unchanged. Run node --test test/owner-actions-contract.test.js test/capacity-model.test.js and make them pass.',
    ].join(' '),
    testCommand: 'node --test test/owner-actions-contract.test.js test/capacity-model.test.js',
  },
});

// Session config for one benchmark run. `allRouteIds` is the production pool
// (every other route is excluded so only the chosen ones can answer).
export function benchmarkConfig({ routes, allRouteIds, task = 'small', tier = null, drillAfterIteration = null }) {
  const spec = TASKS[task];
  if (!spec) throw new Error(`unknown task ${task}`);
  if (!Array.isArray(routes) || !routes.length || routes.length > 2) throw new Error('one route, or two for failover');
  const keep = new Set(routes);
  const excluded = allRouteIds.filter((id) => !keep.has(id));
  return {
    publish: 'none',
    dataClass: 'PUBLIC',
    codingTier: tier || task,
    allowPaid: false,
    testCommand: spec.testCommand,
    routing: { allowPaid: false, excludedRoutes: excluded.slice(0, 50) },
    ...(drillAfterIteration ? { drill: { failoverAfterIteration: drillAfterIteration } } : {}),
    benchmark: { routes, task, startedBy: 'coding-benchmark' },
  };
}

// Metrics of one finished session from its model_attempts rows (linked by
// the idempotency key prefix `<sessionId>:turn:`) and its session row.
export function sessionMetrics(session, attempts) {
  const byRoute = {};
  for (const row of attempts) {
    const id = `${row.provider}:${row.model}`;
    const entry = byRoute[id] ||= { calls: 0, succeeded: 0, failed: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, costUsd: 0 };
    entry.calls += 1;
    if (row.status === 'succeeded') entry.succeeded += 1; else entry.failed += 1;
    entry.inputTokens += Number(row.input_tokens || 0);
    entry.outputTokens += Number(row.output_tokens || 0);
    entry.durationMs += Number(row.duration_ms || 0);
    entry.costUsd += Number(row.cost_usd || 0);
  }
  const totals = Object.values(byRoute).reduce((sum, entry) => ({
    calls: sum.calls + entry.calls, failed: sum.failed + entry.failed,
    inputTokens: sum.inputTokens + entry.inputTokens, outputTokens: sum.outputTokens + entry.outputTokens,
    durationMs: sum.durationMs + entry.durationMs, costUsd: sum.costUsd + entry.costUsd,
  }), { calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, costUsd: 0 });
  const state = session.state || {};
  return {
    session: session.id, status: session.status, phase: session.phase, iterations: session.iteration,
    routesUsed: state.routesUsed || Object.keys(byRoute),
    switches: state.switches ?? session.provider_switches ?? null,
    drill: state.drill || null,
    filesChanged: state.filesChanged || [],
    lastTest: state.lastTest ? { exitCode: state.lastTest.exitCode, command: state.lastTest.command } : null,
    byRoute, totals, tokensPerJob: totals.inputTokens + totals.outputTokens,
    costUsd: Number(totals.costUsd.toFixed(6)),
  };
}

// Failover verdict: a switch happened, the second route continued the SAME
// session (no restart: iterations kept counting, files changed survive), the
// tests pass at the end, and it cost $0.
export function failoverVerdict(metrics, { primary, secondary }) {
  const used = metrics.routesUsed || [];
  const checks = {
    drillFired: Boolean(metrics.drill?.fired),
    bothRoutesAnswered: used.includes(primary) && used.includes(secondary),
    completed: metrics.status === 'completed',
    testsPass: metrics.lastTest?.exitCode === 0,
    filesChanged: metrics.filesChanged.length > 0,
    zeroCost: metrics.costUsd === 0,
  };
  return { ok: Object.values(checks).every(Boolean), checks };
}

async function client() {
  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function allRouteIds() {
  const { createModelPool } = await import('../src/model-gateway/agentic/model-pool.js');
  return createModelPool().map((route) => route.id);
}

async function start(db, { routes, task, drillAfterIteration = null }) {
  const config = benchmarkConfig({ routes, allRouteIds: await allRouteIds(), task, drillAfterIteration });
  const { data, error } = await db.rpc('create_coding_session', {
    p_workspace: WORKSPACE_ID, p_title: TASKS[task].title, p_objective: TASKS[task].objective, p_repository: PUBLIC_REPOSITORY,
    p_base_branch: 'main', p_budget_usd: 0.01, p_config: config, p_created_by: 'coding-benchmark',
  });
  if (error) throw new Error(`create_coding_session: ${error.message}`);
  return Array.isArray(data) ? data[0] : data;
}

async function report(db, sessionId) {
  const { data: session, error } = await db.from('agent_sessions').select('id,status,phase,iteration,provider_switches,state').eq('id', sessionId).single();
  if (error) throw new Error(error.message);
  const { data: attempts } = await db.from('model_attempts').select('provider,model,status,input_tokens,output_tokens,duration_ms,cost_usd')
    .like('idempotency_key', `${sessionId}:turn:%`);
  return sessionMetrics(session, attempts || []);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...rest] = process.argv.slice(2);
  const arg = (name) => rest.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) || null;
  const db = await client();
  if (command === 'start') console.log(JSON.stringify(await start(db, { routes: [arg('route')], task: arg('task') || 'small' }), null, 2));
  else if (command === 'failover') console.log(JSON.stringify(await start(db, { routes: [arg('primary'), arg('secondary')], task: arg('task') || 'small', drillAfterIteration: Number(arg('after') || 3) }), null, 2));
  else if (command === 'report') console.log(JSON.stringify(await report(db, arg('session')), null, 2));
  else console.log('usage: start --route=<id> [--task=small|medium] | failover --primary=<id> --secondary=<id> [--after=3] | report --session=<uuid>');
}
