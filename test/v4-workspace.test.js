import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHubServer } from '../src/hub-server.js';
import { attentionFrom, PRIORITY } from '../src/hub-workspace.js';
import { publicSession } from '../src/hub-coding.js';
import { memoryPostgrest } from '../testing/fixtures/memory-postgrest.js';
import { PREVIEW_WORKSPACE, previewTables } from '../testing/fixtures/hub-preview-data.js';
import { humanError, errorBlock } from '../src/hub-ui/humanize.js';
import { artifactRows, toCsv, toMarkdown } from '../src/hub-ui/export.js';
import { artifactPreview, renderArtifact } from '../src/hub-ui/artifacts.js';
import { escapeHtml } from '../src/hub-ui/markdown.js';

async function withHub(fn) {
  const db = memoryPostgrest(previewTables(Date.now()), { rpc: { model_usage_summary: () => ({ data: [], error: null }) } });
  const server = createHubServer({ db, store: { createJob: async () => ({}) }, port: 0 });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base, db); } finally { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
}
const get = (base, path) => fetch(`${base}${path}`).then((response) => response.json());

test('Command Center: status, CHIEF summary, progress, the 8-person team, next actions and decisions — all from rows', async () => {
  await withHub(async (base) => {
    const center = await get(base, `/api/command-center?workspaceId=${PREVIEW_WORKSPACE}`);
    assert.equal(center.status, 'NEEDS FAHAD');
    assert.equal(center.progress, 55);
    assert.match(center.summary.text, /^First pass is done/, 'CHIEF’s own final, not a direct employee chat');
    assert.deepEqual(center.roster.map((member) => member.label), ['RESEARCH', 'CREATIVE', 'PRODUCT', 'FINANCE', 'CODING', 'AUDIT', 'SOCIAL', 'LEGAL'], 'eight specialists, LEGAL included');
    const finance = center.roster.find((member) => member.key === 'finance');
    assert.deepEqual([finance.state, finance.task, finance.progress], ['WORKING', 'Launch budget and monthly costs', 55]);
    assert.match(finance.latest.summary, /Pilot budget/);
    assert.equal(center.roster.find((member) => member.key === 'research').task, null, 'an available employee shows no task');
    assert.deepEqual(center.nextActions.map((action) => action.text), ['LEGAL drafts refund terms', 'FINANCE confirms card fees']);
    assert.deepEqual(center.decisionsForFahad.map((decision) => decision.from), ['PRODUCT'], '"None yet." is not a decision');
    assert.ok(center.timeline.length && center.handoffs.length);
    assert.equal(center.activeJobId, 'b0000000-0000-4000-8000-000000000001');
  });
});

test('Needs Fahad: categories and priorities, legal and security decisions, no routine noise', async () => {
  const items = attentionFrom({
    sessions: [{ id: 's1', title: 'Merge', status: 'awaiting_approval', updated_at: '2026-09-27T10:00:00Z' }, { id: 's2', title: 'Done task', status: 'completed', completed_at: '2026-09-27T09:00:00Z', result: {} }],
    approvals: [{ id: 'a1', session_id: 's1', status: 'pending', risk: 'high', summary: 'Merge PR', tool_name: 'github.merge' }],
    artifacts: [
      { id: 'x', type: 'compliance_matrix', title: 'Legal', created_at: '2026-09-27T08:00:00Z', data: { items: [{ requirement: 'Refund terms', classification: 'PROFESSIONAL REVIEW REQUIRED' }, { requirement: 'Licence', classification: 'INFORMATION' }] } },
      { id: 'y', type: 'audit_report', title: 'Audit', created_at: '2026-09-27T07:00:00Z', data: { verdict: 'BLOCKED', findings: [{ title: 'Service key in the client', severity: 'critical', area: 'security' }] } },
      { id: 'z', type: 'audit_report', title: 'Style audit', created_at: '2026-09-27T07:00:00Z', data: { verdict: 'NEEDS WORK', findings: [{ title: 'Typo', severity: 'low', area: 'content' }] } },
    ],
    completedObjectives: [{ id: 'j', title: 'Launch plan', completed_at: '2026-09-27T06:00:00Z' }],
  });
  const view = items.map((item) => `${item.priority}|${item.category}|${item.title}`);
  assert.deepEqual(view, ['URGENT|APPROVAL|Merge', 'URGENT|SECURITY DECISION|Audit', 'ACTION NEEDED|LEGAL DECISION|Legal', 'INFO|COMPLETED|Done task', 'INFO|PROJECT COMPLETE|Launch plan']);
  assert.ok(!items.some((item) => item.title === 'Style audit'), 'a low finding is not an interruption');
  assert.ok(!items.some((item) => item.priority === PRIORITY.URGENT && item.kind === 'completed'), 'routine completion is never urgent');
  await withHub(async (base) => {
    const data = await get(base, `/api/attention?workspaceId=${PREVIEW_WORKSPACE}`);
    assert.deepEqual(data.items.map((item) => item.category), ['APPROVAL', 'LEGAL DECISION', 'COMPLETED', 'PROJECT COMPLETE']);
    assert.deepEqual([data.counts.urgent, data.counts.action], [1, 2]);
  });
});

