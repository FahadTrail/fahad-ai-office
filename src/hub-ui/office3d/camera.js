// Navigation & camera (Final Design Spec §09): six camera states with a
// fixed lens and elevation, framed by fitting real bounding boxes. Pure
// maths (no Three.js), tested in Node.
//
//   Overview    38° FOV, 52° elevation, from the SE. Office bbox + 8 %.
//   Department  32°, 38°, from the Promenade. Department bbox + 15 %.
//   Agent       28°, 18°, ¾ over the shoulder at 3.2 m.
//   CHIEF       30°, 28°, from the south. Table lower third, wall upper third.
//   Handoffs    34°, 70°, above centre. All routes + 10 %.
//   Idle        slow orbit at 0.6°/s after 90 s without input; any input stops it.
//
// Transitions take 700–900 ms on cubic-bezier(0.22, 1, 0.36, 1) and arc
// above the glass. Keys 0–8 jump to zones; Esc steps back.
import { FORUM, OFFICE, OFFICE_BOX, OFFICE_WALL, ZONES, zoneBox } from './plan.js?v=__UI_VERSION__';

export const CAMERA_STATES = Object.freeze({
  overview: Object.freeze({ fov: 38, elevation: 52, bearing: 135, margin: 0.08 }),
  department: Object.freeze({ fov: 32, elevation: 38, margin: 0.15 }),
  agent: Object.freeze({ fov: 28, elevation: 18, distance: 3.2, shoulder: 35 }),
  chief: Object.freeze({ fov: 30, elevation: 28, bearing: 180, margin: 0.1 }),
  handoffs: Object.freeze({ fov: 34, elevation: 70, bearing: 160, margin: 0.1 }),
  idle: Object.freeze({ degreesPerSecond: 0.6, afterSeconds: 90 }),
});
export const TRANSITION = Object.freeze({ min: 700, max: 900, bezier: Object.freeze([0.22, 1, 0.36, 1]), arcClearance: OFFICE.ceiling + 0.8 });

const DEG = Math.PI / 180;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const length = Math.hypot(...a) || 1; return scale(a, 1 / length); };
const round3 = (value) => Math.round(value * 1000) / 1000;
const roundVec = (vector) => vector.map(round3);

// The unit vector from a target toward a camera at a compass bearing
// (0 north, 90 east, 180 south) and an elevation (degrees).
export function direction(bearing, elevation) {
  const az = bearing * DEG; const el = elevation * DEG;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
}
// Compass bearing of a horizontal vector (dx, dz).
export function bearingOf(dx, dz) { return ((Math.atan2(dx, -dz) / DEG) + 360) % 360; }

// Projects a point to normalised device coordinates for a camera.
export function project(point, { position, target, fov, aspect }) {
  const forward = norm(sub(target, position));
  const right = norm(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const v = sub(point, position);
  const z = dot(v, forward);
  const t = Math.tan((fov * DEG) / 2);
  return { x: dot(v, right) / (z * t * aspect), y: dot(v, up) / (z * t), z };
}

const corners = ([min, max]) => {
  const list = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) list.push([x, y, z]);
  return list;
};
export function grow([min, max], fraction) {
  const centre = scale(add(min, max), 0.5);
  const half = scale(sub(max, min), 0.5 * (1 + fraction));
  return [sub(centre, half), add(centre, half)];
}

