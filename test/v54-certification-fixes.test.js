// Defects found by the V5.4 functional certification, each pinned by a test
// that reproduces what the live certification run showed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverablesBoard } from '../src/hub-deliverables.js';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minutes) => new Date(Date.UTC(2026, 9, 5, 21, 0) + minutes * 60_000).toISOString();
const brief = (stage, extra = {}) => JSON.stringify({ workflow: 'chief-research-chief', stage, ...extra });
const AGENTS = ['chief-of-staff', 'research-strategy', 'product-tech', 'brand-creative', 'business-finance', 'qa-security'].map((slug, index) => ({ id: id(900 + index), slug, name: slug }));
const agent = (slug) => AGENTS.find((row) => row.slug === slug).id;
const task = (n, slug, stage, status, extra = {}) => ({ id: id(n), job_id: id(100), agent_id: agent(slug), title: extra.title || `${slug} work`, status, brief: brief(stage, extra.brief), depends_on: [], sequence: extra.sequence ?? n, created_at: at(n), started_at: at(n), completed_at: status === 'done' ? at(n + 1) : null, not_before: null });
const output = (n, decisions) => ({ id: id(5000 + n), job_id: id(100), task_id: id(n), kind: 'task', summary: '', content: `## Summary\nWork ${n}.\n\n## Decisions for Fahad\n${decisions}`, created_at: at(n + 1) });
const VENUE = '1. Choose the venue: Alserkal Avenue or AstroLabs DMCC.';

function run(synthesisStatus, extraTasks = []) {
  const tasks = [
    ...extraTasks,
    task(10, 'chief-of-staff', 'chief_plan', 'done', { sequence: 10 }),
    task(20, 'research-strategy', 'specialist', 'done', { sequence: 100 }),
    task(21, 'product-tech', 'specialist', 'done', { sequence: 101 }),
    task(22, 'brand-creative', 'specialist', 'done', { sequence: 102 }),
    task(23, 'business-finance', 'specialist', 'done', { sequence: 103 }),
    task(24, 'qa-security', 'specialist', 'done', { sequence: 104 }),
    task(25, 'business-finance', 'specialist', 'done', { sequence: 500, brief: { revision: 'Reproducible model', revisesTaskId: id(23) } }),
    task(30, 'chief-of-staff', 'synthesis', synthesisStatus, { sequence: 950 }),
  ];
  const results = [20, 21, 22, 23, 24, 25].map((n) => output(n, VENUE));
  if (synthesisStatus === 'done') results.push(output(30, `${VENUE}\n2. Confirm the date.`));
  const artifacts = [
    { id: id(700), project_id: id(1), job_id: id(100), task_id: id(24), agent_slug: 'qa-security', type: 'audit_report', title: 'Plan review', data: { verdict: 'NEEDS WORK', findings: [] }, created_at: at(25) },
    { id: id(701), project_id: id(1), job_id: id(100), task_id: id(25), agent_slug: 'business-finance', type: 'financial_model', title: 'Budget', data: { items: [], validation: { state: 'VERIFIED' } }, created_at: at(26) },
  ];
  return deliverablesBoard({ project: { id: id(1), name: 'Certification' }, jobs: [{ id: id(100), title: 'Book-swap pop-up', status: synthesisStatus === 'done' ? 'completed' : 'running', created_at: at(0) }], tasks, agents: AGENTS, results, artifacts, reviews: [], now: Date.parse(at(60)) });
}

test('a decision CHIEF consolidated is one "needs you", not one per employee', () => {
  const view = run('done');
  const needs = view.deliverables.filter((item) => item.status === 'needs_fahad');
  assert.deepEqual(needs.map((item) => item.agent.key), ['chief'], 'only CHIEF’s final asks Fahad');
  assert.equal(view.summary.counts.needs_fahad, 1);
  const audit = view.deliverables.find((item) => item.agent.key === 'audit');
  assert.deepEqual([audit.status, audit.reason.code], ['needs_review', 'audit'], 'AUDIT keeps its own verdict');
  const finance = view.deliverables.find((item) => item.agent.key === 'finance');
  assert.deepEqual([finance.status, finance.version.number, finance.version.count], ['ready', 2, 2], 'the verified revision is the delivered version');
  for (const key of ['research', 'product', 'creative']) {
    const item = view.deliverables.find((entry) => entry.agent.key === key);
    assert.equal(item.status, 'ready', key);
    assert.match(item.decisions, /Choose the venue/, `${key} still shows the decision it proposed`);
  }
});

test('before CHIEF consolidates, an employee’s decision is still raised', () => {
  const view = run('running');
  const research = view.deliverables.find((item) => item.agent.key === 'research');
  assert.deepEqual([research.status, research.reason.code], ['needs_fahad', 'decision']);
});

test('a CHIEF review that only asked for revisions does not hide the employees’ decisions', () => {
  // The workflow creates the final synthesis (sequence 950) before the review
  // (sequence 900) completes, so the final is the objective's last CHIEF step.
  for (const finalStatus of ['queued', 'failed']) {
    const view = run(finalStatus, [task(29, 'chief-of-staff', 'synthesis', 'done', { sequence: 900, title: 'Chief synthesis' })]);
    const research = view.deliverables.find((item) => item.agent.key === 'research');
    assert.deepEqual([research.status, research.reason.code], ['needs_fahad', 'decision'], `final ${finalStatus}: the decision is still raised`);
  }
});