test('search: every kind, current project only, escaped patterns, bounded', async () => {
  await withHub(async (base) => {
    const found = await get(base, `/api/search?workspaceId=${PREVIEW_WORKSPACE}&q=budget`);
    const kinds = new Set(found.results.map((result) => result.kind));
    for (const kind of ['objective', 'artifact']) assert.ok(kinds.has(kind), kind);
    assert.ok(found.results.every((result) => result.href.startsWith('#/')));
    const people = await get(base, `/api/search?workspaceId=${PREVIEW_WORKSPACE}&q=فاينانس`);
    assert.ok(people.results.some((result) => result.kind === 'employee' && result.title === 'FINANCE'), 'Arabic nicknames find employees');
    assert.deepEqual((await get(base, `/api/search?workspaceId=${PREVIEW_WORKSPACE}&q=a`)).results, [], 'two letters minimum');
    assert.deepEqual((await get(base, `/api/search?workspaceId=${PREVIEW_WORKSPACE}&q=%25%25`)).results, [], 'wildcards are literal');
    const memory = await get(base, `/api/search?workspaceId=${PREVIEW_WORKSPACE}&q=PDPL`);
    assert.ok(memory.results.some((result) => result.kind === 'memory'));
  });
});

test('memory can be edited and removed safely, scoped to its project', async () => {
  await withHub(async (base, db) => {
    const id = db.tables.project_memory[0].id;
    const patch = (body, project = PREVIEW_WORKSPACE, memoryId = id) => fetch(`${base}/api/projects/${project}/memory/${memoryId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await patch({ content: 'Pilot area is Dubai Marina.' })).status, 200);
    assert.equal(db.tables.project_memory[0].content, 'Pilot area is Dubai Marina.');
    assert.equal((await patch({ kind: 'secret_prompt' })).status, 400, 'only known memory types');
    assert.equal((await patch({ content: 'x' })).status, 400, 'too short');
    assert.equal((await patch({ content: 'Moved elsewhere' }, '22222222-2222-4222-8222-222222222222')).status, 404, 'another project cannot edit it');
  });
});

test('infrastructure errors read as human language, with the original behind View details', () => {
  assert.equal(humanError('429 RATE_LIMIT from provider'), 'Free model capacity is temporarily full. The task will resume automatically.');
  assert.equal(humanError('PROVIDER_AUTH 403 provider blocked'), 'This provider needs account action (Models → provider).');
  assert.match(humanError('Could not load Office data: 500'), /nothing was lost/);
  assert.equal(humanError('WAITING_FOR_CAPACITY'), 'Waiting for free model capacity — will resume automatically.');
  assert.equal(humanError('Workspace name taken'), 'Workspace name taken', 'plain messages stay as they are');
  const html = errorBlock('429 <b>RATE_LIMIT</b>', escapeHtml);
  assert.match(html, /View details/);
  assert.doesNotMatch(html, /<b>/);
});

test('exports: one shared CSV/document path, formula-safe, for every tabular type', () => {
  const finance = { type: 'financial_model', title: 'Budget', data: { currency: 'AED', items: [{ category: 'Build', item: '=HYPERLINK("x")', one_time: 100, monthly: 10, basis: 'KNOWN' }] } };
  const csv = toCsv(finance);
  assert.match(csv, /^Category,Item,One-time,Monthly,First year,Basis,Note,Currency\r\n/);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/, 'spreadsheet formulas are neutralised');
  assert.match(csv, /,220,KNOWN,/, 'first year = one-time + 12 × monthly');
  for (const type of ['table', 'compliance_matrix', 'audit_report', 'content_calendar', 'checklist', 'timeline', 'kanban', 'evidence', 'risk_matrix', 'chart', 'flow', 'moodboard']) {
    assert.ok(Array.isArray(artifactRows({ type, data: {} })), type);
  }
  assert.match(toMarkdown({ type: 'compliance_matrix', title: 'Legal', data: { items: [{ requirement: 'a|b' }] } }), /a\\\|b[\s\S]*not a licensed lawyer/);
});

test('department views: finance traceable, legal honest, audit actionable, creative visual — all escaped', () => {
  const finance = renderArtifact({ type: 'financial_model', title: 'B', data: { currency: 'AED', items: [{ category: 'Build', item: 'App', one_time: 1000, monthly: 0, basis: 'KNOWN' }, { category: 'Ops', item: 'Hosting', monthly: 100, basis: 'ESTIMATED' }] } });
  assert.match(finance, /Setup \(one-time\)[\s\S]*1,000 AED[\s\S]*Monthly[\s\S]*100 AED[\s\S]*Annual running[\s\S]*1,200 AED[\s\S]*First year total[\s\S]*2,200 AED/);
  assert.match(finance, /Sensitivity \(derived\)[\s\S]*2,440 AED[\s\S]*1,960 AED/, '±20% only on the uncertain lines');
  const legal = renderArtifact({ type: 'compliance_matrix', title: 'L', data: { items: [{ requirement: 'Refund terms', classification: 'PROFESSIONAL REVIEW REQUIRED', status: 'required', uncertainty: 'high', source: 'javascript:alert(1)' }] } });
  assert.match(legal, /not a licensed lawyer/);
  assert.doesNotMatch(legal, /href="javascript/);
  const audit = renderArtifact({ type: 'audit_report', title: 'A', data: { verdict: 'NEEDS WORK', findings: [{ title: '<img src=x>', severity: 'high', owner: 'legal', detail: 'Draft it' }] } });
  assert.match(audit, /data-send-owner="legal"[^>]*hidden/, 'the send-to-owner action exists but is shown only where it is wired');
  assert.doesNotMatch(audit, /<img/);
  const creative = renderArtifact({ type: 'moodboard', title: 'Qahwa Run — brand direction', data: { palette: [{ name: 'Espresso', hex: '#3B2A20', role: 'primary' }, { name: 'Sand', hex: '#E9DCC7', role: 'background' }, { name: 'Bad', hex: 'red;x:url(javascript:1)' }], typography: [{ role: 'Headings', family: "Fraunces');x", sample: 'Hi' }] } });
  assert.match(creative, /class="mb-preview"[\s\S]*Qahwa Run/, 'the moodboard becomes a brand preview');
  assert.doesNotMatch(creative, /url\(|javascript|Fraunces'\)/);
  assert.match(artifactPreview({ type: 'moodboard', data: { palette: [{ hex: '#112233' }] } }), /background:#112233/);
  assert.equal(artifactPreview({ type: 'unknown', data: {} }), '');
});

test('a finished Coding task keeps its PR, CI and files from the final result', () => {
  const view = publicSession({ id: 's', status: 'completed', state: {}, result: { summary: 'Done', pr: { url: 'https://github.com/o/r/pull/9', number: 9 }, ci: { state: 'success' }, filesChanged: ['a.js'] } });
  assert.deepEqual([view.pr.number, view.ci.state, view.filesChanged], [9, 'success', ['a.js']]);
});
