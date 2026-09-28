// The immersive Office: an architectural model of Fahad AI Office rendered
// with Three.js. Loaded only when the Live Office enters immersive mode.
//
//   mountOffice3D(container, { state, dark, tokens, quality, reducedMotion, on })
//     → { update(state), focus(key), overview(), setProject(id), setFollow(on),
//         setTheme(dark, tokens), dispose(), stats() }
//
// It consumes the presentation state only (office-presentation.js); it never
// fetches or queries anything. Any rendering failure calls on.error() and the
// Live Office falls back to the light Office.
import * as THREE from '../vendor/three.js?v=__UI_VERSION__';
import { CAMERA, ENTRANCE, PARTITIONS, PLINTH, WALLS, WINGS, WORKSPACES, anchor, focusPreset } from './layout.js?v=__UI_VERSION__';
import { CODING_STAGES, motionFor, stateVisual } from './state-visuals.js?v=__UI_VERSION__';
import { POSES, WING_ACCENTS, applyPose, createCharacterFactory } from './characters.js?v=__UI_VERSION__';
import { drawBoard, drawEngineeringPanel, drawMonitor, drawProjectWall, surfacePalette } from './surfaces.js?v=__UI_VERSION__';

const QUALITY = Object.freeze({
  high: { pixelRatio: 2, shadows: true, shadowSize: 2048, board: [1024, 512], monitor: [320, 200], fps: 60, plants: 1 },
  balanced: { pixelRatio: 1.5, shadows: true, shadowSize: 1024, board: [768, 384], monitor: [256, 160], fps: 45, plants: 1 },
  light: { pixelRatio: 1, shadows: false, shadowSize: 0, board: [640, 320], monitor: [192, 120], fps: 30, plants: 0.5 },
});
const ORDER = ['high', 'balanced', 'light'];

const MATERIALS = (dark) => ({
  plinth: { color: dark ? '#26282e' : '#f7f5f1', roughness: 0.9 },
  floor: { color: dark ? '#3a3a40' : '#ece3d6', roughness: 0.85 },
  wood: { color: dark ? '#7a604a' : '#c9ab86', roughness: 0.45 },
  walnut: { color: dark ? '#5b4435' : '#8a6a52', roughness: 0.4 },
  white: { color: dark ? '#4a4e58' : '#fbfaf8', roughness: 0.55 },
  metal: { color: dark ? '#9aa0aa' : '#b4b8bf', roughness: 0.28, metalness: 0.85 },
  dark: { color: dark ? '#0d0f13' : '#23252a', roughness: 0.3, metalness: 0.4 },
  bezel: { color: dark ? '#1a1c21' : '#d9d9dc', roughness: 0.25, metalness: 0.6 },
  wall: { color: dark ? '#434752' : '#ffffff', roughness: 0.92 },
  textile: { color: dark ? '#4c515c' : '#d9d4cc', roughness: 1 },
  plant: { color: dark ? '#3d5a45' : '#6f8f6f', roughness: 0.9, flatShading: true },
  pot: { color: dark ? '#4a4d55' : '#d8d2c8', roughness: 0.8 },
  glass: { color: dark ? '#9fb4d0' : '#dbe8f4', roughness: 0.04, metalness: 0.1, transparent: true, opacity: dark ? 0.14 : 0.22, depthWrite: false },
});

