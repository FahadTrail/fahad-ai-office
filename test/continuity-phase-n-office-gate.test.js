// Phase N Office leg — focused finish-gate suite.
//
// The disposable Office marker task (phase-n/office.md) proves Continuity
// handoff/recovery mechanics, not a full-repository re-certification inside
// the Office worker, so the drill's Office task supplies THIS suite as its
// explicit `testCommand`. This file is both:
//   1. the focused gate itself — it must prove the checkout/task is sane and
//      exit non-zero on any real failure (it is exactly what the live drill
//      executes at the Office finish gate), and
//   2. the regression coverage for that configuration:
//        (a) Phase N supplies the explicit focused test command,
//        (b) normal Coding Agent tasks still auto-detect and run their normal
//            test suite when no testCommand is configured,
//        (c) the Phase N one-shot worker cannot bypass the finish gate — the
//            configured gate command always executes, a non-zero exit blocks
//            the session and publication never happens.
// Full-repository tests stay enforced by PR #106 CI (`node --test`).
// No network, no credentials: harness sessions run against in-process fake
// APIs and local fixture repositories.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodingWorker } from '../src/coding-agent/runtime.js';
import { normalizeConfig } from '../src/coding-agent/controller.js';
import {
  REPOSITORY, SESSION_CONFIG, WORKSPACE_ID, createFixtureRepo, fakeApis, localRuntime,
} from '../testing/fixtures/coding-agent-harness.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const GATE_FILE = basename(fileURLToPath(import.meta.url));
const GATE_COMMAND = `node --test test/${GATE_FILE}`;
const DRILL_PATH = join(REPO_ROOT, 'tools', 'continuity-phase-n-live.mjs');
const CONTROLLER_PATH = join(REPO_ROOT, 'src', 'coding-agent', 'controller.js');
const RUNNER_PATH = join(REPO_ROOT, 'src', 'coding-agent', 'one-shot-runner.js');
// A deterministic gate command that fails exactly like a broken checkout
// would: `node --test` exits non-zero when the file it must run is missing.
const FAILING_COMMAND = 'node --test test/phase-n-gate-canary-missing.test.js';

// --------------------------------------------------- checkout / task sanity

test('the focused gate proves the checkout and the Office marker task are sane', () => {
  // The checkout under test can run its own suite at all.
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test), 'the repository still declares its normal test suite');
  const required = [
    'src/coding-agent/controller.js',
    'src/coding-agent/one-shot-runner.js',
    'tools/continuity-phase-n-live.mjs',
    join('test', GATE_FILE),
  ];
  for (const rel of required) assert.ok(existsSync(join(REPO_ROOT, rel)), `${rel} is missing from the checkout`);
  // Every file the Office leg depends on must parse; node --check exits
  // non-zero on a syntax error, which fails this gate.
  for (const rel of required.slice(0, 3)) {
    execFileSync(process.execPath, ['--check', join(REPO_ROOT, rel)], { stdio: 'pipe' });
  }
  // The task's marker, once the Office leg has produced it: present, real
  // content, and the only file the leg touched inside phase-n/.
  const markerDir = join(REPO_ROOT, 'phase-n');
  const marker = join(markerDir, 'office.md');
  if (existsSync(marker)) {
    const lines = readFileSync(marker, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    assert.ok(lines.length >= 1 && lines.length <= 10, `the Office marker must hold one short line, got ${lines.length} non-empty lines`);
    assert.deepEqual(readdirSync(markerDir).sort(), ['office.md'], 'the Office leg touched only its own marker inside phase-n/');
  }
});

// ------------------------------------------------- (a) explicit test command

