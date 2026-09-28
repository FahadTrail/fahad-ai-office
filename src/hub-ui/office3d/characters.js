// The Office's employees as 3D figures (Character V2). Stylised, professional
// people: natural proportions, tailored silhouettes, hair and wardrobe that
// give each department a quiet identity. No faces are drawn (a small nose
// and ears only), no names, no costumes. The figures sit with their backs to
// the camera, so hair, shoulders and clothing carry most of the character.
//
// Performance: every figure uses one shared vertex-coloured material, and
// its parts are merged per moving part (legs, body, head, two upper arms, two
// forearms): 7 draw calls per figure.
//
// Geometry and wardrobe are built here; which pose to show comes from
// state-visuals.js; the scene decides when. Replace this module to change the
// character style without touching logic.

// Muted, cohesive wing accents (the Office stays one visual system).
export const WING_ACCENTS = Object.freeze({
  atrium: '#6f8fbf', intelligence: '#6b7fa8', strategy: '#7d9a86', creative: '#b08a72', build: '#7b76b0',
});

// Wardrobe per employee. Analytical roles (RESEARCH, LEGAL, AUDIT) are
// precise: knitwear or suits, glasses. PRODUCT and FINANCE are executive:
// tailored jackets. CREATIVE and SOCIAL are a little more expressive: colour
// and rolled sleeves. CODING is technical: a dark hoodie and headphones.
// CHIEF is senior and central: a charcoal suit and a slightly taller frame.
export const WARDROBE = Object.freeze({
  chief: { top: '#2b2f38', legs: '#23262c', shirt: '#f1eee8', skin: '#c99b7a', hair: '#2a2421', style: 'short', cut: 'suit', pocket: true, scale: 1.05 },
  research: { top: '#6f7b8c', legs: '#383c44', shirt: '#e9e6e0', skin: '#e0b99a', hair: '#3b2c24', style: 'bun', cut: 'knit', glasses: true },
  legal: { top: '#27324a', legs: '#222838', shirt: '#f4f4f2', skin: '#8d5f45', hair: '#1c1917', style: 'short', cut: 'suit', tie: '#6b7fa8' },
  audit: { top: '#5b6068', legs: '#34373d', shirt: '#eceff2', skin: '#d2a888', hair: '#4a4038', style: 'crop', cut: 'blazer', glasses: true },
  product: { top: '#9c8466', legs: '#33363c', shirt: '#f3f1ec', skin: '#c58f6d', hair: '#5a3e2c', style: 'long', cut: 'blazer' },
  finance: { top: '#3a3f47', legs: '#2c3036', shirt: '#eef1f5', skin: '#b98563', hair: '#2a2420', style: 'side', cut: 'suit', tie: '#7d9a86' },
  creative: { top: '#b0735a', legs: '#2f3136', shirt: '#efe6dc', skin: '#a8745a', hair: '#1f1a18', style: 'long', cut: 'knit', rolled: true },
  social: { top: '#8fa596', legs: '#3a3d42', shirt: '#f5f2ec', skin: '#e6c1a3', hair: '#6b4a32', style: 'bun', cut: 'overshirt', rolled: true },
  coding: { top: '#30343c', legs: '#23262b', shirt: '#30343c', skin: '#d9ad8c', hair: '#2c2522', style: 'crop', cut: 'hoodie', headphones: true },
});
const DEFAULT_WARDROBE = WARDROBE.research;
const SHOE = '#1c1d20';

