// V5 immersive Office: the presentation contract, state→visual mapping,
// spatial layout, "no fake data" on 3D surfaces, lazy loading, fallbacks and
// the vendored engine's size and licence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { ROSTER, describeOffice, officeMode, presentationState, visualState } from '../src/hub-ui/office-presentation.js';
import { CODING_STAGES, codingPanel, motionFor, stateVisual } from '../src/hub-ui/office3d/state-visuals.js';
import { CAMERA, PARTITIONS, WINGS, WORKSPACES, anchor, focusPreset } from '../src/hub-ui/office3d/layout.js';
import { POSES } from '../src/hub-ui/office3d/characters.js';
import { drawBoard, drawEngineeringPanel, drawMonitor, drawProjectWall, surfacePalette } from '../src/hub-ui/office3d/surfaces.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-09-28T10:00:00Z');
const agent = (key, state = 'AVAILABLE', extra = {}) => ({ key, slug: `${key}-slug`, label: key.toUpperCase(), state, detail: '', ...extra });
const OFFICE = {
  agents: ROSTER.map((key) => agent(key)).map((entry) => ({
    ...entry,
    ...(entry.key === 'product' ? { state: 'WORKING', assignment: { jobId: 'job-1', objective: 'Launch plan', task: 'MVP scope' }, progress: 40 } : {}),
    ...(entry.key === 'coding' ? { state: 'NEEDS FAHAD', detail: 'Waiting for your approval', assignment: { sessionId: 's1', task: 'API' } } : {}),
    ...(entry.key === 'social' ? { state: 'WAITING', detail: 'Waiting for CREATIVE', assignment: { jobId: 'job-1', task: 'Calendar' } } : {}),
  })),
  workflows: [{ id: 'job-1', title: 'Launch plan', status: 'running', progress: 40, team: ['chief', 'product', 'social'] }, { id: 'job-0', title: 'First pass', status: 'completed', progress: 100 }],
  handoffs: [
    { id: 'h1', from: 'PRODUCT', fromKey: 'product', to: 'SOCIAL', toKey: 'social', jobId: 'job-1', at: new Date(NOW - 2 * 60_000).toISOString() },
    { id: 'h2', from: 'CHIEF', fromKey: 'chief', to: 'PRODUCT', toKey: 'product', jobId: 'job-1', at: new Date(NOW - 3 * 3600_000).toISOString() },
    { id: 'h3', from: 'X', fromKey: 'ghost', to: 'PRODUCT', toKey: 'product', at: new Date(NOW).toISOString() },
  ],
  needsFahad: 1,
  coding: { id: 's1', title: 'API', status: 'awaiting_approval', phase: 'deploy', pr: { number: 12 }, ci: 'success' },
};
const ARTIFACTS = [
  { id: 'a1', agent: 'finance', type: 'financial_model', title: 'Unverified model', at: '2026-09-28T09:00:00Z', data: { items: [{ item: 'x', one_time: 5 }], validation: { state: 'INCONSISTENT' }, calculated: { year_revenue: 229000 } } },
  { id: 'a0', agent: 'finance', type: 'financial_model', title: 'Verified model', at: '2026-09-28T08:00:00Z', data: { validation: { state: 'VERIFIED' }, calculated: { months: 12, currency: 'AED', year_revenue: 154440, year_costs: 40000, net: 114440, break_even_month: 5 } } },
  { id: 'a2', agent: 'creative', type: 'moodboard', title: 'Brand', at: '2026-09-28T09:30:00Z', data: { palette: [{ name: 'Sand', hex: '#E8DCC4' }] } },
];

