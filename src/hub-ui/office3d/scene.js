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
import { OFFICE, ZONES, ZONE_KEYS, zoneByNumber } from './plan.js?v=__UI_VERSION__';
import { CAMERA_STATES, agentView, between, ceilingVisible, chiefView, departmentView, handoffsView, orbit, overviewView, stepBack, transitionMs } from './camera.js?v=__UI_VERSION__';
import { MODE_TRANSITION_MS, blendPreset, kelvinToHex, resolveMode, sunDirection } from './modes.js?v=__UI_VERSION__';
import { createMaterials, assetUrl } from './materials.js?v=__UI_VERSION__';
import { buildArchitecture } from './architecture.js?v=__UI_VERSION__';
import { buildFurniture } from './furniture.js?v=__UI_VERSION__';
import { buildPlants } from './plants.js?v=__UI_VERSION__';
import { LIVE_TEXT_METRES, RESOLUTION, drawChiefMonitor, drawDepartment, drawDeskMonitor, drawOfficeWall, drawRoutingMap, screenPalette } from './screens.js?v=__UI_VERSION__';
import { deskSignal, forumState, statBar } from './states.js?v=__UI_VERSION__';
import { createPeople } from './people.js?v=__UI_VERSION__';
import { bakeFloor } from './bake.js?v=__UI_VERSION__';

// Quality tiers (§14): auto-selected, stepped down by the frame-rate watchdog.
export const QUALITY = Object.freeze({
  high: { pixelRatio: 2, shadowSize: 4096, composer: true, ao: true, msaa: 4, fps: 60 },
  balanced: { pixelRatio: 1.5, shadowSize: 2048, composer: true, ao: false, msaa: 4, fps: 60 },
  light: { pixelRatio: 1, shadowSize: 1024, composer: false, ao: false, msaa: 0, fps: 30 },
});
const ORDER = ['high', 'balanced', 'light'];

