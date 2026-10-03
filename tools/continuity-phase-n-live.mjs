#!/usr/bin/env node
// Live Phase N drill: FAHAD OFFICE -> OPENCODE -> GEMINI CLI on real workers.
// Run on the VPS after ops/setup-continuity-workers.sh --install and the
// docs/CONTINUITY-VPS-WORKERS.md authentication steps. Full runbook and
// evidence list: docs/CONTINUITY-VPS-WORKERS.md.
//
//   node tools/continuity-phase-n-live.mjs --check      # verify-only preflight (no writes)
//   node tools/continuity-phase-n-live.mjs --run        # the real drill
//   node tools/continuity-phase-n-live.mjs --selftest   # drill plumbing only (no workers)
//
// Guarantees:
//   * Nothing is mocked as evidence: all three workers are the real CLIs /
//     the real Office Coding Agent; every lease, session, checkpoint and
//     commit in the report comes from the real Supervisor run.
//   * Isolated state: a disposable branch, disposable worktrees and a
//     file-persisted Continuity store under .continuity/phase-n-drill/.
//     Production Supabase continuity tables do not exist (migration
//     unapplied) and are never touched beyond the Office worker's own
//     documented agent_sessions usage.
//   * Fail closed: any unproven worker death, dirty worktree, head mismatch
//     or missing evidence ends the drill with an exact blocker, never a pass.
//   * No credentials are ever printed; only environment variable NAMES.
//   * Production flags are never modified; the owner exports the drill flags
//     in the drill shell only.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile as nodeExecFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ContinuitySupervisor } from '../src/continuity/supervisor.js';
import { ContinuityCheckpointer } from '../src/continuity/checkpointer.js';
import { WorktreeManager } from '../src/continuity/worktree.js';
import { OfficeContinuityAdapter } from '../src/continuity/adapters/office.js';
import { externalAdaptersFromEnv } from '../src/continuity/runtime.js';
import { resolvePhaseNWorkspace } from '../src/continuity/phase-n-workspace.js';
import { createClient } from '@supabase/supabase-js';
import { MemoryContinuityStore, validCheckpoint } from '../testing/fixtures/continuity-harness.js';

const execFile = promisify(nodeExecFile);
const REPOSITORY = 'FahadTrail/fahad-ai-office';
const MARKERS = { office: 'phase-n/office.md', opencode: 'phase-n/opencode.md', 'gemini-cli': 'phase-n/gemini.md' };
const WORKERS = [
  { key: 'office', display_name: 'Fahad Office Coding Agent', kind: 'native', quota_source: 'office-pools', enabled: true },
  { key: 'opencode', display_name: 'OpenCode', kind: 'cli', quota_source: 'opencode', enabled: true },
  { key: 'gemini-cli', display_name: 'Gemini CLI', kind: 'cli', quota_source: 'gemini-cli', enabled: true },
  { key: 'claude-code', display_name: 'Claude Code', kind: 'cli', quota_source: 'anthropic-claude-subscription', enabled: false },
  { key: 'codex', display_name: 'OpenAI Codex', kind: 'cli', quota_source: 'openai-chatgpt', enabled: false },
  { key: 'antigravity', display_name: 'Google Antigravity', kind: 'cli', quota_source: 'google-ai-pro', enabled: false },
  { key: 'kilo', display_name: 'Kilo Code', kind: 'cli', quota_source: 'kilo-auto-free', enabled: false },
  { key: 'freebuff', display_name: 'Freebuff', kind: 'manual', quota_source: 'freebuff', enabled: false },
];

