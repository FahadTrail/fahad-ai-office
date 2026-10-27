import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ROSTER, arabicCount, archiveFilter, codingSessionState, createRefresher, deliveryProgress, fractionLabel, livingDashboard, objectiveSignature, employeeColor, employeeState, employeeTabs, fractionWidth, greeting, jobStatus, numericDate, outputTypes, workflowMap, workflowMetrics,
} from '../src/hub-ui/office-model.js';
import { startPreview } from '../tools/hub-preview.mjs';

const file = (name) => fileURLToPath(new URL(`../src/hub-ui/${name}`, import.meta.url));
const read = (name) => readFileSync(file(name), 'utf8');
const node = (kind, state, extra = {}) => ({ kind, state, agentSlug: extra.agentSlug || `agent-${Math.random()}`, ...extra });

test('the redesign modules are valid scripts', () => {
  for (const name of ['screens.js', 'office-model.js', 'app.js']) execFileSync(process.execPath, ['--check', file(name)]);
});

test('job status follows the derived lifecycle first and never invents a known state', () => {
  assert.equal(jobStatus({ status: 'running', lifecycle: 'NEEDS_OWNER' }).key, 'needs');
  assert.equal(jobStatus({ status: 'running', lifecycle: 'WAITING' }).key, 'waiting');
  assert.equal(jobStatus({ status: 'planning' }).key, 'planning');
  assert.equal(jobStatus({ lifecycle: 'CANCELLED' }).label, 'ملغاة');
  assert.equal(jobStatus({ status: 'failed' }, 'en').label, 'Failed');
  const unknown = jobStatus({ status: 'mystery' });
  assert.equal(unknown.key, 'unknown');
  assert.equal(unknown.label, 'mystery', 'an unknown stored status is shown as-is');
});

test('delivery progress counts real assignment units only', () => {
  const nodes = [
    node('plan', 'done'),
    node('workstream', 'done', { agentSlug: 'research-strategy' }),
    node('workstream', 'done', { agentSlug: 'product-tech' }),
    node('workstream', 'working', { agentSlug: 'business-finance' }),
    node('development', 'capacity', { agentSlug: 'coding-agent' }),
    node('workstream', 'failed', { agentSlug: 'legal-compliance' }),
    node('consult', 'done', { agentSlug: 'qa-security' }),
    node('synthesis', 'waiting'),
  ];
  const progress = deliveryProgress(nodes, { jobStatus: 'running' });
  assert.deepEqual([progress.total, progress.delivered, progress.working, progress.capacity, progress.failed], [5, 2, 1, 1, 1]);
  assert.equal(progress.phase, 'delivering');
  assert.equal(fractionWidth(progress), 40);
});

test('an open revision is not delivered, all delivered waits for CHIEF, and a final report is done', () => {
  const base = [node('workstream', 'done', { agentSlug: 'product-tech' }), node('workstream', 'done', { agentSlug: 'business-finance' })];
  const revising = deliveryProgress([...base, node('workstream', 'working', { agentSlug: 'product-tech', revision: true }), node('synthesis', 'waiting')], { jobStatus: 'running' });
  assert.equal(revising.delivered, 1);
  assert.equal(revising.revising, 1);
  assert.equal(deliveryProgress([...base, node('synthesis', 'waiting')], { jobStatus: 'running' }).phase, 'awaiting_synthesis');
  assert.equal(deliveryProgress([...base, node('synthesis', 'working')], { jobStatus: 'running' }).phase, 'synthesizing');
  assert.equal(deliveryProgress([...base, node('synthesis', 'done')], { final: { content: 'x' }, jobStatus: 'completed' }).phase, 'done');
});

