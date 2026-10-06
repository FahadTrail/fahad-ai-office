// V5.4: the Deliverables Center pages by objective instead of stopping at the
// newest 60. Every page holds all rows its objectives own, so a deliverable is
// never dropped for being old and never repeated across pages; a live refresh
// re-reads only the newest window and keeps the older pages Fahad loaded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubServer } from '../src/hub-server.js';
import { byBoardOrder, cursorOf, olderThan, parseCursor, timeKey } from '../src/hub-deliverables.js';
import { filterDeliverables, groupDeliverables, mergeObjectives, mergePages, summarizeDeliverables } from '../src/hub-ui/deliverables.js';
import { memoryPostgrest } from '../testing/fixtures/memory-postgrest.js';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minutes) => new Date(Date.UTC(2026, 9, 1, 8, 0) + minutes * 60_000).toISOString();
const brief = (stage, extra = {}) => JSON.stringify({ workflow: 'chief-research-chief', stage, ...extra });
const PROJECT = id(1);
const OTHER = id(2);
const FINANCE = id(901);
const CHIEF = id(902);
const CODING = id(903);
const JOBS = 75;
// Objectives 14..17 were created in the same instant: the first page ends
// inside that group, so the cursor has to break the tie by id.
const createdAt = (n) => (n >= 14 && n <= 17 ? at(16) : at(n));

function fixture() {
  const tables = {
    projects: [{ id: PROJECT, name: 'Long project', description: '', default_repository: 'owner/long' }, { id: OTHER, name: 'Other project', description: '', default_repository: null }],
    agents: [{ id: FINANCE, slug: 'business-finance', name: 'FINANCE' }, { id: CHIEF, slug: 'chief-of-staff', name: 'CHIEF' }, { id: CODING, slug: 'coding-agent', name: 'CODING' }],
    jobs: [], tasks: [], results: [], artifacts: [], agent_sessions: [], agent_approvals: [], events: [], deliverable_reviews: [],
  };
  for (let n = 1; n <= JOBS; n += 1) {
    const job = id(1000 + n);
    tables.jobs.push({ id: job, project_id: PROJECT, title: `Objective ${n}`, goal: `Goal ${n}`, status: 'completed', priority: 'normal', conversation_id: null, created_at: createdAt(n), completed_at: at(n + 1) });
    tables.tasks.push({ id: id(2000 + n), job_id: job, agent_id: CHIEF, title: 'Chief planning', status: 'done', brief: brief('chief_plan'), depends_on: [], sequence: 10, created_at: createdAt(n), started_at: createdAt(n), completed_at: createdAt(n), not_before: null });
    tables.tasks.push({ id: id(3000 + n), job_id: job, agent_id: FINANCE, title: `Budget ${n}`, status: 'done', brief: brief('specialist'), depends_on: [], sequence: 100, created_at: createdAt(n), started_at: createdAt(n), completed_at: at(n + 1), not_before: null });
    tables.results.push({ id: id(4000 + n), job_id: job, task_id: id(3000 + n), kind: 'task', summary: '', content: `## Summary\nBudget for objective ${n} is ${n * 100} AED${n === 2 ? ' (pomegranate stall)' : ''}.`, created_at: at(n + 1) });
    if (n % 5 === 0) tables.artifacts.push({ id: id(5000 + n), project_id: PROJECT, job_id: job, task_id: id(3000 + n), conversation_id: null, agent_slug: 'business-finance', type: 'table', title: `Budget table ${n}`, data: { columns: ['Item', 'AED'], rows: [['Venue', String(n)]] }, created_at: at(n + 1) });
  }
  // Structured outputs without an objective, spread across both pages' windows.
  for (const [n, minute] of [[1, 3], [2, 40], [3, 90]]) tables.artifacts.push({ id: id(6000 + n), project_id: PROJECT, job_id: null, task_id: null, conversation_id: null, agent_slug: 'business-finance', type: 'checklist', title: `Loose checklist ${n}`, data: { items: [] }, created_at: at(minute) });
  // CODING: its own job is the newest; the objective that launched it is old.
  const codingJob = id(1100);
  tables.jobs.push({ id: codingJob, project_id: PROJECT, title: 'Coding job', goal: 'Fix it', status: 'running', priority: 'normal', conversation_id: null, created_at: at(200), completed_at: null });
  tables.tasks.push({ id: id(3100), job_id: codingJob, agent_id: CODING, title: 'Coding Agent session', status: 'assigned', brief: JSON.stringify({ workflow: 'coding-agent' }), depends_on: [], sequence: 10, created_at: at(200), started_at: at(200), completed_at: null, not_before: null });
  tables.agent_sessions.push({ id: id(7000), workspace_id: PROJECT, job_id: codingJob, title: 'Fix the importer', objective: 'Fix it', repository: 'owner/long', status: 'completed', phase: 'report', state: {}, result: { summary: 'Fixed.' }, created_at: at(200), updated_at: at(201), completed_at: at(201) });
  tables.events.push({ id: id(8000), job_id: id(1003), task_id: null, payload: { kind: 'task_launched', session_id: id(7000) }, created_at: at(4) });
  // An older CODING session recorded without its own job (allowed by the schema).
  tables.agent_sessions.push({ id: id(7001), workspace_id: PROJECT, job_id: null, title: 'Old loose fix', objective: 'Old', repository: 'owner/long', status: 'completed', phase: 'report', state: {}, result: { summary: 'Done long ago.' }, created_at: at(6), updated_at: at(7), completed_at: at(7) });
  // Another project's work must never appear.
  tables.jobs.push({ id: id(1900), project_id: OTHER, title: 'Foreign objective', goal: 'x', status: 'completed', priority: 'normal', conversation_id: null, created_at: at(300), completed_at: at(301) });
  tables.tasks.push({ id: id(3900), job_id: id(1900), agent_id: FINANCE, title: 'Foreign budget', status: 'done', brief: brief('specialist'), depends_on: [], sequence: 100, created_at: at(300), started_at: at(300), completed_at: at(301), not_before: null });
  tables.results.push({ id: id(4900), job_id: id(1900), task_id: id(3900), kind: 'task', summary: '', content: '## Summary\nForeign.', created_at: at(301) });
  return tables;
}

