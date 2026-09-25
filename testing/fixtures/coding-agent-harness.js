// Deterministic harness for Coding Agent end-to-end tests.
//
// What is REAL here: the controller loop, durable session store (file-backed),
// Tool Broker + workspace policy + audit, sandbox filesystem operations, shell
// commands (`npm test` running `node --test`), git commits, bundles and pushes
// to a local bare repository, provider-neutral transcripts, checkpoints,
// provider-state cooldowns and turn-level failover.
//
// What is SIMULATED: the two "models" are scripted state machines (not LLMs)
// that decide their next tool call from the transcript, and GitHub, Supabase
// and the production health endpoint are in-process fake HTTP APIs. The
// scripted "primary" deliberately fails with HTTP 429 to force a handoff.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryAgentSessionStore } from '../../src/agent-state/session-store.js';
import { LocalPolicyStore, LocalToolAuditStore } from '../../src/agent-state/local-stores.js';
import { MemoryProviderStateStore } from '../../src/model-gateway/agentic/provider-state.js';
import { createCodingRuntime } from '../../src/coding-agent/runtime.js';

export const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
export const SUPABASE_REF = 'abcdefghijklmnopqrst';
export const REPOSITORY = 'FahadTrail/demo-app';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args], { cwd, stdio: 'pipe' }).toString().trim();

