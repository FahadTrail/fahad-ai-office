import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Script } from 'node:vm';
import { createHubServer, HUB_HTML, modelCatalog, readJobSnapshot, usageSnapshot } from '../src/hub-server.js';

const workspaceId = '2ae856da-00cb-4594-a7e6-710f2011d0c3';
const jobId = 'fdd024d0-8f3f-4b85-9900-1c1b55dc620a';

function fakeDb() {
  const tables = {
    projects: [{ id: workspaceId, name: 'Fahad AI Office' }],
    workspace_policies: [{ workspace_id: workspaceId, enabled: true, monthly_budget_usd: 2, max_request_budget_usd: .1, spent_usd: .2, reserved_usd: 0, budget_period_end: '2026-10-01T00:00:00.000Z' }],
    jobs: [{ id: jobId, title: 'Ship Hub', goal: 'Ship the Hub', status: 'running', priority: 'normal', project_id: workspaceId, tokens_used: 5, cost_usd: .01, created_at: '2026-09-24T00:00:00.000Z', updated_at: '2026-09-24T00:00:00.000Z' }],
    tasks: [{ id: '11111111-1111-4111-8111-111111111111', job_id: jobId, title: 'Chief planning', status: 'running', progress: 40, attempts: 1, max_attempts: 3, agent_id: '22222222-2222-4222-8222-222222222222', sequence: 10, started_at: null, created_at: '2026-09-24T00:00:00.000Z' }],
    agents: [{ id: '22222222-2222-4222-8222-222222222222', slug: 'chief-of-staff', name: 'Chief of Staff' }],
    events: [{ id: 'event-1', job_id: jobId, type: 'status_changed', level: 'info', message: 'Chief started', payload: { provider: 'anthropic', token: 'do-not-return' }, task_id: null, run_id: null, agent_id: null, created_at: '2026-09-24T00:00:01.000Z' }],
    model_attempts: [], tool_executions: [], runs: [], results: [],
    workspace_provider_permissions: [
      { workspace_id: workspaceId, provider: 'anthropic', models: ['claude-sonnet-5'], enabled: true },
      { workspace_id: workspaceId, provider: 'deepseek', models: ['deepseek-flash'], enabled: true },
    ],
  };
  return { _tables: tables, from(name) { return new Query(tables[name] || []); } };
}

class Query {
  constructor(rows) { this.rows = rows; this.filters = []; this.singleMode = false; this.maybe = false; }
  select() { return this; }
  eq(key, value) { this.filters.push((row) => row[key] === value); return this; }
  in(key, values) { this.filters.push((row) => values.includes(row[key])); return this; }
  order() { return this; }
  limit(value) { this.rows = this.rows.slice(0, value); return this; }
  single() { this.singleMode = true; return this; }
  maybeSingle() { this.maybe = true; return this; }
  then(resolve, reject) { try { const rows = this.rows.filter((row) => this.filters.every((filter) => filter(row))); const data = this.singleMode ? rows[0] : this.maybe ? (rows[0] || null) : rows; resolve({ data, error: null }); } catch (error) { reject(error); } }
}

test('Hub snapshot exposes workspace lineage and safe operational state', async () => {
  const snapshot = await readJobSnapshot(fakeDb(), jobId);
  assert.equal(snapshot.workspace.name, 'Fahad AI Office');
  assert.equal(snapshot.tasks[0].agent.name, 'Chief of Staff');
  assert.equal(snapshot.events[0].payload.token, undefined);
  assert.equal(snapshot.job.project_id, undefined);
});