test('presentation state: one contract for every renderer, built only from Office data', () => {
  const state = presentationState({ office: OFFICE, artifacts: ARTIFACTS, now: NOW });
  assert.deepEqual(state.employees.map((employee) => employee.key), ROSTER);
  const product = state.employees.find((employee) => employee.key === 'product');
  assert.deepEqual([product.visual, product.task, product.jobId, product.progress, product.active], ['WORKING', 'MVP scope', 'job-1', 40, true]);
  const research = state.employees.find((employee) => employee.key === 'research');
  assert.deepEqual([research.task, research.progress, research.active], [null, null, false], 'an available employee shows no task');
  assert.equal(state.employees.find((employee) => employee.key === 'coding').coding.pr.number, 12);
  assert.deepEqual(state.handoffs.map((handoff) => [handoff.id, handoff.fresh]), [['h1', true], ['h2', false]], 'unknown employees are dropped; freshness is real');
  assert.deepEqual(state.projects[0].team, ['chief', 'product', 'social']);
  assert.equal(state.projects[1].active, false);
  // FINANCE: the newest artifact is unverified, so the workspace shows the verified one;
  // a hand-drawn FINANCE chart never shows, a calculator chart can.
  assert.equal(state.artifacts.finance.id, 'a0');
  const handDrawn = { id: 'c1', agent: 'finance', type: 'chart', at: '2026-09-28T09:59:00Z', data: { labels: ['M1'], series: [{ name: 'Revenue', values: [9e9] }] } };
  assert.equal(presentationState({ office: OFFICE, artifacts: [handDrawn, ARTIFACTS[0]], now: NOW }).artifacts.finance.id, 'a1', 'unverified model → awaiting, never the hand-drawn chart');
  assert.equal(presentationState({ office: OFFICE, artifacts: [{ ...handDrawn, data: { ...handDrawn.data, calculated: true } }], now: NOW }).artifacts.finance.id, 'c1');
  assert.equal(state.summary.needsFahad, 1);
  assert.match(describeOffice(state), /PRODUCT is working; SOCIAL waiting; 1 item needs you\./);
  assert.equal(visualState({ key: 'research', state: 'WORKING' }), 'RESEARCHING');
});

test('real state → visual behaviour; idle employees never look busy', () => {
  assert.deepEqual(motionFor(stateVisual({ state: 'AVAILABLE' })), { ambient: 1, task: 0 });
  assert.equal(motionFor(stateVisual({ state: 'WORKING' })).task, 1);
  assert.deepEqual(motionFor(stateVisual({ state: 'WORKING' }), { reducedMotion: true }), { ambient: 0, task: 0 });
  assert.equal(stateVisual({ state: 'NEEDS FAHAD' }).indicator, 'attention');
  assert.equal(stateVisual({ state: 'FAILED' }).screen, 'error');
  for (const visual of ['AVAILABLE', 'THINKING', 'WORKING', 'TESTING', 'REVIEWING', 'WAITING', 'QUEUED', 'NEEDS FAHAD', 'BLOCKED', 'COMPLETED', 'FAILED'].map((state) => stateVisual({ state }))) {
    assert.ok(POSES[visual.pose], `pose ${visual.pose}`);
  }
  // CODING's panel follows the real lifecycle phase.
  const panel = codingPanel({ state: 'NEEDS FAHAD', coding: OFFICE.coding });
  assert.deepEqual([panel.stage, panel.awaiting, panel.pr.number], ['DEPLOYING', true, 12]);
  assert.equal(codingPanel({ coding: { status: 'completed', phase: 'done' } }).stage, null, 'no stage is lit when nothing runs');
  assert.ok(CODING_STAGES.includes('CI') && CODING_STAGES.includes('VERIFYING'));
});

test('the Office is a real plan: wings, nine distinct workspaces, readable camera presets', () => {
  assert.deepEqual(Object.keys(WORKSPACES).sort(), [...ROSTER].sort());
  const wings = new Set(WINGS.map((wing) => wing.id));
  for (const [key, workspace] of Object.entries(WORKSPACES)) {
    assert.ok(wings.has(workspace.wing), key);
    const wing = WINGS.find((entry) => entry.id === workspace.wing);
    assert.ok(Math.abs(workspace.x - wing.x) <= wing.width / 2 && Math.abs(workspace.z - wing.z) <= wing.depth / 2 + 1, `${key} sits inside ${wing.id}`);
  }
  const entries = Object.entries(WORKSPACES);
  for (const [a, first] of entries) for (const [b, second] of entries) if (a < b) assert.ok(Math.hypot(first.x - second.x, first.z - second.z) >= 4.5, `${a} and ${b} have room`);
  assert.equal(WORKSPACES.chief.wing, 'atrium');
  assert.deepEqual(['research', 'legal', 'audit'].map((key) => WORKSPACES[key].wing), ['intelligence', 'intelligence', 'intelligence']);
  assert.deepEqual(['product', 'finance'].map((key) => WORKSPACES[key].wing), ['strategy', 'strategy']);
  assert.deepEqual(['creative', 'social', 'coding'].map((key) => WORKSPACES[key].wing), ['creative', 'creative', 'build']);
  assert.ok(PARTITIONS.length >= 6);
  assert.equal(focusPreset('finance').target[0], WORKSPACES.finance.x);
  assert.deepEqual(focusPreset('nobody'), CAMERA.overview);
  assert.equal(anchor('ghost'), null);
});