test('Phase N supplies the explicit focused test command to the Office task — and nothing that weakens the gate', () => {
  const src = readFileSync(DRILL_PATH, 'utf8');
  const declared = src.match(/const OFFICE_TEST_COMMAND = '([^']+)'/);
  assert.ok(declared, 'the drill declares one explicit Office test command');
  assert.equal(declared[1], GATE_COMMAND, 'the focused gate command runs exactly this suite');
  assert.ok(src.includes('testCommand: OFFICE_TEST_COMMAND'), 'the Office marker task config supplies it explicitly');
  assert.ok(!/testCommand:\s*(null|undefined|false|''|"")/.test(src), 'the drill never disables a test command');
  assert.ok(!src.includes('allowProtectedPaths'), 'the drill never grants itself a protected-path bypass');
});

// ------------------------------------------------------- (b) normal task path

test('a normal Coding Agent task without a configured testCommand auto-detects and runs its normal suite at the gate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phase-n-gate-normal-'));
  try {
    const { bare } = createFixtureRepo(root);
    let step = 0;
    const behavior = async () => {
      step += 1;
      if (step === 1) return reply([scriptedCall('read_file', { path: 'src/math.js' })]);
      if (step === 2) return reply([scriptedCall('edit_file', { path: 'src/math.js', old_text: 'return a - b;', new_text: 'return a + b;' })]);
      return reply([scriptedCall('finish', { summary: 'Fixed add() to sum its arguments; tests pass.', tests_run: 'npm test' })]);
    };
    const { runtime, sessionStore } = localRuntime({
      root, storePath: join(root, 'state.json'), pool: gatePool(behavior), fetchFn: fakeApis({ bare }).fetchFn,
    });
    // A NORMAL task: no testCommand anywhere in its config — the shape that
    // must keep auto-detecting the repository's own suite.
    const { testCommand: _noExplicitCommand, ...normalConfig } = SESSION_CONFIG;
    const created = await sessionStore.createSession({
      workspaceId: WORKSPACE_ID, title: 'Fix add() bug', repository: REPOSITORY,
      objective: 'The add() function returns wrong results. Fix it and keep the tests green.',
      config: { ...normalConfig, publish: 'branch', fetchUrl: bare, pushUrl: bare },
    });
    assert.equal((await sessionStore.getSession(created.id)).config.testCommand, undefined, 'this normal task configured no test command');

    const outcome = await new CodingWorker({ runtime, sessionStore }).runOnce();
    assert.equal(outcome.status, 'completed', outcome.blocker);
    assert.equal((await sessionStore.getSession(created.id)).status, 'completed');
    const events = await sessionStore.listEvents(created.id);
    const ready = events.find((event) => event.type === 'session' && /Sandbox ready/.test(event.message));
    assert.equal(ready?.payload?.testCommand, 'npm test', 'the repository suite was auto-detected for the normal task');
    assert.ok(events.some((event) => event.type === 'test' && event.message === 'Gate: npm test → exit 0'),
      'the auto-detected normal suite ran at the finish gate');
    const passed = events.find((event) => event.message === 'Finish gate passed.');
    assert.equal(passed?.payload?.gate?.tested, true);
    assert.equal(passed?.payload?.gate?.testCommand, 'npm test');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the controller keeps auto-detection as the fallback — an explicit testCommand only ever overrides, never disables', () => {
  const src = readFileSync(CONTROLLER_PATH, 'utf8');
  assert.ok(src.includes('this.testCommand = this.config.testCommand ?? await detectTestCommand(this.sandbox);'),
    'prepareSandbox still auto-detects when the task config carries no testCommand');
  // Normalization never invents a command for a task that has none, and null
  // falls through the ?? straight back into auto-detection.
  assert.equal(normalizeConfig({}).testCommand, undefined);
  assert.equal(normalizeConfig({ testCommand: 'npm test' }).testCommand, 'npm test');
  assert.equal(normalizeConfig({ testCommand: null }).testCommand, null);
});

// ------------------------------------------------- (c) the gate cannot be bypassed

