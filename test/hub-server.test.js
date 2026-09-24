import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHubServer, readJobSnapshot } from '../src/hub-server.js';

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
  };
  return { from(name) { return new Query(tables[name] || []); } };
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
  await new Promise((resolve) => server.close(resolve));
});
