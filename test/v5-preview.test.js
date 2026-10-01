// The private V5 demo preview: the fictional scenario shows every
// representative state through the REAL Hub handlers, and the static
// preview can never write anywhere.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createHubServer } from '../src/hub-server.js';
import { memoryPostgrest } from '../testing/fixtures/memory-postgrest.js';
import { demoTables } from '../testing/fixtures/v5-demo-data.js';
import { presentationState } from '../src/hub-ui/office-presentation.js';

async function officeFor(moment) {
  const now = Date.now();
  const db = memoryPostgrest(demoTables(now, moment), { rpc: { model_usage_summary: () => ({ data: [], error: null }) } });
  const server = createHubServer({ db, store: {}, host: '127.0.0.1', port: 0, accessToken: '', authEnabled: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { workspaces } = await (await fetch(`${base}/api/workspaces`)).json();
    const workspaceId = workspaces.find((workspace) => workspace.name === 'Qahwa Run').id;
    const office = await (await fetch(`${base}/api/office?workspaceId=${workspaceId}`)).json();
    const { artifacts } = await (await fetch(`${base}/api/artifacts?workspaceId=${workspaceId}&limit=60`)).json();
    return { office, artifacts, now };
  } finally { server.close(); }
}

test('demo "work" moment shows every representative state from real handlers', async () => {
  const { office, artifacts, now } = await officeFor('work');
  const state = Object.fromEntries(office.agents.map((agent) => [agent.key, agent.state]));
  assert.equal(office.agents.length, 9);
  assert.equal(state.chief, 'THINKING');
  assert.equal(state.coding, 'TESTING');
  assert.equal(state.creative, 'WORKING');
  assert.equal(state.finance, 'COMPLETED');
  assert.equal(state.research, 'AVAILABLE');
  assert.equal(state.social, 'WAITING');
  assert.equal(office.coding.ci, 'pending');
  const view = presentationState({ office, artifacts, now });
  assert.equal(view.artifacts.finance.type, 'financial_model');
  assert.equal(view.artifacts.finance.data.validation.state, 'VERIFIED');
  assert.equal(view.artifacts.creative.type, 'moodboard');
  assert.ok(view.handoffs.some((handoff) => handoff.fresh) && view.handoffs.some((handoff) => !handoff.fresh));
  assert.ok(view.projects.some((project) => project.team.length >= 5));
});

test('demo "needs" moment: CI passed, CODING needs Fahad, CREATIVE hands off to SOCIAL', async () => {
  const { office, artifacts, now } = await officeFor('needs');
  const state = Object.fromEntries(office.agents.map((agent) => [agent.key, agent.state]));
  assert.equal(state.coding, 'NEEDS FAHAD');
  assert.equal(state.creative, 'COMPLETED');
  assert.equal(state.social, 'WORKING');
  assert.equal(office.needsFahad, 1);
  assert.equal(office.coding.ci, 'success');
  const view = presentationState({ office, artifacts, now });
  assert.ok(view.handoffs.some((handoff) => handoff.fromKey === 'creative' && handoff.toKey === 'social' && handoff.fresh));
});

test('the preview shim refuses every write and never names a production host', () => {
  const shim = readFileSync(new URL('../tools/v5-preview-shim.js', import.meta.url), 'utf8');
  assert.match(shim, /if \(method !== 'GET'\) return json\(\{ ok: false, error: WRITE_REFUSED \}, 403\)/);
  assert.match(shim, /Available in production after V5 approval\./);
  assert.match(shim, /DEMO DATA/);
  assert.doesNotMatch(shim, /supabase|trimedia|telegram|api\.github\.com/i);
  const build = readFileSync(new URL('../tools/v5-preview-build.mjs', import.meta.url), 'utf8');
  assert.match(build, /authEnabled: false/);
  assert.doesNotMatch(build, /SUPABASE_|process\.env/);
});

test('timeline: CI still running reads "running", never "failed"', async () => {
  const { timelineView } = await import('../src/hub-office-live.js');
  const at = new Date().toISOString();
  const session = (state) => ({ id: 's1', title: 'API', created_at: at, updated_at: at, status: 'running', result: { ci: { state, checkedAt: at } } });
  const ci = (state) => timelineView({ sessions: [session(state)] }).find((entry) => entry.kind === 'ci');
  assert.deepEqual([ci('pending').text, ci('pending').status], ['CI running for API', 'working']);
  assert.deepEqual([ci('success').text, ci('success').status], ['CI passed for API', 'done']);
  assert.deepEqual([ci('failure').text, ci('failure').status], ['CI failed for API', 'failed']);
});
