// V5.3 Project Deliverables Center: the board is derived only from real rows
// (results, artifacts, sessions, approvals) through the real Hub handlers;
// owner curation is the only new state and degrades honestly without its
// migration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHubServer } from '../src/hub-server.js';
import { deliverablesBoard, versionChains, stripArtifactBlocks } from '../src/hub-deliverables.js';
import { memoryPostgrest } from '../testing/fixtures/memory-postgrest.js';
import { previewTables, PREVIEW_WORKSPACE } from '../testing/fixtures/hub-preview-data.js';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AGENTS = [['chief-of-staff', 1], ['business-finance', 2], ['coding-agent', 3], ['qa-security', 4], ['legal-compliance', 5], ['brand-creative', 6]]
  .map(([slug, n]) => ({ id: id(900 + n), slug, name: slug }));
const agent = (slug) => AGENTS.find((row) => row.slug === slug).id;
const brief = (stage, extra = {}) => JSON.stringify({ workflow: 'chief-research-chief', stage, ...extra });
const at = (minutes) => new Date(Date.UTC(2026, 9, 5, 12, 0) + minutes * 60_000).toISOString();
const NOW = Date.parse(at(60));
const PROJECT = { id: id(1), name: 'Harbor', description: 'Test project', default_repository: 'owner/harbor' };
const task = (n, job, slug, stage, status, extra = {}) => ({ id: id(n), job_id: job, agent_id: agent(slug), title: `Task ${n}`, status, brief: brief(stage, extra.brief), depends_on: extra.depends_on || [], sequence: extra.sequence ?? n, created_at: at(n), started_at: extra.started_at ?? at(n), completed_at: status === 'done' ? at(n + 1) : null, not_before: extra.not_before || null });
const result = (n, job, taskId, content, kind = 'task') => ({ id: id(5000 + n), job_id: job, task_id: taskId, kind, summary: '', content, created_at: at(n) });
const board = (rows) => deliverablesBoard({ project: PROJECT, agents: AGENTS, now: NOW, reviews: [], ...rows });
const byTitle = (view, title) => view.deliverables.find((item) => item.title === title);

test('a revision round is one card: the delivered version stays visible while the next runs', () => {
  const job = { id: id(100), title: 'Launch plan', status: 'running', priority: 'high', created_at: at(0) };
  const v1 = { ...task(10, job.id, 'business-finance', 'specialist', 'done', { sequence: 100 }), title: 'Budget' };
  const v2 = { ...task(20, job.id, 'business-finance', 'specialist', 'running', { sequence: 500, brief: { revision: 'Cut setup cost', revisesTaskId: id(10) } }), title: 'Budget' };
  const r1 = task(30, job.id, 'chief-of-staff', 'synthesis', 'done', { sequence: 900 });
  const r2 = task(40, job.id, 'chief-of-staff', 'synthesis', 'queued', { sequence: 950, depends_on: [id(20)] });
  const view = board({
    jobs: [job], tasks: [v1, v2, r1, r2],
    results: [result(11, job.id, id(10), '## Summary\nBudget v1 is 38k.\n\n## Decisions for Fahad\nNone.'), result(31, job.id, id(30), '## Executive summary\nRound one.')],
    artifacts: [{ id: id(700), project_id: PROJECT.id, job_id: job.id, task_id: id(10), agent_slug: 'business-finance', type: 'financial_model', title: 'Budget model', data: { items: [] }, created_at: at(11) }],
  });
  const finance = view.deliverables.filter((item) => item.agent.key === 'finance');
  assert.equal(finance.length, 1, 'versions collapse into one card');
  assert.equal(finance[0].key, `task:${id(10)}`, 'the delivered version is shown');
  assert.equal(finance[0].status, 'in_progress', 'status follows the newest version');
  assert.deepEqual(finance[0].version, { number: 1, count: 2, pending: true, list: finance[0].version.list });
  assert.equal(finance[0].version.list[1].revision, true);
  assert.equal(finance[0].artifacts[0].type, 'financial_model');
  assert.equal(finance[0].priority, 'high');
  const chief = view.deliverables.find((item) => item.agent.key === 'chief');
  assert.equal(chief.type, 'synthesis');
  assert.equal(chief.version.count, 2, 'synthesis rounds are versions of one result');
  assert.equal(chief.status, 'waiting');
  assert.deepEqual(chief.reason, { code: 'dependency', agents: ['FINANCE'] });
  const chains = versionChains([v1, v2, r1, r2]);
  assert.equal(chains.rootOf(v2), id(10));
  assert.equal(chains.rootOf(r2), id(30));
});

