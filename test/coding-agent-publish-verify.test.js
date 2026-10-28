// Regression tests for the V3.0 Python acceptance failure (session bb02c85e,
// 2026-10-28): the first push was refused (HTTP 403), the handler turned the
// failure into a structured tool error that the Tool Broker audited as
// "succeeded", and after the credential was fixed the resumed session replayed
// that ledger row as a successful push. The controller logged "Pushed …",
// stored a pushedHead that never reached GitHub and then failed to open the
// pull request with HTTP 422 because the head branch did not exist.
//
// The controller must prove every external effect against the remote itself:
// a replayed ledger row is never evidence that a push or a pull request exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox } from '../src/coding-agent/sandbox.js';
import { GitHubClient } from '../src/coding-agent/github.js';
import { CodingWorker } from '../src/coding-agent/runtime.js';
import {
  REPOSITORY, WORKSPACE_ID, createFixtureRepo, fakeApis, localRuntime,
} from '../testing/fixtures/coding-agent-harness.js';

const gitDir = (dir, ...args) => execFileSync('git', [`--git-dir=${dir}`, ...args], { stdio: 'pipe' }).toString().trim();
const remoteHead = (bare, branch) => {
  try { return gitDir(bare, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`); } catch { return null; }
};

let callCounter = 0;
const call = (name, args) => ({ type: 'tool_call', id: `verify_${callCounter++}`, name, arguments: args });
const reply = (blocks) => ({
  message: { role: 'assistant', content: blocks },
  stopReason: 'tool_calls',
  usage: { inputTokens: 1000, outputTokens: 50, costUsd: 0 },
  requestId: null, rateLimit: null, durationMs: 5,
});

function scriptedFixer() {
  return {
    async turn({ messages }) {
      const calls = messages.flatMap((message) => message.content.filter((block) => block.type === 'tool_call'));
      const has = (name) => calls.some((entry) => entry.name === name);
      if (!has('update_plan')) return reply([call('update_plan', { steps: [{ title: 'Fix add()', status: 'in_progress' }], next_action: 'Edit src/math.js' })]);
      if (!has('edit_file')) return reply([call('edit_file', { path: 'src/math.js', old_text: 'return a - b;', new_text: 'return a + b;' })]);
      if (!has('run_command')) return reply([call('run_command', { command: 'npm test' })]);
      return reply([call('finish', { summary: 'Fixed add(); tests pass.', tests_run: 'npm test' })]);
    },
  };
}

function pool() {
  return [{
    id: 'anthropic:claude-opus-5', provider: 'anthropic', model: 'claude-opus-5', billingClass: 'paid', qualityTier: 5, costTier: 4,
    secretRef: 'env://ANTHROPIC_API_KEY', toolCalling: true, contextWindow: 200_000, privacyApproved: true, unavailableReasons: [],
    pricing: { inputPerMillion: 1, outputPerMillion: 1 }, protocolClient: scriptedFixer(),
  }];
}

// A pre-receive hook stands in for GitHub refusing the credential (HTTP 403).
function denyPushes(bare) {
  const hook = join(bare, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho "Permission to FahadTrail/demo-app.git denied to fahad-office-bot." >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  return () => rmSync(hook, { force: true });
}

async function blockedThenResumed(t, { corruptState = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fahad-publish-verify-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { bare } = createFixtureRepo(root);
  const allowPushes = denyPushes(bare);
  const apis = fakeApis({ bare });
  const { runtime, sessionStore, auditStore } = localRuntime({ root, storePath: join(root, 'state.json'), pool: pool(), fetchFn: apis.fetchFn });
  const created = await sessionStore.createSession({
    workspaceId: WORKSPACE_ID, title: 'Fix add() bug', repository: REPOSITORY,
    objective: 'The add() function returns wrong results. Fix it, keep tests green.',
    config: {
      testCommand: 'npm test', publish: 'pull_request', waitForCi: false, deploy: { mode: 'none' }, verify: {},
      supabase: { projects: [] }, githubApiBase: 'https://api.github.test', routing: { strategy: 'balanced' },
      fetchUrl: bare, pushUrl: bare,
    },
  });
  const worker = new CodingWorker({ runtime, sessionStore });

  const first = await worker.runOnce();
  assert.equal(first.status, 'blocked', 'a refused push blocks the session');
  let session = await sessionStore.getSession(created.id);
  assert.equal(session.phase, 'publish');
  assert.ok(!session.state.git.pushedHead, 'a refused push never records a pushed head');
  assert.equal(remoteHead(bare, session.workBranch), null, 'the branch is not on the remote');
  assert.match(session.blocker, /push/i);
  assert.equal(apis.state.pulls.length, 0);

  if (corruptState) {
    // A session already damaged by the old replay bug (production session
    // bb02c85e): its state claims a pushedHead the remote never received.
    const falseHead = session.state.git.head;
    sessionStore.data.sessions[created.id].state.git.pushedHead = falseHead;
    const latest = sessionStore.data.checkpoints[created.id].filter((entry) => entry.transcript).at(-1);
    latest.state.git.pushedHead = falseHead;
    sessionStore.persist();
  }

  // The owner fixes the credential and resumes the same session.
  allowPushes();
  await sessionStore.resume(created.id);
  const second = await worker.runOnce();
  assert.equal(second.status, 'completed', second.blocker);
  session = await sessionStore.getSession(created.id);

  const pushed = remoteHead(bare, session.workBranch);
  assert.ok(pushed, 'the work branch really exists on the remote');
  assert.equal(pushed, session.state.git.pushedHead, 'the recorded pushed head is the remote head');
  assert.equal(apis.state.pulls.length, 1, 'exactly one pull request');
  assert.equal(apis.state.pulls[0].head.sha, pushed, 'the pull request is on the verified head');
  assert.ok(!apis.state.rejectedPulls, 'no pull request was attempted for a branch missing from the remote');
  assert.equal(session.state.pr.number, 1);

  const events = await sessionStore.listEvents(created.id);
  const pushedEvents = events.filter((event) => event.type === 'github' && /^Pushed /.test(event.message));
  assert.equal(pushedEvents.length, 1, 'a push is announced only once, after it was verified');
  assert.match(pushedEvents[0].message, /verified/i);
  assert.equal(events.filter((event) => event.type === 'tool_call' && event.message === 'edit_file').length, 0);
  // No completed work was redone: the fix was edited exactly once.
  const edits = auditStore.rows().filter((row) => row.tool === 'repo.edit');
  assert.equal(edits.length, 1, 'the resumed session did not repeat the completed code change');
  return { session, events };
}

test('a refused push is never replayed as success after the session resumes', { timeout: 120_000 }, async (t) => {
  await blockedThenResumed(t);
});

test('a session whose stored pushedHead never reached the remote is repaired on resume', { timeout: 120_000 }, async (t) => {
  const { events } = await blockedThenResumed(t, { corruptState: true });
  assert.ok(events.some((event) => /not on GitHub|was not found on the remote/i.test(event.message)), 'the false pushed state is reported, not hidden');
});

test('publishBranch verifies the remote head and is idempotent when the branch is already published', { timeout: 60_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fahad-publish-idem-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { bare } = createFixtureRepo(root);
  const sandbox = new Sandbox({ root: join(root, 'sandboxes'), sessionId: randomUUID(), mode: 'unisolated' });
  await sandbox.prepare({ repository: REPOSITORY, baseBranch: 'main', workBranch: 'fahad/idem', fetchUrl: bare });
  await sandbox.writeFile('src/math.js', 'export function add(a, b) {\n  return a + b;\n}\n');
  const { head } = await sandbox.commitAll('fix');
  const publish = (previousHead = null) => sandbox.publishBranch({ repository: REPOSITORY, branch: 'fahad/idem', token: null, pushUrl: bare, expectedHead: head, previousHead });

  const first = await publish();
  assert.deepEqual([first.head, first.remoteHead, first.verified, first.alreadyPublished], [head, head, true, false]);
  // A restart lost the pushed state: the same push is a verified no-op, never
  // a lease failure and never a second push.
  const again = await publish();
  assert.deepEqual([again.remoteHead, again.verified, again.alreadyPublished], [head, true, true]);
  assert.equal(remoteHead(bare, 'fahad/idem'), head);

  // A refused push surfaces a classified, actionable error.
  const allow = denyPushes(bare);
  await sandbox.writeFile('README.md', 'more\n');
  const next = await sandbox.commitAll('more');
  await assert.rejects(
    () => sandbox.publishBranch({ repository: REPOSITORY, branch: 'fahad/idem', token: null, pushUrl: bare, expectedHead: next.head, previousHead: head }),
    (error) => error.code === 'PUSH_FORBIDDEN' && /permission|credential/i.test(error.message),
  );
  assert.equal(remoteHead(bare, 'fahad/idem'), head, 'the refused push left the remote unchanged');
  allow();
});

test('pull request creation refuses a missing or mismatched head instead of a 422, and never duplicates', async () => {
  const branches = new Map();
  const pulls = [];
  const posts = [];
  const fetchFn = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const path = url.pathname.replace(`/repos/${REPOSITORY}`, '');
    const branch = path.match(/^\/branches\/(.+)$/);
    if (branch) {
      const sha = branches.get(decodeURIComponent(branch[1]));
      return sha ? json({ commit: { sha } }) : json({ message: 'Branch not found' }, 404);
    }
    if (path === '/pulls' && method === 'GET') return json(pulls.filter((pull) => `FahadTrail:${pull.head.ref}` === url.searchParams.get('head')));
    if (path === '/pulls' && method === 'POST') {
      const body = JSON.parse(init.body);
      posts.push(body);
      if (!branches.has(body.head)) return json({ message: 'Validation Failed', errors: [{ field: 'head', code: 'invalid' }] }, 422);
      const pull = { number: pulls.length + 1, html_url: 'https://github.test/pull/1', state: 'open', head: { ref: body.head, sha: branches.get(body.head) }, base: { ref: body.base } };
      pulls.push(pull);
      return json(pull, 201);
    }
    return json({ message: 'Not Found' }, 404);
  };
  const github = new GitHubClient({ token: 't', repository: REPOSITORY, fetchFn, apiBase: 'https://api.github.test', env: {} });
  const sha = 'a'.repeat(40);
  const args = { branch: 'fahad/x', base: 'main', title: 'T', body: 'B', head: sha };

  await assert.rejects(() => github.createPullRequest(args), (error) => error.code === 'REMOTE_BRANCH_MISSING');
  assert.equal(posts.length, 0, 'no POST is sent for a branch that is not on GitHub');

  branches.set('fahad/x', 'b'.repeat(40));
  await assert.rejects(() => github.createPullRequest(args), (error) => error.code === 'REMOTE_HEAD_MISMATCH');
  assert.equal(posts.length, 0);

  branches.set('fahad/x', sha);
  const created = await github.createPullRequest(args);
  assert.deepEqual([created.number, created.reused, created.headSha], [1, false, sha]);
  const reused = await github.createPullRequest(args);
  assert.deepEqual([reused.number, reused.reused], [1, true]);
  assert.equal(posts.length, 1, 'a second request reuses the open pull request');
});

test('publish blockers read as the real cause and next action in the Hub', async () => {
  const { humanError } = await import('../src/hub-ui/humanize.js');
  const blocker = 'Could not complete the push: PUSH_FORBIDDEN: GitHub refused the push to FahadTrail/x (HTTP 403): …';
  assert.match(humanError(blocker, 'en'), /HTTP 403[\s\S]*write access[\s\S]*resume/);
  assert.match(humanError(blocker, 'ar'), /403/);
  assert.match(humanError('Could not complete the pull request: REMOTE_BRANCH_MISSING: Branch x was not found', 'en'), /not on GitHub yet/);
  // A 401 push is about the agent's GitHub credential, not the owner's sign-in.
  assert.doesNotMatch(humanError('PUSH_UNAUTHORIZED: GitHub rejected the Coding Agent credential (HTTP 401)', 'en'), /sign in/i);
});
