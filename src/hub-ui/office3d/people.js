// The Office's people (Final Design Spec §05): one realistic rig at 7.5
// heads, simplified matte faces with no lip-sync, tailored business and Gulf
// attire with one department garment tone. Clips blend over 300 ms. No
// floating icons: state shows on the desk and in the body.
//
// Built procedurally (no downloaded models): smooth tapered limbs and an
// elliptical torso skinned to one shared skeleton layout, one vertex-coloured
// matte material for everyone, keyframed clips for every state.
import * as THREE from '../vendor/three.js?v=__UI_VERSION__';

export const BLEND_SECONDS = 0.3;
export const HEIGHT = 1.75; // 7.5 heads of 0.233 m

// Wardrobe: business suits, knitwear, the kandura with ghutra and agal, the
// abaya with shayla. Garment tones are restrained and differ by department.
export const WARDROBE = Object.freeze({
  chief: { attire: 'kandura', robe: '#f4f2ec', headdress: 'ghutra', cloth: '#f7f6f2', skin: '#b98a68', build: 1.03 },
  research: { attire: 'business', top: '#5d6670', shirt: '#f2efe8', legs: '#3b3f45', skin: '#e2b896', hair: 'bun', hairColor: '#3a2a20', glasses: true, build: 0.96, female: true },
  creative: { attire: 'abaya', robe: '#1d1c1f', trim: '#b8a27f', headdress: 'shayla', cloth: '#232226', skin: '#c99a76', build: 0.95, female: true },
  social: { attire: 'business', top: '#8a6f55', shirt: '#ece6da', legs: '#4a4038', skin: '#a7724f', hair: 'short', hairColor: '#1f1a17', build: 0.99, open: true },
  coding: { attire: 'business', top: '#2c3036', shirt: '#2c3036', legs: '#2a2c30', skin: '#d6a77f', hair: 'crop', hairColor: '#241c17', build: 1.0, knit: true },
  product: { attire: 'kandura', robe: '#d9d1c2', headdress: 'ghutra', cloth: '#f4f2ec', skin: '#c08d66', build: 1.0 },
  finance: { attire: 'business', top: '#283447', shirt: '#f4f2ee', legs: '#283447', skin: '#8d5b3e', hair: 'long', hairColor: '#17110e', build: 0.95, female: true },
  audit: { attire: 'business', top: '#3a3a3c', shirt: '#eef0f2', legs: '#343436', skin: '#e9c3a1', hair: 'side', hairColor: '#6b5a48', glasses: true, build: 1.01, tie: '#5b2f2f' },
  legal: { attire: 'kandura', robe: '#f6f4ef', headdress: 'ghutra', cloth: '#f7f6f2', skin: '#9c6b4c', build: 1.02, beard: true },
});

// ------------------------------------------------------------------ skeleton
// Bind pose: standing, feet at y = 0, facing −z (the desk), right hand +x.
const BONES = [
  ['hips', null, [0, 0.95, 0]], ['spine', 'hips', [0, 1.08, 0]], ['chest', 'spine', [0, 1.26, 0]], ['neck', 'chest', [0, 1.47, 0]], ['head', 'neck', [0, 1.55, 0]],
  ['upperArm.L', 'chest', [-0.19, 1.425, 0]], ['foreArm.L', 'upperArm.L', [-0.205, 1.125, 0]], ['hand.L', 'foreArm.L', [-0.215, 0.865, 0]],
  ['upperArm.R', 'chest', [0.19, 1.425, 0]], ['foreArm.R', 'upperArm.R', [0.205, 1.125, 0]], ['hand.R', 'foreArm.R', [0.215, 0.865, 0]],
  ['thigh.L', 'hips', [-0.095, 0.91, 0]], ['shin.L', 'thigh.L', [-0.1, 0.49, 0]], ['foot.L', 'shin.L', [-0.1, 0.08, 0]],
  ['thigh.R', 'hips', [0.095, 0.91, 0]], ['shin.R', 'thigh.R', [0.1, 0.49, 0]], ['foot.R', 'shin.R', [0.1, 0.08, 0]],
];
const BONE_INDEX = Object.fromEntries(BONES.map(([name], index) => [name, index]));
const BONE_WORLD = Object.fromEntries(BONES.map(([name, , position]) => [name, position]));

