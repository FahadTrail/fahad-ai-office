// The building (Final Design Spec §01–§02): a 48 × 32 m single storey with
// a 4.2 m ceiling and an 8.4 m atrium. Honed travertine on the Promenade and
// in Arrival, white-oak plank in the departments, the CHIEF Forum sunk
// 0.45 m in three steps, a 12 mm brass inlay on the Promenade ring, the Forum
// ring and eight spokes, microcement columns, low-iron glazing between
// bronze fins, glazed rooms with privacy bands, oak slats on black felt and
// the Ø 8 m oculus.
//
// The ceilings and the roof are cut away whenever the camera rises above
// them; an invisible roof still casts the sun's shadow, so daylight only
// enters through the façades, the clerestory and the oculus.
import * as THREE from '../vendor/three.js?v=__UI_VERSION__';
import { CEILING, COLUMNS, COLUMN_RADIUS, DOOR_WIDTH, FACADE, FORUM, GLASS, OFFICE, OFFICE_WALL, PARTITIONS, PRIVACY_BAND, ROOMS, ZONES, floorHeight } from './plan.js?v=__UI_VERSION__';
import { inlayNetwork } from './routes.js?v=__UI_VERSION__';
import { createBuilder, stripGeometry } from './builder.js?v=__UI_VERSION__';

const SLAB = 0.3;
const INLAY_WIDTH = 0.012;