export function createFixtureRepo(root) {
  const work = join(root, 'fixture-src');
  const bare = join(root, 'origin.git');
  mkdirSync(join(work, 'src'), { recursive: true });
  mkdirSync(join(work, 'test'), { recursive: true });
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'demo-app', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
  // The bug the agent must find: add() subtracts.
  writeFileSync(join(work, 'src', 'math.js'), 'export function add(a, b) {\n  return a - b;\n}\n');
  writeFileSync(join(work, 'test', 'math.test.js'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n\ntest('add sums numbers', () => {\n  assert.equal(add(2, 3), 5);\n});\n");
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'initial');
  execFileSync('git', ['clone', '-q', '--bare', work, bare]);
  return { bare, baseHead: git(work, 'rev-parse', 'HEAD') };
}

function toolCalls(messages) {
  return messages.flatMap((message) => message.content.filter((block) => block.type === 'tool_call'));
}

function allText(messages) {
  return messages.flatMap((message) => message.content.filter((block) => block.type === 'text').map((block) => block.text)).join('\n');
}

let callCounter = 0;
const call = (name, args) => ({ type: 'tool_call', id: `call_${Date.now().toString(36)}_${callCounter++}`, name, arguments: args });

function reply(blocks, text = null) {
  return {
    message: { role: 'assistant', content: [...(text ? [{ type: 'text', text }] : []), ...blocks] },
    stopReason: 'tool_calls',
    usage: { inputTokens: 1200, outputTokens: 80, costUsd: 0.0021 },
    requestId: null,
    rateLimit: null,
    durationMs: 5,
  };
}

// Scripted primary: investigates, fixes the bug, then hits a rate limit.
export function scriptedPrimary({ pauseFile = null, log = [] } = {}) {
  return {
    async turn({ messages }) {
      const calls = toolCalls(messages);
      const has = (name) => calls.some((entry) => entry.name === name);
      log.push({ provider: 'primary', calls: calls.length });
      if (!has('list_files')) return reply([call('list_files', {})], 'Inspecting the repository.');
      if (!has('read_file')) return reply([call('read_file', { path: 'src/math.js' }), call('read_file', { path: 'test/math.test.js' })]);
      if (!has('update_plan')) {
        return reply([call('update_plan', {
          steps: [{ title: 'Reproduce the failing test', status: 'in_progress' }, { title: 'Fix add()', status: 'pending' }, { title: 'Re-run tests and finish', status: 'pending' }],
          next_action: 'Run the test suite to reproduce the failure',
        })]);
      }
      if (!has('run_command')) {
        if (pauseFile && existsSync(pauseFile)) await new Promise((resolve) => setTimeout(resolve, 60_000));
        return reply([call('run_command', { command: 'npm test' })]);
      }
      if (!has('record_note')) return reply([call('record_note', { note: 'Root cause: add() in src/math.js subtracts instead of adding.' })]);
      if (!has('edit_file')) return reply([call('edit_file', { path: 'src/math.js', old_text: 'return a - b;', new_text: 'return a + b;' })]);
      const error = new Error('rate limited');
      Object.assign(error, { status: 429, type: 'rate_limit_error', retryAfter: '900' });
      throw error;
    },
  };
}

// Scripted backup: must receive a continuation (not the original prompt) and
// continues from the saved state; later fixes a controlled CI failure.
export function scriptedBackup({ log = [] } = {}) {
  return {
    async turn({ messages }) {
      const first = allText([messages[0]]);
      if (!/CONTINUATION OF AN IN-PROGRESS TASK/.test(first) || !/src\/math\.js/.test(first) || !/Root cause: add\(\)/.test(first)) {
        throw Object.assign(new Error('backup did not receive the durable continuation'), { status: 400, type: 'invalid_request' });
      }
      log.push({ provider: 'backup', continuation: true });
      const calls = toolCalls(messages);
      const count = (name) => calls.filter((entry) => entry.name === name).length;
      const ciFailed = /CI FAILED/.test(allText(messages));
      if (count('finish') === 0) {
        if (count('run_command') === 0) return reply([call('run_command', { command: 'npm test' })], 'Continuing from the checkpoint: verifying the fix.');
        if (count('supabase_query') === 0) return reply([call('supabase_query', { project_ref: SUPABASE_REF, sql: 'select 1 as ok' })]);
        return reply([call('finish', { summary: 'Fixed add() to sum its arguments; tests pass.', tests_run: 'npm test' })]);
      }
      if (ciFailed && count('write_file') === 0) {
        return reply([call('write_file', { path: 'docs/math.md', content: '# math\n\n`add(a, b)` returns the sum of two numbers.\n' })], 'CI requires documentation.');
      }
      if (ciFailed && count('run_command') < 2) return reply([call('run_command', { command: 'npm test' })]);
      return reply([call('finish', { summary: 'Fixed add() and added docs/math.md required by CI.', tests_run: 'npm test' })]);
    },
  };
}

export function scriptedPool({ pauseFile = null, log = [] } = {}) {
  const common = { toolCalling: true, contextWindow: 200_000, privacyApproved: true, unavailableReasons: [], pricing: { inputPerMillion: 1, outputPerMillion: 1 } };
  return [
    { ...common, id: 'anthropic:claude-opus-5', provider: 'anthropic', model: 'claude-opus-5', billingClass: 'paid', qualityTier: 5, costTier: 4,
      secretRef: 'env://ANTHROPIC_API_KEY', protocolClient: scriptedPrimary({ pauseFile, log }) },
    { ...common, id: 'deepseek:deepseek-flash', provider: 'deepseek', model: 'deepseek-flash', billingClass: 'paid', qualityTier: 4, costTier: 1,
      secretRef: 'env://DEEPSEEK_API_KEY', protocolClient: scriptedBackup({ log }) },
  ];
}

// In-process fake of the GitHub, Supabase Management and health APIs.
export function fakeApis({ bare }) {
  const state = { pulls: [], ciSeen: [], merged: null, requests: [] };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchFn = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    state.requests.push(`${method} ${url.host}${url.pathname}`);
    if (url.host === 'api.github.test') {
      const path = url.pathname.replace(`/repos/${REPOSITORY}`, '');
      if (path === '/pulls' && method === 'GET') return json(state.pulls.filter((pull) => pull.head.ref === url.searchParams.get('head').split(':')[1]));
      if (path === '/pulls' && method === 'POST') {
        const body = JSON.parse(init.body);
        const head = execFileSync('git', ['--git-dir', bare, 'rev-parse', `refs/heads/${body.head}`]).toString().trim();
        const pull = { number: state.pulls.length + 1, html_url: `https://github.test/${REPOSITORY}/pull/${state.pulls.length + 1}`, state: 'open', head: { ref: body.head, sha: head }, base: { ref: body.base }, title: body.title };
        state.pulls.push(pull);
        return json(pull, 201);
      }
      const checkRuns = path.match(/^\/commits\/([0-9a-f]{40})\/check-runs$/);
      if (checkRuns) {
        const sha = checkRuns[1];
        if (!state.ciSeen.includes(sha)) state.ciSeen.push(sha);
        const failing = state.ciSeen.indexOf(sha) === 0;
        return json({ check_runs: [
          { id: 101, name: 'unit-tests', status: 'completed', conclusion: 'success', html_url: 'https://github.test/run/101' },
          { id: failing ? 202 : 203, name: 'docs-check', status: 'completed', conclusion: failing ? 'failure' : 'success', html_url: 'https://github.test/run/202' },
        ] });
      }
      if (/^\/commits\/[0-9a-f]{40}\/status$/.test(path)) return json({ statuses: [] });
      if (path === '/actions/jobs/202/logs') return new Response('2026-09-25T00:00:00.000Z docs-check: ERROR docs/math.md is missing; every public module needs documentation\n', { status: 200 });
      const merge = path.match(/^\/pulls\/(\d+)\/merge$/);
      if (merge && method === 'PUT') {
        const body = JSON.parse(init.body);
        state.merged = { number: Number(merge[1]), sha: body.sha };
        return json({ merged: true, sha: body.sha });
      }
      if (/^\/actions\/workflows\/deploy\.yml\/runs$/.test(path)) {
        return json({ workflow_runs: state.merged ? [{ id: 9, status: 'completed', conclusion: 'success', html_url: 'https://github.test/deploy/9', created_at: new Date().toISOString() }] : [] });
      }
      return json({ message: `Not Found ${path}` }, 404);
    }
    if (url.host === 'api.supabase.test') {
      state.supabaseQuery = JSON.parse(init.body).query;
      return json([{ rows: [{ ok: 1 }] }], 201);
    }
    if (url.host === 'office.example.test' && url.pathname === '/healthz') {
      return json({ ok: true, version: state.merged ? state.merged.sha.slice(0, 7) : 'old' });
    }
    return json({ message: 'unexpected host' }, 599);
  };
  return { state, fetchFn };
}

