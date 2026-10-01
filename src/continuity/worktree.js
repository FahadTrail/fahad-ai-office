import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

const execFile = promisify(nodeExecFile);

function inside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel && !rel.startsWith('..') && !isAbsolute(rel);
}
export class WorktreeManager {
  constructor({ repositoryRoot, worktreesRoot, run = execFile } = {}) {
    if (!repositoryRoot || !worktreesRoot) throw new TypeError('WorktreeManager requires repositoryRoot and worktreesRoot');
    this.repositoryRoot = resolve(repositoryRoot);
    this.worktreesRoot = resolve(worktreesRoot);
    this.run = run;
  }

  assertTarget(path) {
    if (!inside(this.worktreesRoot, path)) throw new Error('CONTINUITY_WORKTREE_OUTSIDE_ROOT');
    return resolve(path);
  }

  async git(args, options = {}) {
    const outcome = await this.run('git', ['-C', options.cwd || this.repositoryRoot, ...args], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return String(outcome?.stdout || '').trim();
  }

  async create({ path, branch, refresh = false, remote = 'origin' }) {
    const target = this.assertTarget(path);
    await mkdir(this.worktreesRoot, { recursive: true });
    if (refresh) {
      // A native Office session may have pushed the task branch from another
      // checkout. Fetch the exact branch before an external worker receives
      // the baton; never let it start from a stale local ref.
      await this.git(['fetch', '--no-tags', remote, branch]);
      await this.git(['worktree', 'add', '-B', branch, target, 'FETCH_HEAD']);
    } else {
      await this.git(['worktree', 'add', target, branch]);
    }
    return { path: target, branch, head: await this.head(target) };
  }

  async head(path) {
    return this.git(['rev-parse', 'HEAD'], { cwd: this.assertTarget(path) });
  }

  async status(path) {
    const text = await this.git(['status', '--porcelain=v1'], { cwd: this.assertTarget(path) });
    return { clean: text.length === 0, detail: text, files: text ? text.split(/\r?\n/).map((line) => line.slice(3)) : [] };
  }

  async changedSince(path, baseCommit) {
    const target = this.assertTarget(path);
    const committed = /^[0-9a-f]{40}$/.test(baseCommit || '')
      ? (await this.git(['diff', '--name-only', `${baseCommit}..HEAD`], { cwd: target })).split(/\r?\n/).filter(Boolean) : [];
    const status = await this.status(target);
    return [...new Set([...committed, ...status.files])].sort();
  }

  async verifyAgainstCheckpoint({ worktree, checkpoint }) {
    const head = await this.head(worktree);
    const status = await this.status(worktree);
    const extra = head === checkpoint.last_commit ? [] : (await this.git(['log', '--format=%H', `${checkpoint.last_commit}..${head}`], { cwd: this.assertTarget(worktree) })).split(/\r?\n/).filter(Boolean);
    return { ok: status.clean, head, extraCommits: extra, dirtyFiles: status.files };
  }

  async remove(path) {
    const target = this.assertTarget(path);
    const status = await this.status(target);
    if (!status.clean) throw new Error('CONTINUITY_WORKTREE_NOT_CLEAN');
    await this.git(['worktree', 'remove', target]);
    return true;
  }
}