// Frames a box: the closest distance at which every corner fits inside the
// safe area (NDC insets for the overlay), with the box centred in it.
// insets: { top, bottom, left, right } as fractions of the half-height/width.
export function frame({ box, bearing, elevation, fov, aspect, margin = 0, insets = {} }) {
  const grown = grow(box, margin);
  const points = corners(grown);
  const dir = direction(bearing, elevation);
  const limits = { top: 1 - (insets.top || 0) * 2, bottom: -1 + (insets.bottom || 0) * 2, left: -1 + (insets.left || 0) * 2, right: 1 - (insets.right || 0) * 2 };
  let target = scale(add(grown[0], grown[1]), 0.5);
  let distance = 40;
  for (let pass = 0; pass < 4; pass += 1) {
    const fits = (d) => {
      const camera = { position: add(target, scale(dir, d)), target, fov, aspect };
      return points.every((point) => { const p = project(point, camera); return p.z > 0.1 && p.x >= limits.left && p.x <= limits.right && p.y >= limits.bottom && p.y <= limits.top; });
    };
    let low = 0.5; let high = 400;
    for (let step = 0; step < 40; step += 1) { const mid = (low + high) / 2; if (fits(mid)) high = mid; else low = mid; }
    distance = high;
    // Re-centre the box inside the safe area, then fit again.
    const camera = { position: add(target, scale(dir, distance)), target, fov, aspect };
    const projected = points.map((point) => project(point, camera));
    const cx = (Math.min(...projected.map((p) => p.x)) + Math.max(...projected.map((p) => p.x))) / 2 - (limits.left + limits.right) / 2;
    const cy = (Math.min(...projected.map((p) => p.y)) + Math.max(...projected.map((p) => p.y))) / 2 - (limits.top + limits.bottom) / 2;
    if (Math.abs(cx) < 0.002 && Math.abs(cy) < 0.002) break;
    const forward = scale(dir, -1);
    const right = norm(cross(forward, [0, 1, 0]));
    const up = cross(right, forward);
    const t = Math.tan((fov * DEG) / 2) * distance;
    target = add(target, add(scale(right, cx * t * aspect), scale(up, cy * t)));
  }
  return { position: roundVec(add(target, scale(dir, distance))), target: roundVec(target), fov, distance: round3(distance) };
}

// ------------------------------------------------------------------ states

export function overviewView({ aspect = 16 / 9, insets } = {}) {
  const state = CAMERA_STATES.overview;
  return { name: 'overview', ...frame({ box: OFFICE_BOX, bearing: state.bearing, elevation: state.elevation, fov: state.fov, aspect, margin: state.margin, insets }) };
}

// From the Promenade into the department: the camera stands on the Forum
// side of the department and looks outward across it.
export function departmentView(key, { aspect = 16 / 9, insets } = {}) {
  const zone = ZONES[key];
  if (!zone || key === 'chief') return null;
  const state = CAMERA_STATES.department;
  const [cx, cz] = zone.centre;
  return { name: 'department', key, ...frame({ box: zoneBox(key), bearing: bearingOf(-cx, -cz), elevation: state.elevation, fov: state.fov, aspect, margin: state.margin, insets }) };
}

// ¾ over the shoulder at 3.2 m: behind the employee, turned 35° toward the
// Promenade side, looking at the desk and its monitors.
export function agentView(key) {
  const zone = ZONES[key];
  if (!zone) return null;
  const state = CAMERA_STATES.agent;
  const { x, z, yaw } = zone.desk;
  const floor = key === 'chief' ? -FORUM.depth : 0;
  const target = [x, floor + 1.02, z];
  const back = [Math.sin(yaw), Math.cos(yaw)];
  // Turn toward the Forum side so the shoulder view looks into the Office.
  const toForum = [-x, -z];
  const side = back[0] * toForum[1] - back[1] * toForum[0] >= 0 ? 1 : -1;
  const angle = side * state.shoulder * DEG;
  const dir2 = [back[0] * Math.cos(angle) - back[1] * Math.sin(angle), back[0] * Math.sin(angle) + back[1] * Math.cos(angle)];
  const bearing = bearingOf(dir2[0], dir2[1]);
  const dir = direction(bearing, state.elevation);
  return { name: 'agent', key, position: roundVec(add(target, scale(dir, state.distance))), target: roundVec(target), fov: state.fov, distance: state.distance };
}

