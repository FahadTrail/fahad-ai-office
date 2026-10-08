// The Office plan (Final Design Spec, "Daylight Atrium"): one 48 × 32 m
// single-storey headquarters on a 3 × 3 grid. The CHIEF Forum is at the
// centre, under the atrium; departments 01–08 are numbered clockwise from
// the north-west; the entrance is from the south. Pure data, no Three.js:
// the renderer, the camera, the handoff routes and the labels all read it.
//
// Coordinates: metres, origin at the centre of the Forum, +x east, +z south,
// +y up. A workspace's yaw is the direction its employee faces:
// yaw 0 = north (−z), π = south, −π/2 = east, π/2 = west.

export const OFFICE = Object.freeze({ width: 48, depth: 32, ceiling: 4.2, atrium: 8.4, minX: -24, maxX: 24, minZ: -16, maxZ: 16 });

// Grid lines: three bays each way (west 14 · centre 20 · east 14; north 9 ·
// middle 14 · south 9).
export const GRID = Object.freeze({ x: Object.freeze([-24, -10, 10, 24]), z: Object.freeze([-16, -7, 7, 16]) });

// The CHIEF Forum: Ø 10 m, sunk 0.45 m in three steps, under a Ø 8 m oculus.
export const FORUM = Object.freeze({
  x: 0, z: 0, radius: 5, depth: 0.45, steps: 3, tread: 0.4, oculusRadius: 4,
  table: Object.freeze({ x: 0, z: 0.1, length: 3.6, width: 1.3, height: 0.74 }),
});
// The Promenade ring around the Forum (honed travertine) and its brass
// inlay; the Forum ring inlay runs on the Forum's edge.
export const PROMENADE = Object.freeze({ inner: 5, outer: 7, inlay: 6, forumInlay: 4.85 });
// The Office Wall: 7.2 × 2.4 m on the atrium's north partition, facing the
// Forum. Numerals on it are at least 0.18 m tall (screens.js).
export const OFFICE_WALL = Object.freeze({ x: 0, z: -6.82, width: 7.2, height: 2.4, bottom: 1.25, facing: Math.PI });

export const ZONE_KEYS = Object.freeze(['chief', 'research', 'creative', 'social', 'coding', 'product', 'finance', 'audit', 'legal']);

// Departments, numbered clockwise. kind: open | glazed. kelvin: the
// department's own light colour shift (Coding −200 K, Legal +200 K).
// spoke: where the department's spoke meets it (its threshold).
// desk: the employee's workstation (x, z, yaw). display: the 75" department
// screen on a linen wall section of the far façade, facing the Forum.
export const ZONES = Object.freeze({
  chief: zone({ number: '00', name: 'CHIEF', nameAr: 'الرئيس', kind: 'forum', bounds: [-7, -7, 7, 7],
    threshold: [0, 0], desk: [0, 0.1, 0], signature: 'forum', props: 'executive', posture: 'seated' }),
  research: zone({ number: '01', name: 'Research', nameAr: 'البحث', kind: 'open', note: 'library', bounds: [-24, -16, -10, -7],
    threshold: [-10.6, -7.6], desk: [-17.6, -12.4, 0], display: [-17.6, -15.82, 4.6], signature: 'library', props: 'reading', posture: 'seated' }),
  creative: zone({ number: '02', name: 'Creative', nameAr: 'الإبداع', kind: 'open', note: 'studio', bounds: [-10, -16, 0, -7],
    threshold: [-5, -7], desk: [-5.4, -11.15, 0], display: [-3.3, -15.82, 4.2], signature: 'pinboard', props: 'studio', posture: 'seated' }),
  social: zone({ number: '03', name: 'Social', nameAr: 'السوشال', kind: 'open', note: 'studio', bounds: [0, -16, 10, -7],
    threshold: [5, -7], desk: [5.2, -12.1, 0], display: [6.4, -15.82, 4.2], signature: 'standing-bench', props: 'phones', posture: 'standing' }),
  coding: zone({ number: '04', name: 'Coding', nameAr: 'البرمجة', kind: 'open', bounds: [10, -16, 24, -7], kelvin: -200,
    threshold: [10.6, -7.6], desk: [16, -12.3, 0], display: [17.2, -15.82, 4.6], signature: 'dual-bench', props: 'engineering', posture: 'seated' }),
  product: zone({ number: '05', name: 'Product', nameAr: 'المنتج', kind: 'open', bounds: [10, -7, 24, 7],
    threshold: [10, 0], desk: [18.4, 0.6, -Math.PI / 2], display: [23.82, 0.6, 4.6], signature: 'whiteboard', props: 'collaboration', posture: 'seated' }),
  finance: zone({ number: '06', name: 'Finance', nameAr: 'المالية', kind: 'glazed', bounds: [10, 7, 24, 16],
    threshold: [10.55, 7.55], desk: [17, 11.15, Math.PI], display: [17, 15.82, 4.6], signature: 'meeting-table', props: 'documents', posture: 'seated' }),
  audit: zone({ number: '07', name: 'Audit', nameAr: 'التدقيق', kind: 'glazed', bounds: [-24, 7, -10, 16],
    threshold: [-10.55, 7.55], desk: [-17.2, 12.2, Math.PI], display: [-17.2, 15.82, 4.6], signature: 'archive', props: 'review', posture: 'seated' }),
  legal: zone({ number: '08', name: 'Legal', nameAr: 'القانونية', kind: 'glazed', bounds: [-24, -7, -10, 7], kelvin: 200,
    threshold: [-10, 0], desk: [-18.4, -0.6, Math.PI / 2], display: [-23.82, -0.6, 4.6], signature: 'legal-library', props: 'review', posture: 'seated' }),
});