export const SESSION_CONFIG = {
  testCommand: 'npm test',
  publish: 'pull_request',
  deploy: { mode: 'merge', workflow: 'deploy.yml' },
  verify: { url: 'https://office.example.test/healthz', hosts: ['office.example.test'], expectShaField: 'version' },
  supabase: { projects: [SUPABASE_REF] },
  githubApiBase: 'https://api.github.test',
  supabaseApiBase: 'https://api.supabase.test',
  // The scripted scenario starts on the premium route and fails over to the
  // economy route; the workspace default (economy) would start on the latter.
  routing: { strategy: 'balanced' },
};

export const FAST_LIMITS = { ciPollMs: 1, deployPollMs: 1, verifyDelayMs: 1, leaseRenewMs: 60_000 };

export function localRuntime({
  root, storePath, pool, fetchFn, workerLog = () => {}, sandboxMode = 'unisolated',
  now = undefined, sleepFn = async () => {}, providerStateStore = new MemoryProviderStateStore(),
}) {
  const sessionStore = new MemoryAgentSessionStore({ persistPath: storePath });
  const policyStore = new LocalPolicyStore({
    workspaceId: WORKSPACE_ID,
    providers: [
      { provider: 'anthropic', models: ['claude-opus-5'], secretRef: 'env://ANTHROPIC_API_KEY', enabled: true },
      { provider: 'deepseek', models: ['deepseek-flash'], secretRef: 'env://DEEPSEEK_API_KEY', enabled: true },
    ],
  });
  const auditStore = new LocalToolAuditStore();
  const attempts = [];
  const runtime = createCodingRuntime({
    env: { ...process.env, CODING_GITHUB_TOKEN: 'test-github-token-0001', CODING_SUPABASE_ACCESS_TOKEN: 'test-supabase-token-0001' },
    sessionStore, providerStateStore, policyStore, auditStore, pool, fetchFn,
    sandboxRoot: join(root, 'sandboxes'), sandboxMode, limits: FAST_LIMITS,
    modelAttemptSink: async (session, attempt) => { attempts.push({ route: attempt.route.id, status: attempt.status, error: attempt.error?.code || null }); },
    log: workerLog, sleepFn, now,
  });
  return { runtime, sessionStore, policyStore, auditStore, providerStateStore, attempts };
}
