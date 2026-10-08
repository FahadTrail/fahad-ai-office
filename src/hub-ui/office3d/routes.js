// Handoffs travel as light along the brass inlay set into the floor
// (Final Design Spec §07). Pure geometry and timing, tested in Node:
//
//   path:  desk → spoke → Promenade → (Forum ring) → spoke → desk
//   pulse: a 1.2 m comet at 4 m/s; a trip lasts 2.5–6 s
//   fade:  the tail fades over 1.2 s; an 8 % ember stays for 30 s
//   concurrency: at most 6 visible, 80 mm apart; more bundle as ×N
//   blocked: a red dot held at the destination threshold, pulsing every 6 s
//
// Only real handoff records are ever routed (office-presentation.js).
import { FORUM, PROMENADE, ZONES, seatPoint } from './plan.js?v=__UI_VERSION__';

export const PULSE = Object.freeze({
  length: 1.2, speed: 4, minTrip: 2.5, maxTrip: 6, fade: 1.2, ember: 0.08, emberSeconds: 30,
  emissiveDay: 0.6, emissiveNight: 1.4, maxVisible: 6, laneSpacing: 0.08, blockedPulse: 6, arrivalRamp: 0.4, fromLabelSeconds: 3,
});

const TAU = Math.PI * 2;
const polar = (angle, radius) => [Math.sin(angle) * radius, Math.cos(angle) * radius];
const angleOf = ([x, z]) => Math.atan2(x, z);

// Where each department's spoke meets the Promenade inlay.
export function spokeAngle(key) {
  const zone = ZONES[key];
  if (!zone || key === 'chief') return null;
  return angleOf(zone.threshold);
}

// Arc samples from angle a to angle b the short way round, at radius r.
function arc(a, b, radius, step = 0.35) {
  let delta = ((b - a) % TAU + TAU) % TAU;
  if (delta > Math.PI) delta -= TAU;
  const count = Math.max(1, Math.ceil(Math.abs(delta * radius) / step));
  return Array.from({ length: count + 1 }, (_, index) => polar(a + (delta * index) / count, radius));
}

// The inlay route between two employees: a list of [x, z] floor points.
// CHIEF's route leaves the Promenade, crosses into the Forum ring and goes
// round it to the table; everyone else meets on the Promenade ring.
export function routePath(fromKey, toKey) {
  if (!ZONES[fromKey] || !ZONES[toKey] || fromKey === toKey) return null;
  const leg = (key) => {
    if (key === 'chief') return null;
    const zone = ZONES[key];
    return { seat: seatPoint(key), threshold: [...zone.threshold], angle: spokeAngle(key) };
  };
  const [from, to] = [leg(fromKey), leg(toKey)];
  const chiefSeat = seatPoint('chief');
  const chiefAngle = angleOf(chiefSeat);
  const points = [];
  const push = (point) => { const last = points.at(-1); if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) > 1e-3) points.push([round(point[0]), round(point[1])]); };
  if (from) { push(from.seat); push(from.threshold); push(polar(from.angle, PROMENADE.inlay)); }
  else { push(chiefSeat); for (const point of arc(chiefAngle, to.angle, PROMENADE.forumInlay)) push(point); }
  if (from && to) for (const point of arc(from.angle, to.angle, PROMENADE.inlay)) push(point);
  if (!to) { push(polar(from.angle, PROMENADE.forumInlay)); for (const point of arc(from.angle, chiefAngle, PROMENADE.forumInlay)) push(point); push(chiefSeat); }
  else { if (!from) push(polar(to.angle, PROMENADE.inlay)); push(to.threshold); push(to.seat); }
  return points;
}

export function pathLength(points) {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) length += Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]);
  return length;
}

