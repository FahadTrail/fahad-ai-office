// Procedural material detail for the immersive Office (V5.1 final polish).
// Small canvas textures drawn once at start-up: no downloads, no image
// files. Each texture is near-white detail (0.82–1.0) that multiplies the
// material's own colour, so the same texture serves the light and dark
// themes and every time of day.
//
// Low visual noise by design: soft multi-scale variation, fine grain and
// thin joints; seeded randomness (deterministic screenshots); each pattern
// wraps seamlessly, and tile sizes are chosen so repeats fall on real joints
// (planks, slabs) instead of reading as a stamp.
//
//   drawDetail(canvas, kind) where kind is one of DETAIL_KINDS.
//   DETAIL_REPEAT[kind] = metres covered by one texture tile.

export const DETAIL_KINDS = Object.freeze(['oak', 'ash', 'walnut', 'stone', 'concrete', 'resin', 'grain', 'veneer']);

// One tile's size in metres (the scene sets texture.repeat from it).
export const DETAIL_REPEAT = Object.freeze({
  oak: 4.8, ash: 3.6, walnut: 3.2, stone: 3.6, concrete: 5, resin: 2.4, grain: 1.2, veneer: 1.6,
});

// Mulberry32: tiny seeded PRNG.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const shade = (value, alpha) => `rgba(${value},${value},${value},${alpha})`;

// Soft, wrapped blobs: large-scale tonal variation without a visible tile.
function clouds(g, size, rand, { count, min, max, alpha, dark = 70 }) {
  for (let index = 0; index < count; index += 1) {
    const x = rand() * size; const y = rand() * size; const radius = min + rand() * (max - min);
    const light = rand() < 0.5;
    for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) {
      const gradient = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, radius);
      gradient.addColorStop(0, light ? shade(255, alpha) : shade(dark, alpha));
      gradient.addColorStop(1, light ? shade(255, 0) : shade(dark, 0));
      g.fillStyle = gradient;
      g.fillRect(x + dx - radius, y + dy - radius, radius * 2, radius * 2);
    }
  }
}

// Fine speckle (stone, concrete, resin).
function speckle(g, size, rand, count, alpha, value = 60) {
  for (let index = 0; index < count; index += 1) {
    g.fillStyle = shade(rand() < 0.5 ? value : 255, alpha * (0.4 + rand() * 0.6));
    g.fillRect(rand() * size, rand() * size, 1 + rand() * 1.4, 1 + rand() * 1.4);
  }
}

// Long wood-grain streaks inside a rectangle (horizontal).
function grainStreaks(g, x, y, width, height, rand, { lines, alpha, value = 70 }) {
  g.save(); g.beginPath(); g.rect(x, y, width, height); g.clip();
  for (let index = 0; index < lines; index += 1) {
    const baseY = y + rand() * height;
    const wave = 0.6 + rand() * 1.8; const phase = rand() * Math.PI * 2;
    g.strokeStyle = shade(value, alpha * (0.3 + rand() * 0.7));
    g.lineWidth = 0.6 + rand() * 1.1;
    g.beginPath();
    for (let step = 0; step <= 24; step += 1) {
      const px = x + (width * step) / 24;
      const py = baseY + Math.sin(phase + (step / 24) * Math.PI * wave) * height * 0.06;
      if (step) g.lineTo(px, py); else g.moveTo(px, py);
    }
    g.stroke();
  }
  g.restore();
}

// Planks with staggered ends: the tile edge falls on a plank joint.
function planks(g, size, rand, { rows, alpha, joint, lines }) {
  const height = size / rows;
  for (let row = 0; row < rows; row += 1) {
    const y = row * height;
    const offset = rand() * size;
    const lengths = [size * (0.45 + rand() * 0.2)]; lengths.push(size - lengths[0]);
    let x = -offset;
    for (let pass = 0; pass < 3; pass += 1) for (const length of lengths) {
      const tone = 0.93 + rand() * 0.07;
      g.fillStyle = shade(Math.round(255 * tone), 1);
      for (const dx of [0, size]) g.fillRect(x + dx, y, length, height);
      for (const dx of [0, size]) grainStreaks(g, x + dx, y, length, height, rand, { lines, alpha });
      g.fillStyle = shade(90, joint);
      for (const dx of [0, size]) g.fillRect(x + dx + length - 1, y, 1.2, height);
      x += length;
    }
    g.fillStyle = shade(90, joint);
    g.fillRect(0, y, size, 1.2);
  }
}

