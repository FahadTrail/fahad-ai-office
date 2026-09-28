// The Office's employees as 3D figures. Abstract, human-like, professional:
// a calm ceramic-matte figure with a thin role accent at the collar — no
// faces, no names, no costumes. Geometry and materials are built here;
// which pose to show comes from state-visuals.js; the scene decides when.
// Replace this module to change the character style without touching logic.

// Muted, cohesive wing accents (the Office stays one visual system).
export const WING_ACCENTS = Object.freeze({
  atrium: '#6f8fbf', intelligence: '#6b7fa8', strategy: '#7d9a86', creative: '#b08a72', build: '#7b76b0',
});

export function createCharacterFactory(THREE, { dark }) {
  const skin = new THREE.MeshStandardMaterial({ color: dark ? '#5d6069' : '#e7e2da', roughness: 0.62, metalness: 0.02 });
  const cloth = new THREE.MeshStandardMaterial({ color: dark ? '#2c3039' : '#c9c3ba', roughness: 0.8, metalness: 0 });
  const geometries = {
    torso: new THREE.CapsuleGeometry(0.2, 0.38, 6, 16),
    head: new THREE.SphereGeometry(0.135, 24, 16),
    neck: new THREE.CylinderGeometry(0.055, 0.065, 0.1, 12),
    upperArm: new THREE.CapsuleGeometry(0.055, 0.22, 4, 8),
    forearm: new THREE.CapsuleGeometry(0.05, 0.22, 4, 8),
    thigh: new THREE.CapsuleGeometry(0.075, 0.3, 4, 8),
    shin: new THREE.CapsuleGeometry(0.065, 0.34, 4, 8),
    collar: new THREE.TorusGeometry(0.105, 0.012, 8, 32),
  };
  const accents = new Map();
  const accentMaterial = (color) => {
    if (!accents.has(color)) accents.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.2, emissive: color, emissiveIntensity: dark ? 0.35 : 0.08 }));
    return accents.get(color);
  };

  // A seated figure; origin at the seat, facing +z.
  function create({ accent }) {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const mesh = (geometry, material, position, rotation = [0, 0, 0], scale = [1, 1, 1]) => {
      const node = new THREE.Mesh(geometry, material);
      node.position.set(...position); node.rotation.set(...rotation); node.scale.set(...scale);
      // Only the torso and head cast shadows (limbs add draw calls, not depth).
      node.castShadow = geometry === geometries.torso || geometry === geometries.head;
      return node;
    };
    const torso = mesh(geometries.torso, cloth, [0, 0.42, 0], [0, 0, 0], [1.15, 1, 0.78]);
    const neck = mesh(geometries.neck, skin, [0, 0.75, 0.01]);
    const head = new THREE.Group();
    head.position.set(0, 0.9, 0.02);
    head.add(mesh(geometries.head, skin, [0, 0, 0], [0, 0, 0], [1, 1.12, 1.02]));
    const collar = mesh(geometries.collar, accentMaterial(accent), [0, 0.71, 0.01], [Math.PI / 2, 0, 0], [1.25, 1, 1]);
    body.add(torso, neck, head, collar);
    const arm = (side) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.24, 0.62, 0);
      const upper = mesh(geometries.upperArm, cloth, [0, -0.15, 0]);
      const elbow = new THREE.Group();
      elbow.position.set(0, -0.3, 0);
      elbow.add(mesh(geometries.forearm, skin, [0, -0.14, 0]));
      shoulder.add(upper, elbow);
      body.add(shoulder);
      return { shoulder, elbow };
    };
    const left = arm(-1);
    const right = arm(1);
    const leg = (side) => {
      const hip = new THREE.Group();
      hip.position.set(side * 0.11, 0.06, 0.05);
      hip.rotation.x = -Math.PI / 2;
      hip.add(mesh(geometries.thigh, cloth, [0, -0.2, 0]));
      const knee = new THREE.Group();
      knee.position.set(0, -0.42, 0);
      knee.rotation.x = Math.PI / 2;
      knee.add(mesh(geometries.shin, cloth, [0, -0.2, 0]));
      hip.add(knee);
      root.add(hip);
    };
    leg(-1); leg(1);
    return { root, body, head, left, right };
  }

  const dispose = () => { Object.values(geometries).forEach((geometry) => geometry.dispose()); skin.dispose(); cloth.dispose(); accents.forEach((material) => material.dispose()); };
  return { create, dispose };
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
