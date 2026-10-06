// V5.4 certification of the deliverable review actions through the real Hub
// handlers: every action survives a reload, a decision stays on the exact
// version it was made on, one project's curation never reaches another
// project, and nothing is readable or writable without the owner session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHubServer } from '../src/hub-server.js';
import { memoryPostgrest } from '../testing/fixtures/memory-postgrest.js';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minutes) => new Date(Date.UTC(2026, 9, 2, 9, 0) + minutes * 60_000).toISOString();
const brief = (stage, extra = {}) => JSON.stringify({ workflow: 'chief-research-chief', stage, ...extra });
const A = id(1);
const B = id(2);
const FINANCE = id(901);

function tables() {
  return {
    projects: [{ id: A, name: 'Project A' }, { id: B, name: 'Project B' }],
    agents: [{ id: FINANCE, slug: 'business-finance', name: 'FINANCE' }],
    jobs: [
      { id: id(100), project_id: A, title: 'Pilot budget', goal: 'Budget', status: 'completed', priority: 'normal', created_at: at(0) },
      { id: id(200), project_id: B, title: 'Other budget', goal: 'Budget', status: 'completed', priority: 'normal', created_at: at(0) },
    ],
    tasks: [
      { id: id(10), job_id: id(100), agent_id: FINANCE, title: 'Budget', status: 'done', brief: brief('specialist'), depends_on: [], sequence: 100, created_at: at(1), started_at: at(1), completed_at: at(2) },
      { id: id(20), job_id: id(200), agent_id: FINANCE, title: 'Budget B', status: 'done', brief: brief('specialist'), depends_on: [], sequence: 100, created_at: at(1), started_at: at(1), completed_at: at(2) },
    ],
    results: [
      { id: id(50), job_id: id(100), task_id: id(10), kind: 'task', summary: '', content: '## Summary\nVersion one: 38,000 AED.', created_at: at(2) },
      { id: id(60), job_id: id(200), task_id: id(20), kind: 'task', summary: '', content: '## Summary\nProject B budget.', created_at: at(2) },
    ],
    artifacts: [], agent_sessions: [], agent_approvals: [], events: [], deliverable_reviews: [],
  };
}

async function hub(rows, options = {}) {
  const db = memoryPostgrest(rows);
  const server = createHubServer({ db, store: {}, host: '127.0.0.1', port: 0, accessToken: '', authEnabled: false, ...options, ...(options.authClient ? { authClient: options.authClient } : {}) });
  if (!server.listening) await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) } : { headers });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  return { db, server, call, base };
}
const board = async (call, project = A) => (await call(`/api/deliverables?workspaceId=${project}`)).body;
const card = (view, key) => view.deliverables.find((item) => item.key === key || item.reviewKey === key);

test('every review action persists across a reload: pin, unpin, approve, revision, archive, undo', async () => {
  const { server, call, db } = await hub(tables());
  try {
    const key = `task:${id(10)}`;
    const review = (change) => call('/api/deliverables/review', { workspaceId: A, key, ...change });
    assert.equal((await review({ pinned: true })).status, 200);
    assert.equal(card(await board(call), key).review.pinned, true, 'pinned after reload');
    assert.equal((await review({ pinned: false })).status, 200);
    assert.equal(card(await board(call), key).review.pinned, false, 'unpinned after reload');

    assert.equal((await review({ decision: 'approved', note: 'Go' })).status, 200);
    let view = await board(call);
    assert.deepEqual([card(view, key).status, card(view, key).reason.code, card(view, key).review.decisionKey], ['ready', 'approved', key]);

    assert.equal((await review({ decision: 'revision_requested', note: 'Lower the setup cost' })).status, 200);
    view = await board(call);
    assert.deepEqual([card(view, key).status, card(view, key).reason.code, card(view, key).review.note], ['needs_review', 'revision_requested', 'Lower the setup cost']);

    assert.equal((await review({ archived: true })).status, 200);
    view = await board(call);
    assert.equal(card(view, key).review.archived, true);
    assert.equal(view.summary.total, 0, 'archived work leaves the counts');
    assert.equal(view.summary.archived, 1);
    assert.equal((await review({ archived: false, decision: null })).status, 200);
    view = await board(call);
    assert.deepEqual([card(view, key).review.archived, card(view, key).review.decision, card(view, key).status], [false, null, 'ready']);
    assert.equal(db.tables.deliverable_reviews.length, 1, 'one row for the chain, never a duplicate');
    assert.equal(db.tables.deliverable_reviews[0].project_id, A, 'stored under its own project');
  } finally { server.close(); }
});

