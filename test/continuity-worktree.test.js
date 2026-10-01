import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { WorktreeManager } from '../src/continuity/worktree.js';

const runFile = promisify(execFile);
async function git(cwd, ...args) { return String((await runFile('git', ['-C', cwd, ...args], { windowsHide: true })).stdout || '').trim(); }

test('worktree manager fetches the exact remote task branch before an external worker starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fahad-continuity-worktree-'));
  const repository = join(root, 'repository');
  const remote = join(root, 'remote.git');
  const publisher = join(root, 'publisher');
  const worktreesRoot = join(root, 'worktrees');
  const worktree = join(worktreesRoot, 'worker');
  try {
    await mkdir(repository);
    await git(repository, 'init', '-b', 'main');
    await git(repository, 'config', 'user.name', 'Continuity Test');
    await git(repository, 'config', 'user.email', 'continuity@example.invalid');
    await writeFile(join(repository, 'base.txt'), 'base\n');
    await git(repository, 'add', '.');
    await git(repository, 'commit', '-m', 'base');
    await git(repository, 'branch', 'codex/remote-task');
    await runFile('git', ['clone', '--bare', repository, remote], { windowsHide: true });
    await git(repository, 'remote', 'add', 'origin', remote);
    await runFile('git', ['clone', remote, publisher], { windowsHide: true });
    await git(publisher, 'config', 'user.name', 'Continuity Publisher');
    await git(publisher, 'config', 'user.email', 'publisher@example.invalid');
    await git(publisher, 'switch', 'codex/remote-task');
    await writeFile(join(publisher, 'remote.txt'), 'pushed by the previous worker\n');
    await git(publisher, 'add', 'remote.txt');
    await git(publisher, 'commit', '-m', 'remote worker checkpoint');
    await git(publisher, 'push', 'origin', 'codex/remote-task');
    const remoteHead = await git(publisher, 'rev-parse', 'HEAD');
    assert.notEqual(await git(repository, 'rev-parse', 'codex/remote-task'), remoteHead, 'the supervisor clone starts stale');

    const manager = new WorktreeManager({ repositoryRoot: repository, worktreesRoot });
    const created = await manager.create({ path: worktree, branch: 'codex/remote-task', refresh: true });
    assert.equal(created.head, remoteHead);
    assert.equal(await git(worktree, 'show', 'HEAD:remote.txt'), 'pushed by the previous worker');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('worktree refresh fails closed when the configured remote branch is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fahad-continuity-worktree-fail-'));
  const repository = join(root, 'repository');
  const worktreesRoot = join(root, 'worktrees');
  try {
    await mkdir(repository);
    await git(repository, 'init', '-b', 'main');
    await git(repository, 'config', 'user.name', 'Continuity Test');
    await git(repository, 'config', 'user.email', 'continuity@example.invalid');
    await writeFile(join(repository, 'base.txt'), 'base\n');
    await git(repository, 'add', '.');
    await git(repository, 'commit', '-m', 'base');
    const manager = new WorktreeManager({ repositoryRoot: repository, worktreesRoot });
    await assert.rejects(manager.create({ path: join(worktreesRoot, 'worker'), branch: 'codex/missing', refresh: true }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
