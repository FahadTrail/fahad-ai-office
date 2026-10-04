// Regression tests for the Office → Continuity publish path: when Continuity
// binds a session's work branch to an already-existing leased remote branch
// (workBranch === baseBranch), the first push must lease against the exact
// remote head the sandbox was cloned from. The empty lease ("branch must not
// exist") is correct only for a standalone Coding Agent session minting a
// brand-new branch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox } from '../src/coding-agent/sandbox.js';
import { CodingWorker } from '../src/coding-agent/runtime.js';
import {
  REPOSITORY, WORKSPACE_ID, createFixtureRepo, fakeApis, localRuntime,
} from '../testing/fixtures/coding-agent-harness.js';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=LeaseTest', '-c', 'user.email=lease@example.com', ...args], { cwd, stdio: 'pipe' }).toString().trim();
const gitDir = (dir, ...args) => execFileSync('git', [`--git-dir=${dir}`, ...args], { stdio: 'pipe' }).toString().trim();
const remoteHead = (bare, branch) => gitDir(bare, 'rev-parse', `refs/heads/${branch}`);

// One deterministic, non-failing scripted model: inspect, plan, fix the bug,
// run the tests, finish. The controller then owns commit and push.
let callCounter = 0;
const call = (name, args) => ({ type: 'tool_call', id: `lease_${callCounter++}`, name, arguments: args });
const reply = (blocks, text = null) => ({
  message: { role: 'assistant', content: [...(text ? [{ type: 'text', text }] : []), ...blocks] },
  stopReason: 'tool_calls',
  usage: { inputTokens: 1000, outputTokens: 50, costUsd: 0.001 },
  requestId: null, rateLimit: null, durationMs: 5,
});

function scriptedFixer() {
  return {
    async turn({ messages }) {
      const calls = messages.flatMap((message) => message.content.filter((block) => block.type === 'tool_call'));
      const has = (name) => calls.some((entry) => entry.name === name);
      if (!has('list_files')) return reply([call('list_files', {})], 'Inspecting the repository.');
      if (!has('update_plan')) return reply([call('update_plan', {
        steps: [{ title: 'Reproduce the failing test', status: 'in_progress' }, { title: 'Fix add()', status: 'pending' }, { title: 'Verify and finish', status: 'pending' }],
        next_action: 'Run the test suite, then fix add()',
      })]);
      if (!has('edit_file')) return reply([call('edit_file', { path: 'src/math.js', old_text: 'return a - b;', new_text: 'return a + b;' })]);
      if (!has('run_command')) return reply([call('run_command', { command: 'npm test' })]);
      return reply([call('finish', { summary: 'Fixed add() to sum its arguments; tests pass.', tests_run: 'npm test' })]);
    },
  };
}

function leasePool() {
  const common = { toolCalling: true, contextWindow: 200_000, privacyApproved: true, unavailableReasons: [], pricing: { inputPerMillion: 1, outputPerMillion: 1 } };
  return [{
    ...common, id: 'anthropic:claude-opus-5', provider: 'anthropic', model: 'claude-opus-5',
    billingClass: 'paid', qualityTier: 5, costTier: 4, secretRef: 'env://ANTHROPIC_API_KEY',
    protocolClient: scriptedFixer(),
  }];
}

// Mirrors the Phase N Office leg: publish to the branch only — no PR, no CI
// wait, no merge, no deploy, no production verification.
function leaseSessionConfig(bare) {
  return {
    testCommand: 'npm test',
    publish: 'branch',
    deploy: { mode: 'none' },
    verify: {},
    supabase: { projects: [] },
    githubApiBase: 'https://api.github.test',
    routing: { strategy: 'balanced' },
    fetchUrl: bare,
    pushUrl: bare,
  };
}

async function pushEvents(sessionStore, sessionId) {
  const events = await sessionStore.listEvents(sessionId);
  return events.filter((event) => event.type === 'tool_call' && event.message === 'git.push');
}

