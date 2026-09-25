// Isolated development workspace for one Coding Agent session.
//
// Isolation model (production, "isolated" mode):
//   * The controller runs as container root and holds provider, GitHub and
//     Supabase credentials. Its /proc environment is unreadable to other uids.
//   * Everything the model can influence — shell commands, tests, package
//     installs, git status/diff/commit — runs as an unprivileged sandbox uid
//     with a scrubbed environment inside the session's worktree.
//   * After every command, stray sandbox processes are killed so nothing
//     keeps running between tool calls.
//   * Publishing never executes repository-controlled git config as root:
//     the sandbox writes a git bundle, the controller fetches the bundle into
//     a controller-owned repository and pushes from there.
//
// "unisolated" mode exists only for local development and automated tests,
// where no production credential is present. The controller refuses it in
// production unless explicitly overridden.

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  chmod, lchown, lstat, mkdir, open, readdir, readFile, realpath, rm, stat, writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { assertWritablePath, checkCommand, normalizeRepoPath, policyError, redact, sandboxEnvironment } from './policy.js';

export const SANDBOX_IDENTITY = Object.freeze({ uid: 1000, gid: 1000 });
const MAX_READ_BYTES = 400_000;

export function resolveSandboxMode(env = process.env) {
  const requested = String(env.CODING_AGENT_SANDBOX || 'isolated').toLowerCase();
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (requested === 'isolated') {
    if (!isRoot || process.platform !== 'linux') {
      throw policyError('SANDBOX_UNAVAILABLE', 'Isolated sandbox mode requires the coding worker to run as container root on Linux');
    }
    return 'isolated';
  }
  if (requested === 'unisolated') {
    if (env.NODE_ENV === 'production' && env.CODING_AGENT_ALLOW_UNISOLATED !== 'true') {
      throw policyError('SANDBOX_UNSAFE', 'Unisolated sandbox mode is refused in production');
    }
    return 'unisolated';
  }
  throw policyError('SANDBOX_MODE_INVALID', 'CODING_AGENT_SANDBOX must be isolated or unisolated');
}

export class Sandbox {
  constructor({ root, sessionId, mode = 'isolated', identity = SANDBOX_IDENTITY, env = process.env, now = () => Date.now() }) {
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new TypeError('Sandbox requires a session UUID');
    this.mode = mode;
    this.identity = identity;
    this.env = env;
    this.now = now;
    this.root = resolve(root);
    this.sessionDir = join(this.root, 'sessions', sessionId);
    this.repoDir = join(this.sessionDir, 'repo');
    this.homeDir = join(this.sessionDir, 'home');
    this.controlDir = join(this.root, 'control', sessionId);
    this.publishRepo = join(this.controlDir, 'publish.git');
  }

  get isolated() {
    return this.mode === 'isolated';
  }

  async exists() {
    try {
      return (await stat(join(this.repoDir, '.git'))).isDirectory();
    } catch {
      return false;
    }
  }

  // Clones the repository into the sandbox. The clone runs as the controller
  // (it needs the token for private repositories) and ownership is handed to
  // the sandbox identity afterwards; the stored remote carries no credential.
  async prepare({ repository, baseBranch, workBranch, token = null, fetchUrl = null }) {
    await mkdir(join(this.homeDir, 'tmp'), { recursive: true, mode: 0o700 });
    await mkdir(this.controlDir, { recursive: true, mode: 0o700 });
    await chmod(this.controlDir, 0o700);
    const url = fetchUrl || `https://github.com/${repository}.git`;
    if (!(await this.exists())) {
      await rm(this.repoDir, { recursive: true, force: true });
      const clone = await this.controllerGit(['clone', '--no-tags', '--single-branch', '--branch', baseBranch, url, this.repoDir], { token, timeoutMs: 600_000 });
      if (clone.code !== 0) throw policyError('CLONE_FAILED', `Repository clone failed: ${redact(clone.stderr).split('\n').find(Boolean) || 'unknown error'}`);
      await this.handOver(this.sessionDir);
      const checkout = await this.git(['checkout', '-B', workBranch]);
      if (checkout.code !== 0) throw policyError('BRANCH_FAILED', 'Could not create the work branch');
    }
    await this.handOver(this.homeDir);
    const head = await this.git(['rev-parse', 'HEAD']);
    return { head: head.stdout.trim() };
  }

