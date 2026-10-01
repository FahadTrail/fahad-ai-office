#!/usr/bin/env node
// Builds the private V5 immersive DEMO preview: a static copy of the Hub UI
// whose API is a recorded, read-only snapshot of the REAL Hub handlers over
// fictional demo data (testing/fixtures/v5-demo-data.js). No server, no
// Supabase, no models, no Telegram: nothing it does can reach production.
// Writes are refused in the page ("Available in production after V5
// approval."). Output: a folder with index.html, ui/, demo/.
//
//   node tools/v5-preview-build.mjs <out-dir>
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHubServer } from '../src/hub-server.js';
import { memoryPostgrest } from '../testing/fixtures/memory-postgrest.js';
import { DEMO_MOMENTS, demoTables } from '../testing/fixtures/v5-demo-data.js';

const out = process.argv[2];
if (!out) { console.error('usage: node tools/v5-preview-build.mjs <out-dir>'); process.exit(1); }
const UI = new URL('../src/hub-ui/', import.meta.url).pathname;
const capturedAt = Date.now();
const keyOf = (path) => { const url = new URL(path, 'http://demo'); url.searchParams.sort(); return `${url.pathname}${url.search}`; };

async function record(moment) {
  const tables = demoTables(capturedAt, moment);
  const db = memoryPostgrest(tables, { rpc: { model_usage_summary: () => ({ data: [], error: null }) } });
  const server = createHubServer({ db, store: {}, host: '127.0.0.1', port: 0, accessToken: '', authEnabled: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const responses = {};
  const get = async (path) => {
    const key = keyOf(path);
    if (key in responses) return responses[key];
    const response = await fetch(base + path);
    if (!response.ok) return null;
    const body = await response.json();
    responses[key] = body;
    return body;
  };
  const q = (params) => `?${new URLSearchParams(params)}`;
  await get('/healthz');
  // Only the fictional demo project is offered (named as a demo).
  const listing = await get('/api/workspaces');
  const workspaces = listing.workspaces.filter((workspace) => workspace.name === 'Qahwa Run').map((workspace) => ({ ...workspace, name: 'Qahwa Run (demo)' }));
  listing.workspaces = workspaces;
  await get('/api/capabilities');
  for (const { id: workspaceId } of workspaces) {
    const ws = { workspaceId };
    for (const path of ['/api/conversations', '/api/attention', '/api/office', '/api/command-center', '/api/models', '/api/timeline', '/api/tasks']) await get(path + q(ws));
    await get(`/api/conversations${q({ ...ws, archived: 'true' })}`);
    await get(`/api/conversations${q({ ...ws, archived: 'false', q: '' })}`);
    await get(`/api/conversations${q({ ...ws, archived: 'true', q: '' })}`);
    for (const status of ['running', 'attention', 'completed', 'failed', 'cancelled']) await get(`/api/tasks${q({ ...ws, status })}`);
    for (const limit of [60, 200]) await get(`/api/artifacts${q({ ...ws, limit })}`);
    await get(`/api/projects/${workspaceId}`);
    const office = await get(`/api/office${q(ws)}`);
    for (const agent of office?.agents || []) {
      await get(`/api/agents/${agent.slug}${q(ws)}`);
      await get(`/api/artifacts${q({ ...ws, agent: agent.slug })}`);
    }
    const { conversations = [] } = await get(`/api/conversations${q(ws)}`) || {};
    for (const conversation of conversations) await get(`/api/conversations/${conversation.id}`);
    const { tasks = [] } = await get(`/api/tasks${q(ws)}`) || {};
    for (const task of tasks) await get(`/api/tasks/${task.id}`);
  }
  for (const job of tables.jobs) await get(`/api/workflows/${job.id}`);
  server.close();
  return responses;
}

// Static copy of the UI; asset URLs lose their cache-busting query.
function copyUi(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const source = join(from, name);
    const target = join(to, name);
    if (statSync(source).isDirectory()) { copyUi(source, target); continue; }
    if (/\.(js|css)$/.test(name)) writeFileSync(target, readFileSync(source, 'utf8').replaceAll('?v=__UI_VERSION__', '').replaceAll('__UI_VERSION__', 'demo'));
    else if (name !== 'index.html') cpSync(source, target);
  }
}

rmSync(out, { recursive: true, force: true });
copyUi(UI, join(out, 'ui'));
mkdirSync(join(out, 'demo'), { recursive: true });
const moments = {};
for (const moment of DEMO_MOMENTS) moments[moment] = await record(moment);
writeFileSync(join(out, 'demo', 'data.json'), JSON.stringify({ capturedAt, moments }));
cpSync(new URL('./v5-preview-shim.js', import.meta.url).pathname, join(out, 'demo', 'shim.js'));
const html = readFileSync(join(UI, 'index.html'), 'utf8')
  .replaceAll('?v=__UI_VERSION__', '')
  .replace('<title>Fahad AI Office</title>', '<title>Office V5 Preview</title>')
  .replace('<link rel="stylesheet" href="./ui/app.css">', '<script src="./demo/shim.js" charset="utf-8"></script>\n<link rel="stylesheet" href="./ui/app.css">');
if (!html.includes('./demo/shim.js')) throw new Error('shim not injected');
// The private host wraps the page in its own document skeleton, so the page
// is written as head elements + body content (browsers accept both forms).
const page = html.replace(/<!doctype html>\s*/i, '').replace(/<\/?html[^>]*>\s*/g, '').replace(/<\/?head>\s*/g, '').replace(/<\/?body>\s*/g, '')
  .replace(/<meta name="viewport"[^>]*>\s*/, '');
writeFileSync(join(out, 'index.html'), page);
console.log(`V5 demo preview written to ${out} (${Object.values(moments).map((entry) => Object.keys(entry).length).join(' + ')} recorded responses)`);
