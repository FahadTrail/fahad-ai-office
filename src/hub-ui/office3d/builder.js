// Static geometry, gathered in world space and merged per material: the
// whole building costs one draw call per finish. Bevelled boxes (light
// catches real edges), metre-scaled UVs, shadow flags per bucket.
import * as THREE from '../vendor/three.js?v=__UI_VERSION__';
import { metreUVs } from './materials.js?v=__UI_VERSION__';

const UP = new THREE.Vector3(0, 1, 0);

export function createBuilder(materials) {
  const buckets = new Map(); // key → { material, geometries: [], cast, receive }
  const geometryCache = new Map();
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scaleVector = new THREE.Vector3(1, 1, 1);
  const position = new THREE.Vector3();

  const bucketFor = (name, { cast = true, receive = true } = {}) => {
    const key = `${name}|${cast}|${receive}`;
    if (!buckets.has(key)) buckets.set(key, { material: materials.get(name), geometries: [], cast, receive });
    return buckets.get(key);
  };

  // Adds a geometry (local space) transformed to world space.
  const add = (geometry, name, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1, parent = null, cast = true, receive = true } = {}) => {
    euler.set(rx, ry, rz, 'YXZ');
    quaternion.setFromEuler(euler);
    matrix.compose(position.set(x, y, z), quaternion, scaleVector.set(sx, sy, sz));
    if (parent) matrix.premultiply(parent);
    const placed = (geometry.index ? geometry.toNonIndexed() : geometry.clone()).applyMatrix4(matrix);
    for (const name of Object.keys(placed.attributes)) if (!['position', 'normal', 'uv'].includes(name)) placed.deleteAttribute(name);
    bucketFor(name, { cast, receive }).geometries.push(placed);
    return placed;
  };

  const shared = (key, make) => { if (!geometryCache.has(key)) geometryCache.set(key, make()); return geometryCache.get(key); };

  // A box with softly rounded edges (radius in metres; 0 = sharp).
  const box = (w, h, d, name, options = {}) => {
    const radius = Math.min(options.radius ?? 0.006, w / 2.01, h / 2.01, d / 2.01);
    const geometry = shared(`box:${w}:${h}:${d}:${radius}`, () => (radius > 0.0005 ? new THREE.RoundedBoxGeometry(w, h, d, 2, radius) : new THREE.BoxGeometry(w, h, d)));
    return add(geometry, name, options);
  };
  const cylinder = (rTop, rBottom, h, name, options = {}) => {
    const segments = options.segments || 24;
    const geometry = shared(`cyl:${rTop}:${rBottom}:${h}:${segments}:${options.open || false}`, () => new THREE.CylinderGeometry(rTop, rBottom, h, segments, 1, options.open || false));
    return add(geometry, name, options);
  };
  // A horizontal slab from an outline (x, z) with a thickness, top at y.
  const slab = (points, thickness, name, { y = 0, holes = [], ...options } = {}) => {
    const shape = new THREE.Shape(points.map(([px, pz]) => new THREE.Vector2(px, -pz)));
    for (const hole of holes) shape.holes.push(new THREE.Path(hole.map(([px, pz]) => new THREE.Vector2(px, -pz))));
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 48 });
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, y - thickness, 0);
    add(geometry, name, options);
    geometry.dispose();
  };
  // A lathe (vases, planters, pedestal bases): profile points [r, y].
  const lathe = (profile, name, options = {}) => {
    const geometry = shared(`lathe:${JSON.stringify(profile)}:${options.segments || 32}`, () => new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), options.segments || 32));
    return add(geometry, name, options);
  };

  // Merges every bucket into one mesh per material under a parent group.
  const build = (parent, { uv = 'metres' } = {}) => {
    const meshes = [];
    for (const bucket of buckets.values()) {
      if (!bucket.geometries.length) continue;
      if (uv === 'metres' && bucket.material.userData.finish) for (const geometry of bucket.geometries) metreUVs(geometry);
      const merged = THREE.mergeGeometries(bucket.geometries, false);
      for (const geometry of bucket.geometries) geometry.dispose();
      bucket.geometries.length = 0;
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, bucket.material);
      mesh.castShadow = bucket.cast; mesh.receiveShadow = bucket.receive;
      mesh.matrixAutoUpdate = false; mesh.updateMatrix();
      if (bucket.material.transparent) mesh.renderOrder = 2;
      parent.add(mesh);
      meshes.push(mesh);
    }
    buckets.clear();
    return meshes;
  };

  const dispose = () => { for (const geometry of geometryCache.values()) geometry.dispose(); geometryCache.clear(); };
  return { add, box, cylinder, slab, lathe, build, dispose, shared, UP };
}

// A thin strip following a polyline on the floor (the brass inlay): flat
// quads, width in metres, y the floor height function.
export function stripGeometry(points, width, heightAt = () => 0, lift = 0.0015) {
  const positions = []; const normals = []; const uvs = []; const along = [];
  let distance = 0;
  for (let index = 0; index < points.length; index += 1) {
    const prev = points[Math.max(0, index - 1)]; const next = points[Math.min(points.length - 1, index + 1)];
    const dx = next[0] - prev[0]; const dz = next[1] - prev[1];
    const length = Math.hypot(dx, dz) || 1;
    const [ox, oz] = [(-dz / length) * width / 2, (dx / length) * width / 2];
    if (index > 0) distance += Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]);
    const y = heightAt(points[index][0], points[index][1]) + lift;
    positions.push(points[index][0] + ox, y, points[index][1] + oz, points[index][0] - ox, y, points[index][1] - oz);
    normals.push(0, 1, 0, 0, 1, 0);
    uvs.push(distance, 0, distance, 1);
    along.push(distance, distance);
  }
  const index = [];
  for (let i = 0; i < points.length - 1; i += 1) { const a = i * 2; index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('along', new THREE.Float32BufferAttribute(along, 1));
  geometry.setIndex(index);
  geometry.userData.length = distance;
  return geometry;
}
