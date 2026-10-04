import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { assertAdapterContract } from '../src/continuity/adapter-contract.js';
import { CodexContinuityAdapter } from '../src/continuity/adapters/codex.js';
import { ClaudeCodeContinuityAdapter, claudeCodeAdapter } from '../src/continuity/adapters/claude-code.js';
import { ExternalWorkerDriver, externalFailureEvidence } from '../src/continuity/external-driver.js';
import { antigravityAdapter } from '../src/continuity/adapters/antigravity.js';
import { createOpenCodeAdapter } from '../src/continuity/adapters/opencode.js';
import { GeminiCliContinuityAdapter, createGeminiCliAdapter, geminiCliAdapter } from '../src/continuity/adapters/gemini-cli.js';
import { createKiloAdapter } from '../src/continuity/adapters/kilo.js';
import { createFreebuffAdapter } from '../src/continuity/adapters/freebuff.js';

function readyDriver() {
  const calls = [];
  return {
    calls,
    async inspect(_binary, args) {
      if (args[0] === '--version') return { ok: true, stdout: 'codex-cli 0.158.0-alpha.2.1' };
      if (args[0] === 'login') return { ok: true, stdout: '' };
      return { ok: true, stdout: args[1] === 'resume' ? '--json --config' : '--json --sandbox --cd --config' };
    },
    launch(options) {
      calls.push(options);
      const state = { child: { args: options.args, prompt: options.prompt }, id: null, usage: null, finished: false };
      queueMicrotask(() => {
        options.onEvent({ type: 'thread.started', thread_id: 'thread-1' }, state);
        options.onEvent({ type: 'turn.completed', usage: { total_tokens: 42 } }, state);
      });
      return state;
    },
    async stop(state) { state.finished = true; return { stopped: true, exitCode: 0 }; },
  };
}