export function drawDetail(canvas, kind, seed = 7) {
  const g = canvas.getContext('2d');
  const size = canvas.width;
  const rand = random(seed + DETAIL_KINDS.indexOf(kind) * 101);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, size, size);
  if (kind === 'oak') { planks(g, size, rand, { rows: 8, alpha: 0.07, joint: 0.22, lines: 10 }); clouds(g, size, rand, { count: 10, min: size * 0.12, max: size * 0.3, alpha: 0.05 }); }
  if (kind === 'ash') { planks(g, size, rand, { rows: 10, alpha: 0.05, joint: 0.16, lines: 8 }); clouds(g, size, rand, { count: 8, min: size * 0.1, max: size * 0.25, alpha: 0.035 }); }
  if (kind === 'walnut') {
    // Herringbone: the executive floor of the Strategy Wing.
    const unit = size / 8;
    for (let row = -1; row < 9; row += 1) for (let column = -1; column < 9; column += 1) {
      const x = column * unit; const y = row * unit + (column % 2) * (unit / 2);
      const tone = Math.round(255 * (0.93 + rand() * 0.07));
      g.save(); g.translate(x + unit / 2, y + unit / 2); g.rotate(column % 2 ? Math.PI / 4 : -Math.PI / 4);
      g.fillStyle = shade(tone, 1); g.fillRect(-unit * 0.7, -unit * 0.17, unit * 1.4, unit * 0.34);
      grainStreaks(g, -unit * 0.7, -unit * 0.17, unit * 1.4, unit * 0.34, rand, { lines: 4, alpha: 0.08 });
      g.strokeStyle = shade(80, 0.14); g.lineWidth = 1; g.strokeRect(-unit * 0.7, -unit * 0.17, unit * 1.4, unit * 0.34);
      g.restore();
    }
  }
  if (kind === 'stone') {
    // Large-format slabs with faint veining (the Executive Atrium).
    clouds(g, size, rand, { count: 16, min: size * 0.08, max: size * 0.3, alpha: 0.05 });
    for (let vein = 0; vein < 5; vein += 1) {
      g.strokeStyle = shade(120, 0.05 + rand() * 0.05); g.lineWidth = 0.8 + rand() * 1.4;
      g.beginPath(); let x = rand() * size; let y = rand() * size; g.moveTo(x, y);
      for (let step = 0; step < 14; step += 1) { x += (rand() - 0.3) * size * 0.08; y += (rand() - 0.5) * size * 0.06; g.lineTo(x, y); }
      g.stroke();
    }
    speckle(g, size, rand, size * 3, 0.05);
    g.fillStyle = shade(110, 0.18);
    for (let line = 0; line < 3; line += 1) { g.fillRect(0, (line * size) / 3, size, 1.2); g.fillRect((line * size) / 3, 0, 1.2, size); }
  }
  if (kind === 'concrete') { clouds(g, size, rand, { count: 22, min: size * 0.05, max: size * 0.22, alpha: 0.06 }); speckle(g, size, rand, size * 5, 0.07); }
  if (kind === 'resin') {
    // Dark technical resin with a very fine service grid (Build Studio).
    clouds(g, size, rand, { count: 12, min: size * 0.1, max: size * 0.3, alpha: 0.05 });
    speckle(g, size, rand, size * 2, 0.04);
    g.fillStyle = shade(150, 0.14);
    for (let line = 0; line < 4; line += 1) { g.fillRect(0, (line * size) / 4, size, 1); g.fillRect((line * size) / 4, 0, 1, size); }
  }
  if (kind === 'grain' || kind === 'veneer') {
    // Furniture wood: continuous grain for desk tops, shelves and tables.
    clouds(g, size, rand, { count: 8, min: size * 0.1, max: size * 0.3, alpha: 0.05 });
    grainStreaks(g, 0, 0, size, size, rand, { lines: kind === 'veneer' ? 70 : 46, alpha: kind === 'veneer' ? 0.1 : 0.08 });
  }
  return canvas;
}
