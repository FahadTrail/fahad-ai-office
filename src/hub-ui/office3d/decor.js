// Architecture and light fixtures for the immersive Office (V5.1). Static and
// data-free: nothing here shows or implies work. The scene merges every piece
// per material, so the whole building costs a handful of draw calls.
//
//   addDecor(kit) → nothing; builds into kit.world.
//
// kit: { THREE, world, ceiling, box, roundedSlab, plant, decal, strip,
//        material, fx, art, settings, WORKSPACES, WALLS, WING_ACCENTS }
//
// Suspended pieces (pendants, acoustic baffles) go into kit.ceiling: the
// scene shows that layer in the overview and lifts it away (a cutaway) in
// close views, so nothing hangs between the camera and the real work.
//
// fx materials (set by the time of day): fx.poolWarm (lamp and pendant light
// on the floor), fx.poolCool (screen glow), fx.window (daylight patches),
// fx.wash (wall washes). Accent strips use vertex colours (fx.accent).
//
// Each wing has its own architectural voice, without large labels:
//   Executive Atrium   stone inlay, a floating ring light, flanking plants
//   Intelligence Wing  library wall, archive cabinets, a quiet reading table
//   Strategy Wing      a walnut boardroom table, an executive credenza, art
//   Creative Studio    a standing studio table with samples, warm felt, a sofa
//   Build Studio       a server rack pair, a workbench, dark acoustic baffles