// ------------------------------------------------------------------ geometry
class Body {
  constructor() { this.positions = []; this.normals = []; this.colors = []; this.indices = []; this.skinIndex = []; this.skinWeight = []; }
  vertex([x, y, z], [nx, ny, nz], color, weights) {
    this.positions.push(x, y, z); this.normals.push(nx, ny, nz); this.colors.push(color.r, color.g, color.b);
    const list = Object.entries(weights).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const total = list.reduce((sum, [, weight]) => sum + weight, 0) || 1;
    for (let k = 0; k < 4; k += 1) { this.skinIndex.push(list[k] ? BONE_INDEX[list[k][0]] : 0); this.skinWeight.push(list[k] ? list[k][1] / total : 0); }
    return this.positions.length / 3 - 1;
  }
  // A ring-based surface: rings[i] = { centre, rx, rz, weights, color(theta) }; theta 0 = front (−z).
  rings(list, segments = 18, { cap = false, arc = null } = {}) {
    const start = this.positions.length / 3;
    const span = arc ? arc[1] - arc[0] : Math.PI * 2;
    const columns = arc ? segments + 1 : segments;
    for (const ring of list) {
      for (let s = 0; s < columns; s += 1) {
        const theta = (arc ? arc[0] : 0) + (s / segments) * span;
        const x = Math.sin(theta) * ring.rx; const z = -Math.cos(theta) * ring.rz;
        const normal = new THREE.Vector3(Math.sin(theta) / ring.rx, ring.ny || 0, -Math.cos(theta) / ring.rz).normalize();
        this.vertex([ring.centre[0] + x, ring.centre[1], ring.centre[2] + z], normal.toArray(), typeof ring.color === 'function' ? ring.color(theta, ring) : ring.color, ring.weights);
      }
    }
    // Outward winding when rings rise; drapes that fall are wound the other way.
    const falling = list.length > 1 && list[1].centre[1] < list[0].centre[1];
    for (let r = 0; r < list.length - 1; r += 1) for (let s = 0; s < segments; s += 1) {
      const a = start + r * columns + s; const b = start + r * columns + ((s + 1) % columns); const c = a + columns; const d = b + columns;
      if (falling) this.indices.push(a, b, c, b, d, c); else this.indices.push(a, c, b, b, c, d);
    }
    if (cap) { const last = list.at(-1); const centre = this.vertex(last.centre, [0, 1, 0], typeof last.color === 'function' ? last.color(0, last) : last.color, last.weights); const base = start + (list.length - 1) * columns; for (let s = 0; s < segments; s += 1) this.indices.push(base + s, centre, base + ((s + 1) % columns)); }
  }
  // A smooth tapered limb from joint a to joint b, blending weights near both ends.
  limb(boneA, boneB, parent, from, to, r0, r1, color, { segments = 12, rings = 7, flatten = 1, endCap = false } = {}) {
    const a = new THREE.Vector3(...from); const b = new THREE.Vector3(...to);
    const axis = b.clone().sub(a); const length = axis.length(); axis.normalize();
    const side = Math.abs(axis.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(axis, side).normalize(); const v = new THREE.Vector3().crossVectors(axis, u).normalize();
    const start = this.positions.length / 3;
    for (let i = 0; i <= rings; i += 1) {
      const t = i / rings;
      const radius = r0 + (r1 - r0) * t;
      // Muscle swell a third of the way down.
      const swell = 1 + Math.sin(Math.min(1, t * 1.5) * Math.PI) * 0.08;
      const centre = a.clone().addScaledVector(axis, length * t);
      const weights = t < 0.18 && parent ? { [parent]: 0.5 - t * 2.5, [boneA]: 0.5 + t * 2.5 } : t > 0.82 && boneB ? { [boneA]: 1 - (t - 0.82) * 2.6, [boneB]: (t - 0.82) * 2.6 } : { [boneA]: 1 };
      for (let s = 0; s < segments; s += 1) {
        const theta = (s / segments) * Math.PI * 2;
        const normal = u.clone().multiplyScalar(Math.cos(theta)).addScaledVector(v, Math.sin(theta) * flatten).normalize();
        this.vertex(centre.clone().addScaledVector(u, Math.cos(theta) * radius * swell).addScaledVector(v, Math.sin(theta) * radius * swell * flatten).toArray(), normal.toArray(), color, weights);
      }
    }
    for (let i = 0; i < rings; i += 1) for (let s = 0; s < segments; s += 1) {
      const p = start + i * segments + s; const q = start + i * segments + ((s + 1) % segments);
      this.indices.push(p, q, p + segments, q, q + segments, p + segments);
    }
    if (endCap) { const centre = this.vertex(b.toArray(), axis.toArray(), color, boneB ? { [boneA]: 0.5, [boneB]: 0.5 } : { [boneA]: 1 }); const base = start + rings * segments; for (let s = 0; s < segments; s += 1) this.indices.push(base + s, base + ((s + 1) % segments), centre); }
  }
  // An ellipsoid (head, hands, feet, hair masses), skinned to one bone.
  ellipsoid(bone, centre, [rx, ry, rz], color, { segments = 16, rings = 12, from = 0, to = Math.PI, colorAt = null, squash = null } = {}) {
    const start = this.positions.length / 3;
    for (let i = 0; i <= rings; i += 1) {
      const phi = from + (to - from) * (i / rings);
      for (let s = 0; s <= segments; s += 1) {
        const theta = (s / segments) * Math.PI * 2;
        let x = Math.sin(phi) * Math.sin(theta); let y = Math.cos(phi); let z = -Math.sin(phi) * Math.cos(theta);
        if (squash) [x, y, z] = squash(x, y, z);
        const p = [centre[0] + x * rx, centre[1] + y * ry, centre[2] + z * rz];
        this.vertex(p, new THREE.Vector3(x / rx, y / ry, z / rz).normalize().toArray(), colorAt ? colorAt(x, y, z) : color, typeof bone === 'string' ? { [bone]: 1 } : bone(p));
      }
    }
    for (let i = 0; i < rings; i += 1) for (let s = 0; s < segments; s += 1) {
      const a = start + i * (segments + 1) + s; const b = a + segments + 1;
      this.indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  geometry() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.skinIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.skinWeight, 4));
    geometry.setIndex(this.indices);
    geometry.computeBoundingSphere();
    return geometry;
  }
}

