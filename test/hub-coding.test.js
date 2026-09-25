import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Script } from 'node:vm';
import { createHubServer, HUB_HTML } from '../src/hub-server.js';
import { modelPoolSnapshot } from '../src/hub-coding.js';

const workspaceId = '2ae856da-00cb-4594-a7e6-710f2011d0c3';
const sessionId = '5b7a6f0e-3a8f-4a38-9d1d-0a4a4c1b2c3d';

class Query {
  constructor(rows, error = null) { this.rows = rows; this.filters = []; this.maybe = false; this.error = error; }
  select() { return this; }
  eq(key, value) { this.filters.push((row) => row[key] === value); return this; }
  in(key, values) { this.filters.push((row) => values.includes(row[key])); return this; }
  order() { return this; }
  limit() { return this; }
  maybeSingle() { this.maybe = true; return this; }
  then(resolve) {
    if (this.error) return resolve({ data: null, error: this.error });
    const rows = this.rows.filter((row) => this.filters.every((filter) => filter(row)));
    resolve({ data: this.maybe ? rows[0] || null : rows, error: null });
  }
}

function fakeDb({ installed = true } = {}) {
  const missing = { message: 'relation "public.agent_sessions" does not exist', code: '42P01' };
  const tables = {
    projects: [{ id: workspaceId, name: 'Fahad AI Office' }],
    agent_sessions: [{ id: sessionId, workspace_id: workspaceId, job_id: 'j', title: 'Fix bug', objective: 'Fix the parser bug now', repository: 'FahadTrail/fahad-ai-office',
      base_branch: 'main', work_branch: 'fahad/fix', status: 'awaiting_approval', phase: 'deploy', plan: [{ title: 'Fix', status: 'done' }],
      state: { filesChanged: ['src/a.js'], pr: { number: 7, url: 'https://github.com/x/pull/7' }, switches: [{ from: 'anthropic:claude-opus-5', to: 'deepseek:deepseek-flash', reason: 'PROVIDER_RATE_LIMIT' }] },
      config: { deploy: { mode: 'merge' } }, provider_switches: 1, iteration: 9, budget_usd: 5, spent_usd: 0.4, tokens_in: 100, tokens_out: 10,
      current_route: 'deepseek:deepseek-flash', created_at: '2026-09-25T00:00:00Z' }],
    agent_events: [{ id: 1, session_id: sessionId, type: 'provider_switch', level: 'warning', message: 'switched', payload: { from: 'a', token: 'hide-me' }, created_at: '2026-09-25T00:00:01Z' }],
    agent_approvals: [{ id: '9c1f1d4e-1111-4222-8333-444455556666', session_id: sessionId, workspace_id: workspaceId, tool_name: 'github.pr_merge', action: 'merge', risk: 'medium', summary: 'Merge PR #7', status: 'pending', requested_at: '2026-09-25T00:00:02Z' }],
    model_attempts: [],
    provider_status: [
      { provider: 'anthropic', model: 'claude-opus-5', billing_class: 'paid', health: 'rate_limited', cooldown_until: new Date(Date.now() + 3_600_000).toISOString(), rate_limit: { requestsLimit: 50, requestsRemaining: 0 }, requests_total: 4, failures_total: 1, input_tokens_total: 1000, output_tokens_total: 100, cost_usd_total: 0.02, last_error_code: 'PROVIDER_RATE_LIMIT' },
      { provider: 'deepseek', model: 'deepseek-flash', billing_class: 'paid', health: 'healthy', rate_limit: null, requests_total: 2, failures_total: 0, input_tokens_total: 10, output_tokens_total: 1, cost_usd_total: 0.001 },
    ],
  };
  const rpcCalls = [];
  return {
    rpcCalls,
    from(name) { return !installed && /^agent_|provider_status/.test(name) ? new Query([], missing) : new Query(tables[name] || []); },
    async rpc(name, args) {
      rpcCalls.push([name, args]);
      if (!installed) return { data: null, error: { message: 'Could not find the function public.create_coding_session', code: 'PGRST202' } };
      if (name === 'create_coding_session') return { data: [{ ...tables.agent_sessions[0], id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', status: 'queued', title: args.p_title }], error: null };
      if (name === 'decide_agent_approval') return { data: { id: args.p_approval, status: args.p_decision }, error: null };
      return { data: null, error: null };
    },
  };
}

async function withServer(db, fn) {
  const server = createHubServer({ db, store: { createJob: async () => ({}) }, port: 0 });
  await once(server, 'listening');
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('Hub starts a Coding Agent session with validated configuration', async () => {
  const db = fakeDb();
  await withServer(db, async (base) => {
    const response = await fetch(`${base}/api/coding/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      workspaceId, repository: 'FahadTrail/fahad-ai-office', objective: 'Implement the export feature and ship it', budgetUsd: 8, deploy: true,
      verifyUrl: 'https://fahad-ai-office.example.com/healthz', verifyShaField: 'version',
    }) });
    assert.equal(response.status, 201);
    const [name, args] = db.rpcCalls[0];
    assert.equal(name, 'create_coding_session');
    assert.equal(args.p_budget_usd, 8);
    assert.deepEqual(args.p_config.deploy, { mode: 'merge', workflow: 'deploy.yml' });
    assert.deepEqual(args.p_config.verify, { url: 'https://fahad-ai-office.example.com/healthz', hosts: ['fahad-ai-office.example.com'], expectShaField: 'version' });
    const bad = await fetch(`${base}/api/coding/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId, repository: 'not a repo', objective: 'Implement the export feature' }) });
    assert.equal(bad.status, 400);
  });
});

test('Hub session detail shows lifecycle, switches and approvals without sensitive payload keys', async () => {
  await withServer(fakeDb(), async (base) => {
    const detail = await fetch(`${base}/api/coding/sessions/${sessionId}`).then((response) => response.json());
    assert.equal(detail.session.providerSwitches, 1);
    assert.equal(detail.session.pr.number, 7);
    assert.equal(detail.approvals[0].status, 'pending');
    assert.equal(detail.events[0].payload.token, undefined);
    const approvals = await fetch(`${base}/api/approvals?workspaceId=${workspaceId}`).then((response) => response.json());
    assert.equal(approvals.approvals.length, 1);
    const decided = await fetch(`${base}/api/approvals/${approvals.approvals[0].id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approved' }) });
    assert.equal(decided.status, 200);
    const invalid = await fetch(`${base}/api/approvals/${approvals.approvals[0].id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'maybe' }) });
    assert.equal(invalid.status, 400);
  });
});

