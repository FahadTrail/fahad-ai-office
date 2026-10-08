// The Office redesign ("Daylight Atrium"): the presentation contract, the
// renderer/lighting separation, "no fake data" on every in-world screen, the
// red-only-for-attention rule, lazy loading and budgets, fail-safe and
// accessibility, the bilingual overlay, the API truth extensions, the rig
// and ambient life. Pure checks: no browser, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { ROSTER, describeOffice, officeRenderer, presentationState, visualState } from '../src/hub-ui/office-presentation.js';
import { COPY, copyFor, departmentName, formatCost, formatDuration, formatTokens, stateLabel } from '../src/hub-ui/office-copy.js';
import { CODING_STAGES, LIVE_TEXT_METRES, MIN_GLYPH_SHARE, codingStage, departmentLines, drawDepartment, drawDeskMonitor, drawOfficeWall, drawRoutingMap, screenPalette } from '../src/hub-ui/office3d/screens.js';
import { deskSignal } from '../src/hub-ui/office3d/states.js';
import { BLEND_SECONDS, WARDROBE, buildClips, buildPersonGeometry } from '../src/hub-ui/office3d/people.js';
import { WALKERS, cloudShade, walkPath, walkerCandidates } from '../src/hub-ui/office3d/life.js';
import { ZONES, seatPoint } from '../src/hub-ui/office3d/plan.js';
import { deliveriesView, employeeQueues, pipelineView, usageView } from '../src/hub-office.js';
import { handoffView } from '../src/hub-office-live.js';
import { stripGeometry } from '../src/hub-ui/office3d/builder.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const OFFICE3D = readdirSync(new URL('../src/hub-ui/office3d/', import.meta.url)).filter((name) => name.endsWith('.js'));
const NOW = Date.parse('2026-10-08T10:00:00Z');
const agent = (key, state = 'AVAILABLE', extra = {}) => ({ key, slug: `${key}-slug`, label: key.toUpperCase(), state, detail: '', ...extra });
const OFFICE = {
  agents: ROSTER.map((key) => agent(key)).map((entry) => ({
    ...entry,
    ...(entry.key === 'product' ? { state: 'WORKING', assignment: { jobId: 'job-1', objective: 'Launch plan', task: 'MVP scope' }, progress: 40, queue: 3 } : {}),
    ...(entry.key === 'coding' ? { state: 'NEEDS FAHAD', detail: 'Waiting for your approval', assignment: { sessionId: 's1', task: 'API' } } : {}),
    ...(entry.key === 'social' ? { state: 'WAITING', detail: 'Waiting for CREATIVE', assignment: { jobId: 'job-1', task: 'Calendar' } } : {}),
    ...(entry.key === 'legal' ? { enabled: false } : {}),
  })),
  workflows: [{ id: 'job-1', title: 'Launch plan', status: 'running', progress: 40, team: ['chief', 'product', 'social'] }, { id: 'job-0', title: 'First pass', status: 'completed', progress: 100 }],
  handoffs: [
    { id: 'h1', from: 'PRODUCT', fromKey: 'product', to: 'SOCIAL', toKey: 'social', jobId: 'job-1', at: new Date(NOW - 2 * 60_000).toISOString() },
    { id: 'h2', from: 'CHIEF', fromKey: 'chief', to: 'PRODUCT', toKey: 'product', jobId: 'job-1', at: new Date(NOW - 3 * 3600_000).toISOString() },
    { id: 'h3', from: 'X', fromKey: 'ghost', to: 'PRODUCT', toKey: 'product', at: new Date(NOW).toISOString() },
  ],
  deliveries: [{ key: 'research', title: 'Market scan', at: new Date(NOW - 60_000).toISOString() }, { key: 'ghost', title: 'x', at: new Date(NOW).toISOString() }],
  needsFahad: 1,
  coding: { id: 's1', title: 'API', status: 'awaiting_approval', phase: 'deploy', pr: { number: 12 }, ci: 'success' },
};
const ARTIFACTS = [
  { id: 'a1', agent: 'finance', type: 'financial_model', title: 'Unverified model', at: '2026-10-08T09:00:00Z', data: { validation: { state: 'INCONSISTENT' }, calculated: { net: 229000 } } },
  { id: 'a0', agent: 'finance', type: 'financial_model', title: 'Verified model', at: '2026-10-08T08:00:00Z', data: { validation: { state: 'VERIFIED' }, calculated: { net: 114440, currency: 'AED' } } },
];

