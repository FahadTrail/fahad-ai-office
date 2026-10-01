import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ContinuitySupervisor } from '../src/continuity/supervisor.js';
import { ContinuityCheckpointer } from '../src/continuity/checkpointer.js';
import { WorktreeManager } from '../src/continuity/worktree.js';
import { MemoryContinuityStore, fakeAdapter, validCheckpoint } from '../testing/fixtures/continuity-harness.js';

const runFile = promisify(execFile);
async function git(cwd, ...args) { return String((await runFile('git', ['-C', cwd, ...args], { windowsHide: true })).stdout || '').trim(); }

test('continuity e2e: Office crash recovers through Codex and Claude on one real branch without duplicate edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fahad-continuity-e2e-'));
  const repository = join(root, 'repo');
  const worktreesRoot = join(root, 'worktrees');
  const worktree = join(worktreesRoot, 'continuity');
  await mkdir(repository); await mkdir(worktreesRoot);
  try {
    await git(repository, 'init', '-b', 'main');
    await git(repository, 'config', 'user.name', 'Continuity Test');
    await git(repository, 'config', 'user.email', 'continuity@example.invalid');
    await writeFile(join(repository, 'base.txt'), 'base\n');
    await git(repository, 'add', '.'); await git(repository, 'commit', '-m', 'base');
    await git(repository, 'branch', 'codex/continuity-runtime');
    const worktrees = new WorktreeManager({ repositoryRoot: repository, worktreesRoot });
    await worktrees.create({ path: worktree, branch: 'codex/continuity-runtime' });
    await git(worktree, 'config', 'user.name', 'Continuity Test');
    await git(worktree, 'config', 'user.email', 'continuity@example.invalid');
    const base = await git(worktree, 'rev-parse', 'HEAD');

    const store = new MemoryContinuityStore({ workers: [
      { key: 'office', kind: 'native', enabled: true, quota_source: 'office-pools' },
      { key: 'codex', kind: 'cli', enabled: true, quota_source: 'openai-chatgpt' },
      { key: 'claude-code', kind: 'cli', enabled: true, quota_source: 'anthropic-claude-subscription' },
    ] });
    const office = fakeAdapter('office', { quality: 5 });
    office.start = async (input) => {
      await writeFile(join(input.worktree, 'office.txt'), 'office atomic step\n');
      await git(input.worktree, 'add', 'office.txt'); await git(input.worktree, 'commit', '-m', 'office step');
      return { session: { id: 'office-run', worktree: input.worktree } };
    };
    const codex = fakeAdapter('codex', { quality: 4 });
    codex.start = async (input) => {
      assert.equal(await git(input.worktree, 'show', 'HEAD:office.txt'), 'office atomic step', 'Codex sees the previous worker commit');
      await writeFile(join(input.worktree, 'codex.txt'), 'codex continuation\n');
      await git(input.worktree, 'add', 'codex.txt'); await git(input.worktree, 'commit', '-m', 'codex continuation');
      return { session: { id: 'codex-run', worktree: input.worktree } };
    };
    const claude = fakeAdapter('claude-code', { quality: 3 });
    claude.start = async (input) => {
      assert.equal(await git(input.worktree, 'show', 'HEAD:office.txt'), 'office atomic step');
      assert.equal(await git(input.worktree, 'show', 'HEAD:codex.txt'), 'codex continuation');
      await writeFile(join(input.worktree, 'claude.txt'), 'claude finish\n');
      await git(input.worktree, 'add', 'claude.txt'); await git(input.worktree, 'commit', '-m', 'claude finish');
      return { session: { id: 'claude-run', worktree: input.worktree } };
    };
    const supervisor = new ContinuitySupervisor({
      store, adapters: [office, codex, claude],
      checkpointerFactory: (options) => new ContinuityCheckpointer({ ...options, writeMirror: async () => {}, env: {}, clock: { now: () => Date.now() } }),
      gates: async () => ({ ok: true, checks: [], failed: [], nextExactAction: null }),
      verifyBranch: (_lease, checkpoint) => worktrees.verifyAgainstCheckpoint({ worktree, checkpoint }),
      confirmStopped: async () => true, // the fake Office process was explicitly killed above
    });
    const task = { projectId: 'p', repository: 'FahadTrail/fahad-ai-office', branch: 'codex/continuity-runtime', worktree, objective: 'E2E recovery.', dataClass: 'PUBLIC', size: 'medium', capability: 'coding' };
    const started = await supervisor.startTask({ task, checkpoint: validCheckpoint({ base_commit: base, last_commit: base }) });
    const officeHead = await git(worktree, 'rev-parse', 'HEAD');
    assert.notEqual(officeHead, base);

    const activeLease = [...store.leases.values()].find((lease) => lease.status === 'ACTIVE');
    activeLease.stale = true;
    supervisor.leaseManager.stopAll();
    supervisor.running.clear(); // the Office process disappeared before its next checkpoint
    const recovered = await supervisor.recoverStale();
    assert.equal(recovered[0].recovered, true);
    assert.equal(recovered[0].worker, 'codex');
    const codexHead = await git(worktree, 'rev-parse', 'HEAD');
    assert.notEqual(codexHead, officeHead);
    assert.deepEqual((await git(worktree, 'log', '--format=%s', '-3')).split(/\r?\n/), ['codex continuation', 'office step', 'base']);
    const runtime = [...supervisor.running.values()][0];
    assert.equal(runtime.checkpoint.last_commit, officeHead, 'recovery checkpoint records the commit made after the crashed worker checkpoint');
    assert.match(runtime.checkpoint.decisions.at(-1), new RegExp(officeHead));
    assert.equal([...store.leases.values()].filter((lease) => lease.status === 'ACTIVE').length, 1);
    const handed = await supervisor.handoff(runtime.session.id, {
      reason: 'forced drill handoff', preferredWorker: 'claude-code',
      checkpoint: validCheckpoint({ base_commit: base, last_commit: codexHead, agent_id: 'codex', agent_type: 'cli' }),
    });
    assert.equal(handed.handedOff, true);
    assert.equal(handed.to, 'claude-code');
    assert.equal([...store.leases.values()].filter((lease) => lease.status === 'ACTIVE').length, 1);
    const claudeHead = await git(worktree, 'rev-parse', 'HEAD');
    assert.deepEqual((await git(worktree, 'log', '--format=%s', '-4')).split(/\r?\n/), ['claude finish', 'codex continuation', 'office step', 'base']);
    await supervisor.finish(handed.session.id, { checkpoint: validCheckpoint({ base_commit: base, last_commit: claudeHead, agent_id: 'claude-code', agent_type: 'cli' }) });
    assert.equal([...store.leases.values()].filter((lease) => lease.status === 'ACTIVE').length, 0);
    assert.equal(store.sessions.get(handed.session.id).status, 'COMPLETED');
    supervisor.stop();
    assert.equal(started.worker, 'office');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
