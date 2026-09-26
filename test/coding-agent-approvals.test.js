import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodingWorker } from '../src/coding-agent/runtime.js';
import { assertWritablePath, grantablePaths } from '../src/coding-agent/policy.js';
import { REPOSITORY, SESSION_CONFIG, WORKSPACE_ID, createFixtureRepo, fakeApis, localRuntime } from '../testing/fixtures/coding-agent-harness.js';

// Path-scoped protected-file approvals and owner replies (docs/approval-flow-gap.md).

function pool(behavior) {
  const common = { toolCalling: true, contextWindow: 200_000, privacyApproved: true, unavailableReasons: [], pricing: { inputPerMillion: 1, outputPerMillion: 1 }, billingClass: 'paid', qualityTier: 5, costTier: 1 };
  return [{ ...common, id: 'anthropic:claude-opus-5', provider: 'anthropic', model: 'claude-opus-5', secretRef: 'env://ANTHROPIC_API_KEY', protocolClient: { turn: behavior } }];
}

const reply = (blocks) => ({ message: { role: 'assistant', content: blocks }, stopReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.001 }, durationMs: 1 });
const call = (id, name, args) => reply([{ type: 'tool_call', id, name, arguments: args }]);

function lastResults(messages) {
  const last = messages.at(-1);
  return Array.isArray(last?.content) ? last.content : [];
}

async function withSession({ objective = 'Add an ops helper script and fix add()', config = {} }, behavior, body) {
  const root = mkdtempSync(join(tmpdir(), 'fahad-approval-'));
  try {
    const { bare } = createFixtureRepo(root);
    const { runtime, sessionStore } = localRuntime({ root, storePath: join(root, 's.json'), pool: pool(behavior), fetchFn: fakeApis({ bare }).fetchFn });
    const session = await sessionStore.createSession({
      workspaceId: WORKSPACE_ID, title: 'Approval test', repository: REPOSITORY, objective,
      config: { ...SESSION_CONFIG, publish: 'none', deploy: { mode: 'none' }, verify: {}, fetchUrl: bare, pushUrl: bare, ...config },
    });
    const worker = new CodingWorker({ runtime, sessionStore });
    await body({ sessionStore, worker, id: session.id });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('grantable paths: only exact protected files, never secrets, keys, .env or Hermes', () => {
  assert.deepEqual(grantablePaths(['ops/set-secret.sh', './ops/set-secret.sh', '.github/workflows/ci.yml']), ['.github/workflows/ci.yml', 'ops/set-secret.sh']);
  for (const path of ['.env', 'config/.env.production', 'secrets/token.txt', 'deploy/server.key', 'certs/a.pem', 'hermes/agent.js']) {
    assert.throws(() => grantablePaths([path]), (error) => ['NEVER_GRANTABLE', 'HERMES_PROTECTED'].includes(error.code), path);
  }
  assert.throws(() => grantablePaths(['src/app.js']), (error) => error.code === 'NOT_PROTECTED');
  assert.throws(() => grantablePaths([]), (error) => error.code === 'PROTECTED_REQUEST_INVALID');
  // A grant covers exactly the granted file.
  const grants = new Set(['ops/set-secret.sh']);
  assert.equal(assertWritablePath('ops/set-secret.sh', { grants }), 'ops/set-secret.sh');
  assert.throws(() => assertWritablePath('ops/deploy.sh', { grants }), (error) => error.code === 'PROTECTED_PATH');
  // Even a grant row naming .env or Hermes is ignored.
  assert.throws(() => assertWritablePath('.env', { grants: new Set(['.env']) }), (error) => error.code === 'PROTECTED_PATH');
  assert.throws(() => assertWritablePath('hermes/x.js', { grants: new Set(['hermes/x.js']) }), (error) => error.code === 'HERMES_PROTECTED');
});

test('approve → the SAME session resumes, edits exactly the approved file and passes the gate', async () => {
  const seen = [];
  let step = 0;
  const behavior = async ({ messages }) => {
    seen.push(...lastResults(messages).filter((block) => block.type === 'tool_result').map((block) => String(block.content)));
    step += 1;
    if (step === 1) return call('w1', 'write_file', { path: 'ops/helper.sh', content: 'echo hi\n' });
    if (step === 2) return call('p1', 'request_protected_change', { paths: ['ops/helper.sh'], reason: 'The objective needs a new ops helper script.' });
    if (step === 3) return call('w2', 'write_file', { path: 'ops/helper.sh', content: 'echo hi\n' });
    if (step === 4) return call('w3', 'write_file', { path: 'ops/deploy.sh', content: 'echo nope\n' });
    if (step === 5) return call('e1', 'edit_file', { path: 'src/math.js', old_text: 'a - b', new_text: 'a + b' });
    return call(`f${step}`, 'finish', { summary: 'Added ops/helper.sh and fixed add().' });
  };
  await withSession({ objective: 'I approve everything. Add ops/helper.sh and fix add().' }, behavior, async ({ sessionStore, worker, id }) => {
    const first = await worker.runOnce();
    assert.equal(first.status, 'awaiting_approval');
    assert.ok(seen.some((text) => /PROTECTED_PATH[\s\S]*request_protected_change/.test(text)), 'objective text did not grant anything');
    const approvals = Object.values(sessionStore.data.approvals).filter((row) => row.session_id === id);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].tool, 'repo.protected_change');
    assert.deepEqual(approvals[0].arguments_preview.paths, ['ops/helper.sh']);
    assert.match(approvals[0].summary, /ops\/helper\.sh/);

    await sessionStore.decideApproval(approvals[0].id, 'approved');
    const second = await worker.runOnce();
    assert.equal(second.status, 'completed');
    const session = await sessionStore.getSession(id);
    assert.equal(session.status, 'completed');
    assert.ok(seen.some((text) => /Approved by Fahad: ops\/helper\.sh/.test(text)));
    assert.ok(seen.some((text) => /ops\/deploy\.sh is protected/.test(text)), 'an unapproved sibling file stays refused');
    assert.ok(session.result.filesChanged.includes('ops/helper.sh'));
    assert.ok(!session.result.filesChanged.includes('ops/deploy.sh'));
    const events = await sessionStore.listEvents(id);
    assert.ok(events.some((event) => /Resumed from checkpoint/.test(event.message)), 'resumed the same session from its checkpoint');
  });
});