test('presentation: one contract built only from Office data, now with queues, enabled and deliveries', () => {
  const state = presentationState({ office: OFFICE, artifacts: ARTIFACTS, now: NOW });
  assert.deepEqual(state.employees.map((employee) => employee.key), ROSTER);
  const product = state.employees.find((employee) => employee.key === 'product');
  assert.deepEqual([product.visual, product.task, product.queue, product.active, product.enabled], ['WORKING', 'MVP scope', 3, true, true]);
  assert.equal(state.employees.find((employee) => employee.key === 'legal').enabled, false);
  assert.deepEqual(state.handoffs.map((handoff) => [handoff.id, handoff.fresh]), [['h1', true], ['h2', false]], 'unknown employees are dropped; freshness is real');
  assert.deepEqual(state.deliveries.map((delivery) => delivery.key), ['research'], 'deliveries only from the roster');
  assert.equal(state.artifacts.finance.id, 'a0', 'FINANCE shows the VERIFIED model, never the newer unverified one');
  assert.match(describeOffice(state, 'en'), /PRODUCT is working; SOCIAL waiting; 1 item needs you\./);
  assert.match(describeOffice(state, 'ar'), /PRODUCT يشتغل؛ SOCIAL ينتظر؛ 1 أمر ينتظرك\./);
  assert.equal(visualState({ key: 'research', state: 'WORKING' }), 'RESEARCHING');
});

test('renderer: the 3D Office is the Office; the simplified Office only when the device cannot draw it, or by choice', () => {
  const desktop = { webgl: true, weakGpu: false, small: false, coarse: false, reducedMotion: false, strong: true };
  assert.deepEqual(officeRenderer({ capability: desktop }), { render: '3d', quality: 'high' });
  assert.equal(officeRenderer({ capability: { ...desktop, reducedMotion: true } }).render, '3d', 'reduced motion keeps the 3D Office, still');
  assert.deepEqual(officeRenderer({ preference: 'simplified', capability: desktop }), { render: 'simplified', reason: 'chosen' });
  assert.equal(officeRenderer({ capability: { ...desktop, webgl: false } }).reason, 'webgl');
  assert.equal(officeRenderer({ capability: { ...desktop, small: true } }).reason, 'small');
  assert.equal(officeRenderer({ capability: { ...desktop, coarse: true } }).reason, 'coarse');
  assert.equal(officeRenderer({ capability: { ...desktop, weakGpu: true } }).reason, 'weak');
  assert.deepEqual(officeRenderer({ preference: '3d', capability: { ...desktop, weakGpu: true } }), { render: '3d', quality: 'light' });
  // Light · Immersive · Auto are lighting modes, stored apart from the renderer.
  const office = read('src/hub-ui/office.js');
  assert.match(office, /readPref\('hub-office-light-mode', 'auto'\)/);
  assert.match(office, /readPref\('hub-office-view', 'auto'\)/);
  assert.doesNotMatch(office, /hub-office-mode/, 'the old combined mode setting is gone');
  assert.match(read('src/hub-ui/app.js'), /id="simplifiedOffice"/, 'Settings offers the simplified Office');
});

// A 2D-context stand-in that records every text and rectangle fill.
function recordingCanvas(width = 1024, height = 576) {
  const texts = []; const fills = [];
  const g = new Proxy({ fillText: (value) => texts.push(String(value)), fillRect: (...args) => fills.push([g.fillStyle, ...args]), measureText: () => ({ width: 10 }),
    createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }) }, { get: (target, name) => (name in target ? target[name] : () => {}), set: (target, name, value) => { target[name] = value; return true; } });
  const canvas = { width, height, getContext: () => g };
  g.canvas = canvas;
  return { canvas, texts, fills };
}
const day = screenPalette('day'); const night = screenPalette('night');

