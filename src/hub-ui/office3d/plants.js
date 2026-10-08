// Planting and décor (Final Design Spec §01): olive trees, Ficus,
// Zamioculcas and Strelitzia in microcement and bronze planters. Leaves are
// instanced, alpha-masked cards with a folded midrib (no faceted blobs),
// one draw call per species. A gentle sway is ambient (neutral) motion and
// stops with reduced motion.
import * as THREE from '../vendor/three.js?v=__UI_VERSION__';
import { PLANTS } from './plan.js?v=__UI_VERSION__';
import { createBuilder } from './builder.js?v=__UI_VERSION__';

const SPECIES = {
  olive: { atlas: 0, leaf: [0.075, 0.016], colors: ['#7f8d6c', '#8e9b7c', '#6f7d5f', '#9aa58a'], planter: { r: 0.62, h: 0.62, material: 'microcement' } },
  ficus: { atlas: 1, leaf: [0.32, 0.24], colors: ['#3f5b34', '#4a6a3c', '#36502e'], planter: { r: 0.32, h: 0.5, material: 'microcement' } },
  zamioculcas: { atlas: 2, leaf: [0.09, 0.04], colors: ['#2f4a2a', '#3a5733', '#294226'], planter: { r: 0.22, h: 0.34, material: 'ceramicDark' } },
  strelitzia: { atlas: 3, leaf: [0.7, 0.24], colors: ['#46633f', '#3c5636', '#527047'], planter: { r: 0.34, h: 0.52, material: 'bronze' } },
};

