// Baked floor light (Final Design Spec §14: "Day and night lightmap sets. The
// sun is the only dynamic shadow."). Drawn once from the plan when the Office
// mounts: a day set of ambient occlusion (soft contact shadows under every
// piece of furniture, along walls, columns and planters) and a night set of
// light pools (the coves along the façades, the Forum's step lights, the desk
// underlights and the Promenade's floor washes). Each set is one floor
// overlay, so it costs one draw call and no real light.
import * as THREE from '../vendor/three.js?v=__UI_VERSION__';
import { COLUMNS, COLUMN_RADIUS, FORUM, GLASS, OFFICE, PLANTS, PROMENADE, ZONES } from './plan.js?v=__UI_VERSION__';

const PIXELS_PER_METRE = { high: 40, balanced: 28, light: 18 };

export function bakeFloor({ footprints = [], tier = 'balanced' }) {
  const scale = PIXELS_PER_METRE[tier] || 28;
  const width = Math.round(OFFICE.width * scale); const height = Math.round(OFFICE.depth * scale);
  const toCanvas = (x, z) => [(x - OFFICE.minX) * scale, (z - OFFICE.minZ) * scale];

  // ------------------------------------------------------------ day: ambient occlusion
  const ao = document.createElement('canvas'); ao.width = width; ao.height = height;
  const g = ao.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, width, height);
  const blob = (x, z, w, d, yaw, strength, soften = 0.35) => {
    const [cx, cz] = toCanvas(x, z);
    g.save(); g.translate(cx, cz); g.rotate(-yaw);
    const rx = (w / 2) * scale * (1 + soften); const rz = (d / 2) * scale * (1 + soften);
    g.scale(1, rz / rx);
    const gradient = g.createRadialGradient(0, 0, rx * 0.15, 0, 0, rx);
    gradient.addColorStop(0, `rgba(0,0,0,${strength})`); gradient.addColorStop(0.55, `rgba(0,0,0,${strength * 0.55})`); gradient.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gradient; g.beginPath(); g.arc(0, 0, rx, 0, Math.PI * 2); g.fill();
    g.restore();
  };
  for (const [x, z, w, d, yaw, strength] of footprints) blob(x, z, w, d, yaw, strength * 0.9);
  for (const [x, z] of COLUMNS) blob(x, z, COLUMN_RADIUS * 4.5, COLUMN_RADIUS * 4.5, 0, 0.42, 0.2);
  for (const [, x, z] of PLANTS) blob(x, z, 1.8, 1.8, 0, 0.4, 0.2);
  // Along the façades and glass: a gentle darkening where wall meets floor.
  const edge = (x1, z1, x2, z2, reach, strength) => {
    const [ax, az] = toCanvas(x1, z1); const [bx, bz] = toCanvas(x2, z2);
    g.save(); g.lineCap = 'round';
    for (let layer = 6; layer >= 1; layer -= 1) { g.strokeStyle = `rgba(0,0,0,${strength / 6})`; g.lineWidth = (reach * scale * layer) / 3; g.beginPath(); g.moveTo(ax, az); g.lineTo(bx, bz); g.stroke(); }
    g.restore();
  };
  edge(OFFICE.minX, OFFICE.minZ, OFFICE.maxX, OFFICE.minZ, 0.5, 0.35); edge(OFFICE.minX, OFFICE.maxZ, OFFICE.maxX, OFFICE.maxZ, 0.5, 0.35);
  edge(OFFICE.minX, OFFICE.minZ, OFFICE.minX, OFFICE.maxZ, 0.5, 0.35); edge(OFFICE.maxX, OFFICE.minZ, OFFICE.maxX, OFFICE.maxZ, 0.5, 0.35);
  for (const [x1, z1, x2, z2] of GLASS) edge(x1, z1, x2, z2, 0.18, 0.18);
  edge(-4.6, -7, 4.6, -7, 0.45, 0.35);

  // ------------------------------------------------------------ night: light pools
  const night = document.createElement('canvas'); night.width = width; night.height = height;
  const n = night.getContext('2d');
  n.fillStyle = '#000000'; n.fillRect(0, 0, width, height);
  const pool = (x, z, radius, color, alpha) => {
    const [cx, cz] = toCanvas(x, z);
    const gradient = n.createRadialGradient(cx, cz, 0, cx, cz, radius * scale);
    gradient.addColorStop(0, color.replace('A', String(alpha))); gradient.addColorStop(1, color.replace('A', '0'));
    n.fillStyle = gradient; n.fillRect(cx - radius * scale, cz - radius * scale, radius * scale * 2, radius * scale * 2);
  };
  const wash = (x1, z1, x2, z2, reach, color, alpha) => {
    const [ax, az] = toCanvas(x1, z1); const [bx, bz] = toCanvas(x2, z2);
    for (let layer = 8; layer >= 1; layer -= 1) { n.strokeStyle = color.replace('A', String(alpha / 8)); n.lineWidth = (reach * scale * layer) / 4; n.lineCap = 'round'; n.beginPath(); n.moveTo(ax, az); n.lineTo(bx, bz); n.stroke(); }
  };
  const warm = 'rgba(255,190,130,A)'; const soft = 'rgba(255,214,170,A)';
  // Coves along the façades (inside) and the clerestory base.
  wash(OFFICE.minX + 0.6, OFFICE.minZ + 0.6, OFFICE.maxX - 0.6, OFFICE.minZ + 0.6, 1.6, warm, 0.5); wash(OFFICE.minX + 0.6, OFFICE.maxZ - 0.6, OFFICE.maxX - 0.6, OFFICE.maxZ - 0.6, 1.6, warm, 0.5);
  wash(OFFICE.minX + 0.6, OFFICE.minZ + 0.6, OFFICE.minX + 0.6, OFFICE.maxZ - 0.6, 1.6, warm, 0.5); wash(OFFICE.maxX - 0.6, OFFICE.minZ + 0.6, OFFICE.maxX - 0.6, OFFICE.maxZ - 0.6, 1.6, warm, 0.5);
  // The Promenade's floor wash around the Forum.
  for (let index = 0; index < 24; index += 1) { const angle = (index / 24) * Math.PI * 2; pool(Math.sin(angle) * (PROMENADE.inlay + 0.4), Math.cos(angle) * (PROMENADE.inlay + 0.4), 1.6, soft, 0.22); }
  // Desk underlights and the department pools.
  for (const zone of Object.values(ZONES)) {
    const { x, z } = zone.desk;
    pool(x, z, 2.4, warm, 0.5);
    const [cx, cz] = zone.centre;
    if (zone.number !== '00') pool(cx, cz, 5, soft, 0.2);
  }
  for (const [, x, z] of PLANTS) pool(x, z, 1.4, soft, 0.28);

  const textures = [];
  const texture = (canvas) => { const made = new THREE.CanvasTexture(canvas); made.colorSpace = THREE.SRGBColorSpace; made.anisotropy = 4; textures.push(made); return made; };
  const aoTexture = texture(ao); const nightTexture = texture(night);

  // Overlays: the floor plane minus the Forum's opening, and the Forum floor.
  const group = new THREE.Group(); group.name = 'baked-floor';
  const plane = (y, uvOf) => {
    const shape = new THREE.Shape([[OFFICE.minX, OFFICE.minZ], [OFFICE.maxX, OFFICE.minZ], [OFFICE.maxX, OFFICE.maxZ], [OFFICE.minX, OFFICE.maxZ]].map(([x, z]) => new THREE.Vector2(x, -z)));
    shape.holes.push(new THREE.Path(Array.from({ length: 96 }, (_, index) => { const a = (index / 96) * Math.PI * 2; return new THREE.Vector2(Math.sin(a) * FORUM.radius, -Math.cos(a) * FORUM.radius); })));
    const geometry = new THREE.ShapeGeometry(shape, 48); geometry.rotateX(-Math.PI / 2); geometry.translate(0, y, 0);
    uvOf(geometry); return geometry;
  };
  const planUv = (geometry) => { const position = geometry.attributes.position; const uv = new Float32Array(position.count * 2); for (let index = 0; index < position.count; index += 1) { uv[index * 2] = (position.getX(index) - OFFICE.minX) / OFFICE.width; uv[index * 2 + 1] = 1 - (position.getZ(index) - OFFICE.minZ) / OFFICE.depth; } geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); };
  const forumDisc = (y) => { const geometry = new THREE.CircleGeometry(FORUM.radius - (FORUM.steps - 1) * FORUM.tread, 64); geometry.rotateX(-Math.PI / 2); geometry.translate(0, y, 0); planUv(geometry); return geometry; };
  const multiply = new THREE.MeshBasicMaterial({ map: aoTexture, transparent: true, blending: THREE.MultiplyBlending, premultipliedAlpha: true, depthWrite: false, toneMapped: false });
  const additive = new THREE.MeshBasicMaterial({ map: nightTexture, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, opacity: 0 });
  for (const material of [multiply, additive]) {
    for (const geometry of [plane(0.004, planUv), forumDisc(-FORUM.depth + 0.004)]) { const mesh = new THREE.Mesh(geometry, material); mesh.renderOrder = material === multiply ? 1 : 2; mesh.matrixAutoUpdate = false; mesh.updateMatrix(); group.add(mesh); }
  }
  return {
    group,
    // Night pools follow the artificial light level of the mode.
    setNight(level) { additive.opacity = level * 1.6; additive.visible = level > 0.01; },
    setAmbient(strength) { multiply.color.setScalar(1); multiply.opacity = strength; },
    dispose() { for (const made of textures) made.dispose(); multiply.dispose(); additive.dispose(); group.traverse((node) => node.geometry?.dispose()); },
  };
}
