// V5.1 visual polish: time of day, Character V2 wardrobe, department views,
// the ceiling cutaway and the performance guards. Pure checks, no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ROSTER } from '../src/hub-ui/office-presentation.js';
import { LIGHTING, TIMES, TRANSITION_MS, blendLighting, easeLight, resolveTime } from '../src/hub-ui/office3d/lighting.js';
import { WARDROBE, WING_ACCENTS } from '../src/hub-ui/office3d/characters.js';
import { CAMERA, WINGS, WORKSPACES, focusPreset, wingPreset } from '../src/hub-ui/office3d/layout.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('time of day: DAY, EVENING, NIGHT follow the theme unless Fahad chooses', () => {
  assert.deepEqual(TIMES, ['day', 'evening', 'night']);
  assert.equal(resolveTime('', false), 'day');
  assert.equal(resolveTime('', true), 'night');
  assert.equal(resolveTime('evening', false), 'evening');
  assert.equal(resolveTime('bogus', true), 'night');
  // Every preset sets the same keys, so any two can blend.
  const keys = Object.keys(LIGHTING.day).sort();
  for (const name of TIMES) assert.deepEqual(Object.keys(LIGHTING[name]).sort(), keys, name);
  // Night is lamp-lit and quiet; day is sunlit with the lamps off.
  assert.equal(LIGHTING.day.lamps, 0);
  assert.equal(LIGHTING.night.lamps, 1);
  assert.ok(LIGHTING.day.sun > LIGHTING.evening.sun && LIGHTING.evening.sun > LIGHTING.night.sun);
  assert.ok(LIGHTING.day.windows > LIGHTING.night.windows);
  assert.ok(LIGHTING.evening.sunPos[1] < LIGHTING.day.sunPos[1], 'the evening sun is low');
  // Screens are never pushed to glare by day.
  assert.ok(LIGHTING.day.screens <= 1);
});

test('time of day blends smoothly: endpoints exact, colours and vectors interpolated', () => {
  assert.deepEqual(blendLighting(LIGHTING.day, LIGHTING.night, 0), { ...LIGHTING.day, sunPos: [...LIGHTING.day.sunPos], backdrop: [...LIGHTING.day.backdrop] });
  const end = blendLighting(LIGHTING.day, LIGHTING.night, 1);
  assert.equal(end.sky, LIGHTING.night.sky);
  assert.deepEqual(end.sunPos, LIGHTING.night.sunPos);
  const mid = blendLighting({ sky: '#000000', sun: 0, sunPos: [0, 0, 0], backdrop: ['#000000', '#ffffff'] }, { sky: '#ffffff', sun: 2, sunPos: [2, 4, 6], backdrop: ['#ffffff', '#000000'] }, 0.5);
  assert.deepEqual(mid, { sky: '#808080', sun: 1, sunPos: [1, 2, 3], backdrop: ['#808080', '#808080'] });
  assert.equal(blendLighting(LIGHTING.day, LIGHTING.night, 7).lamps, 1, 't is clamped');
  assert.deepEqual([easeLight(-1), easeLight(0.5), easeLight(2)], [0, 0.5, 1]);
  assert.ok(TRANSITION_MS >= 1000 && TRANSITION_MS <= 4000);
});

