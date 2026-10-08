// The Office redesign (Final Design Spec, "Daylight Atrium"): the pure
// foundation — plan, routes, lighting modes, camera states, desk signals
// and label layout. No browser, no Three.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COLUMNS, COLUMN_RADIUS, DOOR_WIDTH, FORUM, GLASS, OFFICE, OFFICE_WALL, PROMENADE, ROOMS, ZONES, ZONE_KEYS, floorHeight, labelAnchor, seatPoint, zoneAt, zoneByNumber } from '../src/hub-ui/office3d/plan.js';
import { PULSE, afterglow, blockedHold, cometAt, inlayNetwork, measure, offsetPath, pathLength, planPulses, pointAt, routePath, tripSeconds } from '../src/hub-ui/office3d/routes.js';
import { KEYFRAMES, LIGHT_MODES, MODE_MINUTES, kelvinToHex, lightingAt, resolveMode, sunDirection, uiPhase } from '../src/hub-ui/office3d/modes.js';
import { CAMERA_STATES, TRANSITION, agentView, between, chiefView, departmentView, ease, handoffsView, occluders, orbit, overviewView, project, stepBack, transitionMs } from '../src/hub-ui/office3d/camera.js';
import { FORUM_STATES, RED_STATES, deskSignal, forumState, isRed, labelPriority, statBar, systemState } from '../src/hub-ui/office3d/states.js';
import { LOD, layoutLabels, lodFor, overlaps, slotBox } from '../src/hub-ui/office3d/labels.js';
import { ROSTER } from '../src/hub-ui/office-presentation.js';

const near = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;
// Segment-segment distance in 2D (for clearance checks).
function segmentDistance([a, b], [c, d]) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const intersects = Math.sign(cross(a, b, c)) !== Math.sign(cross(a, b, d)) && Math.sign(cross(c, d, a)) !== Math.sign(cross(c, d, b));
  if (intersects) return 0;
  const pointSeg = (p, q, r) => { const dx = r[0] - q[0]; const dz = r[1] - q[1]; const t = Math.max(0, Math.min(1, ((p[0] - q[0]) * dx + (p[1] - q[1]) * dz) / (dx * dx + dz * dz || 1))); return Math.hypot(p[0] - q[0] - dx * t, p[1] - q[1] - dz * t); };
  return Math.min(pointSeg(a, c, d), pointSeg(b, c, d), pointSeg(c, a, b), pointSeg(d, a, b));
}

test('plan: 48 × 32 m, 4.2 m ceiling, 8.4 m atrium; CHIEF at the centre in a sunk Ø 10 m Forum under a Ø 8 m oculus', () => {
  assert.deepEqual([OFFICE.width, OFFICE.depth, OFFICE.ceiling, OFFICE.atrium], [48, 32, 4.2, 8.4]);
  assert.deepEqual([FORUM.x, FORUM.z, FORUM.radius * 2, FORUM.depth, FORUM.oculusRadius * 2, FORUM.table.length], [0, 0, 10, 0.45, 8, 3.6]);
  assert.equal(OFFICE_WALL.width, 7.2); assert.equal(OFFICE_WALL.height, 2.4);
  assert.equal(floorHeight(0, 0), -0.45); assert.equal(floorHeight(10, 0), 0);
  assert.ok(floorHeight(4.9, 0) > -0.45 && floorHeight(4.9, 0) < 0, 'steps between the Promenade and the Forum floor');
  assert.equal(zoneAt(0, 0), 'chief');
  assert.equal(seatPoint('chief')[0], 0, 'CHIEF sits on the centre line, facing the Office Wall');
  assert.equal(ZONES.chief.desk.yaw, 0);
});