test('a pre-existing Continuity-bound branch publishes its first push with the exact cloned head as the lease', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'fahad-lease-bound-'));
  try {
    const { bare } = createFixtureRepo(root);
    const branch = 'continuity/phase-n-lease';
    // The Supervisor pre-creates and pushes the leased branch before Office starts.
    git(join(root, 'fixture-src'), 'branch', branch);
    git(join(root, 'fixture-src'), 'push', bare, `refs/heads/${branch}:refs/heads/${branch}`);
    const leaseHead = remoteHead(bare, branch);

    const apis = fakeApis({ bare });
    const { runtime, sessionStore, auditStore } = localRuntime({ root, storePath: join(root, 'state.json'), pool: leasePool(), fetchFn: apis.fetchFn });
    const created = await sessionStore.createSession({
      workspaceId: WORKSPACE_ID, title: 'Phase N Office leg', repository: REPOSITORY,
      objective: 'Harmless Phase N drill: create only the marker change, commit and push this branch. Touch no other file.',
      baseBranch: branch, config: leaseSessionConfig(bare),
    });
    // OfficeContinuityAdapter.start() binds work_branch to the leased branch.
    sessionStore.data.sessions[created.id].work_branch = branch;
    sessionStore.persist();

    const worker = new CodingWorker({ runtime, sessionStore });
    const outcome = await worker.runOnce();
    assert.equal(outcome.status, 'completed', outcome.blocker);

    const session = await sessionStore.getSession(created.id);
    assert.equal(session.workBranch, branch);
    // The expected remote head was initialized to the exact cloned head…
    assert.equal(session.state.git.boundRemoteHead, leaseHead, 'bound sessions record the exact cloned remote head');
    const pushes = await pushEvents(sessionStore, created.id);
    assert.equal(pushes.length, 1, 'exactly one controller-owned push');
    assert.equal(pushes[0].payload.args.previous_head, leaseHead, 'the first push leases the exact cloned remote head');
    // …and the remote branch advanced by one commit on top of it.
    const pushed = remoteHead(bare, branch);
    assert.equal(pushed, session.state.git.pushedHead);
    assert.deepEqual(gitDir(bare, 'log', '--format=%P', '-1', pushed).split(/\s+/), [leaseHead], 'the push built on the leased head instead of replacing history');
    assert.equal(apis.state.pulls.length, 0, 'publish:branch opens no pull request');
    assert.ok(auditStore.rows().some((row) => row.tool === 'git.push' && row.status === 'succeeded'), 'git.push audited as succeeded');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a Continuity-bound branch whose remote changed unexpectedly fails closed and is never overwritten', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'fahad-lease-closed-'));
  try {
    const { bare, baseHead } = createFixtureRepo(root);
    const src = join(root, 'fixture-src');
    const branch = 'continuity/phase-n-lease';
    // Two commits on the leased branch: baseHead (A) then the lease head (B).
    git(src, 'checkout', '-q', '-b', branch);
    writeFileSync(join(src, 'notes.txt'), 'leased\n');
    git(src, 'add', '.');
    git(src, 'commit', '-qm', 'lease base');
    git(src, 'push', bare, `refs/heads/${branch}:refs/heads/${branch}`);
    const leaseHead = remoteHead(bare, branch);
    assert.notEqual(leaseHead, baseHead);

    const sandbox = new Sandbox({ root: join(root, 'sandboxes'), sessionId: randomUUID(), mode: 'unisolated' });
    await sandbox.prepare({ repository: REPOSITORY, baseBranch: branch, workBranch: branch, fetchUrl: bare });
    assert.equal(await sandbox.trackingHead(branch), leaseHead, 'the clone recorded the exact remote head');
    await sandbox.writeFile('src/math.js', 'export function add(a, b) {\n  return a + b;\n}\n');
    const { head: localHead } = await sandbox.commitAll('local work');

    // Another worker advances the remote branch in the meantime.
    const other = join(root, 'other');
    execFileSync('git', ['clone', '-q', '--branch', branch, bare, other], { stdio: 'pipe' });
    writeFileSync(join(other, 'z.txt'), 'other worker\n');
    git(other, 'add', '.');
    git(other, 'commit', '-qm', 'other worker');
    git(other, 'push', '-q', 'origin', `refs/heads/${branch}:refs/heads/${branch}`);
    const moved = remoteHead(bare, branch);
    assert.notEqual(moved, leaseHead);

    const publish = (previousHead) => sandbox.publishBranch({
      repository: REPOSITORY, branch, token: null, pushUrl: bare, expectedHead: localHead, previousHead,
    });
    // The exact (now stale) lease head must fail closed, keeping the remote.
    await assert.rejects(() => publish(leaseHead), (error) => error.code === 'PUSH_FAILED');
    assert.equal(remoteHead(bare, branch), moved, 'the moved remote branch was not overwritten');
    // The old empty lease ("branch must not exist") also fails, as git rightly insists.
    await assert.rejects(() => publish(null), (error) => error.code === 'PUSH_FAILED');
    assert.equal(remoteHead(bare, branch), moved, 'the empty lease never force-created the branch');

    // Pure lease protection: the remote is rewritten back to an ancestor, so a
    // plain push would fast-forward; the explicit lease must still refuse.
    gitDir(bare, 'update-ref', `refs/heads/${branch}`, baseHead);
    await assert.rejects(() => publish(leaseHead), (error) => error.code === 'PUSH_FAILED');
    assert.equal(remoteHead(bare, branch), baseHead, 'the unexpectedly reset branch was not advanced');

    // With the remote restored to the expected head, the exact lease succeeds.
    gitDir(bare, 'update-ref', `refs/heads/${branch}`, leaseHead);
    await publish(leaseHead);
    assert.equal(remoteHead(bare, branch), localHead, 'the leased push succeeded against the unchanged remote');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a normal standalone Coding Agent branch keeps its empty first-push lease', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'fahad-lease-standalone-'));
  try {
    const { bare, baseHead } = createFixtureRepo(root);
    const apis = fakeApis({ bare });
    const { runtime, sessionStore, auditStore } = localRuntime({ root, storePath: join(root, 'state.json'), pool: leasePool(), fetchFn: apis.fetchFn });
    const created = await sessionStore.createSession({
      workspaceId: WORKSPACE_ID, title: 'Fix add() bug', repository: REPOSITORY,
      objective: 'The add() function returns wrong results. Fix it, keep tests green.',
      config: leaseSessionConfig(bare),
    });

    const worker = new CodingWorker({ runtime, sessionStore });
    const outcome = await worker.runOnce();
    assert.equal(outcome.status, 'completed', outcome.blocker);

    const session = await sessionStore.getSession(created.id);
    assert.match(session.workBranch, /^fahad\//, 'the session minted its own work branch');
    // No Continuity binding: no expected-remote-head initialization happens.
    assert.ok(!session.state.git.boundRemoteHead, 'standalone sessions never lease against a pre-existing head');
    const pushes = await pushEvents(sessionStore, created.id);
    assert.equal(pushes.length, 1, 'exactly one controller-owned push');
    assert.ok(!('previous_head' in pushes[0].payload.args), 'the first push of a new branch sends no previous_head');
    assert.ok(auditStore.rows().some((row) => row.tool === 'git.push' && row.status === 'succeeded'), 'git.push audited as succeeded');
    // The new remote branch exists at the pushed head, on top of the base.
    const pushed = remoteHead(bare, session.workBranch);
    assert.equal(pushed, session.state.git.pushedHead);
    assert.deepEqual(gitDir(bare, 'log', '--format=%P', '-1', pushed).split(/\s+/), [baseHead]);
    assert.equal(remoteHead(bare, 'main'), baseHead, 'the base branch was untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
