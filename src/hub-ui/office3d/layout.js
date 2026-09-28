// The Office as a place: an architectural plan in metres. Pure data — the
// scene builds geometry from it and tests check it. Wings group work the way
// the organisation works:
//
//   back:   CREATIVE STUDIO (Creative, Social)        BUILD STUDIO (Coding)
//   left:   INTELLIGENCE WING (Research, Legal, Audit)
//   centre: EXECUTIVE ATRIUM (CHIEF + project wall)
//   right:  STRATEGY WING (Product, Finance)
//   front:  entrance, brand wall and a small lounge
//
// Camera looks from the front-right; every workstation faces into the room.

export const PLINTH = Object.freeze({ width: 40, depth: 28, height: 0.35, centerZ: -2 });

export const WINGS = Object.freeze([
  { id: 'atrium', label: 'Executive Atrium', x: 0, z: -0.5, width: 12, depth: 10 },
  { id: 'intelligence', label: 'Intelligence Wing', x: -13.5, z: 0, width: 11, depth: 13 },
  { id: 'strategy', label: 'Strategy Wing', x: 13.5, z: -1.5, width: 11, depth: 9 },
  { id: 'creative', label: 'Creative Studio', x: -9.25, z: -11, width: 15.5, depth: 6.5 },
  { id: 'build', label: 'Build Studio', x: 9, z: -11, width: 11, depth: 6.5 },
]);

// Everyone faces their desk and wall display (towards -z), so from the
// Office's viewpoint Fahad looks over each employee's shoulder at the real
// work on their screens. yaw is kept for future layouts.
export const WORKSPACES = Object.freeze({
  chief: { wing: 'atrium', x: 0, z: 0.4, yaw: 0, desk: 'executive', board: { width: 6.6, height: 2.5, back: 3.2, kind: 'project-wall' } },
  research: { wing: 'intelligence', x: -16, z: -2.4, yaw: 0, desk: 'standard', board: { width: 3.4, height: 1.9, back: 2.4, kind: 'intelligence-wall' } },
  legal: { wing: 'intelligence', x: -11, z: -2.4, yaw: 0, desk: 'standard', board: { width: 3.2, height: 1.8, back: 2.4, kind: 'document-wall' } },
  audit: { wing: 'intelligence', x: -13.5, z: 4.6, yaw: 0, desk: 'standard', board: { width: 3.4, height: 1.8, back: 2.4, kind: 'review-board' } },
  product: { wing: 'strategy', x: 11, z: -1.4, yaw: 0, desk: 'standard', board: { width: 3.6, height: 1.9, back: 2.4, kind: 'roadmap-board' } },
  finance: { wing: 'strategy', x: 16, z: -1.4, yaw: 0, desk: 'standard', board: { width: 3.4, height: 1.9, back: 2.4, kind: 'finance-screen' } },
  creative: { wing: 'creative', x: -13, z: -10, yaw: 0, desk: 'studio', board: { width: 4.4, height: 2.2, back: 2.5, kind: 'moodboard-wall' } },
  social: { wing: 'creative', x: -6, z: -10, yaw: 0, desk: 'studio', board: { width: 4, height: 2.1, back: 2.5, kind: 'content-wall' } },
  coding: { wing: 'build', x: 9, z: -10, yaw: 0, desk: 'engineering', board: { width: 5, height: 2.2, back: 2.5, kind: 'engineering-panel' } },
});

// Glass partitions (x1,z1 → x2,z2) with door gaps; low perimeter walls give
// the architectural-model look without hiding work.
export const PARTITIONS = Object.freeze([
  [-7.5, -7, -7.5, -2], [-7.5, 2, -7.5, 8],
  [7.5, -7, 7.5, -2.5], [7.5, 1.5, 7.5, 4],
  [-18.5, -6.8, -12, -6.8], [-9, -6.8, 3, -6.8], [6, -6.8, 18.5, -6.8],
  [2.5, -15, 2.5, -8.5],
]);
export const WALLS = Object.freeze([
  [-19.6, -15.6, 19.6, -15.6], [-19.6, -15.6, -19.6, 8], [19.6, -15.6, 19.6, 5],
]);

export const ENTRANCE = Object.freeze({ brandWall: { x: -3.5, z: 9.2, width: 7, height: 1.35 }, lounge: { x: 12.5, z: 7 } });

// Camera presets: an architectural overview and a framed view per workspace.
export const CAMERA = Object.freeze({
  fov: 32,
  overview: { target: [0, 0, -3], azimuth: 0.42, polar: 0.9, distance: 58 },
  focusDistance: 11.5, focusPolar: 1.08,
});

// A framed view of a workspace (V5.1): from behind and to the right of the
// employee, a little higher, so the figure, the desk and the whole wall
// display share the frame instead of the display filling it.
export function focusPreset(key) {
  const workspace = WORKSPACES[key];
  if (!workspace) return CAMERA.overview;
  const chief = key === 'chief';
  return { target: [workspace.x, 1.0, workspace.z - workspace.board.back * 0.3], azimuth: workspace.yaw + (chief ? 0.3 : 0.42), polar: chief ? 0.94 : 0.96, distance: chief ? 16 : 12 };
}

// A department view: the whole wing, framed from the Office's viewpoint.
export function wingPreset(id) {
  const wing = WINGS.find((entry) => entry.id === id);
  if (!wing) return null;
  const span = Math.max(wing.width, wing.depth * 1.3);
  // Back studios are seen from higher up, over the glass partitions.
  const back = wing.z < -6;
  return { target: [wing.x, 0.9, wing.z - (back ? 0.2 : 0.6)], azimuth: back ? 0.3 : 0.4, polar: back ? 0.72 : 0.9, distance: (back ? 12 : 10) + span * 1.4 };
}

// Desk anchor (screen height) for handoff arcs.
export function anchor(key) {
  const workspace = WORKSPACES[key];
  return workspace ? [workspace.x, 1.35, workspace.z] : null;
}
