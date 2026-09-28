// Builds the vendored, tree-shaken Three.js bundle for the immersive Office:
//   node tools/build-three.mjs
// Output: src/hub-ui/vendor/three.js (committed; the Hub serves it like any
// other UI asset — content-hashed, immutable, gzipped). MIT licence kept.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('node_modules/three/package.json', 'utf8'));
await build({
  entryPoints: ['tools/three-entry.js'],
  outfile: 'src/hub-ui/vendor/three.js',
  bundle: true, format: 'esm', minify: true, target: 'es2022', legalComments: 'none',
  banner: { js: `/* three.js r${version} — https://threejs.org — Copyright 2010-2026 Three.js Authors — MIT License (see node_modules/three/LICENSE). Tree-shaken bundle for Fahad AI Office. */` },
});
console.log('Built src/hub-ui/vendor/three.js from three', version);