export function createCharacterFactory(THREE) {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.74, metalness: 0 });
  // Torso: a tailored lathe profile (waist → chest → shoulders), flattened.
  const torsoProfile = [[0, 0], [0.165, 0.015], [0.19, 0.1], [0.172, 0.28], [0.2, 0.44], [0.222, 0.57], [0.216, 0.65], [0.17, 0.715], [0.075, 0.755], [0, 0.765]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const cap = (fraction) => new THREE.SphereGeometry(0.128, 22, 12, 0, Math.PI * 2, 0, Math.PI * fraction);
  const geometries = {
    torso: new THREE.LatheGeometry(torsoProfile, 22),
    shoulder: new THREE.SphereGeometry(0.078, 14, 10),
    neck: new THREE.CylinderGeometry(0.048, 0.056, 0.1, 12),
    head: new THREE.SphereGeometry(0.12, 24, 16),
    ear: new THREE.SphereGeometry(0.026, 8, 6),
    nose: new THREE.ConeGeometry(0.018, 0.04, 8),
    hairShort: cap(0.52), hairCrop: cap(0.44), hairSide: cap(0.56),
    bun: new THREE.SphereGeometry(0.056, 12, 10),
    hairLong: new THREE.CapsuleGeometry(0.1, 0.12, 4, 12),
    upperArm: new THREE.CapsuleGeometry(0.052, 0.22, 4, 10),
    forearm: new THREE.CapsuleGeometry(0.046, 0.2, 4, 10),
    cuff: new THREE.CylinderGeometry(0.05, 0.05, 0.035, 12),
    hand: new THREE.SphereGeometry(0.045, 10, 8),
    thigh: new THREE.CapsuleGeometry(0.08, 0.3, 4, 10),
    shin: new THREE.CapsuleGeometry(0.066, 0.34, 4, 10),
    shoe: new THREE.CapsuleGeometry(0.05, 0.13, 4, 8),
    panel: new THREE.BoxGeometry(1, 1, 1),
    lens: new THREE.TorusGeometry(0.032, 0.006, 6, 16),
    band: new THREE.TorusGeometry(0.138, 0.012, 6, 20, Math.PI),
    earCup: new THREE.CylinderGeometry(0.038, 0.038, 0.03, 14),
    hood: new THREE.TorusGeometry(0.11, 0.045, 8, 18),
  };
  const colour = new THREE.Color();

  // Bakes a part into its moving group: geometry × matrix + a colour.
  const bake = (geometry, hex, matrix) => {
    const baked = (geometry.index ? geometry.toNonIndexed() : geometry.clone()).applyMatrix4(matrix);
    colour.set(hex);
    const count = baked.attributes.position.count;
    const colours = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) colours.set([colour.r, colour.g, colour.b], index * 3);
    return { position: baked.attributes.position.array, normal: baked.attributes.normal.array, colour: colours, dispose: () => baked.dispose() };
  };
  const merge = (parts) => {
    const size = (key) => parts.reduce((sum, part) => sum + part[key].length, 0);
    const buffers = { position: new Float32Array(size('position')), normal: new Float32Array(size('normal')), colour: new Float32Array(size('colour')) };
    const offsets = { position: 0, normal: 0, colour: 0 };
    for (const part of parts) for (const key of Object.keys(buffers)) { buffers[key].set(part[key], offsets[key]); offsets[key] += part[key].length; part.dispose(); }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(buffers.position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(buffers.normal, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(buffers.colour, 3));
    geometry.computeBoundingSphere();
    return geometry;
  };
  const made = [];

  // A seated figure; origin at the seat, facing +z.
  function create({ key, accent }) {
    const look = WARDROBE[key] || DEFAULT_WARDROBE;
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const head = new THREE.Group(); head.position.set(0, 0.9, 0.02);
    body.add(head);
    const pieces = [];
    // A part: geometry, colour, parent group, position, rotation, scale.
    const part = (geometry, hex, parent, position, rotation = [0, 0, 0], scale = [1, 1, 1]) => {
      const node = new THREE.Object3D();
      node.position.set(...position); node.rotation.set(...rotation); node.scale.set(...scale);
      parent.add(node);
      pieces.push({ node, geometry, hex, parent });
    };
    const sleeve = look.top;

    // Body: torso, shoulders, neck and the details of the cut.
    part(geometries.torso, look.top, body, [0, 0.02, 0], [0, 0, 0], [1.12, 1, 0.7]);
    for (const side of [-1, 1]) part(geometries.shoulder, look.top, body, [side * 0.205, 0.64, -0.005], [0, 0, 0], [1.05, 0.8, 0.95]);
    part(geometries.neck, look.skin, body, [0, 0.79, 0.01]);
    if (look.cut === 'suit' || look.cut === 'blazer') {
      part(geometries.panel, look.shirt, body, [0, 0.6, 0.148], [-0.18, 0, 0], [0.1, 0.2, 0.012]);
      for (const side of [-1, 1]) part(geometries.panel, shade(look.top, -0.18), body, [side * 0.062, 0.6, 0.153], [-0.18, 0, side * 0.32], [0.035, 0.24, 0.012]);
      if (look.tie) part(geometries.panel, look.tie, body, [0, 0.57, 0.158], [-0.16, 0, 0], [0.034, 0.19, 0.01]);
      if (look.pocket) part(geometries.panel, accent, body, [0.12, 0.55, 0.15], [-0.1, 0, 0], [0.05, 0.02, 0.01]);
    } else if (look.cut === 'hoodie') {
      part(geometries.hood, shade(look.top, -0.1), body, [0, 0.74, -0.07], [1.25, 0, 0], [1, 1, 0.8]);
    } else {
      part(geometries.panel, look.shirt, body, [0, 0.72, 0.1], [-0.5, 0, 0], [0.12, 0.05, 0.012]);
    }

    // Head: head, ears, nose and hair (seen most, from behind the desk).
    part(geometries.head, look.skin, head, [0, 0, 0], [0, 0, 0], [0.9, 1.1, 0.98]);
    for (const side of [-1, 1]) part(geometries.ear, look.skin, head, [side * 0.108, -0.005, -0.005], [0, 0, 0], [0.5, 1, 0.8]);
    part(geometries.nose, look.skin, head, [0, -0.012, 0.118], [Math.PI / 2, 0, 0]);
    const hair = { short: geometries.hairShort, crop: geometries.hairCrop, side: geometries.hairSide, bun: geometries.hairShort, long: geometries.hairShort }[look.style] || geometries.hairShort;
    part(hair, look.hair, head, [0, 0.012, -0.012], [look.style === 'side' ? -0.35 : -0.42, 0, look.style === 'side' ? 0.12 : 0], [0.94, 1.1, 1.02]);
    if (look.style === 'bun') part(geometries.bun, look.hair, head, [0, 0.07, -0.115]);
    if (look.style === 'long') part(geometries.hairLong, look.hair, head, [0, -0.1, -0.06], [0.12, 0, 0], [1.08, 1, 0.52]);
    if (look.glasses) {
      for (const side of [-1, 1]) part(geometries.lens, '#26282d', head, [side * 0.042, 0.012, 0.112]);
      part(geometries.panel, '#26282d', head, [0, 0.014, 0.114], [0, 0, 0], [0.02, 0.006, 0.006]);
    }
    if (look.headphones) {
      part(geometries.band, '#1c1e22', head, [0, 0.02, -0.005], [0, 0, 0], [0.95, 1.05, 1]);
      for (const side of [-1, 1]) part(geometries.earCup, '#1c1e22', head, [side * 0.122, 0.0, -0.005], [0, 0, Math.PI / 2]);
    }

    // Arms: upper arm on the shoulder, forearm + cuff + hand on the elbow.
    const arm = (side) => {
      const shoulder = new THREE.Group(); shoulder.position.set(side * 0.235, 0.62, 0);
      const elbow = new THREE.Group(); elbow.position.set(0, -0.3, 0);
      shoulder.add(elbow); body.add(shoulder);
      part(geometries.upperArm, sleeve, shoulder, [0, -0.15, 0]);
      if (look.rolled) {
        part(geometries.cuff, sleeve, elbow, [0, -0.03, 0], [0, 0, 0], [1.1, 1.4, 1.1]);
        part(geometries.forearm, look.skin, elbow, [0, -0.14, 0], [0, 0, 0], [0.9, 1, 0.9]);
      } else {
        part(geometries.forearm, sleeve, elbow, [0, -0.13, 0]);
        if (look.cut === 'suit' || look.cut === 'blazer') part(geometries.cuff, look.shirt, elbow, [0, -0.245, 0], [0, 0, 0], [0.95, 1, 0.95]);
      }
      part(geometries.hand, look.skin, elbow, [0, -0.29, 0.01], [0, 0, 0], [0.78, 1.1, 0.55]);
      return { shoulder, elbow };
    };
    const left = arm(-1);
    const right = arm(1);

    // Legs (static): thighs forward, shins down, shoes.
    for (const side of [-1, 1]) {
      const hip = new THREE.Group(); hip.position.set(side * 0.105, 0.06, 0.05); hip.rotation.x = -Math.PI / 2;
      const knee = new THREE.Group(); knee.position.set(0, -0.42, 0); knee.rotation.x = Math.PI / 2;
      hip.add(knee); root.add(hip);
      part(geometries.thigh, look.legs, hip, [0, -0.2, 0]);
      part(geometries.shin, look.legs, knee, [0, -0.2, 0]);
      part(geometries.shoe, SHOE, knee, [0, -0.43, 0.06], [Math.PI / 2, 0, 0], [1, 1, 0.8]);
    }

    // Merge each moving part's pieces into one mesh.
    const rigid = [root, body, head, left.shoulder, left.elbow, right.shoulder, right.elbow];
    root.updateMatrixWorld(true);
    const buckets = new Map(rigid.map((group) => [group, []]));
    const inverse = new THREE.Matrix4();
    for (const piece of pieces) {
      let owner = piece.parent;
      while (!buckets.has(owner)) owner = owner.parent;
      inverse.copy(owner.matrixWorld).invert();
      buckets.get(owner).push(bake(piece.geometry, piece.hex, new THREE.Matrix4().multiplyMatrices(inverse, piece.node.matrixWorld)));
      piece.node.parent.remove(piece.node);
    }
    for (const [group, parts] of buckets) {
      if (!parts.length) continue;
      const geometry = merge(parts);
      made.push(geometry);
      const mesh = new THREE.Mesh(geometry, material);
      // Only the body and head cast shadows (limbs add draw calls, not depth).
      mesh.castShadow = group === body || group === head;
      mesh.receiveShadow = false;
      group.add(mesh);
    }
    if (look.scale) root.scale.setScalar(look.scale);
    return { root, body, head, left, right };
  }

  const dispose = () => { Object.values(geometries).forEach((geometry) => geometry.dispose()); made.forEach((geometry) => geometry.dispose()); material.dispose(); };
  return { create, dispose };
}

