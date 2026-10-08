// The immersive Office — "Daylight Atrium" (Final Design Spec, October 2026).
// Loaded only when the Live Office shows the 3D Office.
//
//   mountOffice3D(container, options) → controller
//     options: { state, quality, reducedMotion, lightMode, rtl, copy, insets(), avoidRects(), on: { … } }
//     controller: update(state) · setView({ name, key }) · back() · view() · setLightMode(mode)
//                 setProject(id) · setRtl(rtl) · stats() · dispose()
//
// It consumes the presentation state only (office-presentation.js) and never
// fetches Office data. Any rendering failure calls on.error() and the Live
// Office falls back to the simplified Office.
import * as THREE from '../vendor/three.js?v=__UI_VERSION__';
import { COLUMNS, OFFICE, ZONES, ZONE_KEYS, labelAnchor, zoneByNumber } from './plan.js?v=__UI_VERSION__';
import { CAMERA_STATES, agentView, between, ceilingVisible, occluders, chiefView, departmentView, handoffsView, orbit, overviewView, stepBack, transitionMs } from './camera.js?v=__UI_VERSION__';
import { MODE_TRANSITION_MS, blendPreset, kelvinToHex, resolveMode, sunDirection } from './modes.js?v=__UI_VERSION__';
import { createMaterials, assetUrl } from './materials.js?v=__UI_VERSION__';
import { buildArchitecture } from './architecture.js?v=__UI_VERSION__';
import { buildFurniture } from './furniture.js?v=__UI_VERSION__';
import { buildPlants } from './plants.js?v=__UI_VERSION__';
import { LIVE_TEXT_METRES, RESOLUTION, drawChiefMonitor, drawDepartment, drawDeskMonitor, drawOfficeWall, drawRoutingMap, screenPalette } from './screens.js?v=__UI_VERSION__';
import { deskSignal, forumState, statBar } from './states.js?v=__UI_VERSION__';
import { createPeople } from './people.js?v=__UI_VERSION__';
import { bakeFloor } from './bake.js?v=__UI_VERSION__';
import { createHandoffs } from './handoffs3d.js?v=__UI_VERSION__';
import { cloudShade, createLife } from './life.js?v=__UI_VERSION__';
import { FORUM_STATES } from './states.js?v=__UI_VERSION__';
import { createErrorBudget, createWatchdog, median } from './perf.js?v=__UI_VERSION__';

// Quality tiers (§14): auto-selected, stepped down by the frame-rate watchdog.
export const QUALITY = Object.freeze({
  high: { pixelRatio: 2, shadowSize: 4096, composer: true, ao: true, msaa: 4, fps: 60 },
  balanced: { pixelRatio: 1.5, shadowSize: 2048, composer: true, ao: false, msaa: 4, fps: 60 },
  // Lean: the same look (composer, night bloom) at 1× resolution and 2× MSAA,
  // so a slow laptop steps down without losing the night atmosphere.
  lean: { pixelRatio: 1, shadowSize: 2048, composer: true, ao: false, msaa: 2, fps: 60 },
  light: { pixelRatio: 1, shadowSize: 1024, composer: false, ao: false, msaa: 0, fps: 30 },
});

