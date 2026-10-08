// Procedural PBR material maps for the Office's finishes (Final Design Spec
// §01: honed travertine #E6DED1, white-oak plank #C9A77D, white-oak slats on
// black felt, walnut, microcement, linen, brushed bronze, leather, wool).
//
// Pure JavaScript, deterministic and tileable: the build step
// (tools/build-office-assets.mjs) runs it once and compresses the maps to
// KTX2; the browser runs it at low resolution only as a fallback.
//
//   generateMaterial(kind, size) → { albedo, orm, normal, size, metres }
//     albedo  sRGB RGBA
//     orm     linear RGBA: R ambient occlusion, G roughness (relative), B metalness
//     normal  tangent-space RGBA (OpenGL convention, +Y up)
//     metres  the real-world size one texture tile covers

export const MATERIAL_KINDS = Object.freeze(['travertine', 'oak', 'slat', 'walnut', 'microcement', 'felt', 'linen', 'bronze', 'leather', 'wool']);

// Physical size of one tile and the build resolution of each finish.
export const MATERIAL_SPEC = Object.freeze({
  travertine: { metres: 4.8, size: 2048, normalSize: 1024, strength: 1.2 },
  oak: { metres: 2.28, size: 2048, normalSize: 1024, strength: 2.2 },
  slat: { metres: 1.2, size: 512, normalSize: 512, strength: 2 },
  walnut: { metres: 1.8, size: 1024, normalSize: 512, strength: 1.4 },
  microcement: { metres: 3, size: 1024, normalSize: 512, strength: 1.2 },
  felt: { metres: 0.6, size: 512, normalSize: 512, strength: 1.6 },
  linen: { metres: 0.25, size: 512, normalSize: 512, strength: 2.5 },
  bronze: { metres: 0.8, size: 512, normalSize: 512, strength: 0.6 },
  leather: { metres: 0.4, size: 512, normalSize: 512, strength: 2.2 },
  wool: { metres: 0.3, size: 512, normalSize: 512, strength: 2.4 },
});

// ------------------------------------------------------------------ noise

function hash(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);
const fract = (value) => value - Math.floor(value);

// Periodic value noise: u, v in [0, 1) tile; period = lattice cells per tile.
function noise(u, v, period, seed) {
  const x = u * period; const y = v * period;
  const xi = Math.floor(x); const yi = Math.floor(y);
  const xf = fade(x - xi); const yf = fade(y - yi);
  const wrap = (n) => ((n % period) + period) % period;
  const a = hash(wrap(xi), wrap(yi), seed); const b = hash(wrap(xi + 1), wrap(yi), seed);
  const c = hash(wrap(xi), wrap(yi + 1), seed); const d = hash(wrap(xi + 1), wrap(yi + 1), seed);
  return lerp(lerp(a, b, xf), lerp(c, d, xf), yf);
}
// Fractal noise with periodic octaves (period doubles each octave).
function fbm(u, v, period, octaves, seed, gain = 0.5) {
  let sum = 0; let amp = 1; let norm = 0; let p = period;
  for (let octave = 0; octave < octaves; octave += 1) { sum += noise(u, v, p, seed + octave * 101) * amp; norm += amp; amp *= gain; p *= 2; }
  return sum / norm;
}
// Anisotropic periodic fbm (periods differ along u and v): grain and bands.
function fbm2(u, v, pu, pv, octaves, seed, gain = 0.5) {
  let sum = 0; let amp = 1; let norm = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    const mu = pu * 2 ** octave; const mv = pv * 2 ** octave;
    const x = u * mu; const y = v * mv;
    const xi = Math.floor(x); const yi = Math.floor(y);
    const xf = fade(x - xi); const yf = fade(y - yi);
    const wx = (n) => ((n % mu) + mu) % mu; const wy = (n) => ((n % mv) + mv) % mv;
    const s = seed + octave * 131;
    const a = hash(wx(xi), wy(yi), s); const b = hash(wx(xi + 1), wy(yi), s);
    const c = hash(wx(xi), wy(yi + 1), s); const d = hash(wx(xi + 1), wy(yi + 1), s);
    sum += lerp(lerp(a, b, xf), lerp(c, d, xf), yf) * amp; norm += amp; amp *= gain;
  }
  return sum / norm;
}

