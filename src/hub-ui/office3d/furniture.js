// Furniture and fit-out (Final Design Spec §04): one company — a shared kit
// (white-oak desks on blackened-steel frames, wool task chairs, 27" monitors,
// bronze task lamps) plus one signature piece and prop set per department.
//
//   Research  library wall + reading chairs        Product  whiteboard wall, round table
//   Creative  pin-board wall, shared table          Finance  glazed, long meeting table
//   Social    standing bench, phones on stands      Audit    glazed, archive credenza
//   Coding    dual-monitor benches                  Legal    glazed, library + review table
//   CHIEF     walnut table in the Forum facing the Office Wall
//
// Static pieces are merged into the building's buckets; each employee's
// chair, monitors and lamp are live objects the state drives (states.js).
import * as THREE from '../vendor/three.js?v=__UI_VERSION__';
import { FORUM, OFFICE_WALL, ROOMS, ZONES } from './plan.js?v=__UI_VERSION__';
import { BOOK_COLORS } from './materials.js?v=__UI_VERSION__';
import { createBuilder } from './builder.js?v=__UI_VERSION__';

export const MONITOR = Object.freeze({ width: 0.6, height: 0.34, bezel: 0.012 });
export const DISPLAY = Object.freeze({ width: 1.66, height: 0.94, bottom: 1.05 });

// Transforms a local point (x right, z toward the employee) of a workspace
// whose employee faces `yaw` into world coordinates.
export function local(origin, yaw, [lx, lz]) {
  const c = Math.cos(yaw); const s = Math.sin(yaw);
  return [origin[0] + lx * c + lz * s, origin[1] - lx * s + lz * c];
}

