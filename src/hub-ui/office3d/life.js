// Ambient life (Final Design Spec §06): "Colour means truth. Motion without
// colour is ambience." Breathing, head turns and chair swivel live in the
// clips; this module adds the rest of the ambient set — at most two walkers,
// coffee steam at the Commons and passing cloud shadows. Ambient motion is
// neutral (never coloured), never implies work, only involves employees who
// are really available, and stops entirely with reduced motion.
import * as THREE from '../vendor/three.js?v=__UI_VERSION__';
import { PROMENADE, ZONES, floorHeight, seatPoint } from './plan.js?v=__UI_VERSION__';
import { measure, pointAt } from './routes.js?v=__UI_VERSION__';

export const WALKERS = Object.freeze({ max: 2, speed: 1.15, everySeconds: 75, pauseSeconds: 8 });
const COFFEE = [-8.75, 12.3];

// A walk from an employee's chair to the coffee bar and back, along the
// Promenade like everyone else (pure; tested in Node).
export function walkPath(key) {
  const zone = ZONES[key];
  if (!zone || key === 'chief') return null;
  const seat = seatPoint(key); const threshold = zone.threshold;
  const start = Math.atan2(threshold[0], threshold[1]); const end = Math.atan2(-3.2, 7.4);
  let delta = ((end - start) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
  const steps = Math.max(2, Math.ceil(Math.abs(delta) * PROMENADE.outer / 0.6));
  const ring = Array.from({ length: steps + 1 }, (_, index) => { const a = start + (delta * index) / steps; return [Math.sin(a) * (PROMENADE.outer + 0.35), Math.cos(a) * (PROMENADE.outer + 0.35)]; });
  const out = [seat, threshold, ...ring, [-3.2, 8.6], [COFFEE[0] + 0.75, COFFEE[1]]];
  return out.map(([x, z]) => [Math.round(x * 1000) / 1000, Math.round(z * 1000) / 1000]);
}

// Who may walk now: available, enabled, not CHIEF, not standing staff.
export function walkerCandidates(state) {
  return (state?.employees || []).filter((employee) => employee.state === 'AVAILABLE' && employee.enabled !== false && !['chief', 'social'].includes(employee.key)).map((employee) => employee.key);
}

export function createLife({ scene, crew, desks, reducedMotion = false, tier = 'balanced' }) {
  const group = new THREE.Group(); group.name = 'life';
  scene.add(group);
  const walks = new Map(); // key → { path, distances, length, start, phase }
  let nextAt = performance.now() + 20_000;
  let seed = 7;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

  // Coffee steam: two soft, slowly rising wisps over the espresso machine.
  const steamMaterial = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uLevel: { value: reducedMotion ? 0 : 1 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform float uTime; uniform float uLevel; varying vec2 vUv;
      void main() {
        float x = vUv.x - 0.5 + sin(vUv.y * 7.0 - uTime * 1.3) * 0.12 * vUv.y;
        float wisp = exp(-x * x * 60.0) * smoothstep(0.0, 0.15, vUv.y) * (1.0 - vUv.y);
        float flow = 0.6 + 0.4 * sin(vUv.y * 14.0 - uTime * 2.2);
        gl_FragColor = vec4(vec3(1.0), wisp * flow * 0.32 * uLevel);
      }`,
  });
  const steam = new THREE.Group();
  for (const offset of [-0.05, 0.06]) { const plane = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.5), steamMaterial); plane.position.set(COFFEE[0] + offset, 1.62, 11.6); plane.rotation.y = Math.PI / 2 + offset * 6; steam.add(plane); }
  group.add(steam);

  const startWalk = (key, now) => {
    const desk = desks.get(key); const person = desk?.person;
    const path = walkPath(key);
    if (!person || !path) return;
    const there = [...path]; const back = [...path].reverse();
    const full = [...there, ...back.slice(1)];
    const distances = measure(full);
    desk.walking = true;
    group.attach(person.root);
    walks.set(key, { key, person, desk, path: full, distances, length: distances.at(-1), start: now, pausedAt: there.length - 1 });
    crew.play(person, 'walk');
  };
  const endWalk = (walk) => {
    walk.desk.walking = false;
    walk.desk.station.chair.add(walk.person.root);
    walk.person.root.position.set(0, 0, 0.04); walk.person.root.rotation.set(0, 0, 0);
    walks.delete(walk.key);
  };

  const position = new THREE.Vector3();
  const tick = (now, state) => {
    if (reducedMotion) return false;
    steamMaterial.uniforms.uTime.value = now / 1000;
    const available = new Set(walkerCandidates(state));
    // Anyone whose real state changed goes straight back to the desk.
    for (const walk of [...walks.values()]) if (!available.has(walk.key)) endWalk(walk);
    if (now > nextAt && walks.size < WALKERS.max) {
      const free = [...available].filter((key) => !walks.has(key));
      if (free.length) startWalk(free[Math.floor(random() * free.length)], now);
      nextAt = now + (WALKERS.everySeconds * (0.6 + random() * 0.8)) * 1000;
    }
    for (const walk of [...walks.values()]) {
      const seconds = (now - walk.start) / 1000;
      const halfway = walk.distances[walk.pausedAt];
      const travelled = seconds * WALKERS.speed;
      // Walk out, pause at the coffee bar, walk back.
      let s = travelled;
      if (travelled > halfway) s = travelled < halfway + WALKERS.pauseSeconds * WALKERS.speed ? halfway : travelled - WALKERS.pauseSeconds * WALKERS.speed;
      const pausing = travelled > halfway && s === halfway;
      if (s >= walk.length) { endWalk(walk); continue; }
      const [x, z] = pointAt(walk.path, walk.distances, s);
      const [ax, az] = pointAt(walk.path, walk.distances, Math.min(walk.length, s + 0.3));
      walk.person.root.position.set(x, floorHeight(x, z), z);
      if (!pausing) walk.person.root.rotation.set(0, Math.atan2(-(ax - x), -(az - z)), 0);
      crew.play(walk.person, pausing ? 'stand' : 'walk');
      walk.person.root.getWorldPosition(position);
    }
    return walks.size > 0;
  };

  return {
    group, tick, walking: (key) => walks.has(key),
    dispose() { for (const walk of [...walks.values()]) endWalk(walk); steam.children.forEach((plane) => plane.geometry.dispose()); steamMaterial.dispose(); scene.remove(group); },
  };
}

// Passing cloud shadows (day only): the sun dims by up to 12 % as a cloud
// crosses, a few times a minute. Pure; the scene multiplies the sun by it.
export function cloudShade(seconds) {
  const passing = Math.max(0, Math.sin(seconds * 0.11) * Math.sin(seconds * 0.037 + 1.3));
  return 1 - 0.12 * passing * passing;
}
