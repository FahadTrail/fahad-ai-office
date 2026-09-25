import test from 'node:test';
import { withIsolatedSandboxLock } from '../testing/fixtures/uid-lock.js';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodingWorker } from '../src/coding-agent/runtime.js';
import { MemoryAgentSessionStore } from '../src/agent-state/session-store.js';
import {
  REPOSITORY, SESSION_CONFIG, WORKSPACE_ID, createFixtureRepo, fakeApis, localRuntime, scriptedPool,
} from '../testing/fixtures/coding-agent-harness.js';

const branchFile = (bare, branch, path) => execFileSync('git', ['--git-dir', bare, 'show', `refs/heads/${branch}:${path}`]).toString();

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0 && process.platform === 'linux';

for (const sandboxMode of ['unisolated', 'isolated']) {
test(`coding agent completes the lifecycle with a real handoff, CI repair, approval, merge and verification (${sandboxMode} sandbox)`, {
  timeout: 180_000, skip: sandboxMode === 'isolated' && !isRoot && 'isolated mode requires container root',
}, () => (sandboxMode === 'isolated' ? withIsolatedSandboxLock : (fn) => fn())(async () => {
  const root = mkdtempSync(join(tmpdir(), 'fahad-coding-e2e-'));
  if (sandboxMode === 'isolated') chmodSync(root, 0o755);
  try {
    const { bare } = createFixtureRepo(root);
    const apis = fakeApis({ bare });
    const log = [];
    const { runtime, sessionStore, auditStore, providerStateStore, attempts } = localRuntime({
      root, storePath: join(root, 'state.json'), pool: scriptedPool({ log }), fetchFn: apis.fetchFn, sandboxMode,
    });
    const created = await sessionStore.createSession({
      workspaceId: WORKSPACE_ID, title: 'Fix add() bug', repository: REPOSITORY,
      objective: 'The add() function returns wrong results. Fix it, keep tests green, deploy and verify production.',
      config: { ...SESSION_CONFIG, fetchUrl: bare, pushUrl: bare },
    });
    const worker = new CodingWorker({ runtime, sessionStore });

    const first = await worker.runOnce();
    assert.equal(first.status, 'awaiting_approval', first.blocker);
    let session = await sessionStore.getSession(created.id);
    assert.equal(session.status, 'awaiting_approval');

    // Provider continuity: the primary hit a 429, a checkpoint was saved, and the
    // backup continued the same task from the durable continuation.
    assert.equal(session.providerSwitches, 1);
    assert.equal(session.previousRoute, 'anthropic:claude-opus-5');
    assert.equal(session.currentRoute, 'deepseek:deepseek-flash');
    assert.ok(log.some((entry) => entry.provider === 'backup' && entry.continuation));
    assert.ok(attempts.some((attempt) => attempt.route === 'anthropic:claude-opus-5' && attempt.error === 'PROVIDER_RATE_LIMIT'));
    const primaryState = (await providerStateStore.snapshot()).get('anthropic:claude-opus-5');
    assert.equal(primaryState.health, 'rate_limited');
    const events = await sessionStore.listEvents(created.id);
    assert.ok(events.some((event) => event.type === 'provider_switch'));
    assert.ok(events.some((event) => event.type === 'tool_result' && event.message === 'list_files ok'), 'listing the repository root works');
    assert.ok(!events.some((event) => event.type === 'tool_result' && /→ [A-Z_]+/.test(event.message)), 'no scripted tool call failed');
    const switchCheckpoint = sessionStore.data.checkpoints[created.id].find((checkpoint) => checkpoint.reason === 'provider_switch');
    assert.ok(switchCheckpoint, 'a checkpoint precedes the provider switch');
    assert.ok(switchCheckpoint.state.filesChanged.includes('src/math.js'), 'checkpoint carries the in-progress change');

    // Real repository work: the bug fix and the CI-required doc were pushed.
    assert.match(branchFile(bare, session.workBranch, 'src/math.js'), /return a \+ b;/);
    assert.match(branchFile(bare, session.workBranch, 'docs/math.md'), /returns the sum/);
    assert.equal(apis.state.pulls.length, 1);
    assert.equal(apis.state.ciSeen.length, 2, 'CI failed once, was repaired and re-run');
    assert.ok(events.some((event) => event.type === 'ci' && /CI failed/.test(event.message)));
    assert.ok(events.some((event) => event.type === 'test' && /exit 1/.test(event.message)), 'the controlled test failure was observed');
    assert.match(apis.state.supabaseQuery, /select 1 as ok/);

    // Merge is APPROVAL by policy: recorded, not executed.
    const mergeRows = auditStore.rows().filter((row) => row.tool === 'github.pr_merge');
    assert.deepEqual(mergeRows.map((row) => row.status), ['approval_required']);
    const approval = Object.values(sessionStore.data.approvals).find((row) => row.tool === 'github.pr_merge');
    assert.equal(approval.status, 'pending');
    assert.equal(apis.state.merged, null);

    await sessionStore.decideApproval(approval.id, 'approved');
    const second = await worker.runOnce();
    assert.equal(second.status, 'completed', second.blocker);
    session = await sessionStore.getSession(created.id);
    assert.equal(session.status, 'completed');
    assert.equal(apis.state.merged.number, 1);
    assert.deepEqual(auditStore.rows().filter((row) => row.tool === 'github.pr_merge').map((row) => [row.decision, row.status]),
      [['approval', 'approval_required'], ['auto', 'succeeded']]);
    assert.equal(Object.values(sessionStore.data.approvals).find((row) => row.id === approval.id).status, 'consumed');
    assert.equal(session.result.verify.ok, true);
    assert.match(session.result.report, /Model switches:\*\* 1/);
    assert.match(session.result.report, /#1/);
    // Every real action went through the broker audit.
    for (const tool of ['repo.list', 'repo.read', 'repo.edit', 'shell.run', 'git.commit', 'git.push', 'github.pr_create', 'github.ci_status', 'github.ci_logs', 'deploy.status', 'verify.http', 'supabase.query_read']) {
      assert.ok(auditStore.rows().some((row) => row.tool === tool && row.status === 'succeeded'), `${tool} audited`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}));
}

function runChild(args) {
  const child = spawn(process.execPath, ['testing/fixtures/coding-worker-child.js', ...args], {
    cwd: new URL('../', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, done };
}

test('a killed worker process loses nothing: a new process resumes the same session from its checkpoint', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'fahad-coding-restart-'));
  try {
    const { bare } = createFixtureRepo(root);
    const storePath = join(root, 'state.json');
    const pauseFile = join(root, 'pause');
    const store = new MemoryAgentSessionStore({ persistPath: storePath });
    const created = await store.createSession({
      workspaceId: WORKSPACE_ID, title: 'Fix add() bug', repository: REPOSITORY,
      objective: 'The add() function returns wrong results. Fix it and keep the tests green.',
      config: { ...SESSION_CONFIG, deploy: { mode: 'none' }, verify: {}, fetchUrl: bare, pushUrl: bare },
    });
    writeFileSync(pauseFile, 'pause');
    const firstRun = runChild([root, storePath, bare, pauseFile]);
    // Wait until the first process has durably checkpointed its plan, then kill it hard.
    const deadline = Date.now() + 60_000;
    for (;;) {
      const state = existsSync(storePath) ? JSON.parse(readFileSync(storePath, 'utf8')) : null;
      if (state?.sessions[created.id]?.iteration >= 3) break;
      if (Date.now() > deadline) throw new Error('first worker made no progress');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    firstRun.child.kill('SIGKILL');
    const killed = await firstRun.done;
    assert.equal(killed.signal, 'SIGKILL');
    store.reload();
    const interrupted = await store.getSession(created.id);
    assert.equal(interrupted.status, 'running', 'the killed worker still holds the lease');
    const iterationAtKill = interrupted.iteration;

    // The lease expires (as it would after 5 minutes) and a new process takes over.
    store.expireLease(created.id);
    rmSync(pauseFile);
    const secondRun = runChild([root, storePath, bare, '']);
    const result = await secondRun.done;
    assert.equal(result.code, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);
    assert.equal(outcome.status, 'completed', outcome.blocker);

    store.reload();
    const finished = await store.getSession(created.id);
    assert.equal(finished.status, 'completed');
    assert.ok(finished.iteration > iterationAtKill);
    const events = await store.listEvents(created.id);
    assert.ok(events.some((event) => /Resumed from checkpoint/.test(event.message)), 'second process resumed from a checkpoint');
    assert.equal(events.filter((event) => event.type === 'tool_call' && event.message === 'repo.list').length, 1, 'completed work was not redone');
    assert.ok(events.some((event) => event.type === 'provider_switch'));
    assert.match(branchFile(bare, finished.workBranch, 'src/math.js'), /return a \+ b;/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