test('Hub API lists workspaces and creates a workspace-scoped job', async () => {
  const db = fakeDb();
  const jobs = [];
  const store = { createJob: async (input) => { jobs.push(input); return { id: jobId, title: input.title, goal: input.goal, status: 'planning' }; } };
  const server = createHubServer({ db, store, port: 0 });
  await once(server, 'listening');
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const workspaces = await fetch(`${base}/api/workspaces`).then((response) => response.json());
  assert.deepEqual(workspaces.workspaces, [{ id: workspaceId, name: 'Fahad AI Office' }]);
  const created = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId, goal: 'Build the Hub MVP' }) }).then((response) => response.json());
  assert.equal(created.job.workspaceId, workspaceId);
  assert.equal(jobs[0].projectId, workspaceId);
  assert.equal(jobs[0].requestedProvider, 'auto');
  const preferred = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId, goal: 'Plan an answer', provider: 'anthropic' }) }).then((response) => response.json());
  assert.equal(preferred.ok, true);
  assert.equal(jobs[1].requestedProvider, 'anthropic');
  const denied = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId, goal: 'Plan an answer', provider: 'qwen' }) });
  assert.equal(denied.status, 403);
  assert.equal(jobs.length, 2);
  await new Promise((resolve) => server.close(resolve));
});

test('Hub model catalog keeps inactive providers non-selectable', () => {
  const catalog = modelCatalog();
  assert.equal(catalog.find((entry) => entry.provider === 'anthropic').default, true);
  assert.equal(catalog.find((entry) => entry.provider === 'qwen').selectable, false);
  assert.equal(catalog.find((entry) => entry.provider === 'qwen').state, 'not_connected');
  assert.equal(modelCatalog([{ provider: 'anthropic', models: ['claude-sonnet-5'], enabled: true }]).find((entry) => entry.provider === 'deepseek').selectable, false);
});