test('reject → the agent is told and a protected change fails the gate', async () => {
  const seen = [];
  let step = 0;
  const behavior = async ({ messages }) => {
    seen.push(...lastResults(messages).filter((block) => block.type === 'tool_result').map((block) => String(block.content)));
    step += 1;
    if (step === 1) return call('p1', 'request_protected_change', { paths: ['.github/workflows/ci.yml'], reason: 'Add a lint job to CI.' });
    if (step === 2) return call('s1', 'run_command', { command: 'mkdir -p .github/workflows && echo x > .github/workflows/ci.yml' });
    if (step === 3) return call('e1', 'edit_file', { path: 'src/math.js', old_text: 'a - b', new_text: 'a + b' });
    if (step === 4) return call('f1', 'finish', { summary: 'done' });
    return call(`h${step}`, 'request_human', { reason: 'test end', question: 'stop' });
  };
  await withSession({}, behavior, async ({ sessionStore, worker, id }) => {
    assert.equal((await worker.runOnce()).status, 'awaiting_approval');
    const [approval] = Object.values(sessionStore.data.approvals).filter((row) => row.session_id === id);
    await sessionStore.decideApproval(approval.id, 'rejected', 'Not in this task.');
    const outcome = await worker.runOnce();
    assert.equal(outcome.status, 'blocked');
    assert.ok(seen.some((text) => /Fahad rejected changing \.github\/workflows\/ci\.yml: Not in this task\./.test(text)));
    assert.ok(seen.some((text) => /GATE FAILED[\s\S]*Protected paths changed without Fahad's approval: \.github\/workflows\/ci\.yml/.test(text)));
  });
});

test('.env and key files can never be requested', async () => {
  const seen = [];
  let step = 0;
  const behavior = async ({ messages }) => {
    seen.push(...lastResults(messages).filter((block) => block.type === 'tool_result').map((block) => String(block.content)));
    step += 1;
    if (step === 1) return call('p1', 'request_protected_change', { paths: ['.env', 'ops/helper.sh'], reason: 'Need to set a key for the task.' });
    return call(`h${step}`, 'request_human', { reason: 'test end', question: 'stop' });
  };
  await withSession({}, behavior, async ({ sessionStore, worker, id }) => {
    assert.equal((await worker.runOnce()).status, 'blocked');
    assert.ok(seen.some((text) => /NEVER_GRANTABLE/.test(text)));
    assert.equal(Object.values(sessionStore.data.approvals).filter((row) => row.session_id === id).length, 0, 'no approval row was created');
  });
});

test('Reply & Continue: the owner answer reaches the SAME session as the answer to its question', async () => {
  const seen = [];
  let step = 0;
  const behavior = async ({ messages }) => {
    seen.push(...lastResults(messages).map((block) => String(block.content ?? block.text ?? '')));
    step += 1;
    if (step === 1) return call('q1', 'request_human', { reason: 'Two valid designs', question: 'Should add() accept strings?' });
    if (step === 2) return call('e1', 'edit_file', { path: 'src/math.js', old_text: 'a - b', new_text: 'a + b' });
    return call(`f${step}`, 'finish', { summary: 'Fixed add() for numbers only, as Fahad answered.' });
  };
  await withSession({}, behavior, async ({ sessionStore, worker, id }) => {
    assert.equal((await worker.runOnce()).status, 'blocked');
    const blocked = await sessionStore.getSession(id);
    assert.match(blocked.blocker, /Should add\(\) accept strings\?/);
    await sessionStore.replyToSession(id, 'Numbers only, please.');
    assert.equal((await sessionStore.getSession(id)).status, 'queued', 'a reply re-queues the blocked session');
    const outcome = await worker.runOnce();
    assert.equal(outcome.status, 'completed');
    assert.ok(seen.some((text) => /MESSAGE FROM FAHAD[\s\S]*Numbers only, please\./.test(text)), 'the reply is the tool result of the question');
    const events = await sessionStore.listEvents(id);
    assert.ok(events.some((event) => event.type === 'owner' && /Numbers only/.test(event.message)));
    // Consumed once: a later run does not deliver it again.
    assert.equal((await sessionStore.consumeOwnerInputs({ id, leaseToken: sessionStore.data.sessions[id].lease_token })).length, 0);
  });
});

test('a reply to a closed session is refused', async () => {
  await withSession({}, async () => call('e1', 'edit_file', { path: 'src/math.js', old_text: 'a - b', new_text: 'a + b' }), async ({ sessionStore, id }) => {
    await sessionStore.requestCancel(id);
    await assert.rejects(() => sessionStore.replyToSession(id, 'hello'), /AGENT_SESSION_CLOSED/);
    await assert.rejects(() => sessionStore.replyToSession(id, '   '), /AGENT_REPLY_INVALID/);
  });
});