test('outputs are counted once and only real deliverables become cards', () => {
  const job = { id: id(200), title: 'Brand', status: 'completed', created_at: at(0) };
  const chat = { id: id(201), title: 'Quick question', status: 'completed', conversation_id: id(250), created_at: at(0) };
  const chatWithModel = { id: id(202), title: 'Price it', status: 'completed', created_at: at(0) };
  const tasks = [
    task(1, job.id, 'chief-of-staff', 'chief_plan', 'done'),
    task(2, job.id, 'brand-creative', 'specialist', 'done'),
    task(3, job.id, 'coding-agent', 'launch_dev', 'done'),
    task(4, job.id, 'business-finance', 'consult', 'done'),
    task(5, chat.id, 'business-finance', 'direct', 'done'),
    task(6, chatWithModel.id, 'business-finance', 'direct', 'done'),
  ];
  const view = board({
    jobs: [job, chat, chatWithModel], tasks,
    // complete_task files the last task's output again as the job's final.
    results: [result(2, job.id, id(2), '## Summary\nWarm palette.'), result(3, job.id, id(2), '## Summary\nWarm palette.', 'final'), result(5, chat.id, id(5), 'About 3%.')],
    artifacts: [{ id: id(701), project_id: PROJECT.id, job_id: chatWithModel.id, task_id: id(6), agent_slug: 'business-finance', type: 'financial_model', title: 'Pricing model', data: { items: [] }, created_at: at(7) }],
  });
  assert.deepEqual(view.deliverables.map((item) => item.title).sort(), ['Pricing model', 'Task 2']);
  assert.equal(byTitle(view, 'Task 2').summary, 'Warm palette.');
  assert.equal(view.summary.total, 2);
});

