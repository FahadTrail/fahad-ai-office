// Phase N Office leg — one-shot runner regression suite.
//
// Proves the architecture that keeps the live drill self-contained:
//   1. the Office leg executes from the CURRENT checkout through the
//      one-shot runner — never through the deployed production worker;
//   2. the runner executes ONLY the exact native session this Phase N run
//      created and can never fall back to a queue claim;
//   3. it refuses on any session identity or lease mismatch;
//   4. no unrelated queued session can be claimed (exact-id claim vs the
//      queue-order claim that would take the decoy);
//   5. cleanup always happens — runner process proven dead and disposable
//      workspace root removed, PASS or FAIL.
// No network, no credentials: everything runs against the in-memory store
// and local child processes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { MemoryAgentSessionStore } from '../src/agent-state/session-store.js';
import {
  OneShotRefusal,
  claimOnCreate,
  removeRunnerWorkspace,
  runOneShotSession,
  startRunnerProcess,
  verifyCheckoutOrigin,
  verifyOfficeSessionIdentity,
} from '../src/coding-agent/one-shot-runner.js';
import { codeFingerprint } from '../src/build-info.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNNER_PATH = join(REPO_ROOT, 'src', 'coding-agent', 'one-shot-runner.js');
const DRILL_PATH = join(REPO_ROOT, 'tools', 'continuity-phase-n-live.mjs');
const BRANCH = 'continuity/phase-n-drill-test';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const REPOSITORY = 'FahadTrail/fahad-ai-office';
const WORKER = 'phase-n-office-runner:test-run:1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// decoy: an unrelated queued job (same workspace, continuity-tagged — the
// strongest decoy: only the exact session id can tell it apart).
// target: the session "this Phase N run created", already claimed by WORKER
// exactly as claimOnCreate does in the drill.
async function setup() {
  const store = new MemoryAgentSessionStore();
  const decoy = await store.createSession({
    workspaceId: WORKSPACE, title: 'production decoy', objective: 'unrelated production job',
    repository: REPOSITORY, baseBranch: 'main', config: { continuity: true },
  });
  store.data.sessions[decoy.id].work_branch = 'continuity/production-decoy';
  const target = await store.createSession({
    workspaceId: WORKSPACE, title: 'phase n office leg', objective: 'create the marker file',
    repository: REPOSITORY, baseBranch: BRANCH, config: { continuity: true },
  });
  store.data.sessions[target.id].work_branch = BRANCH;
  const claim = await store.claimById(target.id, { worker: WORKER });
  assert.equal(claim.ok, true, 'setup must lease the target to the runner worker');
  return { store, decoy, target };
}

const expectations = (sessionId) => ({
  sessionId, worker: WORKER, branch: BRANCH, repository: REPOSITORY, workspaceId: WORKSPACE,
});

// --------------------------------------------------------- checkout proof

test('the runner proves it executes from the checkout under test and refuses any other path', () => {
  const runnerPath = fileURLToPath(new URL('../src/coding-agent/one-shot-runner.js', import.meta.url));
  const origin = verifyCheckoutOrigin({ checkoutRoot: REPO_ROOT, runnerPath });
  assert.equal(origin.runnerPath, join(REPO_ROOT, 'src', 'coding-agent', 'one-shot-runner.js'));
  // A runner executed from a deployed image or another directory can never
  // pass: the path must be the checkout's own one-shot runner, exactly.
  assert.throws(
    () => verifyCheckoutOrigin({ checkoutRoot: REPO_ROOT, runnerPath: '/srv/deployed-office/src/coding-agent/one-shot-runner.js' }),
    (error) => error instanceof OneShotRefusal && error.code === 'RUNNER_OUTSIDE_CHECKOUT',
  );
  assert.throws(
    () => verifyCheckoutOrigin({ checkoutRoot: REPO_ROOT, runnerPath: join(REPO_ROOT, 'src', 'coding-worker.js') }),
    (error) => error instanceof OneShotRefusal && error.code === 'RUNNER_OUTSIDE_CHECKOUT',
  );
  assert.throws(
    () => verifyCheckoutOrigin({ checkoutRoot: null, runnerPath }),
    (error) => error instanceof OneShotRefusal && error.code === 'CHECKOUT_ROOT_REQUIRED',
  );
  // The CLI computes its fingerprint from its own module root; for a runner
  // inside the checkout that is the checkout — the value the drill compares
  // against PHASE_N_EXPECT_FINGERPRINT.
  assert.equal(codeFingerprint(), codeFingerprint(REPO_ROOT));
});