// Cumulative distances, for sampling by arc length.
export function measure(points) {
  const distances = [0];
  for (let index = 1; index < points.length; index += 1) distances.push(distances[index - 1] + Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]));
  return distances;
}
export function pointAt(points, distances, s) {
  const total = distances.at(-1);
  const target = Math.max(0, Math.min(total, s));
  let index = 1;
  while (index < distances.length - 1 && distances[index] < target) index += 1;
  const span = distances[index] - distances[index - 1] || 1;
  const t = (target - distances[index - 1]) / span;
  const [a, b] = [points[index - 1], points[index]];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// A parallel lane 80 mm to the side, so simultaneous handoffs never merge.
export function offsetPath(points, offset) {
  if (!offset) return points.map((point) => [...point]);
  return points.map((point, index) => {
    const prev = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const dx = next[0] - prev[0]; const dz = next[1] - prev[1];
    const length = Math.hypot(dx, dz) || 1;
    return [round(point[0] - (dz / length) * offset), round(point[1] + (dx / length) * offset)];
  });
}

// The trip: 4 m/s, never shorter than 2.5 s or longer than 6 s.
export function tripSeconds(length) {
  return Math.min(PULSE.maxTrip, Math.max(PULSE.minTrip, length / PULSE.speed));
}

// The comet's brightness at distance s along the route when its head is at
// h (metres): full at the head, falling off over the 1.2 m tail; zero ahead.
export function cometAt(s, head) {
  const behind = head - s;
  if (behind < 0 || behind > PULSE.length) return 0;
  const t = 1 - behind / PULSE.length;
  return t * t;
}

// After arrival: the tail fades over 1.2 s, then an 8 % ember stays for 30 s.
export function afterglow(secondsSinceArrival) {
  if (secondsSinceArrival < 0) return 1;
  if (secondsSinceArrival < PULSE.fade) return 1 - (1 - PULSE.ember) * (secondsSinceArrival / PULSE.fade);
  if (secondsSinceArrival < PULSE.emberSeconds) return PULSE.ember;
  return 0;
}

// Which fresh handoffs draw, in which lane, and which bundle as ×N. At most
// six are visible; routes sharing a destination beyond that become one
// bundle badge at the destination. Each visible route gets its own lane.
export function planPulses(handoffs, { max = PULSE.maxVisible } = {}) {
  const valid = handoffs.filter((handoff) => ZONES[handoff.fromKey] && ZONES[handoff.toKey] && handoff.fromKey !== handoff.toKey)
    .toSorted((a, b) => String(b.at).localeCompare(String(a.at)));
  const visible = valid.slice(0, max);
  const lanes = visible.map((handoff, index) => ({ handoff, lane: index, offset: round((index - (visible.length - 1) / 2) * PULSE.laneSpacing) }));
  const bundles = new Map();
  for (const handoff of valid.slice(max)) bundles.set(handoff.toKey, (bundles.get(handoff.toKey) || 0) + 1);
  return { visible: lanes, bundles: [...bundles].map(([toKey, count]) => ({ toKey, count })) };
}

// A blocked handoff holds a red dot at the destination's threshold.
export function blockedHold(handoff) {
  if (!['blocked', 'failed'].includes(handoff?.status) || !ZONES[handoff.toKey]) return null;
  const zone = ZONES[handoff.toKey];
  const point = handoff.toKey === 'chief' ? polar(angleOf(seatPoint('chief')), FORUM.radius) : zone.threshold;
  return { key: handoff.toKey, point: [round(point[0]), round(point[1])], period: PULSE.blockedPulse };
}

// Every inlay segment of the Office, for drawing the brass: the eight
// spokes (threshold → Promenade), the Promenade ring, the Forum ring and
// each department's short run from its threshold to the desk.
export function inlayNetwork() {
  const segments = [];
  for (const key of Object.keys(ZONES)) {
    if (key === 'chief') continue;
    const zone = ZONES[key];
    segments.push({ kind: 'spoke', key, points: [[...zone.threshold], polar(spokeAngle(key), PROMENADE.outer)].map(roundPoint) });
    segments.push({ kind: 'desk', key, points: [seatPoint(key), [...zone.threshold]].map(roundPoint) });
  }
  segments.push({ kind: 'ring', key: 'promenade', points: arcFull(PROMENADE.inlay) });
  segments.push({ kind: 'ring', key: 'forum', points: arcFull(PROMENADE.forumInlay) });
  return segments;
}
function arcFull(radius) { return Array.from({ length: 97 }, (_, index) => roundPoint(polar((index / 96) * TAU, radius))); }
function roundPoint(point) { return [round(point[0]), round(point[1])]; }
function round(value) { return Math.round(value * 1000) / 1000; }