test('statuses come from the Office’s validators and Fahad’s decisions, never from guesswork', () => {
  const job = { id: id(300), title: 'Readiness', status: 'completed', created_at: at(0) };
  const tasks = [task(1, job.id, 'qa-security', 'specialist', 'done'), task(2, job.id, 'legal-compliance', 'specialist', 'done'), task(3, job.id, 'business-finance', 'specialist', 'done'), task(4, job.id, 'brand-creative', 'specialist', 'done')];
  const art = (n, taskN, slug, type, data) => ({ id: id(800 + n), project_id: PROJECT.id, job_id: job.id, task_id: id(taskN), agent_slug: slug, type, title: `${type} ${n}`, data, created_at: at(n) });
  const rows = {
    jobs: [job], tasks,
    results: [result(1, job.id, id(1), '## Summary\nAudit.'), result(2, job.id, id(2), '## Summary\nLegal.'), result(3, job.id, id(3), '## Summary\nNumbers.'), result(4, job.id, id(4), '## Summary\nBrand.\n\n## Decisions for Fahad\nPick logo A or B.')],
    artifacts: [art(1, 1, 'qa-security', 'audit_report', { verdict: 'NEEDS WORK', findings: [] }), art(2, 2, 'legal-compliance', 'compliance_matrix', { items: [{ classification: 'RISK FLAG' }, { classification: 'INFORMATION' }] }),
      art(3, 3, 'business-finance', 'financial_model', { items: [], validation: { state: 'INCONSISTENT' } })],
  };
  const view = board(rows);
  const status = (n) => view.deliverables.find((item) => item.key === `task:${id(n)}`);
  assert.deepEqual([status(1).status, status(1).reason], ['needs_review', { code: 'audit', verdict: 'NEEDS WORK' }]);
  assert.deepEqual([status(2).status, status(2).reason], ['needs_review', { code: 'compliance', count: 1 }]);
  assert.deepEqual([status(3).status, status(3).reason], ['needs_review', { code: 'finance', state: 'INCONSISTENT' }]);
  assert.deepEqual([status(4).status, status(4).reason.code, status(4).decisions], ['needs_fahad', 'decision', 'Pick logo A or B.']);
  assert.deepEqual(view.summary.counts, { needs_fahad: 1, blocked: 0, needs_review: 3, in_progress: 0, waiting: 0, ready: 0 });

  // Fahad's decision applies to the exact version he decided on.
  const approved = board({ ...rows, reviews: [{ deliverable_key: `task:${id(1)}`, decision: 'approved', decision_key: `task:${id(1)}`, decided_at: at(50) }, { deliverable_key: `task:${id(4)}`, decision: 'approved', decision_key: `task:${id(999)}`, decided_at: at(50) }] });
  assert.deepEqual(approved.deliverables.find((item) => item.key === `task:${id(1)}`).reason, { code: 'approved', at: at(50) }, 'Fahad can accept a flagged output');
  assert.equal(approved.deliverables.find((item) => item.key === `task:${id(1)}`).status, 'ready');
  assert.equal(approved.deliverables.find((item) => item.key === `task:${id(4)}`).status, 'needs_fahad', 'a decision on another version does not carry over');
  const revision = board({ ...rows, reviews: [{ deliverable_key: `task:${id(3)}`, decision: 'revision_requested', decision_key: `task:${id(3)}`, decided_at: at(51) }] });
  assert.equal(revision.deliverables.find((item) => item.key === `task:${id(3)}`).reason.code, 'revision_requested');
});

test('work that is not delivered yet says exactly why', () => {
  const job = { id: id(400), title: 'Launch', status: 'running', created_at: at(0) };
  const failedJob = { id: id(401), title: 'Stopped', status: 'failed', created_at: at(0) };
  const cancelled = { id: id(402), title: 'Cancelled', status: 'cancelled', created_at: at(0) };
  const view = board({
    jobs: [job, failedJob, cancelled],
    tasks: [
      task(1, job.id, 'business-finance', 'specialist', 'running'),
      task(2, job.id, 'brand-creative', 'specialist', 'queued', { not_before: at(70) }),
      task(3, job.id, 'qa-security', 'specialist', 'queued', { depends_on: [id(1), id(2)] }),
      task(4, job.id, 'legal-compliance', 'specialist', 'failed'),
      task(5, failedJob.id, 'business-finance', 'specialist', 'queued'),
      task(6, cancelled.id, 'business-finance', 'specialist', 'done'),
      task(7, job.id, 'chief-of-staff', 'synthesis', 'skipped'),
    ],
  });
  const reason = (n) => view.deliverables.find((item) => item.key === `task:${id(n)}`)?.reason;
  assert.equal(reason(1).code, 'working');
  assert.deepEqual(reason(2), { code: 'capacity', until: at(70) });
  assert.deepEqual(reason(3), { code: 'dependency', agents: ['FINANCE', 'CREATIVE'] });
  assert.equal(reason(4).code, 'failed');
  assert.equal(reason(5).code, 'stopped', 'a step of a stopped objective will never run');
  assert.equal(reason(6), undefined, 'cancelled objectives are not deliverables');
  assert.equal(reason(7), undefined, 'skipped steps are not deliverables');
  for (const item of view.deliverables.filter((entry) => entry.status !== 'ready')) assert.equal(item.artifacts.length, 0, 'no preview is invented for work in progress');
});