// A canvas stand-in that records every text drawn.
function recordingCanvas(width = 1024, height = 512) {
  const texts = [];
  const g = new Proxy({ fillText: (value) => texts.push(String(value)), measureText: () => ({ width: 10 }), createRadialGradient: () => ({ addColorStop() {} }) }, {
    get: (target, name) => (name in target ? target[name] : () => {}), set: () => true,
  });
  return { canvas: { width, height, getContext: () => g }, texts };
}
const palette = surfacePalette({}, false);

test('no fake data on 3D surfaces: FINANCE numbers only when VERIFIED, abstract when idle', () => {
  const unverified = recordingCanvas();
  drawBoard(unverified.canvas, { kind: 'finance-screen', employee: { key: 'finance', label: 'FINANCE', state: 'WORKING', artifact: ARTIFACTS[0] }, visual: stateVisual({ state: 'WORKING' }), palette });
  assert.ok(!unverified.texts.some((value) => /229/.test(value)), 'an unverified figure is never drawn');
  assert.ok(unverified.texts.some((value) => /Awaiting validated figures/.test(value)));
  const verified = recordingCanvas();
  drawBoard(verified.canvas, { kind: 'finance-screen', employee: { key: 'finance', label: 'FINANCE', state: 'WORKING', artifact: ARTIFACTS[1] }, visual: stateVisual({ state: 'WORKING' }), palette });
  assert.ok(verified.texts.some((value) => value.includes('154,440')) && verified.texts.some((value) => /VERIFIED/.test(value)));
  // No artifact and working → abstract pattern with only the area name.
  const abstract = recordingCanvas();
  assert.equal(drawBoard(abstract.canvas, { kind: 'intelligence-wall', employee: { key: 'research', label: 'RESEARCH', state: 'WORKING' }, visual: stateVisual({ state: 'WORKING' }), palette }), 'abstract');
  assert.deepEqual(abstract.texts, ['Research']);
  const idle = recordingCanvas();
  assert.equal(drawBoard(idle.canvas, { kind: 'intelligence-wall', employee: { key: 'research', label: 'RESEARCH', state: 'AVAILABLE' }, visual: stateVisual({ state: 'AVAILABLE' }), palette }), 'idle');
  const monitor = recordingCanvas(256, 160);
  drawMonitor(monitor.canvas, { visual: stateVisual({ state: 'WORKING' }), palette, label: 'LEGAL' });
  assert.deepEqual(monitor.texts, [], 'desk monitors carry no invented text');
  // CHIEF's wall: real objectives; CODING: real stage, PR and CI.
  const wall = recordingCanvas();
  drawProjectWall(wall.canvas, { state: presentationState({ office: OFFICE, artifacts: [], now: NOW }), palette });
  assert.ok(wall.texts.includes('Launch plan') && wall.texts.includes('40%'));
  const engineering = recordingCanvas();
  drawEngineeringPanel(engineering.canvas, { employee: { coding: OFFICE.coding }, panel: codingPanel({ state: 'NEEDS FAHAD', coding: OFFICE.coding }), palette, stages: CODING_STAGES });
  assert.ok(engineering.texts.some((value) => /PR #12/.test(value)) && engineering.texts.includes('Waiting for your approval'));
});

test('view modes: AUTO stays light during the beta; fallbacks are automatic', () => {
  const desktop = { webgl: true, weakGpu: false, small: false, coarse: false, reducedMotion: false, strong: true };
  assert.equal(officeMode({ preference: 'auto', capability: desktop }).render, 'light', 'beta: AUTO keeps the light Office');
  assert.deepEqual(officeMode({ preference: 'auto', capability: desktop, autoImmersive: true }), { render: 'immersive', quality: 'high' });
  assert.equal(officeMode({ preference: 'immersive', capability: desktop }).render, 'immersive');
  assert.equal(officeMode({ preference: 'immersive', capability: { ...desktop, webgl: false } }).render, 'light');
  assert.equal(officeMode({ preference: 'immersive', capability: { ...desktop, small: true } }).render, 'light');
  assert.equal(officeMode({ preference: 'immersive', capability: { ...desktop, weakGpu: true } }).quality, 'light');
  assert.equal(officeMode({ preference: 'auto', capability: { ...desktop, reducedMotion: true }, autoImmersive: true }).render, 'light');
  assert.equal(officeMode({ preference: 'auto', capability: { ...desktop, coarse: true }, autoImmersive: true }).render, 'light', 'phones and tablets keep the light Office');
  assert.equal(officeMode({ preference: 'light', capability: desktop, autoImmersive: true }).render, 'light');
});

test('the 3D engine is lazy: only the immersive Office imports it; nothing else does', () => {
  const app = read('src/hub-ui/app.js');
  const office = read('src/hub-ui/office.js');
  assert.doesNotMatch(app, /office3d|vendor\/three/);
  assert.doesNotMatch(office, /^import .*(office3d|three)/m, 'no static import of the 3D engine');
  assert.match(office, /import\('\.\/office3d\/scene\.js\?v=__UI_VERSION__'\)/);
  assert.match(read('src/hub-ui/office3d/scene.js'), /from '\.\.\/vendor\/three\.js\?v=__UI_VERSION__'/);
  for (const file of ['project.js', 'library.js', 'artifacts.js', 'export.js']) assert.doesNotMatch(read(`src/hub-ui/${file}`), /office3d|three/);
  // The renderer never talks to the network: it only receives presentation state.
  for (const file of ['scene.js', 'surfaces.js', 'characters.js', 'layout.js', 'state-visuals.js']) assert.doesNotMatch(read(`src/hub-ui/office3d/${file}`), /fetch\(|api\(|\/api\//);
});

test('the vendored engine stays inside its budget and keeps its MIT notice', () => {
  const bundle = readFileSync(new URL('../src/hub-ui/vendor/three.js', import.meta.url));
  assert.match(bundle.subarray(0, 300).toString(), /three\.js r0\.186\.1 .* MIT License/);
  assert.ok(gzipSync(bundle).length < 170_000, `gzipped engine ${gzipSync(bundle).length} B`);
  const scene = ['scene.js', 'surfaces.js', 'characters.js', 'layout.js', 'state-visuals.js'].reduce((sum, file) => sum + statSync(new URL(`../src/hub-ui/office3d/${file}`, import.meta.url)).size, 0);
  assert.ok(scene < 90_000, `scene code ${scene} B`);
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.devDependencies.three && !pkg.dependencies?.three, 'three is a build-time dependency only');
});

test('the immersive Office fails safe and stays accessible', () => {
  const scene = read('src/hub-ui/office3d/scene.js');
  const office = read('src/hub-ui/office.js');
  assert.match(scene, /webglcontextlost/);
  assert.match(scene, /catch \(error\) \{ fail\(error\); \}/, 'a render error calls the fallback');
  assert.match(office, /fallBack\('The immersive Office stopped; showing the light Office\.'\)/);
  assert.match(office, /id="o3dUseLight"/, 'the loading screen offers the light Office');
  assert.match(scene, /canvas\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(scene, /button\.type = 'button'; button\.className = 'o3d-label'/, 'every workspace is a real button');
  assert.match(scene, /setAttribute\('aria-label'/);
  assert.match(office, /aria-live="polite" id="o3dSummary"/);
  assert.match(office, /o3d-handoff/, 'handoffs are listed as buttons');
  assert.match(scene, /event\.key === 'Escape'/);
  assert.match(read('src/hub-ui/office.css'), /prefers-reduced-motion: reduce\) \{ \.o3d-label/);
});

test('a calculator chart keeps its "calculated by code" flag when stored', async () => {
  const { parseArtifacts } = await import('../src/office/artifacts.js');
  const block = (value) => `\`\`\`artifact\n${JSON.stringify(value)}\n\`\`\``;
  const [calculated, handDrawn] = parseArtifacts(`${block({ type: 'chart', title: 'A', calculated: true, labels: ['M1'], series: [{ name: 'Revenue', values: [1] }] })}\n${block({ type: 'chart', title: 'B', calculated: 'yes', labels: ['M1'], series: [{ name: 'Revenue', values: [1] }] })}`).artifacts;
  assert.equal(calculated.data.calculated, true);
  assert.equal(handDrawn.data.calculated, undefined, 'only the literal true set by code counts');
});