test('Hub degrades cleanly before the Coding Agent migration is applied', async () => {
  await withServer(fakeDb({ installed: false }), async (base) => {
    const response = await fetch(`${base}/api/coding/sessions?workspaceId=${workspaceId}`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'CODING_AGENT_NOT_INSTALLED');
    const pool = await fetch(`${base}/api/model-pool`);
    assert.equal(pool.status, 200, 'the model pool still renders from configuration');
    const workspaces = await fetch(`${base}/api/workspaces`);
    assert.equal(workspaces.status, 200);
  });
});

test('model pool dashboard never invents quota and explains unavailability', async () => {
  const snapshot = await modelPoolSnapshot({ db: fakeDb(), env: { ANTHROPIC_API_KEY: 'sk-ant-test-key-1234', DEEPSEEK_API_KEY: 'deepseek-test-key-1234' } });
  const byId = Object.fromEntries(snapshot.routes.map((route) => [route.id, route]));
  const opus = byId['anthropic:claude-opus-5'];
  assert.match(opus.availability, /^RATE LIMITED — RETRY AFTER \d{2}:\d{2}:\d{2}$/);
  assert.equal(opus.quotaPercentRemaining, 0, 'provider-reported window is shown as reported');
  assert.equal(opus.usage.costBasis.includes('ESTIMATED'), true);
  const deepseek = byId['deepseek:deepseek-flash'];
  assert.match(deepseek.availability, /PRIVACY REVIEW PENDING/);
  assert.equal(deepseek.quotaPercentRemaining, null);
  const sonnet = byId['anthropic:claude-sonnet-5'];
  assert.equal(sonnet.availability, 'AVAILABLE — EXACT QUOTA UNKNOWN');
  assert.equal(sonnet.routingRank, 1);
  assert.match(byId['gemini:gemini-2.5-flash'].availability, /NOT CONFIGURED — CREDENTIAL_MISSING/);
  assert.equal(byId['openai:gpt-5.3-codex'].enabled, false);
});

test('Hub page includes the Coding Agent UI in parseable scripts and exposes the deployed version', async () => {
  const scripts = [...HUB_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 2);
  for (const [, body] of scripts) new Script(body);
  assert.match(HUB_HTML, /id="codingView"/);
  assert.match(HUB_HTML, /Model pool/);
  assert.match(HUB_HTML, /data-approve/);
  await withServer(fakeDb(), async (base) => {
    const health = await fetch(`${base}/healthz`).then((response) => response.json());
    assert.ok('version' in health);
  });
});