export function mountOffice3D(container, { state, dark = false, tokens = {}, quality = 'balanced', reducedMotion = false, on = {} }) {
  let tier = QUALITY[quality] ? quality : 'balanced';
  let settings = QUALITY[tier];
  let palette = surfacePalette(tokens, dark);
  let current = state;
  let selectedProject = null;
  let follow = false;
  let disposed = false;
  const disposables = [];
  const track = (item) => { disposables.push(item); return item; };

  // ------------------------------------------------------------ renderer
  const canvas = document.createElement('canvas');
  canvas.className = 'o3d-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  container.append(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: tier !== 'light', alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, settings.pixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = dark ? 1.15 : 1.05;
  renderer.shadowMap.enabled = settings.shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  canvas.addEventListener('webglcontextlost', (event) => { event.preventDefault(); fail(new Error('WebGL context lost')); });

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, 0.5, 400);

  // ------------------------------------------------------------ lights
  const hemi = new THREE.HemisphereLight(dark ? '#9fb3d9' : '#ffffff', dark ? '#2a241c' : '#d9d2c5', dark ? 1.05 : 1.25);
  const sun = new THREE.DirectionalLight(dark ? '#ffd2a1' : '#fff6ea', dark ? 1.25 : 2.1);
  sun.position.set(-18, 32, 22);
  sun.castShadow = settings.shadows;
  sun.shadow.mapSize.set(settings.shadowSize || 512, settings.shadowSize || 512);
  Object.assign(sun.shadow.camera, { left: -24, right: 24, top: 20, bottom: -20, near: 1, far: 90 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  const fill = new THREE.DirectionalLight(dark ? '#7f95c9' : '#dbe7ff', dark ? 0.35 : 0.45);
  fill.position.set(24, 14, -10);
  scene.add(hemi, sun, fill);
  // Image-based lighting: a soft studio environment gives wood, metal, glass
  // and screens real reflections (PBR). Skipped on the light tier, where
  // every per-pixel cost matters more than reflections.
  if (tier !== 'light') try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new THREE.RoomEnvironment();
    scene.environment = track(pmrem.fromScene(room, 0.04).texture);
    scene.environmentIntensity = dark ? 0.28 : 0.3;
    room.traverse?.((node) => { node.geometry?.dispose?.(); node.material?.dispose?.(); });
    pmrem.dispose();
    hemi.intensity = dark ? 0.75 : 0.7;
    renderer.toneMappingExposure = dark ? 1.15 : 0.95;
  } catch { /* lights alone still draw the Office */ }

  // ------------------------------------------------------------ helpers
  let mats = MATERIALS(dark);
  const materialCache = new Map();
  const material = (name) => {
    if (!materialCache.has(name)) materialCache.set(name, track(new THREE.MeshStandardMaterial(mats[name])));
    return materialCache.get(name);
  };
  const box = (w, h, d, mat, [x, y, z], parent, { shadow = true, receive = true } = {}) => {
    const mesh = new THREE.Mesh(track(new THREE.BoxGeometry(w, h, d)), typeof mat === 'string' ? material(mat) : mat);
    mesh.position.set(x, y, z); mesh.castShadow = shadow && settings.shadows; mesh.receiveShadow = receive;
    parent.add(mesh);
    return mesh;
  };
  const roundedSlab = (w, d, h, r, mat, [x, y, z], parent) => {
    const shape = new THREE.Shape();
    shape.moveTo(-w / 2 + r, -d / 2); shape.lineTo(w / 2 - r, -d / 2); shape.quadraticCurveTo(w / 2, -d / 2, w / 2, -d / 2 + r);
    shape.lineTo(w / 2, d / 2 - r); shape.quadraticCurveTo(w / 2, d / 2, w / 2 - r, d / 2); shape.lineTo(-w / 2 + r, d / 2);
    shape.quadraticCurveTo(-w / 2, d / 2, -w / 2, d / 2 - r); shape.lineTo(-w / 2, -d / 2 + r); shape.quadraticCurveTo(-w / 2, -d / 2, -w / 2 + r, -d / 2);
    const geometry = track(new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 2, curveSegments: 6 }));
    geometry.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, typeof mat === 'string' ? material(mat) : mat);
    mesh.position.set(x, y + h, z); mesh.castShadow = settings.shadows; mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  // Soft contact shadow under furniture (cheap ambient occlusion).
  const contactTexture = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    const gradient = g.createRadialGradient(64, 64, 4, 64, 64, 62);
    gradient.addColorStop(0, 'rgba(0,0,0,0.42)'); gradient.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gradient; g.fillRect(0, 0, 128, 128);
    return track(new THREE.CanvasTexture(c));
  })();
  const contactMaterial = track(new THREE.MeshBasicMaterial({ map: contactTexture, transparent: true, depthWrite: false, opacity: dark ? 0.9 : 0.55 }));
  const contact = (w, d, [x, z], parent) => {
    const mesh = new THREE.Mesh(track(new THREE.PlaneGeometry(w, d)), contactMaterial);
    mesh.rotation.x = -Math.PI / 2; mesh.position.set(x, 0.012, z); mesh.renderOrder = 1;
    parent.add(mesh);
  };
  const canvasTexture = ([w, h]) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const texture = track(new THREE.CanvasTexture(c));
    texture.colorSpace = THREE.SRGBColorSpace; texture.minFilter = THREE.LinearFilter; texture.generateMipmaps = false;
    return { canvas: c, texture };
  };
  const screenMaterial = (texture) => track(new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));

  // ------------------------------------------------------------ architecture
  const world = new THREE.Group();
  scene.add(world);
  box(PLINTH.width, PLINTH.height, PLINTH.depth, 'plinth', [0, -PLINTH.height / 2, PLINTH.centerZ], world, { shadow: false });
  const floorTexture = (() => {
    const c = document.createElement('canvas'); c.width = 1024; c.height = 1024;
    const g = c.getContext('2d');
    g.fillStyle = mats.floor.color; g.fillRect(0, 0, 1024, 1024);
    for (let row = 0; row < 32; row += 1) {
      const offset = (row * 173) % 256;
      for (let x = -offset; x < 1024; x += 256) {
        const shade = ((row * 31 + x * 7) % 9) / 9;
        g.fillStyle = dark ? `rgba(255,255,255,${0.012 + shade * 0.02})` : `rgba(120,90,50,${0.02 + shade * 0.035})`;
        g.fillRect(x + 1, row * 32 + 1, 254, 30);
      }
    }
    const texture = track(new THREE.CanvasTexture(c));
    texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4;
    return texture;
  })();
  const floor = new THREE.Mesh(track(new THREE.PlaneGeometry(PLINTH.width - 1.2, PLINTH.depth - 1.2)), track(new THREE.MeshStandardMaterial({ map: floorTexture, roughness: 0.78 })));
  floor.rotation.x = -Math.PI / 2; floor.position.set(0, 0.002, PLINTH.centerZ); floor.receiveShadow = true;
  world.add(floor);
  for (const wing of WINGS) {
    const rug = new THREE.Mesh(track(new THREE.PlaneGeometry(wing.width, wing.depth)), track(new THREE.MeshStandardMaterial({
      color: new THREE.Color(WING_ACCENTS[wing.id]).lerp(new THREE.Color(dark ? '#3a3a40' : '#f3eee6'), dark ? 0.88 : 0.8), roughness: 1, transparent: true, opacity: 0.85 })));
    rug.rotation.x = -Math.PI / 2; rug.position.set(wing.x, 0.006, wing.z); rug.receiveShadow = true;
    world.add(rug);
  }
  for (const [x1, z1, x2, z2] of WALLS) {
    const length = Math.hypot(x2 - x1, z2 - z1);
    const wall = box(length, 1.4, 0.24, 'wall', [(x1 + x2) / 2, 0.7, (z1 + z2) / 2], world);
    wall.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
  }
  for (const [x1, z1, x2, z2] of PARTITIONS) {
    const length = Math.hypot(x2 - x1, z2 - z1);
    const group = new THREE.Group();
    group.position.set((x1 + x2) / 2, 0, (z1 + z2) / 2); group.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
    const pane = box(length, 2.1, 0.03, 'glass', [0, 1.1, 0], group, { shadow: false, receive: false });
    pane.renderOrder = 2;
    box(length, 0.05, 0.07, 'metal', [0, 2.17, 0], group, { receive: false });
    box(length, 0.06, 0.08, 'metal', [0, 0.03, 0], group, { receive: false });
    world.add(group);
  }

  // Brand wall at the entrance and a small lounge.
  const brand = canvasTexture([1024, 200]);
  const drawBrand = () => {
    const g = brand.canvas.getContext('2d');
    g.fillStyle = dark ? '#1c1f26' : '#ffffff'; g.fillRect(0, 0, 1024, 200);
    g.fillStyle = tokens.accent || '#5e98ff'; g.beginPath(); g.roundRect(56, 60, 80, 80, 20); g.fill();
    g.fillStyle = '#ffffff'; g.font = '700 52px Inter, system-ui, sans-serif'; g.textAlign = 'center'; g.fillText('F', 96, 119);
    g.fillStyle = dark ? '#f2f2f4' : '#1d1d1f'; g.textAlign = 'left'; g.font = '600 64px Inter, system-ui, sans-serif'; g.fillText('Fahad AI Office', 168, 122);
    brand.texture.needsUpdate = true;
  };
  drawBrand();
  const brandWall = new THREE.Group();
  brandWall.position.set(ENTRANCE.brandWall.x, 0, ENTRANCE.brandWall.z);
  brandWall.rotation.y = 0.35;
  box(ENTRANCE.brandWall.width, ENTRANCE.brandWall.height, 0.3, 'wall', [0, ENTRANCE.brandWall.height / 2, 0], brandWall);
  const brandFace = new THREE.Mesh(track(new THREE.PlaneGeometry(ENTRANCE.brandWall.width * 0.86, ENTRANCE.brandWall.width * 0.86 * 200 / 1024)), screenMaterial(brand.texture));
  brandFace.position.set(0, ENTRANCE.brandWall.height * 0.55, 0.16);
  brandWall.add(brandFace);
  world.add(brandWall);
  const lounge = new THREE.Group();
  lounge.position.set(ENTRANCE.lounge.x, 0, ENTRANCE.lounge.z);
  box(3.2, 0.42, 1.0, 'textile', [0, 0.21, 0], lounge); box(3.2, 0.5, 0.25, 'textile', [0, 0.62, -0.38], lounge);
  roundedSlab(1.2, 0.7, 0.05, 0.3, 'walnut', [0, 0.36, 1.2], lounge);
  box(0.06, 0.36, 0.06, 'metal', [0, 0.18, 1.2], lounge);
  contact(4, 2.6, [0, 0.4], lounge);
  world.add(lounge);

  const plantGeometry = track(new THREE.IcosahedronGeometry(0.55, 1));
  const potGeometry = track(new THREE.CylinderGeometry(0.32, 0.26, 0.55, 16));
  const plant = (x, z, scale = 1) => {
    const group = new THREE.Group();
    group.position.set(x, 0, z); group.scale.setScalar(scale);
    const pot = new THREE.Mesh(potGeometry, material('pot')); pot.position.y = 0.275; pot.castShadow = settings.shadows;
    const leaves = new THREE.Mesh(plantGeometry, material('plant')); leaves.position.y = 1.05; leaves.scale.set(1, 1.35, 1); leaves.castShadow = settings.shadows;
    group.add(pot, leaves);
    contact(1.3, 1.3, [0, 0], group);
    world.add(group);
  };
  const plants = [[-18.6, -14.6], [18.6, -14.6], [-18.4, 9.8], [3.4, 9.3], [17.8, 8.4], [3.6, -14.5], [-4.6, 3.4], [4.6, 3.4], [-7.4, 9.5]];
  plants.slice(0, Math.ceil(plants.length * settings.plants)).forEach(([x, z], index) => plant(x, z, index > 6 ? 0.75 : 1));

  // ------------------------------------------------------------ workspaces
  const factory = createCharacterFactory(THREE, { dark });
  disposables.push({ dispose: factory.dispose });
  const workspaces = new Map();
  const pickables = [];
  const monitorGeometry = track(new THREE.BoxGeometry(0.62, 0.38, 0.03));
  const chairSeat = track(new THREE.BoxGeometry(0.52, 0.08, 0.5));
  const chairBack = track(new THREE.BoxGeometry(0.5, 0.6, 0.07));
  const chairPost = track(new THREE.CylinderGeometry(0.03, 0.03, 0.42, 8));
  const chairBase = track(new THREE.CylinderGeometry(0.28, 0.3, 0.04, 20));

  for (const [key, spec] of Object.entries(WORKSPACES)) {
    const group = new THREE.Group();
    group.position.set(spec.x, 0, spec.z); group.rotation.y = spec.yaw;
    group.userData = { key };
    const executive = spec.desk === 'executive';
    const studio = spec.desk === 'studio';
    const engineering = spec.desk === 'engineering';
    const deskWidth = executive ? 2.8 : studio ? 2.4 : engineering ? 2.3 : 1.9;
    const deskDepth = executive ? 1.15 : studio ? 1.2 : 0.95;
    // Desk: top + slim legs (executive: solid walnut pedestal).
    roundedSlab(deskWidth, deskDepth, 0.05, 0.08, executive ? 'walnut' : 'wood', [0, 0.72, 0], group);
    if (executive) box(deskWidth * 0.9, 0.7, 0.08, 'walnut', [0, 0.36, -deskDepth / 2 + 0.1], group);
    else for (const sx of [-1, 1]) box(0.05, 0.72, deskDepth * 0.85, 'metal', [sx * (deskWidth / 2 - 0.12), 0.36, 0], group);
    contact(deskWidth + 1.4, deskDepth + 2.2, [0, 0.4], group);
    // Monitors on the desk (engineering: two).
    const monitors = [];
    const monitorCount = engineering ? 2 : 1;
    for (let index = 0; index < monitorCount; index += 1) {
      const offset = monitorCount === 1 ? 0 : (index - 0.5) * 0.7;
      const stand = box(0.05, 0.28, 0.05, 'metal', [offset, 0.9, -deskDepth / 2 + 0.2], group, { receive: false });
      stand.castShadow = false;
      const frame = new THREE.Mesh(monitorGeometry, material('dark'));
      frame.position.set(offset, 1.14, -deskDepth / 2 + 0.2); frame.castShadow = settings.shadows;
      const surface = canvasTexture(settings.monitor);
      const screen = new THREE.Mesh(track(new THREE.PlaneGeometry(0.58, 0.34)), screenMaterial(surface.texture));
      screen.position.set(offset, 1.14, -deskDepth / 2 + 0.216);
      screen.userData.dynamic = true;
      // Monitors face the employee: the employee sits on +z looking to -z.
      group.add(frame, screen);
      monitors.push({ ...surface, screen });
    }
    // Chair + figure (the employee sits on the +z side, facing the desk).
    const seat = new THREE.Group();
    seat.position.set(0, 0, deskDepth / 2 + 0.45);
    seat.rotation.y = Math.PI;
    const base = new THREE.Mesh(chairBase, material('metal')); base.position.y = 0.02;
    const post = new THREE.Mesh(chairPost, material('metal')); post.position.y = 0.24;
    const cushion = new THREE.Mesh(chairSeat, material(executive ? 'dark' : 'textile')); cushion.position.y = 0.46; cushion.castShadow = settings.shadows;
    const back = new THREE.Mesh(chairBack, material(executive ? 'dark' : 'textile')); back.position.set(0, 0.8, -0.24); back.castShadow = settings.shadows;
    seat.add(base, post, cushion, back);
    const figure = factory.create({ accent: WING_ACCENTS[spec.wing] });
    figure.root.position.set(0, 0.5, 0.02);
    figure.root.userData.dynamic = true;
    figure.root.rotation.y = 0;
    seat.add(figure.root);
    group.add(seat);
    // The wall display behind the desk (for CHIEF: the project wall).
    const board = spec.board;
    const boardGroup = new THREE.Group();
    boardGroup.position.set(0, 0, -board.back);
    box(board.width + 0.06, board.height + 0.06, 0.05, 'bezel', [0, 1.1 + board.height / 2, -0.03], boardGroup, { receive: false });
    const surface = canvasTexture(executive ? [Math.round(settings.board[0] * 1.25), Math.round(settings.board[1] * 1.25 * board.height / board.width * 2)] : settings.board);
    const display = new THREE.Mesh(track(new THREE.PlaneGeometry(board.width, board.height)), screenMaterial(surface.texture));
    display.position.set(0, 1.1 + board.height / 2, 0.005);
    display.userData = { key, board: true, dynamic: true };
    boardGroup.add(display);
    box(0.08, 1.1, 0.08, 'metal', [-board.width / 2 + 0.3, 0.55, -0.04], boardGroup, { receive: false });
    box(0.08, 1.1, 0.08, 'metal', [board.width / 2 - 0.3, 0.55, -0.04], boardGroup, { receive: false });
    group.add(boardGroup);
    // Indicator above the employee (attention, waiting, warning, done, error).
    const indicator = new THREE.Group();
    indicator.position.set(0, 2.25, deskDepth / 2 + 0.45);
    const dot = new THREE.Mesh(track(new THREE.SphereGeometry(0.07, 16, 12)), track(new THREE.MeshBasicMaterial({ color: palette.warning, toneMapped: false })));
    const halo = new THREE.Mesh(track(new THREE.RingGeometry(0.11, 0.14, 32)), track(new THREE.MeshBasicMaterial({ color: palette.warning, transparent: true, opacity: 0.5, side: THREE.DoubleSide, toneMapped: false, depthWrite: false })));
    indicator.add(dot, halo);
    indicator.visible = false;
    indicator.userData.dynamic = true;
    group.add(indicator);
    addProps(key, spec, group, { deskWidth, deskDepth });
    // Hit volume for picking the whole workspace.
    const hit = new THREE.Mesh(track(new THREE.BoxGeometry(deskWidth + 0.8, 2.2, deskDepth + 1.6)), track(new THREE.MeshBasicMaterial({ visible: false })));
    hit.position.set(0, 1.1, 0.4); hit.userData = { key, dynamic: true };
    group.add(hit);
    pickables.push(hit, display);
    world.add(group);
    workspaces.set(key, { key, group, figure, monitors, board: { ...surface, display, kind: board.kind }, indicator, dot, halo, seed: pickables.length * 1.7,
      pose: POSES.relaxed, visual: stateVisual({ state: 'AVAILABLE' }), signature: '', dim: 1 });
  }

  // Distinct, data-free props give each area its identity (documents,
  // materials, hardware); real work stays on the screens.
  function addProps(key, spec, group, { deskWidth, deskDepth }) {
    const side = deskWidth / 2 + 0.9;
    if (key === 'chief') {
      for (const sx of [-0.8, 0.8]) {
        const guest = new THREE.Group(); guest.position.set(sx, 0, -deskDepth / 2 - 0.85);
        const seat = new THREE.Mesh(chairSeat, material('textile')); seat.position.y = 0.44; seat.castShadow = settings.shadows;
        const back = new THREE.Mesh(chairBack, material('textile')); back.position.set(0, 0.76, -0.24); back.castShadow = settings.shadows;
        const leg = new THREE.Mesh(chairPost, material('metal')); leg.position.y = 0.22;
        guest.add(seat, back, leg); group.add(guest);
      }
    }
    if (['research', 'legal', 'audit'].includes(key)) {
      // A low credenza with document stacks and binders.
      box(1.6, 0.62, 0.45, 'white', [side, 0.31, -0.4], group);
      for (let index = 0; index < (key === 'research' ? 4 : 3); index += 1) box(0.26, 0.06 + (index % 3) * 0.05, 0.34, index % 2 ? 'white' : 'textile', [side - 0.55 + index * 0.36, 0.66 + ((index % 3) * 0.025), -0.4], group);
    }
    if (key === 'creative') {
      // Material sample wall: architectural finishes, not brand data.
      const wall = new THREE.Group(); wall.position.set(-side - 0.3, 0, -1.2);
      box(1.3, 1.9, 0.06, 'white', [0, 1.15, 0], wall);
      const finishes = ['wood', 'walnut', 'metal', 'textile', 'pot', 'plant'];
      finishes.forEach((finish, index) => box(0.5, 0.42, 0.03, finish, [-0.3 + (index % 2) * 0.6, 1.75 - Math.floor(index / 2) * 0.55, 0.05], wall, { receive: false }));
      group.add(wall);
    }
    if (key === 'social') {
      for (const sx of [-0.55, 0.55]) { const phone = box(0.14, 0.26, 0.012, 'dark', [sx, 0.92, -0.1], group, { receive: false }); phone.rotation.x = -0.35; }
    }
    if (key === 'coding') {
      box(0.62, 1.25, 0.62, 'dark', [side + 0.2, 0.625, -0.6], group);
      for (let index = 0; index < 5; index += 1) box(0.5, 0.02, 0.01, 'metal', [side + 0.2, 0.3 + index * 0.2, -0.28], group, { receive: false });
    }
    if (key === 'product') {
      const stand = new THREE.Group(); stand.position.set(-side, 0, -0.5); stand.rotation.y = 0.35;
      box(1.1, 0.75, 0.03, 'white', [0, 1.35, 0], stand); box(0.04, 1.0, 0.04, 'metal', [0, 0.5, 0], stand);
      group.add(stand);
    }
    if (key === 'finance') {
      const frame = new THREE.Mesh(monitorGeometry, material('dark'));
      frame.position.set(0.72, 1.12, -deskDepth / 2 + 0.28); frame.rotation.y = -0.35; frame.castShadow = settings.shadows;
      group.add(frame);
    }
  }

  // Needs Fahad beacon beside CHIEF.
  const beacon = new THREE.Group();
  beacon.position.set(WORKSPACES.chief.x + 2.2, 0, WORKSPACES.chief.z + 1.2);
  box(0.05, 1.9, 0.05, 'metal', [0, 0.95, 0], beacon, { receive: false });
  const beaconLight = new THREE.Mesh(track(new THREE.SphereGeometry(0.16, 20, 14)), track(new THREE.MeshBasicMaterial({ color: palette.warning, toneMapped: false })));
  beaconLight.position.y = 2.0;
  const beaconHalo = new THREE.Mesh(track(new THREE.RingGeometry(0.24, 0.32, 40)), track(new THREE.MeshBasicMaterial({ color: palette.warning, transparent: true, opacity: 0.45, side: THREE.DoubleSide, toneMapped: false, depthWrite: false })));
  beaconHalo.position.y = 2.0;
  beacon.add(beaconLight, beaconHalo);
  beacon.visible = false;
  beacon.userData.dynamic = true;
  beaconLight.userData = { beacon: true };
  pickables.push(beaconLight);
  world.add(beacon);

  // ------------------------------------------------------------ batching
  // Static furniture and architecture are merged per material (within each
  // workspace, so Project Mode can still dim a workspace): far fewer draw
  // calls, same look.
  const mergeStatic = (root) => {
    root.updateMatrixWorld(true);
    const inverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const buckets = new Map();
    const visit = (node) => {
      if (node.userData.dynamic) return;
      if (node.isMesh && node !== root && node.material?.isMeshStandardMaterial || node.isMesh && node.material === contactMaterial) {
        const bucket = buckets.get(node.material) || { meshes: [], cast: false };
        bucket.meshes.push(node); bucket.cast ||= node.castShadow;
        buckets.set(node.material, bucket);
      }
      for (const child of node.children) if (!(child.isGroup && workspaces.has(child.userData.key) && root === world)) visit(child);
    };
    for (const child of root.children) visit(child);
    for (const [mat, bucket] of buckets) {
      if (bucket.meshes.length < 2) continue;
      const positions = []; const normals = []; const uvs = [];
      for (const mesh of bucket.meshes) {
        const matrix = new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld);
        const geometry = (mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()).applyMatrix4(matrix);
        const count = geometry.attributes.position.count;
        positions.push(...geometry.attributes.position.array);
        normals.push(...(geometry.attributes.normal ? geometry.attributes.normal.array : new Float32Array(count * 3)));
        uvs.push(...(geometry.attributes.uv ? geometry.attributes.uv.array : new Float32Array(count * 2)));
        geometry.dispose();
        mesh.parent.remove(mesh);
      }
      const merged = track(new THREE.BufferGeometry());
      merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      merged.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = bucket.cast && settings.shadows; mesh.receiveShadow = true;
      if (mat === contactMaterial) mesh.renderOrder = 1;
      root.add(mesh);
    }
  };
  for (const workspace of workspaces.values()) mergeStatic(workspace.group);
  mergeStatic(world);

  // ------------------------------------------------------------ handoffs
  const handoffGroup = new THREE.Group();
  handoffGroup.userData.dynamic = true;
  world.add(handoffGroup);
  let handoffs = [];
  const packetGeometry = track(new THREE.SphereGeometry(0.11, 16, 12));
  const seenPackets = new Set();
  const buildHandoffs = () => {
    for (const child of [...handoffGroup.children]) { handoffGroup.remove(child); child.geometry?.dispose(); }
    handoffs = [];
    const unique = new Map();
    for (const handoff of current.handoffs) { const pair = `${handoff.fromKey}>${handoff.toKey}`; if (!unique.has(pair)) unique.set(pair, handoff); }
    for (const handoff of unique.values()) {
      const from = anchor(handoff.fromKey); const to = anchor(handoff.toKey);
      if (!from || !to) continue;
      const mid = new THREE.Vector3((from[0] + to[0]) / 2, 3.2 + Math.hypot(to[0] - from[0], to[2] - from[2]) * 0.08, (from[2] + to[2]) / 2);
      const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(...from), mid, new THREE.Vector3(...to));
      const inProject = (!selectedProject || handoff.jobId === selectedProject) && (!focused || handoff.fromKey === focused || handoff.toKey === focused);
      const line = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, focused ? 0.014 : handoff.fresh ? 0.05 : 0.032, 6, false),
        track(new THREE.MeshBasicMaterial({ color: palette.accent, transparent: true, opacity: inProject ? (handoff.fresh ? 0.9 : 0.55) : 0.08, toneMapped: false, depthWrite: false })));
      const hit = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.35, 6, false), track(new THREE.MeshBasicMaterial({ visible: false })));
      hit.userData = { handoff };
      handoffGroup.add(line, hit);
      pickables.push(hit);
      const record = { handoff, curve, line, hit, packet: null, t: 0 };
      const key = `${handoff.id}@${handoff.at}`;
      if (handoff.fresh && inProject && !reducedMotion && !seenPackets.has(key)) {
        record.packet = new THREE.Mesh(packetGeometry, track(new THREE.MeshBasicMaterial({ color: palette.accent, toneMapped: false })));
        record.packet.position.copy(curve.getPoint(0));
        handoffGroup.add(record.packet);
      }
      seenPackets.add(key);
      handoffs.push(record);
    }
    for (let index = pickables.length - 1; index >= 0; index -= 1) if (pickables[index].userData.handoff && !handoffGroup.children.includes(pickables[index])) pickables.splice(index, 1);
  };

  // ------------------------------------------------------------ labels (DOM)
  // Real buttons over the scene: readable, keyboard-reachable, and the
  // accessible equivalent of clicking a 3D workspace.
  const labels = document.createElement('div');
  labels.className = 'o3d-labels';
  container.append(labels);
  const labelFor = new Map();
  for (const key of workspaces.keys()) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'o3d-label'; button.dataset.key = key;
    // First click flies to the workspace; a click on the focused workspace
    // (or Enter from the keyboard) opens the employee panel.
    button.onpointerdown = () => { button.dataset.armed = String(focused === key); };
    button.onclick = () => { const open = button.dataset.armed !== 'false'; delete button.dataset.armed; if (open) on.select?.(key); else if (focused !== key) focus(key); };
    button.onfocus = () => focus(key);
    labels.append(button);
    labelFor.set(key, button);
  }
  const beaconButton = document.createElement('a');
  beaconButton.className = 'o3d-label o3d-needs'; beaconButton.href = '#/attention';
  labels.append(beaconButton);

  // ------------------------------------------------------------ state → scene
  const drawSurfaces = (force = false) => {
    for (const [key, workspace] of workspaces) {
      const employee = current.employees.find((entry) => entry.key === key);
      const visual = stateVisual(employee || { state: 'AVAILABLE', key });
      const signature = JSON.stringify([employee?.state, employee?.task, employee?.artifact?.id, employee?.coding, key === 'chief' ? [current.projects, current.summary, selectedProject] : null, dark]);
      workspace.visual = visual;
      workspace.pose = POSES[visual.pose] || POSES.relaxed;
      if (!force && signature === workspace.signature) continue;
      workspace.signature = signature;
      if (key === 'chief') drawProjectWall(workspace.board.canvas, { state: current, palette, selected: selectedProject });
      else if (key === 'coding') drawEngineeringPanel(workspace.board.canvas, { employee, panel: visual.panel, palette, stages: CODING_STAGES });
      else drawBoard(workspace.board.canvas, { kind: workspace.board.kind, employee, visual, palette, seed: workspace.seed });
      workspace.board.texture.needsUpdate = true;
      for (const monitor of workspace.monitors) { drawMonitor(monitor.canvas, { visual, palette, label: employee?.label || key.toUpperCase() }); monitor.texture.needsUpdate = true; }
      const tone = { attention: palette.warning, waiting: palette.muted, warning: palette.warning, done: palette.success, error: palette.danger }[visual.indicator];
      // COMPLETED shows a brief pulse only when the scene sees it happen.
      const justCompleted = visual.indicator === 'done' && workspace.lastState && workspace.lastState !== 'COMPLETED';
      workspace.lastState = employee?.state || 'AVAILABLE';
      workspace.indicator.visible = Boolean(visual.indicator) && visual.indicator !== 'waiting' && (visual.indicator !== 'done' || justCompleted);
      if (tone) { workspace.dot.material.color.set(tone); workspace.halo.material.color.set(tone); }
      workspace.completedAt = justCompleted ? performance.now() : 0;
    }
  };
  const drawLabels = () => {
    for (const employee of current.employees) {
      const button = labelFor.get(employee.key);
      if (!button) continue;
      const inProject = !selectedProject || current.projects.find((project) => project.id === selectedProject)?.team.includes(employee.key);
      button.dataset.state = employee.state;
      button.classList.toggle('dimmed', !inProject);
      button.innerHTML = `<span class="o3d-name">${escape(employee.label)}</span><span class="o3d-state">${escape(stateWord(employee.visual))}</span>${employee.task ? `<span class="o3d-task" dir="auto">${escape(employee.task)}</span>` : ''}<span class="o3d-open" aria-hidden="true">Open panel ›</span>`;
      button.setAttribute('aria-label', `${employee.label}: ${stateWord(employee.visual)}${employee.task ? ` — ${employee.task}` : ''}. Open workspace`);
    }
    beaconButton.hidden = !current.needsFahad;
    beaconButton.textContent = `${current.needsFahad} ${current.needsFahad === 1 ? 'needs' : 'need'} you`;
    beaconButton.setAttribute('aria-label', `${current.needsFahad} ${current.needsFahad === 1 ? 'item needs' : 'items need'} your attention. Open Needs Fahad`);
    beacon.visible = current.needsFahad > 0;
  };
  const applyProjectDim = () => {
    const team = selectedProject ? current.projects.find((project) => project.id === selectedProject)?.team || [] : null;
    for (const [key, workspace] of workspaces) {
      const target = !team || team.includes(key) || key === 'chief' ? 1 : 0.28;
      workspace.dim = target;
    }
  };

  // ------------------------------------------------------------ camera rig
  const view = { target: new THREE.Vector3(...CAMERA.overview.target), azimuth: CAMERA.overview.azimuth, polar: CAMERA.overview.polar, distance: CAMERA.overview.distance };
  let tween = null;
  const placeCamera = () => {
    const sinPolar = Math.sin(view.polar);
    camera.position.set(view.target.x + view.distance * sinPolar * Math.sin(view.azimuth), view.target.y + view.distance * Math.cos(view.polar), view.target.z + view.distance * sinPolar * Math.cos(view.azimuth));
    camera.lookAt(view.target);
  };
  const moveTo = (preset, duration = 900) => {
    const to = { target: new THREE.Vector3(...preset.target), azimuth: preset.azimuth, polar: preset.polar, distance: preset.distance };
    if (reducedMotion || duration === 0) { Object.assign(view, { ...to, target: to.target }); placeCamera(); wake(); return; }
    tween = { from: { target: view.target.clone(), azimuth: view.azimuth, polar: view.polar, distance: view.distance }, to, start: performance.now(), duration };
    wake();
  };
  let focused = null;
  // The overview distance is fitted to the stage so the whole plinth shows
  // at any aspect ratio.
  let overviewPreset = { ...CAMERA.overview };
  const fitOverview = () => {
    const corners = [];
    // Fit the furnished area (walls, workspaces, entrance); the plinth's far
    // corners may be cropped slightly.
    for (const x of [-19.6, 19.6]) for (const z of [-15.6, 9.8]) for (const y of [0, 3.6]) corners.push(new THREE.Vector3(x, y, z));
    const probe = camera.clone();
    const fits = (distance) => {
      const sin = Math.sin(CAMERA.overview.polar);
      const [tx, ty, tz] = CAMERA.overview.target;
      probe.position.set(tx + distance * sin * Math.sin(CAMERA.overview.azimuth), ty + distance * Math.cos(CAMERA.overview.polar), tz + distance * sin * Math.cos(CAMERA.overview.azimuth));
      probe.lookAt(tx, ty, tz); probe.updateMatrixWorld(); probe.updateProjectionMatrix();
      return corners.every((corner) => { const p = corner.clone().project(probe); return Math.abs(p.x) < 1.1 && p.y < 0.78 && p.y > -1.02; });
    };
    let low = 20; let high = 140;
    for (let step = 0; step < 18; step += 1) { const mid = (low + high) / 2; if (fits(mid)) high = mid; else low = mid; }
    overviewPreset = { ...CAMERA.overview, distance: high };
  };
  function focus(key) { focused = key; labels.classList.add('zoomed'); buildHandoffs(); moveTo(focusPreset(key)); on.focus?.(key); }
  const overview = () => { focused = null; labels.classList.remove('zoomed'); buildHandoffs(); moveTo(overviewPreset); on.focus?.(null); };

  // Gentle orbit (drag) and zoom (wheel) — clicks remain the main interaction.
  let drag = null;
  canvas.addEventListener('pointerdown', (event) => { drag = { x: event.clientX, y: event.clientY, azimuth: view.azimuth, polar: view.polar, moved: false }; });
  window.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointermove', (event) => {
    if (drag) {
      const dx = event.clientX - drag.x; const dy = event.clientY - drag.y;
      if (Math.hypot(dx, dy) > 4) drag.moved = true;
      if (drag.moved) {
        tween = null;
        view.azimuth = clamp(drag.azimuth - dx * 0.004, -0.4, 1.9);
        view.polar = clamp(drag.polar - dy * 0.003, 0.55, 1.25);
        placeCamera(); wake();
      }
      return;
    }
    hover(event);
  });
  canvas.addEventListener('wheel', (event) => { event.preventDefault(); tween = null; view.distance = clamp(view.distance * (1 + Math.sign(event.deltaY) * 0.08), 9, 80); placeCamera(); wake(); }, { passive: false });
  function onPointerUp(event) {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (!moved && event.target === canvas) pick(event);
  }
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const hitAt = (event) => {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObjects(pickables, false)[0]?.object || null;
  };
  let hovered = null;
  const hover = (event) => {
    const object = hitAt(event);
    canvas.style.cursor = object ? 'pointer' : 'grab';
    const key = object?.userData.key || null;
    if (key !== hovered) { if (hovered) labelFor.get(hovered)?.classList.remove('hover'); hovered = key; if (key) labelFor.get(key)?.classList.add('hover'); }
  };
  const pick = (event) => {
    const object = hitAt(event);
    if (!object) return;
    if (object.userData.handoff) return on.handoff?.(object.userData.handoff);
    if (object.userData.beacon) { location.hash = '#/attention'; return; }
    if (object.userData.board && object.userData.key) {
      const employee = current.employees.find((entry) => entry.key === object.userData.key);
      if (employee?.artifact) return on.artifact?.(employee.artifact);
    }
    if (object.userData.key) { if (focused === object.userData.key) on.select?.(object.userData.key); else focus(object.userData.key); }
  };

  // ------------------------------------------------------------ loop
  const born = performance.now();
  let awake = true;
  let lastFrame = 0;
  const frames = [];
  let slowSince = 0;
  function wake() { awake = true; }
  const project = new THREE.Vector3();
  const loop = () => {
    if (disposed) return;
    const now = performance.now();
    if (document.hidden) return;
    if (now - lastFrame < 1000 / settings.fps - 1) return;
    const delta = now - lastFrame; lastFrame = now;
    const time = (now - born) / 1000;
    let animating = false;
    try {
      if (tween) {
        const t = Math.min(1, (now - tween.start) / tween.duration);
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        view.target.lerpVectors(tween.from.target, tween.to.target, e);
        view.azimuth = tween.from.azimuth + (tween.to.azimuth - tween.from.azimuth) * e;
        view.polar = tween.from.polar + (tween.to.polar - tween.from.polar) * e;
        view.distance = tween.from.distance + (tween.to.distance - tween.from.distance) * e;
        placeCamera();
        if (t >= 1) tween = null;
        animating = true;
      }
      for (const workspace of workspaces.values()) {
        const motion = motionFor(workspace.visual, { reducedMotion });
        applyPose(workspace.figure, workspace.pose, { time, ambient: motion.ambient, task: motion.task, seed: workspace.seed });
        if (workspace.completedAt && now - workspace.completedAt > 6000) { workspace.indicator.visible = false; workspace.completedAt = 0; }
        if (workspace.indicator.visible && !reducedMotion) {
          const pulse = workspace.visual.indicator === 'attention' ? 1 + Math.sin(time * 2.4) * 0.12 : 1;
          workspace.halo.scale.setScalar(pulse);
          workspace.indicator.rotation.y = 0;
          workspace.indicator.lookAt(camera.position);
        }
        if (workspace.lastDim !== workspace.dim) {
          workspace.lastDim = workspace.dim;
          setDim(workspace.group, workspace.dim);
        }
        if (motion.ambient) animating = true;
      }
      if (beacon.visible && !reducedMotion) { beaconHalo.scale.setScalar(1 + Math.sin(time * 2.2) * 0.15); beaconHalo.lookAt(camera.position); animating = true; }
      for (const record of handoffs) {
        if (!record.packet) continue;
        record.t = Math.min(1, record.t + delta / 1900);
        const e = 1 - Math.pow(1 - record.t, 3);
        record.packet.position.copy(record.curve.getPoint(e));
        if (record.t >= 1) { handoffGroup.remove(record.packet); record.packet = null; }
        animating = true;
      }
      if (awake || animating) {
        renderer.render(scene, camera);
        placeLabels();
      }
      awake = false;
      frames.push(delta);
      if (frames.length > 90) frames.shift();
      watchPerformance(now);
    } catch (error) { fail(error); }
  };
  // Labels follow their workspace; overlapping labels are nudged apart
  // (nearer workspaces keep their place), so names never cover each other.
  const placeLabels = () => {
    const rect = canvas.getBoundingClientRect();
    const placed = [];
    const entries = [...workspaces].map(([key, workspace]) => {
      // Overview: above the employee. Focus: under the desk, so the wall
      // display (the real work) stays uncovered.
      if (focused) project.set(0, 0.05, 1.9).applyMatrix4(workspace.group.matrixWorld);
      else project.set(0, 2.45, 0.9).applyMatrix4(workspace.group.matrixWorld);
      const depth = project.distanceTo(camera.position);
      project.project(camera);
      return { key, x: ((project.x + 1) / 2) * rect.width, y: ((1 - project.y) / 2) * rect.height, visible: project.z < 1, depth };
    }).sort((a, b) => a.depth - b.depth);
    for (const entry of entries) {
      const button = labelFor.get(entry.key);
      const width = button.offsetWidth || 110; const height = button.offsetHeight || 40;
      let top = focused ? entry.y + 6 : entry.y - height;
      for (let pass = 0; pass < 6; pass += 1) {
        const clash = placed.find((box) => Math.abs(box.x - entry.x) < (box.width + width) / 2 + 4 && top < box.top + box.height + 3 && top + height > box.top - 3);
        if (!clash) break;
        top = clash.top - height - 4;
      }
      // A workspace outside the frame hides its label instead of piling up at the edge.
      const onScreen = entry.visible && entry.x > -width / 2 && entry.x < rect.width + width / 2 && entry.y > -20 && entry.y < rect.height + 20;
      if (!onScreen) { button.style.visibility = 'hidden'; continue; }
      top = Math.max(56, Math.min(rect.height - height - 10, top));
      const left = Math.max(8, Math.min(rect.width - width - 8, entry.x - width / 2));
      placed.push({ x: left + width / 2, top, width, height });
      button.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
      button.style.visibility = 'visible';
      button.classList.toggle('focused', focused === entry.key);
    }
    if (!beaconButton.hidden) {
      project.set(0, 2.0, 0).applyMatrix4(beacon.matrixWorld).project(camera);
      beaconButton.style.transform = `translate(${Math.round(((project.x + 1) / 2) * rect.width + 14)}px, ${Math.round(((1 - project.y) / 2) * rect.height - 14)}px)`;
    }
  };
  // Frame-rate watchdog: step quality down, then give up gracefully.
  const watchPerformance = (now) => {
    if (frames.length < 60 || reducedMotion) return;
    const fps = 1000 / (frames.reduce((sum, value) => sum + value, 0) / frames.length);
    const floor = Math.min(22, settings.fps * 0.5);
    if (fps >= floor) { slowSince = 0; return; }
    if (!slowSince) { slowSince = now; return; }
    if (now - slowSince < 4000) return;
    slowSince = 0; frames.length = 0;
    const next = ORDER[ORDER.indexOf(tier) + 1];
    if (next) setQuality(next);
    else on.slow?.(fps);
  };
  function setQuality(next) {
    tier = next; settings = QUALITY[next];
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, settings.pixelRatio));
    renderer.shadowMap.enabled = settings.shadows; sun.castShadow = settings.shadows;
    resize(); on.quality?.(next);
  }

  // ------------------------------------------------------------ resize / dispose
  const resize = () => {
    const { clientWidth: width, clientHeight: height } = container;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height; camera.updateProjectionMatrix();
    const wasOverview = !focused && !tween && Math.abs(view.distance - overviewPreset.distance) < 0.01;
    fitOverview();
    if (wasOverview || !fittedOnce) { fittedOnce = true; Object.assign(view, { target: new THREE.Vector3(...overviewPreset.target), azimuth: overviewPreset.azimuth, polar: overviewPreset.polar, distance: overviewPreset.distance }); placeCamera(); }
    wake();
  };
  let fittedOnce = false;
  // Escape returns to the overview (keyboard equivalent of "back").
  const onKey = (event) => { if (event.key === 'Escape' && focused && !document.querySelector('.sheet-backdrop, dialog[open]')) overview(); };
  container.addEventListener('keydown', onKey);
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  const onVisibility = () => { if (!document.hidden) { lastFrame = 0; wake(); } };
  document.addEventListener('visibilitychange', onVisibility);

  function fail(error) {
    if (disposed) return;
    on.error?.(error);
  }

  // ------------------------------------------------------------ public API
  const update = (next) => {
    const previous = current;
    current = next;
    drawSurfaces();
    buildHandoffs();
    drawLabels();
    applyProjectDim();
    followWork(previous, next);
    wake();
  };
  // FOLLOW WORK: only major events move the camera, at most every 20 s.
  let lastFollow = 0;
  const followWork = (previous, next) => {
    if (!follow || !previous || performance.now() - lastFollow < 20_000) return;
    const before = new Map(previous.employees.map((employee) => [employee.key, employee.state]));
    const major = next.employees.find((employee) => employee.state !== before.get(employee.key) && ['NEEDS FAHAD', 'COMPLETED'].includes(employee.state))
      || next.employees.find((employee) => employee.state !== before.get(employee.key) && employee.active && before.get(employee.key) === 'AVAILABLE');
    const fresh = next.handoffs.find((handoff) => handoff.fresh && !previous.handoffs.some((old) => old.id === handoff.id));
    const key = major?.key || fresh?.toKey;
    if (!key) return;
    lastFollow = performance.now();
    focus(key);
  };

  placeCamera(); resize();
  update(state);
  renderer.setAnimationLoop(loop);

  return {
    update,
    focus,
    overview,
    setProject(id) { selectedProject = id || null; drawSurfaces(true); buildHandoffs(); drawLabels(); applyProjectDim(); if (id) overview(); wake(); },
    setFollow(value) { follow = Boolean(value); },
    stats() {
      const fps = frames.length ? Math.round(1000 / (frames.reduce((sum, value) => sum + value, 0) / frames.length)) : null;
      return { quality: tier, fps, drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures };
    },
    dispose() {
      disposed = true;
      renderer.setAnimationLoop(null);
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      container.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerup', onPointerUp);
      for (const child of handoffGroup.children) child.geometry?.dispose();
      for (const item of disposables) item.dispose?.();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove(); labels.remove();
    },
  };
}

// Dimming for Project Mode: employees outside the project fade back.
function setDim(group, value) {
  group.traverse((node) => {
    if (!node.isMesh || !node.material || node.material.visible === false) return;
    const material = node.material;
    if (!node.userData.dimMaterial) {
      if (value === 1) return;
      node.userData.original = material;
      node.userData.dimMaterial = material.clone();
      node.userData.dimMaterial.transparent = true;
    }
    if (value === 1) { node.material = node.userData.original; return; }
    node.userData.dimMaterial.opacity = (node.userData.original.opacity ?? 1) * value;
    node.material = node.userData.dimMaterial;
  });
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const stateWord = (value) => (String(value || '').charAt(0) + String(value || '').slice(1).toLowerCase()).replace(/\bfahad\b/, 'Fahad');
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
