// The immersive Office's asset pipeline: the build manifest, the
// disk-streamed /ui/office-assets/ route (whitelist, ETag, immutable cache,
// Range), provenance and licences of every shipped asset, and the pure
// texture generator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { createHubServer, OFFICE_ASSETS } from '../src/hub-server.js';
import { ASSETS } from '../src/hub-ui/office3d/asset-manifest.js';
import { MATERIAL_KINDS, MATERIAL_SPEC, generateMaterial, normalFromHeight } from '../src/hub-ui/office3d/texgen.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url));
const manifest = JSON.parse(read('src/hub-ui/office3d/assets/manifest.json'));

test('manifest: every file is hashed, typed and has a licence and source; the client manifest matches', () => {
  const names = Object.keys(manifest.files);
  for (const kind of MATERIAL_KINDS) for (const map of ['albedo', 'orm', 'normal']) assert.ok(names.includes(`materials/${kind}-${map}.ktx2`), `${kind} ${map}`);
  for (const name of ['env/day.exr', 'env/night.exr', 'basis/basis_transcoder.js', 'basis/basis_transcoder.wasm']) assert.ok(names.includes(name), name);
  for (const [name, file] of Object.entries(manifest.files)) {
    const body = read(`src/hub-ui/office3d/assets/${name}`);
    assert.equal(file.bytes, body.length, `${name} size`);
    assert.equal(file.sha1, createHash('sha1').update(body).digest('hex').slice(0, 16), `${name} hash`);
    assert.ok(file.license && file.source, `${name} provenance`);
    assert.ok(/^(CC0-1\.0|Apache-2\.0|Original work)/.test(file.license), `${name}: ${file.license}`);
    assert.deepEqual(ASSETS[name], { v: file.sha1, bytes: file.bytes }, `${name} in the client manifest`);
  }
  assert.equal(Object.keys(ASSETS).length, names.length);
  // KTX2 files really are KTX2; EXR files really are OpenEXR.
  for (const name of names.filter((entry) => entry.endsWith('.ktx2'))) assert.equal(read(`src/hub-ui/office3d/assets/${name}`).subarray(1, 7).toString('latin1'), 'KTX 20', name);
  for (const name of names.filter((entry) => entry.endsWith('.exr'))) assert.equal(read(`src/hub-ui/office3d/assets/${name}`).readUInt32LE(0), 20000630, name);
  // A browser-friendly pack: well under 8 MB in all, no single file over 1 MB.
  const total = Object.values(manifest.files).reduce((sum, file) => sum + file.bytes, 0);
  assert.ok(total < 8 * 1024 * 1024, `${(total / 1048576).toFixed(2)} MB`);
  for (const [name, file] of Object.entries(manifest.files)) assert.ok(file.bytes < 1024 * 1024, name);
});

test('licences: Archivo (OFL) and the CC0 HDRIs are recorded decisions', () => {
  const decisions = JSON.parse(read('legal/license-decisions.json')).decisions;
  for (const name of ['font:Archivo', 'asset:Poly Haven HDRIs']) assert.ok(decisions.some((entry) => new RegExp(entry.match).test(name) && entry.decision === 'APPROVED'), name);
  for (const weight of [400, 500, 600]) assert.ok(statSync(new URL(`../src/hub-ui/fonts/archivo-${weight}.woff2`, import.meta.url)).size > 5000);
});

function fetchRaw(port, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}