async function withHub(tables, fn) {
  const server = createHubServer({ db: memoryPostgrest(tables), store: {}, host: '127.0.0.1', port: 0, accessToken: '', authEnabled: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (params) => {
    const response = await fetch(`${base}/api/deliverables?${new URLSearchParams({ workspaceId: PROJECT, ...params })}`);
    return { status: response.status, body: await response.json() };
  };
  try { return await fn(get); } finally { server.close(); }
}

const keysOf = (page) => page.deliverables.map((item) => item.key);
const expectedKeys = () => new Set([
  ...Array.from({ length: JOBS }, (_, index) => `task:${id(3001 + index)}`),
  `session:${id(7000)}`, `session:${id(7001)}`, `artifact:${id(6001)}`, `artifact:${id(6002)}`, `artifact:${id(6003)}`,
]);

test('a project with more than 60 objectives is paged without losing or repeating a deliverable', async () => {
  await withHub(fixture(), async (get) => {
    const first = await get({});
    assert.equal(first.status, 200);
    assert.equal(first.body.page.mode, 'first');
    assert.equal(first.body.page.jobs, 60);
    assert.equal(first.body.page.hasMore, true);
    assert.equal(first.body.totals.objectives, JOBS + 1, 'the true total of this project (75 objectives + 1 CODING job), never another project');
    const second = await get({ before: first.body.page.cursor });
    assert.equal(second.status, 200);
    assert.equal(second.body.page.mode, 'before');
    assert.equal(second.body.page.jobs, JOBS + 1 - 60);
    assert.equal(second.body.page.hasMore, false);
    const all = [...keysOf(first.body), ...keysOf(second.body)];
    assert.equal(new Set(all).size, all.length, 'no deliverable is repeated across pages');
    assert.deepEqual(new Set(all), expectedKeys(), 'every deliverable is reachable, including the oldest');
    assert.ok(keysOf(second.body).includes(`task:${id(3001)}`), 'the oldest objective is on the older page');
    assert.ok(!all.includes(`task:${id(3900)}`), 'another project never leaks in');
    // Artifacts stay attached to their own objective's card on their page.
    const tableCard = [...first.body.deliverables, ...second.body.deliverables].find((item) => item.key === `task:${id(3005)}`);
    assert.equal(tableCard.artifacts[0].title, 'Budget table 5');
  });
});

test('objectives created in the same instant keep one order and none is lost at the page edge', () => {
  const jobs = [14, 15, 16, 17].map((n) => ({ id: id(1000 + n), created_at: at(16) }));
  const ordered = jobs.toSorted(byBoardOrder).map((job) => job.id);
  assert.deepEqual(ordered, [id(1017), id(1016), id(1015), id(1014)], 'ties break by id, newest first');
  const cursor = parseCursor(cursorOf({ id: id(1016), created_at: at(16) }));
  assert.deepEqual(jobs.filter((job) => olderThan(job, cursor)).map((job) => job.id).sort(), [id(1014), id(1015)]);
  // Microseconds are compared exactly, whatever trailing zeros the database trims.
  assert.equal(timeKey('2026-10-05T21:04:39.1694+00:00'), timeKey('2026-10-05T21:04:39.169400+00:00'));
  assert.ok(timeKey('2026-10-05T21:04:39.169404+00:00') > timeKey('2026-10-05T21:04:39.1694+00:00'));
  assert.ok(timeKey('2026-10-05T21:04:39+00:00') < timeKey('2026-10-05T21:04:39.000001+00:00'));
});

test('cursors are validated and before/since cannot be combined', async () => {
  await withHub(fixture(), async (get) => {
    assert.equal((await get({ before: 'not-a-cursor' })).status, 400);
    assert.equal((await get({ before: `${at(1)}|${id(1)}`, since: `${at(1)}|${id(1)}` })).status, 400);
    assert.equal((await get({ since: `2026-13-45T00:00:00Z|${id(1)}` })).status, 400);
  });
});

test('a CODING card lives on its own job\'s page and keeps the objective that launched it', async () => {
  await withHub(fixture(), async (get) => {
    const first = await get({});
    const coding = first.body.deliverables.find((item) => item.key === `session:${id(7000)}`);
    assert.ok(coding, 'the session is on the newest page with its own job');
    assert.equal(coding.objective?.title, 'Objective 3', 'the launching objective is resolved even though it is on an older page');
  });
});

test('a live refresh re-reads the newest window and keeps loaded older pages intact', async () => {
  const tables = fixture();
  await withHub(tables, async (get) => {
    const first = await get({});
    const second = await get({ before: first.body.page.cursor });
    // New work arrives after both pages were loaded.
    tables.jobs.push({ id: id(1200), project_id: PROJECT, title: 'Objective new', goal: 'new', status: 'completed', priority: 'normal', conversation_id: null, created_at: at(400), completed_at: at(401) });
    tables.tasks.push({ id: id(3200), job_id: id(1200), agent_id: FINANCE, title: 'Budget new', status: 'done', brief: brief('specialist'), depends_on: [], sequence: 100, created_at: at(400), started_at: at(400), completed_at: at(401), not_before: null });
    tables.results.push({ id: id(4200), job_id: id(1200), task_id: id(3200), kind: 'task', summary: '', content: '## Summary\nNew budget.', created_at: at(401) });
    const refreshed = await get({ since: first.body.page.cursor });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.page.mode, 'since');
    assert.equal(refreshed.body.page.jobs, 61, 'the whole first window plus the new objective; nothing fell off its edge');
    assert.equal(refreshed.body.totals.objectives, JOBS + 2);
    const merged = mergePages(refreshed.body.deliverables, second.body.deliverables);
    assert.equal(merged.length, expectedKeys().size + 1);
    assert.equal(new Set(merged.map((item) => item.key)).size, merged.length, 'no duplicates after a refresh');
  });
});

test('search, filters, groups and counts work across every loaded page', async () => {
  await withHub(fixture(), async (get) => {
    const first = await get({});
    const second = await get({ before: first.body.page.cursor });
    const merged = mergePages(first.body.deliverables, second.body.deliverables);
    const found = filterDeliverables(merged, { search: 'pomegranate' }, 'en');
    assert.deepEqual(found.map((item) => item.key), [`task:${id(3002)}`], 'search reaches an older page');
    const byObjective = groupDeliverables(merged, 'objective', 'en');
    assert.ok(byObjective.some((group) => group.label === 'Objective 1'), 'grouping includes older objectives');
    const objectives = mergeObjectives(first.body.objectives, second.body.objectives);
    assert.equal(objectives.length, new Set(objectives.map((objective) => objective.id)).size);
    assert.ok(objectives.some((objective) => objective.title === 'Objective 1'));
    assert.ok(Date.parse(objectives[0].createdAt) >= Date.parse(objectives.at(-1).createdAt), 'newest objective first');
    const summary = summarizeDeliverables(merged);
    assert.equal(summary.total, merged.length);
    assert.equal(summary.counts.ready + summary.counts.in_progress + summary.counts.needs_fahad + summary.counts.needs_review + summary.counts.waiting + summary.counts.blocked, merged.length);
    const finance = filterDeliverables(merged, { agent: 'finance' }, 'en');
    assert.ok(finance.some((item) => item.key === `task:${id(3001)}`), 'employee filter includes older pages');
  });
});

test('outputs and sessions without an objective appear exactly once across pages', async () => {
  await withHub(fixture(), async (get) => {
    const first = await get({});
    const second = await get({ before: first.body.page.cursor });
    const loose = [...first.body.deliverables, ...second.body.deliverables].filter((item) => item.kind === 'artifact').map((item) => item.key);
    assert.deepEqual(loose.toSorted(), [`artifact:${id(6001)}`, `artifact:${id(6002)}`, `artifact:${id(6003)}`]);
    const looseSession = [...first.body.deliverables, ...second.body.deliverables].filter((item) => item.key === `session:${id(7001)}`);
    assert.equal(looseSession.length, 1, 'a CODING session without a job appears once');
    assert.ok(second.body.deliverables.some((item) => item.key === `session:${id(7001)}`), 'in the window of its own time (older page)');
  });
});

test('the board client loads older pages on demand and refreshes without dropping them', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/hub-ui/deliverables.js', import.meta.url), 'utf8');
  assert.match(source, /before: paging\.cursor/, 'Load older asks for the page after the cursor');
  assert.match(source, /since: paging\.windowStart/, 'a refresh after loading older pages re-reads only the newest window');
  assert.match(source, /mergePages\(head\.deliverables, paging\.older\)/, 'the board shows every loaded page once');
  assert.match(source, /summarizeDeliverables\(items\(\)\)/, 'header counts cover everything loaded');
  assert.match(source, /objectivesShown\(/, 'the header says how many objectives are shown out of the true total');
  assert.doesNotMatch(source, /JOB_WINDOW/);
});
