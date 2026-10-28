import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRepositoryProfile, profileSummary, setupNeeded } from '../src/coding-agent/repo-profile.js';
import { readFileSync } from 'node:fs';

// A sandbox stand-in with the two calls the profile uses.
function sandbox(files) {
  return {
    async resolveInside(path) { if (!(path in files)) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' }); return { relativePath: path }; },
    async readFile(path) {
      if (!(path in files)) throw new Error('missing');
      return { content: String(files[path]).split('\n').map((line, index) => `${index + 1}  ${line}`).join('\n') };
    },
  };
}

test('Node projects: the lockfile chooses the manager, its frozen install and its scripts', async () => {
  const pkg = JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .', build: 'vite build' }, devDependencies: { vitest: '1' } });
  const pnpm = await detectRepositoryProfile(sandbox({ 'package.json': pkg, 'pnpm-lock.yaml': '' }));
  assert.deepEqual([pnpm.packageManager, pnpm.setupCommand, pnpm.setupMarker, pnpm.testCommand], ['pnpm', 'pnpm install --frozen-lockfile', 'node_modules', 'pnpm test']);
  assert.deepEqual(pnpm.checks, ['pnpm run lint', 'pnpm run build']);
  const npm = await detectRepositoryProfile(sandbox({ 'package.json': pkg, 'package-lock.json': '{}' }));
  assert.deepEqual([npm.setupCommand, npm.testCommand, npm.checks[0]], ['npm ci', 'npm test', 'npm run lint']);
  const noLock = await detectRepositoryProfile(sandbox({ 'package.json': pkg }));
  assert.equal(noLock.setupCommand, 'npm install --no-package-lock', 'never creates a lockfile in the PR');
  const placeholder = await detectRepositoryProfile(sandbox({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }));
  assert.deepEqual([placeholder.testCommand, placeholder.setupCommand], [null, null]);
});

test('Python, Go and Rust projects, and unknown layouts', async () => {
  const python = await detectRepositoryProfile(sandbox({ 'requirements.txt': 'flask', tests: '' }));
  assert.deepEqual([python.setupCommand, python.testCommand], ['python3 -m pip install --user --break-system-packages -r requirements.txt', 'python3 -m pytest -q']);
  const go = await detectRepositoryProfile(sandbox({ 'go.mod': 'module x' }));
  assert.deepEqual([go.setupCommand, go.testCommand, go.checks], ['go mod download', 'go test ./...', ['go vet ./...']]);
  const rust = await detectRepositoryProfile(sandbox({ 'Cargo.toml': '' }));
  assert.deepEqual([rust.setupCommand, rust.testCommand], [null, 'cargo test']);
  const unknown = await detectRepositoryProfile(sandbox({ 'README.md': '' }));
  assert.deepEqual(unknown.languages, []);
  assert.match(profileSummary(unknown), /not recognised/);
});

test('setup runs once, only when dependencies are declared and missing', async () => {
  const files = { 'package.json': JSON.stringify({ scripts: { test: 'node --test' }, dependencies: { x: '1' } }), 'package-lock.json': '{}' };
  const profile = await detectRepositoryProfile(sandbox(files));
  assert.equal(await setupNeeded(sandbox(files), profile, {}), true);
  assert.equal(await setupNeeded(sandbox(files), profile, { setupDone: true }), false);
  assert.equal(await setupNeeded(sandbox({ ...files, node_modules: '' }), profile, {}), false);
  assert.match(profileSummary(profile), /npm ci/);
});

test('a missing toolchain (exit 127, the command itself not found) is a clear blocker, never a test failure', async () => {
  const { toolchainMissing } = await import('../src/coding-agent/repo-profile.js');
  assert.match(toolchainMissing('go test ./...', 127, 'sh: 1: go: not found'), /`go` is not installed in the worker image/);
  assert.match(toolchainMissing('cargo test', 127, 'bash: cargo: command not found'), /`cargo`/);
  assert.match(toolchainMissing('python3 -m pytest -q', 127, '/bin/sh: python3: not found'), /`python3`/);
  // A failing test, or a test whose output mentions "not found", is not a toolchain problem.
  assert.equal(toolchainMissing('go test ./...', 1, 'sh: 1: go: not found'), null);
  assert.equal(toolchainMissing('npm test', 127, 'sh: 1: jest: not found'), null);
  assert.equal(toolchainMissing('npm test', 0, ''), null);
});

test('the controller stops with TOOLCHAIN_MISSING when the setup or the test gate cannot find its command', () => {
  const source = readFileSync(new URL('../src/coding-agent/controller.js', import.meta.url), 'utf8');
  assert.equal((source.match(/code: 'TOOLCHAIN_MISSING'/g) || []).length, 2);
});