// ---------------------------------------------------------------- utilities
async function git(cwd, ...args) {
  const { stdout } = await execFile('git', ['-C', cwd, ...args], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return String(stdout || '').trim();
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function envSet(name) { return Boolean(process.env[name]); }
function envOn(name) { return /^(1|true|yes)$/i.test(String(process.env[name] || '')); }

class DrillAbort extends Error { constructor(blocker, detail = null) { super(blocker); this.blocker = blocker; this.detail = detail; } }
function must(condition, blocker, detail = null) { if (!condition) throw new DrillAbort(blocker, detail); }

// Termination proof: a pid is dead only when the OS says so (ESRCH), or the
// surviving pid is provably a different process (cmdline no longer the binary).
// Anything else is UNVERIFIABLE -> not dead -> recovery must refuse.
async function pidStatus(pid, binary) {
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

// ------------------------------------------------- isolated persisted store
// The Continuity store for the drill. Same enforcement code the tests use
// (one-writer lease, checkpoint guards, handoff state machine), persisted to
// disk so a Supervisor restart must reload real state instead of trusting
// memory. Production Supabase continuity tables are not applied, so the drill
// keeps its state isolated; the SQL twins of these guards are proven by
// `npm run db:replay` scenarios.
class PersistentStore extends MemoryContinuityStore {
  constructor({ workers, statePath }) { super({ workers }); this.statePath = statePath; }

  static async load({ workers, statePath }) {
    const store = new PersistentStore({ workers, statePath });
    try {
      const raw = JSON.parse(await readFile(statePath, 'utf8'));
      const hydrate = (rows) => new Map(rows.map((row) => [row.id, row]));
      store.sessions = hydrate(raw.sessions);
      store.leases = hydrate(raw.leases);
      store.checkpoints = hydrate(raw.checkpoints);
      store.handoffs = hydrate(raw.handoffs);
      store.usage = raw.usage || [];
      store.events = raw.events || [];
      store.sequence = raw.sequence || store.sequence;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error; // a corrupt state file must never be silently replaced
    }
    return store;
  }

  async persist() {
    const payload = {
      schema: 'continuity.phase-n-drill.v1',
      savedAt: new Date().toISOString(),
      sessions: [...this.sessions.values()],
      leases: [...this.leases.values()],
      checkpoints: [...this.checkpoints.values()],
      handoffs: [...this.handoffs.values()],
      usage: this.usage,
      events: this.events,
      sequence: this.sequence,
    };
    const tmp = `${this.statePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`);
    await rename(tmp, this.statePath);
  }
}

// ---------------------------------------------------------------- preflight
async function preflight({ checkOnly }) {
  const findings = [];
  let workspaceId = null;
  const ok = (msg) => findings.push({ level: 'PASS', msg });
  const warn = (msg) => findings.push({ level: 'WARN', msg });
  const bad = (msg) => findings.push({ level: 'FAIL', msg });

  const repoRoot = String((await git(process.cwd(), 'rev-parse', '--show-toplevel')) || '');
  ok(`repository checkout: ${repoRoot}`);
  const origin = await git(repoRoot, 'remote', 'get-url', 'origin').catch(() => '');
  origin.toLowerCase().includes(REPOSITORY.toLowerCase())
    ? ok('origin matches the repository')
    : bad(`origin does not look like ${REPOSITORY}`);

  // Environment variable NAMES only — never a value.
  for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
    envSet(name) ? ok(`${name}: set (value not shown)`) : bad(`${name} missing — the Office leg needs it (Settings → Environment on the VPS .env)`);
  }
  // Provider-neutral OpenCode gates: free source, auto-reload off, access
  // and privacy are required for every provider; the Zen promotion is
  // required only when the declared model provider is Zen. Legacy ZEN_*
  // flag names are still accepted (wired the same way in runtime.js).
  const modelProvider = String(process.env.CONTINUITY_OPENCODE_MODEL_PROVIDER || 'zen').trim().toLowerCase() || 'zen';
  const onEither = (...names) => names.some((name) => envOn(name));
  const opencodeFlags = ['CONTINUITY_OPENCODE_ENABLED', 'CONTINUITY_OPENCODE_AUTO_RELOAD_OFF',
    'CONTINUITY_OPENCODE_ACCESS_VERIFIED', 'CONTINUITY_OPENCODE_PRIVACY_VERIFIED'];
  for (const name of opencodeFlags) {
    envOn(name) ? ok(`${name}: on`) : bad(`${name} not set — OpenCode stays fail-closed until the owner asserts it`);
  }
  onEither('CONTINUITY_OPENCODE_FREE_VERIFIED', 'CONTINUITY_OPENCODE_ZEN_FREE_VERIFIED')
    ? ok('free model source verified (owner assertion)')
    : bad('free model source not verified — set CONTINUITY_OPENCODE_FREE_VERIFIED');
  if (modelProvider === 'zen') {
    onEither('CONTINUITY_OPENCODE_PROMOTION_ACTIVE', 'CONTINUITY_OPENCODE_ZEN_PROMOTION_ACTIVE')
      ? ok('Zen promotion active (owner assertion; provider=zen)')
      : bad('Zen promotion not asserted — required only for CONTINUITY_OPENCODE_MODEL_PROVIDER=zen');
  } else {
    ok(`OpenCode model provider "${modelProvider}" is not zen: no Zen promotion required`);
  }
  envOn('CONTINUITY_GEMINI_CLI_ENABLED') ? ok('CONTINUITY_GEMINI_CLI_ENABLED: on') : bad('CONTINUITY_GEMINI_CLI_ENABLED not set');
  if (envOn('CONTINUITY_SUPERVISOR')) warn('CONTINUITY_SUPERVISOR is on in this shell: the drill never touches the production runtime; unset it for a clean shell');

  // Real capability probes through the real adapters (runs the CLIs).
  const { opencode, gemini } = externalAdaptersFromEnv({ env: process.env });
  for (const [label, adapter] of [['OpenCode', opencode], ['Gemini CLI', gemini]]) {
    try {
      const probe = await adapter.available();
      probe.ok ? ok(`${label} probe: ${probe.authState || 'ready'}`)
        : bad(`${label} probe: ${probe.authState || ''} ${probe.reason || ''}`.trim());
    } catch (error) { bad(`${label} probe threw: ${error.message}`); }
  }
  if (envSet('SUPABASE_URL') && envSet('SUPABASE_SERVICE_ROLE_KEY')) {
    try {
      const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
      const { error } = await db.from('agent_sessions').select('id').limit(1);
      error ? bad(`Office database reachable but agent_sessions rejected the query: ${error.message}`)
        : ok('Office agent_sessions reachable (read-only probe)');
      // Office leg workspace: explicit PHASE_N_WORKSPACE_ID preferred and
      // validated (project exists, enabled, Coding-Agent-intended); without
      // one, only the single enabled Coding Agent workspace is auto-resolved.
      // A disabled or ambiguous workspace fails HERE, before any branch,
      // supervisor or worker is ever created.
      try {
        const workspace = await resolvePhaseNWorkspace({ db, requestedId: process.env.PHASE_N_WORKSPACE_ID || null });
        workspaceId = workspace.workspaceId;
        ok(`workspace ${workspace.workspaceId} (${workspace.projectName}) is enabled for Coding Agent runs [${workspace.source}]`);
      } catch (error) { bad(`Phase N workspace: ${error.message}`); }
    } catch (error) { bad(`Office database probe failed: ${error.message}`); }
  } else {
    bad('Phase N workspace not validated — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are missing');
  }

  const failed = findings.filter((entry) => entry.level === 'FAIL');
  for (const entry of findings) console.log(`  [${entry.level}] ${entry.msg}`);
  if (checkOnly) {
    console.log(failed.length ? `\nCHECK FAILED: ${failed.length} blocker(s). Nothing was written.` : '\nCHECK PASSED: environment ready for --run.');
  }
  return { ok: failed.length === 0, repoRoot, workspaceId, findings };
}

// ---------------------------------------------------------------- evidence
function makeEvidence(stateDir) {
  const entries = [];
  return {
    entries,
    add(phase, data) {
      const entry = { at: new Date().toISOString(), phase, ...data };
      entries.push(entry);
      console.log(`[evidence] ${phase} ${JSON.stringify(data)}`);
      return entry;
    },
    async write(report) {
      const payload = { ...report, evidence: entries };
      await writeFile(join(stateDir, 'report.json'), `${JSON.stringify(payload, null, 2)}\n`);
      return payload;
    },
  };
}

// ---------------------------------------------------------------- the drill
async function runDrill({ keep }) {
  const pre = await preflight({ checkOnly: false });
  must(pre.ok, 'PREFLIGHT_FAILED', pre.findings.filter((entry) => entry.level === 'FAIL').map((entry) => entry.msg));
  must(pre.workspaceId, 'PHASE_N_WORKSPACE_UNRESOLVED', 'preflight did not resolve an enabled workspace for the Office leg');
  const repoRoot = pre.repoRoot;
  const stateDir = join(repoRoot, '.continuity', 'phase-n-drill');
  const worktreesRoot = join(stateDir, 'worktrees');
  const statePath = join(stateDir, 'state.json');
  const ledgerPath = join(stateDir, 'termination.json');
  const startedAt = new Date().toISOString();
  // A previous attempt's isolated state must never leak into this run: stale
  // ACTIVE leases would trip the single-writer evidence and skew the recovery
  // attempt counts. Rotate it aside (report and state preserved) and start
  // from a clean slate.
  try { await rename(stateDir, join(repoRoot, '.continuity', `phase-n-drill-prev-${startedAt.replace(/[-:TZ.]/g, '').slice(0, 14)}`)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Keep the checkout's worktree registrations in sync with the moved tree.
  await git(repoRoot, 'worktree', 'prune').catch(() => {});
  await mkdir(worktreesRoot, { recursive: true });
  const evidence = makeEvidence(stateDir);
  const branch = `continuity/phase-n-drill-${startedAt.replace(/[-:TZ.]/g, '').slice(0, 14)}`;
  const worktrees = new WorktreeManager({ repositoryRoot: repoRoot, worktreesRoot });
  const supervisors = [];
  let phaseAdapters = null;
  let verdict = 'FAIL';
  let blocker = null;

  const drillGates = async ({ worktree }) => {
    const checks = [];
    const status = await worktrees.status(worktree);
    checks.push({ kind: 'branch', name: 'worktree clean before completion', ok: status.clean, detail: status.detail });
    const merges = await git(worktree, 'rev-list', '--merges', '--count').catch(() => '0');
    checks.push({ kind: 'history', name: 'no merge commits on the drill branch', ok: Number(merges) === 0, detail: `merges=${merges}` });
    for (const [worker, marker] of Object.entries(MARKERS)) {
      let present = false;
      try { present = (await git(worktree, 'cat-file', '-e', `HEAD:${marker}`)) === ''; } catch { present = false; }
      checks.push({ kind: 'artifact', name: `${worker} marker committed (${marker})`, ok: present });
    }
    const failed = checks.filter((entry) => !entry.ok);
    return { ok: failed.length === 0, checks, failed, nextExactAction: failed.length ? `Complete: ${failed.map((entry) => entry.name).join('; ')}` : null };
  };

  const buildSupervisor = ({ store, confirmStopped }) => {
    // The production runtime wires an inspectCheckpoint into the external
    // adapters; without it every OpenCode/Gemini launch fails
    // CHECKPOINT_FAILED before its first turn.
    const inspectCheckpoint = async ({ session, context }) => {
      const lastCommit = await worktrees.head(session.worktree);
      const files = await worktrees.changedSince(session.worktree, context?.checkpoint?.base_commit);
      return {
        ...context.checkpoint,
        timestamp: new Date().toISOString(),
        last_commit: lastCommit,
        files_changed: files,
        diff_summary: files.length ? `${files.length} file(s) differ from the checkpoint base.` : 'No file differences from the checkpoint base.',
      };
    };
    const { opencode, gemini } = externalAdaptersFromEnv({ env: process.env, inspectCheckpoint });
    const db = createOfficeDb();
    const office = new OfficeContinuityAdapter({ db });
    const adapters = [office, opencode, gemini];
    const supervisor = new ContinuitySupervisor({
      store,
      adapters,
      checkpointerFactory: (options) => new ContinuityCheckpointer({ ...options, env: process.env, clock: { now: () => Date.now() } }),
      gates: drillGates,
      verifyBranch: (lease, checkpoint) => worktrees.verifyAgainstCheckpoint({ worktree: lease.worktree, checkpoint }),
      confirmStopped,
      prepareWorktree: ({ session, task }) => worktrees.create({ path: join(worktreesRoot, session.id), branch: task.branch, repository: task.repository, refresh: true }),
      prepareTransfer: async ({ runtime, checkpoint }) => {
        // Mirrors the production runtime exactly: only supervisor-managed
        // worktrees are published and retired by the Supervisor.
        if (runtime.adapter.capabilities().worktreeManagement !== 'supervisor') return;
        const verification = await worktrees.verifyAgainstCheckpoint({ worktree: runtime.task.worktree, checkpoint });
        if (!verification.ok || verification.head !== checkpoint.last_commit) throw new Error('CONTINUITY_HANDOFF_WORKTREE_UNSAFE');
        await worktrees.publish(runtime.task.worktree, checkpoint.branch);
        await worktrees.remove(runtime.task.worktree);
      },
      releaseWorktree: (path) => worktrees.remove(path),
      mirrorPath: join(stateDir, 'checkpoint.json'),
      mirrorPathForSession: (lease) => join(stateDir, 'sessions', `${lease.session_id}.json`),
      doNotTouch: ['src/model-gateway/', 'src/hub-capacity.js', 'src/office/finance.js', 'V4/V5 UI', 'Dockerfile', 'docker-compose.yml', 'ops/deploy.sh', 'systems outside this repository'],
      statusIntervalMs: 10 * 60_000,
      usageIntervalMs: 60 * 60_000,
    });
    supervisors.push(supervisor);
    return { supervisor, adapters: { office, opencode, gemini } };
  };

  const activeLeases = async (store) => (await store.listLeases({ statuses: ['ACTIVE'] })).length;
  const assertSingleWriter = async (store, phase) => {
    const count = await activeLeases(store);
    evidence.add(phase, { activeLeases: count });
    must(count <= 1, 'SINGLE_WRITER_VIOLATED', `${count} active leases at ${phase}`);
    return count;
  };

  try {
    // ---------------------------------------------------------- setup
    const base = await git(repoRoot, 'rev-parse', 'HEAD');
    await git(repoRoot, 'branch', branch);
    await git(repoRoot, 'push', '--porcelain', 'origin', `refs/heads/${branch}:refs/heads/${branch}`);
    evidence.add('setup', { branch, baseCommit: base, stateDir });

    const store = await PersistentStore.load({ workers: WORKERS, statePath });
    const proveTermination = async ({ session }) => {
      // Fail-closed by default: recovery refuses unless the persisted ledger
      // proves THIS session's writer is dead, re-verified right now.
      try {
        const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
        const entry = ledger[session.id];
        if (!entry) return false;
        const status = await pidStatus(entry.pid, entry.binary);
        return Boolean(status.dead);
      } catch { return false; }
    };
    const supervisorABuilt = buildSupervisor({ store, confirmStopped: proveTermination });
    const supervisorA = supervisorABuilt.supervisor;
    phaseAdapters = supervisorABuilt.adapters;
    await store.persist();

    // ------------------------------------------------- phase 1: Office leg
    const checkpoint0 = validCheckpoint({ branch, base_commit: base, last_commit: base, agent_id: 'office', agent_type: 'native', status: 'ACTIVE', next_exact_action: `Create only ${MARKERS.office} with one short line, then commit and push this branch. Do not touch any other file.` });
    const task = {
      projectId: pre.workspaceId, title: 'Continuity Phase N live drill (Office leg)',
      repository: REPOSITORY, branch, worktree: null,
      objective: `Harmless Phase N drill: create only ${MARKERS.office} with one short line, commit and push to this branch. Touch no other file.`,
      dataClass: 'PUBLIC', size: 'medium', capability: 'coding',
      excludeWorkers: ['opencode', 'gemini-cli'],
      config: { publish: 'branch' },
    };
    const started = await supervisorA.startTask({ task, checkpoint: checkpoint0 });
    must(started.started && started.worker === 'office', 'OFFICE_START_FAILED', started.blocker || 'office was not selected');
    const officeSessionId = started.session.id;
    evidence.add('office.started', { sessionId: officeSessionId, leaseId: started.lease.id, nativeSessionId: started.session.native_session_id || null, worker: started.worker });
    await assertSingleWriter(store, 'office.leased');

    const deadline = Date.now() + 20 * 60_000;
    let officePush = base;
    while (Date.now() < deadline) {
      const remote = String((await git(repoRoot, 'ls-remote', 'origin', `refs/heads/${branch}`).catch(() => '')) || '').split(/\s/)[0];
      if (remote && remote !== base) { officePush = remote; break; }
      await sleep(5_000);
    }
    must(officePush !== base, 'OFFICE_NEVER_PUSHED', 'the Office worker did not push its commit within 20 minutes (check the coding worker and publish config)');
    evidence.add('office.pushed', { commit: officePush });

    // ---------------------------------------- phase 2: office -> opencode
    const handoff1 = await supervisorA.handoff(officeSessionId, {
      reason: 'Phase N drill: office -> opencode',
      preferredWorker: 'opencode',
      checkpoint: validCheckpoint({ branch, base_commit: base, last_commit: officePush, agent_id: 'office', agent_type: 'native', status: 'HANDOFF_READY', next_exact_action: `Create only ${MARKERS.opencode} with one short line, then commit. Do not touch any other file.` }),
    });
    must(handoff1.handedOff && handoff1.to === 'opencode', 'OFFICE_TO_OPENCODE_FAILED', handoff1.blocker || 'handoff refused');
    const opencodeSessionId = handoff1.session.id;
    await store.persist();
    evidence.add('handoff.office_opencode', { handoffId: handoff1.handoff.id, checkpointId: handoff1.checkpoint.id, fromSession: officeSessionId, toSession: opencodeSessionId, to: handoff1.to });
    await assertSingleWriter(store, 'opencode.leased');
    // Source stopped before transfer: the Supervisor only proposes a handoff
    // after adapter.stop() confirmed; verify the recorded event order too.
    const stopIdx = store.events.findIndex((event) => event.event === 'WORKER_STOPPED' && event.payload?.sessionId === officeSessionId);
    const proposeIdx = store.events.findIndex((event) => event.event === 'HANDOFF_PROPOSED');
    must(stopIdx >= 0 && proposeIdx > stopIdx, 'STOP_NOT_CONFIRMED_BEFORE_TRANSFER', `WORKER_STOPPED@${stopIdx} HANDOFF_PROPOSED@${proposeIdx}`);
    evidence.add('source_stopped_before_transfer', { stoppedEventIndex: stopIdx, proposedEventIndex: proposeIdx });

    const runtimeO = supervisorA.running.get(opencodeSessionId);
    must(runtimeO, 'OPENCODE_RUNTIME_MISSING');
    const opencodeHeadAtStart = await worktrees.head(runtimeO.task.worktree);
    must(opencodeHeadAtStart === officePush, 'DESTINATION_START_MISMATCH', `${opencodeHeadAtStart} != ${officePush}`);
    evidence.add('opencode.started', { sessionId: opencodeSessionId, leaseId: runtimeO.lease.id, cliSessionId: runtimeO.adapterSession.id, worktreeHead: opencodeHeadAtStart });

    // ------------------------------------------------ phase 3: OpenCode turn
    const stateO = phaseAdapters.opencode.sessions.get(runtimeO.adapterSession.id);
    must(stateO, 'OPENCODE_SESSION_STATE_MISSING');
    await Promise.race([stateO.done, sleep(30 * 60_000).then(() => { throw new DrillAbort('OPENCODE_TURN_TIMEOUT'); })]);
    must(!stateO.errorCode && stateO.exitCode === 0, 'OPENCODE_TURN_FAILED', `${stateO.errorCode || ''} exit=${stateO.exitCode} stderr=${String(stateO.stderr || '').slice(-400)}`);
    const opencodeHead = await worktrees.head(runtimeO.task.worktree);
    must(opencodeHead !== officePush, 'OPENCODE_MADE_NO_COMMIT');
    const opencodeStatus = await worktrees.status(runtimeO.task.worktree);
    must(opencodeStatus.clean, 'OPENCODE_WORKTREE_DIRTY', opencodeStatus.detail);
    const savedO = await supervisorA.saveCheckpoint(opencodeSessionId, validCheckpoint({ branch, base_commit: officePush, last_commit: opencodeHead, agent_id: 'opencode', agent_type: 'cli', status: 'ACTIVE', next_exact_action: `Create only ${MARKERS['gemini-cli']} with one short line, then commit. Do not touch any other file.` }), { event: 'manual' });
    const opencodeCheckpoint = await store.latestCheckpoint(opencodeSessionId);
    must(opencodeCheckpoint?.payload?.last_commit === opencodeHead, 'OPENCODE_CHECKPOINT_NOT_PERSISTED', savedO?.reason || '');
    await store.persist();
    evidence.add('opencode.checkpoint', { checkpointId: opencodeCheckpoint.id, commit: opencodeHead, turnExit: stateO.exitCode });

    // --------------------------------- phase 4: real death, fail-closed, restart
    const victimPid = stateO.child.pid;
    const aliveBefore = await pidStatus(victimPid, 'opencode');
    must(!aliveBefore.dead, 'OPENCODE_ALREADY_DEAD', aliveBefore.method);
    evidence.add('termination.pre_kill', { pid: victimPid, status: aliveBefore.method });
    stateO.child.kill('SIGKILL');
    await Promise.race([stateO.done, sleep(15_000)]);
    must(stateO.finished, 'OPENCODE_DEATH_NOT_OBSERVED');
    const afterKill = await pidStatus(victimPid, 'opencode');
    must(afterKill.dead, 'OPENCODE_PID_NOT_PROVEN_DEAD', afterKill.method);
    evidence.add('termination.killed', { pid: victimPid, observedSignal: stateO.signal, observedExit: stateO.exitCode, proof: afterKill.method });
    // Simulated Supervisor crash: heartbeats stop, the lease goes stale, and
    // everything the restart needs is already on disk. No termination proof
    // is sealed yet — the ledger does not exist.
    for (const lease of store.leases.values()) if (lease.status === 'ACTIVE') lease.stale = true;
    await store.persist();
    supervisorA.stop();
    evidence.add('supervisor_a_crashed', { persistedState: statePath, proofSealed: false });

    const storeB = await PersistentStore.load({ workers: WORKERS, statePath });
    // The crash left exactly one ACTIVE lease, flagged stale; it must reload
    // exactly like that or the recovery below has nothing to reclaim.
    const reloadedActive = await storeB.listLeases({ statuses: ['ACTIVE'] });
    must(reloadedActive.length === 1 && reloadedActive.every((entry) => entry.stale === true), 'STALE_STATE_NOT_RELOADED', JSON.stringify(reloadedActive.map((entry) => ({ id: entry.id, stale: entry.stale }))));
    const supervisorBBuilt = buildSupervisor({ store: storeB, confirmStopped: proveTermination });
    const supervisorB = supervisorBBuilt.supervisor;
    phaseAdapters = supervisorBBuilt.adapters;
    evidence.add('supervisor_b_started', { reloadedSessions: (await storeB.listSessions({})).length, reloadedCheckpoints: (await storeB.listCheckpoints()).length });

    const firstAttempt = await supervisorB.recoverStale();
    must(firstAttempt.length === 1 && firstAttempt[0].recovered === false && firstAttempt[0].blocker === 'WORKER_STOP_UNCONFIRMED',
      'FAIL_CLOSED_RECOVERY_NOT_ENFORCED', JSON.stringify(firstAttempt.map((entry) => entry.blocker)));
    evidence.add('recovery.refused_without_proof', { leaseId: firstAttempt[0].lease.id, blocker: firstAttempt[0].blocker });

    // Seal the termination proof only now, after the refusal was observed.
    await mkdir(dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, `${JSON.stringify({ [opencodeSessionId]: { pid: victimPid, binary: 'opencode', observedSignal: stateO.signal || 'SIGKILL', verifiedAt: new Date().toISOString(), verifiedBy: afterKill.method } }, null, 2)}\n`);
    const secondAttempt = await supervisorB.recoverStale();
    must(secondAttempt.length === 1 && secondAttempt[0].recovered === true, 'RECOVERY_FAILED', JSON.stringify(secondAttempt.map((entry) => entry.blocker)));
    must(secondAttempt[0].worker === 'gemini-cli', 'RECOVERY_WRONG_WORKER', secondAttempt[0].worker);
    const recoveryHead = secondAttempt[0].verification.head;
    must(recoveryHead === opencodeHead, 'RECOVERY_NOT_FROM_EXACT_COMMIT', `${recoveryHead} != ${opencodeHead}`);
    await storeB.persist();
    evidence.add('recovery.reclaimed', { leaseId: secondAttempt[0].lease.id, sessionId: secondAttempt[0].session.id, worker: secondAttempt[0].worker, fromCommit: recoveryHead, proof: afterKill.method });
    await assertSingleWriter(storeB, 'after_recovery');

    // --------------------------------------- phase 5: Gemini CLI turn + finish
    const geminiSessionId = secondAttempt[0].session.id;
    const runtimeG = supervisorB.running.get(geminiSessionId);
    must(runtimeG, 'GEMINI_RUNTIME_MISSING');
    const geminiHeadAtStart = await worktrees.head(runtimeG.task.worktree);
    must(geminiHeadAtStart === opencodeHead, 'GEMINI_START_MISMATCH', `${geminiHeadAtStart} != ${opencodeHead}`);
    const stateG = phaseAdapters.gemini.sessions.get(runtimeG.adapterSession.id);
    must(stateG, 'GEMINI_SESSION_STATE_MISSING');
    evidence.add('gemini.started', { sessionId: geminiSessionId, leaseId: runtimeG.lease.id, cliSessionId: runtimeG.adapterSession.id, worktreeHead: geminiHeadAtStart });
    await Promise.race([stateG.done, sleep(30 * 60_000).then(() => { throw new DrillAbort('GEMINI_TURN_TIMEOUT'); })]);
    must(!stateG.errorCode && stateG.exitCode === 0, 'GEMINI_TURN_FAILED', `${stateG.errorCode || ''} exit=${stateG.exitCode} stderr=${String(stateG.stderr || '').slice(-400)}`);
    const geminiHead = await worktrees.head(runtimeG.task.worktree);
    must(geminiHead !== opencodeHead, 'GEMINI_MADE_NO_COMMIT');
    const finished = await supervisorB.finish(geminiSessionId, {
      checkpoint: validCheckpoint({ branch, base_commit: opencodeHead, last_commit: geminiHead, agent_id: 'gemini-cli', agent_type: 'cli', status: 'COMPLETED', next_exact_action: 'Drill complete.' }),
    });
    must(finished.completed, 'COMPLETION_GATES_FAILED', JSON.stringify(finished.gates?.failed || null));
    await storeB.persist();
    evidence.add('gemini.finished', { sessionId: geminiSessionId, checkpointId: finished.checkpoint.id, commit: geminiHead, completed: finished.completed });

    // ------------------------------------------------------ final evidence
    must((await activeLeases(storeB)) === 0, 'LEASES_NOT_RELEASED');
    const history = (await git(repoRoot, 'log', '--format=%H %s', `${base}..${geminiHead}`)).split(/\r?\n/).filter(Boolean);
    const subjects = history.map((line) => line.slice(41));
    must(new Set(history.map((line) => line.slice(0, 40))).size === history.length, 'DUPLICATE_COMMITS');
    must(new Set(subjects).size === subjects.length, 'DUPLICATE_EDIT_SUBJECTS', subjects.join(' | '));
    must((await git(repoRoot, 'rev-list', '--merges', '--count', `${base}..${geminiHead}`)) === '0', 'NON_LINEAR_HISTORY');
    // One active writer at every observed point, replayed from the event log.
    let concurrent = 0; let maxConcurrent = 0;
    for (const event of storeB.events) {
      if (event.event === 'LEASE_ACQUIRED') { concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent); }
      if (event.event === 'LEASE_RELEASED') concurrent = Math.max(0, concurrent - 1);
    }
    must(maxConcurrent <= 1, 'CONCURRENT_WRITERS_OBSERVED', String(maxConcurrent));
    const finalSession = await storeB.getSession(geminiSessionId);
    must(finalSession?.status === 'COMPLETED', 'SESSION_NOT_COMPLETED', finalSession?.status);
    verdict = 'PASS';
    evidence.add('final', { baseCommit: base, finalCommit: geminiHead, history, maxConcurrentWriters: maxConcurrent, finalStatus: finalSession.status });
  } catch (error) {
    blocker = error.blocker || error.message;
    evidence.add('aborted', { blocker, detail: error.detail || null });
  } finally {
    for (const supervisor of supervisors) {
      try { await supervisor.drainForShutdown(); } catch { /* best-effort: never leave a live worker behind */ }
      supervisor.stop();
    }
    const report = { tool: 'continuity-phase-n-live', repository: REPOSITORY, branch, verdict, blocker, startedAt, finishedAt: new Date().toISOString(), keep };
    const payload = await evidence.write(report);
    console.log(`\nVERDICT: ${verdict}${blocker ? ` — ${blocker}` : ''}`);
    console.log(`Report: ${join(stateDir, 'report.json')}`);
    if (verdict === 'PASS' && !keep) {
      try {
        await rm(worktreesRoot, { recursive: true, force: true });
        await git(repoRoot, 'worktree', 'prune');
        await git(repoRoot, 'branch', '-D', branch);
        await git(repoRoot, 'push', '--delete', 'origin', branch).catch(() => {});
        console.log(`Cleanup: disposable branch ${branch} removed (local and origin); report kept.`);
      } catch (error) { console.log(`Cleanup incomplete: ${error.message} — remove the disposable branch ${branch} manually.`); }
    } else if (!keep) {
      console.log(`Cleanup skipped so evidence is preserved; rerun with the branch removed: git branch -D ${branch} && git push --delete origin ${branch}`);
    }
    return payload.verdict === 'PASS' ? 0 : 1;
  }
}

function createOfficeDb() {
  if (!envSet('SUPABASE_URL') || !envSet('SUPABASE_SERVICE_ROLE_KEY')) throw new DrillAbort('OFFICE_DB_NOT_CONFIGURED');
  // Values come from the environment and are never printed or persisted.
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

// ------------------------------------------------------------- self test
async function selftest() {
  // Verifies the drill's own plumbing (persisted store + termination proof
  // gate) without any worker. Explicitly NOT worker evidence.
  const stateDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', '.continuity', 'phase-n-selftest');
  await mkdir(stateDir, { recursive: true });
  const statePath = join(stateDir, 'state.json');
  const ledgerPath = join(stateDir, 'termination.json');
  await rm(statePath, { force: true }); await rm(ledgerPath, { force: true });
  const store = await PersistentStore.load({ workers: WORKERS, statePath });
  const session = await store.createSession({ workerKey: 'opencode', repository: REPOSITORY, branch: 'continuity/phase-n-selftest', objective: 'plumbing only' });
  const lease = await store.acquireLease(session.id);
  await store.persist();
  const reloaded = await PersistentStore.load({ workers: WORKERS, statePath });
  must((await reloaded.listLeases({ statuses: ['ACTIVE'] })).length === 1, 'SELFTEST_PERSISTENCE_FAILED');
  const confirm = async ({ session: entry }) => {
    try {
      const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
      const entry2 = ledger[entry.id];
      if (!entry2) return false;
      return (await pidStatus(entry2.pid, entry2.binary)).dead;
    } catch { return false; }
  };
  must((await confirm({ session })) === false, 'SELFTEST_FAIL_CLOSED_FAILED');
  const pid = process.pid; // provably alive -> still not dead
  await writeFile(ledgerPath, JSON.stringify({ [session.id]: { pid, binary: 'node' } }));
  must((await confirm({ session })) === false, 'SELFTEST_LIVE_PID_MUST_REFUSE');
  await writeFile(ledgerPath, JSON.stringify({ [session.id]: { pid: 99_999_999, binary: 'node' } }));
  must((await confirm({ session })) === true, 'SELFTEST_DEAD_PID_MUST_PASS');
  await rm(stateDir, { recursive: true, force: true });
  console.log('SELFTEST PASSED: persisted store round-trip and termination-proof gate behave fail-closed.');
  return 0;
}

// ------------------------------------------------------------------- main
const args = new Set(process.argv.slice(2));
let code = 2;
try {
  if (args.has('--selftest')) code = await selftest();
  else if (args.has('--check')) code = (await preflight({ checkOnly: true })).ok ? 0 : 1;
  else if (args.has('--run')) code = await runDrill({ keep: args.has('--keep') });
  else {
    console.log('Usage: node tools/continuity-phase-n-live.mjs --check | --run [--keep] | --selftest');
  }
} catch (error) {
  console.error(`Drill aborted: ${error.blocker || error.message}`);
  if (error.detail) console.error(String(error.detail));
  code = 1;
}
process.exit(code);
