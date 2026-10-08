#!/usr/bin/env node
// Builds the immersive Office's asset pack (src/hub-ui/office3d/assets/):
//
//   materials/<finish>-{albedo,orm,normal}.ktx2   procedural PBR maps (texgen.js), Basis-compressed
//   env/day.exr, env/night.exr                     CC0 Poly Haven HDRIs (via @pmndrs/assets), reflections only
//   basis/basis_transcoder.{js,wasm}               the KTX2 transcoder from three (Apache-2.0)
//   manifest + office3d/asset-manifest.js          sha1, bytes, type and provenance of every file
//
// and copies Archivo (OFL-1.1) for in-world screens into src/hub-ui/fonts/.
//
//   node tools/build-office-assets.mjs [--only=materials|env|basis|fonts] [--hdri-from=<dir of *.exr.js>] [--fonts-from=<@fontsource/archivo dir>]
//
// Deterministic: the same sources produce byte-identical maps. The encoder
// (ktx2-encoder, MIT) is a dev dependency; nothing here runs in production.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MATERIAL_KINDS, generateMaterial } from '../src/hub-ui/office3d/texgen.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'src/hub-ui/office3d/assets');
const FONTS = join(ROOT, 'src/hub-ui/fonts');
const flags = Object.fromEntries(process.argv.slice(2).map((flag) => flag.replace(/^--/, '').split('=')).map(([key, value = 'true']) => [key, value]));
const only = flags.only ? new Set(flags.only.split(',')) : null;
const want = (step) => !only || only.has(step);

const PROVENANCE = {
  materials: { license: 'Original work (procedural, src/hub-ui/office3d/texgen.js)', source: 'tools/build-office-assets.mjs' },
  'env/day.exr': { license: 'CC0-1.0', source: 'Poly Haven HDRI "lebombo" (apartment), 512×256 EXR via @pmndrs/assets 1.7.0' },
  'env/night.exr': { license: 'CC0-1.0', source: 'Poly Haven HDRI (hall), 512×256 EXR via @pmndrs/assets 1.7.0' },
  basis: { license: 'Apache-2.0', source: 'three r0.186.1 examples/jsm/libs/basis (Binomial Basis Universal transcoder)' },
};
const TYPES = { '.ktx2': 'image/ktx2', '.exr': 'image/x-exr', '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.hdr': 'image/vnd.radiance', '.bin': 'application/octet-stream', '.json': 'application/json' };

mkdirSync(ASSETS, { recursive: true });

if (want('materials')) {
  const { encodeToKTX2 } = await import('ktx2-encoder');
  mkdirSync(join(ASSETS, 'materials'), { recursive: true });
  const encode = (data, size, options) => encodeToKTX2(new Uint8Array([0]), { generateMipmap: true, imageDecoder: async () => ({ data, width: size, height: size }), ...options });
  for (const kind of MATERIAL_KINDS) {
    const started = Date.now();
    const map = generateMaterial(kind);
    // Colour: ETC1S in sRGB. ORM: ETC1S, linear. Normals: UASTC (normal-map mode, Zstandard).
    const albedo = await encode(map.albedo, map.size, { isUASTC: false, qualityLevel: 192, isSetKTX2SRGBTransferFunc: true });
    const orm = await encode(map.orm, map.size, { isUASTC: false, qualityLevel: 160, isSetKTX2SRGBTransferFunc: false, isPerceptual: false });
    const normal = await encode(map.normal, map.normalSize, { isUASTC: true, isNormalMap: true, needSupercompression: true, isSetKTX2SRGBTransferFunc: false, isPerceptual: false });
    writeFileSync(join(ASSETS, 'materials', `${kind}-albedo.ktx2`), albedo);
    writeFileSync(join(ASSETS, 'materials', `${kind}-orm.ktx2`), orm);
    writeFileSync(join(ASSETS, 'materials', `${kind}-normal.ktx2`), normal);
    console.log(`materials/${kind}: ${map.size}px (${Math.round((albedo.length + orm.length + normal.length) / 1024)} KB) in ${Date.now() - started} ms`);
  }
}

if (want('env') && flags['hdri-from']) {
  mkdirSync(join(ASSETS, 'env'), { recursive: true });
  for (const [name, source] of [['day', 'apartment'], ['night', 'hall']]) {
    const module = readFileSync(join(flags['hdri-from'], `${source}.exr.js`), 'utf8');
    const base64 = module.slice(module.indexOf('base64,') + 7, module.lastIndexOf("'"));
    writeFileSync(join(ASSETS, 'env', `${name}.exr`), Buffer.from(base64, 'base64'));
    console.log(`env/${name}.exr from ${source}`);
  }
}

if (want('basis')) {
  mkdirSync(join(ASSETS, 'basis'), { recursive: true });
  for (const file of ['basis_transcoder.js', 'basis_transcoder.wasm']) copyFileSync(join(ROOT, 'node_modules/three/examples/jsm/libs/basis', file), join(ASSETS, 'basis', file));
}

if (want('fonts') && flags['fonts-from']) {
  for (const weight of [400, 500, 600]) copyFileSync(join(flags['fonts-from'], 'files', `archivo-latin-${weight}-normal.woff2`), join(FONTS, `archivo-${weight}.woff2`));
  console.log('fonts: Archivo 400/500/600 (latin)');
}

// The manifest: every asset with its content hash (the cache key) and provenance.
const files = {};
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) { walk(path); continue; }
    const name = relative(ASSETS, path).split('\\').join('/');
    const extension = name.slice(name.lastIndexOf('.'));
    if (!TYPES[extension] || name === 'manifest.json') continue;
    const body = readFileSync(path);
    const group = name.split('/')[0];
    const provenance = PROVENANCE[name] || PROVENANCE[group] || {};
    files[name] = { sha1: createHash('sha1').update(body).digest('hex').slice(0, 16), bytes: body.length, type: TYPES[extension], ...provenance };
  }
};
if (existsSync(ASSETS)) walk(ASSETS);
const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(join(ASSETS, 'manifest.json'), `${JSON.stringify({ about: 'Immersive Office assets, streamed from disk by the Hub (/ui/office-assets/). Built by tools/build-office-assets.mjs.', files: sorted }, null, 2)}\n`);
writeFileSync(join(ROOT, 'src/hub-ui/office3d/asset-manifest.js'), `// Generated by tools/build-office-assets.mjs — do not edit.\n// path → content hash (the cache key in /ui/office-assets/<path>?v=<hash>) and size.\nexport const ASSETS = Object.freeze(${JSON.stringify(Object.fromEntries(Object.entries(sorted).map(([name, file]) => [name, { v: file.sha1, bytes: file.bytes }])), null, 2)});\n`);
const total = Object.values(sorted).reduce((sum, file) => sum + file.bytes, 0);
console.log(`manifest: ${Object.keys(sorted).length} files, ${(total / 1024 / 1024).toFixed(2)} MB`);
