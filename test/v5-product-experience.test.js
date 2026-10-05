import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { commandCenter } from '../src/hub-office.js';
import { taskView } from '../src/hub-workspace.js';
import { capacitySentence, healthFacts, latestResults, ownerWorkCounts, progressWidth, projectFacts } from '../src/hub-ui/owner-facts.js';

const read = (name) => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');

test('V5 owner shell exposes the nine requested product areas and Arabic-first RTL', () => {
  const index = read('src/hub-ui/index.html');
  assert.match(index, /<html lang="ar" dir="rtl">/);
  for (const nav of ['home', 'projects', 'employees', 'work', 'attention', 'continuity', 'models', 'artifacts', 'settings']) {
    assert.match(index, new RegExp(`data-nav="${nav}"`), nav);
  }
  assert.match(index, /data-i18n="askChief"/);
  const app = read('src/hub-ui/app.js');
  assert.match(app, /localStorage\.getItem\('hub-language'\) \|\| 'ar'/);
  assert.match(app, /document\.documentElement\.dir = value === 'ar' \? 'rtl' : 'ltr'/);
  assert.match(app, /data-language="ar"/);
  assert.match(app, /data-language="en"/);
});

test('Home is composed only from real owner APIs and keeps models as execution details', () => {
  const app = read('src/hub-ui/app.js');
  for (const endpoint of ['/api/command-center', '/api/attention', '/api/office', '/api/capacity', '/api/platform', '/api/tasks']) assert.ok(app.includes(endpoint), endpoint);
  assert.match(app, /function renderHome\(/);
  assert.match(app, /A model is an execution engine, never an employee identity/);
  assert.doesNotMatch(app, /demo project|sample task|fake capacity/i);
});

test('Approvals show safe facts and decide through the existing owner RPC endpoint', () => {
  const app = read('src/hub-ui/app.js');
  assert.match(app, /\/api\/approvals\$\{q\(/);
  assert.match(app, /data-approval-decision="approved"/);
  assert.match(app, /data-approval-decision="rejected"/);
  assert.match(app, /estimatedCostUsd/);
  assert.match(app, /arguments_preview/);
  assert.doesNotMatch(app, /JSON\.stringify\(approval\.arguments_preview/);
});

test('Continuity and platform keep technical state behind advanced disclosures', () => {
  const project = read('src/hub-ui/project.js');
  const app = read('src/hub-ui/app.js');
  assert.match(project, /Advanced details and controls/);
  assert.match(project, /Last checkpoint/);
  assert.match(project, /Next action/);
  assert.match(project, /Handoff history/);
  assert.match(app, /Provider and key status/);
  assert.match(app, /Secret values are never returned/);
  execFileSync(process.execPath, ['--check', fileURLToPath(new URL('../src/hub-ui/app.js', import.meta.url))]);
});

test('running counts keep employees on an objective out of the running total', () => {
  const counts = ownerWorkCounts({
    jobs: [{ id: 'goal', status: 'running' }, { id: 'done', status: 'completed' }],
    tasks: [{ id: 'child', group: 'attention', jobId: 'goal' }, { id: 'solo', group: 'running', jobId: null }],
    agents: [
      { state: 'WORKING', assignment: { jobId: 'goal' } },
      { state: 'REVIEWING', assignment: { jobId: 'goal' } },
      { state: 'WORKING', assignment: { sessionId: 'solo' } },
    ],
  });
  assert.equal(counts.objectives, 1);
  assert.equal(counts.coding, 1);
  assert.equal(counts.running, 2);
  assert.equal(counts.employeesOnObjectives, 2);
  assert.notEqual(counts.running, counts.objectives + counts.employeesOnObjectives);
});

test('latest results collapse the same job or task and unknown numbers stay unknown', () => {
  const latest = latestResults({
    attention: [{ title: 'Launch', jobId: 'j', at: '2026-10-05T01:00:00Z', priority: 'INFO' }, { title: 'Fix', taskId: 't', at: '2026-10-05T02:00:00Z' }],
    jobs: [{ id: 'j', status: 'completed', title: 'Launch', completed_at: '2026-10-05T01:00:00Z' }],
    tasks: [{ id: 't', group: 'completed', title: 'Fix', completedAt: '2026-10-05T02:00:00Z', jobId: 'j' }],
  });
  assert.deepEqual(latest.map((item) => item.title), ['Fix', 'Launch']);
  assert.equal(projectFacts({}).cost, null);
  assert.equal(projectFacts({ center: { objectives: { active: [] }, costUsd: 0, status: 'NO ACTIVITY' }, stats: { tasks: 0, completedTasks: 0 } }).cost, 0);
  assert.equal(projectFacts({ center: { objectives: { active: [] }, costUsd: null, status: 'UP TO DATE' } }).active, 0);
  assert.equal(projectFacts({}).state, 'unavailable');
  assert.equal(healthFacts({}).state, 'unavailable');
  assert.equal(healthFacts({ health: { ok: false }, platform: { systemHealth: { database: 'ok' } } }).state, 'unhealthy');
  assert.equal(healthFacts({ health: { ok: true }, platform: { systemHealth: { hub: 'ok', database: 'ok' } } }).state, 'healthy');
  assert.equal(progressWidth(0), 0);
  assert.equal(progressWidth(null), 0);
  assert.equal(capacitySentence(null, 'ar'), null);
  const view = commandCenter({ project: { id: 'p', name: 'Harbor' }, live: { jobs: [], tasks: [], sessions: [], approvals: [] }, states: new Map(), costs: null });
  assert.equal(view.costUsd, null);
  const session = { id: 's', status: 'running', phase: 'implement', budget_usd: 2, created_at: '2026-10-05T00:00:00Z', updated_at: '2026-10-05T00:01:00Z', state: {}, config: {} };
  assert.equal(taskView({ ...session, spent_usd: null }).metrics.costUsd, null);
  assert.equal(taskView({ ...session, spent_usd: 0 }).metrics.costUsd, 0);
});
