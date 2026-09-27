import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createHubServer } from '../src/hub-server.js';
import { OfficeStream, handoffView, timelineView } from '../src/hub-office-live.js';
import { memoryPostgrest } from '../testing/fixtures/memory-postgrest.js';
import { PREVIEW_WORKSPACE, previewTables } from '../testing/fixtures/hub-preview-data.js';
import { STATION_ROLES, roleMark, stationArt } from '../src/hub-ui/characters.js';
import { visualState } from '../src/hub-ui/office.js';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const file = (name) => readFileSync(new URL(`../src/hub-ui/${name}`, import.meta.url), 'utf8');

async function withHub(fn, tables = previewTables(Date.now())) {
  const db = memoryPostgrest(tables);
  const server = createHubServer({ db, store: { createJob: async () => ({}) }, port: 0 });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base, db); } finally { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
}
const get = (base, path) => fetch(`${base}${path}`).then((response) => response.json());

test('the Live Office shows only real states: every employee from its own rows', async () => {
  await withHub(async (base) => {
    const office = await get(base, `/api/office?workspaceId=${PREVIEW_WORKSPACE}`);
    const state = Object.fromEntries(office.agents.map((agent) => [agent.key, agent.state]));
    assert.deepEqual(office.agents.map((agent) => agent.key), ['chief', 'research', 'creative', 'product', 'finance', 'coding', 'audit', 'social', 'legal'], 'exactly the nine roles');
    assert.equal(state.research, 'AVAILABLE', 'finished work does not keep an employee busy');
    assert.equal(state.finance, 'WORKING');
    assert.equal(state.legal, 'WORKING');
    assert.equal(state.creative, 'WAITING');
    assert.match(office.agents.find((agent) => agent.key === 'creative').detail, /free model capacity/);
    assert.equal(state.social, 'WAITING');
    assert.equal(office.agents.find((agent) => agent.key === 'social').detail, 'Waiting for CREATIVE');
    assert.equal(state.coding, 'NEEDS FAHAD');
    assert.equal(state.chief, 'WAITING');
    assert.equal(office.needsFahad, 1);
    assert.equal(office.agents.find((agent) => agent.key === 'finance').progress, 55);
    assert.ok(['MVP board', 'Roadmap', 'Order journey'].includes(office.agents.find((agent) => agent.key === 'product').recentArtifact.title), 'a real PRODUCT artifact');
    assert.equal(office.agents.find((agent) => agent.key === 'research').recentArtifact.type === 'evidence' || office.agents.find((agent) => agent.key === 'research').recentArtifact.type === 'table', true);
    const handoff = office.handoffs.find((entry) => entry.fromKey === 'product' && entry.toKey === 'finance');
    assert.deepEqual([handoff.objective, handoff.task, handoff.status, handoff.artifact?.type], ['Qahwa Run — launch plan', 'Launch budget and monthly costs', 'in progress', 'flow']);
    assert.ok(office.timeline.length > 5 && office.timeline.every((entry, index, list) => index === 0 || list[index - 1].at >= entry.at), 'newest first');
  });
});