test('without delegated units there is no fraction, only a truthful phase', () => {
  const planning = deliveryProgress([node('plan', 'working')], { jobStatus: 'planning' });
  assert.equal(planning.fraction, false);
  assert.equal(planning.phase, 'planning');
  assert.equal(fractionWidth(planning), null, 'no bar is drawn without units');
  assert.equal(deliveryProgress([node('plan', 'done')], { jobStatus: 'running' }).phase, 'chief');
  assert.equal(deliveryProgress([], { jobStatus: 'cancelled' }).phase, 'cancelled');
});

test('employee tabs group by employee and exclude CHIEF plan and synthesis', () => {
  const tabs = employeeTabs([
    { kind: 'plan', state: 'done', agentSlug: 'chief-of-staff' },
    { kind: 'workstream', state: 'done', agentSlug: 'product-tech', agentLabel: 'PRODUCT' },
    { kind: 'workstream', state: 'working', agentSlug: 'product-tech', agentLabel: 'PRODUCT', revision: true },
    { kind: 'workstream', state: 'failed', agentSlug: 'legal-compliance', agentLabel: 'LEGAL' },
    { kind: 'synthesis', state: 'waiting', agentSlug: 'chief-of-staff' },
  ]);
  assert.deepEqual(tabs.map((tab) => [tab.slug, tab.nodes.length, tab.state]), [['product-tech', 2, 'working'], ['legal-compliance', 1, 'failed']]);
});

test('the visual workflow map draws only recorded dependency edges and caps its surface', () => {
  const nodes = [
    { id: 'plan', title: 'Plan', kind: 'plan', state: 'done', agentSlug: 'chief-of-staff', dependsOn: [] },
    { id: 'research', title: 'Research', kind: 'workstream', state: 'done', agentSlug: 'research-strategy', dependsOn: ['plan'] },
    { id: 'product', title: 'Product', kind: 'workstream', state: 'working', agentSlug: 'product-tech', dependsOn: ['research', 'missing'] },
    { id: 'synthesis', title: 'Synthesis', kind: 'synthesis', state: 'waiting', agentSlug: 'chief-of-staff', dependsOn: ['product'] },
  ];
  const map = workflowMap(nodes);
  assert.deepEqual(map.edges.map((edge) => `${edge.from}>${edge.to}`), ['plan>research', 'research>product', 'product>synthesis']);
  assert.equal(map.edges.find((edge) => edge.to === 'product').active, true, 'a working destination is the only animated edge');
  assert.deepEqual(map.nodes.map((entry) => entry.level), [0, 1, 2, 3]);
  const capped = workflowMap(nodes, { maxNodes: 2 });
  assert.equal(capped.hidden, 2);
  assert.deepEqual(capped.edges.map((edge) => `${edge.from}>${edge.to}`), ['plan>research'], 'no edge points at a hidden card');
});

test('workflow charts count real assignment rows and report honest empty states', () => {
  const metrics = workflowMetrics([
    { kind: 'plan', state: 'done', agentSlug: 'chief-of-staff' },
    { kind: 'workstream', state: 'done', agentSlug: 'research-strategy', agentLabel: 'RESEARCH' },
    { kind: 'workstream', state: 'working', agentSlug: 'product-tech', agentLabel: 'PRODUCT' },
    { kind: 'development', state: 'capacity', agentSlug: 'coding-agent', agentLabel: 'CODING' },
    { kind: 'workstream', state: 'blocked', agentSlug: 'legal-compliance', agentLabel: 'LEGAL' },
    { kind: 'synthesis', state: 'waiting', agentSlug: 'chief-of-staff' },
  ], [{}, {}]);
  assert.equal(metrics.total, 4);
  assert.deepEqual(metrics.statuses, { done: 1, working: 1, waiting: 0, capacity: 1, failed: 1 });
  assert.equal(metrics.handoffs, 2);
  assert.deepEqual(workflowMetrics([], []).employees, []);
});