test('the Phase N Office config cannot bypass the finish gate: a failing gate command blocks the session before publish', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phase-n-gate-blocked-'));
  try {
    const { bare } = createFixtureRepo(root);
    let step = 0;
    const behavior = async () => {
      step += 1;
      if (step === 1) return reply([scriptedCall('write_file', { path: 'notes.md', content: 'drill scratch\n' })]);
      // Every retry varies its summary, so the gate itself — never the
      // no-progress guard — is what must stop this session.
      return reply([scriptedCall('finish', { summary: `marker attempt ${step}` })]);
    };
    const { runtime, sessionStore } = localRuntime({
      root, storePath: join(root, 'state.json'), pool: gatePool(behavior), fetchFn: fakeApis({ bare }).fetchFn,
    });
    // The Phase N Office session shape: explicit focused command + branch
    // publication. The repository has its own suite (npm test), yet the gate
    // must execute ONLY the configured command — and honor its failure.
    const { testCommand: _omit, ...normalConfig } = SESSION_CONFIG;
    const created = await sessionStore.createSession({
      workspaceId: WORKSPACE_ID, title: 'Continuity Phase N office leg', repository: REPOSITORY,
      objective: 'Harmless Phase N drill: create only phase-n/office.md with one short line. Touch no other file.',
      config: { ...normalConfig, publish: 'branch', testCommand: FAILING_COMMAND, fetchUrl: bare, pushUrl: bare },
    });

    const outcome = await new CodingWorker({ runtime, sessionStore }).runOnce();
    assert.equal(outcome.status, 'blocked', outcome.blocker);
    const session = await sessionStore.getSession(created.id);
    assert.equal(session.status, 'blocked');
    assert.match(session.blocker, /finish gate failed 6 times/);
    assert.equal(session.errorCode, 'GATE_LIMIT');
    const events = await sessionStore.listEvents(created.id);
    const gateRuns = events.filter((event) => event.message === `Gate: ${FAILING_COMMAND} → exit 1`);
    assert.equal(gateRuns.length, 6, 'every finish attempt executed the configured gate command to a non-zero exit');
    // Publication is impossible behind a failed gate: the work branch never
    // reached the remote.
    let pushed = true;
    try {
      execFileSync('git', ['--git-dir', bare, 'rev-parse', '--verify', `refs/heads/${session.workBranch}`], { stdio: 'pipe' });
    } catch { pushed = false; }
    assert.equal(pushed, false, 'the session published behind a failed gate');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the Phase N one-shot runner executes the standard controller and can never reconfigure or skip the gate', () => {
  const src = readFileSync(RUNNER_PATH, 'utf8');
  assert.ok(src.includes('createCodingRuntime'), 'the runner builds the full production runtime');
  assert.ok(src.includes('return runtime.controller;'), 'the session runs on the standard controller — finish gate included');
  for (const forbidden of ['testCommand', 'allowProtectedPaths', 'finishGate', 'noChanges']) {
    assert.ok(!src.includes(forbidden), `the runner must never reference or override ${forbidden}`);
  }
  // The drill reaches the gate only through the session config, which the
  // controller reads; the gate itself stays controller-owned.
  const drill = readFileSync(DRILL_PATH, 'utf8');
  assert.ok(drill.includes('testCommand: OFFICE_TEST_COMMAND'), 'the focused command reaches the session config, where the controller reads it');
});

// ------------------------------------------------------------------ helpers

function gatePool(behavior) {
  const common = {
    toolCalling: true, contextWindow: 200_000, privacyApproved: true, unavailableReasons: [],
    pricing: { inputPerMillion: 1, outputPerMillion: 1 }, billingClass: 'paid', qualityTier: 5, costTier: 1,
  };
  return [{
    ...common, id: 'anthropic:claude-opus-5', provider: 'anthropic', model: 'claude-opus-5',
    secretRef: 'env://ANTHROPIC_API_KEY', protocolClient: { turn: behavior },
  }];
}

const reply = (blocks) => ({
  message: { role: 'assistant', content: blocks },
  stopReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.01 }, durationMs: 1,
});
let scriptedCallSeq = 0;
const scriptedCall = (name, args) => ({ type: 'tool_call', id: `gate${scriptedCallSeq++}`, name, arguments: args });