// From the south across the Forum to the Office Wall: the table sits in the
// lower third of the frame and the wall in the upper third.
export function chiefView({ aspect = 16 / 9, insets } = {}) {
  const state = CAMERA_STATES.chief;
  const table = FORUM.table;
  const box = [[-OFFICE_WALL.width / 2, -FORUM.depth, OFFICE_WALL.z], [OFFICE_WALL.width / 2, OFFICE_WALL.bottom + OFFICE_WALL.height, table.z + table.width / 2 + 1.1]];
  return { name: 'chief', key: 'chief', ...frame({ box, bearing: state.bearing, elevation: state.elevation, fov: state.fov, aspect, margin: state.margin, insets }) };
}

// High above the centre: every route of the moment, plus 10 %.
export function handoffsView(routes = [], { aspect = 16 / 9, insets } = {}) {
  const state = CAMERA_STATES.handoffs;
  const points = routes.flat();
  const box = points.length
    ? [[Math.min(...points.map((p) => p[0])), 0, Math.min(...points.map((p) => p[1]))], [Math.max(...points.map((p) => p[0])), 1, Math.max(...points.map((p) => p[1]))]]
    : [[-12, 0, -9], [12, 1, 9]];
  return { name: 'handoffs', ...frame({ box, bearing: state.bearing, elevation: state.elevation, fov: state.fov, aspect, margin: state.margin, insets }) };
}

// The idle orbit: the overview, turned around its target at 0.6°/s.
export function orbit(view, seconds) {
  const angle = CAMERA_STATES.idle.degreesPerSecond * seconds * DEG;
  const offset = sub(view.position, view.target);
  const rotated = [offset[0] * Math.cos(angle) - offset[2] * Math.sin(angle), offset[1], offset[0] * Math.sin(angle) + offset[2] * Math.cos(angle)];
  return { ...view, position: roundVec(add(view.target, rotated)) };
}

// Esc steps back one level: agent → its department → overview.
export function stepBack(view) {
  if (!view || view.name === 'overview') return { name: 'overview' };
  if (view.name === 'agent' && view.key && view.key !== 'chief') return { name: 'department', key: view.key };
  return { name: 'overview' };
}

// ------------------------------------------------------------------ motion

// CSS cubic-bezier(x1, y1, x2, y2) as a function of time (0..1).
export function cubicBezier(x1, y1, x2, y2) {
  const bx = (t) => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3;
  const by = (t) => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3;
  const dx = (t) => 3 * x1 * (1 - t) ** 2 + 6 * (x2 - x1) * t * (1 - t) + 3 * (1 - x2) * t * t;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let step = 0; step < 8; step += 1) { const error = bx(t) - x; const slope = dx(t); if (Math.abs(error) < 1e-6 || !slope) break; t -= error / slope; }
    t = Math.max(0, Math.min(1, t));
    return by(t);
  };
}
export const ease = cubicBezier(...TRANSITION.bezier);

// 700–900 ms: longer journeys take a little longer.
export function transitionMs(from, to) {
  const travel = Math.hypot(...sub(from.position, to.position)) + Math.hypot(...sub(from.target, to.target)) * 0.5;
  return Math.round(TRANSITION.min + (TRANSITION.max - TRANSITION.min) * Math.min(1, travel / 40));
}

// A point on the move between two views at progress t (0..1). When both ends
// are below the ceiling in different places the camera rises above the
// glass mid-way instead of flying through it.
export function between(from, to, t) {
  const e = ease(t);
  const lerp = (a, b) => a.map((value, index) => value + (b[index] - value) * e);
  const position = lerp(from.position, to.position);
  const target = lerp(from.target, to.target);
  const low = Math.min(from.position[1], to.position[1]);
  const apart = Math.hypot(from.position[0] - to.position[0], from.position[2] - to.position[2]);
  if (low < TRANSITION.arcClearance && apart > 2) {
    const peak = Math.max(0, TRANSITION.arcClearance - low) + Math.min(4, apart * 0.08);
    position[1] += peak * Math.sin(Math.PI * t);
  }
  return { position, target, fov: from.fov + (to.fov - from.fov) * e };
}

// The ceiling over a zone draws only while the camera is beneath it.
export function ceilingVisible(cameraY, height) { return cameraY < height - 0.25; }