test('every Hub browser script parses and sends the selected authorized provider', () => {
  const scripts = [...HUB_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 2);
  for (const [, body] of scripts) new Script(body);
  assert.match(HUB_HTML, /provider:document\.getElementById\('modelSelect'\)\?\.value\|\|'auto'/);
  assert.match(HUB_HTML, /hub-workspace-changed/);
  assert.match(HUB_HTML, /id="projectPrompt"/);
  assert.match(HUB_HTML, /id="projectName"/);
  assert.doesNotMatch(HUB_HTML, /window\.prompt\(/);
  assert.match(HUB_HTML, /if\(final\)addBubble\(final,'office'\)/);
});

test('Hub usage snapshot aggregates attempts and workspace budget without sensitive payloads', async () => {
  const db = fakeDb();
  db._tables.model_attempts.push(
    { workspace_id: workspaceId, provider: 'anthropic', model: 'claude-sonnet-5', status: 'succeeded', input_tokens: 10, output_tokens: 20, reasoning_tokens: 0, cached_input_tokens: 0, cost_usd: .02, started_at: '2026-09-24T00:00:00.000Z' },
    { workspace_id: workspaceId, provider: 'deepseek', model: 'deepseek-flash', status: 'failed', input_tokens: 5, output_tokens: 0, reasoning_tokens: 0, cached_input_tokens: 0, cost_usd: .01, started_at: '2026-09-24T00:00:00.000Z' },
  );
  const usage = await usageSnapshot(db, workspaceId, new Date('2026-09-24T12:00:00.000Z'));
  assert.equal(usage.totals.tokens, 35);
  assert.equal(usage.totals.monthUsd, .03);
  assert.equal(usage.budget.remainingUsd, 1.8);
});

test('usage reconstructs historical fallback from model attempts without double counting audited switches', async () => {
  const db = fakeDb();
  const runId = '33333333-3333-4333-8333-333333333333';
  db._tables.model_attempts.push(
    { workspace_id: workspaceId, run_id: runId, provider: 'anthropic', status: 'failed', cost_usd: 0, started_at: '2026-09-24T00:00:00.000Z' },
    { workspace_id: workspaceId, run_id: runId, provider: 'deepseek', status: 'succeeded', cost_usd: 0.001, started_at: '2026-09-24T00:00:01.000Z' },
  );
  db._tables.events.push({ job_id: jobId, run_id: runId, type: 'activity', payload: { kind: 'provider_switch' } });
  const usage = await usageSnapshot(db, workspaceId);
  assert.equal(usage.fallbacks, 1);
});

test('Hub counts only completed provider-native tool executions', async () => {
  const db = fakeDb();
  db._tables.events.push(
    { id: 'tool-start', job_id: jobId, type: 'activity', payload: { kind: 'host_tool', tool: 'WebFetch', status: 'started' }, created_at: '2026-09-24T00:00:02.000Z' },
    { id: 'tool-done', job_id: jobId, type: 'activity', payload: { kind: 'host_tool', tool: 'WebFetch', status: 'succeeded', duration_ms: 25 }, created_at: '2026-09-24T00:00:03.000Z' },
  );
  const snapshot = await readJobSnapshot(db, jobId);
  assert.equal(snapshot.toolExecutions.length, 1);
  assert.equal(snapshot.toolExecutions[0].tool_name, 'WebFetch');
  assert.equal(snapshot.toolExecutions[0].status, 'succeeded');
});

test('owner OTP session gates the Hub API without exposing the service key', async () => {
  const db = fakeDb();
  const calls = [];
  db.auth = {
    signInWithOtp: async (input) => { calls.push(['send', input]); return { error: null }; },
    verifyOtp: async () => ({ error: null, data: { user: { email: 'owner@example.com' }, session: { access_token: 'session-token' } } }),
    getUser: async (token) => token === 'session-token' ? { error: null, data: { user: { email: 'owner@example.com' } } } : { error: new Error('invalid'), data: null },
  };
  const store = { createJob: async () => ({ id: jobId, title: 'Task', goal: 'Task', status: 'planning' }) };
  const server = createHubServer({ db, store, port: 0, authEnabled: true, ownerEmail: 'owner@example.com' });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const denied = await fetch(`${base}/api/workspaces`).then((response) => response.json());
  assert.equal(denied.error, 'HUB_UNAUTHORIZED');
  const sent = await fetch(`${base}/api/auth/request-otp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com' }) }).then((response) => response.json());
  assert.equal(sent.ok, true);
  assert.equal(calls[0][1].options.shouldCreateUser, false);
  const verified = await fetch(`${base}/api/auth/verify-otp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', token: '123456' }) });
  assert.equal(verified.status, 200);
  const cookie = verified.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  const workspaces = await fetch(`${base}/api/workspaces`, { headers: { cookie: cookie.split(';')[0] } }).then((response) => response.json());
  assert.equal(workspaces.workspaces[0].name, 'Fahad AI Office');
  await new Promise((resolve) => server.close(resolve));
});


test('Hub shows the complete Chief result before the short job summary', async () => {
  const db = fakeDb();
  db._tables.jobs[0].status = 'completed';
  db._tables.jobs[0].final_summary = 'Short summary';
  db._tables.tasks[0].status = 'done';
  db._tables.results.push({ task_id: db._tables.tasks[0].id, summary: 'Short summary', content: 'Full final answer with source link' });
  const snapshot = await readJobSnapshot(db, jobId);
  assert.equal(snapshot.tasks[0].result.content, 'Full final answer with source link');
  const server = createHubServer({ db, store: { createJob: async () => ({}) }, port: 0 });
  await once(server, 'listening');
  const html = await fetch(`http://127.0.0.1:${server.address().port}/`).then((response) => response.text());
  assert.match(html, /done\?\.result\?\.content\|\|s\.job\.final_summary/);
  await new Promise((resolve) => server.close(resolve));
});


test('OTP verification cannot replace the service-role project session', async () => {
  const db = fakeDb();
  db.auth = {
    verifyOtp: async () => { throw new Error('shared DB auth was used'); },
    getUser: async () => { throw new Error('shared DB auth was used'); },
  };
  const authClient = {
    verifyOtp: async () => ({ error: null, data: { user: { email: 'owner@example.com' }, session: { access_token: 'isolated-session' } } }),
    getUser: async (token) => token === 'isolated-session'
      ? { error: null, data: { user: { email: 'owner@example.com' } } }
      : { error: new Error('invalid'), data: null },
  };
  const server = createHubServer({ db, authClient, store: {}, port: 0, authEnabled: true, ownerEmail: 'owner@example.com' });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const verified = await fetch(`${base}/api/auth/verify-otp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', token: '123456' }) });
  assert.equal(verified.status, 200);
  const cookie = verified.headers.get('set-cookie').split(';')[0];
  const response = await fetch(`${base}/api/workspaces`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).workspaces, [{ id: workspaceId, name: 'Fahad AI Office' }]);
  await new Promise((resolve) => server.close(resolve));
});