const linear = (hex) => new THREE.Color(hex);
const torsoWeight = (y) => (y < 0.99 ? { hips: 1 } : y < 1.06 ? { hips: (1.06 - y) / 0.07, spine: (y - 0.99) / 0.07 } : y < 1.2 ? { spine: 1 } : y < 1.28 ? { spine: (1.28 - y) / 0.08, chest: (y - 1.2) / 0.08 } : y < 1.44 ? { chest: 1 } : { chest: 0.5, neck: 0.5 });

export function buildPersonGeometry(key, detail = 'high') {
  const look = WARDROBE[key] || WARDROBE.audit;
  const body = new Body();
  const seg = detail === 'high' ? 1 : 0.6;
  const n = (value) => Math.max(6, Math.round(value * seg));
  const skin = linear(look.skin);
  const robe = look.attire === 'kandura' || look.attire === 'abaya';
  const top = linear(robe ? look.robe : look.top);
  const legs = linear(robe ? look.robe : look.legs);
  const shirt = linear(look.shirt || look.robe);
  const shoes = linear(look.attire === 'kandura' ? '#5a4232' : '#1c1a19');
  const b = look.build;

  // Torso: elliptical rings from the hips to the neck; the shirt shows in a V
  // at the front of a jacket; the kandura shows its placket.
  const chestColor = (theta, ring) => {
    const front = Math.cos(theta) > 0.86 && ring.centre[1] > 1.24;
    if (look.attire === 'business' && !look.knit && front) {
      if (look.tie && Math.cos(theta) > 0.97 && ring.centre[1] < 1.42) return linear(look.tie);
      return shirt;
    }
    if (look.attire === 'abaya' && Math.cos(theta) > 0.95) return linear(look.trim);
    return top;
  };
  const torso = [
    [0.86, 0.165, 0.115], [0.95, 0.17, 0.118], [1.04, 0.152, 0.105], [1.13, 0.158, 0.11], [1.24, 0.178, 0.122], [1.34, 0.19, 0.122], [1.41, 0.19, 0.11], [1.45, 0.12, 0.085], [1.48, 0.06, 0.055],
  ].map(([y, rx, rz]) => ({ centre: [0, y, 0.005], rx: rx * b, rz: rz * b, weights: torsoWeight(y), color: chestColor }));
  body.rings(torso, n(22));
  // Shoulders: rounded caps over the arm joints.
  for (const side of [-1, 1]) {
    const arm = side < 0 ? 'upperArm.L' : 'upperArm.R';
    body.ellipsoid(() => ({ chest: 0.5, [arm]: 0.5 }), [side * 0.175 * b, 1.415, 0.005], [0.068 * b, 0.06, 0.07], top, { segments: n(12), rings: n(8) });
  }
  // Neck and head.
  body.limb('neck', 'head', 'chest', [0, 1.45, 0.01], [0, 1.57, 0.005], 0.055, 0.05, skin, { segments: n(12), rings: 3 });
  const headCentre = [0, 1.635, -0.005];
  body.ellipsoid('head', headCentre, [0.082, 0.112, 0.098], skin, { segments: n(22), rings: n(16),
    squash: (x, y, z) => [x * (1 - Math.max(0, -y) * 0.22), y, z * (1 - Math.max(0, -y) * 0.12) + (z < 0 && y < 0 ? 0.04 * y : 0)] });
  // Simplified features: a soft nose and ears; no drawn eyes or mouth.
  body.ellipsoid('head', [0, 1.622, -0.098], [0.013, 0.025, 0.016], skin, { segments: 8, rings: 6 });
  for (const side of [-1, 1]) body.ellipsoid('head', [side * 0.083, 1.64, 0.004], [0.012, 0.028, 0.02], skin, { segments: 8, rings: 6 });
  if (look.beard) body.ellipsoid('head', [0, 1.565, -0.045], [0.07, 0.05, 0.06], linear('#2a211c'), { segments: n(14), rings: 8, from: Math.PI * 0.35, to: Math.PI });
  // Hair, or the headdress.
  if (look.headdress === 'ghutra') {
    const cloth = linear(look.cloth);
    // The ghutra falls from the crown over the shoulders, open at the face.
    const drape = [[1.765, 0.092, 0.105], [1.7, 0.1, 0.112], [1.6, 0.112, 0.122], [1.5, 0.14, 0.13], [1.42, 0.2, 0.15]].map(([y, rx, rz]) => ({ centre: [0, y, 0.01], rx, rz, weights: y > 1.48 ? { head: 1 } : { head: 0.4, chest: 0.6 }, color: cloth }));
    body.rings(drape, n(20), { arc: [Math.PI * 0.32, Math.PI * 1.68] });
    body.ellipsoid('head', [0, 1.69, 0.0], [0.092, 0.08, 0.104], cloth, { segments: n(18), rings: n(8), from: 0, to: Math.PI * 0.55 });
    // The agal: a black double cord on the crown.
    for (const offset of [0, 0.014]) body.rings([{ centre: [0, 1.715 + offset, 0.005], rx: 0.093, rz: 0.104, weights: { head: 1 }, color: linear('#141414') }, { centre: [0, 1.727 + offset, 0.005], rx: 0.093, rz: 0.104, weights: { head: 1 }, color: linear('#141414') }], n(20));
  } else if (look.headdress === 'shayla') {
    const cloth = linear(look.cloth);
    const drape = [[1.76, 0.088, 0.1], [1.68, 0.098, 0.108], [1.58, 0.102, 0.11], [1.5, 0.1, 0.1], [1.44, 0.17, 0.13]].map(([y, rx, rz]) => ({ centre: [0, y, 0.008], rx, rz, weights: y > 1.48 ? { head: 1 } : { head: 0.4, chest: 0.6 }, color: cloth }));
    body.rings(drape, n(20), { arc: [Math.PI * 0.28, Math.PI * 1.72] });
    body.ellipsoid('head', [0, 1.665, 0.004], [0.088, 0.105, 0.102], cloth, { segments: n(18), rings: n(10), from: 0, to: Math.PI * 0.5 });
  } else {
    const hair = linear(look.hairColor);
    const extent = { short: 0.52, crop: 0.48, side: 0.55, bun: 0.6, long: 0.62 }[look.hair] || 0.5;
    body.ellipsoid('head', [0, 1.645, 0.006], [0.087, 0.118, 0.103], hair, { segments: n(20), rings: n(10), from: 0, to: Math.PI * extent,
      squash: (x, y, z) => [x, y, z > 0 ? z * 1.04 : z * (look.hair === 'side' ? 0.98 : 0.96)] });
    if (look.hair === 'bun') body.ellipsoid('head', [0, 1.69, 0.1], [0.045, 0.042, 0.04], hair, { segments: 12, rings: 8 });
    if (look.hair === 'long') body.rings([[1.62, 0.088, 0.09], [1.5, 0.095, 0.085], [1.38, 0.11, 0.07]].map(([y, rx, rz]) => ({ centre: [0, y, 0.035], rx, rz, weights: y > 1.48 ? { head: 1 } : { head: 0.3, chest: 0.7 }, color: hair })), n(16), { arc: [Math.PI * 0.55, Math.PI * 1.45] });
  }
  if (look.glasses) {
    const frame = linear('#1d1b1a');
    for (const side of [-1, 1]) body.rings([0, 1].map((k) => ({ centre: [side * 0.032, 1.646 + k * 0.004, -0.094], rx: 0.024, rz: 0.004, weights: { head: 1 }, color: frame })), 10);
  }
  // Arms: sleeves to the wrist, then hands.
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? -1 : 1;
    const shoulder = [s * 0.19 * b, 1.425, 0]; const elbow = [s * 0.205 * b, 1.125, 0.01]; const wrist = [s * 0.215 * b, 0.865, 0];
    const sleeve = robe ? (look.attire === 'abaya' ? 0.062 : 0.058) : 0.052;
    body.limb(`upperArm.${side}`, `foreArm.${side}`, 'chest', shoulder, elbow, sleeve * b, (sleeve - 0.008) * b, top, { segments: n(12), rings: 6 });
    body.limb(`foreArm.${side}`, `hand.${side}`, `upperArm.${side}`, elbow, wrist, (sleeve - 0.008) * b, (robe ? sleeve - 0.004 : 0.04) * b, top, { segments: n(12), rings: 6 });
    // The hand: a softly flattened mitten with a thumb.
    body.ellipsoid(`hand.${side}`, [wrist[0] + s * 0.004, wrist[1] - 0.075, wrist[2] - 0.004], [0.026, 0.07, 0.042], skin, { segments: n(12), rings: 8 });
    body.ellipsoid(`hand.${side}`, [wrist[0] - s * 0.012, wrist[1] - 0.05, wrist[2] - 0.035], [0.013, 0.035, 0.014], skin, { segments: 8, rings: 6 });
  }
  // Legs: trousers (or the robe falling over them) and shoes.
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? -1 : 1;
    const hip = [s * 0.095 * b, 0.91, 0]; const knee = [s * 0.1 * b, 0.49, -0.01]; const ankle = [s * 0.1 * b, 0.08, 0.01];
    const width = robe ? 1.25 : 1;
    body.limb(`thigh.${side}`, `shin.${side}`, 'hips', hip, knee, 0.078 * b * width, 0.056 * b * width, legs, { segments: n(14), rings: 7 });
    body.limb(`shin.${side}`, `foot.${side}`, `thigh.${side}`, knee, ankle, 0.056 * b * width, (robe ? 0.07 : 0.046) * b, legs, { segments: n(14), rings: 7 });
    body.ellipsoid(`foot.${side}`, [s * 0.1 * b, 0.045, -0.06], [0.045, 0.04, 0.125], shoes, { segments: n(12), rings: 8, squash: (x, y, z) => [x, Math.max(y, -0.55), z] });
  }
  return body.geometry();
}

