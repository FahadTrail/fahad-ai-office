// Identifies the code a process is running without relying on git metadata
// (deploys ship only src/ and the package manifests). The fingerprint is a
// hash of those files' paths and contents; `node src/build-info.js [root]`
// prints it, so a worker's reported fingerprint can be matched to a commit.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url));

function listFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export function codeFingerprint(root = DEFAULT_ROOT) {
  const files = [...listFiles(join(root, 'src')), join(root, 'package.json'), join(root, 'package-lock.json')]
    .filter((path) => { try { return statSync(path).isFile(); } catch { return false; } })
    .map((path) => relative(root, path).replaceAll('\\', '/'))
    .sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file).update('\0').update(createHash('sha256').update(readFileSync(join(root, file))).digest('hex')).update('\n');
  }
  return hash.digest('hex').slice(0, 16);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(codeFingerprint(process.argv[2] || DEFAULT_ROOT));
}