export function buildPlants({ materials, tier, reducedMotion }) {
  const root = new THREE.Group(); root.name = 'plants';
  const b = createBuilder(materials);
  const leaves = new Map(Object.keys(SPECIES).map((name) => [name, []]));
  const trunks = [];
  let seed = 4242;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const density = tier === 'light' ? 0.5 : 1;
  const addLeaf = (species, position, normalish, scale = 1) => {
    // Orientation: the leaf's length points along `normalish` with a random roll.
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normalish.clone().normalize());
    quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), random() * Math.PI * 2));
    const [w, l] = [SPECIES[species].leaf[1], SPECIES[species].leaf[0]];
    const s = scale * (0.8 + random() * 0.4);
    const matrix = new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(w * s, l * s, w * s));
    const colors = SPECIES[species].colors;
    leaves.get(species).push({ matrix, color: colors[Math.floor(random() * colors.length)] });
  };

  for (const [species, x, z] of PLANTS) {
    const spec = SPECIES[species];
    const { r, h, material } = spec.planter;
    b.lathe([[0, 0], [r * 0.92, 0], [r, h * 0.12], [r, h], [r * 0.94, h], [r * 0.94, h * 0.92], [0, h * 0.92]], material, { x, y: 0, z, segments: 40 });
    b.cylinder(r * 0.93, r * 0.93, 0.02, 'soil', { x, y: h * 0.9, z, segments: 32, cast: false });
    const top = h * 0.9;
    if (species === 'olive') {
      // A gnarled trunk of two or three leaders, then a loose silvery canopy.
      const leaders = 3;
      for (let index = 0; index < leaders; index += 1) {
        const angle = (index / leaders) * Math.PI * 2 + random();
        const lean = 0.35 + random() * 0.3;
        const points = [new THREE.Vector3(x, top, z)];
        for (let step = 1; step <= 4; step += 1) {
          const t = step / 4;
          points.push(new THREE.Vector3(x + Math.cos(angle) * lean * t + (random() - 0.5) * 0.12, top + t * (1.9 + random() * 0.4), z + Math.sin(angle) * lean * t + (random() - 0.5) * 0.12));
        }
        trunks.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 16, 0.06 - index * 0.008, 7, false));
        const crown = points.at(-1);
        const count = Math.round(520 * density);
        for (let leaf = 0; leaf < count; leaf += 1) {
          const u = random() * Math.PI * 2; const v = Math.acos(2 * random() - 1); const radius = 0.25 + random() * 0.65;
          const offset = new THREE.Vector3(Math.sin(v) * Math.cos(u) * radius, Math.cos(v) * radius * 0.55 + 0.1, Math.sin(v) * Math.sin(u) * radius);
          addLeaf('olive', crown.clone().add(offset), offset.clone().add(new THREE.Vector3(0, 0.4, 0)), 1);
        }
      }
    } else if (species === 'ficus') {
      const points = [new THREE.Vector3(x, top, z), new THREE.Vector3(x + 0.03, top + 0.7, z - 0.02), new THREE.Vector3(x - 0.02, top + 1.5, z + 0.03)];
      trunks.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 10, 0.025, 6, false));
      const count = Math.round(70 * density);
      for (let leaf = 0; leaf < count; leaf += 1) {
        const height = top + 0.35 + (leaf / count) * 1.3;
        const angle = leaf * 2.4;
        const out = new THREE.Vector3(Math.cos(angle), 0.6 + random() * 0.5, Math.sin(angle));
        addLeaf('ficus', new THREE.Vector3(x + Math.cos(angle) * 0.14, height, z + Math.sin(angle) * 0.14), out, 1 - (leaf / count) * 0.3);
      }
    } else if (species === 'zamioculcas') {
      for (let stem = 0; stem < 11; stem += 1) {
        const angle = stem * 0.57 * Math.PI; const lean = 0.25 + random() * 0.2; const tall = 0.45 + random() * 0.35;
        for (let leaf = 0; leaf < 12; leaf += 1) {
          const t = 0.25 + (leaf / 12) * 0.75;
          const base = new THREE.Vector3(x + Math.cos(angle) * lean * t, top + tall * t, z + Math.sin(angle) * lean * t);
          for (const side of [-1, 1]) addLeaf('zamioculcas', base, new THREE.Vector3(Math.cos(angle + side * 1.2), 0.5, Math.sin(angle + side * 1.2)), 1 - t * 0.3);
        }
      }
    } else if (species === 'strelitzia') {
      for (let stem = 0; stem < 9; stem += 1) {
        const angle = stem * 0.7 * Math.PI + random(); const lean = 0.08 + random() * 0.18; const tall = 0.8 + random() * 0.6;
        const base = new THREE.Vector3(x, top, z); const tip = new THREE.Vector3(x + Math.cos(angle) * lean, top + tall, z + Math.sin(angle) * lean);
        trunks.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([base, base.clone().lerp(tip, 0.5).add(new THREE.Vector3(0, 0.05, 0)), tip]), 6, 0.012, 5, false));
        addLeaf('strelitzia', tip.clone().add(new THREE.Vector3(Math.cos(angle) * 0.05, 0.3, Math.sin(angle) * 0.05)), new THREE.Vector3(Math.cos(angle) * 0.3, 1, Math.sin(angle) * 0.3), 1);
      }
    }
  }

  // Trunks and stems: one merged mesh.
  if (trunks.length) {
    const merged = THREE.mergeGeometries(trunks.map((geometry) => geometry.toNonIndexed()));
    for (const geometry of trunks) geometry.dispose();
    const mesh = new THREE.Mesh(merged, materials.get('bark'));
    mesh.castShadow = true; mesh.receiveShadow = true; root.add(mesh);
  }

  // Leaves: one instanced mesh per species, alpha-masked from a leaf atlas.
  const atlas = leafAtlas();
  const uniforms = { uTime: { value: 0 } };
  const meshes = [];
  for (const [species, list] of leaves) {
    if (!list.length) continue;
    const geometry = leafCard(SPECIES[species].atlas);
    const material = new THREE.MeshStandardMaterial({ map: atlas, alphaTest: 0.5, side: THREE.DoubleSide, roughness: species === 'zamioculcas' ? 0.35 : 0.7, color: '#ffffff' });
    if (!reducedMotion) material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uniforms.uTime;
      shader.vertexShader = `uniform float uTime;\n${shader.vertexShader}`.replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 anchor = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float sway = sin(uTime * 0.9 + anchor.x * 1.7 + anchor.z * 1.3) * 0.015 * position.y;
          transformed.x += sway; transformed.z += sway * 0.6;
        #endif`);
    };
    const mesh = new THREE.InstancedMesh(geometry, material, list.length);
    list.forEach((leaf, index) => { mesh.setMatrixAt(index, leaf.matrix); mesh.setColorAt(index, new THREE.Color(leaf.color)); });
    mesh.castShadow = tier !== 'light'; mesh.receiveShadow = true; mesh.name = `leaves:${species}`;
    root.add(mesh); meshes.push(mesh);
  }
  b.build(root); b.dispose();
  return {
    root,
    tick(seconds) { uniforms.uTime.value = seconds; },
    dispose() { root.traverse((node) => { if (node.isMesh) { node.geometry?.dispose(); if (node.material?.map === atlas) node.material.dispose(); } }); atlas.dispose(); },
  };
}