test('the living dashboard rolls up only recorded assignments, dependencies, handoffs and activity', () => {
  const workflow = {
    nodes: [
      { id: 'plan', kind: 'plan', state: 'done', agentSlug: 'chief-of-staff', dependsOn: [] },
      { id: 'research', kind: 'workstream', state: 'done', agentSlug: 'research-strategy', agentLabel: 'RESEARCH', dependsOn: ['plan'] },
      { id: 'product', kind: 'workstream', state: 'working', agentSlug: 'product-tech', agentLabel: 'PRODUCT', dependsOn: ['research', 'missing'] },
      { id: 'synthesis', kind: 'synthesis', state: 'waiting', agentSlug: 'chief-of-staff', dependsOn: ['product'] },
    ],
    handoffs: [{ from: 'CHIEF', to: 'RESEARCH' }, { from: 'RESEARCH', to: 'PRODUCT' }],
  };
  const dashboard = livingDashboard({
    objectives: [{ id: 'job' }], workflows: [workflow], attentionCount: 1,
    agents: [{ slug: 'chief-of-staff', state: 'THINKING' }, { slug: 'research-strategy', state: 'AVAILABLE' }, { slug: 'product-tech', state: 'WORKING' }],
    timeline: [{ kind: 'detail', technical: true }, { kind: 'assigned', technical: false, who: 'PRODUCT' }],
  });
  assert.deepEqual([dashboard.objectives, dashboard.assignments, dashboard.delivered, dashboard.relationships, dashboard.handoffs, dashboard.attention], [1, 2, 1, 3, 2, 1]);
  assert.deepEqual(dashboard.states, { done: 1, working: 1, waiting: 0, capacity: 0, failed: 0 });
  assert.deepEqual([dashboard.team.busy, dashboard.team.available], [2, 1]);
  assert.equal(dashboard.activity.length, 1, 'technical activity stays out of the quiet timeline');
});

test('employee states are honest: idle is available, CHIEF coordinates, a delivery is سلّم', () => {
  assert.equal(employeeState({ slug: 'research-strategy', state: 'AVAILABLE' }).label, 'متاح');
  assert.equal(employeeState({ slug: 'research-strategy' }).key, 'available');
  assert.equal(employeeState({ slug: 'chief-of-staff', state: 'THINKING' }).label, 'ينسّق');
  assert.equal(employeeState({ slug: 'business-finance', state: 'WORKING' }).label, 'يعمل');
  assert.equal(employeeState({ slug: 'product-tech', state: 'COMPLETED' }).label, 'سلّم');
  assert.equal(employeeState({ slug: 'content-media', state: 'WAITING' }).label, 'بانتظار');
  assert.equal(employeeState({ slug: 'coding-agent', state: 'NEEDS FAHAD' }, 'en').label, 'Needs you');
});

test('employee colours are UI tokens keyed by slug with a neutral fallback', () => {
  assert.equal(employeeColor('chief-of-staff'), 'var(--emp-chief)');
  assert.equal(employeeColor('retired-role'), 'var(--emp-neutral)');
  assert.equal(ROSTER.length, 9);
  const css = read('app.css');
  for (const key of ['chief', 'research', 'product', 'finance', 'coding', 'audit', 'social', 'creative', 'legal', 'neutral']) assert.equal((css.match(new RegExp(`--emp-${key}:`, 'g')) || []).length, 3, key);
});

test('greeting, counts, dates and output types', () => {
  assert.equal(greeting(9), 'صباح الخير، فهد');
  assert.equal(greeting(20), 'مساء الخير، فهد');
  assert.equal(greeting(15, 'en'), 'Good afternoon, Fahad');
  assert.equal(arabicCount(2, ['طلب واحد', 'طلبان', 'طلبات', 'طلبًا']), 'طلبان');
  assert.equal(arabicCount(5, ['طلب واحد', 'طلبان', 'طلبات', 'طلبًا']), '5 طلبات');
  assert.match(numericDate('2026-10-22T10:05:00'), /^2026-10-22 10:05$/);
  assert.equal(numericDate('not a date'), '');
  assert.deepEqual(outputTypes([]), ['REPORT']);
  assert.deepEqual(outputTypes([{ type: 'kanban' }, { type: 'brand_new_type' }]), ['BOARD', 'BRAND NEW TYPE']);
});

