import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAdapterContract } from '../src/continuity/adapter-contract.js';
import { CodexContinuityAdapter } from '../src/continuity/adapters/codex.js';
import { ClaudeCodeContinuityAdapter, claudeCodeAdapter } from '../src/continuity/adapters/claude-code.js';
import { ExternalWorkerDriver } from '../src/continuity/external-driver.js';
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
test('OpenCode Zen fails closed for every required safety condition', async () => {
  const cases = [
    [{ autoReload: true }, 'AUTO_RELOAD_MUST_BE_OFF'],
    [{ autoReload: false }, 'ZEN_MODEL_NOT_VERIFIED_FREE'],
    [{ autoReload: false, zenFree: true }, 'ZEN_PROMOTION_INACTIVE'],
    [{ autoReload: false, zenFree: true, promotionActive: true }, 'ZEN_ACCESS_NOT_VERIFIED'],
    [{ autoReload: false, zenFree: true, promotionActive: true, legitimateAccess: true }, 'ZEN_PRIVACY_NOT_ALLOWED'],
  ];
  for (const [options, reason] of cases) assert.equal((await createOpenCodeAdapter(options).available()).reason, reason);
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