export function buildArchitecture({ materials, tier }) {
  const root = new THREE.Group(); root.name = 'architecture';
  const lowCeiling = new THREE.Group(); lowCeiling.name = 'ceiling-low';
  const highCeiling = new THREE.Group(); highCeiling.name = 'ceiling-high';
  const casters = new THREE.Group(); casters.name = 'roof-shadow';
  root.add(lowCeiling, highCeiling, casters);
  const b = createBuilder(materials);
  const disposables = [];

  // ------------------------------------------------------------ the site
  // Low sage planting all around, a band of honed limestone terrace, the
  // building on its plinth. Fog carries the ground into the horizon.
  const ground = new THREE.Mesh(new THREE.CircleGeometry(160, 64), materials.get('lawn'));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.36; ground.receiveShadow = true;
  root.add(ground); disposables.push(ground.geometry);
  b.box(OFFICE.width + 14, 0.1, OFFICE.depth + 14, 'terrace', { y: -0.36, radius: 0 , cast: false });
  b.box(OFFICE.width + 14.4, 0.08, OFFICE.depth + 14.4, 'microcement', { y: -0.39, radius: 0, cast: false });
  // The entrance walk to the south door.
  b.box(4.4, 0.12, 7, 'travertine', { x: 0, y: -0.33, z: OFFICE.maxZ + 3.5, radius: 0, cast: false });
  // The building's plinth (a slab edge 0.3 m above the terrace).
  b.box(OFFICE.width + 0.6, SLAB, OFFICE.depth + 0.6, 'microcement', { y: -SLAB / 2 - 0.02, radius: 0.02 });

  // ------------------------------------------------------------ floors
  const rect = ([minX, minZ, maxX, maxZ]) => [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]];
  for (const key of Object.keys(ZONES)) if (key !== 'chief') b.slab(rect(ZONES[key].bounds), SLAB, 'oak', { y: 0 });
  b.slab(rect(ROOMS.boardroom.bounds), SLAB, 'oak', { y: 0 });
  b.slab(rect(ROOMS.arrival.bounds), SLAB, 'travertine', { y: 0 });
  // The Promenade: the centre bay in travertine around the Forum's opening.
  const circle = (radius, count = 96) => Array.from({ length: count }, (_, index) => { const a = (index / count) * Math.PI * 2; return [Math.sin(a) * radius, Math.cos(a) * radius]; });
  b.slab(rect([-10, -7, 10, 7]), SLAB, 'travertine', { y: 0, holes: [circle(FORUM.radius).reverse()] });
  // Three steps down into the Forum (0.15 m each), then the Forum floor.
  const treads = FORUM.steps;
  for (let step = 1; step < treads; step += 1) {
    const outer = FORUM.radius - (step - 1) * FORUM.tread; const inner = outer - FORUM.tread;
    b.slab(circle(outer), 0.2, 'travertine', { y: -step * (FORUM.depth / treads), holes: [circle(inner).reverse()] });
  }
  b.slab(circle(FORUM.radius - (treads - 1) * FORUM.tread), 0.2, 'travertine', { y: -FORUM.depth });

  // ------------------------------------------------------------ brass inlay
  const inlay = new THREE.Group(); inlay.name = 'inlay';
  const inlayGeometries = inlayNetwork().map((segment) => {
    const points = segment.kind === 'ring' ? segment.points : densify(segment.points, 0.25);
    return stripGeometry(points, INLAY_WIDTH, floorHeight, 0.0012);
  });
  const inlayMesh = new THREE.Mesh(THREE.mergeGeometries(inlayGeometries.map((geometry) => { geometry.deleteAttribute('along'); return geometry; })), materials.get('brass'));
  inlayMesh.receiveShadow = true; inlay.add(inlayMesh);
  for (const geometry of inlayGeometries) geometry.dispose();
  root.add(inlay);

  // ------------------------------------------------------------ columns
  // Instanced so the close views can cut away the ones in front of the focus.
  const shaftGeometry = new THREE.CylinderGeometry(COLUMN_RADIUS, COLUMN_RADIUS, 1, 32).translate(0, 0.5, 0);
  const footGeometry = new THREE.CylinderGeometry(COLUMN_RADIUS + 0.012, COLUMN_RADIUS + 0.012, 0.06, 32).translate(0, 0.03, 0);
  const shafts = new THREE.InstancedMesh(shaftGeometry, materials.get('microcement'), COLUMNS.length);
  const feet = new THREE.InstancedMesh(footGeometry, materials.get('bronze'), COLUMNS.length);
  const columnMatrices = COLUMNS.map(([x, z]) => {
    const atrium = Math.abs(x) < 9.5 && Math.abs(z) < 7;
    return [new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion(), new THREE.Vector3(1, atrium ? OFFICE.atrium : OFFICE.ceiling, 1)), new THREE.Matrix4().makeTranslation(x, 0, z)];
  });
  const hiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
  const showColumns = (hidden = new Set()) => {
    columnMatrices.forEach(([shaft, foot], index) => { const gone = hidden.has(index); shafts.setMatrixAt(index, gone ? hiddenMatrix : shaft); feet.setMatrixAt(index, gone ? hiddenMatrix : foot); });
    shafts.instanceMatrix.needsUpdate = true; feet.instanceMatrix.needsUpdate = true;
    shafts.computeBoundingSphere(); feet.computeBoundingSphere();
  };
  showColumns();
  let hiddenColumns = new Set();
  for (const mesh of [shafts, feet]) { mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = 'columns'; root.add(mesh); }

  // ------------------------------------------------------------ façade
  // Glass between bronze fins every 1.2 m; linen-clad solid sections behind
  // each department display; the entrance on the south.
  const solids = Object.values(ZONES).filter((zone) => zone.display).map((zone) => zone.display);
  const facades = [
    { axis: 'x', fixed: OFFICE.minZ, from: OFFICE.minX, to: OFFICE.maxX, out: -1 },
    { axis: 'x', fixed: OFFICE.maxZ, from: OFFICE.minX, to: OFFICE.maxX, out: 1 },
    { axis: 'z', fixed: OFFICE.minX, from: OFFICE.minZ, to: OFFICE.maxZ, out: -1 },
    { axis: 'z', fixed: OFFICE.maxX, from: OFFICE.minZ, to: OFFICE.maxZ, out: 1 },
  ];
  const finGeometry = new THREE.BoxGeometry(FACADE.finWidth, OFFICE.ceiling, FACADE.finDepth);
  const finMatrices = [];
  for (const facade of facades) {
    const along = (value) => (facade.axis === 'x' ? [value, facade.fixed] : [facade.fixed, value]);
    const solidSpans = solids.filter((display) => (facade.axis === 'x' ? Math.abs(display.z - facade.fixed) < 0.5 : Math.abs(display.x - facade.fixed) < 0.5))
      .map((display) => { const centre = facade.axis === 'x' ? display.x : display.z; return [centre - FACADE.solidWidth / 2, centre + FACADE.solidWidth / 2]; });
    const entrance = facade.axis === 'x' && facade.fixed === OFFICE.maxZ ? [ROOMS.arrival.entrance[0], ROOMS.arrival.entrance[1]] : null;
    const gaps = [...solidSpans, ...(entrance ? [entrance] : [])].sort((a, b) => a[0] - b[0]);
    // Glass runs between the gaps.
    let cursor = facade.from;
    for (const [start, end] of [...gaps, [facade.to, facade.to]]) {
      if (start - cursor > 0.05) glassRun(along, facade, cursor, start);
      cursor = Math.max(cursor, end);
    }
    for (const [start, end] of solidSpans) {
      const centre = (start + end) / 2; const [x, z] = along(centre);
      const inward = -facade.out * 0.12;
      b.box(facade.axis === 'x' ? end - start : 0.24, OFFICE.ceiling, facade.axis === 'x' ? 0.24 : end - start, 'microcement', { x: facade.axis === 'x' ? x : x - facade.out * 0.02, y: OFFICE.ceiling / 2, z: facade.axis === 'x' ? z - facade.out * 0.02 : z });
      // The linen wall face (inside) that carries the department display.
      b.box(facade.axis === 'x' ? end - start - 0.2 : 0.03, OFFICE.ceiling - 0.3, facade.axis === 'x' ? 0.03 : end - start - 0.2, 'linen', { x: facade.axis === 'x' ? x : x + inward, y: (OFFICE.ceiling - 0.3) / 2 + 0.05, z: facade.axis === 'x' ? z + inward : z, cast: false });
    }
    if (entrance) {
      const [x1] = along(entrance[0]); const [x2] = along(entrance[1]);
      for (const x of [x1, x2]) b.box(0.12, 3.2, 0.3, 'bronze', { x, y: 1.6, z: facade.fixed });
      b.box(x2 - x1 + 0.12, 0.16, 0.3, 'bronze', { x: (x1 + x2) / 2, y: 3.2, z: facade.fixed });
      b.box(x2 - x1 + 2.4, 0.08, 2.2, 'bronze', { x: (x1 + x2) / 2, y: 3.6, z: facade.fixed + 1.0 });
    }
    // Head and sill trims along the whole façade.
    const [hx, hz] = along((facade.from + facade.to) / 2);
    const length = facade.to - facade.from;
    b.box(facade.axis === 'x' ? length : 0.18, 0.12, facade.axis === 'x' ? 0.18 : length, 'bronze', { x: hx, y: OFFICE.ceiling + 0.06, z: hz });
    b.box(facade.axis === 'x' ? length : 0.2, 0.5, facade.axis === 'x' ? 0.2 : length, 'microcement', { x: hx + (facade.axis === 'z' ? facade.out * 0.1 : 0), y: OFFICE.ceiling + 0.37, z: hz + (facade.axis === 'x' ? facade.out * 0.1 : 0) });
  }
  function glassRun(along, facade, start, end) {
    const [x1, z1] = along(start); const [x2, z2] = along(end);
    const mid = [(x1 + x2) / 2, (z1 + z2) / 2]; const length = end - start;
    b.box(facade.axis === 'x' ? length : 0.02, OFFICE.ceiling - 0.1, facade.axis === 'x' ? 0.02 : length, 'glass', { x: mid[0], y: (OFFICE.ceiling - 0.1) / 2 + 0.05, z: mid[1], cast: false, receive: false, radius: 0 });
    b.box(facade.axis === 'x' ? length : 0.12, 0.05, facade.axis === 'x' ? 0.12 : length, 'bronze', { x: mid[0], y: 0.025, z: mid[1] });
    for (let value = Math.ceil(start / FACADE.finSpacing) * FACADE.finSpacing; value <= end + 1e-6; value += FACADE.finSpacing) {
      const [fx, fz] = along(value);
      const m = new THREE.Matrix4().makeTranslation(fx + (facade.axis === 'z' ? facade.out * FACADE.finDepth / 2 : 0), OFFICE.ceiling / 2, fz + (facade.axis === 'x' ? facade.out * FACADE.finDepth / 2 : 0));
      if (facade.axis === 'z') m.multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2));
      finMatrices.push(m);
    }
  }
  const fins = new THREE.InstancedMesh(finGeometry, materials.get('bronze'), finMatrices.length);
  finMatrices.forEach((m, index) => fins.setMatrixAt(index, m));
  fins.castShadow = true; fins.receiveShadow = true; fins.name = 'fins';
  root.add(fins); disposables.push(finGeometry);

  // ------------------------------------------------------------ glazed rooms
  for (const [x1, z1, x2, z2, door] of GLASS) {
    const length = Math.hypot(x2 - x1, z2 - z1);
    const yaw = -Math.atan2(z2 - z1, x2 - x1);
    const dir = [(x2 - x1) / length, (z2 - z1) / length];
    const spans = door === 'open' ? [] : door ? (() => { const at = (door[0] - x1) * dir[0] + (door[1] - z1) * dir[1]; return [[0, at - DOOR_WIDTH / 2], [at + DOOR_WIDTH / 2, length]]; })() : [[0, length]];
    for (const [s0, s1] of spans) {
      if (s1 - s0 < 0.05) continue;
      const mid = (s0 + s1) / 2; const [mx, mz] = [x1 + dir[0] * mid, z1 + dir[1] * mid];
      b.box(s1 - s0, OFFICE.ceiling - 0.12, 0.016, 'glass', { x: mx, y: (OFFICE.ceiling - 0.12) / 2 + 0.06, z: mz, ry: yaw, cast: false, receive: false, radius: 0 });
      b.box(s1 - s0, PRIVACY_BAND.top - PRIVACY_BAND.bottom, 0.02, 'frosted', { x: mx, y: (PRIVACY_BAND.top + PRIVACY_BAND.bottom) / 2, z: mz, ry: yaw, cast: false, receive: false, radius: 0 });
      b.box(s1 - s0, 0.06, 0.07, 'bronze', { x: mx, y: 0.03, z: mz, ry: yaw });
      // Mullions every ~1.5 m.
      const count = Math.max(1, Math.round((s1 - s0) / 1.5));
      for (let index = 0; index <= count; index += 1) {
        const at = s0 + ((s1 - s0) * index) / count; const [px, pz] = [x1 + dir[0] * at, z1 + dir[1] * at];
        b.box(0.045, OFFICE.ceiling, 0.07, 'bronze', { x: px, y: OFFICE.ceiling / 2, z: pz, ry: yaw });
      }
    }
    // Door portals.
    if (door) {
      const at = door === 'open' ? length / 2 : (door[0] - x1) * dir[0] + (door[1] - z1) * dir[1];
      const width = door === 'open' ? length : DOOR_WIDTH;
      const [cx, cz] = [x1 + dir[0] * at, z1 + dir[1] * at];
      for (const side of [-1, 1]) b.box(0.06, 2.6, 0.1, 'bronze', { x: cx + dir[0] * side * width / 2, y: 1.3, z: cz + dir[1] * side * width / 2, ry: yaw });
      b.box(width + 0.06, 0.08, 0.1, 'bronze', { x: cx, y: 2.62, z: cz, ry: yaw });
      b.box(width, OFFICE.ceiling - 2.66, 0.016, 'glass', { x: cx, y: (OFFICE.ceiling + 2.66) / 2, z: cz, ry: yaw, cast: false, receive: false, radius: 0 });
    }
  }

  // ------------------------------------------------------------ partitions
  for (const wall of PARTITIONS) {
    const [x1, z1] = wall.from; const [x2, z2] = wall.to;
    const length = Math.hypot(x2 - x1, z2 - z1);
    b.box(length, wall.height, wall.thickness, 'microcement', { x: (x1 + x2) / 2, y: wall.height / 2, z: (z1 + z2) / 2, ry: -Math.atan2(z2 - z1, x2 - x1) });
  }
  // The Office Wall's bronze frame (the screen itself is built by screens.js).
  b.box(OFFICE_WALL.width + 0.12, OFFICE_WALL.height + 0.12, 0.04, 'bronze', { x: OFFICE_WALL.x, y: OFFICE_WALL.bottom + OFFICE_WALL.height / 2, z: OFFICE_WALL.z - 0.01 });

  // ------------------------------------------------------------ atrium clerestory (4.2 → 8.4)
  const clerestory = createBuilder(materials);
  const atriumEdges = [[-10, -7, 10, -7], [10, -7, 10, 7], [10, 7, -10, 7], [-10, 7, -10, -7]];
  const clerestoryFins = [];
  for (const [x1, z1, x2, z2] of atriumEdges) {
    const length = Math.hypot(x2 - x1, z2 - z1); const yaw = -Math.atan2(z2 - z1, x2 - x1);
    const [mx, mz] = [(x1 + x2) / 2, (z1 + z2) / 2]; const height = OFFICE.atrium - OFFICE.ceiling;
    clerestory.box(length, height, 0.02, 'glass', { x: mx, y: OFFICE.ceiling + height / 2, z: mz, ry: yaw, cast: false, receive: false, radius: 0 });
    clerestory.box(length + 0.3, 0.45, 0.3, 'microcement', { x: mx, y: OFFICE.ceiling + 0.22, z: mz, ry: yaw });
    clerestory.box(length + 0.3, 0.3, 0.3, 'microcement', { x: mx, y: OFFICE.atrium + 0.15, z: mz, ry: yaw });
    const dir = [(x2 - x1) / length, (z2 - z1) / length];
    for (let at = 0.6; at < length; at += FACADE.finSpacing) clerestoryFins.push(new THREE.Matrix4().makeTranslation(x1 + dir[0] * at, OFFICE.ceiling + height / 2, z1 + dir[1] * at).multiply(new THREE.Matrix4().makeRotationY(yaw)));
  }
  clerestory.build(highCeiling);
  const clerestoryFinGeometry = new THREE.BoxGeometry(0.32, OFFICE.atrium - OFFICE.ceiling, FACADE.finWidth);
  const clerestoryFinMesh = new THREE.InstancedMesh(clerestoryFinGeometry, materials.get('bronze'), clerestoryFins.length);
  clerestoryFins.forEach((m, index) => clerestoryFinMesh.setMatrixAt(index, m));
  clerestoryFinMesh.castShadow = true; highCeiling.add(clerestoryFinMesh); disposables.push(clerestoryFinGeometry);

  // ------------------------------------------------------------ ceilings: oak slats on black felt
  const [aMinX, aMinZ, aMaxX, aMaxZ] = CEILING.atriumBounds;
  const low = createBuilder(materials);
  // Felt backing over everything outside the atrium (four slabs around it).
  for (const [minX, minZ, maxX, maxZ] of [[OFFICE.minX, OFFICE.minZ, OFFICE.maxX, aMinZ], [OFFICE.minX, aMaxZ, OFFICE.maxX, OFFICE.maxZ], [OFFICE.minX, aMinZ, aMinX, aMaxZ], [aMaxX, aMinZ, OFFICE.maxX, aMaxZ]]) {
    low.box(maxX - minX, 0.03, maxZ - minZ, 'felt', { x: (minX + maxX) / 2, y: OFFICE.ceiling + 0.015, z: (minZ + maxZ) / 2, cast: false, radius: 0 });
  }
  low.build(lowCeiling);
  const high = createBuilder(materials);
  high.slab(rect([aMinX, aMinZ, aMaxX, aMaxZ]), 0.03, 'felt', { y: OFFICE.atrium + 0.03, holes: [circle(FORUM.oculusRadius).reverse()], cast: false });
  // The oculus: a bronze ring and its glass.
  high.add(new THREE.TorusGeometry(FORUM.oculusRadius, 0.06, 8, 96), 'bronze', { y: OFFICE.atrium - 0.05, rx: Math.PI / 2 });
  high.build(highCeiling);

  const slatGeometry = new THREE.BoxGeometry(CEILING.slatWidth, CEILING.slatDepth, 1);
  disposables.push(slatGeometry);
  const slatPitch = tier === 'light' ? CEILING.pitch * 2 : CEILING.pitch;
  const slatsFor = (group, y, spans) => {
    const matrices = [];
    for (const { x, z0, z1 } of spans) if (z1 - z0 > 0.05) matrices.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, (z0 + z1) / 2), new THREE.Quaternion(), new THREE.Vector3(1, 1, z1 - z0)));
    const mesh = new THREE.InstancedMesh(slatGeometry, materials.get('slat'), matrices.length);
    matrices.forEach((m, index) => mesh.setMatrixAt(index, m));
    mesh.castShadow = false; mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  // Low ceiling: slats run north–south across the whole plan, skipping the atrium.
  const lowSpans = [];
  for (let x = OFFICE.minX + slatPitch / 2; x < OFFICE.maxX; x += slatPitch) {
    if (x > aMinX && x < aMaxX) { lowSpans.push({ x, z0: OFFICE.minZ, z1: aMinZ }, { x, z0: aMaxZ, z1: OFFICE.maxZ }); } else lowSpans.push({ x, z0: OFFICE.minZ, z1: OFFICE.maxZ });
  }
  slatsFor(lowCeiling, OFFICE.ceiling - CEILING.slatDepth / 2, lowSpans);
  // Atrium ceiling: slats around the oculus.
  const highSpans = [];
  for (let x = aMinX + slatPitch / 2; x < aMaxX; x += slatPitch) {
    const r = FORUM.oculusRadius + 0.05;
    if (Math.abs(x) < r) { const h = Math.sqrt(r * r - x * x); highSpans.push({ x, z0: aMinZ, z1: -h }, { x, z0: h, z1: aMaxZ }); } else highSpans.push({ x, z0: aMinZ, z1: aMaxZ });
  }
  slatsFor(highCeiling, OFFICE.atrium - CEILING.slatDepth / 2, highSpans);

  // ------------------------------------------------------------ the invisible roof (shadows only)
  const caster = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  const roofLow = createBuilder({ get: () => caster });
  for (const [minX, minZ, maxX, maxZ] of [[OFFICE.minX, OFFICE.minZ, OFFICE.maxX, aMinZ], [OFFICE.minX, aMaxZ, OFFICE.maxX, OFFICE.maxZ], [OFFICE.minX, aMinZ, aMinX, aMaxZ], [aMaxX, aMinZ, OFFICE.maxX, aMaxZ]]) {
    roofLow.box(maxX - minX, 0.3, maxZ - minZ, 'caster', { x: (minX + maxX) / 2, y: OFFICE.ceiling + 0.25, z: (minZ + maxZ) / 2, radius: 0 });
  }
  roofLow.slab(rect([aMinX, aMinZ, aMaxX, aMaxZ]), 0.3, 'caster', { y: OFFICE.atrium + 0.4, holes: [circle(FORUM.oculusRadius).reverse()] });
  for (const mesh of roofLow.build(casters, { uv: 'none' })) { mesh.castShadow = true; mesh.receiveShadow = false; mesh.renderOrder = -1; }
  disposables.push(caster);

  // ------------------------------------------------------------ night fixtures (emissive, no real lights)
  // Coves along the inside of every façade head, and LED lines under the
  // Forum's three step nosings. Their level follows the mode's artificial light.
  const glow = new THREE.MeshStandardMaterial({ color: '#2a2016', emissive: new THREE.Color('#ffbf80'), emissiveIntensity: 0, roughness: 0.6 });
  const fixtures = [];
  const coveInset = 0.28; const coveY = OFFICE.ceiling - 0.08;
  for (const [x1, z1, x2, z2] of [[OFFICE.minX + coveInset, OFFICE.minZ + coveInset, OFFICE.maxX - coveInset, OFFICE.minZ + coveInset], [OFFICE.minX + coveInset, OFFICE.maxZ - coveInset, OFFICE.maxX - coveInset, OFFICE.maxZ - coveInset], [OFFICE.minX + coveInset, OFFICE.minZ + coveInset, OFFICE.minX + coveInset, OFFICE.maxZ - coveInset], [OFFICE.maxX - coveInset, OFFICE.minZ + coveInset, OFFICE.maxX - coveInset, OFFICE.maxZ - coveInset]]) {
    const geometry = new THREE.BoxGeometry(Math.hypot(x2 - x1, z2 - z1), 0.03, 0.05);
    geometry.rotateY(-Math.atan2(z2 - z1, x2 - x1)); geometry.translate((x1 + x2) / 2, coveY, (z1 + z2) / 2);
    fixtures.push(geometry);
  }
  for (let step = 0; step < FORUM.steps; step += 1) {
    const geometry = new THREE.TorusGeometry(FORUM.radius - step * FORUM.tread - 0.03, 0.01, 6, 160);
    geometry.rotateX(Math.PI / 2); geometry.translate(0, -step * (FORUM.depth / FORUM.steps) - 0.03, 0);
    fixtures.push(geometry);
  }
  const fixtureMesh = new THREE.Mesh(THREE.mergeGeometries(fixtures.map((geometry) => geometry.toNonIndexed())), glow);
  for (const geometry of fixtures) geometry.dispose();
  fixtureMesh.name = 'night-fixtures'; root.add(fixtureMesh); disposables.push(glow);

  // ------------------------------------------------------------ merge
  b.build(root);
  b.dispose(); low.dispose(); high.dispose(); clerestory.dispose(); roofLow.dispose();
  return {
    root, lowCeiling, highCeiling, casters, inlay,
    // Cutaway: hides the columns at these indices of COLUMNS (empty shows all).
    setHiddenColumns(indices) { const next = new Set(indices); if (next.size === hiddenColumns.size && [...next].every((index) => hiddenColumns.has(index))) return false; hiddenColumns = next; showColumns(next); return true; },
    setNight(level) { glow.emissiveIntensity = level * 3.2; },
    dispose() { for (const item of disposables) item.dispose?.(); root.traverse((node) => { if (node.isMesh || node.isInstancedMesh) node.geometry?.dispose(); }); },
  };
}

// Extra points along straight runs so the inlay follows the Forum steps.
function densify(points, step) {
  const out = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    const [a, b] = [points[index - 1], points[index]];
    const count = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 1; k <= count; k += 1) out.push([a[0] + ((b[0] - a[0]) * k) / count, a[1] + ((b[1] - a[1]) * k) / count]);
  }
  return out;
}