test('CODING sessions are deliverables linked to the objective that launched them', () => {
  const objective = { id: id(500), title: 'Launch plan', status: 'running', priority: 'urgent', conversation_id: id(560), created_at: at(0) };
  const codingJob = { id: id(501), title: 'API', status: 'running', created_at: at(1) };
  const soloJob = { id: id(502), title: 'Fix', status: 'completed', created_at: at(2) };
  const codingTask = (n, job) => ({ ...task(n, job, 'coding-agent', null, 'assigned'), brief: JSON.stringify({ workflow: 'coding-agent', workflow_version: 1 }) });
  const session = (n, job, status, extra = {}) => ({ id: id(n), workspace_id: PROJECT.id, job_id: job, title: `Session ${n}`, repository: 'owner/harbor', status, phase: 'deploy', state: {}, result: {}, created_at: at(n), updated_at: at(n + 1), ...extra });
  const view = board({
    jobs: [objective, codingJob, soloJob], tasks: [codingTask(1, codingJob.id), codingTask(2, soloJob.id)],
    sessions: [
      session(10, codingJob.id, 'awaiting_approval', { state: { pr: { number: 12, url: 'https://github.com/owner/harbor/pull/12' }, filesChanged: ['src/a.js', 'test/a.test.js'], lastTest: { exitCode: 0 } } }),
      session(11, soloJob.id, 'completed', { result: { summary: '**Fixed** rounding.', ci: { state: 'failure' }, pr: { number: 11, url: 'javascript:alert(1)' } }, completed_at: at(13) }),
      session(12, soloJob.id, 'cancelled'),
    ],
    approvals: [{ id: id(20), session_id: id(10), tool_name: 'github.pr_merge', risk: 'high', summary: 'Merge PR #12', status: 'pending', arguments_preview: {} }],
    launches: [{ job_id: objective.id, payload: { kind: 'task_launched', session_id: id(10) } }],
  });
  const api = view.deliverables.find((item) => item.key === `session:${id(10)}`);
  assert.equal(api.kind, 'coding');
  assert.equal(api.objective.id, objective.id, 'linked through the launch event');
  assert.equal(api.priority, 'urgent');
  assert.deepEqual([api.status, api.reason.code, api.reason.risk], ['needs_fahad', 'approval', 'high']);
  assert.deepEqual(api.coding.pr, { number: 12, url: 'https://github.com/owner/harbor/pull/12' });
  assert.deepEqual([api.coding.tests, api.coding.filesCount], ['passing', 2]);
  assert.equal(api.links.task, `#/task/${id(10)}`);
  const fix = view.deliverables.find((item) => item.key === `session:${id(11)}`);
  assert.equal(fix.objective, null, 'a CODING job is not an objective');
  assert.deepEqual([fix.status, fix.reason.code], ['needs_review', 'ci_failed']);
  assert.equal(fix.summary, 'Fixed rounding.');
  assert.equal(fix.coding.pr.url, null, 'only https links are passed to the browser');
  assert.equal(view.deliverables.some((item) => item.key === `session:${id(12)}`), false, 'a cancelled session is not a deliverable');
  assert.deepEqual(view.objectives.map((entry) => entry.id), [objective.id]);
});

test('older structured outputs stand alone and owner curation is optional', () => {
  const orphan = { id: id(600), project_id: PROJECT.id, job_id: id(650), task_id: id(651), agent_slug: 'legal-compliance', type: 'compliance_matrix', title: 'Old matrix', data: { items: [] }, created_at: at(5) };
  const unavailable = deliverablesBoard({ project: PROJECT, agents: AGENTS, jobs: [{ id: id(650), title: 'Old objective', status: 'completed', created_at: at(0) }], artifacts: [orphan], reviews: null, now: NOW });
  assert.equal(unavailable.reviews.available, false, 'no curation table reads as unavailable, not as an error');
  assert.equal(unavailable.deliverables[0].key, `artifact:${id(600)}`);
  assert.equal(unavailable.deliverables[0].objective.title, 'Old objective');
  const archived = deliverablesBoard({ project: PROJECT, agents: AGENTS, artifacts: [orphan], reviews: [{ deliverable_key: `artifact:${id(600)}`, archived: true, pinned: true }], now: NOW });
  assert.equal(archived.reviews.available, true);
  assert.deepEqual([archived.summary.total, archived.summary.archived], [0, 1], 'archived outputs leave the counts');
  assert.deepEqual(archived.deliverables[0].review, { pinned: true, archived: true, decision: null, decisionKey: null, note: null, decidedAt: null, updatedAt: null });
  assert.equal(stripArtifactBlocks('a\n```artifact\n{"type":"table"}\n```\n\n\n\nb'), 'a\n\nb');
});

