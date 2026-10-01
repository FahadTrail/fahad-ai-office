import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

const execFile = promisify(nodeExecFile);

function inside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel && !rel.startsWith('..') && !isAbsolute(rel);
}
function remoteRepository(url) {
  const normalized = String(url || '').replace(/\.git\/?$/i, '').replace(/\/$/, '');
  const match = normalized.match(/(?:[^@/]+@[^:]+:|https?:\/\/[^/]+\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/i);
  return match?.[1] || null;
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

  async create({ path, branch, repository = null, refresh = false, remote = 'origin' }) {
    const target = this.assertTarget(path);
    if (repository) {
      const configured = remoteRepository(await this.git(['remote', 'get-url', remote]));
      if (!configured || configured.toLowerCase() !== repository.toLowerCase()) throw new Error('CONTINUITY_REPOSITORY_MISMATCH');
    }
    if (['main', 'master'].includes(branch)) throw new Error('CONTINUITY_PROTECTED_BRANCH');
    await this.git(['check-ref-format', '--branch', branch]);
    const existing = await lstat(target).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing) throw new Error('CONTINUITY_WORKTREE_TARGET_EXISTS');
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
    const target = this.assertTarget(worktree);
    let branch = null;
    try { branch = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: target }); }
    catch { /* Detached HEAD is not the leased branch. */ }
    let checkpointAncestor = head === checkpoint.last_commit;
    if (!checkpointAncestor && /^[0-9a-f]{40}$/.test(checkpoint.last_commit || '')) {
      try { await this.git(['merge-base', '--is-ancestor', checkpoint.last_commit, head], { cwd: target }); checkpointAncestor = true; }
      catch { checkpointAncestor = false; }
    }
    const extra = checkpointAncestor && head !== checkpoint.last_commit
      ? (await this.git(['log', '--format=%H', `${checkpoint.last_commit}..${head}`], { cwd: target })).split(/\r?\n/).filter(Boolean) : [];
    return { ok: status.clean && branch === checkpoint.branch && checkpointAncestor, head, branch, checkpointAncestor, extraCommits: extra, dirtyFiles: status.files };
  }

  async remove(path) {
    const target = this.assertTarget(path);
    const entry = await lstat(target);
    if (entry.isSymbolicLink()) throw new Error('CONTINUITY_WORKTREE_SYMLINK');
    const status = await this.status(target);
    if (!status.clean) throw new Error('CONTINUITY_WORKTREE_NOT_CLEAN');
    await this.git(['worktree', 'remove', target]);
    return true;
  }

  async publish(path, branch, remote = 'origin') {
    const target = this.assertTarget(path);
    if (['main', 'master'].includes(branch)) throw new Error('CONTINUITY_PROTECTED_BRANCH');
    await this.git(['check-ref-format', '--branch', branch]);
    const current = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: target });
    if (current !== branch) throw new Error('CONTINUITY_WORKTREE_BRANCH_MISMATCH');
    if (!(await this.status(target)).clean) throw new Error('CONTINUITY_WORKTREE_NOT_CLEAN');
    await this.git(['push', '--porcelain', remote, `refs/heads/${branch}:refs/heads/${branch}`], { cwd: target });
    return { branch, head: await this.head(target) };
  }
}