test('the asset route streams only manifest files, with ETag, immutable cache and Range', async () => {
  const server = createHubServer({ db: { from() { throw new Error('no db'); } }, store: {}, host: '127.0.0.1', port: 0 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address();
  try {
    const name = 'env/day.exr';
    const asset = OFFICE_ASSETS[name];
    const whole = await fetchRaw(port, `/ui/office-assets/${name}?v=${asset.sha1}`);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers['content-type'], 'image/x-exr');
    assert.equal(Number(whole.headers['content-length']), asset.bytes);
    assert.equal(whole.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(whole.headers['x-content-type-options'], 'nosniff');
    assert.ok(whole.body.equals(read(`src/hub-ui/office3d/assets/${name}`)));
    assert.equal((await fetchRaw(port, `/ui/office-assets/${name}`)).headers['cache-control'], 'no-cache', 'unversioned requests revalidate');
    assert.equal((await fetchRaw(port, `/ui/office-assets/${name}`, { 'if-none-match': asset.etag })).status, 304);
    const part = await fetchRaw(port, `/ui/office-assets/${name}`, { range: 'bytes=4-11' });
    assert.equal(part.status, 206); assert.equal(part.headers['content-range'], `bytes 4-11/${asset.bytes}`);
    assert.ok(part.body.equals(read(`src/hub-ui/office3d/assets/${name}`).subarray(4, 12)));
    const tail = await fetchRaw(port, `/ui/office-assets/${name}`, { range: 'bytes=-16' });
    assert.equal(tail.body.length, 16);
    assert.equal((await fetchRaw(port, `/ui/office-assets/${name}`, { range: 'bytes=99999999-' })).status, 416);
    const head = await fetchRaw(port, `/ui/office-assets/${name}`, {}, 'HEAD');
    assert.equal(head.status, 200); assert.equal(head.body.length, 0);
    assert.equal((await fetchRaw(port, '/ui/office-assets/basis/basis_transcoder.wasm')).headers['content-type'], 'application/wasm');
    for (const path of ['/ui/office-assets/manifest.json', '/ui/office-assets/../../hub-server.js', '/ui/office-assets/%2e%2e/%2e%2e/hub-server.js', '/ui/office-assets/env/missing.exr', '/ui/office-assets/%E0%A4%A']) {
      assert.equal((await fetchRaw(port, path)).status, 404, path);
    }
    // The pack is never loaded into the in-memory UI assets.
    assert.equal((await fetchRaw(port, '/ui/office3d/assets/basis/basis_transcoder.js')).status, 404);
  } finally { server.close(); }
});

test('texture generator: tileable, deterministic PBR maps for every finish', () => {
  for (const kind of MATERIAL_KINDS) {
    const a = generateMaterial(kind, { size: 32, normalSize: 32 });
    const b = generateMaterial(kind, { size: 32, normalSize: 32 });
    assert.deepEqual(a.albedo, b.albedo, `${kind} deterministic`);
    assert.equal(a.albedo.length, 32 * 32 * 4); assert.equal(a.normal.length, 32 * 32 * 4);
    assert.ok(MATERIAL_SPEC[kind].metres > 0.1 && MATERIAL_SPEC[kind].metres <= 5);
    // Normals are unit length and face up.
    for (let i = 0; i < a.normal.length; i += 4 * 37) { const [x, y, z] = [0, 1, 2].map((k) => a.normal[i + k] / 127.5 - 1); assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 0.03 && z > 0.3, kind); }
  }
  // Spec colours: honed travertine #E6DED1 and white oak #C9A77D on average.
  const mean = (kind) => { const map = generateMaterial(kind, { size: 64, normalSize: 8 }); const sum = [0, 0, 0]; for (let i = 0; i < map.albedo.length; i += 4) for (let c = 0; c < 3; c += 1) sum[c] += map.albedo[i + c]; return sum.map((value) => value / (map.albedo.length / 4)); };
  const near = (rgb, hex, tolerance) => { const target = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16)); return rgb.every((value, index) => Math.abs(value - target[index]) < tolerance); };
  assert.ok(near(mean('travertine'), '#e6ded1', 14), `travertine ${mean('travertine').map(Math.round)}`);
  assert.ok(near(mean('oak'), '#c9a77d', 16), `oak ${mean('oak').map(Math.round)}`);
  // Wrapped Sobel: a flat field gives straight-up normals.
  const flat = normalFromHeight(new Float32Array(16).fill(0.5), 4);
  assert.deepEqual([...flat.subarray(0, 4)], [128, 128, 255, 255]);
});