test('no fake world data: lighting reads no clock, location or weather', () => {
  for (const file of ['lighting.js', 'decor.js']) {
    const source = read(`src/hub-ui/office3d/${file}`).replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(source, /Date\(|Date\.now|getHours|geolocation|navigator|weather|fetch\(/, file);
  }
  const scene = read('src/hub-ui/office3d/scene.js');
  assert.match(scene, /resolveTime\(time, dark\)/);
  assert.match(read('src/hub-ui/office.js'), /readPref\('hub-office-light', ''\)/, 'the choice is a saved Office setting');
});

test('Character V2: one consistent wardrobe system for all nine employees', () => {
  assert.deepEqual(Object.keys(WARDROBE).sort(), [...ROSTER].sort());
  const hex = /^#[0-9a-f]{6}$/i;
  for (const [key, look] of Object.entries(WARDROBE)) {
    for (const field of ['top', 'legs', 'shirt', 'skin', 'hair']) assert.match(look[field], hex, `${key}.${field}`);
    assert.ok(['short', 'crop', 'side', 'bun', 'long'].includes(look.style), key);
    assert.ok(['suit', 'blazer', 'knit', 'overshirt', 'hoodie'].includes(look.cut), key);
  }
  // Department identity through wardrobe, not costumes.
  assert.equal(WARDROBE.chief.cut, 'suit');
  assert.ok(WARDROBE.chief.scale > 1, 'CHIEF reads as senior and central');
  assert.ok(['research', 'audit'].every((key) => WARDROBE[key].glasses), 'analytical roles wear glasses');
  assert.ok(['product', 'finance'].every((key) => ['suit', 'blazer'].includes(WARDROBE[key].cut)), 'strategy roles are tailored');
  assert.ok(['creative', 'social'].every((key) => WARDROBE[key].rolled), 'studio roles are more relaxed');
  assert.ok(WARDROBE.coding.headphones && WARDROBE.coding.cut === 'hoodie');
  assert.equal(new Set(Object.values(WARDROBE).map((look) => look.skin)).size >= 7, true, 'a varied, natural range of skin tones');
  assert.deepEqual(Object.keys(WING_ACCENTS).sort(), WINGS.map((wing) => wing.id).sort());
});

test('Character V2 stays cheap: one shared material, merged per moving part', () => {
  const source = read('src/hub-ui/office3d/characters.js');
  assert.equal((source.match(/new THREE\.MeshStandardMaterial/g) || []).length, 1, 'one material for every figure');
  assert.match(source, /vertexColors: true/);
  assert.match(source, /const rigid = \[root, body, head, left\.shoulder, left\.elbow, right\.shoulder, right\.elbow\]/, '7 meshes per figure');
});

test('camera: department views for every wing and calm, predictable framing', () => {
  for (const wing of WINGS) {
    const preset = wingPreset(wing.id);
    assert.ok(preset, wing.id);
    assert.ok(Math.abs(preset.target[0] - wing.x) < wing.width / 2 && Math.abs(preset.target[2] - wing.z) < wing.depth / 2, `${wing.id}: the view is aimed inside the wing`);
    assert.ok(preset.polar >= 0.6 && preset.polar <= 1.1 && preset.distance > 12 && preset.distance < CAMERA.overview.distance, wing.id);
  }
  assert.equal(wingPreset('nowhere'), null);
  for (const key of Object.keys(WORKSPACES)) {
    const preset = focusPreset(key);
    assert.ok(preset.polar < 1.05, `${key}: seen from above the shoulder, never from floor level`);
    assert.ok(preset.distance >= 11, `${key}: the desk and the whole wall display share the frame`);
  }
  assert.ok(focusPreset('chief').distance > focusPreset('finance').distance, 'CHIEF gets the wider, central frame');
  const scene = read('src/hub-ui/office3d/scene.js');
  assert.match(scene, /t \* t \* t \* \(t \* \(t \* 6 - 15\) \+ 10\)/, 'smootherstep camera easing');
  assert.match(scene, /focusWing\(id\)/);
});

test('cutaway, performance and fallbacks are kept', () => {
  const scene = read('src/hub-ui/office3d/scene.js');
  // Suspended fixtures never hang between the camera and the work.
  assert.match(scene, /function focus\(key\) \{ focused = key; ceiling\.visible = false;/);
  assert.match(scene, /const overview = \(\) => \{ focused = null; ceiling\.visible = true;/);
  // Light is decals and emissive materials, not dozens of real lights.
  assert.equal((scene.match(/new THREE\.(PointLight|SpotLight|RectAreaLight)/g) || []).length, 0);
  assert.match(scene, /blending: THREE\.AdditiveBlending/);
  // Ambient-only motion renders at 30 fps; a still Office does not render.
  assert.match(scene, /ambientOnly \? Math\.min\(30, settings\.fps\)/);
  assert.match(scene, /if \(awake \|\| animating\) \{/);
  // Reduced motion: the time of day switches instantly.
  assert.match(scene, /if \(reducedMotion\) \{ light = \{ \.\.\.LIGHTING\[next\] \}/);
  // The light tier still skips image-based lighting and shadows.
  assert.match(scene, /if \(tier !== 'light'\) try \{/);
});

test('progressive disclosure: V5 owner areas are primary and Office view options stay inside the Office', () => {
  const index = read('src/hub-ui/index.html');
  const nav = index.slice(index.indexOf('<nav class="nav">'), index.indexOf('<details class="nav-more"'));
  assert.equal((nav.match(/class="nav-item"/g) || []).length, 9);
  for (const route of ['#/', '#/projects', '#/deliverables', '#/employees', '#/work', '#/attention', '#/continuity', '#/models', '#/settings']) assert.ok(nav.includes(`href="${route}"`), route);
  const office = read('src/hub-ui/office.js');
  assert.match(office, /<details class="o3d-handoffs o3d-options"><summary>View<\/summary>/, 'light and quality live under View');
  assert.match(office, /id="officeSummary"/);
  assert.doesNotMatch(read('src/hub-ui/app.js'), /<details class="disclosure" open><summary>Model pool/, 'the model table is behind a disclosure');
});

// ---- V5.1 final polish -------------------------------------------------
const { DETAIL_KINDS, DETAIL_REPEAT, drawDetail } = await import('../src/hub-ui/office3d/textures.js');
const { GLANCE_LIMIT, glanceYaw } = await import('../src/hub-ui/office3d/layout.js');
const { applyPose, POSES } = await import('../src/hub-ui/office3d/characters.js');

// A 2D-context stand-in that records fills (no DOM in Node).
function fakeCanvas(size = 128) {
  const calls = { fills: 0, strokes: 0 };
  const g = new Proxy({ createRadialGradient: () => ({ addColorStop() {} }), createLinearGradient: () => ({ addColorStop() {} }),
    fillRect: () => { calls.fills += 1; }, stroke: () => { calls.strokes += 1; } }, { get: (target, name) => (name in target ? target[name] : () => {}), set: () => true });
  return { canvas: { width: size, height: size, getContext: () => g }, calls };
}

test('procedural material detail: every finish draws, deterministic, repeated per metre, no downloads', () => {
  for (const kind of DETAIL_KINDS) {
    const { canvas, calls } = fakeCanvas();
    assert.equal(drawDetail(canvas, kind), canvas);
    assert.ok(calls.fills > 0, kind);
    assert.ok(DETAIL_REPEAT[kind] > 0.5 && DETAIL_REPEAT[kind] < 8, `${kind} tile size in metres`);
  }
  const first = fakeCanvas(); const second = fakeCanvas();
  drawDetail(first.canvas, 'stone'); drawDetail(second.canvas, 'stone');
  assert.deepEqual(first.calls, second.calls, 'seeded: the same Office every time');
  const source = read('src/hub-ui/office3d/textures.js').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(source, /fetch\(|new Image|\.png|\.jpg|url\(/);
  const scene = read('src/hub-ui/office3d/scene.js');
  // Each wing has its own floor finish; wood, stone and felt carry detail.
  for (const wing of WINGS) assert.match(scene, new RegExp(`${wing.id}: \\{ kind: '`), wing.id);
  assert.match(scene, /const MATERIAL_DETAIL = \{ wood: 'grain', walnut: 'veneer', stone: 'stone'/);
});

test('light tier at night stays readable without extra lights', () => {
  const scene = read('src/hub-ui/office3d/scene.js');
  assert.match(scene, /hemi\.intensity = hasEnvironment \? L\.hemi : L\.hemi \+ 0\.35 \+ L\.lamps \* 0\.55/);
  assert.match(scene, /toneMappingExposure = hasEnvironment \? L\.exposure : L\.exposure \+ L\.lamps \* 0\.28/);
  assert.match(scene, /if \(!hasEnvironment\) for \(const name of \['metal', 'dark', 'bezel'\]\)/, 'metals turn satin without reflections');
  assert.match(scene, /if \(!hasEnvironment\) for \(const made of floorMaterials\)/, 'floors get a faint emissive lift at night on the light tier');
  assert.ok(LIGHTING.day.exposure < 0.86 && LIGHTING.day.sun < 3, 'day is toned down from the washed-out pass');
});

test('Build Studio view is framed on CODING, tighter than the generic wing framing', () => {
  const build = wingPreset('build');
  const coding = WORKSPACES.coding;
  assert.ok(Math.hypot(build.target[0] - coding.x, build.target[2] - coding.z) < 1.5, 'CODING is the focal point');
  assert.ok(build.distance < 21, `distance ${build.distance}`);
  const creative = wingPreset('creative');
  assert.ok(build.distance < creative.distance);
});

test('motion foundation: a glance toward a colleague, only on a real fresh handoff', () => {
  assert.equal(glanceYaw('finance', 'finance'), 0);
  assert.equal(glanceYaw('finance', 'ghost'), 0);
  // FINANCE sits right of PRODUCT: PRODUCT glances right (negative yaw), FINANCE left.
  assert.ok(glanceYaw('product', 'finance') < 0 && glanceYaw('finance', 'product') > 0);
  for (const from of Object.keys(WORKSPACES)) for (const to of Object.keys(WORKSPACES)) assert.ok(Math.abs(glanceYaw(from, to)) <= GLANCE_LIMIT);
  // applyPose eases the head toward the glance; without one it stays facing the desk.
  const group = () => ({ rotation: { x: 0, y: 0 } });
  const figure = () => ({ body: group(), head: group(), left: { shoulder: group(), elbow: group() }, right: { shoulder: group(), elbow: group() } });
  const turned = figure(); const still = figure();
  for (let frame = 0; frame < 200; frame += 1) {
    applyPose(turned, POSES.working, { time: 0, ambient: 0, task: 0, seed: 1, glance: 0.6 });
    applyPose(still, POSES.working, { time: 0, ambient: 0, task: 0, seed: 1 });
  }
  assert.ok(Math.abs(turned.head.rotation.y - 0.6) < 0.01 && Math.abs(still.head.rotation.y) < 0.001);
  const scene = read('src/hub-ui/office3d/scene.js');
  assert.match(scene, /if \(!handoff\.fresh \|\| glanced\.has\(id\)\) continue;/, 'only fresh handoffs, once each');
  assert.match(scene, /const startGlances = \(\) => \{\n    if \(reducedMotion\) return;/);
  assert.doesNotMatch(scene, /Math\.random\(\)/, 'no random motion');
});

test('laptop layout: the Office fits a 1280×720 screen', () => {
  const css = read('src/hub-ui/office.css');
  assert.match(css, /@media \(max-height: 820px\) \{\n  \.office\.is-immersive \.office-stats \{ display: none; \}/);
  assert.match(css, /\.ask-chief \{ display: flex; gap: var\(--s-2\); flex: 1 1 320px;/);
  const office = read('src/hub-ui/office.js');
  assert.ok(office.indexOf('id="o3dFollow"') > office.indexOf('<summary>View</summary>'), 'Follow work lives in the View menu');
  assert.match(read('src/hub-ui/office3d/scene.js'), /Math\.max\(controlsHeight\(\) \+ 8,/, 'labels never sit under the view controls');
});