test('the timeline filters by employee, status and objective and invents nothing', async () => {
  await withHub(async (base) => {
    const all = await get(base, `/api/timeline?workspaceId=${PREVIEW_WORKSPACE}`);
    assert.ok(all.entries.some((entry) => entry.text === 'RESEARCH delivered Dubai coffee pre-order market scan'));
    assert.ok(all.entries.some((entry) => entry.text === 'PRODUCT handed “Launch budget and monthly costs” to FINANCE'));
    assert.ok(all.entries.some((entry) => entry.status === 'attention' && /Needs your approval: Merge PR #12/.test(entry.text)));
    assert.ok(all.entries.some((entry) => entry.kind === 'capacity' && /CREATIVE: Waiting for free model capacity/.test(entry.text)));
    const legal = await get(base, `/api/timeline?workspaceId=${PREVIEW_WORKSPACE}&agent=legal`);
    assert.ok(legal.entries.length && legal.entries.every((entry) => entry.agentKey === 'legal' || entry.toKey === 'legal'));
    const done = await get(base, `/api/timeline?workspaceId=${PREVIEW_WORKSPACE}&status=done`);
    assert.ok(done.entries.every((entry) => entry.status === 'done'));
    const nobody = await get(base, `/api/timeline?workspaceId=${PREVIEW_WORKSPACE}&agent=unknown-person`);
    assert.deepEqual(nobody.entries, []);
    const bad = await fetch(`${base}/api/timeline?workspaceId=${PREVIEW_WORKSPACE}&job=not-a-uuid`);
    assert.equal(bad.status, 400);
  });
  assert.deepEqual(timelineView({}), [], 'no rows, no activity');
});

test('handoffs carry from, to, objective, task, artifact, status and time', () => {
  const agentById = new Map([['a', { id: 'a', slug: 'research-strategy' }], ['b', { id: 'b', slug: 'product-tech' }]]);
  const view = handoffView({ id: 'h', from_agent_id: 'a', to_agent_id: 'b', from_task_id: 't1', to_task_id: 't2', job_id: 'j', created_at: '2026-09-27T11:00:00Z' }, {
    agentById, jobById: new Map([['j', { id: 'j', title: 'Launch' }]]), taskById: new Map([['t1', { title: 'Scan' }], ['t2', { title: 'MVP', status: 'queued', not_before: '2026-09-27T12:10:00Z' }]]),
    artifactsByTask: new Map([['t1', [{ id: 'x', title: 'Competitors', type: 'table' }]]]), now: NOW,
  });
  assert.deepEqual(view, { id: 'h', from: 'RESEARCH', fromKey: 'research', to: 'PRODUCT', toKey: 'product', jobId: 'j', objective: 'Launch', fromTask: 'Scan', task: 'MVP', status: 'waiting for capacity', artifact: { id: 'x', title: 'Competitors', type: 'table' }, at: '2026-09-27T11:00:00Z' });
});

test('the employee workspace has handoffs, attention, integrations and progress', async () => {
  await withHub(async (base) => {
    const coding = await get(base, `/api/agents/coding-agent?workspaceId=${PREVIEW_WORKSPACE}`);
    assert.equal(coding.state.state, 'NEEDS FAHAD');
    assert.deepEqual(coding.attention.map((item) => item.kind), ['action']);
    assert.ok(coding.integrations.includes('github') && coding.integrations.includes('supabase_tools'));
    assert.equal(coding.codingSessions[0].prUrl, 'https://github.com/FahadTrail/qahwa-run/pull/12');
    const finance = await get(base, `/api/agents/business-finance?workspaceId=${PREVIEW_WORKSPACE}`);
    assert.equal(finance.progress, 55);
    assert.ok(finance.handoffs.some((handoff) => handoff.from === 'PRODUCT' && handoff.to === 'FINANCE'));
    assert.ok(!finance.integrations.includes('github'), 'FINANCE has no repository access');
    const chief = await get(base, `/api/agents/chief-of-staff?workspaceId=${PREVIEW_WORKSPACE}`);
    assert.ok(chief.integrations.includes('telegram'));
  });
});

test('realtime: one shared watermark per workspace pushes "change" to every open page', async () => {
  const db = memoryPostgrest(previewTables(Date.now()));
  const stream = new OfficeStream({ db, watchMs: 20 });
  const writes = [[], []];
  const responses = writes.map((sink) => {
    const listeners = {};
    return { writeHead: () => {}, write: (chunk) => sink.push(chunk), end: () => {}, on: (event, fn) => { listeners[event] = fn; }, close: () => listeners.close?.() };
  });
  responses.forEach((response) => stream.subscribe(PREVIEW_WORKSPACE, response));
  assert.equal(stream.rooms.size, 1, 'pages of one workspace share one watcher');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(writes.every((sink) => sink.some((chunk) => chunk.includes('event: ready')) && !sink.some((chunk) => chunk.includes('event: change'))), 'no change, no push');
  db.tables.events.push({ id: 999, job_id: null, type: 'activity', payload: {}, created_at: new Date().toISOString() });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(writes.every((sink) => sink.some((chunk) => chunk.includes('event: change'))), 'a real change reaches every page');
  responses.forEach((response) => response.close());
  assert.equal(stream.rooms.size, 0, 'the watcher stops when the last page leaves');
});

test('the stream endpoint is served as text/event-stream behind the same auth', async () => {
  await withHub(async (base) => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/stream?workspaceId=${PREVIEW_WORKSPACE}`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value), /event: ready/);
    controller.abort();
  });
  const denied = createHubServer({ db: memoryPostgrest({}), store: {}, port: 0, accessToken: 'secret-token-value' });
  await once(denied, 'listening');
  try { assert.equal((await fetch(`http://127.0.0.1:${denied.address().port}/api/stream?workspaceId=${PREVIEW_WORKSPACE}`)).status, 401); }
  finally { await new Promise((resolve) => denied.close(resolve)); }
});

test('visual states restate the real state only (role wording, who it waits for)', () => {
  assert.equal(visualState({ key: 'research', state: 'WORKING' }), 'RESEARCHING');
  assert.equal(visualState({ key: 'creative', state: 'WORKING' }), 'DESIGNING');
  assert.equal(visualState({ key: 'finance', state: 'WORKING' }), 'WORKING');
  assert.equal(visualState({ key: 'audit', state: 'WAITING', detail: 'Waiting for CODING' }), 'WAITING FOR CODING');
  assert.equal(visualState({ key: 'audit', state: 'WAITING', detail: 'Waiting for CODING, LEGAL' }), 'WAITING');
  assert.equal(visualState({ key: 'legal', state: 'AVAILABLE' }), 'AVAILABLE');
  assert.equal(visualState({ key: 'coding', state: 'NEEDS FAHAD' }), 'NEEDS FAHAD');
  assert.equal(visualState({ key: 'legal' }), 'AVAILABLE', 'no state means available, never busy');
});

test('character art is separate from logic, themeable and has no names or raw colours', () => {
  assert.deepEqual([...STATION_ROLES].sort(), ['audit', 'chief', 'coding', 'creative', 'finance', 'legal', 'product', 'research', 'social']);
  for (const role of STATION_ROLES) {
    const svg = stationArt(role, role.toUpperCase());
    assert.match(svg, /^<svg class="station-art"/);
    assert.doesNotMatch(svg, /#[0-9a-f]{3,8}\b|rgb\(|<script|on[a-z]+=/i, `${role}: colours come from CSS tokens, no script`);
    assert.match(roleMark(role, role), /class="role-mark"/);
  }
  const logic = file('office.js');
  assert.doesNotMatch(logic, /<path class="(torso|head)"/, 'office.js does not draw characters');
  assert.match(logic, /import \{ roleMark, stationArt \} from '\.\/characters\.js/);
});

test('the Live Office is lazy-loaded, honours reduced motion and uses tokens only', () => {
  const app = file('app.js');
  const css = file('office.css');
  assert.match(app, /import\('\.\/office\.js\?v=__UI_VERSION__'\)/, 'loaded on demand');
  assert.doesNotMatch(app, /^import .*office\.js/m, 'not in the initial bundle');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*animation: none !important/);
  assert.match(css, /data-motion="full"/, 'motion only when allowed');
  for (const sheet of ['office.css', 'project.css']) assert.deepEqual(file(sheet).match(/#[0-9a-f]{3,8}\b/gi) || [], [], `${sheet}: no raw colours outside the token blocks`);
  assert.match(file('project.css'), /prefers-reduced-motion/);
  assert.match(css, /animation: attention 1\.6s var\(--ease-in-out\) 4;/, 'attention pulses a few times, not forever');
  for (const state of ['THINKING', 'WORKING', 'TESTING', 'WAITING', 'REVIEWING', 'NEEDS FAHAD', 'BLOCKED', 'COMPLETED', 'FAILED']) assert.ok(css.includes(`[data-state="${state}"]`), state);
});

test('text assets are served gzip-compressed when the browser accepts it; fonts are not re-compressed', async () => {
  await withHub(async (base) => {
    const html = await fetch(`${base}/`).then((response) => response.text());
    const version = html.match(/app\.js\?v=([0-9a-f]{12})/)[1];
    const plain = await fetch(`${base}/ui/app.css?v=${version}`, { headers: { 'accept-encoding': 'identity' } });
    assert.equal(plain.headers.get('content-encoding'), null);
    const { request } = await import('node:http');
    const gz = await new Promise((resolve, reject) => {
      request(`${base}/ui/app.css?v=${version}`, { headers: { 'accept-encoding': 'gzip' } }, (response) => { const chunks = []; response.on('data', (chunk) => chunks.push(chunk)); response.on('end', () => resolve({ headers: response.headers, size: Buffer.concat(chunks).length })); }).on('error', reject).end();
    });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(gz.headers.vary, 'accept-encoding');
    assert.ok(gz.size < Number((await plain.arrayBuffer()).byteLength) / 3, 'CSS compresses to under a third');
    const font = await fetch(`${base}/ui/fonts/inter-latin-var.woff2?v=${version}`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(font.headers.get('content-encoding'), null);
  });
});

test('accessibility guards: interactive layers are not hidden, scroll regions are reachable, focus is visible', () => {
  const office = file('office.js');
  assert.doesNotMatch(office, /class="handoff-layer"[^>]*aria-hidden/, 'the clickable handoff layer is not aria-hidden');
  assert.match(office, /role="dialog" aria-modal="true"/);
  assert.match(office, /event\.key === 'Escape'/, 'drawers close with Escape');
  assert.match(office, /event\.key === 'Tab'/, 'focus stays inside an open drawer');
  const art = file('artifacts.js');
  assert.match(art, /class="art-scroll" tabindex="0" role="region"/);
  assert.match(art, /class="art-kanban" tabindex="0" role="region"/);
  const css = file('app.css');
  assert.match(css, /:focus-visible \{ outline: none; box-shadow: var\(--focus\); /);
  assert.match(css, /--accent-fill:/, 'white-on-accent buttons use a darker fill (WCAG AA)');
  assert.match(file('app.js'), /<h1 class="chat-title"/, 'every page has a heading');
});