test('archive filters narrow by date and employee and hide tests unless asked', () => {
  const items = [
    { id: 'a', closedAt: '2026-10-01T10:00:00', participants: [{ slug: 'business-finance' }], classification: { class: 'REAL' } },
    { id: 'b', closedAt: '2026-10-05T10:00:00', participants: [{ slug: 'legal-compliance' }], classification: { class: 'REAL' } },
    { id: 't', closedAt: '2026-10-05T10:00:00', participants: [], classification: { class: 'TEST' } },
  ];
  assert.deepEqual(archiveFilter(items).map((item) => item.id), ['a', 'b']);
  assert.deepEqual(archiveFilter(items, { includeTests: true }).map((item) => item.id), ['a', 'b', 't']);
  assert.deepEqual(archiveFilter(items, { from: '2026-10-02' }).map((item) => item.id), ['b']);
  assert.deepEqual(archiveFilter(items, { to: '2026-10-01' }).map((item) => item.id), ['a']);
  assert.deepEqual(archiveFilter(items, { employee: 'legal-compliance' }).map((item) => item.id), ['b']);
});

test('the shell has the four-screen navigation and keeps every legacy destination reachable', () => {
  const index = read('index.html');
  assert.match(index, /class="brand-mark" aria-hidden="true">ف</);
  assert.match(index, /مكتب فهد/);
  assert.match(index, /href="#\/" data-nav="home"[^>]*>.*المكتب/s);
  assert.match(index, /href="#\/archive" data-nav="archive"/);
  assert.match(index, /class="nav-icon nav-gear" href="#\/settings"[^>]*aria-label="Settings"/);
  for (const hash of ['#/chief', '#/projects', '#/deliverables', '#/work', '#/chats', '#/artifacts', '#/office', '#/employees', '#/attention', '#/models', '#/continuity', '#/integrations']) assert.ok(index.includes(`href="${hash}"`), hash);
  const app = read('app.js');
  for (const route of ["archive: renderArchive", "job: () => renderJob(id)", "workflow: () => renderJob(id)", "attention: () => renderSettingsSection('approvals')", "employees: () => renderSettingsSection('team')", "integrations: () => renderSettingsSection('tools')", "models: () => renderSettingsSection('models')"]) assert.ok(app.includes(route), route);
  for (const section of ['team', 'approvals', 'models', 'coding', 'tools', 'health', 'appearance']) assert.match(app, new RegExp(`key: '${section}'`));
});