test('creating a project from the Hub works and inherits the template’s free routes', async () => {
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(new URL('../supabase/migrations/20261005220000_create_hub_project_fix.sql', import.meta.url), 'utf8');
  const body = sql.slice(sql.indexOf('as $$'), sql.lastIndexOf('$$;'));
  // RETURNS TABLE (id, name) makes "name" and "id" variables: no query may read them unqualified.
  assert.doesNotMatch(body, /from public\.projects where name/, 'the ambiguous reference is gone');
  for (const match of body.matchAll(/from public\.(\w+) (\w+)\b/g)) assert.notEqual(match[2], 'where', `${match[1]} is read through an alias`);
  assert.match(body, /from public\.workspace_provider_permissions pp\s+where pp\.workspace_id = v_template and pp\.enabled;/, 'every enabled template route is inherited');
  assert.doesNotMatch(body, /provider in \('anthropic', 'deepseek'\)/, 'free routes are no longer dropped');
  assert.match(body, /least\(v_policy\.monthly_budget_usd, 0\.50\)/, 'the new project budget cap is unchanged');
  assert.match(body, /decision in \('auto', 'approval'\)/, 'denied tools are never copied');
  assert.match(sql, /revoke all on function public\.create_hub_project\(text\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.create_hub_project\(text\) to service_role;/);
  assert.ok(readFileSync(new URL('../supabase/verify/scenarios/create_hub_project.sql', import.meta.url), 'utf8').includes("create_hub_project('  Pop-up plan  ')"), 'the replay calls the function for real');
});

test('a monthly budget whose period ended rolls over once and is re-read', async () => {
  const { SupabaseWorkspacePolicyStore, rollExpiredBudgetPeriod } = await import('../src/workspace-policy/supabase-store.js');
  const WS = id(77);
  const row = { workspace_id: WS, enabled: true, version: 7, monthly_budget_usd: 2, max_request_budget_usd: 0.1, spent_usd: 1.94, reserved_usd: 0, budget_period_start: '2026-09-01T00:00:00Z', budget_period_end: '2026-10-01T00:00:00Z' };
  const calls = [];
  const db = {
    from: (table) => {
      const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: { ...row }, error: null }), then: (resolve) => resolve({ data: [], error: null }) };
      if (table !== 'workspace_policies') return query;
      return query;
    },
    rpc: async (name, args) => {
      calls.push([name, args]);
      Object.assign(row, { spent_usd: 0, version: 8, budget_period_start: '2026-10-01T00:00:00Z', budget_period_end: '2026-11-01T00:00:00Z' });
      return { data: true, error: null };
    },
  };
  const policy = await new SupabaseWorkspacePolicyStore(db).getPolicy(WS);
  assert.deepEqual(calls, [['roll_workspace_budget_period', { p_workspace: WS }]], 'rolled exactly once');
  assert.deepEqual([policy.budget.spentUsd, policy.budget.periodEnd, policy.version], [0, '2026-11-01T00:00:00Z', 8], 'the re-read shows this month');

  // A concurrent reader already rolled the period: re-read rather than keep last month's numbers.
  assert.equal(await rollExpiredBudgetPeriod({ rpc: async () => ({ data: false, error: null }) }, WS, '2026-10-01T00:00:00Z'), true);
  // A current period never calls the database; a missing function changes nothing.
  assert.equal(await rollExpiredBudgetPeriod({ rpc: () => { throw new Error('must not be called'); } }, WS, '2999-01-01T00:00:00Z'), false);
  assert.equal(await rollExpiredBudgetPeriod({ rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'function not found' } }) }, WS, '2026-10-01T00:00:00Z'), false);
  assert.equal(await rollExpiredBudgetPeriod({ rpc: async () => { throw new Error('network'); } }, WS, '2026-10-01T00:00:00Z'), false);

  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(new URL('../supabase/migrations/20261005230000_workspace_budget_rollover.sql', import.meta.url), 'utf8');
  assert.match(sql, /and now\(\) >= wp\.budget_period_end;/, 'only an ended period rolls');
  assert.doesNotMatch(sql.slice(sql.indexOf('as $$'), sql.lastIndexOf('$$;')), /reserved_usd\s*=/, 'in-flight reservations are never reset');
  assert.match(sql, /revoke all on function public\.roll_workspace_budget_period\(uuid\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.roll_workspace_budget_period\(uuid\) to service_role;/);
});

test('each runtime start records its version so production is observable without /healthz', async () => {
  const { runtimeStartedEvent, recordRuntimeStart } = await import('../src/ops/runtime-started.js');
  const event = runtimeStartedEvent({ version: 'bbc5956c15d3', fingerprint: 'bd99390db5bf1fd2', pid: 42, startedAt: '2026-10-05T20:09:24.000Z' });
  assert.deepEqual(event.payload, { kind: 'runtime_started', version: 'bbc5956c15d3', codeFingerprint: 'bd99390db5bf1fd2', pid: 42, startedAt: '2026-10-05T20:09:24.000Z', versionConfirmed: true });
  assert.equal(event.type, 'activity');
  const inserted = [];
  assert.equal(await recordRuntimeStart({ from: () => ({ insert: async (row) => { inserted.push(row); return { error: null }; } }) }, () => {}, { fingerprint: 'f', pid: 1, path: '/nonexistent/deployed-sha', waitMs: 0 }), true);
  assert.equal(inserted[0].payload.kind, 'runtime_started');
  const logs = [];
  assert.equal(await recordRuntimeStart({ from: () => ({ insert: async () => { throw new Error('offline'); } }) }, (...parts) => logs.push(parts.join(' ')), { fingerprint: null, pid: 1, path: '/nonexistent/deployed-sha', waitMs: 0 }), false, 'a failed write never throws');
  assert.match(logs[0], /runtime start not recorded/);
  const { readFileSync } = await import('node:fs');
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(index, /await checkHealth\(\);\n\s+\/\/ The running version and every restart, readable from the database\.\n\s+recordRuntimeStart\(db, log\);/, 'recorded after the readiness check, without blocking start-up');
});
