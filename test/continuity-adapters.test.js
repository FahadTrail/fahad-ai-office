import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { assertAdapterContract } from '../src/continuity/adapter-contract.js';
import { CodexContinuityAdapter } from '../src/continuity/adapters/codex.js';
import { claudeCodeAdapter } from '../src/continuity/adapters/claude-code.js';
import { antigravityAdapter } from '../src/continuity/adapters/antigravity.js';
import { createOpenCodeAdapter } from '../src/continuity/adapters/opencode.js';
import { createKiloAdapter } from '../src/continuity/adapters/kilo.js';
import { createFreebuffAdapter } from '../src/continuity/adapters/freebuff.js';

function fakeSpawn(_command, args) {
  const child = new EventEmitter();
  child.args = args; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin = { end: (text) => { child.prompt = text; } };
  child.kill = () => { child.emit('exit', 0); return true; };
  queueMicrotask(() => child.stdout.emit('data', Buffer.from('{"type":"thread.started","thread_id":"thread-1"}\n{"usage":{"total_tokens":42}}\n')));
  return child;
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
  const adapter = new CodexContinuityAdapter({ spawn: fakeSpawn, enabled: true, probe: async () => ({ ok: true }) });
  const { session, process } = await adapter.start({ continuationPacket: 'continue safely', worktree: 'C:\\work' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(process.args, ['exec', '--json', '--sandbox', 'workspace-write', '--approve-for-me', '-C', 'C:\\work', '-']);
  assert.equal(process.prompt, 'continue safely');
  assert.equal((await adapter.usage({ session })).task_tokens, 42);
  assert.equal((await adapter.usage({ session })).basis, 'PROVIDER_REPORTED');
  assert.equal((await adapter.stop({ session, reason: 'handoff' })).stopped, true);
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