test('plan: nine zones numbered 00–08 clockwise from the north-west; Legal, Finance, Audit and the Boardroom are glazed', () => {
  assert.deepEqual([...ZONE_KEYS].sort(), [...ROSTER].sort());
  assert.deepEqual(ZONE_KEYS.map((key) => ZONES[key].number), ['00', '01', '02', '03', '04', '05', '06', '07', '08']);
  // Clockwise: the department centres' angles around the Forum increase.
  const bearing = (key) => { const [x, z] = ZONES[key].centre; return (Math.atan2(x, -z) * 180 / Math.PI + 360 + 60) % 360; };
  const order = ZONE_KEYS.slice(1).map(bearing);
  for (let index = 1; index < order.length; index += 1) assert.ok(order[index] > order[index - 1], `${ZONE_KEYS[index + 1]} follows clockwise`);
  assert.deepEqual(ZONE_KEYS.filter((key) => ZONES[key].kind === 'glazed'), ['finance', 'audit', 'legal']);
  assert.equal(ROOMS.boardroom.kind, 'glazed'); assert.equal(ROOMS.boardroom.seats, 14);
  assert.ok(ROOMS.arrival.bounds[3] === OFFICE.maxZ && ROOMS.arrival.entrance[0] < 0 && ROOMS.arrival.entrance[1] > 0, 'the entrance is from the south, on the Forum axis');
  assert.equal(zoneByNumber(4), 'coding'); assert.equal(zoneByNumber(0), 'chief'); assert.equal(zoneByNumber(9), null);
  assert.equal(ZONES.coding.kelvin, -200); assert.equal(ZONES.legal.kelvin, 200);
});

test('plan: every desk, seat and display sits in its own zone; displays hang on the far façade facing the Forum', () => {
  for (const key of ZONE_KEYS) {
    const zone = ZONES[key];
    const seat = seatPoint(key);
    assert.equal(zoneAt(zone.desk.x, zone.desk.z), key, `${key} desk`);
    assert.equal(zoneAt(...seat), key, `${key} seat`);
    assert.ok(labelAnchor(key), key);
    if (key === 'chief') continue;
    const [minX, minZ, maxX, maxZ] = zone.bounds;
    const { x, z } = zone.display;
    assert.ok([minX, maxX].some((edge) => Math.abs(Math.abs(edge) - OFFICE.width / 2) < 0.01 && Math.abs(x - edge) < 0.3)
      || [minZ, maxZ].some((edge) => Math.abs(Math.abs(edge) - OFFICE.depth / 2) < 0.01 && Math.abs(z - edge) < 0.3), `${key} display is on the façade`);
    // The employee faces the display (backs to the Promenade).
    const facing = [-Math.sin(zone.desk.yaw), -Math.cos(zone.desk.yaw)];
    assert.ok(facing[0] * (x - zone.desk.x) + facing[1] * (z - zone.desk.z) > 0, `${key} faces its display`);
  }
});

test('plan: no spoke or desk run meets a column or a glass wall except through a doorway', () => {
  const segments = inlayNetwork().filter((segment) => segment.kind !== 'ring');
  for (const segment of segments) {
    for (const [x, z] of COLUMNS) {
      for (let index = 1; index < segment.points.length; index += 1) {
        const clearance = segmentDistance([segment.points[index - 1], segment.points[index]], [[x, z], [x, z]]);
        assert.ok(clearance > COLUMN_RADIUS + 0.25, `${segment.kind} ${segment.key} clears the column at ${x},${z} (${clearance.toFixed(2)} m)`);
      }
    }
    for (const [x1, z1, x2, z2, door] of GLASS) {
      const hit = segmentDistance([segment.points[0], segment.points[1]], [[x1, z1], [x2, z2]]) === 0;
      if (!hit) continue;
      assert.ok(door, `${segment.key} crosses glass at ${x1},${z1}→${x2},${z2} without a door`);
      if (door === 'open') continue;
      // Crossing point within the door gap.
      const [ax, az] = segment.points[0]; const [bx, bz] = segment.points[1];
      const t = ((x1 - ax) * (z2 - z1) - (z1 - az) * (x2 - x1)) / ((bx - ax) * (z2 - z1) - (bz - az) * (x2 - x1));
      const cross = [ax + (bx - ax) * t, az + (bz - az) * t];
      assert.ok(Math.hypot(cross[0] - door[0], cross[1] - door[1]) < DOOR_WIDTH / 2, `${segment.key} passes through its door`);
    }
  }
});