test('the spawned runner CLI refuses — fail closed — before any store is touched when identity or code proof is missing', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'phase-n-runner-cli-'));
  try {
    // Strip every credential from the child environment: these refusals must
    // happen without any database or provider access, and nothing may leak.
    const baseEnv = { ...process.env, PHASE_N_OFFICE_SESSION: '', PHASE_N_OFFICE_WORKER: '' };
    delete baseEnv.SUPABASE_URL;
    delete baseEnv.SUPABASE_SERVICE_ROLE_KEY;

    const run = (args, extraEnv, resultPath) => new Promise((resolve) => {
      execFile(process.execPath, [RUNNER_PATH, ...args],
        { cwd: REPO_ROOT, env: { ...baseEnv, ...extraEnv, PHASE_N_RUNNER_RESULT: resultPath } },
        (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
    });
    const readResult = async (path) => JSON.parse(await readFile(path, 'utf8'));

    // 1. No session identity at all → refused, no claim possible.
    const resultA = join(scratch, 'a.json');
    const outA = await run([], {}, resultA);
    assert.notEqual(outA.code, 0, 'the runner must exit non-zero on refusal');
    const a = await readResult(resultA);
    assert.equal(a.ok, false);
    assert.equal(a.refused, 'SESSION_ID_REQUIRED');

    // 2. Code that is not the checkout under test (fingerprint mismatch) →
    //    refused before any Supabase access.
    const resultB = join(scratch, 'b.json');
    const idB = randomUUID();
    const outB = await run([], {
      PHASE_N_OFFICE_SESSION: idB,
      PHASE_N_OFFICE_WORKER: WORKER,
      PHASE_N_CHECKOUT_ROOT: REPO_ROOT,
      PHASE_N_EXPECT_FINGERPRINT: '0000000000000000',
    }, resultB);
    assert.notEqual(outB.code, 0);
    const b = await readResult(resultB);
    assert.equal(b.ok, false);
    assert.equal(b.refused, 'CHECKOUT_FINGERPRINT_MISMATCH');
    assert.equal(b.sessionId, idB);

    // 3. The session id arrives twice (argv + env); disagreement → refused.
    const resultC = join(scratch, 'c.json');
    const idC = randomUUID();
    const outC = await run(['--session', randomUUID()], { PHASE_N_OFFICE_SESSION: idC }, resultC);
    assert.notEqual(outC.code, 0);
    const c = await readResult(resultC);
    assert.equal(c.ok, false);
    assert.equal(c.refused, 'SESSION_ARGUMENT_MISMATCH');
    assert.equal(c.sessionId, idC);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------- exactly one session

test('the one-shot runner executes only the exact session and can never use the queue claim', async () => {
  const { store, decoy, target } = await setup();
  // Any fallback to the generic queue claim must explode loudly.
  store.claim = async () => { throw new Error('QUEUE_CLAIM_MUST_NEVER_BE_USED'); };
  const ran = [];
  const controller = { run: async (session) => { ran.push(session.id); return { status: 'completed' }; } };

  const out = await runOneShotSession({
    store, sessionId: target.id, expect: expectations(target.id),
    buildController: async () => controller,
  });

  assert.deepEqual(ran, [target.id], 'exactly one session ran — the intended one');
  assert.equal(out.outcome.status, 'completed');
  const decoyAfter = await store.getSession(decoy.id);
  assert.equal(decoyAfter.status, 'queued', 'the unrelated queued session is untouched');
  assert.equal(decoyAfter.leaseOwner, null);
  const targetAfter = await store.getSession(target.id);
  assert.equal(targetAfter.leaseOwner, WORKER);
});

test('the runner refuses a missing session instead of claiming whatever the queue offers', async () => {
  const { store, decoy } = await setup();
  store.claim = async () => { throw new Error('QUEUE_CLAIM_MUST_NEVER_BE_USED'); };
  const controller = { run: async () => { throw new Error('controller must not run'); } };
  const missingId = randomUUID();

  await assert.rejects(
    runOneShotSession({ store, sessionId: missingId, expect: expectations(missingId), buildController: async () => controller }),
    (error) => error instanceof OneShotRefusal && error.code === 'SESSION_NOT_FOUND',
  );
  const decoyAfter = await store.getSession(decoy.id);
  assert.equal(decoyAfter.status, 'queued', 'the queued decoy was not claimed as a fallback');
  assert.equal(decoyAfter.leaseOwner, null);
});

// --------------------------------------------------- identity / lease gates

test('the runner refuses on every session identity or lease mismatch', async (t) => {
  const cases = [
    {
      name: 'expected session id differs from the loaded session',
      mutate: () => {},
      expect: (id) => ({ ...expectations(id), sessionId: randomUUID() }),
      code: 'SESSION_IDENTITY_MISMATCH',
    },
    {
      name: 'continuity branch mismatch',
      mutate: () => {},
      expect: (id) => ({ ...expectations(id), branch: 'continuity/some-other-branch' }),
      code: 'BRANCH_MISMATCH',
    },
    {
      name: 'repository mismatch',
      mutate: () => {},
      expect: (id) => ({ ...expectations(id), repository: 'FahadTrail/other-repo' }),
      code: 'REPOSITORY_MISMATCH',
    },
    {
      name: 'workspace mismatch',
      mutate: () => {},
      expect: (id) => ({ ...expectations(id), workspaceId: '33333333-3333-4333-8333-333333333333' }),
      code: 'WORKSPACE_MISMATCH',
    },
    {
      name: 'not a Continuity session',
      mutate: (store, id) => { store.data.sessions[id].config = {}; },
      expect: (id) => expectations(id),
      code: 'NOT_A_CONTINUITY_SESSION',
    },
    {
      name: 'still queued — never claim it from the queue',
      mutate: (store, id) => {
        Object.assign(store.data.sessions[id], { status: 'queued', lease_owner: null, lease_token: null });
      },
      expect: (id) => expectations(id),
      code: 'SESSION_NOT_CLAIMED',
    },
    {
      name: 'leased to another worker',
      mutate: (store, id) => { store.data.sessions[id].lease_owner = 'production-worker:7'; },
      expect: (id) => expectations(id),
      code: 'LEASE_OWNER_MISMATCH',
    },
    {
      name: 'fencing token missing',
      mutate: (store, id) => { store.data.sessions[id].lease_token = null; },
      expect: (id) => expectations(id),
      code: 'LEASE_TOKEN_MISSING',
    },
    {
      name: 'session already terminal',
      mutate: (store, id) => { Object.assign(store.data.sessions[id], { status: 'completed' }); },
      expect: (id) => expectations(id),
      code: 'SESSION_STATUS_MISMATCH',
    },
    {
      name: 'expected branch not configured (fail closed, not pass through)',
      mutate: () => {},
      expect: (id) => ({ ...expectations(id), branch: null }),
      code: 'BRANCH_EXPECTATION_REQUIRED',
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const { store, target } = await setup();
      testCase.mutate(store, target.id);
      let ran = false;
      const controller = { run: async () => { ran = true; return { status: 'completed' }; } };
      await assert.rejects(
        runOneShotSession({
          store, sessionId: target.id, expect: testCase.expect(target.id),
          buildController: async () => controller,
        }),
        (error) => error instanceof OneShotRefusal && error.code === testCase.code,
        testCase.code,
      );
      assert.equal(ran, false, 'a refused identity must never reach the controller');
    });
  }

  await t.test('missing session id expectation', async () => {
    const { store } = await setup();
    await assert.rejects(
      runOneShotSession({ store, sessionId: null, expect: {}, buildController: async () => null }),
      (error) => error instanceof OneShotRefusal && error.code === 'SESSION_ID_REQUIRED',
    );
  });

  await t.test('verifyOfficeSessionIdentity is the gate itself', () => {
    const session = {
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', workBranch: BRANCH, repository: REPOSITORY,
      workspaceId: WORKSPACE, config: { continuity: true }, status: 'running',
      leaseOwner: WORKER, leaseToken: 'token',
    };
    const ok = verifyOfficeSessionIdentity({ session, expect: expectations(session.id) });
    assert.equal(ok, session);
    assert.throws(
      () => verifyOfficeSessionIdentity({ session, expect: { ...expectations(session.id), sessionId: randomUUID() } }),
      (error) => error instanceof OneShotRefusal && error.code === 'SESSION_IDENTITY_MISMATCH',
    );
  });
});

// ------------------------------------------------- exact-id vs queue claim

test('claimById binds only the given id; the queue-order claim would have taken the decoy', async () => {
  const store = new MemoryAgentSessionStore();
  const decoy = await store.createSession({
    workspaceId: WORKSPACE, title: 'decoy', objective: 'unrelated', repository: REPOSITORY, config: { continuity: true },
  });
  store.data.sessions[decoy.id].work_branch = 'continuity/production-decoy';
  const target = await store.createSession({
    workspaceId: WORKSPACE, title: 'target', objective: 'phase n', repository: REPOSITORY, baseBranch: BRANCH, config: { continuity: true },
  });
  store.data.sessions[target.id].work_branch = BRANCH;

  // Exact-id claim: only the target moves; the OLDER queued decoy is safe.
  const claim = await store.claimById(target.id, { worker: WORKER });
  assert.equal(claim.ok, true);
  assert.equal(claim.session.id, target.id);
  const decoyAfter = await store.getSession(decoy.id);
  assert.equal(decoyAfter.status, 'queued');
  assert.equal(decoyAfter.leaseOwner, null);

  // Contrast — the hazard this replaces: the queue-order claim picks the
  // OLDEST queued session, which is the decoy, not the session you meant.
  const generic = await store.claim({ worker: 'another-worker:1' });
  assert.equal(generic.id, decoy.id, 'the queue claim takes the decoy — exactly what claimById must never do');

  // Refusals, all by exact id — never a different session.
  const taken = await store.claimById(decoy.id, { worker: WORKER });
  assert.equal(taken.ok, false);
  assert.equal(taken.reason, 'NOT_QUEUED');
  const unknown = await store.claimById(randomUUID(), { worker: WORKER });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'SESSION_NOT_FOUND');
  const cancelled = await store.createSession({
    workspaceId: WORKSPACE, title: 'cancelled', objective: 'x', repository: REPOSITORY, config: { continuity: true },
  });
  store.data.sessions[cancelled.id].cancel_requested = true;
  const cancelledClaim = await store.claimById(cancelled.id, { worker: WORKER });
  assert.equal(cancelledClaim.ok, false);
  assert.equal(cancelledClaim.reason, 'CANCEL_REQUESTED');
  await assert.rejects(store.claimById(target.id, { worker: WORKER, leaseSeconds: 5 }), /AGENT_LEASE_INVALID/);
  // Re-claim by the SAME owner is idempotent and never rotates the token.
  const again = await store.claimById(target.id, { worker: WORKER });
  assert.equal(again.ok, true);
  assert.equal(again.alreadyOwned, true);
  assert.equal(again.session.leaseToken, claim.session.leaseToken);
});

// ------------------------------------------------------- claim-on-create

test('claimOnCreate leases the exact session the instant it exists and fails closed on refusal', async () => {
  // Happy path: the decoy (queued, older) is created first through the raw
  // store; the wrapped createSession then binds ONLY its own new row.
  const store = new MemoryAgentSessionStore();
  const decoy = await store.createSession({
    workspaceId: WORKSPACE, title: 'decoy', objective: 'unrelated', repository: REPOSITORY, config: { continuity: true },
  });
  let attempt = null;
  const native = claimOnCreate(store, { worker: WORKER, onAttempt: (id) => { attempt = id; } });
  const session = await native.createSession({
    workspaceId: WORKSPACE, title: 'phase n', objective: 'marker', repository: REPOSITORY, baseBranch: BRANCH, config: { continuity: true },
  });
  assert.equal(attempt, session.id, 'the drill learns the exact native session id');
  assert.equal(session.status, 'running');
  assert.equal(session.leaseOwner, WORKER);
  const decoyAfter = await store.getSession(decoy.id);
  assert.equal(decoyAfter.status, 'queued', 'claimOnCreate never queue-claims another session');

  // Refusal path: the claim fails → creation fails with the exact id and
  // reason, and nothing is retried against a different session.
  const refused = new MemoryAgentSessionStore();
  let refusedId = null;
  const wrapped = claimOnCreate(refused, { worker: WORKER, onAttempt: (id) => { refusedId = id; } });
  wrapped.claimById = async (id) => ({ ok: false, reason: 'CLAIM_RACE_LOST', session: null });
  await assert.rejects(
    wrapped.createSession({
      workspaceId: WORKSPACE, title: 'phase n', objective: 'marker', repository: REPOSITORY, baseBranch: BRANCH, config: { continuity: true },
    }),
    (error) => /PHASE_N_OFFICE_CLAIM_REFUSED/.test(error.message)
      && error.code === 'PHASE_N_OFFICE_CLAIM_REFUSED'
      && error.sessionId === refusedId && Boolean(refusedId),
  );
});

test('claimOnCreate uses the atomic pre-leased path when the persistent store provides it', async () => {
  const expected = { id: '00000000-0000-4000-8000-000000000099', status: 'running', leaseOwner: WORKER };
  let received = null;
  let attempted = null;
  const store = {
    createSession: async () => { throw new Error('queued creation must not be used'); },
    claimById: async () => { throw new Error('post-insert claim must not be used'); },
    createClaimedSession: async (args, options) => {
      received = { args, options };
      return expected;
    },
  };
  const wrapped = claimOnCreate(store, { worker: WORKER, leaseSeconds: 900, onAttempt: (id) => { attempted = id; } });
  const session = await wrapped.createSession({ workspaceId: WORKSPACE, title: 'phase n', objective: 'marker', repository: REPOSITORY });
  assert.equal(session, expected);
  assert.equal(attempted, expected.id);
  assert.equal(received.options.worker, WORKER);
  assert.equal(received.options.leaseSeconds, 900);
});

// -------------------------------------------------- drill wiring (source)

test('the drill executes the Office leg from the current checkout, never the production worker', () => {
  const src = readFileSync(DRILL_PATH, 'utf8');
  // Wired through the in-checkout one-shot runner…
  assert.ok(src.includes("from '../src/coding-agent/one-shot-runner.js'"), 'the drill imports the checkout runner');
  assert.ok(src.includes("join(repoRoot, 'src', 'coding-agent', 'one-shot-runner.js')"), 'the runner script is resolved inside this checkout');
  assert.ok(src.includes('claimOnCreate(new SupabaseAgentSessionStore(db)'), 'the native session is pre-leased to the exact runner on creation');
  assert.ok(src.includes('pre-leased persistent insert'), 'the evidence identifies the queue-race-free persistent strategy');
  assert.ok(src.includes("args: ['--session', officeClaim.sessionId]"), 'the session id is passed on argv (cross-checked with env)');
  assert.ok(src.includes('PHASE_N_OFFICE_SESSION: officeClaim.sessionId'), 'the session id is also passed through env');
  assert.ok(src.includes('PHASE_N_OFFICE_WORKER: officeWorkerId'), 'the runner is bound to the exact worker id holding the lease');
  assert.ok(src.includes('PHASE_N_EXPECT_FINGERPRINT: fingerprint'), 'the runner must prove it is the code under test');
  assert.ok(src.includes('PHASE_N_CHECKOUT_ROOT: repoRoot'), 'the runner must prove it lives in this checkout');
  assert.ok(src.includes("CODING_AGENT_WORKSPACE_ROOT: officeSandboxRoot"), 'the sandbox root is the disposable drill workspace');
  assert.ok(src.includes("join(stateDir, 'office-sandbox')"), 'the disposable workspace root lives under the drill state dir');
  assert.ok(src.includes('PHASE_N_EXPECT_WORKSPACE: String(pre.workspaceId)'), 'the runner is bound to the validated workspace');
  // …and the claim is wired BEFORE the Office session is ever created.
  assert.ok(src.indexOf('claimOnCreate(') < src.indexOf('supervisorA.startTask'), 'the exact-id claim is wired before the Office leg starts');
  // Nothing anywhere points at the deployed production worker or its paths.
  for (const forbidden of ['fahad-office-coding-worker', 'CodingWorker', 'runOnce(', 'coding-worker', '/opt/']) {
    assert.ok(!src.includes(forbidden), `the drill must never reference ${forbidden}`);
  }
});

test('cleanup always happens: the runner and workspace are cleaned in finally, PASS or FAIL', () => {
  const src = readFileSync(DRILL_PATH, 'utf8');
  const finallyStart = src.lastIndexOf('} finally {');
  assert.ok(finallyStart > 0, 'the drill has a finally block');
  const createOfficeDb = src.indexOf('function createOfficeDb');
  const finallyText = src.slice(finallyStart, createOfficeDb > finallyStart ? createOfficeDb : undefined);

  assert.ok(finallyText.includes('runner.stop('), 'the runner is stopped in finally');
  assert.ok(finallyText.includes('removeRunnerWorkspace('), 'the workspace root is removed in finally');
  const passGuard = finallyText.indexOf("verdict === 'PASS'");
  const stopCall = finallyText.indexOf('runner.stop(');
  const removeCall = finallyText.indexOf('removeRunnerWorkspace(');
  assert.ok(stopCall > -1 && removeCall > -1);
  if (passGuard > -1) {
    assert.ok(stopCall < passGuard && removeCall < passGuard,
      'runner and workspace cleanup run unconditionally, before the PASS-only branch cleanup');
  }
  assert.ok(finallyText.includes('OFFICE_RUNNER_NOT_PROVEN_DEAD'), 'an unproven runner death flips the verdict to FAIL');
  assert.ok(finallyText.includes('OFFICE_WORKSPACE_CLEANUP_FAILED'), 'a failed workspace removal flips the verdict to FAIL');
  assert.ok(finallyText.includes('officeClaim.sessionId && verdict !=='), 'the drill closes its own native session on failure');
});

test('cleanup primitives: stop() proves the process dead and removeRunnerWorkspace() always clears the tree', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'phase-n-cleanup-'));
  try {
    // Workspace root: nested sandbox tree removed; missing path is already clean.
    const workspaceRoot = join(scratch, 'office-sandbox');
    await mkdir(join(workspaceRoot, 'sessions', 'abc', 'repo'), { recursive: true });
    await writeFile(join(workspaceRoot, 'sessions', 'abc', 'repo', 'file.txt'), 'x');
    assert.equal(existsSync(workspaceRoot), true);
    await removeRunnerWorkspace(workspaceRoot);
    assert.equal(existsSync(workspaceRoot), false, 'the disposable workspace root is gone');
    await removeRunnerWorkspace(workspaceRoot); // idempotent
    await assert.rejects(removeRunnerWorkspace(''), /requires a path/);

    // Runner process: spawned, then proven dead by stop() — ESRCH or a pid
    // provably reused by a different process, never an assumption.
    const hold = join(scratch, 'hold.js');
    await writeFile(hold, 'setInterval(() => {}, 1000);\n');
    const proc = startRunnerProcess({ script: hold, cwd: scratch, env: process.env });
    await sleep(250); // let node boot and hold the interval
    const proof = await proc.stop({ graceMs: 5_000 });
    assert.equal(proof.dead, true, `runner must be proven dead, got ${JSON.stringify(proof)}`);
    assert.ok(['ESRCH', 'PID_REUSED'].includes(proof.method), proof.method);
    const again = await proc.stop({ graceMs: 1_000 }); // idempotent
    assert.equal(again.dead, true);
    assert.equal(existsSync(hold), true, 'stop() only kills the process; workspace removal is its own guarantee');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