// ------------------------------------------------------------------ handlers

async function hub(tables, { failReviews = false } = {}) {
  const db = memoryPostgrest(tables, { rpc: { model_usage_summary: () => ({ data: [], error: null }) } });
  if (failReviews) {
    const from = db.from;
    // A project where the V5.3 migration is not applied yet.
    db.from = (name) => {
      if (name !== 'deliverable_reviews') return from(name);
      const missing = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.deliverable_reviews' in the schema cache" } };
      const chain = new Proxy({}, { get: (_, key) => (key === 'then' ? (resolve) => resolve(missing) : () => chain) });
      return chain;
    };
  }
  const server = createHubServer({ db, store: {}, host: '127.0.0.1', port: 0, accessToken: '', authEnabled: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body) => {
    const response = await fetch(`${base}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    return { status: response.status, body: await response.json() };
  };
  return { db, server, call };
}

test('the preview project reads as a truthful board through the real Hub', async () => {
  const { server, call } = await hub(previewTables(Date.now()));
  try {
    const { status, body } = await call(`/api/deliverables?workspaceId=${PREVIEW_WORKSPACE}`);
    assert.equal(status, 200);
    assert.equal(body.reviews.available, true);
    assert.deepEqual(body.summary.counts, { needs_fahad: 2, blocked: 0, needs_review: 2, in_progress: 2, waiting: 4, ready: 6 });
    assert.equal(body.summary.total, 16);
    assert.match(body.summary.chief.text, /^First pass is done/);
    const api = body.deliverables.find((item) => item.title === 'Pre-order API endpoint');
    assert.deepEqual([api.kind, api.status, api.objective.title], ['coding', 'needs_fahad', 'Qahwa Run — launch plan']);
    const product = body.deliverables.find((item) => item.agent.key === 'product');
    assert.deepEqual([product.type, product.reason.code], ['kanban', 'decision']);
    assert.equal(body.deliverables.some((item) => item.title === 'Card fees'), false, 'a text-only chat answer stays in Chats');
    for (const item of body.deliverables) assert.ok(item.status && item.agent?.label && item.key, item.title);
    assert.ok(!JSON.stringify(body).includes('decided_by'), 'who decided is never sent to the browser');

    const report = await call(`/api/deliverables/report?workspaceId=${PREVIEW_WORKSPACE}&taskId=${product.key.split(':')[1]}`);
    assert.equal(report.status, 200);
    assert.match(report.body.report.text, /^## Summary\nMVP: order ahead/);
    assert.doesNotMatch(report.body.report.text, /```artifact/, 'visuals come from validated artifact rows, not raw blocks');
    assert.equal(report.body.artifacts.length, 3);
    const foreign = await call(`/api/deliverables/report?workspaceId=22222222-2222-4222-8222-222222222222&taskId=${product.key.split(':')[1]}`);
    assert.equal(foreign.status, 404, 'a task of another project is not readable here');
    assert.equal((await call('/api/deliverables?workspaceId=not-a-uuid')).status, 400);
  } finally { server.close(); }
});