test('a decision belongs to the exact version: a newer version starts clean', async () => {
  const rows = tables();
  const { server, call } = await hub(rows);
  try {
    const v1 = `task:${id(10)}`;
    assert.equal((await call('/api/deliverables/review', { workspaceId: A, key: v1, decision: 'approved' })).status, 200);
    // FINANCE delivers a revised version afterwards.
    rows.tasks.push({ id: id(11), job_id: id(100), agent_id: FINANCE, title: 'Budget', status: 'done', brief: brief('specialist', { revision: 'Lower setup', revisesTaskId: id(10) }), depends_on: [], sequence: 500, created_at: at(5), started_at: at(5), completed_at: at(6) });
    rows.results.push({ id: id(51), job_id: id(100), task_id: id(11), kind: 'task', summary: '', content: '## Summary\nVersion two: 31,000 AED.', created_at: at(6) });
    const view = await board(call);
    const item = card(view, v1);
    assert.equal(item.key, `task:${id(11)}`, 'the card now shows version two');
    assert.equal(item.reviewKey, v1, 'curation stays on the chain');
    assert.equal(item.review.decisionKey, v1, 'the approval is recorded for version one only');
    assert.notEqual(item.reason?.code, 'approved', 'version two is not shown as approved');
    // Approving the new version is a separate, explicit decision.
    const approveV2 = await call('/api/deliverables/review', { workspaceId: A, key: `task:${id(11)}`, decision: 'approved' });
    assert.equal(approveV2.body.review.decisionKey, `task:${id(11)}`);
  } finally { server.close(); }
});

test('one project’s curation never reaches another project', async () => {
  const rows = tables();
  // A stray row stored under project B for project A's deliverable key.
  rows.deliverable_reviews.push({ project_id: B, deliverable_key: `task:${id(10)}`, pinned: true, archived: true, decision: 'approved', decision_key: `task:${id(10)}`, decided_at: at(3), updated_at: at(3) });
  const { server, call, db } = await hub(rows);
  try {
    const item = card(await board(call, A), `task:${id(10)}`);
    assert.deepEqual([item.review, item.status], [null, 'ready'], 'project A is unaffected by rows of project B');
    const refused = await call('/api/deliverables/review', { workspaceId: B, key: `task:${id(10)}`, pinned: true });
    assert.equal(refused.status, 404, 'a key from project A cannot be curated under project B');
    const refusedOther = await call('/api/deliverables/review', { workspaceId: A, key: `task:${id(20)}`, decision: 'approved' });
    assert.equal(refusedOther.status, 404, 'a key from project B cannot be curated under project A');
    assert.equal(db.tables.deliverable_reviews.length, 1, 'no row was written by the refused calls');
    assert.equal((await board(call, B)).deliverables.some((entry) => entry.key === `task:${id(10)}`), false, 'project A work never appears on project B');
  } finally { server.close(); }
});

test('nothing is readable or writable without the owner session', async () => {
  const authClient = {
    verifyOtp: async () => ({ error: null, data: { user: { email: 'owner@example.com' }, session: { access_token: 'owner-session' } } }),
    getUser: async (token) => (token === 'owner-session' ? { error: null, data: { user: { email: 'owner@example.com' } } } : { error: new Error('invalid'), data: null }),
  };
  const { server, call, db } = await hub(tables(), { authEnabled: true, ownerEmail: 'owner@example.com', authClient });
  try {
    const read = await call(`/api/deliverables?workspaceId=${A}`);
    assert.equal(read.status, 401);
    assert.equal(read.body.error, 'HUB_UNAUTHORIZED');
    assert.equal((await call(`/api/deliverables/report?workspaceId=${A}&taskId=${id(10)}`)).status, 401);
    const write = await call('/api/deliverables/review', { workspaceId: A, key: `task:${id(10)}`, pinned: true });
    assert.equal(write.status, 401);
    const forged = await call('/api/deliverables/review', { workspaceId: A, key: `task:${id(10)}`, pinned: true }, { cookie: 'hub_session=forged-token' });
    assert.equal(forged.status, 401, 'a forged session is refused');
    assert.equal(db.tables.deliverable_reviews.length, 0, 'no unauthenticated write reached the table');
    const login = await call('/api/auth/verify-otp', { email: 'owner@example.com', token: '123456' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const owner = await call('/api/deliverables/review', { workspaceId: A, key: `task:${id(10)}`, decision: 'approved' }, { cookie });
    assert.equal(owner.status, 200);
    assert.equal(db.tables.deliverable_reviews[0].decided_by, 'owner@example.com', 'the decision records the signed-in owner');
  } finally { server.close(); }
});