// ------------------------------------------------------------------ clips
// Poses are local bone rotations (radians, XYZ) plus a hips offset. Seated
// poses put the hips on a 0.47 m seat.
const SEATED = { hipsY: -0.39, hipsZ: 0.06, 'thigh.L': [1.5, 0, 0.04], 'thigh.R': [1.5, 0, -0.04], 'shin.L': [-1.5, 0, 0], 'shin.R': [-1.5, 0, 0], 'foot.L': [0.05, 0, 0], 'foot.R': [0.05, 0, 0] };
const POSES = {
  relaxed: { ...SEATED, spine: [0.06, 0, 0], chest: [0.04, 0, 0], head: [0.02, 0, 0], 'upperArm.L': [0.32, 0, -0.12], 'upperArm.R': [0.32, 0, 0.12], 'foreArm.L': [0.95, 0, 0.1], 'foreArm.R': [0.95, 0, -0.1] },
  typing: { ...SEATED, spine: [-0.06, 0, 0], chest: [-0.02, 0, 0], head: [-0.16, 0, 0], 'upperArm.L': [0.42, 0, -0.16], 'upperArm.R': [0.42, 0, 0.16], 'foreArm.L': [1.25, 0, 0.32], 'foreArm.R': [1.25, 0, -0.32], 'hand.L': [-0.2, 0, 0], 'hand.R': [-0.2, 0, 0] },
  reading: { ...SEATED, spine: [-0.04, 0, 0], chest: [-0.03, 0, 0], head: [-0.26, 0.05, 0], 'upperArm.L': [0.3, 0, -0.1], 'upperArm.R': [0.48, 0, 0.12], 'foreArm.L': [0.95, 0, 0.12], 'foreArm.R': [1.2, 0, -0.25], 'hand.R': [-0.15, 0, 0] },
  waiting: { ...SEATED, spine: [0.02, 0, 0], head: [0.0, 0.18, 0], 'upperArm.L': [0.28, 0, -0.1], 'upperArm.R': [0.28, 0, 0.1], 'foreArm.L': [1.0, 0, 0.25], 'foreArm.R': [1.0, 0, -0.25] },
  blocked: { ...SEATED, spine: [-0.08, 0, 0], chest: [-0.04, 0, 0], head: [-0.2, 0, 0.04], 'upperArm.L': [0.36, 0, -0.14], 'upperArm.R': [0.72, 0, 0.32], 'foreArm.L': [1.1, 0, 0.25], 'foreArm.R': [2.25, 0, -0.35], 'hand.R': [0.4, 0, 0] },
  sitback: { ...SEATED, hipsZ: 0.1, spine: [0.16, 0, 0], chest: [0.08, 0, 0], head: [0.1, 0, 0], 'upperArm.L': [0.1, 0, -0.18], 'upperArm.R': [0.1, 0, 0.18], 'foreArm.L': [0.6, 0, 0.1], 'foreArm.R': [0.6, 0, -0.1] },
  lookUp: { ...SEATED, spine: [0.04, 0, 0], chest: [0.02, 0, 0], head: [0.22, 0, 0], 'upperArm.L': [0.38, 0, -0.14], 'upperArm.R': [0.38, 0, 0.14], 'foreArm.L': [1.15, 0, 0.3], 'foreArm.R': [1.15, 0, -0.3] },
  stand: { hipsY: 0, 'upperArm.L': [0.04, 0, -0.06], 'upperArm.R': [0.04, 0, 0.06], 'foreArm.L': [0.12, 0, 0], 'foreArm.R': [0.12, 0, 0] },
  phone: { hipsY: 0, head: [-0.42, 0, 0], neck: [-0.1, 0, 0], 'upperArm.L': [0.25, 0, -0.1], 'upperArm.R': [0.32, 0, 0.12], 'foreArm.L': [1.2, 0, 0.35], 'foreArm.R': [1.35, 0, -0.45] },
  review: { hipsY: 0, head: [0.1, 0.1, 0], 'upperArm.L': [0.04, 0, -0.08], 'upperArm.R': [0.8, 0, 0.1], 'foreArm.R': [0.9, 0, -0.2], 'foreArm.L': [0.4, 0, 0.3] },
};
// Clips: [pose, breathing amplitude, head drift, typing hands, loop seconds].
const CLIPS = {
  relaxed: ['relaxed', 0.018, 0.1, 0, 8], typing: ['typing', 0.012, 0.03, 1, 2.4], reading: ['reading', 0.014, 0.05, 0.35, 6],
  waiting: ['waiting', 0.016, 0.14, 0, 9], blocked: ['blocked', 0.012, 0.03, 0, 7], sitback: ['sitback', 0.02, 0.06, 0, 6],
  lookUp: ['lookUp', 0.015, 0.05, 0, 7], stand: ['stand', 0.016, 0.1, 0, 8], phone: ['phone', 0.014, 0.03, 0.4, 3], review: ['review', 0.015, 0.12, 0, 7],
};