test('adapter contract covers the permanent external worker stack without pretending readiness', async () => {
  const codex = new CodexContinuityAdapter({ enabled: false });
  const adapters = [codex, claudeCodeAdapter, antigravityAdapter, createOpenCodeAdapter(), createGeminiCliAdapter(), createKiloAdapter(), createFreebuffAdapter()];
  for (const adapter of adapters) assert.equal(assertAdapterContract(adapter), adapter);
  for (const adapter of adapters) assert.equal((await adapter.available()).ok, false);
  assert.equal(antigravityAdapter.capabilities().quotaSource, 'google-ai-pro');
  assert.equal(createKiloAdapter({ chatGptLogin: true }).capabilities().quotaSource, 'openai-chatgpt');
  assert.equal(geminiCliAdapter.capabilities().quotaSource, 'gemini-cli');
});
test('Codex adapter uses the verified non-interactive JSON invocation and reports emitted usage only', async () => {
  const driver = readyDriver();
  const adapter = new CodexContinuityAdapter({ driver, enabled: true, inspectCheckpoint: async ({ context }) => context.checkpoint });
  const { session, process } = await adapter.start({ continuationPacket: 'continue safely', worktree: 'C:\\work' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(process.args, ['exec', '--json', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '-C', 'C:\\work', '-']);
  assert.equal(process.prompt, 'continue safely');
  assert.equal(driver.calls[0].cwd, 'C:\\work');
  assert.equal((await adapter.usage({ session })).task_tokens, 42);
  assert.equal((await adapter.usage({ session })).basis, 'PROVIDER_REPORTED');
  assert.equal((await adapter.stop({ session, reason: 'handoff' })).stopped, true);
});
test('Codex stop waits for a confirmed driver verdict and fails closed when termination is unconfirmed', async () => {
  const driver = readyDriver();
  let resolveStop;
  driver.stop = () => new Promise((resolve) => { resolveStop = resolve; });
  const adapter = new CodexContinuityAdapter({ driver, enabled: true, inspectCheckpoint: async ({ context }) => context.checkpoint });
  const { session } = await adapter.start({ continuationPacket: 'continue', worktree: 'C:\\work' });
  const stopping = adapter.stop({ session, reason: 'handoff' });
  let resolved = false;
  stopping.then(() => { resolved = true; }, () => { resolved = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false, 'handoff cannot continue before the old process exits');
  resolveStop({ stopped: false });
  await assert.rejects(stopping, /WORKER_STOP_UNCONFIRMED/);
  const confirmed = adapter.stop({ session, reason: 'handoff' });
  let confirmedResolved = false;
  confirmed.then(() => { confirmedResolved = true; }, () => { confirmedResolved = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(confirmedResolved, false);
  resolveStop({ stopped: true, exitCode: 0 });
  assert.equal((await confirmed).stopped, true);
});
test('Codex handoff re-inspects Git instead of trusting an old checkpoint', async () => {
  const adapter = new CodexContinuityAdapter({ inspectCheckpoint: async ({ context }) => ({ ...context.checkpoint, last_commit: 'c'.repeat(40) }) });
  const result = await adapter.checkpoint({ session: { id: 'run' }, context: { checkpoint: { last_commit: 'b'.repeat(40) } } });
  assert.equal(result.payload.last_commit, 'c'.repeat(40));
});
test('Claude Code readiness accepts subscription auth only and cannot push outside Supervisor ownership', async () => {
  const probe = async (authMethod) => {
    const driver = { inspect: async (_binary, args) => {
      if (args[0] === '--version') return { ok: true, stdout: '2.1.268' };
      if (args[0] === '--help') return { ok: true, stdout: '--output-format --resume --permission-mode --permission-prompts --allowedTools' };
      return { ok: true, stdout: JSON.stringify({ authMethod }) };
    } };
    const adapter = new ClaudeCodeContinuityAdapter({ driver, enabled: true });
    return { readiness: await adapter.available(), args: adapter.command({}) };
  };
  assert.equal((await probe('claude.ai')).readiness.authState, 'AUTHENTICATED');
  assert.equal((await probe('oauth_token')).readiness.authState, 'AUTHENTICATED');
  for (const method of ['api_key', 'api_key_helper', 'third_party', 'none']) {
    const { readiness } = await probe(method);
    assert.equal(readiness.authState, 'NOT_AUTHENTICATED', method);
    assert.equal(readiness.reason, 'AUTH_REQUIRED', method);
  }
  const { args } = await probe('claude.ai');
  assert.ok(args.includes('dontAsk'));
  assert.ok(args.includes('none'));
  assert.ok(!args.some((arg) => arg.includes('git push')));
});
test('Claude Code receives its isolated login directory without inheriting API billing keys', () => {
  const env = { HOME: '/phase-n', CLAUDE_CONFIG_DIR: '/phase-n/claude', ANTHROPIC_API_KEY: 'not-for-subscription' };
  const driver = new ExternalWorkerDriver({ env });
  const adapter = new ClaudeCodeContinuityAdapter({ driver, enabled: true });
  const childEnv = driver.environment(adapter.envKeys);
  assert.equal(childEnv.CLAUDE_CONFIG_DIR, env.CLAUDE_CONFIG_DIR);
  assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
});
test('OpenCode owner gates are provider-neutral, fail closed and keep legacy Zen behaviour', async () => {
  const gate = (options) => createOpenCodeAdapter(options).gateReason();
  const openrouter = { modelProvider: 'openrouter', model: 'openrouter/openrouter/free' };
  const zen = { model: 'opencode/free' };
  assert.equal(gate({ enabled: true, modelProvider: 'openrouter' }), 'MODEL_NOT_CONFIGURED');
  assert.equal(gate({ ...openrouter, model: 'openrouter', autoReload: false }), 'MODEL_PROVIDER_MISMATCH');
  assert.equal(gate({ ...openrouter, model: 'anthropic/claude', autoReload: false, freeVerified: true,
    legitimateAccess: true, dataClassAllowed: true }), 'MODEL_PROVIDER_MISMATCH');
  // Required for every provider: auto-reload off, verified free source,
  // legitimate access and privacy/data-class approval.
  assert.equal(gate({ ...zen, autoReload: true }), 'AUTO_RELOAD_MUST_BE_OFF');
  assert.equal(gate({ ...zen, autoReload: false }), 'FREE_ACCESS_NOT_VERIFIED');
  assert.equal(gate({ ...openrouter, autoReload: false, freeVerified: true }), 'ACCESS_NOT_VERIFIED');
  assert.equal(gate({ ...openrouter, autoReload: false, freeVerified: true, legitimateAccess: true }), 'PRIVACY_NOT_ALLOWED');
  // Verified OpenRouter Free (any non-zen provider) never needs a Zen
  // promotion …
  assert.equal(gate({ ...openrouter, autoReload: false, freeVerified: true, legitimateAccess: true, dataClassAllowed: true }), null);
  assert.equal(gate({ model: 'openrouter-free/free', autoReload: false, freeVerified: true, legitimateAccess: true,
    dataClassAllowed: true, modelProvider: '  OPENROUTER-Free ' }), null, 'provider matching is trimmed and case-insensitive');
  // … while Zen (the default provider) stays fail-closed without it.
  assert.equal(gate({ ...zen, autoReload: false, freeVerified: true, legitimateAccess: true, dataClassAllowed: true }), 'ZEN_PROMOTION_INACTIVE');
  assert.equal(gate({ ...zen, autoReload: false, freeVerified: true, promotionActive: true, legitimateAccess: true, dataClassAllowed: true }), null);
  // Legacy option name stays accepted (backward compatibility).
  assert.equal(gate({ ...openrouter, autoReload: false, zenFree: false }), 'FREE_ACCESS_NOT_VERIFIED');
  assert.equal(gate({ ...openrouter, autoReload: false, zenFree: true, legitimateAccess: true, dataClassAllowed: true }), null);
  // A closed gate blocks availability before any subprocess runs.
  const cases = [
    [{ ...zen, autoReload: true }, 'AUTO_RELOAD_MUST_BE_OFF'],
    [{ ...zen, autoReload: false }, 'FREE_ACCESS_NOT_VERIFIED'],
    [{ ...openrouter, autoReload: false, freeVerified: true }, 'ACCESS_NOT_VERIFIED'],
    [{ ...zen, autoReload: false, freeVerified: true, legitimateAccess: true, dataClassAllowed: true }, 'ZEN_PROMOTION_INACTIVE'],
  ];
  for (const [options, reason] of cases) assert.equal((await createOpenCodeAdapter(options).available()).reason, reason);
});

test('OpenCode requires and passes an explicit provider-matched model before spawn', async () => {
  let inspections = 0;
  let launches = 0;
  const driver = {
    async inspect() { inspections += 1; return { ok: false, stdout: '', stderr: '' }; },
    launch() { launches += 1; throw new Error('must not spawn'); },
  };
  const missing = createOpenCodeAdapter({ driver, enabled: true, modelProvider: 'openrouter' });
  assert.equal((await missing.available()).reason, 'MODEL_NOT_CONFIGURED');
  assert.equal(inspections, 0);
  await assert.rejects(missing.start({ continuationPacket: 'x', worktree: '/tmp/work' }), /AUTH_REQUIRED/);
  assert.equal(launches, 0);

  const adapter = createOpenCodeAdapter({ modelProvider: 'openrouter', model: 'openrouter/openrouter/free' });
  assert.deepEqual(adapter.command({ worktree: '/tmp/work' }), [
    'run', '--model', 'openrouter/openrouter/free', '--format', 'json', '--auto', '--dir', '/tmp/work',
  ]);
  assert.deepEqual(adapter.command({ worktree: '/tmp/work', resumeId: 'session-1' }).slice(-2), ['--session', 'session-1']);
});

test('OpenCode Phase N mount isolation keeps the checkout read-only and the leased worktree outside it', () => {
  const protectedRoot = resolve('phase-n-protected-checkout');
  const externalWorktree = resolve('..', 'phase-n-external-worktree', 'session-2');
  const adapter = createOpenCodeAdapter({
    modelProvider: 'zen', model: 'opencode/nemotron-3.5-lightning-free',
    isolationRepoRoot: protectedRoot, platform: 'linux',
  });
  const command = adapter.command({ worktree: externalWorktree, resumeId: null });
  assert.equal(command.binary, 'unshare');
  assert.ok(command.args.includes(protectedRoot));
  assert.ok(command.args.includes(externalWorktree));
  assert.ok(command.args.some((arg) => arg.includes('mount --bind "$repo" "$repo"; mount -o remount,ro,bind "$repo"')));
  assert.throws(
    () => adapter.command({ worktree: resolve(protectedRoot, '.continuity', 'worktrees', 'session-2'), resumeId: null }),
    /WORKTREE_UNSAFE/,
  );
});

test('externalAdaptersFromEnv wires the provider-neutral and the legacy OpenCode flags', async () => {
  const { externalAdaptersFromEnv } = await import('../src/continuity/runtime.js');
  const neutral = externalAdaptersFromEnv({ env: {
    CONTINUITY_OPENCODE_ENABLED: '1', CONTINUITY_OPENCODE_AUTO_RELOAD_OFF: '1',
    CONTINUITY_OPENCODE_MODEL: 'openrouter/openrouter/free',
    CONTINUITY_OPENCODE_MODEL_PROVIDER: 'openrouter', CONTINUITY_OPENCODE_FREE_VERIFIED: '1',
    CONTINUITY_OPENCODE_ACCESS_VERIFIED: '1', CONTINUITY_OPENCODE_PRIVACY_VERIFIED: '1',
    CONTINUITY_GEMINI_CLI_ENABLED: '1',
  } });
  assert.equal(neutral.opencode.enabled, true);
  assert.equal(neutral.opencode.gateReason(), null, 'OpenRouter Free must not require a Zen promotion');
  assert.equal(neutral.gemini.enabled, true);
  // Missing neutral gate still fails closed for the OpenRouter provider.
  const neutralMissing = externalAdaptersFromEnv({ env: {
    CONTINUITY_OPENCODE_ENABLED: '1', CONTINUITY_OPENCODE_AUTO_RELOAD_OFF: '1',
    CONTINUITY_OPENCODE_MODEL: 'openrouter/openrouter/free',
    CONTINUITY_OPENCODE_MODEL_PROVIDER: 'openrouter', CONTINUITY_OPENCODE_ACCESS_VERIFIED: '1',
    CONTINUITY_OPENCODE_PRIVACY_VERIFIED: '1',
  } });
  assert.equal(neutralMissing.opencode.gateReason(), 'FREE_ACCESS_NOT_VERIFIED');
  // Legacy ZEN_* names still wire exactly as before; provider defaults to zen.
  const legacy = externalAdaptersFromEnv({ env: {
    CONTINUITY_OPENCODE_ENABLED: '1', CONTINUITY_OPENCODE_AUTO_RELOAD_OFF: '1',
    CONTINUITY_OPENCODE_MODEL: 'opencode/free',
    CONTINUITY_OPENCODE_ZEN_FREE_VERIFIED: '1', CONTINUITY_OPENCODE_ZEN_PROMOTION_ACTIVE: '1',
    CONTINUITY_OPENCODE_ACCESS_VERIFIED: '1', CONTINUITY_OPENCODE_PRIVACY_VERIFIED: '1',
  } });
  assert.equal(legacy.opencode.gateReason(), null, 'the legacy Zen setup keeps working unchanged');
  // …and the legacy promotion assertion is still required for Zen.
  const legacyNoPromo = externalAdaptersFromEnv({ env: {
    CONTINUITY_OPENCODE_ENABLED: '1', CONTINUITY_OPENCODE_AUTO_RELOAD_OFF: '1',
    CONTINUITY_OPENCODE_MODEL: 'opencode/free',
    CONTINUITY_OPENCODE_ZEN_FREE_VERIFIED: '1',
    CONTINUITY_OPENCODE_ACCESS_VERIFIED: '1', CONTINUITY_OPENCODE_PRIVACY_VERIFIED: '1',
  } });
  assert.equal(legacyNoPromo.opencode.gateReason(), 'ZEN_PROMOTION_INACTIVE');
});

test('the Phase N drill preflight never demands a Zen promotion for a non-zen provider', () => {
  const src = readFileSync(new URL('../tools/continuity-phase-n-live.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('CONTINUITY_OPENCODE_MODEL_PROVIDER'), 'the drill reads the declared model provider');
  assert.ok(src.includes("const PHASE_N_OPENCODE_MODEL = 'opencode/nemotron-3.5-lightning-free'"), 'the drill pins the live-proven model');
  assert.ok(src.includes('CONTINUITY_OPENCODE_MODEL'), 'the drill requires the explicit model');
  assert.ok(src.includes('CONTINUITY_OPENCODE_ISOLATION_REPO_ROOT'), 'the drill protects the checkout with OpenCode mount isolation');
  assert.ok(src.includes("join(tmpdir(), `fahad-ai-office-phase-n-${process.pid}`, 'worktrees')"), 'external worktrees stay outside the protected checkout');
  assert.ok(src.includes('CONTINUITY_OPENCODE_FREE_VERIFIED'), 'the drill accepts the provider-neutral free gate');
  const flagsArray = /const opencodeFlags = \[[^\]]*\]/.exec(src)?.[0] || '';
  assert.ok(!flagsArray.includes('ZEN_PROMOTION_ACTIVE'), 'the promotion must not be an unconditional preflight requirement');
  assert.ok(!flagsArray.includes('ZEN_FREE_VERIFIED'), 'the Zen-named free flag must not be the only accepted free gate');
});

test('the Phase N termination proof kills a live resumed OpenCode turn, not the completed marker turn', () => {
  const src = readFileSync(new URL('../tools/continuity-phase-n-live.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('phaseAdapters.opencode.resume({'));
  assert.ok(src.includes('crashState.child.kill(\'SIGKILL\')'));
  assert.ok(!src.includes('stateO.child.kill(\'SIGKILL\')'));
});

test('the Phase N drill declares every lifecycle state it references (no ReferenceError at --run)', () => {
  // Regression guard for a real VPS failure: `--check` preflight passed but
  // `--run` died immediately with `ReferenceError: adapterSets is not
  // defined` inside buildSupervisor(). `node --check` only proves syntax, so
  // this asserts the scope invariant directly: any drill-internal state name
  // that appears in the source must have a declaration.
  const src = readFileSync(new URL('../tools/continuity-phase-n-live.mjs', import.meta.url), 'utf8');
  const declared = (name) => new RegExp(`\\b(?:const|let|var|function|class|import)\\s+${name}\\b`).test(src);
  for (const name of ['adapterSets', 'supervisors', 'phaseAdapters', 'verdict', 'blocker', 'evidence', 'worktrees']) {
    if (new RegExp(`\\b${name}\\b`).test(src)) {
      assert.ok(declared(name), `${name} is referenced in the drill but never declared`);
    }
  }
  // Same bug class, caught generically: every bare `name.push(` collector
  // must resolve to a declaration in this file (property pushes like
  // `foo.bar.push(` are excluded on purpose).
  for (const match of src.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\.push\(/gm)) {
    assert.ok(declared(match[1]), `${match[1]}.push( uses an undeclared variable`);
  }
});

test('OpenCode 1.18.34 run --help is read from its real stderr shape and still fails closed', async () => {
  // Byte-for-byte capture of the official `opencode run --help` (OpenCode
  // 1.18.34): yargs writes the whole help to STDERR, stdout stays empty and
  // the exit code is 0 — the exact shape that produced the VPS false negative.
  const realHelp = readFileSync(new URL('../testing/fixtures/opencode-run-help-1.18.34.txt', import.meta.url), 'utf8');
  const probeWith = async (result) => {
    const driver = { inspect: async () => result };
    return createOpenCodeAdapter({ driver, enabled: true }).verifyFeatures();
  };
  assert.equal((await probeWith({ ok: true, stdout: '', stderr: realHelp })).ok, true,
    'the real stderr-only help must be recognised');
  // ANSI styling (attached terminal) must not hide a flag.
  const ansiHelp = realHelp.replace(/--(format|session|continue|dir|auto)\b/g, '\u001b[1m$&\u001b[0m');
  assert.equal((await probeWith({ ok: true, stdout: ansiHelp, stderr: '' })).ok, true,
    'ANSI styling must not hide a flag');
  // CRLF line endings must not hide a flag either.
  assert.equal((await probeWith({ ok: true, stdout: '', stderr: realHelp.replaceAll('\n', '\r\n') })).ok, true,
    'CRLF line endings must not hide a flag');
  // A genuinely absent flag still fails closed as UNSUPPORTED_VERSION.
  const withoutAuto = realHelp.replace(/^.*--auto.*\n?/m, '');
  assert.ok(!withoutAuto.includes('--auto'));
  assert.equal((await probeWith({ ok: true, stdout: '', stderr: withoutAuto })).ok, false,
    'a missing --auto must fail closed');
  assert.equal((await probeWith({ ok: false, stdout: '', stderr: realHelp })).ok, false,
    'a failed inspection must fail closed');
});

test('the external driver keeps the whole stderr only when a verifier raises the bound', async () => {
  const help = `HEAD-MARKER ${'x'.repeat(4000)} --auto`;
  const execFile = (_binary, _args, _options, callback) => callback(null, '', help);
  const driver = new ExternalWorkerDriver({ execFile, env: {} });
  const bounded = await driver.inspect('opencode', ['run', '--help']);
  assert.ok(!bounded.stderr.includes('HEAD-MARKER'), 'the default tail bound is unchanged for error classification');
  const wide = await driver.inspect('opencode', ['run', '--help'], { stderrLimit: 64 * 1024 });
  assert.equal(wide.stderr, help, 'verifyFeatures reads the complete help text');
});

test('a non-zero OpenCode JSON failure remains visible in bounded failure evidence', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => true;
  const driver = new ExternalWorkerDriver({ spawn: () => child, env: {} });
  const adapter = createOpenCodeAdapter({ modelProvider: 'openrouter', model: 'openrouter/openrouter/free' });
  const worktree = resolve('test-worktree');
  const state = driver.launch({
    binary: 'opencode', args: adapter.command({ worktree }), prompt: 'continue', cwd: worktree,
    onEvent: (event, current) => adapter.consumeEvent(event, current), timeoutMs: 5_000,
  });
  child.stdout.write(`${JSON.stringify({ type: 'error', message: 'provider rejected model' })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.emit('close', 1, null);
  await state.done;
  assert.equal(state.errorCode, 'WORKER_CRASHED');
  assert.match(externalFailureEvidence(state), /provider rejected model/);
  assert.match(externalFailureEvidence(state), /stdout=/);
});


test('Codex reports a sandbox bootstrap failure even when its turn exits successfully', () => {
  const adapter = new CodexContinuityAdapter();
  const state = { errorCode: null, resultSeen: false };
  adapter.consumeEvent({ type: 'item.completed', item: {
    type: 'command_execution', exit_code: 1,
    aggregated_output: 'bwrap: No permissions to create a new namespace',
  } }, state);
  adapter.consumeEvent({ type: 'turn.completed' }, state);
  assert.equal(state.errorCode, 'SANDBOX_UNAVAILABLE');
  assert.equal(state.resultSeen, true);
});
test('sandbox denial is recognised by the shared classifier for every external worker', async () => {
  const { classifyCliFailure, sandboxDenial } = await import('../src/continuity/errors.js');
  assert.equal(sandboxDenial('bwrap: No permissions to create a new namespace'), true);
  assert.equal(sandboxDenial('done\nbwrap: failed to setup loopback'), true);
  assert.equal(sandboxDenial('all commands completed'), false);
  assert.equal(classifyCliFailure({ stderr: 'bwrap: No permissions to create a new namespace', exitCode: 0 }), 'SANDBOX_UNAVAILABLE');
  assert.equal(classifyCliFailure({ stderr: 'clean run', exitCode: 0 }), null);
  assert.equal(classifyCliFailure({ stderr: 'clean run', exitCode: 1 }), 'WORKER_CRASHED');
});
test('a host that cannot start the Codex sandbox is unavailable before any turn starts', async () => {
  const driver = {
    async inspect(_binary, args) {
      if (args[0] === '--version') return { ok: true, stdout: 'codex-cli 0.158.0' };
      if (args[0] === 'sandbox') return { ok: false, exitCode: 1, stdout: '', stderr: 'bwrap: No permissions to create a new namespace' };
      if (args[0] === 'login') return { ok: true, stdout: '' };
      return { ok: true, stdout: args[1] === 'resume' ? '--json --config' : '--json --sandbox --cd --config' };
    },
    launch() { throw new Error('an unavailable worker must never launch'); },
  };
  const adapter = new CodexContinuityAdapter({ driver, enabled: true, platform: 'linux', inspectCheckpoint: async ({ context }) => context.checkpoint });
  const readiness = await adapter.available();
  assert.equal(readiness.ok, false);
  assert.equal(readiness.reason, 'SANDBOX_UNAVAILABLE');
  assert.equal(readiness.authState, 'HOST_CAPABILITY_REQUIRED');
  await assert.rejects(adapter.start({ continuationPacket: 'continue', worktree: '/tmp/work' }), /SANDBOX_UNAVAILABLE/);
});
test('workers without an OS sandbox keep the safe availability default', async () => {
  const driver = { inspect: async () => ({ ok: false, stdout: '', stderr: '' }) };
  const adapter = new CodexContinuityAdapter({ driver, enabled: true, platform: 'darwin' });
  assert.deepEqual(await adapter.verifySandbox(), { ok: true });
  const plain = new ClaudeCodeContinuityAdapter({ driver, enabled: true, platform: 'linux' });
  assert.deepEqual(await plain.verifySandbox(), { ok: true });
});
test('Codex typed usage limit is classified as quota exhaustion', async () => {
  const { classifyCliFailure } = await import('../src/continuity/errors.js');
  assert.equal(classifyCliFailure({ event: { error: { codex_error_info: 'usage_limit_exceeded' } }, exitCode: 1 }), 'QUOTA_EXHAUSTED');
});

test('Gemini CLI explicit model is passed without changing the headless safety flags', () => {
  const adapter = createGeminiCliAdapter({ model: 'gemini-flash-lite-latest' });
  assert.deepEqual(adapter.command(), ['--model', 'gemini-flash-lite-latest', '--output-format', 'stream-json', '--approval-mode', 'yolo', '--skip-trust']);
});

test('Gemini CLI adapter uses only the verified official headless flags and never a stale resume', () => {
  const adapter = new GeminiCliContinuityAdapter();
  const args = adapter.command({ worktree: '/tmp/work' });
  assert.deepEqual(args, ['--output-format', 'stream-json', '--approval-mode', 'yolo', '--skip-trust']);
  assert.ok(!args.includes('--resume'), 'a resume index could resume a different session');
  const caps = adapter.capabilities();
  assert.equal(caps.resume, false, 'recovery starts a fresh session from the continuation packet');
  assert.equal(caps.executionMode, 'EXECUTABLE');
  assert.equal(caps.quotaSource, 'gemini-cli');
  assert.equal(caps.costClass, 'unknown', 'no free cost class before live verification');
  assert.deepEqual(caps.privacyClasses, ['PUBLIC'], 'privacy stays conservative until verified');
  assert.equal(caps.worktreeManagement, 'supervisor');
});

test('Gemini CLI feature verification fails closed when a required official flag disappears', async () => {
  const probeWith = async (helpText) => {
    const driver = { inspect: async () => ({ ok: true, stdout: helpText }) };
    const adapter = new GeminiCliContinuityAdapter({ driver, enabled: true });
    return adapter.verifyFeatures();
  };
  assert.equal((await probeWith('... -o, --output-format [choices: "text","json","stream-json"] --approval-mode [choices: "default","auto_edit","yolo","plan"] --skip-trust')).ok, true);
  assert.equal((await probeWith('--output-format stream-json --approval-mode yolo')).ok, false, 'missing --skip-trust fails closed');
});

test('Gemini CLI auth readiness checks credential presence only and fails closed without it', async () => {
  const adapterWith = (env) => new GeminiCliContinuityAdapter({
    driver: { environment: () => env, inspect: async () => ({ ok: true, stdout: '' }) }, enabled: true,
  });
  // Presence only: the readiness answer never depends on or exposes a value.
  assert.equal((await adapterWith({ GEMINI_API_KEY: 'presence-only' }).verifyAuth()).ok, true);
  assert.equal((await adapterWith({ HOME: '/nonexistent-phase-n-home' }).verifyAuth()).ok, false);
  const noDriverEnv = new GeminiCliContinuityAdapter({ driver: { inspect: async () => ({ ok: true, stdout: '' }) }, enabled: true });
  assert.equal((await noDriverEnv.verifyAuth()).ok, false);
});

test('Gemini CLI structured output parsing: session id, terminal result, usage and severity-aware errors', () => {
  const adapter = new GeminiCliContinuityAdapter();
  const state = {};
  adapter.consumeEvent({ type: 'init', session_id: 'g-123', model: 'gemini' }, state);
  assert.equal(state.id, 'g-123');
  adapter.consumeEvent({ type: 'error', severity: 'warning', message: 'non-fatal notice' }, state);
  assert.equal(state.providerFailure, undefined, 'a warning severity must not fail a successful turn');
  adapter.consumeEvent({ type: 'result', status: 'success', stats: { total_tokens: 90, input_tokens: 60, output_tokens: 30 } }, state);
  assert.equal(state.resultSeen, true);
  assert.deepEqual(state.usage, { total_tokens: 90, input_tokens: 60, output_tokens: 30 });
  assert.equal(state.providerFailure, undefined);
  const failed = {};
  adapter.consumeEvent({ type: 'error', severity: 'error', message: 'model unavailable' }, failed);
  assert.equal(failed.providerFailure.severity, 'error');
  const terminal = {};
  adapter.consumeEvent({ type: 'result', status: 'error', error: { type: 'Error', message: 'api failure' } }, terminal);
  assert.equal(terminal.resultSeen, true, 'a terminal result is seen even when it reports failure');
  assert.equal(terminal.providerFailure.status, 'error');
});

test('the observed unauthenticated Gemini CLI exit is classified as AUTH_REQUIRED', async () => {
  const { classifyCliFailure } = await import('../src/continuity/errors.js');
  // Observed on the official 0.40.1 CLI: plain stderr, no JSON event, exit 41.
  assert.equal(classifyCliFailure({ stderr: 'Please set an Auth method in your settings or specify GEMINI_API_KEY', exitCode: 41 }), 'AUTH_REQUIRED');
});

test('the Phase-N failure taxonomy distinguishes all eight categories from what the runtime reports', async () => {
  const { CONTINUITY_ERROR_CODES, FAILURE_TAXONOMY, failureCategory } = await import('../src/continuity/errors.js');
  assert.deepEqual(Object.keys(FAILURE_TAXONOMY), [
    'AUTH_REQUIRED', 'UNSUPPORTED_VERSION', 'SANDBOX_UNAVAILABLE', 'HOST_CAPABILITY_REQUIRED',
    'RATE_LIMITED', 'PROCESS_FAILED', 'STOP_UNCONFIRMED', 'WORKTREE_UNSAFE',
  ]);
  assert.equal(failureCategory({ code: 'AUTH_REQUIRED' }), 'AUTH_REQUIRED');
  assert.equal(failureCategory({ code: 'UNSUPPORTED_VERSION' }), 'UNSUPPORTED_VERSION');
  assert.equal(failureCategory({ code: 'SANDBOX_UNAVAILABLE' }), 'SANDBOX_UNAVAILABLE', 'run-time isolation failure');
  assert.equal(failureCategory({ code: 'SANDBOX_UNAVAILABLE', authState: 'HOST_CAPABILITY_REQUIRED' }), 'HOST_CAPABILITY_REQUIRED', 'readiness wins when both are present');
  assert.equal(failureCategory({ authState: 'HOST_CAPABILITY_REQUIRED' }), 'HOST_CAPABILITY_REQUIRED');
  assert.equal(failureCategory({ code: 'RATE_LIMITED' }), 'RATE_LIMITED');
  assert.equal(failureCategory({ code: 'WORKER_CRASHED' }), 'PROCESS_FAILED');
  assert.equal(failureCategory({ code: 'WORKER_TIMEOUT' }), 'PROCESS_FAILED');
  assert.equal(failureCategory({ code: 'WORKER_OUTPUT_INVALID' }), 'PROCESS_FAILED');
  assert.equal(failureCategory({ code: 'WORKER_STOP_UNCONFIRMED' }), 'STOP_UNCONFIRMED');
  assert.equal(failureCategory({ code: 'WORKTREE_UNSAFE' }), 'WORKTREE_UNSAFE');
  assert.equal(failureCategory({ code: 'QUOTA_EXHAUSTED' }), null, 'already-unambiguous codes stay outside the taxonomy');
  assert.equal(failureCategory({}), null);
  // Every taxonomy representation must be a real runtime value.
  for (const entry of Object.values(FAILURE_TAXONOMY)) {
    for (const code of entry.codes || []) assert.ok(CONTINUITY_ERROR_CODES.includes(code), code);
  }
});