const hex = (value) => { const n = parseInt(value.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

// ------------------------------------------------------------------ finishes
// Each finish returns per-pixel { rgb: [0..255], height: 0..1, rough: 0..1, ao: 0..1, metal: 0..1 }.

const FINISH = {
  // Honed Roman travertine: slabs 1.2 × 0.6 m with 2 mm joints, soft
  // horizontal banding, filled pores along the bands.
  travertine(u, v) {
    const metres = MATERIAL_SPEC.travertine.metres;
    const sx = Math.floor(u * metres / 1.2); const sy = Math.floor(v * metres / 0.6);
    const lu = fract(u * metres / 1.2); const lv = fract(v * metres / 0.6);
    const slab = hash(sx, sy, 7);
    const joint = Math.min(lu * 1.2, (1 - lu) * 1.2, lv * 0.6, (1 - lv) * 0.6) < 0.0016;
    const band = fbm2(u + slab * 0.37, v, 2, 24, 4, 11 + sx * 3, 0.55);
    const vein = Math.abs(fbm2(u, v + slab, 3, 40, 3, 23, 0.5) - 0.5) < 0.018 ? 1 : 0;
    const pore = fbm2(u, v, 96, 512, 2, 41, 0.45);
    const pit = pore > 0.74 ? (pore - 0.74) * 3.6 : 0;
    const mottle = fbm(u, v, 12, 4, 57);
    const base = hex('#e6ded1');
    // Honed: the slab face is near-flat; pores and joints carry the relief.
    // Darker bands, veins and filled pores drift toward a warmer beige.
    const dark = clamp01(0.5 - band) * 0.9 + vein * 0.35 + pit * 0.6 + (0.5 - mottle) * 0.25 + (0.5 - slab) * 0.2;
    const deep = hex('#c9b89c');
    const light = 1.0 + clamp01(band - 0.55) * 0.05;
    const rgb = base.map((c, index) => lerp(c * light, deep[index], clamp01(dark)));
    return { rgb: joint ? rgb.map((c) => c * 0.78) : rgb, height: joint ? 0.2 : 0.62 - pit * 0.5 + (mottle - 0.5) * 0.05, rough: 0.88 + (pore - 0.5) * 0.15 + pit * 0.2, ao: joint ? 0.7 : 1 - pit * 0.25, metal: 0 };
  },
  // White-oak planks 190 mm wide, staggered lengths, straight grain, micro-bevelled edges.
  oak(u, v) {
    const metres = MATERIAL_SPEC.oak.metres;
    const plankWidth = 0.19 / metres;
    const row = Math.floor(v / plankWidth);
    const rowV = fract(v / plankWidth);
    const offset = hash(row, 0, 3);
    // One or two planks per tile in each row (2.28 or 1.14 m): the tile repeats seamlessly.
    const plankLength = 1 / (1 + Math.floor(hash(row, 1, 5) * 2));
    const along = u + offset;
    const index = Math.floor(along / plankLength);
    const lu = fract(along / plankLength);
    const plank = hash(row, index, 9);
    const edgeV = Math.min(rowV, 1 - rowV) * plankWidth * metres; const edgeU = Math.min(lu, 1 - lu) * plankLength * metres;
    const seam = Math.min(edgeV, edgeU);
    const grain = fbm2(u + plank, v * 1, 6, 220, 4, 17 + row, 0.55);
    const rings = Math.sin(v * Math.PI * 2 * 143 + fbm2(u, v, 3, 60, 3, 29) * 18 + plank * 40) * 0.5 + 0.5;
    const fleck = fbm2(u, v, 40, 640, 2, 31) > 0.78 ? 1 : 0;
    const base = hex('#c9a77d');
    const tone = 1 + (plank - 0.5) * 0.12 + (grain - 0.5) * 0.18 + (rings - 0.5) * 0.06 + fleck * 0.04;
    const rgb = [base[0] * tone, base[1] * tone * (1 - (plank - 0.5) * 0.02), base[2] * tone * (1 - (plank - 0.5) * 0.05)];
    const bevel = seam < 0.0015 ? 0.55 : seam < 0.003 ? 0.85 : 1;
    return { rgb: seam < 0.0008 ? rgb.map((c) => c * 0.55) : rgb, height: 0.6 * bevel + (grain - 0.5) * 0.04, rough: 0.82 + (grain - 0.5) * 0.25, ao: seam < 0.0012 ? 0.75 : 1, metal: 0 };
  },
  // Ceiling slats: white oak, fine grain only.
  slat(u, v) {
    const grain = fbm2(u, v, 4, 120, 4, 61, 0.55);
    const base = hex('#cfae84');
    const tone = 1 + (grain - 0.5) * 0.2;
    return { rgb: base.map((c) => c * tone), height: 0.5 + (grain - 0.5) * 0.06, rough: 0.85, ao: 1, metal: 0 };
  },
  // Book-matched walnut veneer with cathedral figure.
  walnut(u, v) {
    // Long grain along u with gentle cathedral arches across it.
    const arches = 0.35 * Math.cos(Math.PI * 2 * u) + 0.12 * Math.cos(Math.PI * 4 * u + 1.3);
    const wave = fbm2(u, v, 3, 6, 4, 71, 0.55);
    const figure = Math.sin(Math.PI * 2 * (v * 14 + wave * 0.9 + arches)) * 0.5 + 0.5;
    const grain = fbm2(u, v, 6, 240, 4, 73, 0.55);
    const pores = fbm2(u, v, 24, 900, 2, 75) > 0.72 ? 1 : 0;
    const base = hex('#5b3d2a');
    const tone = 1 + (figure - 0.5) * 0.2 + (grain - 0.5) * 0.16 - pores * 0.06;
    return { rgb: [base[0] * tone * 1.02, base[1] * tone, base[2] * tone * 0.96], height: 0.5 + (grain - 0.5) * 0.04 - pores * 0.05, rough: 0.5 + (grain - 0.5) * 0.12 + pores * 0.1, ao: 1, metal: 0 };
  },
  // Microcement: warm grey, soft trowel clouds.
  microcement(u, v) {
    const cloud = fbm(u, v, 4, 6, 81, 0.55);
    const trowel = fbm2(u + cloud * 0.3, v, 6, 18, 3, 83);
    const base = hex('#cdc7be');
    const tone = 1 + (cloud - 0.5) * 0.1 + (trowel - 0.5) * 0.05;
    return { rgb: base.map((c) => c * tone), height: 0.5 + (trowel - 0.5) * 0.06, rough: 0.85 + (cloud - 0.5) * 0.1, ao: 1, metal: 0 };
  },
  // Black acoustic felt.
  felt(u, v) {
    const fibre = fbm(u, v, 64, 3, 91, 0.6);
    const base = hex('#151413');
    return { rgb: base.map((c) => c * (0.85 + fibre * 0.3)), height: fibre, rough: 1, ao: 1, metal: 0 };
  },
  // Natural linen: plain weave.
  linen(u, v) {
    const threads = 96;
    const weftU = fract(u * threads); const warpV = fract(v * threads);
    const over = (Math.floor(u * threads) + Math.floor(v * threads)) % 2;
    const slub = fbm2(u, v, 4, 96, 3, 97);
    const ridge = over ? Math.sin(weftU * Math.PI) : Math.sin(warpV * Math.PI);
    const base = hex('#d9d1c3');
    const tone = 0.92 + ridge * 0.1 + (slub - 0.5) * 0.12;
    return { rgb: base.map((c) => c * tone), height: ridge * 0.8 + slub * 0.2, rough: 0.95, ao: 0.85 + ridge * 0.15, metal: 0 };
  },
  // Brushed bronze: the colour comes from the material; the map carries brushing.
  bronze(u, v) {
    const brush = fbm2(u, v, 2, 512, 3, 103, 0.6);
    const tone = 0.9 + brush * 0.16;
    return { rgb: [255 * tone, 255 * tone, 255 * tone], height: 0.5 + (brush - 0.5) * 0.1, rough: 0.7 + (brush - 0.5) * 0.4, ao: 1, metal: 1 };
  },
  // Espresso leather: pebble grain.
  leather(u, v) {
    const cell = fbm(u, v, 48, 3, 107, 0.5);
    const crease = Math.abs(fbm(u, v, 12, 3, 109) - 0.5) < 0.015 ? 1 : 0;
    const base = hex('#3a2a22');
    const tone = 0.9 + cell * 0.2 - crease * 0.08;
    return { rgb: base.map((c) => c * tone), height: cell - crease * 0.3, rough: 0.62 + (cell - 0.5) * 0.15, ao: 1 - crease * 0.2, metal: 0 };
  },
  // Wool upholstery: fine twill.
  wool(u, v) {
    const twill = fract((u + v) * 160);
    const fuzz = fbm(u, v, 64, 3, 113);
    const base = hex('#8f877c');
    const tone = 0.9 + Math.sin(twill * Math.PI) * 0.08 + (fuzz - 0.5) * 0.12;
    return { rgb: base.map((c) => c * tone), height: Math.sin(twill * Math.PI) * 0.6 + fuzz * 0.4, rough: 1, ao: 0.9 + Math.sin(twill * Math.PI) * 0.1, metal: 0 };
  },
};

// ------------------------------------------------------------------ maps

export function generateMaterial(kind, { size = MATERIAL_SPEC[kind]?.size, normalSize = MATERIAL_SPEC[kind]?.normalSize } = {}) {
  const finish = FINISH[kind];
  if (!finish) throw new Error(`unknown finish ${kind}`);
  const albedo = new Uint8Array(size * size * 4);
  const orm = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sample = finish((x + 0.5) / size, (y + 0.5) / size);
      const i = (y * size + x) * 4;
      albedo[i] = clampByte(sample.rgb[0]); albedo[i + 1] = clampByte(sample.rgb[1]); albedo[i + 2] = clampByte(sample.rgb[2]); albedo[i + 3] = 255;
      orm[i] = clampByte(sample.ao * 255); orm[i + 1] = clampByte(clamp01(sample.rough) * 255); orm[i + 2] = clampByte(sample.metal * 255); orm[i + 3] = 255;
    }
  }
  // The normal map comes from a height field sampled at its own resolution.
  const n = normalSize || size;
  const height = new Float32Array(n * n);
  for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) height[y * n + x] = finish((x + 0.5) / n, (y + 0.5) / n).height;
  return { kind, size, normalSize: n, metres: MATERIAL_SPEC[kind].metres, albedo, orm, normal: normalFromHeight(height, n, MATERIAL_SPEC[kind].strength * (n / 512)) };
}

// Tangent-space normals from a tileable height field (Sobel, wrapped).
export function normalFromHeight(height, size, strength = 1) {
  const out = new Uint8Array(size * size * 4);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * strength; let ny = dy * strength; let nz = 1;
      const length = Math.hypot(nx, ny, nz); nx /= length; ny /= length; nz /= length;
      const i = (y * size + x) * 4;
      out[i] = clampByte((nx * 0.5 + 0.5) * 255); out[i + 1] = clampByte((ny * 0.5 + 0.5) * 255); out[i + 2] = clampByte((nz * 0.5 + 0.5) * 255); out[i + 3] = 255;
    }
  }
  return out;
}

function clampByte(value) { return value < 0 ? 0 : value > 255 ? 255 : Math.round(value); }