// Rooms that are not departments.
export const ROOMS = Object.freeze({
  arrival: Object.freeze({ name: 'Arrival + Commons', nameAr: 'الاستقبال والمساحة المشتركة', kind: 'open', bounds: Object.freeze([-10, 7, 2, 16]), entrance: Object.freeze([-1.6, 1.6]) }),
  boardroom: Object.freeze({ name: 'Boardroom', nameAr: 'غرفة الاجتماعات', kind: 'glazed', bounds: Object.freeze([2, 7, 10, 16]), seats: 14, door: Object.freeze([6, 7]) }),
});

// Glazed rooms: low-iron glass with bronze mullions and a frosted privacy
// band. Each segment is [x1, z1, x2, z2, door?]; door is a [x, z] centre of
// a DOOR_WIDTH opening, or 'open' for a whole-segment doorway. Where a
// glazed room meets the Promenade at a grid corner the corner is chamfered:
// the chamfer is its doorway, so the spoke never meets a glass corner.
export const GLASS = Object.freeze([
  // 08 Legal: north, the chamfer toward Research, east (door on its spoke), south.
  Object.freeze([-24, -7, -11.1, -7]),
  Object.freeze([-11.1, -7, -10, -5.9]),
  Object.freeze([-10, -5.9, -10, 7, Object.freeze([-10, 0])]),
  Object.freeze([-24, 7, -10, 7]),
  // 07 Audit: chamfered doorway at the inner corner, east wall on Arrival.
  Object.freeze([-11.1, 7, -10, 8.1, 'open']),
  Object.freeze([-10, 8.1, -10, 16]),
  // 06 Finance: north wall on Product, chamfered doorway, west wall on the Boardroom.
  Object.freeze([11.1, 7, 24, 7]),
  Object.freeze([10, 8.1, 11.1, 7, 'open']),
  Object.freeze([10, 8.1, 10, 16]),
  // Boardroom: chamfered glass corner, north wall (door), west wall on the Commons.
  Object.freeze([8.9, 7, 10, 8.1]),
  Object.freeze([2, 7, 8.9, 7, Object.freeze([6, 7])]),
  Object.freeze([2, 7, 2, 16]),
]);
export const DOOR_WIDTH = 1.6;
export const PRIVACY_BAND = Object.freeze({ bottom: 0.95, top: 1.55 });

// Solid partitions (microcement): the atrium's north wall that carries the
// Office Wall, and the Research library wall between Research and Creative.
export const PARTITIONS = Object.freeze([
  Object.freeze({ id: 'office-wall', from: Object.freeze([-4.6, -7]), to: Object.freeze([4.6, -7]), height: OFFICE.ceiling, thickness: 0.35, finish: 'microcement' }),
]);

// Structural columns (microcement, Ø 0.45 m): a colonnade of six around
// the atrium, set between the spokes, and the grid columns along the
// department lines (none stands on a spoke or a doorway).
export const COLUMN_RADIUS = 0.225;
export const COLUMNS = Object.freeze([
  ...[20, 72, 108, -20, -72, -108].map((degrees) => { const angle = (degrees * Math.PI) / 180; return [round(Math.sin(angle) * 7.7), round(Math.cos(angle) * 6.6)]; }),
  ...[[-10, -3.5], [-10, 3.5], [10, -3.5], [10, 3.5], [-17, -7], [17, -7], [-17, 7], [17, 7]],
].map((point) => Object.freeze(point)));

// Façade: low-iron glass between bronze fins every 1.2 m; solid linen-clad
// sections behind each department display; the entrance on the south.
export const FACADE = Object.freeze({ finSpacing: 1.2, finDepth: 0.32, finWidth: 0.05, solidWidth: 5.2 });

