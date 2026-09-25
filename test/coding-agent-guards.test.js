import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodingWorker } from '../src/coding-agent/runtime.js';
import { REPOSITORY, SESSION_CONFIG, WORKSPACE_ID, createFixtureRepo, fakeApis, localRuntime } from '../testing/fixtures/coding-agent-harness.js';

function loopingPool(behavior) {
  const common = { toolCalling: true, contextWindow: 200_000, privacyApproved: true, unavailableReasons: [], pricing: { inputPerMillion: 1, outputPerMillion: 1 }, billingClass: 'paid', qualityTier: 5, costTier: 1 };
  return [{ ...common, id: 'anthropic:claude-opus-5', provider: 'anthropic', model: 'claude-opus-5', secretRef: 'env://ANTHROPIC_API_KEY', protocolClient: { turn: behavior } }];
}

async function runWith(behavior, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fahad-guard-'));
  try {
    const { bare } = createFixtureRepo(root);
    const { runtime, sessionStore } = localRuntime({ root, storePath: join(root, 's.json'), pool: loopingPool(behavior), fetchFn: fakeApis({ bare }).fetchFn });
    const session = await sessionStore.createSession({
      workspaceId: WORKSPACE_ID, title: 'Guard test', repository: REPOSITORY, objective: 'Exercise the controller guards safely',
      config: { ...SESSION_CONFIG, fetchUrl: bare, pushUrl: bare }, ...overrides,
    });
    const outcome = await new CodingWorker({ runtime, sessionStore }).runOnce();
    return { outcome, session: await sessionStore.getSession(session.id) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const reply = (blocks) => ({ message: { role: 'assistant', content: blocks }, stopReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.01 }, durationMs: 1 });
let n = 0;

test('the no-progress guard blocks a model that repeats the same call', async () => {
  const { outcome, session } = await runWith(async () => reply([{ type: 'tool_call', id: `c${n++}`, name: 'read_file', arguments: { path: 'src/math.js' } }]));
  assert.equal(outcome.status, 'blocked');
  assert.match(session.blocker, /No-progress guard/);
});

test('a model that stops using tools is blocked instead of looping forever', async () => {
  const { outcome, session } = await runWith(async () => ({ ...reply([{ type: 'text', text: 'I think it is fine.' }]), stopReason: 'end' }));
  assert.equal(outcome.status, 'blocked');
  assert.match(session.blocker, /stopped calling tools/);
});

test('the session budget is a hard stop', async () => {
  const { outcome, session } = await runWith(async () => ({ ...reply([{ type: 'tool_call', id: `b${n++}`, name: 'list_files', arguments: { path: '.' } }]), usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.6 } }), { budgetUsd: 1 });
  assert.equal(outcome.status, 'blocked');
  assert.match(session.blocker, /budget/);
  assert.ok(session.spentUsd >= 1);
});

test('Hermes is protected at the tool layer and again at the finish gate', async () => {
  const seen = [];
  const script = [
    { type: 'tool_call', id: 'h1', name: 'write_file', arguments: { path: 'hermes/agent.js', content: 'x' } },
    // Obfuscated past the command hygiene filter; the finish gate must still catch it.
    { type: 'tool_call', id: 'h2', name: 'run_command', arguments: { command: 'mkdir -p her""mes && echo x > her""mes/agent.js' } },
    { type: 'tool_call', id: 'h3', name: 'finish', arguments: { summary: 'done' } },
  ];
  let step = 0;
  const { session } = await runWith(async ({ messages }) => {
    const results = messages.at(-1).content.filter((block) => block.type === 'tool_result');
    seen.push(...results.map((block) => block.content));
    if (step < script.length) return reply([script[step++]]);
    return reply([{ type: 'tool_call', id: `r${n++}`, name: 'request_human', arguments: { reason: 'test end', question: 'stop' } }]);
  });
  assert.ok(seen.some((text) => /HERMES_PROTECTED/.test(text)), 'direct Hermes write refused');
  assert.ok(seen.some((text) => /GATE FAILED[\s\S]*Hermes paths were modified/.test(text)), 'gate refuses a Hermes change');
  assert.equal(session.status, 'blocked');
  assert.equal(session.pr, undefined);
});