test('owner curation: validated keys, the project’s own rows, delivered versions only', async () => {
  const { db, server, call } = await hub(previewTables(Date.now()));
  try {
    const { body } = await call(`/api/deliverables?workspaceId=${PREVIEW_WORKSPACE}`);
    const ready = body.deliverables.find((item) => item.title === 'First-pass budget');
    const running = body.deliverables.find((item) => item.status === 'in_progress' && item.kind === 'office');
    const pin = await call('/api/deliverables/review', { workspaceId: PREVIEW_WORKSPACE, key: ready.key, pinned: true });
    assert.equal(pin.status, 200);
    assert.equal(pin.body.reviewKey, ready.reviewKey);
    assert.equal(pin.body.review.pinned, true);
    const approve = await call('/api/deliverables/review', { workspaceId: PREVIEW_WORKSPACE, key: ready.key, decision: 'approved', note: 'Use it.' });
    assert.deepEqual([approve.body.review.decision, approve.body.review.decisionKey, approve.body.review.note], ['approved', ready.key, 'Use it.']);
    assert.equal(db.tables.deliverable_reviews.length, 1, 'one row per project and chain');
    assert.equal(db.tables.deliverable_reviews[0].decided_by, 'hub-owner');
    const clear = await call('/api/deliverables/review', { workspaceId: PREVIEW_WORKSPACE, key: ready.key, decision: null });
    assert.deepEqual([clear.body.review.decision, clear.body.review.pinned], [null, true]);

    assert.equal((await call('/api/deliverables/review', { workspaceId: PREVIEW_WORKSPACE, key: 'task:../../etc', pinned: true })).status, 400);
    assert.equal((await call('/api/deliverables/review', { workspaceId: PREVIEW_WORKSPACE, key: ready.key })).status, 400, 'nothing to change');
    assert.equal((await call('/api/deliverables/review', { workspaceId: PREVIEW_WORKSPACE, key: ready.key, decision: 'merged' })).status, 400);
    assert.equal((await call('/api/deliverables/review', { workspaceId: '22222222-2222-4222-8222-222222222222', key: ready.key, pinned: true })).status, 404, 'rows of another project are refused');
    const early = await call('/api/deliverables/review', { workspaceId: PREVIEW_WORKSPACE, key: running.key, decision: 'approved' });
    assert.equal(early.status, 409, 'work in progress cannot be approved');
    assert.equal((await call('/api/deliverables/review', { workspaceId: PREVIEW_WORKSPACE, key: running.key, pinned: true })).status, 200, 'it can still be pinned');
  } finally { server.close(); }
});

test('without the V5.3 migration the board works and curation says so honestly', async () => {
  const { server, call } = await hub(previewTables(Date.now()), { failReviews: true });
  try {
    const { status, body } = await call(`/api/deliverables?workspaceId=${PREVIEW_WORKSPACE}`);
    assert.equal(status, 200);
    assert.equal(body.reviews.available, false);
    assert.equal(body.summary.total, 16);
    const ready = body.deliverables.find((item) => item.status === 'ready');
    const pin = await call('/api/deliverables/review', { workspaceId: PREVIEW_WORKSPACE, key: ready.key, pinned: true });
    assert.equal(pin.status, 503);
    assert.equal(pin.body.code, 'DELIVERABLE_REVIEWS_UNAVAILABLE');
    assert.match(pin.body.error, /not applied yet/);
  } finally { server.close(); }
});

test('the V5.3 migration is additive, isolated and service-role only', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20261005160000_deliverable_reviews.sql', import.meta.url), 'utf8');
  assert.match(sql, /create table public\.deliverable_reviews/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on table public\.deliverable_reviews from public, anon, authenticated, service_role;/);
  assert.match(sql, /grant select, insert, update, delete on table public\.deliverable_reviews to service_role;/);
  assert.doesNotMatch(sql, /\b(alter|drop) table (?!public\.deliverable_reviews)/i, 'no existing table is changed');
  assert.doesNotMatch(sql, /create (or replace )?function|grant [^;]* to (anon|authenticated)/i);
  const scenario = readFileSync(new URL('../supabase/verify/scenarios/deliverable_reviews.sql', import.meta.url), 'utf8');
  assert.match(scenario, /has_table_privilege\('anon', 'public\.deliverable_reviews', 'select'\)/);
});