test('screens: L1 desk monitors show real output only within 4 m, an LOD block beyond, a calm screensaver at rest', () => {
  assert.equal(LIVE_TEXT_METRES, 4);
  const employee = { key: 'finance', label: 'FINANCE', state: 'WORKING', task: 'Launch budget', objective: 'Qahwa Run', detail: 'Working on Launch budget', progress: 40 };
  const near = recordingCanvas(512, 290);
  assert.equal(drawDeskMonitor(near.canvas, { employee, signal: deskSignal(employee), palette: day, near: true }), 'text');
  assert.ok(near.texts.includes('Launch budget') && near.texts.includes('Qahwa Run'));
  const far = recordingCanvas(512, 290);
  assert.equal(drawDeskMonitor(far.canvas, { employee, signal: deskSignal(employee), palette: day, near: false }), 'block');
  assert.deepEqual(far.texts, [], 'beyond 4 m nothing is written — the block stands for real lines');
  const rest = recordingCanvas(512, 290);
  assert.equal(drawDeskMonitor(rest.canvas, { employee: { key: 'audit', state: 'AVAILABLE' }, signal: deskSignal({ key: 'audit', state: 'AVAILABLE' }), palette: day, near: true }), 'screensaver');
  assert.deepEqual(rest.texts, ['F'], 'the screensaver shows only the Office mark');
  // Failed: a solid red square and the real error; nothing red otherwise.
  const failed = recordingCanvas(512, 290);
  drawDeskMonitor(failed.canvas, { employee: { key: 'legal', label: 'LEGAL', state: 'FAILED', detail: 'Could not finish the checklist' }, signal: deskSignal({ key: 'legal', state: 'FAILED' }), palette: day, near: true });
  assert.ok(failed.fills.some(([style]) => style === day.attention) && failed.texts.includes('Could not finish the checklist'));
  for (const state of ['AVAILABLE', 'WORKING', 'WAITING', 'COMPLETED']) {
    const sample = recordingCanvas(512, 290);
    drawDeskMonitor(sample.canvas, { employee: { key: 'legal', label: 'LEGAL', state, task: 'x' }, signal: deskSignal({ key: 'legal', state }), palette: day, near: true });
    assert.ok(!sample.fills.some(([style]) => style === day.attention), `${state} draws no red`);
  }
  const off = recordingCanvas(512, 290);
  assert.equal(drawDeskMonitor(off.canvas, { employee: { key: 'legal', enabled: false }, signal: deskSignal({ key: 'legal', enabled: false }), palette: night, near: true }), 'off');
});