// Ceiling: white-oak slats 40 × 120 mm on black felt; the atrium rises to
// 8.4 m over the Promenade with the Ø 8 m oculus over the Forum.
export const CEILING = Object.freeze({ slatWidth: 0.04, slatDepth: 0.12, pitch: 0.12, atriumBounds: Object.freeze([-10, -7, 10, 7]) });

// Planting and décor (positions only; species decide the model).
export const PLANTS = Object.freeze([
  ['olive', -8.2, -5.4], ['olive', 8.2, -5.4], ['olive', -8.2, 5.4], ['olive', 8.2, 5.4],
  ['ficus', -22.6, -8.4], ['ficus', 22.6, -8.4], ['ficus', 22.6, 8.4], ['ficus', -22.6, 8.4],
  ['strelitzia', -9, 14.6], ['strelitzia', 1, 14.8], ['strelitzia', 11, -14.8],
  ['zamioculcas', -13.2, -8], ['zamioculcas', 13.2, -15], ['zamioculcas', -2, -8], ['zamioculcas', 13.2, 8.2], ['zamioculcas', -13.2, 15.2],
].map((entry) => Object.freeze(entry)));

// ------------------------------------------------------------------ helpers

function zone({ bounds, threshold, desk, display, kelvin = 0, ...rest }) {
  const [minX, minZ, maxX, maxZ] = bounds;
  return Object.freeze({
    ...rest, kelvin,
    bounds: Object.freeze(bounds),
    centre: Object.freeze([(minX + maxX) / 2, (minZ + maxZ) / 2]),
    threshold: Object.freeze(threshold),
    desk: Object.freeze({ x: desk[0], z: desk[1], yaw: desk[2] }),
    display: display ? Object.freeze({ x: display[0], z: display[1], width: display[2] }) : null,
  });
}
function round(value) { return Math.round(value * 1000) / 1000; }

export function zoneOf(key) { return ZONES[key] || null; }

// The floor point in front of the employee's chair: labels and the end of
// every handoff route.
export function seatPoint(key) {
  const zone = ZONES[key];
  if (!zone) return null;
  const { x, z, yaw } = zone.desk;
  const back = key === 'chief' ? 0.95 : zone.posture === 'standing' ? 0.7 : 0.95;
  return [round(x + Math.sin(yaw) * back), round(z + Math.cos(yaw) * back)];
}

// Where the employee's floor label is anchored (a 6 px ring on the floor).
export function labelAnchor(key) {
  const seat = seatPoint(key);
  if (!seat) return null;
  return [seat[0], key === 'chief' ? -FORUM.depth : 0, seat[1]];
}

// The bounding box of a zone in 3D (for camera framing): [min, max].
export function zoneBox(key) {
  const zone = ZONES[key];
  if (!zone) return null;
  // CHIEF: the Forum plus the Office Wall it faces.
  const [minX, minZ, maxX, maxZ] = key === 'chief' ? [-FORUM.radius, OFFICE_WALL.z - 0.2, FORUM.radius, FORUM.radius] : zone.bounds;
  return [[minX, key === 'chief' ? -FORUM.depth : 0, minZ], [maxX, key === 'chief' ? OFFICE_WALL.bottom + OFFICE_WALL.height : 2.6, maxZ]];
}
export const OFFICE_BOX = Object.freeze([Object.freeze([OFFICE.minX, 0, OFFICE.minZ]), Object.freeze([OFFICE.maxX, 3, OFFICE.maxZ])]);

// Department by number key: '0'–'8' (keyboard navigation).
export function zoneByNumber(digit) {
  return ZONE_KEYS.find((key) => ZONES[key].number === `0${digit}`) || null;
}

// Which zone or room a floor point belongs to.
export function zoneAt(x, z) {
  if (Math.hypot(x - FORUM.x, z - FORUM.z) <= PROMENADE.outer) return 'chief';
  for (const key of ZONE_KEYS) {
    if (key === 'chief') continue;
    const [minX, minZ, maxX, maxZ] = ZONES[key].bounds;
    if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) return key;
  }
  for (const [key, room] of Object.entries(ROOMS)) {
    const [minX, minZ, maxX, maxZ] = room.bounds;
    if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) return key;
  }
  return 'promenade';
}

// Floor height at a point: the Forum is sunk 0.45 m in three steps.
export function floorHeight(x, z) {
  const r = Math.hypot(x - FORUM.x, z - FORUM.z);
  if (r >= FORUM.radius) return 0;
  const inner = FORUM.radius - FORUM.steps * FORUM.tread;
  if (r <= inner) return -FORUM.depth;
  const step = Math.ceil((FORUM.radius - r) / FORUM.tread);
  return -Math.min(FORUM.steps, step) * (FORUM.depth / FORUM.steps);
}
