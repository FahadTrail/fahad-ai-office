// Handoffs — light in the stone (Final Design Spec §07). Every pulse is a
// real handoff record; nothing moves without one.
//
//   Path     desk → spoke → Promenade → (Forum ring) → spoke → desk, along the inlay
//   Pulse    1.2 m comet at 4 m/s, trip 2.5–6 s; emissive 0.6 by day, 1.4 with bloom at night
//   Arrival  the destination lamp ramps over 400 ms; the employee turns; "From …" for 3 s
//   Fade     the tail fades over 1.2 s; an 8 % ember stays for 30 s
//   Lanes    at most 6 visible, 80 mm apart; more bundle as ×N at the destination
//   Blocked  a red dot held at the destination threshold, pulsing every 6 s
import * as THREE from '../vendor/three.js?v=__UI_VERSION__';
import { FORUM, PROMENADE, floorHeight } from './plan.js?v=__UI_VERSION__';
import { PULSE, afterglow, blockedHold, offsetPath, planPulses, routePath, tripSeconds } from './routes.js?v=__UI_VERSION__';
import { stripGeometry } from './builder.js?v=__UI_VERSION__';

const VERTEX = `
  attribute float along;
  varying float vAlong; varying float vAcross;
  void main() { vAlong = along; vAcross = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FRAGMENT = `
  uniform float uHead; uniform float uTail; uniform float uFade; uniform float uEmber; uniform float uIntensity; uniform vec3 uColor;
  varying float vAlong; varying float vAcross;
  void main() {
    float behind = uHead - vAlong;
    float comet = behind >= 0.0 && behind <= uTail ? pow(1.0 - behind / uTail, 2.0) : 0.0;
    float spark = exp(-pow(behind / 0.12, 2.0)) * step(-0.12, behind);
    float ember = vAlong <= uHead ? uEmber : 0.0;
    float across = exp(-pow(vAcross * 2.0 - 1.0, 2.0) * 5.0);
    float a = max(max(comet, spark) * uFade, ember) * across;
    if (a < 0.002) discard;
    gl_FragColor = vec4(uColor * uIntensity * a, a);
  }`;

export function createHandoffs({ reducedMotion = false } = {}) {
  const group = new THREE.Group(); group.name = 'handoffs';
  const pulses = new Map(); // id → { record, mesh, material, length, trip, start, arrivedAt }
  const history = new THREE.Group(); history.name = 'handoff-history'; history.visible = false;
  group.add(history);
  const seen = new Set();
  let intensity = PULSE.emissiveDay;
  const color = new THREE.Color('#ffd49a');
  const material = () => new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    uniforms: { uHead: { value: 0 }, uTail: { value: PULSE.length }, uFade: { value: 1 }, uEmber: { value: 0 }, uIntensity: { value: intensity }, uColor: { value: color } } });

  // The Forum ring sweep when CHIEF routes: once round in 1.2 s.
  const ringPoints = Array.from({ length: 129 }, (_, index) => { const a = (index / 128) * Math.PI * 2; return [Math.sin(a) * PROMENADE.forumInlay, Math.cos(a) * PROMENADE.forumInlay]; });
  const ringGeometry = stripGeometry(ringPoints, 0.24, floorHeight, 0.008);
  const ringMaterial = material(); ringMaterial.uniforms.uTail.value = 3.2;
  const ring = new THREE.Mesh(ringGeometry, ringMaterial); ring.visible = false; ring.renderOrder = 4;
  group.add(ring);
  let ringStart = 0;

  // Blocked holds: a red dot and a ring at the destination threshold.
  const holdMaterial = new THREE.MeshBasicMaterial({ color: '#e5484d', transparent: true, opacity: 0.9, toneMapped: false, depthWrite: false });
  const holds = new Map();

  const lanes = (handoffs) => planPulses(handoffs.filter((handoff) => handoff.fresh));

  // Starts pulses for real handoffs seen for the first time on this page.
  const update = (handoffs = [], now = performance.now()) => {
    const plan = lanes(handoffs);
    const wanted = new Set();
    for (const { handoff, offset } of plan.visible) {
      const id = `${handoff.id}@${handoff.at}`;
      wanted.add(id);
      if (pulses.has(id) || seen.has(id)) continue;
      seen.add(id);
      const path = routePath(handoff.fromKey, handoff.toKey);
      if (!path) continue;
      const geometry = stripGeometry(offsetPath(path, offset), 0.46, floorHeight, 0.008);
      const made = material();
      const mesh = new THREE.Mesh(geometry, made); mesh.renderOrder = 4; mesh.userData = { handoff };
      group.add(mesh);
      const length = geometry.userData.length;
      pulses.set(id, { handoff, mesh, material: made, length, trip: tripSeconds(length), start: now, arrivedAt: null, announced: false });
      if (handoff.fromKey === 'chief' || handoff.toKey === 'chief') ringStart = now;
    }
    // Blocked destinations hold a red dot (real blocked or failed handoffs only).
    const blockedNow = new Set();
    for (const handoff of handoffs) {
      const hold = blockedHold(handoff);
      if (!hold) continue;
      blockedNow.add(hold.key);
      if (holds.has(hold.key)) continue;
      const dot = new THREE.Mesh(new THREE.CircleGeometry(0.16, 32), holdMaterial);
      dot.rotation.x = -Math.PI / 2; dot.position.set(hold.point[0], floorHeight(...hold.point) + 0.012, hold.point[1]); dot.renderOrder = 5;
      const halo = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.27, 48), holdMaterial.clone());
      halo.rotation.x = -Math.PI / 2; halo.position.copy(dot.position); halo.renderOrder = 5;
      group.add(dot, halo);
      holds.set(hold.key, { dot, halo, start: now });
    }
    for (const [key, hold] of holds) if (!blockedNow.has(key)) { group.remove(hold.dot, hold.halo); hold.dot.geometry.dispose(); hold.halo.geometry.dispose(); hold.halo.material.dispose(); holds.delete(key); }
    return { bundles: plan.bundles };
  };

  // Advances every pulse; returns arrivals (for the lamp ramp, the turn and
  // the "From …" label) and whether anything still moves.
  const tick = (now = performance.now()) => {
    const arrivals = [];
    let animating = false;
    for (const [id, pulse] of pulses) {
      const elapsed = (now - pulse.start) / 1000;
      const uniforms = pulse.material.uniforms;
      uniforms.uIntensity.value = intensity;
      if (reducedMotion) {
        // No travelling light: the route holds its ember for 30 s.
        uniforms.uHead.value = pulse.length; uniforms.uFade.value = 0; uniforms.uEmber.value = elapsed < PULSE.emberSeconds ? 0.25 : 0;
        if (!pulse.announced) { pulse.announced = true; arrivals.push(pulse.handoff); }
      } else if (elapsed < pulse.trip) {
        uniforms.uHead.value = (elapsed / pulse.trip) * (pulse.length + PULSE.length * 0.2);
        uniforms.uFade.value = 1; uniforms.uEmber.value = 0;
        animating = true;
      } else {
        if (!pulse.announced) { pulse.announced = true; arrivals.push(pulse.handoff); }
        const since = elapsed - pulse.trip;
        const glow = afterglow(since);
        uniforms.uHead.value = pulse.length + PULSE.length;
        uniforms.uFade.value = since < PULSE.fade ? 1 - since / PULSE.fade : 0;
        uniforms.uEmber.value = Math.min(glow, PULSE.ember);
        animating = animating || since < PULSE.fade;
      }
      if (elapsed > pulse.trip + PULSE.emberSeconds) { group.remove(pulse.mesh); pulse.mesh.geometry.dispose(); pulse.material.dispose(); pulses.delete(id); }
    }
    // The Forum ring sweep (once, 1.2 s).
    const sweep = ringStart && !reducedMotion ? (now - ringStart) / 1200 : 2;
    ring.visible = sweep < 1.25;
    if (ring.visible) { ringMaterial.uniforms.uHead.value = sweep * ringGeometry.userData.length; ringMaterial.uniforms.uIntensity.value = intensity; animating = true; }
    // Blocked holds pulse every 6 s (one 1.2 s pulse, then steady).
    for (const hold of holds.values()) {
      const phase = ((now - hold.start) / 1000) % PULSE.blockedPulse;
      const pulse = !reducedMotion && phase < 1.2 ? Math.sin((phase / 1.2) * Math.PI) : 0;
      hold.halo.scale.setScalar(1 + pulse * 0.6); hold.halo.material.opacity = 0.5 + pulse * 0.4;
      if (!reducedMotion) animating = true;
    }
    return { arrivals, animating };
  };

  // Handoffs view: the last 24 hours of routes as a quiet brass trace (history).
  const showHistory = (handoffs, visible) => {
    for (const child of [...history.children]) { history.remove(child); child.geometry.dispose(); child.material.dispose(); }
    history.visible = visible;
    if (!visible) return [];
    const routes = [];
    const unique = new Map();
    for (const handoff of handoffs) { const pair = `${handoff.fromKey}>${handoff.toKey}`; if (!unique.has(pair)) unique.set(pair, handoff); }
    [...unique.values()].slice(0, 24).forEach((handoff, index) => {
      const path = routePath(handoff.fromKey, handoff.toKey);
      if (!path) return;
      const lane = offsetPath(path, ((index % 6) - 2.5) * PULSE.laneSpacing);
      routes.push(lane);
      const made = material(); made.uniforms.uHead.value = 1e4; made.uniforms.uFade.value = 0; made.uniforms.uEmber.value = handoff.fresh ? 0.65 : 0.38; made.uniforms.uIntensity.value = intensity;
      const mesh = new THREE.Mesh(stripGeometry(lane, 0.3, floorHeight, 0.007), made); mesh.renderOrder = 4; mesh.userData = { handoff };
      history.add(mesh);
    });
    return routes;
  };

  return {
    group, update, tick, showHistory,
    // Day 0.6, night 1.4 (the bloom does the rest).
    setNight(level) { intensity = PULSE.emissiveDay + (PULSE.emissiveNight - PULSE.emissiveDay) * level; },
    active: () => pulses.size > 0 || holds.size > 0,
    routes: (handoffs) => handoffs.map((handoff) => routePath(handoff.fromKey, handoff.toKey)).filter(Boolean),
    dispose() { for (const pulse of pulses.values()) { pulse.mesh.geometry.dispose(); pulse.material.dispose(); } ringGeometry.dispose(); ringMaterial.dispose(); holdMaterial.dispose(); showHistory([], false); },
  };
}

export const FORUM_RING_RADIUS = FORUM.radius;