function quaternionOf([x, y, z]) { return new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ')); }

export function buildClips() {
  const clips = {};
  for (const [name, [poseName, breath, drift, hands, seconds]] of Object.entries(CLIPS)) {
    const pose = POSES[poseName];
    const times = [0, 0.25, 0.5, 0.75, 1].map((t) => t * seconds);
    const tracks = [];
    for (const [bone] of BONES) {
      const base = pose[bone] || [0, 0, 0];
      const values = [];
      times.forEach((time, index) => {
        const phase = (index / 4) * Math.PI * 2;
        let [x, y, z] = base;
        if (bone === 'chest') x += Math.sin(phase) * breath;
        if (bone === 'spine') x += Math.sin(phase) * breath * 0.4;
        if (bone === 'head') { y += Math.sin(phase) * drift; x += Math.cos(phase * 2) * drift * 0.2; }
        if (hands && (bone === 'foreArm.L' || bone === 'foreArm.R')) x += Math.sin(phase * 2 + (bone.endsWith('L') ? 0 : Math.PI)) * 0.03 * hands;
        if (hands && (bone === 'hand.L' || bone === 'hand.R')) x += Math.sin(phase * 4 + (bone.endsWith('L') ? 0 : 1.3)) * 0.06 * hands;
        values.push(...quaternionOf([x, y, z]).toArray());
      });
      tracks.push(new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, values));
    }
    const [bx, by, bz] = BONE_WORLD.hips;
    tracks.push(new THREE.VectorKeyframeTrack('hips.position', [0, seconds], [bx, by + (pose.hipsY || 0), bz + (pose.hipsZ || 0), bx, by + (pose.hipsY || 0), bz + (pose.hipsZ || 0)]));
    clips[name] = new THREE.AnimationClip(name, seconds, tracks);
  }
  clips.walk = walkClip();
  return clips;
}