export function addDecor(kit) {
  const { THREE, world, ceiling, box, roundedSlab, plant, decal, strip, settings, WORKSPACES, WALLS, WING_ACCENTS } = kit;
  const group = (x, z, yaw = 0) => { const node = new THREE.Group(); node.position.set(x, 0, z); node.rotation.y = yaw; world.add(node); return node; };
  // A suspended linear pendant: the fixture and two fine rods up into the
  // (cut-away) ceiling.
  const pendant = (length, [x, y, z], yaw = 0) => {
    const node = new THREE.Group(); node.position.set(x, y, z); node.rotation.y = yaw; ceiling.add(node);
    box(length, 0.05, 0.12, 'pendant', [0, 0, 0], node, { shadow: false, receive: false });
    for (const side of [-1, 1]) box(0.012, 0.7, 0.012, 'metal', [side * length * 0.35, 0.37, 0], node, { shadow: false, receive: false });
  };
  const chair = (parent, [x, z], yaw, finish = 'textile') => {
    const seat = new THREE.Group(); seat.position.set(x, 0, z); seat.rotation.y = yaw;
    box(0.5, 0.07, 0.48, finish, [0, 0.45, 0], seat);
    box(0.48, 0.42, 0.06, finish, [0, 0.72, -0.22], seat);
    box(0.04, 0.42, 0.04, 'metal', [0, 0.22, 0], seat, { receive: false });
    parent.add(seat);
  };

  // ---------------------------------------------------------- facades
  // The back and left walls become glazed facades: a solid sill, full-height
  // glass between slim mullions, and a head beam. Daylight comes through them.
  for (const [x1, z1, x2, z2] of WALLS.slice(0, 2)) {
    const length = Math.hypot(x2 - x1, z2 - z1);
    const [mx, mz] = [(x1 + x2) / 2, (z1 + z2) / 2];
    // Local +z faces into the Office (towards its centre).
    let yaw = -Math.atan2(z2 - z1, x2 - x1);
    if (Math.sin(yaw) * -mx + Math.cos(yaw) * (-2 - mz) < 0) yaw += Math.PI;
    const facade = group(mx, mz, yaw);
    box(length, 0.45, 0.24, 'wall', [0, 0.225, 0], facade);
    const pane = box(length, 2.6, 0.03, 'facade', [0, 1.75, 0], facade, { shadow: false, receive: false });
    pane.renderOrder = 2;
    box(length, 0.12, 0.26, 'wall', [0, 3.1, 0], facade, { receive: false });
    const bays = Math.round(length / 2.6);
    for (let index = 0; index <= bays; index += 1) box(0.06, 2.6, 0.1, 'metal', [-length / 2 + (index * length) / bays, 1.75, 0], facade, { receive: false });
    // Warm uplight grazing the sill (night) and daylight patches (day).
    decal(length - 0.4, 0.5, [0, 0.47, 0.14], 'wash', facade, { vertical: true });
    for (let index = 0; index < bays; index += 1) {
      const centre = -length / 2 + ((index + 0.5) * length) / bays;
      decal(length / bays - 0.35, 2.8, [centre, 0.014, 1.75], 'window', facade);
    }
  }

  // ---------------------------------------------------------- light fixtures
  // A slim linear pendant over every desk, with a warm pool of light below.
  for (const [key, spec] of Object.entries(WORKSPACES)) {
    const length = spec.desk === 'executive' ? 2.4 : spec.desk === 'standard' ? 1.5 : 1.9;
    pendant(length, [spec.x, 2.85, spec.z]);
    decal(3.6, 3.4, [spec.x, 0.016, spec.z + 0.3], 'poolWarm', world);
    // Screen glow on the floor in front of each wall display.
    decal(spec.board.width + 1.2, 2.2, [spec.x, 0.018, spec.z - spec.board.back + 1.1], 'poolCool', world);
    // A department accent strip under each wall display.
    strip(spec.board.width - 0.2, [spec.x, 1.07, spec.z - spec.board.back + 0.02], WING_ACCENTS[spec.wing]);
    if (key === 'chief') strip(spec.board.width - 0.2, [spec.x, 1.14 + spec.board.height + 0.04, spec.z - spec.board.back + 0.02], WING_ACCENTS.atrium);
  }

  // ---------------------------------------------------------- executive atrium
  // A stone inlay under CHIEF edged by a flush light cove, and two tall plants.
  const inlay = new THREE.Mesh(kit.track(new THREE.CylinderGeometry(3.7, 3.7, 0.012, 64)), kit.material('inlay'));
  inlay.position.set(0, 0.008, -0.7); inlay.receiveShadow = true;
  world.add(inlay);
  const ring = new THREE.Mesh(kit.track(new THREE.TorusGeometry(3.72, 0.018, 6, 120)), kit.material('cove'));
  ring.rotation.x = Math.PI / 2; ring.position.set(0, 0.012, -0.7); ring.scale.z = 0.4;
  world.add(ring);
  decal(6.4, 6.4, [0, 0.02, -0.6], 'poolWarm', world);
  plant(-3.9, -2.7, 1.15); plant(3.9, -2.7, 1.15);

  // Reception: two pendants and a warm pool.
  for (const dx of [-0.7, 0.7]) pendant(0.9, [4.2 + dx, 2.6, 8.3], -0.2);
  decal(4, 3, [4.2, 0.02, 8.5], 'poolWarm', world);
  strip(2.4, [4.2 - 0.05, 0.12, 8.62], WING_ACCENTS.atrium, -0.2);
  // Lounge: a floor-lamp pool; the brand wall gets a soft wash.
  decal(4.2, 3.2, [12.5, 0.02, 7.3], 'poolWarm', world);

  // ---------------------------------------------------------- intelligence wing
  const archive = group(-8.15, -4.6);
  for (let index = 0; index < 3; index += 1) {
    box(0.5, 0.9, 1.0, 'white', [0, 0.45, -1.05 + index * 1.05], archive);
    box(0.02, 0.02, 0.5, 'metal', [0.26, 0.7, -1.05 + index * 1.05], archive, { receive: false });
  }
  roundedSlab(0.56, 3.2, 0.03, 0.02, 'stone', [0, 0.9, 0], archive);
  const reading = group(-17.4, 5.0);
  const top = new THREE.Mesh(kit.track(new THREE.CylinderGeometry(0.55, 0.55, 0.04, 32)), kit.material('walnut'));
  top.position.y = 0.74; top.castShadow = settings.shadows; top.receiveShadow = true; reading.add(top);
  box(0.06, 0.72, 0.06, 'metal', [0, 0.36, 0], reading, { receive: false });
  chair(reading, [-0.8, 0.1], Math.PI / 2); chair(reading, [0.75, -0.25], -Math.PI / 2 - 0.3);
  decal(2.6, 2.6, [-17.4, 0.02, 5], 'poolWarm', world);

  // ---------------------------------------------------------- strategy wing
  const boardroom = group(13.5, 2.1);
  roundedSlab(3.4, 1.15, 0.05, 0.4, 'walnut', [0, 0.72, 0], boardroom);
  for (const dx of [-1.05, 1.05]) box(0.14, 0.72, 0.6, 'white', [dx, 0.36, 0], boardroom);
  for (const dx of [-1.1, 0, 1.1]) { chair(boardroom, [dx, 0.95], Math.PI); chair(boardroom, [dx, -0.95], 0); }
  pendant(2.6, [13.5, 2.7, 2.1]);
  decal(5, 3.2, [13.5, 0.02, 2.1], 'poolWarm', world);
  const credenza = group(19.05, -4.6, -Math.PI / 2);
  box(2.8, 0.66, 0.46, 'walnut', [0, 0.33, 0], credenza);
  roundedSlab(2.86, 0.5, 0.03, 0.02, 'stone', [0, 0.66, 0], credenza);
  const print = new THREE.Mesh(kit.track(new THREE.PlaneGeometry(1.1, 0.75)), kit.art);
  print.position.set(-0.5, 1.1, 0.05); print.rotation.x = -0.12; credenza.add(print);
  box(1.18, 0.83, 0.03, 'dark', [-0.5, 1.1, 0.03], credenza, { receive: false }).rotation.x = -0.12;
  decal(3.4, 1.4, [18.6, 0.02, -4.6], 'poolWarm', world);

  // ---------------------------------------------------------- creative studio
  const studio = group(-9.5, -9.6);
  roundedSlab(1.9, 0.95, 0.05, 0.1, 'wood', [0, 0.9, 0], studio);
  for (const sx of [-0.8, 0.8]) box(0.05, 0.9, 0.8, 'metal', [sx, 0.45, 0], studio, { receive: false });
  ['feltWarm', 'stone', 'walnut', 'white', 'textile'].forEach((finish, index) => box(0.26, 0.015, 0.34, finish, [-0.64 + index * 0.32, 0.96, (index % 2) * 0.12 - 0.06], studio, { receive: false }));
  const sofa = group(-2.4, -10.8, -Math.PI / 2);
  box(2.2, 0.4, 0.85, 'feltWarm', [0, 0.2, 0], sofa); box(2.2, 0.42, 0.22, 'feltWarm', [0, 0.58, -0.32], sofa);
  for (const sx of [-1.02, 1.02]) box(0.18, 0.55, 0.85, 'feltWarm', [sx, 0.28, 0], sofa);
  const side = new THREE.Mesh(kit.track(new THREE.CylinderGeometry(0.28, 0.28, 0.5, 24)), kit.material('stone'));
  side.position.set(1.55, 0.25, 0); side.castShadow = settings.shadows; sofa.add(side);
  decal(3, 3.4, [-2.4, 0.02, -10.8], 'poolWarm', world);
  for (let index = 0; index < 5; index += 1) box(0.06, 0.6, 3.6, 'feltWarm', [-15 + index * 2.4, 3.2, -11], ceiling, { shadow: false, receive: false });

  // ---------------------------------------------------------- build studio
  const rack = group(12.05, -10.6);
  box(0.62, 1.25, 0.62, 'dark', [0, 0.625, 0], rack);
  for (let index = 0; index < 5; index += 1) box(0.5, 0.02, 0.01, 'metal', [0, 0.3 + index * 0.2, 0.32], rack, { receive: false });
  strip(0.46, [12.05, 1.18, -10.27], WING_ACCENTS.build);
  const bench = group(5.3, -9.3);
  roundedSlab(1.7, 0.7, 0.04, 0.05, 'dark', [0, 0.92, 0], bench);
  for (const sx of [-0.75, 0.75]) box(0.05, 0.92, 0.6, 'metal', [sx, 0.46, 0], bench, { receive: false });
  box(0.34, 0.08, 0.24, 'metal', [-0.35, 1.0, 0], bench, { receive: false });
  box(0.22, 0.05, 0.16, 'felt', [0.3, 0.99, 0.05], bench, { receive: false });
  for (let index = 0; index < 5; index += 1) box(0.06, 0.6, 3.6, 'felt', [4.4 + index * 2.2, 3.2, -11], ceiling, { shadow: false, receive: false });
}

// Abstract architectural artwork for the strategy print: soft blocks and
// lines in the Office palette. No text, no data.
export function drawArt(canvas, dark) {
  const g = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  g.fillStyle = dark ? '#2b2c31' : '#f1ece4'; g.fillRect(0, 0, w, h);
  const blocks = [['#7d9a86', 0.08, 0.14, 0.34, 0.56], ['#c7b299', 0.46, 0.3, 0.24, 0.5], ['#6b7fa8', 0.74, 0.12, 0.16, 0.34]];
  for (const [colour, x, y, bw, bh] of blocks) { g.globalAlpha = dark ? 0.7 : 0.85; g.fillStyle = colour; g.fillRect(x * w, y * h, bw * w, bh * h); }
  g.globalAlpha = 1; g.strokeStyle = dark ? '#8a8a90' : '#3a3b40'; g.lineWidth = Math.max(1, w / 256);
  g.beginPath(); g.moveTo(0.05 * w, 0.8 * h); g.lineTo(0.95 * w, 0.8 * h); g.moveTo(0.62 * w, 0.08 * h); g.lineTo(0.62 * w, 0.92 * h); g.stroke();
}