test('routes: desk → spoke → Promenade → (Forum ring) → spoke → desk for every pair', () => {
  for (const from of ZONE_KEYS) for (const to of ZONE_KEYS) {
    if (from === to) { assert.equal(routePath(from, to), null); continue; }
    const path = routePath(from, to);
    assert.deepEqual(path[0], seatPoint(from)); assert.deepEqual(path.at(-1), seatPoint(to));
    const radii = path.map(([x, z]) => Math.hypot(x, z));
    const onRing = (r) => radii.some((value) => near(value, r, 0.01));
    assert.ok(onRing(PROMENADE.inlay), `${from}→${to} uses the Promenade ring`);
    if (from === 'chief' || to === 'chief') assert.ok(onRing(PROMENADE.forumInlay), `${from}→${to} uses the Forum ring`);
    const length = pathLength(path);
    assert.ok(length > 4 && length < 60, `${from}→${to} ${length.toFixed(1)} m`);
    const seconds = tripSeconds(length);
    assert.ok(seconds >= 2.5 && seconds <= 6);
  }
  assert.equal(routePath('ghost', 'chief'), null);
});

test('routes: pulse, fade, ember, lanes, bundles and blocked holds follow the spec', () => {
  assert.deepEqual([PULSE.length, PULSE.speed, PULSE.minTrip, PULSE.maxTrip, PULSE.fade, PULSE.ember, PULSE.emberSeconds, PULSE.maxVisible, PULSE.laneSpacing, PULSE.blockedPulse],
    [1.2, 4, 2.5, 6, 1.2, 0.08, 30, 6, 0.08, 6]);
  assert.equal(PULSE.emissiveDay, 0.6); assert.equal(PULSE.emissiveNight, 1.4);
  assert.equal(tripSeconds(4), 2.5); assert.equal(tripSeconds(16), 4); assert.equal(tripSeconds(100), 6);
  assert.equal(cometAt(10, 10), 1); assert.equal(cometAt(10.5, 10), 0, 'nothing ahead of the head'); assert.equal(cometAt(8.7, 10), 0, 'the tail is 1.2 m');
  assert.ok(cometAt(9.5, 10) > 0 && cometAt(9.5, 10) < 1);
  assert.equal(afterglow(0), 1); assert.ok(near(afterglow(1.2), 0.08)); assert.equal(afterglow(20), 0.08); assert.equal(afterglow(31), 0);
  const path = routePath('research', 'finance');
  const lane = offsetPath(path, 0.08);
  assert.ok(near(Math.hypot(lane[3][0] - path[3][0], lane[3][1] - path[3][1]), 0.08, 1e-3), '80 mm lanes');
  const distances = measure(path);
  assert.deepEqual(pointAt(path, distances, 0), path[0]);
  assert.deepEqual(pointAt(path, distances, 1e9).map((v) => Math.round(v * 1e3) / 1e3), path.at(-1));
  const handoffs = Array.from({ length: 9 }, (_, index) => ({ id: `h${index}`, fromKey: 'research', toKey: index < 6 ? 'chief' : 'legal', at: new Date(2026, 9, 8, 10, 60 - index).toISOString() }));
  const plan = planPulses(handoffs);
  assert.equal(plan.visible.length, 6);
  assert.deepEqual(plan.bundles, [{ toKey: 'legal', count: 3 }]);
  assert.equal(new Set(plan.visible.map((entry) => entry.offset)).size, 6, 'each visible route has its own lane');
  assert.deepEqual(planPulses([{ fromKey: 'ghost', toKey: 'chief', at: '' }]).visible, [], 'unknown employees are never routed');
  assert.equal(blockedHold({ status: 'delivered', toKey: 'legal' }), null);
  assert.deepEqual(blockedHold({ status: 'blocked', toKey: 'legal' }), { key: 'legal', point: [-10, 0], period: 6 });
});

