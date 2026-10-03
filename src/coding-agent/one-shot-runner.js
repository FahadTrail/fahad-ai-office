// Isolated ONE-SHOT Office Coding Agent runner for the live Phase N drill.
//
// The deployed production coding worker keeps running untouched, but it must
// never be part of Phase N evidence: the drill has to exercise the code in
// THIS checkout, not the deployed image. This module is the replacement.
// The drill claims the exact native session it just created by id
// (claimOnCreate below), spawns this file from the checkout under test, and
// the runner executes that one session through the normal controller — same
// stores, sandbox, Tool Broker, routing, checkpointing and GitHub publish —
// then exits. Nothing loops, nothing else is claimable.
//
// Hard rules (proven by test/continuity-phase-n-office-runner.test.js):
//   * the runner NEVER calls the queue claim: it executes only the session
//     named by PHASE_N_OFFICE_SESSION and refuses on any identity or lease
//     mismatch, so no unrelated queued session can be claimed or run;
//   * it refuses to run code that is not the checkout under test (exact
//     path + code-fingerprint proof), so stale deployed code cannot
//     produce evidence;
//   * credentials come only from the inherited environment and are never
//     logged, printed or written anywhere;
//   * the drill stops this process and removes the disposable workspace
//     root on PASS and on FAIL.
//
// Run directly (the drill spawns it):
//   node src/coding-agent/one-shot-runner.js --session <native session uuid>

import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { SupabaseAgentSessionStore } from '../agent-state/session-store.js';
import { codeFingerprint } from '../build-info.js';
import { modelAttemptRow } from '../coding-worker.js';
import { createCodingRuntime } from './runtime.js';
import { SupabaseProviderStateStore } from '../model-gateway/agentic/provider-state.js';
import { SupabaseRoutingPolicyStore } from '../model-gateway/agentic/routing-policy.js';
import { QualificationStore } from '../model-gateway/agentic/qualification.js';
import { SupabaseWorkspacePolicyStore } from '../workspace-policy/supabase-store.js';
import { SupabaseToolBrokerStore } from '../tool-broker/supabase-store.js';
import { refreshProviderCatalogs } from '../model-gateway/agentic/provider-catalogs.js';
import { refreshOpenRouterCatalog } from '../model-gateway/agentic/openrouter-catalog.js';
import { rankFreeModels } from '../model-gateway/agentic/capabilities.js';

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

export class OneShotRefusal extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'OneShotRefusal';
    this.code = code;
    this.detail = detail;
  }
}

// ------------------------------------------------------------------ claims
// Wraps a session store's createSession so the caller owns the lease of the
// EXACT row it created, by id, in the instant it becomes visible — before a
// queue-order claim from any other worker can bind it. On refusal nothing is
// retried against a different session: the error carries the exact session id
// so the drill can clean up and fail closed.
export function claimOnCreate(store, { worker, leaseSeconds = 300, onAttempt = null } = {}) {
  if (!worker) throw new TypeError('claimOnCreate requires the exact worker id that will own the session');
  const createSession = store.createSession.bind(store);
  store.createSession = async (args) => {
    const session = await createSession(args);
    if (onAttempt) onAttempt(session.id);
    const claim = await store.claimById(session.id, { worker, leaseSeconds });
    if (!claim.ok) {
      const refusal = new Error(`PHASE_N_OFFICE_CLAIM_REFUSED (${claim.reason}): session ${session.id} is not claimable by ${worker}`);
      refusal.code = 'PHASE_N_OFFICE_CLAIM_REFUSED';
      refusal.sessionId = session.id;
      throw refusal;
    }
    return claim.session;
  };
  return store;
}

// ------------------------------------------------------ checkout identity
// Proves this runner IS the checkout under test: the executing module must
// sit at the exact expected path inside that checkout. A runner executed
// from a deployed image or another directory can never pass this.
export function verifyCheckoutOrigin({ checkoutRoot, runnerPath }) {
  if (!checkoutRoot) throw new OneShotRefusal('CHECKOUT_ROOT_REQUIRED', 'PHASE_N_CHECKOUT_ROOT is not set; cannot prove the runner is the checkout under test');
  const root = resolve(checkoutRoot);
  const runner = resolve(runnerPath);
  if (runner !== join(root, 'src', 'coding-agent', 'one-shot-runner.js')) {
    throw new OneShotRefusal('RUNNER_OUTSIDE_CHECKOUT', `runner ${runner} is not the one-shot runner of the checkout under test (${root})`);
  }
  return { checkoutRoot: root, runnerPath: runner };
}