export function mountOffice3D(container, options = {}) {
  const { reducedMotion = false, on = {} } = options;
  let tier = QUALITY[options.quality] ? options.quality : 'balanced';
  let settings = QUALITY[tier];
  let current = options.state || { employees: [], handoffs: [], projects: [] };
  let disposed = false;
  const cleanup = [];
  // Frame-rate watchdog (perf.js): steps quality down only on persistent
  // slowness, after warm-up and outside compile/switch windows.
  const watchdog = createWatchdog({ tier });
  const errors = createErrorBudget();

  // ------------------------------------------------------------ renderer
  const canvas = document.createElement('canvas');
  canvas.className = 'o3d-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  container.append(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !settings.composer, powerPreference: 'high-performance', stencil: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, settings.pixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.info.autoReset = false; // draw calls are counted across every pass of a frame
  // Shadows are re-rendered only when something that casts them moves (see the loop).
  renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = true;
  let shadowsAt = 0;
  // A lost context (GPU reset, driver update) is recovered by the overlay with a fresh mount.
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault(); renderer.setAnimationLoop(null);
    if (!disposed) on.error?.(Object.assign(new Error('WebGL context lost'), { contextLost: true }));
  });

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAMERA_STATES.overview.fov, 1, 0.1, 600);
  scene.fog = new THREE.Fog('#efe7dc', 90, 220);

  // ------------------------------------------------------------ lights
  const sun = new THREE.DirectionalLight('#ffffff', 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(settings.shadowSize, settings.shadowSize);
  Object.assign(sun.shadow.camera, { left: -34, right: 34, top: 34, bottom: -34, near: 1, far: 200 });
  sun.shadow.bias = -0.0002; sun.shadow.normalBias = 0.025; sun.shadow.radius = 4;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight('#f4efe6', '#b9a68a', 0.15);
  const bounce = new THREE.DirectionalLight('#f3dcc0', 0.2); // warm bounce from the stone, no shadows
  scene.add(hemi, bounce, bounce.target);

  // ------------------------------------------------------------ environment (HDR reflections)
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environments = { day: null, night: null };
  const fallbackEnvironment = () => { const room = new THREE.RoomEnvironment(); const texture = pmrem.fromScene(room, 0.04).texture; room.traverse?.((node) => { node.geometry?.dispose?.(); node.material?.dispose?.(); }); return texture; };
  const loadEnvironment = (name) => new Promise((resolve) => {
    const url = assetUrl(`env/${name}.exr`);
    if (!url) return resolve(null);
    new THREE.EXRLoader().setDataType(THREE.HalfFloatType).load(url, (texture) => {
      texture.mapping = THREE.EquirectangularReflectionMapping;
      const target = pmrem.fromEquirectangular(texture); texture.dispose();
      resolve(target.texture);
    }, undefined, () => resolve(null));
  });

  // ------------------------------------------------------------ materials and the building
  const materials = createMaterials({ renderer, tier, onProgress: (share) => on.progress?.(0.3 + share * 0.5) });
  const architecture = buildArchitecture({ materials, tier });
  scene.add(architecture.root);
  const furniture = buildFurniture({ materials, tier });
  scene.add(furniture.root);
  const plants = buildPlants({ materials, tier, reducedMotion });
  scene.add(plants.root);
  const baked = bakeFloor({ footprints: furniture.footprints, tier });
  scene.add(baked.group);
  const handoffs = createHandoffs({ reducedMotion });
  scene.add(handoffs.group);
  let bundles = [];

  // ------------------------------------------------------------ screens (§12)
  const stateWord = options.stateWord || ((value) => (String(value || '').charAt(0) + String(value || '').slice(1).toLowerCase()));
  const screens = furniture.screens.map((entry, index) => {
    const [width, height] = RESOLUTION[entry.kind === 'table' ? 'table' : entry.kind === 'wall' ? 'wall' : entry.kind === 'department' ? 'department' : 'desk'][tier];
    const canvasEl = document.createElement('canvas'); canvasEl.width = width; canvasEl.height = height;
    const texture = new THREE.CanvasTexture(canvasEl);
    texture.colorSpace = THREE.SRGBColorSpace; texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter; texture.anisotropy = 4;
    const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
    entry.mesh.material = material;
    return { ...entry, index, canvas: canvasEl, texture, material, signature: '', near: false };
  });
  const employeeOf = (key) => current.employees?.find((employee) => employee.key === key) || { key, state: 'AVAILABLE' };
  const drawScreen = (screen, force = false) => {
    const employee = employeeOf(screen.key);
    const signal = deskSignal(employee);
    const palette = screenPalette(lighting.phase);
    const signature = JSON.stringify([screen.near, lighting.phase, screen.kind === 'wall' || screen.kind === 'table' || screen.key === 'chief' ? [current.projects, current.handoffs?.map((h) => [h.id, h.fresh]), current.summary, options.stream?.()] : null,
      employee.state, employee.task, employee.objective, employee.detail, employee.progress, employee.queue, employee.artifact?.id, employee.coding, employee.enabled]);
    if (!force && signature === screen.signature) return;
    screen.signature = signature;
    if (screen.kind === 'department') drawDepartment(screen.canvas, { employee, signal, palette, stateWord });
    else if (screen.kind === 'wall') drawOfficeWall(screen.canvas, { state: current, stats: statBar(current, { deliveries: current.deliveries || [] }), stream: options.stream?.() || [], palette, labels: options.copy?.wall || {} });
    else if (screen.kind === 'table') drawRoutingMap(screen.canvas, { state: current, palette });
    else if (screen.key === 'chief') drawChiefMonitor(screen.canvas, { state: current, palette, index: furniture.screens.filter((other) => other.key === 'chief' && other.kind === 'desk').indexOf(furniture.screens[screen.index]), near: screen.near });
    else drawDeskMonitor(screen.canvas, { employee, signal, palette, near: screen.near, index: screen.index, artifactTitle: employee.artifact?.title });
    screen.texture.needsUpdate = true;
  };
  const screenPosition = new THREE.Vector3();
  const refreshNear = () => {
    for (const screen of screens) {
      if (screen.kind !== 'desk') continue;
      screen.mesh.getWorldPosition(screenPosition);
      const near = screenPosition.distanceTo(camera.position) < LIVE_TEXT_METRES;
      if (near !== screen.near) { screen.near = near; drawScreen(screen); }
    }
  };

  // ------------------------------------------------------------ desk signals (§05)
  const lampColor = new THREE.Color(kelvinToHex(2700));
  const desks = new Map([...furniture.workstations].map(([key, station]) => [key, { station, signal: deskSignal({ key }), flareAt: 0, lastState: null }]));
  // ------------------------------------------------------------ people (§05)
  const crew = createPeople({ tier, reducedMotion });
  for (const [key, desk] of desks) {
    const person = crew.create(key);
    desk.person = person;
    desk.station.chair.add(person.root);
    person.root.position.set(0, 0, 0.04);
  }
  const life = createLife({ scene, crew, desks, reducedMotion, tier });
  const POSE_CLIP = { relaxed: 'relaxed', typing: 'typing', reading: 'reading', waiting: 'waiting', blocked: 'blocked', sitback: 'sitback', phone: 'phone', review: 'review' };
  const applyPeople = () => {
    const forum = forumState(current);
    for (const [key, desk] of desks) {
      const person = desk.person; if (!person || desk.walking) continue;
      const signal = desk.signal;
      person.root.visible = signal.pose !== 'empty';
      if (!person.root.visible) continue;
      let clip = POSE_CLIP[signal.pose] || 'relaxed';
      // The employee turns toward whoever just handed work over (3 s).
      const glancing = desk.glance && performance.now() < desk.glance.until && !reducedMotion;
      person.mesh.rotation.y += ((glancing ? desk.glance.yaw : 0) - person.mesh.rotation.y) * 0.08;
      if (key === 'chief' && (forum === 'active' || forum === 'routing') && signal.pose !== 'blocked') clip = 'lookUp';
      if (desk.station.standing && !['phone', 'review'].includes(clip)) clip = 'stand';
      const standing = ['stand', 'phone', 'review'].includes(clip);
      person.root.position.set(standing && !desk.station.standing ? 0.55 : 0, 0, standing ? -0.1 : 0.04);
      crew.play(person, clip);
    }
  };
  // The spec's LOD distances are read on a scale where the farthest label in
  // the fitted Overview sits just inside the medium band (38 of 40 m): zooming
  // out reaches "dot", a department view reaches "name, state, task".
  const lodScale = () => 38 / Math.max(1, overviewFar);
  const personPosition = new THREE.Vector3();
  const distances = new Map();
  const measurePeople = () => {
    for (const [key, desk] of desks) { if (!desk.person) continue; desk.person.root.getWorldPosition(personPosition); distances.set(key, personPosition.distanceTo(camera.position) * lodScale()); }
    return distances;
  };
  const applyDesks = (now = performance.now()) => {
    const night = lighting.preset.artificial;
    for (const [key, desk] of desks) {
      const employee = employeeOf(key);
      const signal = deskSignal(employee);
      if (desk.lastState && desk.lastState !== 'COMPLETED' && employee.state === 'COMPLETED' && !reducedMotion) desk.flareAt = now;
      desk.lastState = employee.state; desk.signal = signal;
      const { shade, ring, pool } = desk.station.lamp;
      const flare = desk.flareAt && now - desk.flareAt < 600 ? Math.sin(((now - desk.flareAt) / 600) * Math.PI) : 0;
      // A handoff arriving: the destination lamp ramps up over 400 ms and holds briefly.
      const arrival = desk.arrivalAt && now - desk.arrivalAt < 3000 ? Math.min(1, (now - desk.arrivalAt) / 400) * (1 - Math.max(0, (now - desk.arrivalAt - 2400) / 600)) : 0;
      signal.lamp = Math.max(signal.lamp, arrival * 0.8);
      shade.material.emissive.copy(lampColor);
      shade.material.emissiveIntensity = (signal.lamp * (0.6 + night * 1.8)) + flare * 2.5;
      pool.material.opacity = Math.min(1, signal.lamp * (0.12 + night * 0.5) + flare * 0.4);
      pool.visible = pool.material.opacity > 0.01; // nothing drawn when the lamp is off
      // Approval: a hollow red ring pulsing every 6 s; blocked and failed: held.
      const pulse = signal.ring === 'approval' && !reducedMotion ? 0.55 + 0.45 * Math.max(0, Math.cos(((now / 1000) % 6) / 6 * Math.PI * 2)) : 1;
      ring.material.opacity = signal.ring ? pulse : 0;
      ring.visible = Boolean(signal.ring);
      // Offline: the empty chair is pushed in under the desk.
      const chair = desk.station.chair;
      const pushed = signal.chair === 'pushed-in';
      const [hx, hz] = desk.station.chairHome; const yaw = desk.station.desk.yaw;
      chair.position.set(hx - (pushed ? Math.sin(yaw) * 0.42 : 0), chair.position.y, hz - (pushed ? Math.cos(yaw) * 0.42 : 0));
      // Ambient (neutral): a slow chair swivel while at rest.
      const resting = ['relaxed', 'waiting'].includes(signal.pose) && !reducedMotion;
      chair.rotation.y = yaw + (resting ? Math.sin(now / 1000 * 0.21 + key.length) * 0.05 : 0);
    }
    applyPeople();
    applyForum(now);
  };
  // The CHIEF Forum (§03): the table's bronze strip is CHIEF's status light.
  let forumWas = 'idle'; let forumChangedAt = 0;
  const stripBlue = new THREE.Color('#5b8cff'); const stripWarm = new THREE.Color('#ffb46b');
  const applyForum = (now) => {
    const strip = furniture.chiefStrip; if (!strip) return;
    const forum = forumState(current);
    if (forum !== forumWas) { forumWas = forum; forumChangedAt = now; }
    const since = now - forumChangedAt;
    const spec = FORUM_STATES[forum];
    if (forum === 'completes') { strip.material.emissive.copy(stripWarm); strip.material.emissiveIntensity = reducedMotion ? 0.4 : since < 600 ? Math.sin((since / 600) * Math.PI) * 2.4 : 0.15; }
    else { strip.material.emissive.copy(stripBlue); strip.material.emissiveIntensity = spec.strip * 2.2 + (forum === 'routing' && since < 400 && !reducedMotion ? 1.6 : 0); }
  };

  // ------------------------------------------------------------ post (AgX output, night bloom, AO on High)
  let composer = null; let bloom = null; let ao = null; let dof = null;
  let aoProxy = null;
  const aoScene = () => {
    if (aoProxy) return aoProxy;
    aoProxy = new THREE.Scene();
    const add = (root) => root.traverse((node) => {
      if (!node.isMesh || node.material?.transparent || node.material?.visible === false || node.userData?.screen || node.parent?.name?.startsWith('ceiling')) return;
      if (node.isSkinnedMesh || node.name?.startsWith('leaves') || !node.geometry?.boundingSphere && !node.isInstancedMesh) return;
      node.updateWorldMatrix(true, false);
      const proxy = node.isInstancedMesh ? new THREE.InstancedMesh(node.geometry, node.material, node.count) : new THREE.Mesh(node.geometry, node.material);
      if (node.isInstancedMesh) proxy.instanceMatrix = node.instanceMatrix;
      proxy.matrixAutoUpdate = false; proxy.matrix.copy(node.matrixWorld); proxy.matrixWorld.copy(node.matrixWorld);
      aoProxy.add(proxy);
    });
    add(architecture.root); add(furniture.root);
    return aoProxy;
  };
  const buildComposer = () => {
    composer?.dispose?.(); composer = null; bloom = null; ao = null; dof = null;
    if (!settings.composer) return;
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: settings.msaa });
    composer = new THREE.EffectComposer(renderer, target);
    composer.addPass(new THREE.RenderPass(scene, camera));
    // AO on High only, computed from a proxy of the large static meshes (shared
    // geometry, no copies) so it costs a few draw calls rather than the scene again.
    if (settings.ao) { ao = new THREE.GTAOPass(aoScene(), camera, 1, 1); ao.blendIntensity = 0.85; composer.addPass(ao); }
    // Subtle depth of field in the agent view (High only).
    if (settings.ao) { dof = new THREE.BokehPass(scene, camera, { focus: CAMERA_STATES.agent.distance, aperture: 0.0016, maxblur: 0.006 }); dof.enabled = false; composer.addPass(dof); }
    bloom = new THREE.UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.6, 0.82);
    bloom.enabled = false;
    composer.addPass(bloom);
    composer.addPass(new THREE.OutputPass());
  };
  buildComposer();

  // ------------------------------------------------------------ lighting modes (§10)
  let lightMode = options.lightMode || 'auto';
  let lighting = resolveMode(lightMode);
  let lightTween = null;
  const applyLighting = (preset) => {
    const dir = sunDirection(preset);
    sun.position.set(dir[0] * 80, Math.max(dir[1], 0.02) * 80, dir[2] * 80);
    sun.color.set(kelvinToHex(preset.sunKelvin));
    sun.intensity = preset.sun; sun.userData.base = preset.sun;
    // The sun stays in the scene at night (intensity 0): removing a light recompiles every material.
    bounce.position.set(-dir[0] * 40, 30, -dir[2] * 40);
    bounce.intensity = preset.sun * 0.07 + preset.artificial * 0.06;
    bounce.color.set(preset.artificial > 0.5 ? '#ffd2a1' : '#f3dcc0');
    hemi.intensity = preset.hemi;
    const useNight = preset.sun < 0.4;
    const environment = (useNight ? environments.night : environments.day) || environments.day || environments.night;
    if (environment && scene.environment !== environment) scene.environment = environment;
    scene.environmentIntensity = preset.sky;
    renderer.toneMappingExposure = preset.exposure;
    scene.fog.color.set(preset.horizon);
    if (scene.background?.isColor) scene.background.set(preset.horizon); else scene.background = new THREE.Color(preset.horizon);
    renderer.shadowMap.needsUpdate = true;
    materials.setTravertineRoughness(preset.roughness);
    baked.setNight(preset.artificial);
    architecture.setNight(preset.artificial);
    handoffs.setNight(preset.bloom);
    for (const screen of screens || []) screen.material.color.setScalar(preset.screens);
    if (bloom) { bloom.enabled = preset.bloom > 0.02; bloom.strength = 0.25 + preset.bloom * 0.45; }
    container.style.setProperty('--o3d-sky', preset.backdrop[0]);
    container.style.setProperty('--o3d-ground', preset.backdrop[1]);
  };
  const setLightMode = (mode) => {
    const next = resolveMode(mode);
    lightMode = next.mode;
    if (reducedMotion) { lighting = next; applyLighting(next.preset); lightTween = null; on.phase?.(next.phase); for (const screen of screens) drawScreen(screen); wake(); return; }
    watchdog.grace(performance.now(), MODE_TRANSITION_MS + 3000);
    lightTween = { from: { ...lighting.preset }, to: next, start: performance.now() };
    lighting = { ...lighting, phase: next.phase };
    for (const screen of screens) drawScreen(screen);
    on.phase?.(next.phase);
    wake();
  };
  // Auto follows the real clock: re-evaluated every minute.
  const autoTimer = setInterval(() => { if (lightMode === 'auto' && !lightTween) { const next = resolveMode('auto'); if (next.phase !== lighting.phase) on.phase?.(next.phase); lighting = next; applyLighting(next.preset); wake(); } }, 60_000);
  cleanup.push(() => clearInterval(autoTimer));

  // ------------------------------------------------------------ camera states (§09)
  let aspect = 16 / 9;
  const insets = () => options.insets?.() || {};
  const viewFor = (request) => {
    const name = request?.name || 'overview';
    if (name === 'department') return departmentView(request.key, { aspect, insets: insets() }) || overviewView({ aspect, insets: insets() });
    if (name === 'agent') return agentView(request.key) || overviewView({ aspect, insets: insets() });
    if (name === 'chief') return chiefView({ aspect, insets: insets() });
    if (name === 'handoffs') return handoffsView(handoffs.showHistory(current.handoffs || [], true), { aspect, insets: insets() });
    return overviewView({ aspect, insets: insets() });
  };
  let active = { name: 'overview' };
  let overviewDistance = 50; let overviewFar = 70;
  let shot = viewFor(active);
  let move = null; // { from, to, start, duration }
  let lastInput = performance.now();
  let idleOrbit = null;
  const placeCamera = (view) => {
    camera.position.set(...view.position);
    camera.fov = view.fov;
    camera.updateProjectionMatrix();
    camera.lookAt(...view.target);
  };
  const setView = (request, { instant = false } = {}) => {
    zoom = 1;
    if ((request?.name || 'overview') !== 'handoffs') handoffs.showHistory([], false);
    const next = viewFor(request);
    active = { ...request, name: next.name, key: next.key };
    idleOrbit = null;
    const from = currentShot();
    if (instant || reducedMotion) { shot = next; move = null; placeCamera(shot); }
    else { move = { from, to: next, start: performance.now(), duration: transitionMs(from, next) }; shot = next; }
    if (dof) dof.enabled = active.name === 'agent' && !reducedMotion;
    watchdog.grace(performance.now());
    on.view?.(active);
    wake();
  };
  const currentShot = () => ({ position: camera.position.toArray(), target: shot.target, fov: camera.fov });

  // ------------------------------------------------------------ labels: anchors for the overlay
  // The overlay lays out floor labels (labels.js); the scene tells it where
  // each label's floor ring is, how far it is, and what the focus covers.
  const anchors = ZONE_KEYS.map((key) => ({ key, world: new THREE.Vector3(...labelAnchor(key)) }));
  const projected = new THREE.Vector3();
  let frameKey = '';
  const focusRect = (key, width, height) => {
    const zone = ZONES[key]; if (!zone) return null;
    const { x, z } = zone.desk; const y = key === 'chief' ? -0.45 : 0;
    const xs = []; const ys = [];
    // CHIEF's focus is the table and the Office Wall it faces.
    const points = [];
    for (const dx of [-1.1, 1.1]) for (const dz of [-0.9, 1.2]) for (const dy of [0, 1.45]) points.push([x + dx, y + dy, z + dz]);
    if (key === 'chief') for (const dx of [-3.7, 3.7]) for (const dy of [1.2, 3.7]) points.push([dx, dy, -6.8]);
    for (const [px, py, pz] of points) {
      projected.set(px, py, pz).project(camera);
      if (projected.z > 1) continue;
      xs.push(((projected.x + 1) / 2) * width); ys.push(((1 - projected.y) / 2) * height);
    }
    if (!xs.length) return null;
    const rect = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    return rect.w > width * 0.96 ? null : rect;
  };
  const emitFrame = (force = false) => {
    const width = container.clientWidth; const height = container.clientHeight;
    const key = `${camera.matrixWorld.elements.map((value) => value.toFixed(3)).join(',')}|${width}x${height}`;
    if (!force && key === frameKey) return;
    frameKey = key;
    camera.updateMatrixWorld();
    const list = anchors.map(({ key: id, world }) => {
      projected.copy(world).project(camera);
      return { key: id, x: ((projected.x + 1) / 2) * width, y: ((1 - projected.y) / 2) * height, visible: projected.z < 1 && projected.z > -1, distance: world.distanceTo(camera.position) };
    });
    const focusKey = active.name === 'agent' || active.name === 'department' ? active.key : active.name === 'chief' ? 'chief' : null;
    on.frame?.({ anchors: list, lodScale: lodScale(), focusKey, focusRect: active.name === 'agent' || active.name === 'chief' ? focusRect(focusKey, width, height) : null, width, height });
  };

  // ------------------------------------------------------------ picking
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const pickables = [...furniture.workstations.values()].map((station) => station.hit);
  const hitAt = (event) => {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const targets = active.name === 'handoffs' ? [...handoffs.group.children.flatMap((child) => (child.isGroup ? child.children : [child])).filter((mesh) => mesh.userData?.handoff), ...pickables] : pickables;
    return raycaster.intersectObjects(targets, false)[0]?.object || null;
  };
  let press = null;
  canvas.addEventListener('pointerdown', (event) => { press = { x: event.clientX, y: event.clientY }; });
  canvas.addEventListener('pointerup', (event) => {
    if (!press || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 6) { press = null; return; }
    press = null;
    const object = hitAt(event);
    if (object?.userData?.handoff) on.handoff?.(object.userData.handoff);
    else if (object?.userData?.key) on.select?.(object.userData.key);
  });
  canvas.addEventListener('pointermove', (event) => { if (event.buttons) return; canvas.style.cursor = hitAt(event) ? 'pointer' : 'default'; });
  // Gentle zoom along the current view (the lens and elevation stay fixed).
  let zoom = 1;
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoom = Math.max(0.7, Math.min(1.6, zoom * (1 + Math.sign(event.deltaY) * 0.06)));
    const base = viewFor(active);
    const offset = new THREE.Vector3(...base.position).sub(new THREE.Vector3(...base.target)).multiplyScalar(zoom);
    shot = { ...base, position: new THREE.Vector3(...base.target).add(offset).toArray() };
    move = null; placeCamera(shot); wake();
  }, { passive: false });

  // ------------------------------------------------------------ loop
  let awake = true; let lastFrame = 0;
  let lastInfo = { calls: 0, triangles: 0 };
  const desksAnimating = () => [...desks.values()].some((desk) => desk.signal.ring === 'approval' || (desk.flareAt && performance.now() - desk.flareAt < 600));
  const frames = [];
  function wake() { awake = true; }
  const loop = (now) => {
    if (disposed || document.hidden || !onScreen) return;
    const ambient = !reducedMotion;
    const fps = ambient && !move && !lightTween && !idleOrbit ? Math.min(30, settings.fps) : settings.fps;
    if (now - lastFrame < 1000 / fps - 1) return;
    const delta = lastFrame ? now - lastFrame : 16; lastFrame = now;
    try {
      let animating = false;
      if (move) {
        const t = Math.min(1, (now - move.start) / move.duration);
        const view = between(move.from, move.to, t);
        placeCamera(view);
        if (t >= 1) move = null;
        animating = true;
      } else if (idleOrbit) {
        placeCamera(orbit(idleOrbit.base, (now - idleOrbit.start) / 1000));
        animating = true;
      } else if (!reducedMotion && active.name === 'overview' && now - lastInput > CAMERA_STATES.idle.afterSeconds * 1000) {
        idleOrbit = { base: shot, start: now };
        on.view?.({ name: 'idle' });
      }
      if (lightTween) {
        const t = Math.min(1, (now - lightTween.start) / MODE_TRANSITION_MS);
        const eased = t * t * (3 - 2 * t);
        applyLighting(blendPreset(lightTween.from, lightTween.to.preset, eased));
        if (t >= 1) { lighting = lightTween.to; lightTween = null; }
        animating = true;
      }
      const cameraY = camera.position.y;
      architecture.lowCeiling.visible = ceilingVisible(cameraY, OFFICE.ceiling);
      architecture.highCeiling.visible = ceilingVisible(cameraY, OFFICE.atrium);
      const close = ['department', 'agent'].includes(active.name) && !idleOrbit;
      architecture.setHiddenColumns(close ? occluders(camera.position.toArray(), shot.target, COLUMNS, { halfAngle: Math.atan(Math.tan((camera.fov * Math.PI) / 360) * camera.aspect), keep: active.name === 'department' ? ZONES[active.key]?.bounds : null }) : []);
      plants.tick(now / 1000);
      if (crew.tick(delta / 1000, measurePeople())) animating = true;
      if (life.tick(now, current)) animating = true;
      // Passing clouds (ambient, day only).
      if (!reducedMotion && sun.userData.base > 0.05) sun.intensity = sun.userData.base * cloudShade(now / 1000);
      const flow = handoffs.tick(now);
      if (flow.animating) animating = true;
      for (const handoff of flow.arrivals) {
        const desk = desks.get(handoff.toKey);
        if (desk) {
          desk.arrivalAt = now;
          const from = ZONES[handoff.fromKey]?.desk; const to = ZONES[handoff.toKey]?.desk;
          if (from && to) { const world = Math.atan2(-(from.x - to.x), -(from.z - to.z)); let turn = world - to.yaw; turn = Math.atan2(Math.sin(turn), Math.cos(turn)); desk.glance = { yaw: Math.max(-0.7, Math.min(0.7, turn)), until: now + 3000 }; }
        }
        on.arrival?.(handoff);
      }
      applyDesks(now);
      furniture.syncChairs();
      if (desksAnimating()) animating = true;
      if (move || animating) refreshNear();
      if (awake || animating || ambient) {
        // Shadows: on demand, and at most 15 times a second while people or chairs move.
        if (animating && now - shadowsAt > 66) renderer.shadowMap.needsUpdate = true;
        // Night: no sun, no shadow pass (once the map exists; the samplers need a depth texture).
        if (sun.intensity < 0.01 && sun.shadow.map) renderer.shadowMap.needsUpdate = false;
        if (renderer.shadowMap.needsUpdate) shadowsAt = now;
        renderer.info.reset();
        if (composer) composer.render(); else renderer.render(scene, camera);
        lastInfo = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
        emitFrame();
      }
      awake = false;
      frames.push(delta); if (frames.length > 90) frames.shift();
      if (!reducedMotion) {
        const decision = watchdog.frame(now, delta, fps);
        if (decision?.step) setQuality(decision.step);
        else if (decision?.giveUp) on.slow?.(decision.fps);
      }
    } catch (error) {
      // One bad frame is survived; only repeated errors stop the 3D Office.
      console.warn('3D Office frame error:', error?.message || error);
      if (errors.record(performance.now())) fail(error);
    }
  };

  function setQuality(next) {
    tier = next; settings = QUALITY[next]; watchdog.grace(performance.now(), 4000);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, settings.pixelRatio));
    sun.shadow.mapSize.set(settings.shadowSize, settings.shadowSize); sun.shadow.map?.dispose(); sun.shadow.map = null; renderer.shadowMap.needsUpdate = true;
    buildComposer(); resize(); applyLighting(lighting.preset); on.quality?.(next);
  }

  // ------------------------------------------------------------ input
  const touch = () => { lastInput = performance.now(); if (idleOrbit) { idleOrbit = null; setView(active); } };
  for (const type of ['pointerdown', 'wheel', 'keydown']) { window.addEventListener(type, touch, { passive: true }); cleanup.push(() => window.removeEventListener(type, touch)); }
  const onKey = (event) => {
    if (event.target.closest?.('input, textarea, select, [contenteditable="true"]') || document.querySelector('.sheet.open')) return;
    if (event.key === 'Escape') { const back = stepBack(active); if (back.name !== active.name || back.key !== active.key) { event.preventDefault(); setView(back); } return; }
    if (/^[0-8]$/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const key = zoneByNumber(Number(event.key));
      if (key) { event.preventDefault(); setView(key === 'chief' ? { name: 'chief' } : { name: 'department', key }); }
    }
  };
  window.addEventListener('keydown', onKey);
  cleanup.push(() => window.removeEventListener('keydown', onKey));

  // ------------------------------------------------------------ resize
  const resize = () => {
    const { clientWidth: width, clientHeight: height } = container;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    watchdog.grace(performance.now());
    composer?.setSize(width, height);
    aspect = width / height; camera.aspect = aspect; camera.updateProjectionMatrix();
    const fitted = overviewView({ aspect, insets: insets() });
    overviewDistance = fitted.distance;
    overviewFar = Math.max(...ZONE_KEYS.map((key) => { const [x, y, z] = labelAnchor(key); return Math.hypot(x - fitted.position[0], y - fitted.position[1], z - fitted.position[2]); }));
    shot = viewFor(active);
    if (!move) placeCamera(shot);
    wake();
    if (typeof emitFrame === 'function') requestAnimationFrame(() => emitFrame(true));
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  const onVisibility = () => { if (!document.hidden) { lastFrame = 0; watchdog.grace(performance.now()); wake(); } };
  // Off-screen (scrolled away, a collapsed panel): no rendering, no judging.
  let onScreen = true;
  const visibility = new IntersectionObserver(([entry]) => {
    const next = entry.isIntersecting;
    if (next && !onScreen) { lastFrame = 0; watchdog.grace(performance.now()); wake(); }
    onScreen = next;
  });
  visibility.observe(container);
  document.addEventListener('visibilitychange', onVisibility);

  function fail(error) { if (!disposed) on.error?.(error); }

  // ------------------------------------------------------------ start
  applyLighting(lighting.preset);
  resize();
  placeCamera(shot);
  refreshNear();
  for (const screen of screens) drawScreen(screen, true);
  applyDesks();
  renderer.setAnimationLoop(loop);
  let textureSource = null;
  const ready = (async () => {
    const [day, night] = await Promise.all([loadEnvironment('day'), loadEnvironment('night')]);
    environments.day = day || fallbackEnvironment(); environments.night = night || environments.day;
    applyLighting(lighting.preset); wake();
    on.progress?.(0.3);
    const textures = await materials.load();
    // Compile every program the scene needs now, off the critical frames where the browser can.
    try {
      if (renderer.extensions.has('KHR_parallel_shader_compile')) await renderer.compileAsync(scene, camera);
      else renderer.compile(scene, camera);
    } catch { /* compiled on first use instead */ }
    renderer.shadowMap.needsUpdate = true; wake();
    on.progress?.(1);
    textureSource = textures;
    watchdog.ready(performance.now());
    return textures;
  })().catch((error) => { fail(error); return null; });

  return {
    ready,
    update(next) {
      current = next;
      bundles = handoffs.update(current.handoffs || []).bundles;
      if (active.name === 'handoffs') handoffs.showHistory(current.handoffs || [], true);
      for (const screen of screens) drawScreen(screen); applyDesks(); wake(); emitFrame(true);
    },
    relayout: () => emitFrame(true),
    bundles: () => bundles,
    setView, view: () => active, back() { setView(stepBack(active)); },
    setLightMode, lightMode: () => lightMode, phase: () => lighting.phase,
    setProject() { emitFrame(true); wake(); },
    setRtl() { wake(); },
    stats() {
      const typical = median(frames);
      return { quality: tier, fps: typical ? Math.round(1000 / typical) : null, watch: watchdog.state(), textureSource, frameErrors: errors.count(), drawCalls: lastInfo.calls, triangles: lastInfo.triangles, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, view: active.name, lightMode, phase: lighting.phase };
    },
    dispose() {
      disposed = true;
      renderer.setAnimationLoop(null);
      observer.disconnect(); visibility.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      for (const step of cleanup) step();
      architecture.dispose(); furniture.dispose(); plants.dispose(); life.dispose(); crew.dispose(); baked.dispose(); handoffs.dispose(); materials.dispose();
      for (const screen of screens) { screen.texture.dispose(); screen.material.dispose(); }
      for (const environment of new Set([environments.day, environments.night])) environment?.dispose?.();
      pmrem.dispose(); composer?.dispose?.();
      renderer.dispose(); if (!renderer.getContext().isContextLost()) renderer.forceContextLoss?.();
      canvas.remove();
    },
  };
}