export function buildFurniture({ materials, tier }) {
  const root = new THREE.Group(); root.name = 'furniture';
  const b = createBuilder(materials);
  const books = []; // { matrix, color }
  const workstations = new Map(); // key → live parts
  const screens = []; // { key, kind, mesh, width, height }
  const footprints = []; // floor AO: [x, z, w, d, yaw, strength]
  let chiefStrip = null;
  const liveChairs = []; // task chairs: transform nodes, drawn by shared instanced meshes

  // ------------------------------------------------------------ kit
  const at = (origin, yaw, offset) => local(origin, yaw, offset);
  const desk = (x, z, yaw, { width = 1.8, depth = 0.8, top = 'oakTop', y = 0 } = {}) => {
    b.box(width, 0.03, depth, top, { x, y: y + 0.725, z, ry: yaw, radius: 0.008 });
    for (const side of [-1, 1]) {
      const [lx, lz] = at([x, z], yaw, [side * (width / 2 - 0.08), 0]);
      b.box(0.04, 0.71, depth - 0.06, 'steel', { x: lx, y: y + 0.355, z: lz, ry: yaw, radius: 0.004 });
      b.box(0.06, 0.02, depth - 0.02, 'steel', { x: lx, y: y + 0.01, z: lz, ry: yaw, radius: 0.004 });
    }
    const [bx, bz] = at([x, z], yaw, [0, -depth / 2 + 0.04]);
    b.box(width - 0.2, 0.32, 0.016, 'steel', { x: bx, y: y + 0.52, z: bz, ry: yaw, radius: 0.004 });
    footprints.push([x, z, width + 0.3, depth + 0.3, yaw, 0.45]);
  };
  // A task chair; into a builder (static) or as its own merged group (live).
  const chair = (target, x, z, yaw, { y = 0, fabric = 'woolSlate', executive = false } = {}) => {
    const seatY = y + 0.46;
    target.cylinder(0.3, 0.3, 0.025, 'steel', { x, y: y + 0.06, z, segments: 5 });
    for (let arm = 0; arm < 5; arm += 1) {
      const angle = (arm / 5) * Math.PI * 2;
      target.box(0.3, 0.025, 0.04, 'steel', { x: x + Math.cos(angle) * 0.15, y: y + 0.06, z: z + Math.sin(angle) * 0.15, ry: -angle });
      target.cylinder(0.025, 0.025, 0.04, 'rubber', { x: x + Math.cos(angle) * 0.29, y: y + 0.025, z: z + Math.sin(angle) * 0.29, segments: 10 });
    }
    target.cylinder(0.022, 0.022, 0.36, 'steel', { x, y: y + 0.25, z, segments: 12 });
    target.box(0.5, 0.08, 0.48, executive ? 'leather' : fabric, { x, y: seatY, z, ry: yaw, radius: 0.03 });
    const [bx, bz] = local([x, z], yaw, [0, 0.22]);
    target.box(0.46, executive ? 0.68 : 0.5, 0.06, executive ? 'leather' : fabric, { x: bx, y: seatY + (executive ? 0.4 : 0.33), z: bz, ry: yaw, rx: -0.12, radius: 0.025 });
    for (const side of [-1, 1]) {
      const [ax, az] = local([x, z], yaw, [side * 0.27, 0.02]);
      target.box(0.04, 0.03, 0.3, 'steel', { x: ax, y: seatY + 0.2, z: az, ry: yaw, radius: 0.01 });
      target.box(0.025, 0.2, 0.025, 'steel', { x: ax, y: seatY + 0.1, z: az, ry: yaw, radius: 0.005 });
    }
  };
  const sideChair = (x, z, yaw, { fabric = 'woolSand', y = 0 } = {}) => {
    b.box(0.46, 0.05, 0.46, fabric, { x, y: y + 0.45, z, ry: yaw, radius: 0.02 });
    const [bx, bz] = local([x, z], yaw, [0, 0.21]);
    b.box(0.44, 0.38, 0.04, fabric, { x: bx, y: y + 0.68, z: bz, ry: yaw, rx: -0.08, radius: 0.015 });
    for (const [lx, lz] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]]) { const [px, pz] = local([x, z], yaw, [lx, lz]); b.cylinder(0.012, 0.012, 0.44, 'steel', { x: px, y: y + 0.22, z: pz, segments: 8 }); }
  };
  const loungeChair = (x, z, yaw, { leather = 'leatherTan' } = {}) => {
    b.box(0.78, 0.22, 0.78, leather, { x, y: 0.32, z, ry: yaw, radius: 0.08 });
    const [bx, bz] = local([x, z], yaw, [0, 0.33]);
    b.box(0.78, 0.5, 0.14, leather, { x: bx, y: 0.6, z: bz, ry: yaw, rx: -0.15, radius: 0.06 });
    for (const side of [-1, 1]) { const [ax, az] = local([x, z], yaw, [side * 0.38, 0.02]); b.box(0.1, 0.24, 0.7, leather, { x: ax, y: 0.5, z: az, ry: yaw, radius: 0.04 }); }
    for (const [lx, lz] of [[-0.32, -0.32], [0.32, -0.32], [-0.32, 0.32], [0.32, 0.32]]) { const [px, pz] = local([x, z], yaw, [lx, lz]); b.cylinder(0.018, 0.012, 0.2, 'bronze', { x: px, y: 0.1, z: pz, segments: 8 }); }
    footprints.push([x, z, 1.1, 1.1, yaw, 0.4]);
  };
  const table = (x, z, yaw, width, depth, { top = 'oakTop', height = 0.74, round = false } = {}) => {
    if (round) {
      b.cylinder(width / 2, width / 2, 0.035, top, { x, y: height - 0.0175, z, segments: 48 });
      b.cylinder(0.05, 0.05, height - 0.04, 'steel', { x, y: height / 2, z, segments: 16 });
      b.cylinder(0.32, 0.36, 0.03, 'steel', { x, y: 0.015, z, segments: 32 });
      footprints.push([x, z, width + 0.4, width + 0.4, 0, 0.35]);
      return;
    }
    b.box(width, 0.035, depth, top, { x, y: height - 0.0175, z, ry: yaw, radius: 0.01 });
    for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const [px, pz] = local([x, z], yaw, [lx * (width / 2 - 0.12), lz * (depth / 2 - 0.1)]);
      b.box(0.05, height - 0.035, 0.05, 'steel', { x: px, y: (height - 0.035) / 2, z: pz, ry: yaw, radius: 0.006 });
    }
    footprints.push([x, z, width + 0.3, depth + 0.3, yaw, 0.4]);
  };
  // Shelving with books (books are one instanced mesh for the whole Office).
  const shelving = (x, z, yaw, width, height, { depth = 0.36, finish = 'oakTop', bays = 0, seed = 1, doubleSided = false } = {}) => {
    // The back panel sits behind the shelves (yaw is the side books are taken from).
    const [backX, backZ] = local([x, z], yaw, [0, doubleSided ? 0 : depth / 2 - 0.01]);
    b.box(width, height, 0.02, finish, { x: backX, y: height / 2, z: backZ, ry: yaw, radius: 0 });
    const shelves = Math.round(height / 0.36);
    for (let row = 0; row <= shelves; row += 1) b.box(width, 0.025, depth, finish, { x, y: 0.05 + (row * (height - 0.06)) / shelves, z, ry: yaw, radius: 0.003 });
    const uprights = bays || Math.max(2, Math.round(width / 0.9));
    for (let column = 0; column <= uprights; column += 1) { const [px, pz] = local([x, z], yaw, [-width / 2 + (width * column) / uprights, 0]); b.box(0.025, height, depth, finish, { x: px, y: height / 2, z: pz, ry: yaw, radius: 0.003 }); }
    let state = seed * 9973;
    const random = () => { state = (state * 16807) % 2147483647; return state / 2147483647; };
    const sides = doubleSided ? [-1, 1] : [1];
    for (const side of sides) for (let row = 0; row < shelves; row += 1) {
      const baseY = 0.05 + (row * (height - 0.06)) / shelves + 0.0125;
      let cursor = -width / 2 + 0.04;
      while (cursor < width / 2 - 0.08) {
        if (random() < 0.12) { cursor += 0.12 + random() * 0.2; continue; }
        const thick = 0.022 + random() * 0.03; const tall = 0.2 + random() * 0.1; const deep = depth * (0.55 + random() * 0.3);
        const lean = random() < 0.05 ? 0.25 : 0;
        const [px, pz] = local([x, z], yaw, [cursor + thick / 2, side * (doubleSided ? depth / 4 : 0.02)]);
        const matrix = new THREE.Matrix4().compose(new THREE.Vector3(px, baseY + tall / 2, pz), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, lean)), new THREE.Vector3(thick, tall, deep / (doubleSided ? 2 : 1)));
        books.push({ matrix, color: BOOK_COLORS[Math.floor(random() * BOOK_COLORS.length)] });
        cursor += thick + 0.002;
      }
    }
    footprints.push([x, z, width + 0.2, depth + 0.3, yaw, 0.35]);
  };
  const credenza = (x, z, yaw, width, { height = 0.72, finish = 'walnut' } = {}) => {
    b.box(width, height - 0.08, 0.45, finish, { x, y: height / 2 + 0.04, z, ry: yaw, radius: 0.008 });
    for (const side of [-1, 1]) { const [px, pz] = local([x, z], yaw, [side * (width / 2 - 0.1), 0]); b.box(0.03, 0.08, 0.4, 'steel', { x: px, y: 0.04, z: pz, ry: yaw }); }
    footprints.push([x, z, width + 0.2, 0.7, yaw, 0.35]);
  };
  const papers = (x, y, z, yaw, count = 3) => { for (let index = 0; index < count; index += 1) b.box(0.21, 0.004 + index * 0.0005, 0.297, 'paper', { x: x + index * 0.012, y: y + 0.002 + index * 0.004, z: z - index * 0.01, ry: yaw + index * 0.06, radius: 0, cast: false }); };
  const ceramic = (x, y, z, { r = 0.06, h = 0.14, dark = false } = {}) => b.lathe([[0, 0], [r * 0.8, 0], [r, h * 0.3], [r * 0.9, h * 0.8], [r * 0.55, h], [r * 0.5, h]], dark ? 'ceramicDark' : 'ceramic', { x, y, z, segments: 20 });

  // A monitor on the desk: bezel and stand merged; the screen is live.
  const monitor = (key, x, y, z, yaw, { tilt = 0.08, kind = 'desk', width = MONITOR.width, height = MONITOR.height } = {}) => {
    const [sx, sz] = local([x, z], yaw, [0, 0.02]);
    b.box(width + MONITOR.bezel * 2, height + MONITOR.bezel * 2, 0.02, 'screenBezel', { x: sx, y: y + 0.12 + height / 2, z: sz, ry: yaw, rx: -tilt, radius: 0.004 });
    const [bx, bz] = local([x, z], yaw, [0, -0.02]);
    b.box(width * 0.5, height * 0.6, 0.03, 'monitorBack', { x: bx, y: y + 0.12 + height / 2, z: bz, ry: yaw, rx: -tilt, radius: 0.01 });
    b.box(0.04, 0.16, 0.03, 'bronze', { x: bx, y: y + 0.08, z: bz, ry: yaw, radius: 0.005 });
    b.box(0.22, 0.008, 0.16, 'bronze', { x: bx, y: y + 0.004, z: bz, ry: yaw, radius: 0.003 });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), null);
    const [px, pz] = local([x, z], yaw, [0, 0.0315]);
    mesh.position.set(px, y + 0.12 + height / 2, pz);
    mesh.rotation.set(-tilt, yaw, 0, 'YXZ');
    mesh.userData = { key, screen: kind };
    root.add(mesh);
    screens.push({ key, kind, mesh, width, height });
    return mesh;
  };
  // The task lamp: bronze arm, ceramic shade, status ring around the base.
  const lamp = (key, x, y, z, yaw) => {
    b.cylinder(0.07, 0.075, 0.018, 'bronze', { x, y: y + 0.009, z, segments: 24 });
    const [ax, az] = local([x, z], yaw, [0.03, 0]);
    b.box(0.014, 0.42, 0.014, 'bronze', { x: ax, y: y + 0.22, z: az, ry: yaw, rz: -0.18 });
    const [hx, hz] = local([x, z], yaw, [0.13, -0.04]);
    b.box(0.014, 0.014, 0.2, 'bronze', { x: hx, y: y + 0.42, z: hz, ry: yaw + 0.6 });
    const [lx, lz] = local([x, z], yaw, [0.2, -0.1]);
    const shadeMaterial = new THREE.MeshStandardMaterial({ color: '#ece6dc', roughness: 0.5, emissive: new THREE.Color('#ffb46b'), emissiveIntensity: 0 });
    const shade = new THREE.Mesh(new THREE.LatheGeometry([[0.02, 0.06], [0.07, 0.0], [0.075, -0.005]].map(([r, h]) => new THREE.Vector2(r, h)), 24), shadeMaterial);
    shade.position.set(lx, y + 0.38, lz); shade.castShadow = true;
    const ringMaterial = new THREE.MeshBasicMaterial({ color: '#e5484d', transparent: true, opacity: 0, toneMapped: false, depthWrite: false });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.006, 8, 48), ringMaterial);
    ring.rotation.x = Math.PI / 2; ring.position.set(x, y + 0.02, z);
    // The pool of lamp light on the desk (a soft additive decal).
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1), new THREE.MeshBasicMaterial({ map: poolTexture(), color: '#ffb466', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    pool.rotation.x = -Math.PI / 2; pool.position.set(lx, y + 0.004, lz); pool.renderOrder = 3;
    root.add(shade, ring, pool);
    return { shade, ring, pool };
  };

  // A workstation: desk, live chair, monitors and lamp for one employee.
  const workstation = (key, { width = 1.8, depth = 0.8, monitors = 1, top = 'oakTop', deskless = false, standing = false, executive = false } = {}) => {
    const zone = ZONES[key];
    const { x, z, yaw } = zone.desk;
    const y = key === 'chief' ? -FORUM.depth : 0;
    if (!deskless) desk(x, z, yaw, { width, depth, top, y });
    const deskTop = y + (standing ? 1.05 : 0.74);
    const monitorMeshes = [];
    for (let index = 0; index < monitors; index += 1) {
      const offset = monitors === 1 ? 0 : (index - (monitors - 1) / 2) * 0.66;
      const turn = monitors === 1 ? 0 : (index - (monitors - 1) / 2) * -0.22;
      const [mx, mz] = local([x, z], yaw, [offset, -depth / 2 + 0.2]);
      monitorMeshes.push(monitor(key, mx, deskTop, mz, yaw + turn));
    }
    const [lampX, lampZ] = local([x, z], yaw, [-(width / 2) + 0.22, -depth / 2 + 0.2]);
    const lampParts = lamp(key, lampX, deskTop, lampZ, yaw);
    // The live chair (its own small group so it can swivel or be pushed in).
    const chairGroup = new THREE.Group(); chairGroup.name = `chair:${key}`;
    const [cx, cz] = local([x, z], yaw, [0, depth / 2 + 0.38]);
    chairGroup.position.set(cx, y, cz); chairGroup.rotation.y = yaw;
    if (!standing && executive) {
      const chairBuilder = createBuilder(materials);
      chair(chairBuilder, 0, 0, 0, { executive });
      chairBuilder.build(chairGroup); chairBuilder.dispose();
    } else if (!standing) liveChairs.push(chairGroup); // drawn instanced (below), one draw per material
    root.add(chairGroup);
    footprints.push([cx, cz, 0.8, 0.8, yaw, 0.3]);
    // An invisible hit volume over the whole workstation (desk, chair, person).
    const [hx, hz] = local([x, z], yaw, [0, 0.35]);
    const hit = new THREE.Mesh(new THREE.BoxGeometry(Math.max(1.6, width + 0.4), 1.9, depth + 1.6), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.set(hx, y + 0.95, hz); hit.rotation.y = yaw; hit.userData = { key, pick: 'workstation' };
    root.add(hit);
    workstations.set(key, { key, desk: { x, z, yaw, y, top: deskTop }, chair: chairGroup, chairHome: [cx, cz], lamp: lampParts, monitors: monitorMeshes, standing, hit });
  };

  // ------------------------------------------------------------ the departments
  // 00 CHIEF — the walnut table in the Forum, facing the Office Wall.
  {
    const t = FORUM.table; const y = -FORUM.depth;
    b.box(t.length, 0.05, t.width, 'walnut', { x: t.x, y: y + t.height - 0.025, z: t.z, radius: 0.012 });
    for (const side of [-1, 1]) b.box(0.08, t.height - 0.05, t.width - 0.2, 'walnut', { x: t.x + side * (t.length / 2 - 0.25), y: y + (t.height - 0.05) / 2, z: t.z, radius: 0.01 });
    b.box(t.length - 0.6, 0.06, 0.06, 'bronze', { x: t.x, y: y + 0.12, z: t.z });
    // The bronze edge strip: CHIEF's status light (§03), a live emissive loop.
    const stripMaterial = new THREE.MeshStandardMaterial({ color: '#7b5d3c', metalness: 1, roughness: 0.35, emissive: new THREE.Color('#5b8cff'), emissiveIntensity: 0 });
    const strip = [];
    for (const [w, d, ox, oz] of [[t.length + 0.012, 0.012, 0, t.width / 2], [t.length + 0.012, 0.012, 0, -t.width / 2], [0.012, t.width, t.length / 2, 0], [0.012, t.width, -t.length / 2, 0]]) {
      const geometry = new THREE.BoxGeometry(w, 0.018, d); geometry.translate(t.x + ox, y + t.height - 0.034, t.z + oz); strip.push(geometry.toNonIndexed());
    }
    chiefStrip = new THREE.Mesh(THREE.mergeGeometries(strip), stripMaterial); chiefStrip.name = 'chief-strip';
    root.add(chiefStrip);
    footprints.push([t.x, t.z, t.length + 0.6, t.width + 0.6, 0, 0.5]);
    workstation('chief', { deskless: true, monitors: 2, depth: t.width, width: t.length, executive: true });
    for (const side of [-1, 1]) sideChair(t.x + side * (t.length / 2 + 0.55), t.z, side * Math.PI / 2, { fabric: 'leather', y });
    for (const side of [-0.7, 0.7]) sideChair(t.x + side, t.z - t.width / 2 - 0.5, Math.PI, { fabric: 'leather', y });
  }
  // 01 Research — the library wall (double-sided, between Research and Creative) and reading chairs.
  workstation('research');
  shelving(-10.25, -11.8, Math.PI / 2, 7, 2.6, { depth: 0.5, seed: 3, doubleSided: true });
  loungeChair(-21.4, -9.4, -2.4); loungeChair(-19.9, -8.6, 2.9);
  table(-20.6, -9.6, 0, 0.55, 0.55, { round: true, height: 0.5, top: 'walnut' });
  ceramic(-20.6, 0.5, -9.6, { r: 0.07, h: 0.18 });
  papers(-17.3, 0.74, -12.5, 0.2, 4);
  // 02 Creative — the shared table and the pin-board on the Office Wall's back.
  workstation('creative', { width: 3.2, depth: 1.3, top: 'oakTop' });
  for (const [lx, lz, turn] of [[-0.9, -1.0, Math.PI], [0.9, -1.0, Math.PI], [1.0, 0.95, 0]]) { const [px, pz] = local([-5.4, -11.15], 0, [lx, lz]); sideChair(px, pz, turn, { fabric: 'woolSand' }); }
  b.box(4.2, 1.7, 0.04, 'cork', { x: -2.4, y: 1.75, z: -7.2, radius: 0.004 });
  b.box(4.28, 0.04, 0.06, 'bronze', { x: -2.4, y: 0.88, z: -7.21 });
  for (let index = 0; index < 14; index += 1) {
    const px = -4.2 + (index % 7) * 0.6 + ((index * 7) % 3) * 0.04; const py = 2.2 - Math.floor(index / 7) * 0.75 - ((index * 5) % 4) * 0.03;
    b.box(index % 3 ? 0.42 : 0.3, index % 3 ? 0.3 : 0.42, 0.004, index % 4 ? 'paper' : 'linenDark', { x: px, y: py, z: -7.235, rz: ((index * 13) % 7 - 3) * 0.01, radius: 0, cast: false });
  }
  papers(-5.0, 0.74, -11.4, -0.3, 5); papers(-6.2, 0.74, -11.0, 0.5, 3);
  // 03 Social — the standing bench, phones on stands.
  workstation('social', { width: 2.4, depth: 0.62, standing: true, deskless: true });
  {
    const { x, z, yaw } = ZONES.social.desk;
    b.box(2.4, 0.04, 0.62, 'oakTop', { x, y: 1.05, z, ry: yaw, radius: 0.008 });
    for (const side of [-1, 1]) b.box(0.05, 1.03, 0.5, 'steel', { x: x + side * 1.1, y: 0.515, z, ry: yaw, radius: 0.004 });
    footprints.push([x, z, 2.7, 0.9, yaw, 0.4]);
    for (const offset of [-0.85, -0.55, 0.75]) {
      b.box(0.075, 0.15, 0.008, 'screenBezel', { x: x + offset, y: 1.16, z: z - 0.12, rx: -0.3, radius: 0.004 });
      b.box(0.05, 0.06, 0.05, 'bronze', { x: x + offset, y: 1.08, z: z - 0.09, radius: 0.004 });
    }
    for (const offset of [-1.6, 1.6]) { b.cylinder(0.17, 0.17, 0.04, 'leatherTan', { x: x + offset, y: 0.74, z: z + 0.4, segments: 24 }); b.cylinder(0.015, 0.015, 0.72, 'steel', { x: x + offset, y: 0.36, z: z + 0.4, segments: 8 }); b.cylinder(0.18, 0.2, 0.015, 'steel', { x: x + offset, y: 0.008, z: z + 0.4, segments: 24 }); }
  }
  shelving(2.4, -7.35, 0, 3.4, 1.1, { depth: 0.32, seed: 7 });
  // 04 Coding — dual-monitor benches.
  workstation('coding', { width: 1.7, depth: 0.82, monitors: 2 });
  {
    const { x, z } = ZONES.coding.desk;
    desk(x + 1.85, z, 0, { width: 1.7, depth: 0.82 });
    for (const offset of [-0.33, 0.33]) monitorStatic(x + 1.85 + offset, 0.74, z - 0.21, offset * -0.6);
    chair(b, x + 1.85, z + 0.79, 0);
    desk(x + 3.7, z, 0, { width: 1.7, depth: 0.82 });
    for (const offset of [-0.33, 0.33]) monitorStatic(x + 3.7 + offset, 0.74, z - 0.21, offset * -0.6);
    chair(b, x + 3.7, z + 0.79, 0);
    credenza(x + 1.85, z + 3.4, Math.PI, 3.6, { finish: 'oakTop' });
    ceramic(x + 0.6, 0.72, z + 3.4, { r: 0.08, h: 0.24, dark: true });
  }
  // 05 Product — the whiteboard wall and a round table for turning to colleagues.
  workstation('product');
  b.box(0.12, 2.3, 3.2, 'microcement', { x: 12.6, y: 1.15, z: -3.9, radius: 0.01 });
  b.box(0.02, 1.25, 2.8, 'whiteboard', { x: 12.67, y: 1.6, z: -3.9, radius: 0.004 });
  b.box(0.05, 0.03, 2.8, 'bronze', { x: 12.7, y: 0.96, z: -3.9 });
  table(14.6, 3.6, 0, 1.1, 1.1, { round: true });
  for (const angle of [0.4, 2.4, 4.4]) sideChair(14.6 + Math.sin(angle) * 0.85, 3.6 + Math.cos(angle) * 0.85, angle, { fabric: 'woolSand' });
  // 06 Finance — glazed; the long meeting table, document review.
  workstation('finance', { deskless: true });
  table(17, 11.15, 0, 4.2, 1.15, { top: 'oakTop' });
  for (const offset of [-1.5, -0.5, 0.5, 1.5]) { if (Math.abs(offset) > 0.6 || offset > 0) sideChair(17 + offset, 11.15 + 0.9, 0, { fabric: 'woolSand' }); }
  for (const offset of [-1.5, 1.5]) sideChair(17 + offset, 11.15 - 0.9, Math.PI, { fabric: 'woolSand' });
  papers(16.4, 0.74, 11.3, 0.1, 6); papers(18.2, 0.74, 11.0, -0.2, 3);
  credenza(17, 15.45, 0, 3.2, { finish: 'walnut' });
  // 07 Audit — glazed; the archive credenza and the review desk.
  workstation('audit');
  for (let unit = 0; unit < 4; unit += 1) shelving(-23.55, 9.2 + unit * 1.55, -Math.PI / 2, 1.5, 2.1, { depth: 0.42, seed: 11 + unit, finish: 'walnut' });
  table(-14.2, 11.8, Math.PI / 2, 1.8, 0.9, { top: 'oakTop' });
  papers(-14.2, 0.74, 11.6, 0.4, 6);
  // 08 Legal — glazed and warmer; the library and the review table.
  workstation('legal');
  shelving(-17, -6.78, Math.PI, 6.2, 2.4, { depth: 0.36, seed: 13, finish: 'walnut' });
  shelving(-17, 6.78, 0, 6.2, 2.4, { depth: 0.36, seed: 17, finish: 'walnut' });
  table(-13.6, 2.6, 0, 1.8, 1.0, { top: 'walnut' });
  for (const side of [-1, 1]) sideChair(-13.6 + side * 0.5, 2.6 + 0.75, 0, { fabric: 'leather' });
  papers(-18.6, 0.74, -0.4, 1.2, 4);
  // Boardroom — 14 seats.
  {
    const [minX, minZ, maxX, maxZ] = ROOMS.boardroom.bounds;
    const cx = (minX + maxX) / 2; const cz = (minZ + maxZ) / 2 + 0.4;
    table(cx, cz, Math.PI / 2, 6.0, 1.6, { top: 'walnut' });
    for (let index = 0; index < 6; index += 1) { const z = cz - 2.5 + index; sideChair(cx - 1.15, z, -Math.PI / 2, { fabric: 'leather' }); sideChair(cx + 1.15, z, Math.PI / 2, { fabric: 'leather' }); }
    sideChair(cx, cz - 3.4, Math.PI, { fabric: 'leather' }); sideChair(cx, cz + 3.4, 0, { fabric: 'leather' });
    credenza(maxX - 0.4, cz, -Math.PI / 2, 3.2);
  }
  // Arrival + Commons — reception, the brand wall, the lounge and the coffee bar.
  {
    b.box(3.0, 1.05, 0.7, 'travertine', { x: -3.6, y: 0.525, z: 11.4, radius: 0.02 });
    b.box(3.1, 0.04, 0.8, 'bronze', { x: -3.6, y: 1.07, z: 11.4, radius: 0.005 });
    chair(b, -3.6, 10.6, Math.PI);
    b.box(5.4, 3.4, 0.3, 'microcement', { x: -4.4, y: 1.7, z: 8.4, radius: 0.01 });
    // Sofas and a low table.
    for (const [x, z, yaw] of [[-7.4, 13.6, Math.PI / 2], [-5.0, 15.0, 0]]) {
      b.box(2.2, 0.42, 0.9, 'woolSand', { x, y: 0.21, z, ry: yaw, radius: 0.06 });
      const [bx, bz] = local([x, z], yaw, [0, 0.36]);
      b.box(2.2, 0.42, 0.2, 'woolSand', { x: bx, y: 0.6, z: bz, ry: yaw, radius: 0.06 });
      footprints.push([x, z, 2.5, 1.2, yaw, 0.45]);
    }
    table(-5.4, 13.3, 0, 1.2, 0.7, { height: 0.38, top: 'travertine' });
    ceramic(-5.6, 0.38, 13.2, { r: 0.09, h: 0.2 });
    // Coffee bar along the Audit wall.
    b.box(0.7, 0.95, 3.4, 'walnut', { x: -9.45, y: 0.475, z: 12.4, radius: 0.01 });
    b.box(0.74, 0.04, 3.44, 'travertine', { x: -9.45, y: 0.97, z: 12.4, radius: 0.005 });
    b.box(0.42, 0.42, 0.5, 'steel', { x: -9.5, y: 1.2, z: 11.6, radius: 0.02 });
    b.box(0.1, 0.06, 0.12, 'bronze', { x: -9.2, y: 1.12, z: 11.6, radius: 0.01 });
    for (let index = 0; index < 4; index += 1) ceramic(-9.4, 0.99, 12.6 + index * 0.18, { r: 0.04, h: 0.09 });
    footprints.push([-9.45, 12.4, 1.0, 3.7, 0, 0.4]);
  }
  // The Office Wall's slim walnut credenza below the screen.
  credenza(0, OFFICE_WALL.z + 0.4, Math.PI, 5.6, { height: 0.5, finish: 'walnut' });

  // Department displays (L2): 75" on the linen wall section, facing the Forum.
  for (const [key, zone] of Object.entries(ZONES)) {
    if (!zone.display) continue;
    const { x, z } = zone.display;
    const facingIn = Math.abs(Math.abs(x) - 24) < 0.5 ? (x > 0 ? -Math.PI / 2 : Math.PI / 2) : (z > 0 ? Math.PI : 0);
    const [px, pz] = local([x, z], facingIn, [0, 0.07]);
    b.box(DISPLAY.width + 0.03, DISPLAY.height + 0.03, 0.04, 'screenBezel', { x: px, y: DISPLAY.bottom + DISPLAY.height / 2, z: pz, ry: facingIn, radius: 0.004 });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(DISPLAY.width, DISPLAY.height), null);
    const [sx, sz] = local([x, z], facingIn, [0, 0.091]);
    mesh.position.set(sx, DISPLAY.bottom + DISPLAY.height / 2, sz); mesh.rotation.y = facingIn;
    mesh.userData = { key, screen: 'department' };
    root.add(mesh);
    screens.push({ key, kind: 'department', mesh, width: DISPLAY.width, height: DISPLAY.height });
    const [cx, cz] = local([x, z], facingIn, [0, 0.45]);
    credenza(cx, cz, facingIn, 2.4, { height: 0.55, finish: 'oakTop' });
  }
  // The Office Wall (L4) and CHIEF's table surface (L3 routing map).
  {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(OFFICE_WALL.width, OFFICE_WALL.height), null);
    mesh.position.set(OFFICE_WALL.x, OFFICE_WALL.bottom + OFFICE_WALL.height / 2, OFFICE_WALL.z + 0.012);
    mesh.userData = { key: 'chief', screen: 'wall' };
    root.add(mesh);
    screens.push({ key: 'chief', kind: 'wall', mesh, width: OFFICE_WALL.width, height: OFFICE_WALL.height });
    const t = FORUM.table;
    const surface = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.5), null);
    surface.rotation.x = -Math.PI / 2; surface.position.set(t.x, -FORUM.depth + t.height + 0.002, t.z + 0.05);
    surface.userData = { key: 'chief', screen: 'table' };
    root.add(surface);
    screens.push({ key: 'chief', kind: 'table', mesh: surface, width: 1.2, height: 0.5 });
  }

  function monitorStatic(x, y, z, turn) {
    b.box(MONITOR.width + 0.024, MONITOR.height + 0.024, 0.02, 'screenBezel', { x, y: y + 0.12 + MONITOR.height / 2, z, ry: turn, rx: -0.08, radius: 0.004 });
    b.box(0.04, 0.16, 0.03, 'bronze', { x, y: y + 0.08, z: z - 0.03, ry: turn });
    b.box(0.22, 0.008, 0.16, 'bronze', { x, y: y + 0.004, z: z - 0.03, ry: turn });
  }

  // ------------------------------------------------------------ books (instanced)
  const bookGeometry = new THREE.BoxGeometry(1, 1, 1);
  const bookMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85 });
  const bookMesh = new THREE.InstancedMesh(bookGeometry, bookMaterial, Math.max(1, books.length));
  books.forEach((book, index) => { bookMesh.setMatrixAt(index, book.matrix); bookMesh.setColorAt(index, new THREE.Color(book.color)); });
  bookMesh.count = books.length; bookMesh.castShadow = tier !== 'light'; bookMesh.receiveShadow = true; bookMesh.name = 'books';
  root.add(bookMesh);

  b.build(root);
  b.dispose();
  // The task chairs: one instanced mesh per material for all of them; each
  // chair group stays a live transform (swivel, pushed in, a seated person).
  const chairParts = [];
  if (liveChairs.length) {
    const template = new THREE.Group(); const chairBuilder = createBuilder(materials);
    chair(chairBuilder, 0, 0, 0); chairBuilder.build(template); chairBuilder.dispose();
    template.updateMatrixWorld(true);
    for (const part of [...template.children]) {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, liveChairs.length);
      mesh.name = 'chairs'; mesh.castShadow = part.castShadow; mesh.receiveShadow = part.receiveShadow; mesh.frustumCulled = false;
      root.add(mesh); chairParts.push({ mesh, offset: part.matrixWorld.clone() });
    }
  }
  const chairMatrix = new THREE.Matrix4();
  const syncChairs = () => {
    for (const { mesh, offset } of chairParts) {
      liveChairs.forEach((group, index) => { group.updateMatrixWorld(); mesh.setMatrixAt(index, chairMatrix.multiplyMatrices(group.matrixWorld, offset)); });
      mesh.instanceMatrix.needsUpdate = true;
    }
  };
  root.updateMatrixWorld(true); syncChairs();

  return {
    root, workstations, screens, footprints, chiefStrip, syncChairs,
    dispose() { root.traverse((node) => { if (node.isMesh) { node.geometry?.dispose(); if (node.material && !node.material.name) node.material.dispose?.(); } }); bookMaterial.dispose(); },
  };
}

let cachedPool = null;
function poolTexture() {
  if (cachedPool) return cachedPool;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
  const g = canvas.getContext('2d');
  const gradient = g.createRadialGradient(64, 64, 2, 64, 64, 63);
  gradient.addColorStop(0, 'rgba(255,255,255,0.9)'); gradient.addColorStop(0.4, 'rgba(255,255,255,0.35)'); gradient.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gradient; g.fillRect(0, 0, 128, 128);
  cachedPool = new THREE.CanvasTexture(canvas); cachedPool.colorSpace = THREE.SRGBColorSpace;
  return cachedPool;
}