// -------------------------------------------------- session identity gate
// Refuses unless the session is exactly the one this Phase N run created:
// same id, bound continuity branch, same workspace and repository, flagged
// as a Continuity session, already claimed and leased to THIS runner.
export function verifyOfficeSessionIdentity({ session, expect = {} }) {
  if (!session) throw new OneShotRefusal('SESSION_NOT_FOUND', 'the expected native Office session does not exist');
  const { sessionId, worker, branch, repository = null, workspaceId = null } = expect;
  if (!sessionId) throw new OneShotRefusal('SESSION_EXPECTATION_REQUIRED', 'the expected session id is not configured (PHASE_N_OFFICE_SESSION)');
  if (!worker) throw new OneShotRefusal('WORKER_EXPECTATION_REQUIRED', 'the expected worker id is not configured (PHASE_N_OFFICE_WORKER)');
  if (!branch) throw new OneShotRefusal('BRANCH_EXPECTATION_REQUIRED', 'the expected continuity branch is not configured (PHASE_N_EXPECT_BRANCH)');
  if (session.id !== sessionId) throw new OneShotRefusal('SESSION_IDENTITY_MISMATCH', `session ${session.id} is not the expected session ${sessionId}`);
  if (session.workBranch !== branch) throw new OneShotRefusal('BRANCH_MISMATCH', `session binds work branch ${session.workBranch}, expected ${branch}`);
  if (repository && session.repository !== repository) throw new OneShotRefusal('REPOSITORY_MISMATCH', `session repository ${session.repository}, expected ${repository}`);
  if (workspaceId && String(session.workspaceId) !== String(workspaceId)) throw new OneShotRefusal('WORKSPACE_MISMATCH', `session workspace ${session.workspaceId}, expected ${workspaceId}`);
  if (session.config?.continuity !== true) throw new OneShotRefusal('NOT_A_CONTINUITY_SESSION', 'session was not created by the Continuity Supervisor');
  if (session.status === 'queued') throw new OneShotRefusal('SESSION_NOT_CLAIMED', `session ${session.id} is still queued; the runner never claims from the queue`);
  if (session.status !== 'running') throw new OneShotRefusal('SESSION_STATUS_MISMATCH', `session status is ${session.status}, expected running`);
  if (session.leaseOwner !== worker) throw new OneShotRefusal('LEASE_OWNER_MISMATCH', `session is leased to ${session.leaseOwner || 'nobody'}, expected ${worker}`);
  if (!session.leaseToken) throw new OneShotRefusal('LEASE_TOKEN_MISSING', 'session has no fencing token; refusing to run unfenced');
  return session;
}

// ------------------------------------------------------------ one-shot run
// Loads, verifies and runs EXACTLY this one session — then returns. It never
// falls back to store.claim(), so an unrelated queued session can never be
// claimed or processed even if the expected session is missing or refused.
export async function runOneShotSession({ store, sessionId, expect = {}, buildController, log = () => {} }) {
  if (!sessionId) throw new OneShotRefusal('SESSION_ID_REQUIRED', 'PHASE_N_OFFICE_SESSION is not set; the runner only executes the exact session this Phase N run created');
  const session = await store.getSession(sessionId);
  if (!session) throw new OneShotRefusal('SESSION_NOT_FOUND', `native Office session ${sessionId} does not exist`);
  // A caller-supplied expectation is never silently replaced by the id we
  // looked up: if both exist and disagree, that disagreement is a refusal.
  verifyOfficeSessionIdentity({ session, expect: { ...expect, sessionId: expect.sessionId ?? sessionId } });
  log(`verified session ${sessionId} (lease owner ${session.leaseOwner}, branch ${session.workBranch})`);
  const controller = await buildController({ session });
  const outcome = await controller.run(session);
  log(`session ${sessionId} finished with status ${outcome.status}${outcome.blocker ? `: ${outcome.blocker}` : ''}`);
  return { sessionId, session, outcome };
}