export function mountOffice3D(container, options = {}) {
  const { reducedMotion = false, on = {} } = options;
  let tier = QUALITY[options.quality] ? options.quality : 'balanced';
  let settings = QUALITY[tier];
  let current = options.state || { employees: [], handoffs: [], projects: [] };
  let disposed = false;
  const cleanup = [];

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
  canvas.addEventListener('webglcontextlost', (event) => { event.preventDefault(); fail(new Error('WebGL context lost')); });

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
  const POSE_CLIP = { relaxed: 'relaxed', typing: 'typing', reading: 'reading', waiting: 'waiting', blocked: 'blocked', sitback: 'sitback', phone: 'phone', review: 'review' };
  const applyPeople = () => {
    const forum = forumState(current);
    for (const [key, desk] of desks) {
      const person = desk.person; if (!person) continue;
      const signal = desk.signal;
      person.root.visible = signal.pose !== 'empty';
      if (!person.root.visible) continue;
      let clip = POSE_CLIP[signal.pose] || 'relaxed';
      if (key === 'chief' && (forum === 'active' || forum === 'routing') && signal.pose !== 'blocked') clip = 'lookUp';
      if (desk.station.standing && !['phone', 'review'].includes(clip)) clip = 'stand';
      const standing = ['stand', 'phone', 'review'].includes(clip);
      person.root.position.set(standing && !desk.station.standing ? 0.55 : 0, 0, standing ? -0.1 : 0.04);
      crew.play(person, clip);
    }
  };
  const lodScale = () => 36 / Math.max(1, overviewDistance);
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
      shade.material.emissive.copy(lampColor);
      shade.material.emissiveIntensity = (signal.lamp * (0.6 + night * 1.8)) + flare * 2.5;
      pool.material.opacity = Math.min(1, signal.lamp * (0.12 + night * 0.5) + flare * 0.4);
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
  };

  // ------------------------------------------------------------ post (AgX output, night bloom, AO on High)
  let composer = null; let bloom = null; let ao = null;
  const buildComposer = () => {
    composer?.dispose?.(); composer = null; bloom = null; ao = null;
    if (!settings.composer) return;
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: settings.msaa });
    composer = new THREE.EffectComposer(renderer, target);
    composer.addPass(new THREE.RenderPass(scene, camera));
    if (settings.ao) { ao = new THREE.GTAOPass(scene, camera, 1, 1); ao.blendIntensity = 0.85; composer.addPass(ao); }
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
    sun.intensity = preset.sun;
    sun.visible = preset.sun > 0.01;
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
    scene.background = new THREE.Color(preset.horizon);
    materials.setTravertineRoughness(preset.roughness);
    baked.setNight(preset.artificial);
    architecture.setNight(preset.artificial);
    for (const screen of screens || []) screen.material.color.setScalar(preset.screens);
    if (bloom) { bloom.enabled = preset.bloom > 0.02; bloom.strength = 0.25 + preset.bloom * 0.45; }
    container.style.setProperty('--o3d-sky', preset.backdrop[0]);
    container.style.setProperty('--o3d-ground', preset.backdrop[1]);
  };
  const setLightMode = (mode) => {
    const next = resolveMode(mode);
    lightMode = next.mode;
    if (reducedMotion) { lighting = next; applyLighting(next.preset); lightTween = null; on.phase?.(next.phase); for (const screen of screens) drawScreen(screen); wake(); return; }
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
    if (name === 'handoffs') return handoffsView(request.routes || [], { aspect, insets: insets() });
    return overviewView({ aspect, insets: insets() });
  };
  let active = { name: 'overview' };
  let overviewDistance = 50;
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
    const next = viewFor(request);
    active = { ...request, name: next.name, key: next.key };
    idleOrbit = null;
    const from = currentShot();
    if (instant || reducedMotion) { shot = next; move = null; placeCamera(shot); }
    else { move = { from, to: next, start: performance.now(), duration: transitionMs(from, next) }; shot = next; }
    on.view?.(active);
    wake();
  };
  const currentShot = () => ({ position: camera.position.toArray(), target: shot.target, fov: camera.fov });

  // ------------------------------------------------------------ loop
  let awake = true; let lastFrame = 0;
  let lastInfo = { calls: 0, triangles: 0 };
  const desksAnimating = () => [...desks.values()].some((desk) => desk.signal.ring === 'approval' || (desk.flareAt && performance.now() - desk.flareAt < 600));
  const frames = [];
  function wake() { awake = true; }
  const loop = (now) => {
    if (disposed || document.hidden) return;
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
      plants.tick(now / 1000);
      if (crew.tick(delta / 1000, measurePeople())) animating = true;
      applyDesks(now);
      if (desksAnimating()) animating = true;
      if (move || animating) refreshNear();
      if (awake || animating || ambient) {
        renderer.info.reset();
        if (composer) composer.render(); else renderer.render(scene, camera);
        lastInfo = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
        on.frame?.({ camera, width: container.clientWidth, height: container.clientHeight });
      }
      awake = false;
      frames.push(delta); if (frames.length > 90) frames.shift();
      watchPerformance(now);
    } catch (error) { fail(error); }
  };

  // Frame-rate watchdog: step quality down, then give up gracefully.
  let slowSince = 0;
  const watchPerformance = (now) => {
    if (frames.length < 60 || reducedMotion) return;
    const average = 1000 / (frames.reduce((sum, value) => sum + value, 0) / frames.length);
    const floor = Math.min(24, settings.fps * 0.45);
    if (average >= floor) { slowSince = 0; return; }
    if (!slowSince) { slowSince = now; return; }
    if (now - slowSince < 4000) return;
    slowSince = 0; frames.length = 0;
    const next = ORDER[ORDER.indexOf(tier) + 1];
    if (next) setQuality(next); else on.slow?.(average);
  };
  function setQuality(next) {
    tier = next; settings = QUALITY[next];
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, settings.pixelRatio));
    sun.shadow.mapSize.set(settings.shadowSize, settings.shadowSize); sun.shadow.map?.dispose(); sun.shadow.map = null;
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
    composer?.setSize(width, height);
    aspect = width / height; camera.aspect = aspect; camera.updateProjectionMatrix();
    overviewDistance = overviewView({ aspect, insets: insets() }).distance;
    shot = viewFor(active);
    if (!move) placeCamera(shot);
    wake();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  const onVisibility = () => { if (!document.hidden) { lastFrame = 0; wake(); } };
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
  const ready = (async () => {
    const [day, night] = await Promise.all([loadEnvironment('day'), loadEnvironment('night')]);
    environments.day = day || fallbackEnvironment(); environments.night = night || environments.day;
    applyLighting(lighting.preset); wake();
    on.progress?.(0.3);
    const textures = await materials.load();
    wake();
    on.progress?.(1);
    return textures;
  })().catch((error) => { fail(error); return null; });

  return {
    ready,
    update(next) { current = next; for (const screen of screens) drawScreen(screen); applyDesks(); wake(); },
    setView, view: () => active, back() { setView(stepBack(active)); },
    setLightMode, lightMode: () => lightMode, phase: () => lighting.phase,
    setProject() { wake(); },
    setRtl() { wake(); },
    stats() {
      const average = frames.length ? Math.round(1000 / (frames.reduce((sum, value) => sum + value, 0) / frames.length)) : null;
      return { quality: tier, fps: average, drawCalls: lastInfo.calls, triangles: lastInfo.triangles, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, view: active.name, lightMode, phase: lighting.phase };
    },
    dispose() {
      disposed = true;
      renderer.setAnimationLoop(null);
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      for (const step of cleanup) step();
      architecture.dispose(); furniture.dispose(); plants.dispose(); crew.dispose(); baked.dispose(); materials.dispose();
      for (const screen of screens) { screen.texture.dispose(); screen.material.dispose(); }
      for (const environment of new Set([environments.day, environments.night])) environment?.dispose?.();
      pmrem.dispose(); composer?.dispose?.();
      renderer.dispose(); renderer.forceContextLoss?.();
      canvas.remove();
    },
  };
}