// A leaf card: unit width/length along +y, folded along the midrib, mapped to
// one quadrant of the atlas.
function leafCard(quadrant) {
  const [u0, v0] = [(quadrant % 2) * 0.5, Math.floor(quadrant / 2) * 0.5];
  const fold = 0.18;
  const positions = [-0.5, 0, fold, 0, 0, 0, 0.5, 0, fold, -0.5, 1, fold, 0, 1, 0, 0.5, 1, fold];
  const uvs = [u0, v0, u0 + 0.25, v0, u0 + 0.5, v0, u0, v0 + 0.5, u0 + 0.25, v0 + 0.5, u0 + 0.5, v0 + 0.5];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex([0, 1, 3, 1, 4, 3, 1, 2, 4, 2, 5, 4]);
  geometry.computeVertexNormals();
  return geometry;
}

// Four leaf silhouettes with veins: olive, fiddle-leaf, zamioculcas, strelitzia.
function leafAtlas() {
  const size = 512; const half = size / 2;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  const draw = (quadrant, outline, veins) => {
    const ox = (quadrant % 2) * half; const oy = (1 - Math.floor(quadrant / 2)) * half;
    g.save(); g.translate(ox, oy); g.beginPath(); outline(g); g.closePath();
    const gradient = g.createLinearGradient(0, half, 0, 0); gradient.addColorStop(0, '#b9bdb0'); gradient.addColorStop(1, '#e8ebe0');
    g.fillStyle = gradient; g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 2; g.beginPath(); g.moveTo(half / 2, half); g.lineTo(half / 2, 4); g.stroke();
    veins?.(g); g.restore();
  };
  const lanceolate = (width) => (ctx) => { ctx.moveTo(half / 2, half); ctx.bezierCurveTo(half / 2 + width, half * 0.7, half / 2 + width, half * 0.3, half / 2, 2); ctx.bezierCurveTo(half / 2 - width, half * 0.3, half / 2 - width, half * 0.7, half / 2, half); };
  draw(0, lanceolate(half * 0.22));
  draw(1, (ctx) => { ctx.moveTo(half / 2, half); ctx.bezierCurveTo(half * 0.95, half * 0.85, half * 0.75, half * 0.45, half * 0.92, half * 0.22); ctx.bezierCurveTo(half * 0.95, 0, half * 0.05, 0, half * 0.08, half * 0.22); ctx.bezierCurveTo(half * 0.25, half * 0.45, half * 0.05, half * 0.85, half / 2, half); },
    (ctx) => { ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1.5; for (let i = 1; i < 6; i += 1) { const y = half - i * half * 0.15; ctx.beginPath(); ctx.moveTo(half / 2, y); ctx.lineTo(half * 0.85, y - 30); ctx.moveTo(half / 2, y); ctx.lineTo(half * 0.15, y - 30); ctx.stroke(); } });
  draw(2, lanceolate(half * 0.3));
  draw(3, (ctx) => { ctx.moveTo(half / 2, half); ctx.bezierCurveTo(half * 0.98, half * 0.8, half * 0.98, half * 0.15, half / 2, 2); ctx.bezierCurveTo(half * 0.02, half * 0.15, half * 0.02, half * 0.8, half / 2, half); },
    (ctx) => { ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1; for (let i = 1; i < 14; i += 1) { const y = half - i * half * 0.065; ctx.beginPath(); ctx.moveTo(half / 2, y); ctx.lineTo(half * 0.9, y - 22); ctx.moveTo(half / 2, y); ctx.lineTo(half * 0.1, y - 22); ctx.stroke(); } });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4;
  return texture;
}