// A darker or lighter version of a colour (-1 … 1).
function shade(hex, amount) {
  const value = parseInt(hex.slice(1), 16);
  const channel = (shift) => {
    const c = (value >> shift) & 255;
    return Math.round(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount);
  };
  return `#${[16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, '0')).join('')}`;
}

// Pose targets (radians) per visual pose. The scene eases toward them.
export const POSES = Object.freeze({
  relaxed: { lean: -0.08, head: -0.02, turn: 0, shoulder: 0.25, elbow: -0.9, reach: 0 },
  focused: { lean: 0.06, head: 0.08, turn: 0, shoulder: -0.55, elbow: -0.75, reach: 0.02 },
  working: { lean: 0.12, head: 0.14, turn: 0, shoulder: -0.75, elbow: -0.65, reach: 0.06 },
  reading: { lean: 0.1, head: 0.28, turn: 0, shoulder: -0.6, elbow: -0.8, reach: 0.02 },
  paused: { lean: -0.02, head: 0, turn: 0.18, shoulder: 0.15, elbow: -1.0, reach: 0 },
});

// Applies a pose with ambient motion (breathing) and — only when the real
// state is active — a small task motion (hands at work).
export function applyPose(figure, pose, { time, ambient, task, seed }) {
  const breathe = Math.sin(time * 1.3 + seed) * 0.012 * ambient;
  const work = Math.sin(time * 7 + seed * 3) * 0.05 * task;
  figure.body.rotation.x += ((pose.lean + breathe) - figure.body.rotation.x) * 0.08;
  figure.head.rotation.x += ((pose.head + breathe * 2) - figure.head.rotation.x) * 0.08;
  figure.head.rotation.y += ((pose.turn + Math.sin(time * 0.3 + seed) * 0.05 * ambient) - figure.head.rotation.y) * 0.05;
  for (const [arm, offset] of [[figure.left, 0], [figure.right, Math.PI]]) {
    arm.shoulder.rotation.x += ((pose.shoulder + (task ? Math.sin(time * 7 + seed + offset) * 0.04 * task : 0)) - arm.shoulder.rotation.x) * 0.1;
    arm.elbow.rotation.x += ((pose.elbow + work) - arm.elbow.rotation.x) * 0.1;
  }
}