// -------------------------------------------------- process lifecycle proof
// A pid is dead only when the OS says so (ESRCH), or the surviving pid is
// provably a different process (its cmdline no longer contains the exact
// runner path). Anything else is not dead.
export async function pidStatus(pid, binary) {
  if (!Number.isInteger(pid) || pid <= 0) return { dead: false, method: 'NO_PID' };
  try { process.kill(pid, 0); } catch (error) {
    if (error.code === 'ESRCH') return { dead: true, method: 'ESRCH' };
    return { dead: false, method: error.code || 'KILL_FAILED' };
  }
  try {
    const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.includes(binary) ? { dead: false, method: 'ALIVE' } : { dead: true, method: 'PID_REUSED' };
  } catch { return { dead: false, method: 'UNVERIFIABLE' }; }
}

// Spawns the runner (or, in tests, any script) as its own process with a
// captured output tail. stop() guarantees termination proof for cleanup:
// SIGTERM, then SIGKILL, then an OS-verified dead check against the exact
// script path — reported, never assumed.
export function startRunnerProcess({ script, args = [], cwd, env = process.env, log = () => {}, maxTailBytes = 8_000 } = {}) {
  if (!script) throw new TypeError('startRunnerProcess requires the script path');
  const child = spawn(process.execPath, [script, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let tailText = '';
  const capture = (chunk) => {
    const text = String(chunk);
    tailText = (tailText + text).slice(-maxTailBytes);
    for (const line of text.split('\n')) if (line.trim()) log(line);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  let exit = null;
  const exited = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => { exit = { code, signal }; resolveExit(exit); });
    child.once('error', (error) => { exit = { code: null, signal: null, error: error.message }; resolveExit(exit); });
  });
  const stop = async ({ graceMs = 10_000 } = {}) => {
    const pid = child.pid;
    if (!pid) return { pid: null, dead: true, method: 'NEVER_STARTED', exit };
    let status = await pidStatus(pid, script);
    if (!status.dead && !exit) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      const termDeadline = Date.now() + Math.min(graceMs, 5_000);
      while (!status.dead && Date.now() < termDeadline) { await sleep(200); status = await pidStatus(pid, script); }
      if (!status.dead) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        const killDeadline = Date.now() + Math.min(graceMs, 5_000);
        while (!status.dead && Date.now() < killDeadline) { await sleep(200); status = await pidStatus(pid, script); }
      }
    }
    if (status.dead && !exit) await Promise.race([exited, sleep(1_000)]);
    return { pid, dead: status.dead, method: status.method, exit: exit || null };
  };
  return { child, pid: child.pid, exited, tail: () => tailText.trim(), stop };
}

// Guaranteed workspace cleanup: the disposable sandbox root is removed on
// PASS and on FAIL; a missing directory is already clean.
export async function removeRunnerWorkspace(root) {
  if (!root) throw new TypeError('removeRunnerWorkspace requires a path');
  await rm(root, { recursive: true, force: true });
  return { removed: true, path: root };
}

// ------------------------------------------------------------------- CLI
function runnerLog(message) {
  console.log(`[phase-n-office] ${message}`);
}

async function writeRunnerResult(resultPath, result) {
  if (!resultPath) return false;
  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  return true;
}