test('modes: Light is 10:30, Immersive 21:30, Auto follows the real clock; the overlay turns at 18:30 and 05:30', () => {
  assert.deepEqual(LIGHT_MODES, ['light', 'immersive', 'auto']);
  assert.equal(MODE_MINUTES.light, 630); assert.equal(MODE_MINUTES.immersive, 1290);
  const noon = new Date(2026, 9, 8, 12, 0); const late = new Date(2026, 9, 8, 22, 15);
  assert.equal(resolveMode('light', late).minutes, 630, 'Light never reads the clock');
  assert.equal(resolveMode('immersive', noon).minutes, 1290);
  assert.equal(resolveMode('auto', noon).minutes, 720);
  assert.equal(resolveMode('bogus', noon).mode, 'auto');
  assert.equal(uiPhase(18 * 60 + 29), 'day'); assert.equal(uiPhase(18 * 60 + 30), 'night');
  assert.equal(uiPhase(5 * 60 + 29), 'night'); assert.equal(uiPhase(5 * 60 + 30), 'day');
  const light = resolveMode('light').preset; const night = resolveMode('immersive').preset;
  assert.equal(light.sunKelvin, 5600); assert.equal(light.screens, 0.7); assert.equal(light.bloom, 0); assert.equal(light.artificial, 0);
  assert.equal(light.roughness, 0.55); assert.equal(night.roughness, 0.4, 'only the travertine roughness shifts at night');
  assert.equal(night.sun, 0); assert.equal(night.bloom, 1); assert.equal(night.artificial, 1);
  assert.ok(resolveMode('light').sun[1] > 0.5, 'a high morning sun at 10:30');
  // Auto keyframes as specified, and every preset carries the same keys.
  for (const minute of [7 * 60, 12 * 60, 17 * 60, 18 * 60 + 30, 20 * 60]) assert.ok(KEYFRAMES.some(([at]) => at === minute), `keyframe ${minute}`);
  const keys = Object.keys(KEYFRAMES[0][1]).sort();
  for (const [, preset] of KEYFRAMES) assert.deepEqual(Object.keys(preset).sort(), keys);
  // Continuous through the day.
  for (let minute = 0; minute < 1440; minute += 5) { const a = lightingAt(minute); const b = lightingAt(minute + 5); assert.ok(Math.abs(a.sun - b.sun) < 0.6, `smooth at ${minute}`); }
  assert.ok(sunDirection({ sunElevation: 30, sunAzimuth: 180 })[2] > 0, 'a southern sun lies toward +z');
  assert.match(kelvinToHex(2700), /^#ff[a-f0-9]{4}$/); assert.match(kelvinToHex(5600), /^#ff[ef][a-f0-9]{3}$/);
});

test('camera: six states with the specified lens and elevation', () => {
  assert.deepEqual([CAMERA_STATES.overview.fov, CAMERA_STATES.overview.elevation, CAMERA_STATES.overview.bearing, CAMERA_STATES.overview.margin], [38, 52, 135, 0.08]);
  assert.deepEqual([CAMERA_STATES.department.fov, CAMERA_STATES.department.elevation, CAMERA_STATES.department.margin], [32, 38, 0.15]);
  assert.deepEqual([CAMERA_STATES.agent.fov, CAMERA_STATES.agent.elevation, CAMERA_STATES.agent.distance], [28, 18, 3.2]);
  assert.deepEqual([CAMERA_STATES.chief.fov, CAMERA_STATES.chief.elevation, CAMERA_STATES.chief.bearing], [30, 28, 180]);
  assert.deepEqual([CAMERA_STATES.handoffs.fov, CAMERA_STATES.handoffs.elevation, CAMERA_STATES.handoffs.margin], [34, 70, 0.1]);
  assert.deepEqual([CAMERA_STATES.idle.degreesPerSecond, CAMERA_STATES.idle.afterSeconds], [0.6, 90]);
  assert.deepEqual([TRANSITION.min, TRANSITION.max, TRANSITION.bezier], [700, 900, [0.22, 1, 0.36, 1]]);
});

test('camera: the overview frames the whole Office from the south-east with CHIEF in view', () => {
  const view = overviewView({ aspect: 16 / 9 });
  assert.ok(view.position[0] > 0 && view.position[2] > 0, 'from the SE');
  const camera = { ...view, aspect: 16 / 9 };
  for (const x of [-24, 24]) for (const z of [-16, 16]) { const p = project([x, 0, z], camera); assert.ok(Math.abs(p.x) <= 1.001 && Math.abs(p.y) <= 1.001, `corner ${x},${z}`); }
  const chief = project([0, 0, 0], camera);
  assert.ok(Math.abs(chief.x) < 0.25 && Math.abs(chief.y) < 0.35, 'CHIEF near the centre of the frame');
  const elevation = Math.asin((view.position[1] - view.target[1]) / Math.hypot(...view.position.map((v, i) => v - view.target[i]))) * 180 / Math.PI;
  assert.ok(near(elevation, 52, 0.01));
  // Overlay insets keep the building clear of the top controls.
  const inset = overviewView({ aspect: 16 / 9, insets: { top: 0.1 } });
  for (const x of [-24, 24]) for (const z of [-16, 16]) assert.ok(project([x, 3, z], { ...inset, aspect: 16 / 9 }).y <= 0.801);
});

test('camera: departments from the Promenade, the agent over the shoulder, CHIEF across the Forum', () => {
  for (const key of ZONE_KEYS.slice(1)) {
    const view = departmentView(key);
    const [cx, cz] = ZONES[key].centre;
    assert.ok(Math.hypot(view.position[0], view.position[2]) < Math.hypot(cx, cz) + 30, key);
    // Looking outward: the camera is on the Forum side of the department.
    const towardForum = [-cx, -cz];
    assert.ok((view.position[0] - view.target[0]) * towardForum[0] + (view.position[2] - view.target[2]) * towardForum[1] > 0, `${key} seen from the Promenade side`);
  }
  assert.equal(departmentView('chief'), null);
  for (const key of ZONE_KEYS) {
    const view = agentView(key);
    const distance = Math.hypot(...view.position.map((v, i) => v - view.target[i]));
    assert.ok(near(distance, 3.2, 0.01), key);
    assert.ok(view.position[1] < OFFICE.ceiling - 0.3, `${key}: below the ceiling, the slats stay in frame`);
    // Behind the employee (over the shoulder), never in front of the desk.
    const { x, z, yaw } = ZONES[key].desk;
    const facing = [-Math.sin(yaw), -Math.cos(yaw)];
    assert.ok((view.position[0] - x) * facing[0] + (view.position[2] - z) * facing[1] < 0, `${key}: from behind`);
  }
  const chief = chiefView({ aspect: 16 / 9 });
  const camera = { ...chief, aspect: 16 / 9 };
  const table = project([0, FORUM.table.height - FORUM.depth, FORUM.table.z], camera);
  const wall = project([0, OFFICE_WALL.bottom + OFFICE_WALL.height / 2, OFFICE_WALL.z], camera);
  assert.ok(table.y < -0.15, `the table sits low in the frame (${table.y.toFixed(2)})`);
  assert.ok(wall.y > 0.15, `the wall sits high in the frame (${wall.y.toFixed(2)})`);
  assert.ok(chief.position[2] > chief.target[2], 'from the south');
  const routes = [routePath('research', 'chief'), routePath('finance', 'legal')];
  const handoffs = handoffsView(routes);
  assert.ok(handoffs.position[1] > 20, 'high above the centre');
});

test('camera: transitions ease on the spec curve, take 700–900 ms and arc above the glass', () => {
  assert.equal(ease(0), 0); assert.equal(ease(1), 1);
  for (let t = 0.05; t < 1; t += 0.05) assert.ok(ease(t) >= ease(t - 0.05), 'monotonic');
  assert.ok(ease(0.3) > 0.6, 'fast start, gentle landing (no bounce)');
  const a = agentView('research'); const b = agentView('finance');
  const ms = transitionMs(a, b);
  assert.ok(ms >= 700 && ms <= 900);
  const mid = between(a, b, 0.5);
  assert.ok(mid.position[1] > TRANSITION.arcClearance, 'over the glass, not through it');
  assert.deepEqual(between(a, b, 1).position.map((v) => Math.round(v * 1000) / 1000), b.position);
  const view = overviewView();
  const turned = orbit(view, 10);
  assert.ok(near(Math.hypot(turned.position[0] - view.target[0], turned.position[2] - view.target[2]), Math.hypot(view.position[0] - view.target[0], view.position[2] - view.target[2]), 1e-2));
  assert.deepEqual(stepBack({ name: 'agent', key: 'legal' }), { name: 'department', key: 'legal' });
  assert.deepEqual(stepBack({ name: 'agent', key: 'chief' }), { name: 'overview' });
  assert.deepEqual(stepBack({ name: 'department', key: 'legal' }), { name: 'overview' });
});

const employee = (key, state, extra = {}) => ({ key, state, ...extra });

test('desk signals: state lives on the desk; red only for Blocked, Failed and Needs you', () => {
  assert.deepEqual(RED_STATES, ['BLOCKED', 'FAILED', 'NEEDS FAHAD']);
  const available = deskSignal(employee('research', 'AVAILABLE'));
  assert.deepEqual([available.lamp, available.monitor, available.pose, available.tone], [0, 'screensaver', 'relaxed', 'neutral']);
  const working = deskSignal(employee('coding', 'WORKING'));
  assert.deepEqual([working.lamp, working.monitor, working.pose, working.tone], [1, 'live', 'typing', 'working']);
  assert.equal(deskSignal(employee('research', 'WORKING')).pose, 'reading', 'Research is read-scroll dominant');
  assert.equal(deskSignal(employee('social', 'WORKING')).pose, 'phone');
  const blocked = deskSignal(employee('legal', 'BLOCKED'));
  assert.deepEqual([blocked.ring, blocked.monitor, blocked.pose], ['blocked', 'frozen', 'blocked']);
  assert.deepEqual([deskSignal(employee('finance', 'FAILED')).monitor, deskSignal(employee('finance', 'FAILED')).ring], ['error', 'failed']);
  assert.equal(deskSignal(employee('coding', 'NEEDS FAHAD')).ring, 'approval');
  const done = deskSignal(employee('audit', 'COMPLETED'));
  assert.deepEqual([done.flare, done.monitor, done.tone], [true, 'delivered', 'done']);
  assert.deepEqual([deskSignal(employee('product', 'WAITING')).tone, deskSignal(employee('product', 'QUEUED')).lamp], ['neutral', 0], 'waiting is never coloured');
  const offline = deskSignal(employee('legal', 'AVAILABLE', { enabled: false }));
  assert.deepEqual([offline.chair, offline.pose, offline.tone], ['pushed-in', 'empty', 'offline']);
  for (const state of ['AVAILABLE', 'QUEUED', 'THINKING', 'WORKING', 'TESTING', 'REVIEWING', 'WAITING', 'NEEDS FAHAD', 'BLOCKED', 'COMPLETED', 'FAILED']) {
    assert.equal(isRed(deskSignal(employee('legal', state)).tone), RED_STATES.includes(state), state);
  }
  assert.ok(labelPriority(employee('legal', 'BLOCKED')) < labelPriority(employee('coding', 'WORKING')));
  assert.equal(labelPriority(employee('research', 'AVAILABLE'), 'research'), 0, 'the focus label comes first');
});

test('CHIEF Forum and system states come only from real rows', () => {
  const state = (chief, handoffs = [], extra = []) => ({ employees: [employee('chief', chief), ...extra], handoffs });
  assert.equal(forumState(state('AVAILABLE')), 'idle');
  assert.equal(forumState(state('THINKING')), 'active');
  assert.equal(forumState(state('WORKING', [{ fromKey: 'chief', toKey: 'legal', fresh: true }])), 'routing');
  assert.equal(forumState(state('WORKING', [{ fromKey: 'chief', toKey: 'legal', fresh: false }])), 'active', 'an old handoff does not route');
  assert.equal(forumState(state('COMPLETED')), 'completes');
  assert.equal(FORUM_STATES.active.strip, 0.4); assert.equal(FORUM_STATES.routing.ringPulse, 1.2); assert.equal(FORUM_STATES.completes.flare, 0.6);
  const quiet = systemState(state('AVAILABLE'));
  assert.equal(quiet.load, 'none'); assert.equal(quiet.allClear, true);
  const busy = systemState({ needsFahad: 1, employees: [employee('chief', 'WORKING'), employee('legal', 'WORKING', { queue: 4 }), employee('coding', 'NEEDS FAHAD'),
    employee('audit', 'BLOCKED'), employee('finance', 'FAILED'), employee('creative', 'WAITING', { resumesAt: '2026-10-08T10:00:00Z' }), employee('social', 'AVAILABLE', { enabled: false })] });
  assert.equal(busy.load, 'several'); assert.equal(busy.allClear, false);
  assert.deepEqual(busy.overloaded, [{ key: 'legal', queue: 4 }]);
  assert.deepEqual([busy.blocked, busy.failed, busy.approval, busy.offline, busy.providerWait], [['audit'], ['finance'], ['coding'], ['social'], ['creative']]);
});

test('stat bar: Working · Needs you · Blocked · Delivered today; red only above zero', () => {
  const now = new Date(2026, 9, 8, 15, 0).getTime();
  const today = new Date(2026, 9, 8, 9, 0).toISOString(); const yesterday = new Date(2026, 9, 7, 22, 0).toISOString();
  const quiet = statBar({ employees: [employee('chief', 'AVAILABLE')], needsFahad: 0 }, { deliveries: [{ at: yesterday }], now });
  assert.deepEqual(quiet.map((entry) => entry.id), ['working', 'needs', 'blocked', 'delivered']);
  assert.deepEqual(quiet.map((entry) => [entry.value, entry.tone]), [[0, 'neutral'], [0, 'neutral'], [0, 'neutral'], [0, 'neutral']]);
  const live = statBar({ employees: [employee('chief', 'WORKING'), employee('audit', 'FAILED'), employee('legal', 'BLOCKED')], needsFahad: 2 }, { deliveries: [{ at: today }, { at: today }, { at: yesterday }], now });
  assert.deepEqual(live.map((entry) => [entry.value, entry.tone]), [[1, 'neutral'], [2, 'attention'], [2, 'attention'], [2, 'neutral']]);
});

test('labels: LOD by distance; greedy slots never overlap, never cover the focus or a panel; RTL mirrors', () => {
  assert.deepEqual([LOD.far, LOD.near], [40, 15]);
  assert.deepEqual([lodFor(41), lodFor(40), lodFor(15), lodFor(14.9)], ['dot', 'name', 'name', 'full']);
  const ltr = slotBox({ x: 100, y: 100 }, [80, 20], 'up-end', false);
  const rtl = slotBox({ x: 100, y: 100 }, [80, 20], 'up-end', true);
  assert.ok(ltr.x < 100 && ltr.x + ltr.w > 150, 'LTR runs right'); assert.ok(rtl.x + rtl.w > 100 && rtl.x < 50, 'RTL runs left');
  // A crowd of nine labels around one point: no two boxes overlap.
  let seed = 7; const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let round = 0; round < 40; round += 1) {
    const entries = ZONE_KEYS.map((key, index) => ({ key, priority: index % 4, distance: 20 + random() * 30,
      anchor: { x: 300 + random() * 200, y: 200 + random() * 150, visible: true }, sizes: { full: [150, 46], name: [96, 22] } }));
    const focus = { x: 380, y: 260, w: 60, h: 40 };
    const panel = { x: 0, y: 0, w: 800, h: 60 };
    const result = layoutLabels(entries, { width: 800, height: 600, avoid: [panel], focus, rtl: round % 2 === 1, lodScale: 1 });
    const boxes = result.filter((entry) => entry.box).map((entry) => entry.box);
    for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) assert.ok(!overlaps(boxes[i], boxes[j]), `round ${round}: labels overlap`);
    for (const box of boxes) { assert.ok(!overlaps(box, focus), 'covers the focus'); assert.ok(!overlaps(box, panel), 'covers a panel'); }
    assert.equal(result.length, entries.length);
  }
  // Demotion: no room for the full card → the name; no room at all → the dot.
  const crowded = layoutLabels([{ key: 'a', priority: 0, distance: 5, anchor: { x: 30, y: 30, visible: true }, sizes: { full: [300, 60], name: [40, 20] } }], { width: 120, height: 120 });
  assert.equal(crowded[0].lod, 'name');
  const none = layoutLabels([{ key: 'a', priority: 0, distance: 5, anchor: { x: 30, y: 30, visible: true }, sizes: { full: [300, 60], name: [300, 20] } }], { width: 120, height: 120 });
  assert.equal(none[0].lod, 'dot'); assert.equal(none[0].box, null);
  const hidden = layoutLabels([{ key: 'a', priority: 0, distance: 5, anchor: { x: 30, y: 30, visible: false }, sizes: { full: [30, 10], name: [20, 10] } }], { width: 120, height: 120 });
  assert.equal(hidden[0].lod, 'hidden');
});

test('close views cut away only the columns between the camera and the focus', () => {
  // A column on the line of sight is hidden; one behind the target, one behind
  // the camera and one far to the side stay.
  const hidden = occluders([0, 10, 0], [10, 1, 0], [[5, 0], [12, 0], [-2, 0], [5, 9], [8, 1]], { halfAngle: 0.5, keep: [7, -2, 13, 2] });
  assert.deepEqual(hidden, [0]);
  // Department views: every column hidden is really between camera and department.
  for (const key of Object.keys(ZONES).filter((name) => name !== 'chief')) {
    const view = departmentView(key);
    for (const index of occluders(view.position, view.target, COLUMNS, { keep: ZONES[key].bounds })) {
      const [x, z] = COLUMNS[index];
      const toColumn = Math.hypot(x - view.position[0], z - view.position[2]);
      assert.ok(toColumn < Math.hypot(view.target[0] - view.position[0], view.target[2] - view.position[2]), `${key}: column ${index} is not in front`);
    }
  }
});
