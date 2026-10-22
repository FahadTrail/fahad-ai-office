import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ROSTER, arabicCount, archiveFilter, deliveryProgress, employeeColor, employeeState, employeeTabs, fractionWidth, greeting, jobStatus, numericDate, outputTypes,
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
  for (const endpoint of ['/api/work/current', '/api/work/history', '/api/work/objectives/', '/api/workflows/', '/api/attention', '/api/office', '/api/tasks', "'/api/conversations'", '/messages', '/stop']) assert.ok(screens.includes(endpoint), endpoint);
  const writes = [...screens.matchAll(/method: '(POST|PATCH|PUT|DELETE)'/g)].length;
  assert.equal(writes, 3, 'submit, Reply & Continue and Stop only');
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
  assert.doesNotMatch(css, /transition: all/);
  const tokens = read('app.css');
  assert.match(tokens, /--blur: saturate\(180%\) blur\(20px\)/);
  assert.match(tokens, /font-family: "JetBrains Mono"/);
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