test('screens: L2 department displays carry up to four real lines; FINANCE figures only when VERIFIED; CODING its real stage', () => {
  assert.ok(Math.abs(MIN_GLYPH_SHARE - 64 / 1080) < 1e-9, 'minimum glyph 64 px at 1080p');
  const lines = departmentLines({ key: 'product', task: 'MVP scope', objective: 'Launch plan', queue: 4, artifact: { title: 'MVP board' }, active: true, state: 'WORKING' });
  assert.deepEqual(lines.map((line) => [line.text, line.tone]), [['MVP scope', 'working'], ['Launch plan', 'muted'], ['Queue 4', 'caution'], ['MVP board', 'muted']]);
  assert.equal(departmentLines({ key: 'x', task: 'a', objective: 'b', queue: 1, artifact: { title: 'c' } }).length, 4);
  const verified = recordingCanvas();
  drawDepartment(verified.canvas, { employee: { key: 'finance', label: 'FINANCE', state: 'WORKING', artifact: ARTIFACTS[1] }, signal: deskSignal({ key: 'finance', state: 'WORKING' }), palette: day });
  assert.ok(verified.texts.some((value) => value.includes('114,440')) && verified.texts.some((value) => /Verified/.test(value)));
  const unverified = recordingCanvas();
  drawDepartment(unverified.canvas, { employee: { key: 'finance', label: 'FINANCE', state: 'WORKING', artifact: ARTIFACTS[0] }, signal: deskSignal({ key: 'finance', state: 'WORKING' }), palette: day });
  assert.ok(!unverified.texts.some((value) => value.includes('229')), 'an unverified figure is never drawn');
  assert.ok(unverified.texts.includes('Awaiting validated figures'));
  assert.equal(codingStage(OFFICE.coding), 'DEPLOYING');
  assert.equal(codingStage({ status: 'completed', phase: 'done' }), null, 'no stage lit when nothing runs');
  assert.ok(CODING_STAGES.includes('CI'));
  const coding = recordingCanvas();
  drawDepartment(coding.canvas, { employee: { key: 'coding', label: 'CODING', state: 'NEEDS FAHAD', coding: OFFICE.coding }, signal: deskSignal({ key: 'coding', state: 'NEEDS FAHAD' }), palette: day });
  assert.ok(coding.texts.some((value) => /PR #12/.test(value)) && coding.texts.includes('Deploying'));
});

test('screens: L3 routing map and L4 Office Wall — Pipeline · Today · Stream, "All clear" when nothing runs', () => {
  const state = presentationState({ office: OFFICE, artifacts: [], now: NOW });
  const wall = recordingCanvas(2048, 683);
  const result = drawOfficeWall(wall.canvas, { state, stats: [{ id: 'working', value: 1, tone: 'neutral' }, { id: 'needs', value: 1, tone: 'attention' }, { id: 'blocked', value: 0, tone: 'neutral' }, { id: 'delivered', value: 3, tone: 'neutral' }], stream: [{ text: 'PRODUCT handed MVP scope to SOCIAL', time: '09:58' }], palette: day });
  assert.deepEqual(result, { projects: 1, stream: 1 });
  for (const value of ['Pipeline', 'Today', 'Stream', 'Launch plan', '40%', '01', '03', 'PRODUCT handed MVP scope to SOCIAL']) assert.ok(wall.texts.includes(value), value);
  const quiet = recordingCanvas(2048, 683);
  drawOfficeWall(quiet.canvas, { state: { projects: [] }, stats: [], stream: [], palette: night });
  assert.ok(quiet.texts.includes('All clear'));
  // Numerals at least 0.18 m on the 2.4 m wall: the Today numerals are 4.8 of 24 units (0.48 m).
  assert.match(read('src/hub-ui/office3d/screens.js'), /const unit = h \/ 24;[\s\S]*size: unit \* 4\.8/);
  assert.ok((4.8 / 24) * 2.4 >= 0.18);
  const map = recordingCanvas(1024, 427);
  assert.equal(drawRoutingMap(map.canvas, { state, palette: day }), true);
  assert.deepEqual(map.texts.toSorted(), Object.values(ZONES).map((zone) => zone.number).toSorted(), 'the routing map writes only department numbers');
});

test('colour means truth: red only for Blocked, Failed and Needs you, in the overlay and the scene', () => {
  const css = read('src/hub-ui/office.css');
  for (const line of css.split('\n').filter((entry) => entry.includes('var(--ov-attention)'))) assert.match(line, /attention|--ov-attention:/, `red outside attention: ${line.trim().slice(0, 80)}`);
  const office = read('src/hub-ui/office.js');
  assert.match(office, /const RED = new Set\(\['NEEDS FAHAD', 'BLOCKED', 'FAILED'\]\)/);
  assert.match(office, /\['needs', needs, needs \? 'attention' : 'neutral'\]/, 'stat bar: red only above zero');
  assert.deepEqual(read('src/hub-ui/office.css').match(/#[0-9a-f]{3,8}\b/gi) || [], [], 'office.css uses tokens only');
  // No floating icons, no neon, no pole screens: no sprites over heads, no real point/spot lights.
  const scene = OFFICE3D.map((file) => read(`src/hub-ui/office3d/${file}`)).join('\n');
  assert.doesNotMatch(scene, /new THREE\.(Sprite|PointLight|SpotLight|RectAreaLight)\(/);
  assert.doesNotMatch(scene, /Math\.random\(\)/, 'nothing random: the Office is the same every time');
});

test('the 3D engine is lazy; the renderer never fetches Office data', () => {
  const app = read('src/hub-ui/app.js'); const office = read('src/hub-ui/office.js');
  assert.doesNotMatch(app, /office3d|vendor\/three/);
  assert.doesNotMatch(office, /^import .*(office3d\/scene|vendor\/three)/m, 'no static import of the scene or the engine');
  assert.match(office, /import\('\.\/office3d\/scene\.js\?v=__UI_VERSION__'\)/);
  assert.match(read('src/hub-ui/office3d/scene.js'), /from '\.\.\/vendor\/three\.js\?v=__UI_VERSION__'/);
  for (const file of ['project.js', 'library.js', 'artifacts.js', 'export.js']) assert.doesNotMatch(read(`src/hub-ui/${file}`), /office3d|three/);
  for (const file of OFFICE3D) assert.doesNotMatch(read(`src/hub-ui/office3d/${file}`), /\/api\/|\bapi\(/, file);
});

test('budgets: the vendored engine and the scene code stay small and keep their notices', () => {
  const bundle = readFileSync(new URL('../src/hub-ui/vendor/three.js', import.meta.url));
  assert.match(bundle.subarray(0, 300).toString(), /three\.js r0\.186\.1 .* MIT License/);
  assert.ok(gzipSync(bundle).length < 240_000, `gzipped engine ${gzipSync(bundle).length} B`);
  const scene = gzipSync(Buffer.concat(OFFICE3D.map((file) => readFileSync(new URL(`../src/hub-ui/office3d/${file}`, import.meta.url))))).length;
  assert.ok(scene < 90_000, `scene code ${scene} B gzipped`);
  assert.ok(OFFICE3D.every((file) => statSync(new URL(`../src/hub-ui/office3d/${file}`, import.meta.url)).size < 70_000));
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.devDependencies.three && !pkg.dependencies?.three && pkg.devDependencies['ktx2-encoder'] && !pkg.dependencies?.['ktx2-encoder'], 'build-time dependencies only');
  // Quality tiers and the frame-rate watchdog.
  const source = read('src/hub-ui/office3d/scene.js');
  assert.match(source, /high: \{ pixelRatio: 2, shadowSize: 4096, composer: true, ao: true/);
  assert.match(source, /light: \{ pixelRatio: 1, shadowSize: 1024, composer: false, ao: false/);
  assert.match(source, /if \(next\) setQuality\(next\); else on\.slow\?\.\(average\)/);
  assert.match(source, /renderer\.toneMapping = THREE\.AgXToneMapping/);
  assert.match(source, /bloom\.enabled = preset\.bloom > 0\.02/, 'bloom at night only');
  assert.match(source, /if \(document\.hidden\) return|disposed \|\| document\.hidden/, 'paused in hidden tabs');
});

test('fail-safe and accessible: context loss and errors fall back; labels are real buttons; reduced motion respected', () => {
  const scene = read('src/hub-ui/office3d/scene.js'); const office = read('src/hub-ui/office.js'); const css = read('src/hub-ui/office.css');
  assert.match(scene, /webglcontextlost/);
  assert.match(scene, /catch \(error\) \{ fail\(error\); \}/);
  assert.match(scene, /canvas\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(office, /error: \(error\) => \{ console\.warn\('3D Office stopped:', error\?\.message \|\| error\); fallBack\('stopped'\); \}/);
  assert.match(office, /id="o3dUseSimplified"/, 'the loading screen offers the simplified Office');
  assert.match(office, /<button type="button" class="o3d-card">/, 'every label is a real button');
  assert.match(office, /setAttribute\('aria-label', `\$\{departmentName\(anchor\.key, language\)\}/);
  assert.match(office, /aria-live="polite" id="o3dSummary"/);
  assert.match(office, /aria-labelledby="ovPanelTitle"/);
  assert.match(office, /class="ov-link" data-index=/, 'handoffs are listed as buttons');
  assert.match(scene, /event\.key === 'Escape'/); assert.match(scene, /\/\^\[0-8\]\$\/\.test\(event\.key\)/, 'keys 0–8 jump to zones');
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.office \*/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.o3d-label, \.o3d-card, \.ov-toast, \.ov-panel/);
  assert.match(scene, /if \(instant \|\| reducedMotion\) \{ shot = next; move = null; placeCamera\(shot\); \}/, 'reduced motion cuts the camera instead of flying');
  // RTL: logical properties, mirrored menus, label slots mirror.
  assert.match(css, /inset-inline-end: var\(--s-4\)/); assert.match(css, /\[dir="rtl"\] \.ov-menu/);
  assert.match(office, /dir="\$\{rtl \? 'rtl' : 'ltr'\}"/); assert.match(office, /rtl, lodScale: frame\.lodScale/);
});

test('copy: Arabic (default) and English cover every word; numbers and money are honest', () => {
  const keys = (value) => Object.keys(value).sort();
  assert.deepEqual(keys(COPY.ar), keys(COPY.en));
  assert.deepEqual(keys(COPY.ar.states), keys(COPY.en.states));
  assert.deepEqual(keys(COPY.ar.wall), keys(COPY.en.wall));
  assert.equal(copyFor('fr'), COPY.ar, 'Arabic is the default');
  assert.equal(departmentName('coding', 'en'), '04 Coding'); assert.equal(departmentName('coding', 'ar'), '04 البرمجة');
  assert.equal(stateLabel('WAITING FOR CREATIVE', 'en'), 'Waiting for CREATIVE'); assert.equal(stateLabel('NEEDS FAHAD', 'ar'), 'ينتظرك');
  assert.equal(formatCost(null, 'en'), 'Unavailable'); assert.equal(formatCost(0.0015, 'en'), '$0.0015'); assert.equal(formatCost(1.5, 'en'), '$1.50');
  assert.equal(formatTokens(9500, 1700, 'en'), '9.5k ↓ · 1.7k ↑'); assert.equal(formatTokens(null, null, 'ar'), 'غير متاح');
  assert.equal(formatDuration(529_000, 'en'), '8 min 49 s'); assert.equal(formatDuration(null, 'en'), 'Unavailable');
});

test('API views: queues, deliveries, usage, pipeline and a truthful blocked handoff — from existing rows only', () => {
  const agents = [{ id: 'a1', slug: 'research-strategy' }, { id: 'a2', slug: 'legal-compliance' }, { id: 'a3', slug: 'chief-of-staff' }];
  const jobs = [{ id: 'j1', status: 'running', title: 'Launch' }];
  const tasks = [
    { id: 't1', job_id: 'j1', agent_id: 'a3', title: 'Plan', status: 'done', completed_at: '2026-10-08T09:00:00Z', sequence: 10, brief: '{}' },
    { id: 't2', job_id: 'j1', agent_id: 'a1', title: 'Scan', status: 'running', started_at: '2026-10-08T09:50:00Z', sequence: 20, depends_on: ['t1'], brief: '{}' },
    { id: 't3', job_id: 'j1', agent_id: 'a2', title: 'Check', status: 'queued', sequence: 30, depends_on: ['t2'], brief: '{}' },
    { id: 't4', job_id: 'j1', agent_id: 'a2', title: 'Terms', status: 'queued', sequence: 40, depends_on: [], brief: '{}' },
  ];
  const queues = employeeQueues({ agents, jobs, tasks, sessions: [{ status: 'queued' }], now: NOW });
  assert.equal(queues.get('legal-compliance'), 2); assert.equal(queues.get('research-strategy'), undefined, 'running work is not queued'); assert.equal(queues.get('coding-agent'), 1);
  const deliveries = deliveriesView({ agents, jobs, tasks, completedSessions: [{ id: 's', title: 'API', completed_at: '2026-10-08T09:30:00Z' }], since: '2026-10-07T10:00:00Z' });
  assert.deepEqual(deliveries.map((delivery) => [delivery.key, delivery.title]), [['coding', 'API'], ['chief', 'Plan']]);
  const usage = usageView([{ model: 'deepseek-flash', provider: 'deepseek', input_tokens: 100, output_tokens: 20, cost_usd: 0.001, started_at: '2026-10-08T09:51:00Z' }, { model: 'claude-sonnet-5', provider: 'anthropic', input_tokens: 50, output_tokens: 5, cost_usd: 0.002, started_at: '2026-10-08T09:55:00Z' }], { startedAt: '2026-10-08T09:50:00Z', now: NOW });
  assert.deepEqual(usage, { model: 'claude-sonnet-5', provider: 'anthropic', attempts: 2, inputTokens: 150, outputTokens: 25, costUsd: 0.003, durationMs: 600_000 });
  assert.equal(usageView([], {}), null, 'no rows, no invented usage');
  assert.deepEqual(pipelineView({ job: jobs[0], tasks, agents, now: NOW }).map((step) => [step.key, step.state]), [['chief', 'done'], ['research', 'working'], ['legal', 'waiting'], ['legal', 'ready']]);
  const view = handoffView({ id: 'h', from_agent_id: 'a1', to_agent_id: 'a2', from_task_id: 't2', to_task_id: 't5', job_id: 'j1', created_at: '2026-10-08T09:59:00Z' },
    { agentById: new Map(agents.map((entry) => [entry.id, { ...entry, key: entry.slug }])), jobById: new Map(jobs.map((job) => [job.id, job])), taskById: new Map([['t5', { id: 't5', status: 'blocked' }]]), artifactsByTask: new Map() });
  assert.equal(view.status, 'blocked');
  assert.match(read('src/hub-ui/office.js'), /handoff\.status === 'blocked' \|\| handoff\.status === 'failed' \? 'attention'/);
});

test('people: one rig, nine wardrobes with business and Gulf attire, every state clip, 300 ms blends', () => {
  assert.deepEqual(Object.keys(WARDROBE).sort(), [...ROSTER].sort());
  assert.ok(Object.values(WARDROBE).some((look) => look.attire === 'kandura' && look.headdress === 'ghutra'), 'kandura with ghutra');
  assert.ok(Object.values(WARDROBE).some((look) => look.attire === 'abaya' && look.headdress === 'shayla'), 'abaya with shayla');
  assert.ok(Object.values(WARDROBE).filter((look) => look.attire === 'business').length >= 4, 'tailored business attire');
  assert.equal(new Set(Object.values(WARDROBE).map((look) => look.robe || look.top)).size >= 7, true, 'one garment tone per department');
  assert.equal(BLEND_SECONDS, 0.3);
  const clips = buildClips();
  for (const name of ['relaxed', 'typing', 'reading', 'blocked', 'sitback', 'waiting', 'lookUp', 'stand', 'phone', 'review', 'walk']) assert.ok(clips[name], name);
  for (const key of ROSTER) {
    const geometry = buildPersonGeometry(key, 'low');
    const weights = geometry.attributes.skinWeight;
    for (let index = 0; index < weights.count; index += 97) { const sum = weights.getX(index) + weights.getY(index) + weights.getZ(index) + weights.getW(index); assert.ok(Math.abs(sum - 1) < 1e-5, `${key} weights normalised`); }
    geometry.computeBoundingBox();
    const height = geometry.boundingBox.max.y - geometry.boundingBox.min.y;
    assert.ok(height > 1.62 && height < 1.85, `${key} stands ${height.toFixed(2)} m (7.5 heads)`);
  }
  // State lives on the desk and the body, never above heads.
  assert.doesNotMatch(read('src/hub-ui/office3d/people.js'), /Sprite|indicator|halo/i);
});

test('ambient life: at most two walkers, only employees who are really available, gone with reduced motion', () => {
  assert.equal(WALKERS.max, 2);
  const state = presentationState({ office: OFFICE, artifacts: [], now: NOW });
  const candidates = walkerCandidates(state);
  assert.ok(!candidates.includes('chief') && !candidates.includes('product') && !candidates.includes('legal'), 'never CHIEF, never someone working, never someone turned off');
  assert.ok(candidates.includes('research'));
  const path = walkPath('research');
  assert.deepEqual(path[0], seatPoint('research'));
  assert.ok(Math.hypot(path.at(-1)[0] + 8, path.at(-1)[1] - 12.3) < 1.2, 'ends at the coffee bar');
  assert.equal(walkPath('chief'), null);
  for (let second = 0; second < 600; second += 7) { const shade = cloudShade(second); assert.ok(shade >= 0.88 && shade <= 1); }
  const life = read('src/hub-ui/office3d/life.js');
  assert.match(life, /if \(reducedMotion\) return false;/);
  assert.match(life, /for \(const walk of \[\.\.\.walks\.values\(\)\]\) if \(!available\.has\(walk\.key\)\) endWalk\(walk\);/, 'a real state change sends a walker straight back');
});

test('floor strips (brass inlay, handoff light, history) face up so they are seen from above', () => {
  // A bent path: along +x, then along -z; every triangle's normal must point up (+y).
  const geometry = stripGeometry([[0, 0], [2, 0], [2, -2]], 0.4, () => 0, 0.01);
  const position = geometry.getAttribute('position'); const index = geometry.getIndex().array;
  const vertex = (i) => [position.getX(i), position.getY(i), position.getZ(i)];
  for (let t = 0; t < index.length; t += 3) {
    const [a, b, c] = [vertex(index[t]), vertex(index[t + 1]), vertex(index[t + 2])];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]; const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const normalY = u[2] * v[0] - u[0] * v[2];
    assert.ok(normalY > 0, `triangle ${t / 3} faces down`);
  }
  assert.equal(geometry.userData.length, 4);
});
