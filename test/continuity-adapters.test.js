import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAdapterContract } from '../src/continuity/adapter-contract.js';
import { CodexContinuityAdapter } from '../src/continuity/adapters/codex.js';
import { ClaudeCodeContinuityAdapter, claudeCodeAdapter } from '../src/continuity/adapters/claude-code.js';
import { ExternalWorkerDriver } from '../src/continuity/external-driver.js';
import { antigravityAdapter } from '../src/continuity/adapters/antigravity.js';
import { createOpenCodeAdapter } from '../src/continuity/adapters/opencode.js';
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
  const adapters = [codex, claudeCodeAdapter, antigravityAdapter, createOpenCodeAdapter(), createKiloAdapter(), createFreebuffAdapter()];
  for (const adapter of adapters) assert.equal(assertAdapterContract(adapter), adapter);
  for (const adapter of adapters) assert.equal((await adapter.available()).ok, false);
  assert.equal(antigravityAdapter.capabilities().quotaSource, 'google-ai-pro');
  assert.equal(createKiloAdapter({ chatGptLogin: true }).capabilities().quotaSource, 'openai-chatgpt');
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
    type: 'CommandExecution', exit_code: 1,
    aggregated_output: 'bwrap: No permissions to create a new namespace',
  } }, state);
  adapter.consumeEvent({ type: 'turn.completed' }, state);
  assert.equal(state.errorCode, 'WORKER_CRASHED');
  assert.equal(state.resultSeen, true);
});
test('Codex typed usage limit is classified as quota exhaustion', async () => {
  const { classifyCliFailure } = await import('../src/continuity/errors.js');
  assert.equal(classifyCliFailure({ event: { error: { codex_error_info: 'usage_limit_exceeded' } }, exitCode: 1 }), 'QUOTA_EXHAUSTED');
});