  // Re-applies a stored working-tree patch when a session resumes on a
  // machine that no longer has its worktree.
  async applyPatch(patch) {
    if (!patch) return false;
    const file = join(this.homeDir, 'tmp', 'restore.patch');
    await writeFile(file, patch, { mode: 0o600 });
    await this.handOver(file);
    const result = await this.git(['apply', '--whitespace=nowarn', file]);
    await rm(file, { force: true });
    return result.code === 0;
  }

  async handOver(path) {
    if (!this.isolated) return;
    const metadata = await lstat(path);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      for (const entry of await readdir(path)) await this.handOver(join(path, entry));
    }
    await lchown(path, this.identity.uid, this.identity.gid);
  }

  // ---------------------------------------------------------------- processes
  async run(command, args, { cwd = this.repoDir, timeoutMs = 300_000, maxOutputBytes = 200_000, input = null } = {}) {
    const env = sandboxEnvironment({ home: this.homeDir });
    const result = await runProcess(command, args, {
      cwd, env, timeoutMs, maxOutputBytes, input,
      identity: this.isolated ? this.identity : null,
      detached: !this.isolated,
    });
    if (this.isolated) await killUidProcesses(this.identity.uid);
    return result;
  }

  async shell(command, { timeoutMs = 300_000 } = {}) {
    checkCommand(command);
    const startedAt = this.now();
    const result = await this.run('bash', ['-c', command], { timeoutMs, maxOutputBytes: 400_000 });
    return {
      exitCode: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: this.now() - startedAt,
      stdout: redact(result.stdout, this.env, 60_000),
      stderr: redact(result.stderr, this.env, 30_000),
      truncated: result.truncated,
    };
  }

  git(args, options = {}) {
    return this.run('git', [
      '-c', `safe.directory=${this.repoDir}`, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'user.name=Fahad AI Office Coding Agent', '-c', 'user.email=coding-agent@users.noreply.github.com',
      ...args,
    ], options);
  }

  // Git commands that need credentials run as the controller, but only in
  // controller-owned repositories or during the initial clone.
  async controllerGit(args, { cwd = this.controlDir, token = null, timeoutMs = 300_000 } = {}) {
    const env = { PATH: process.env.PATH, HOME: this.controlDir, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', LANG: 'C.UTF-8' };
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'GIT_SSL_CAINFO', 'SSL_CERT_FILE']) {
      if (process.env[name]) env[name] = process.env[name];
    }
    let askPass = null;
    if (token) {
      askPass = join(this.controlDir, `askpass-${process.pid}-${this.now()}.sh`);
      await writeFile(askPass, '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" "x-access-token" ;; *) printf "%s\\n" "$FAHAD_GIT_TOKEN" ;; esac\n', { mode: 0o700 });
      Object.assign(env, { GIT_ASKPASS: askPass, GIT_ASKPASS_REQUIRE: 'force', FAHAD_GIT_TOKEN: token });
    }
    try {
      const result = await runProcess('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', ...args], { cwd, env, timeoutMs, maxOutputBytes: 200_000 });
      return { ...result, stdout: redact(result.stdout, { ...this.env, FAHAD_GIT_TOKEN: token }), stderr: redact(result.stderr, { ...this.env, FAHAD_GIT_TOKEN: token }) };
    } finally {
      if (askPass) await rm(askPass, { force: true });
    }
  }

  // Moves a sandbox branch into the controller-owned publish repository via a
  // bundle (pure data), then pushes it with the controller's credential.
  async publishBranch({ repository, branch, token, pushUrl = null, expectedHead, previousHead = null }) {
    const bundle = join(this.homeDir, 'tmp', 'publish.bundle');
    await rm(bundle, { force: true });
    const created = await this.git(['bundle', 'create', bundle, branch]);
    if (created.code !== 0) throw policyError('BUNDLE_FAILED', 'Could not bundle the work branch');
    await mkdir(this.controlDir, { recursive: true, mode: 0o700 });
    if (!(await pathExists(join(this.publishRepo, 'HEAD')))) {
      const init = await this.controllerGit(['init', '--bare', '--quiet', this.publishRepo]);
      if (init.code !== 0) throw policyError('PUBLISH_INIT_FAILED', 'Could not prepare the publish repository');
    }
    const controlBundle = join(this.controlDir, 'publish.bundle');
    await writeFile(controlBundle, await readFile(bundle));
    const fetched = await this.controllerGit(['--git-dir', this.publishRepo, 'fetch', '--no-tags', '--force', controlBundle, `+refs/heads/${branch}:refs/heads/${branch}`]);
    if (fetched.code !== 0) throw policyError('PUBLISH_FETCH_FAILED', 'Could not import the work branch');
    const head = (await this.controllerGit(['--git-dir', this.publishRepo, 'rev-parse', `refs/heads/${branch}`])).stdout.trim();
    if (expectedHead && head !== expectedHead) throw policyError('PUBLISH_HEAD_MISMATCH', 'Published head differs from the tested head');
    const url = pushUrl || `https://github.com/${repository}.git`;
    // Explicit lease: the remote branch must still be at the head this session
    // last pushed (or must not exist yet), so concurrent changes are never lost.
    const lease = `--force-with-lease=refs/heads/${branch}:${/^[0-9a-f]{40}$/.test(previousHead || '') ? previousHead : ''}`;
    const pushed = await this.controllerGit(['--git-dir', this.publishRepo, 'push', lease, url, `refs/heads/${branch}:refs/heads/${branch}`], { token, timeoutMs: 300_000 });
    await rm(controlBundle, { force: true });
    if (pushed.code !== 0) throw policyError('PUSH_FAILED', `Push failed: ${pushed.stderr.split('\n').filter(Boolean).at(-1) || 'unknown error'}`);
    return { head };
  }

  // ---------------------------------------------------------------- files
  async resolveInside(path, { mustExist = true } = {}) {
    const relativePath = normalizeRepoPath(path);
    const repoReal = await realpath(this.repoDir);
    const absolute = relativePath === '.' ? repoReal : join(repoReal, relativePath);
    const parent = await realpath(dirname(absolute)).catch(() => null);
    if (parent && parent !== repoReal && !parent.startsWith(repoReal + sep)) throw policyError('PATH_ESCAPE', 'Path resolves outside the repository');
    if (mustExist) {
      const real = await realpath(absolute).catch(() => null);
      if (!real) throw policyError('FILE_NOT_FOUND', `${relativePath} does not exist`);
      if (real !== repoReal && !real.startsWith(repoReal + sep)) throw policyError('PATH_ESCAPE', 'Path resolves outside the repository');
    }
    return { absolute, relativePath, repoReal };
  }

  async readFile(path, { startLine = 1, endLine = null } = {}) {
    const { absolute, relativePath } = await this.resolveInside(path);
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw policyError('NOT_A_FILE', `${relativePath} is not a regular file`);
      const buffer = Buffer.alloc(Math.min(info.size, MAX_READ_BYTES));
      await handle.read(buffer, 0, buffer.length, 0);
      if (buffer.includes(0)) return { path: relativePath, binary: true, bytes: info.size, content: '' };
      const lines = buffer.toString('utf8').split('\n');
      const first = Math.max(1, Number(startLine) || 1);
      const last = Math.min(lines.length, Number(endLine) || lines.length);
      const content = lines.slice(first - 1, last).map((line, index) => `${String(first + index).padStart(5)}  ${line}`).join('\n');
      return {
        path: relativePath, bytes: info.size, totalLines: lines.length, startLine: first, endLine: last,
        truncated: info.size > MAX_READ_BYTES, content: redact(content, this.env, 120_000),
      };
    } finally {
      await handle.close();
    }
  }

  async writeFile(path, content, { allowProtected = false } = {}) {
    const normalized = assertWritablePath(path, { allowProtected });
    const { absolute } = await this.resolveInside(normalized, { mustExist: false });
    const existing = await lstat(absolute).catch(() => null);
    if (existing?.isSymbolicLink()) throw policyError('SYMLINK_WRITE', 'Refusing to write through a symbolic link');
    if (existing && !existing.isFile()) throw policyError('NOT_A_FILE', `${normalized} is not a regular file`);
    await this.mkdirInside(dirname(normalized));
    const handle = await open(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
    try {
      await handle.writeFile(String(content), 'utf8');
    } finally {
      await handle.close();
    }
    if (this.isolated) await lchown(absolute, this.identity.uid, this.identity.gid);
    return { path: normalized, bytes: Buffer.byteLength(String(content)), created: !existing };
  }

  async editFile(path, oldText, newText, { replaceAll = false, allowProtected = false } = {}) {
    const normalized = assertWritablePath(path, { allowProtected });
    const { absolute } = await this.resolveInside(normalized);
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    let current;
    try { current = await handle.readFile('utf8'); } finally { await handle.close(); }
    if (!oldText) throw policyError('EDIT_EMPTY', 'old_text must not be empty');
    const occurrences = current.split(oldText).length - 1;
    if (occurrences === 0) throw policyError('EDIT_NOT_FOUND', 'old_text was not found; read the file again and copy the exact text');
    if (occurrences > 1 && !replaceAll) throw policyError('EDIT_AMBIGUOUS', `old_text matches ${occurrences} places; include more context or set replace_all`);
    const next = replaceAll ? current.split(oldText).join(newText) : current.replace(oldText, () => newText);
    await this.writeFile(normalized, next, { allowProtected });
    return { path: normalized, replacements: replaceAll ? occurrences : 1 };
  }

  async mkdirInside(relativeDir) {
    if (!relativeDir || relativeDir === '.') return;
    let current = this.repoDir;
    for (const part of relativeDir.split('/')) {
      current = join(current, part);
      const info = await lstat(current).catch(() => null);
      if (info?.isSymbolicLink()) throw policyError('SYMLINK_WRITE', 'Refusing to create files through a symbolic link');
      if (!info) {
        await mkdir(current, { mode: 0o755 });
        if (this.isolated) await lchown(current, this.identity.uid, this.identity.gid);
      } else if (!info.isDirectory()) {
        throw policyError('NOT_A_DIRECTORY', `${relative(this.repoDir, current)} is not a directory`);
      }
    }
  }

  async listFiles(path = '.', { max = 400 } = {}) {
    const { relativePath } = await this.resolveInside(path);
    const result = await this.run('rg', ['--files', '--hidden', '--glob', '!.git', ...(relativePath === '.' ? [] : [relativePath])], { timeoutMs: 60_000 });
    const files = result.stdout.split('\n').filter(Boolean).sort();
    return { path: relativePath, total: files.length, files: files.slice(0, max), truncated: files.length > max };
  }

  async search(pattern, { path = '.', glob = null, max = 200 } = {}) {
    if (!pattern || String(pattern).length > 500) throw policyError('SEARCH_PATTERN_INVALID', 'Search pattern must contain 1 to 500 characters');
    const { relativePath } = await this.resolveInside(path);
    const args = ['--line-number', '--no-heading', '--color', 'never', '--max-count', '50', '--hidden', '--glob', '!.git'];
    if (glob) args.push('--glob', String(glob));
    args.push('--', String(pattern), relativePath);
    const result = await this.run('rg', args, { timeoutMs: 60_000 });
    const lines = result.stdout.split('\n').filter(Boolean);
    return { matches: lines.slice(0, max).map((line) => redact(line.slice(0, 400), this.env)), total: lines.length, truncated: lines.length > max };
  }

  // ---------------------------------------------------------------- git state
  async gitState() {
    const status = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const branch = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    const head = (await this.git(['rev-parse', 'HEAD'])).stdout.trim();
    const changed = [];
    const entries = status.stdout.split('\0').filter(Boolean);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const code = entry.slice(0, 2);
      changed.push({ status: code.trim() || code, path: entry.slice(3) });
      if (code.startsWith('R') || code.startsWith('C')) index += 1;
    }
    return { branch, head, changed };
  }

  async diff({ path = null, maxBytes = 120_000 } = {}) {
    // Intent-to-add makes new files visible in the diff without staging them.
    await this.git(['add', '--intent-to-add', '--all']);
    const args = ['diff', '--no-ext-diff', '--no-color'];
    if (path) args.push('--', normalizeRepoPath(path));
    const result = await this.git(args, { maxOutputBytes: maxBytes * 4 });
    return { diff: redact(result.stdout, this.env, maxBytes), truncated: result.stdout.length > maxBytes };
  }

  async fullPatch(maxBytes = 1_500_000) {
    await this.git(['add', '--intent-to-add', '--all']);
    const result = await this.git(['diff', '--binary', '--no-ext-diff', 'HEAD'], { maxOutputBytes: maxBytes + 1 });
    return result.stdout.length <= maxBytes ? result.stdout : null;
  }

  async commitAll(message) {
    const add = await this.git(['add', '--all']);
    if (add.code !== 0) throw policyError('GIT_ADD_FAILED', 'git add failed');
    const staged = await this.git(['diff', '--cached', '--quiet']);
    if (staged.code === 0) return { committed: false, head: (await this.git(['rev-parse', 'HEAD'])).stdout.trim() };
    const commit = await this.git(['commit', '--no-verify', '-m', message]);
    if (commit.code !== 0) throw policyError('GIT_COMMIT_FAILED', `git commit failed: ${redact(commit.stderr).split('\n').find(Boolean) || ''}`);
    return { committed: true, head: (await this.git(['rev-parse', 'HEAD'])).stdout.trim() };
  }

  async changedPathsSince(baseRef) {
    const result = await this.git(['diff', '--name-only', '-z', `${baseRef}...HEAD`]);
    return result.stdout.split('\0').filter(Boolean);
  }
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function runProcess(command, args, { cwd, env, timeoutMs = 300_000, maxOutputBytes = 200_000, identity = null, detached = false, input = null } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd, env, shell: false, windowsHide: true, detached,
      stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...(identity ? { uid: identity.uid, gid: identity.gid } : {}),
    });
    if (input != null) child.stdin.end(input);
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const append = (current, chunk) => {
      const next = current + chunk;
      if (next.length > maxOutputBytes) {
        truncated = true;
        return next.slice(-maxOutputBytes);
      }
      return next;
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, String(chunk)); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, String(chunk)); });
    let timedOut = false;
    let hardKill;
    const kill = (signal) => {
      try {
        if (detached && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      hardKill = setTimeout(() => kill('SIGKILL'), 5000);
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); clearTimeout(hardKill); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(hardKill);
      if (detached) kill('SIGKILL');
      resolvePromise({ code: code ?? (timedOut ? 124 : 1), signal, stdout, stderr, timedOut, truncated });
    });
  });
}

// Kills every remaining process owned by the sandbox uid. In the coding
// worker container that uid runs nothing but agent-initiated commands.
export async function killUidProcesses(uid) {
  let entries = [];
  try { entries = await readdir('/proc'); } catch { return 0; }
  let killed = 0;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = await readFile(`/proc/${entry}/status`, 'utf8');
      const match = status.match(/^Uid:\s+(\d+)/m);
      if (match && Number(match[1]) === uid) {
        process.kill(Number(entry), 'SIGKILL');
        killed += 1;
      }
    } catch {}
  }
  return killed;
}