function walkClip() {
  const seconds = 1.1; const steps = 8;
  const times = Array.from({ length: steps + 1 }, (_, index) => (index / steps) * seconds);
  const track = (bone, fn) => new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, times.flatMap((time) => quaternionOf(fn((time / seconds) * Math.PI * 2)).toArray()));
  const tracks = [
    track('thigh.L', (p) => [Math.sin(p) * 0.38, 0, 0]), track('thigh.R', (p) => [-Math.sin(p) * 0.38, 0, 0]),
    track('shin.L', (p) => [-Math.max(0, Math.sin(p + 1.2)) * 0.6, 0, 0]), track('shin.R', (p) => [-Math.max(0, -Math.sin(p + 1.2)) * 0.6, 0, 0]),
    track('upperArm.L', (p) => [-Math.sin(p) * 0.28, 0, -0.06]), track('upperArm.R', (p) => [Math.sin(p) * 0.28, 0, 0.06]),
    track('foreArm.L', (p) => [0.25 - Math.sin(p) * 0.1, 0, 0]), track('foreArm.R', (p) => [0.25 + Math.sin(p) * 0.1, 0, 0]),
    track('spine', (p) => [-0.03, Math.sin(p) * 0.06, 0]), track('chest', (p) => [0, -Math.sin(p) * 0.08, 0]),
  ];
  const [bx, by, bz] = BONE_WORLD.hips;
  tracks.push(new THREE.VectorKeyframeTrack('hips.position', times, times.flatMap((time) => [bx, by + Math.abs(Math.cos((time / seconds) * Math.PI * 2)) * 0.025 - 0.02, bz])));
  return new THREE.AnimationClip('walk', seconds, tracks);
}