test('the screens use the existing APIs and write only through the existing conversation endpoints', () => {
  const screens = read('screens.js');
  for (const endpoint of ['/api/work/current', '/api/work/history', '/api/work/objectives/', '/api/workflows/', '/api/operations', '/api/attention', '/api/office', '/api/work/sessions', "'/api/conversations'", '/messages', '/stop']) assert.ok(screens.includes(endpoint), endpoint);
  const writes = [...screens.matchAll(/method: '(POST|PATCH|PUT|DELETE)'/g)].length;
  assert.equal(writes, 4, 'submit, Reply & Continue, Stop, and the owner recovery action only');
  assert.ok(screens.includes('/api/jobs/${job.id}/${action}'), 'the owner recovery action (resume / stop one objective)');
  assert.match(screens, /objectiveAction\(job, 'resume'/);
  assert.match(screens, /objectiveAction\(job, 'stop'/);
  assert.doesNotMatch(screens, /Math\.random|demo|sample|placeholder result|fake/i);
});

test('the premium stylesheet uses tokens only and honours motion, transparency and contrast preferences', () => {
  const css = read('premium.css');
  assert.deepEqual(css.match(/#[0-9a-f]{3,8}\b/gi) || [], [], 'no raw colours outside the token blocks');
  assert.match(css, /scale\(\.97\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(prefers-reduced-transparency: reduce\)/);
  assert.match(css, /@media \(prefers-contrast: more\)/);
  assert.match(css, /backdrop-filter: var\(--blur\)/);
  assert.doesNotMatch(css.match(/\.material \{[^}]+\}/s)?.[0] || '', /backdrop-filter/, 'content cards are solid; glass is for navigation and overlays');
  assert.match(css, /\.workflow-map/);
  assert.match(css, /\.app-dialog/);
  assert.doesNotMatch(css, /transition: all/);
  const tokens = read('app.css');
  assert.match(tokens, /--blur: saturate\(180%\) blur\(20px\)/);
  assert.match(tokens, /font-family: "JetBrains Mono"/);
});

test('V2.1 keeps the true-data visuals, employee sheets and owner confirmation in the frontend boundary', () => {
  const screens = read('screens.js');
  const app = read('app.js');
  assert.match(screens, /workflowMap\(workflow\.nodes, \{ maxNodes: 24 \}\)/);
  assert.match(screens, /Every line below is a recorded dependency/);
  assert.match(screens, /data-employee-sheet/);
  assert.match(app, /Confirm approval/);
  assert.match(app, /Every other owner gate remains in place/);
});

test('V2.2 makes the homepage a bounded real-data dashboard without adding writes', () => {
  const screens = read('screens.js');
  const css = read('premium.css');
  assert.match(screens, /livingDashboard\(\{ objectives, workflows, agents, attentionCount, timeline:/);
  assert.match(screens, /workflowMap\(workflow\?\.nodes \|\| \[\], \{ maxNodes: 10 \}\)/);
  assert.match(screens, /data-dashboard-employee/);
  assert.match(screens, /The flow below uses recorded dependencies only/);
  assert.match(screens, /class="living-dashboard"/);
  assert.match(css, /\.dashboard-kpis/);
  assert.match(css, /\.activity-list/);
  assert.match(css, /\.flow-step\.is-live/);
  assert.doesNotMatch(screens, /setInterval\(/, 'the page keeps the existing visibility-aware refresher');
});

test('preview: history and job detail come from the real handlers over fictional rows', async () => {
  const { server, url } = await startPreview({ port: 0, moment: 'history' });
  try {
    const ws = '11111111-1111-4111-8111-111111111111';
    const history = await (await fetch(`${url}api/work/history?workspaceId=${ws}`)).json();
    const lifecycles = new Set(history.objectives.map((item) => item.lifecycle));
    for (const value of ['COMPLETED', 'FAILED', 'CANCELLED']) assert.ok(lifecycles.has(value), value);
    const current = await (await fetch(`${url}api/work/current?workspaceId=${ws}`)).json();
    assert.ok(![...current.active, ...current.waiting, ...current.needsOwner].some((item) => ['completed', 'failed', 'cancelled'].includes(item.status)), 'terminal jobs are not active work');
    const failed = await (await fetch(`${url}api/workflows/b0000000-0000-4000-8000-000000000004`)).json();
    const progress = deliveryProgress(failed.nodes, { final: failed.final, jobStatus: failed.job.status });
    assert.deepEqual([progress.total, progress.delivered, progress.failed, progress.phase], [1, 0, 1, 'failed']);
  } finally {
    server.close();
  }
});

test('a stored blocked status is not owner attention; only NEEDS_OWNER or waiting_approval is', () => {
  const blocked = jobStatus({ status: 'blocked' });
  assert.equal(blocked.key, 'blocked');
  assert.equal(blocked.label, 'متوقف');
  assert.notEqual(blocked.tone, 'alert');
  assert.equal(jobStatus({ status: 'blocked', lifecycle: 'WAITING' }).key, 'waiting', 'the backend lifecycle for a plain blocked job');
  assert.equal(jobStatus({ status: 'blocked', lifecycle: 'NEEDS_OWNER' }).key, 'needs', 'a real approval or question');
  assert.equal(jobStatus({ status: 'waiting_approval' }).key, 'needs');
});

test('coding sessions need Fahad only for a real approval or question, never for a plain or capacity block', () => {
  const capacity = codingSessionState({ id: 's1', status: 'blocked', phase: 'test' }, [{ kind: 'blocked', taskId: 's1' }]);
  assert.equal(capacity.needs, false);
  assert.equal(jobStatus(capacity.status).key, 'blocked');
  assert.equal(capacity.phase, 'يشغّل الاختبارات');
  assert.equal(codingSessionState({ id: 's2', status: 'blocked' }, [{ kind: 'question', taskId: 's2' }]).needs, true);
  assert.equal(codingSessionState({ id: 's3', status: 'awaiting_approval' }, []).needs, true);
  assert.equal(codingSessionState({ id: 's4', status: 'running' }, [{ kind: 'approval', taskId: 'other' }]).needs, false);
  assert.equal(jobStatus(codingSessionState({ id: 's5', status: 'queued' }, []).status).key, 'waiting');
});

test('several assignments for one employee count separately; a revision changes only the assignment it revises', () => {
  const nodes = [
    { id: 'p1', kind: 'workstream', state: 'done', agentSlug: 'product-tech', dependsOn: [] },
    { id: 'p2', kind: 'workstream', state: 'done', agentSlug: 'product-tech', dependsOn: [] },
    { id: 'f1', kind: 'workstream', state: 'done', agentSlug: 'business-finance', dependsOn: [] },
    { id: 's1', kind: 'synthesis', state: 'done', dependsOn: ['p1', 'p2', 'f1'] },
    { id: 'r1', kind: 'workstream', state: 'working', agentSlug: 'product-tech', revision: true, dependsOn: ['p2', 's1'] },
    { id: 's2', kind: 'synthesis', state: 'waiting', dependsOn: ['p1', 'r1', 'f1'] },
  ];
  const progress = deliveryProgress(nodes, { jobStatus: 'running' });
  assert.deepEqual([progress.total, progress.delivered, progress.revising, progress.failed], [3, 2, 1, 0]);
  assert.equal(progress.phase, 'revising', 'round one is done but the final synthesis is not');
  assert.equal(progress.synthesis, 'pending');
  assert.equal(fractionLabel(progress), 'سُلّم 2 من 3 تكليفات');
  assert.equal(fractionLabel(progress, 'en'), '2 of 3 assignments delivered');
  assert.equal(fractionLabel(deliveryProgress([{ kind: 'plan', state: 'working' }])), '', 'no units, no fraction label');
});

test('a failed revision is failed, a finished revision is delivered, an unplaceable revision is not guessed', () => {
  const base = [{ id: 'p1', kind: 'workstream', state: 'done', agentSlug: 'product-tech', dependsOn: [] }, { id: 'p2', kind: 'workstream', state: 'done', agentSlug: 'product-tech', dependsOn: [] }];
  const failed = deliveryProgress([...base, { id: 'r1', kind: 'workstream', state: 'failed', agentSlug: 'product-tech', revision: true, dependsOn: ['p1'] }], { jobStatus: 'running' });
  assert.deepEqual([failed.delivered, failed.failed, failed.revising], [1, 1, 0]);
  const done = deliveryProgress([...base, { id: 'r1', kind: 'workstream', state: 'done', agentSlug: 'product-tech', revision: true, dependsOn: ['p1'] }], { jobStatus: 'running' });
  assert.deepEqual([done.delivered, done.total], [2, 2]);
  const ambiguous = deliveryProgress([...base, { id: 'r1', kind: 'workstream', state: 'working', agentSlug: 'product-tech', revision: true }], { jobStatus: 'running' });
  assert.deepEqual([ambiguous.delivered, ambiguous.revising, ambiguous.untrackedRevisions], [2, 0, 1]);
  const single = deliveryProgress([base[0], { id: 'r1', kind: 'workstream', state: 'working', agentSlug: 'product-tech', revision: true }], { jobStatus: 'running' });
  assert.equal(single.revising, 1, 'without a link, a single assignment for that employee is unambiguous');
});

test('the refresher runs one load at a time, coalesces triggers, pauses while hidden and polls slowly when live', async () => {
  let clock = 0;
  let hidden = false;
  let runs = 0;
  let release;
  const refresher = createRefresher(() => { runs += 1; return new Promise((resolve) => { release = resolve; }); }, { hidden: () => hidden, now: () => clock, connectedEvery: 120, disconnectedEvery: 30 });
  const first = refresher.trigger();
  refresher.trigger(); refresher.trigger();
  await Promise.resolve();
  assert.equal(runs, 1, 'no parallel load');
  release(); await first; await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 2, 'three triggers during one load cause exactly one follow-up');
  release(); await new Promise((resolve) => setImmediate(resolve));
  refresher.setConnected(true);
  clock = 60; await refresher.tick();
  assert.equal(runs, 2, 'live stream: no poll before the slow interval');
  refresher.setConnected(false);
  const polled = refresher.tick(); await new Promise((resolve) => setImmediate(resolve)); release(); await polled;
  assert.equal(runs, 3, 'disconnected: polls after the short interval');
  hidden = true; clock = 1000;
  await refresher.trigger(); await refresher.tick();
  assert.equal(runs, 3, 'nothing loads while hidden');
  hidden = false;
  const caughtUp = refresher.visible(); await new Promise((resolve) => setImmediate(resolve)); release(); await caughtUp;
  assert.equal(runs, 4, 'one catch-up when visible again');
  await refresher.visible();
  assert.equal(runs, 4, 'no second catch-up');
  refresher.stop(); clock = 99_999;
  await refresher.trigger(); await refresher.tick();
  assert.equal(runs, 4, 'a stopped refresher never loads');
});

test('a workflow graph is refetched only when its objective summary changed', () => {
  const objective = { status: 'running', lifecycle: 'ACTIVE', counts: { executing: 1 }, orchestration: { steps: [{ id: 'deliver', state: 'current' }], currentAssignments: [{ taskId: 't1', posture: 'executing' }] } };
  assert.equal(objectiveSignature(objective), objectiveSignature(structuredClone(objective)));
  assert.notEqual(objectiveSignature(objective), objectiveSignature({ ...objective, orchestration: { ...objective.orchestration, currentAssignments: [{ taskId: 't2', posture: 'executing' }] } }), 'a task finished and another started');
  assert.notEqual(objectiveSignature(objective), objectiveSignature({ ...objective, finalDeliverableId: 'r9' }), 'the final report arrived');
});

test('the Office loads open sessions, caches graphs and keeps the top bar to one request', () => {
  const screens = read('screens.js');
  assert.ok(screens.includes("/api/work/sessions${ctx.q({ workspaceId: ctx.ws(), scope: 'current' })}"));
  assert.doesNotMatch(screens, /\/api\/tasks/, 'no full coding-session list on every Office refresh');
  assert.match(screens, /objectiveSignature\(objective\)/);
  assert.match(screens, /index \+= 4/, 'at most four workflow fetches at a time');
  assert.match(screens, /visibilitychange/);
  const app = read('app.js');
  const nav = app.slice(app.indexOf('function refreshSidebar()'), app.indexOf('// Primary destinations'));
  assert.equal((nav.match(/api\(/g) || []).length, 1, 'the top bar refresh is one request');
  assert.match(app, /live\.navTimer = setTimeout\(refreshSidebar, 1000\)/, 'stream bursts are debounced');
});