// Builds the SAME runtime wiring as the production worker (stores, catalogs,
// Model Pool, Tool Broker, policy, routing, audit) from this checkout, with
// the sandbox root taken from the environment (the drill points it at a
// disposable directory). No health file, no queue loop — one session only.
async function buildController({ db, fingerprint, log }) {
  const auditStore = new SupabaseToolBrokerStore(db);
  const refreshCatalogs = () => Promise.all([
    refreshOpenRouterCatalog({ log, rank: (left, right) => rankFreeModels(left, right, process.env) }).catch(() => null),
    refreshProviderCatalogs({ log }).catch(() => null),
  ]);
  await refreshCatalogs();
  const runtime = createCodingRuntime({
    build: { codeFingerprint: fingerprint, startedAt: new Date().toISOString() },
    sessionStore: new SupabaseAgentSessionStore(db),
    providerStateStore: new SupabaseProviderStateStore(db),
    policyStore: new SupabaseWorkspacePolicyStore(db),
    routingStore: new SupabaseRoutingPolicyStore(db),
    qualificationStore: new QualificationStore(db),
    auditStore,
    modelAttemptSink: async (session, attempt) => {
      const { error } = await db.from('model_attempts').upsert(modelAttemptRow(session, attempt), { onConflict: 'id' });
      if (error) log(`WARN model attempt not recorded: ${error.message}`);
    },
    log: (...parts) => log(parts.map(String).join(' ')),
  });
  const routable = runtime.pool.filter((route) => !route.unavailableReasons.length).map((route) => route.id);
  log(`runtime ready; sandbox mode: ${runtime.mode}; routable models: ${routable.join(', ') || 'none'}`);
  return runtime.controller;
}

async function main() {
  const argv = process.argv.slice(2);
  const resultPath = process.env.PHASE_N_RUNNER_RESULT || null;
  const sessionId = process.env.PHASE_N_OFFICE_SESSION || null;
  const worker = process.env.PHASE_N_OFFICE_WORKER || null;
  // The session id is passed twice, through independent channels (argv and
  // env); both must agree before anything else happens.
  const flagIndex = argv.indexOf('--session');
  const argSession = flagIndex >= 0 ? argv[flagIndex + 1] || null : null;
  let result = null;
  try {
    if (!sessionId) throw new OneShotRefusal('SESSION_ID_REQUIRED', 'PHASE_N_OFFICE_SESSION is not set; the runner only executes the exact session this Phase N run created');
    if (argSession && argSession !== sessionId) throw new OneShotRefusal('SESSION_ARGUMENT_MISMATCH', `argv session ${argSession} does not match PHASE_N_OFFICE_SESSION`);
    if (!worker) throw new OneShotRefusal('WORKER_ID_REQUIRED', 'PHASE_N_OFFICE_WORKER is not set');
    const checkoutRoot = process.env.PHASE_N_CHECKOUT_ROOT || null;
    const runnerPath = verifyCheckoutOrigin({ checkoutRoot, runnerPath: fileURLToPath(import.meta.url) }).runnerPath;
    const fingerprint = codeFingerprint();
    const expectedFingerprint = process.env.PHASE_N_EXPECT_FINGERPRINT || null;
    if (expectedFingerprint && expectedFingerprint !== fingerprint) {
      throw new OneShotRefusal('CHECKOUT_FINGERPRINT_MISMATCH', `runner code ${fingerprint} is not the checkout under test (${expectedFingerprint})`);
    }
    runnerLog(`checkout runner: ${runnerPath} (code ${fingerprint}); session ${sessionId}`);
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new OneShotRefusal('OFFICE_DB_NOT_CONFIGURED', 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not exported in this shell');
    }
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const outcome = await runOneShotSession({
      store: new SupabaseAgentSessionStore(db),
      sessionId,
      expect: {
        sessionId,
        worker,
        branch: process.env.PHASE_N_EXPECT_BRANCH || null,
        repository: process.env.PHASE_N_EXPECT_REPOSITORY || null,
        workspaceId: process.env.PHASE_N_EXPECT_WORKSPACE || null,
      },
      log: runnerLog,
      buildController: async () => buildController({ db, fingerprint, log: runnerLog }),
    });
    result = {
      ok: true, sessionId, worker, runnerPath, codeFingerprint: fingerprint,
      outcome: outcome.outcome, finishedAt: new Date().toISOString(),
    };
  } catch (error) {
    const code = error instanceof OneShotRefusal ? error.code : (error?.code || 'RUNNER_ERROR');
    result = { ok: false, refused: code, detail: String(error?.message || error).slice(0, 500), sessionId, finishedAt: new Date().toISOString() };
    runnerLog(`REFUSED: ${code} — ${result.detail}`);
  }
  if (resultPath) {
    try { await writeRunnerResult(resultPath, result); } catch (error) { runnerLog(`WARN runner result not written: ${error.message}`); }
  }
  return result.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((error) => {
    runnerLog(`FATAL: ${error?.message || error}`);
    process.exit(1);
  });
}