// ------------------------------------------------------------------ people
export function createPeople({ tier, reducedMotion }) {
  // Matte and double-sided: cloth drapes (ghutra, shayla) are open surfaces.
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0, side: THREE.DoubleSide });
  const clips = buildClips();
  const people = new Map();
  const detail = tier === 'light' ? 'low' : 'high';

  const create = (key) => {
    const geometry = buildPersonGeometry(key, detail);
    const bones = BONES.map(([name, , position]) => { const bone = new THREE.Bone(); bone.name = name; bone.position.set(...position); return bone; });
    BONES.forEach(([name, parent], index) => {
      if (!parent) return;
      const parentBone = bones[BONE_INDEX[parent]];
      parentBone.add(bones[index]);
      bones[index].position.sub(new THREE.Vector3(...BONE_WORLD[parent]));
    });
    const mesh = new THREE.SkinnedMesh(geometry, material);
    mesh.add(bones[0]);
    mesh.updateMatrixWorld(true); // the bind pose needs current bone matrices
    mesh.bind(new THREE.Skeleton(bones));
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
    mesh.name = `person:${key}`;
    const root = new THREE.Group(); root.add(mesh); root.name = `person-root:${key}`;
    const mixer = new THREE.AnimationMixer(mesh);
    const actions = Object.fromEntries(Object.entries(clips).map(([name, clip]) => [name, mixer.clipAction(clip)]));
    const person = { key, root, mesh, mixer, actions, clip: null, lod: 0, accumulator: 0, seed: (key.length * 1.37) % 5 };
    play(person, 'relaxed', true);
    people.set(key, person);
    return person;
  };

  // Cross-fades to a clip over 300 ms (instantly with reduced motion).
  const play = (person, name, instant = false) => {
    if (!person.actions[name] || person.clip === name) return;
    const next = person.actions[name];
    next.reset(); next.enabled = true; next.setEffectiveWeight(1); next.time = person.seed % next.getClip().duration;
    next.play();
    const previous = person.clip ? person.actions[person.clip] : null;
    if (previous && !instant && !reducedMotion) previous.crossFadeTo(next, BLEND_SECONDS, false);
    else if (previous) previous.stop();
    person.clip = name;
    if (reducedMotion) { next.paused = false; person.mixer.update(0.001); next.paused = true; }
  };

  // LOD: under 15 m full rate; 15–40 m a third of the rate; beyond, frozen.
  const tick = (delta, distances = new Map()) => {
    if (reducedMotion) return false;
    let moved = false;
    for (const person of people.values()) {
      if (!person.root.visible) continue;
      const distance = distances.get(person.key) ?? 20;
      person.lod = distance < 15 ? 0 : distance < 40 ? 1 : 2;
      if (person.lod === 2) continue;
      person.accumulator += delta;
      const step = person.lod === 0 ? 0 : 0.1;
      if (person.accumulator < step) continue;
      person.mixer.update(person.accumulator); person.accumulator = 0; moved = true;
    }
    return moved;
  };

  return {
    people, create, play, tick, clips,
    dispose() { for (const person of people.values()) { person.mixer.stopAllAction(); person.mesh.geometry.dispose(); person.mesh.skeleton.dispose(); } material.dispose(); },
  };
}
