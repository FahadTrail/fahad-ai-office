import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHubServer } from '../src/hub-server.js';
import { objectiveIndex } from '../src/hub-office-ops.js';
import { officeVisible } from '../src/hub-office.js';
import { memoryPostgrest } from '../testing/fixtures/memory-postgrest.js';
import { attemptBilling, cleanupPreview, currentWork, executiveSummaryOf, jobLifecycle, recommendProject, sessionLifecycle, taskExecution } from '../src/domain/index.js';
import { CONFIRMED_TEST_JOB_IDS } from '../src/domain/work-registry.js';
import { employeeWorkloads } from '../src/domain/workload.js';
import { attentionItems } from '../src/domain/attention.js';
import { normalizeWorker, workerBoard } from '../src/domain/workers.js';
import { continuitySummary } from '../src/domain/continuity-summary.js';
import { objectiveSummary } from '../src/domain/objectives.js';
import { projectSummary } from '../src/domain/projects.js';
import { WorkStream } from '../src/domain/stream.js';
import { spendOf } from '../src/domain/costs.js';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PROJECT = id(10);
const OTHER = id(11);
const CHIEF = id(1);
const RESEARCH = id(2);
const FINANCE = id(3);
const CODING = id(4);
const PRODUCT = id(5);
const AGENTS = [
  { id: CHIEF, slug: 'chief-of-staff', name: 'CHIEF' },
  { id: RESEARCH, slug: 'research-strategy', name: 'RESEARCH' },
  { id: FINANCE, slug: 'business-finance', name: 'FINANCE' },
  { id: CODING, slug: 'coding-agent', name: 'CODING' },
  { id: PRODUCT, slug: 'product-tech', name: 'PRODUCT' },
];
const BENCHMARK = [...CONFIRMED_TEST_JOB_IDS][0];
const brief = (stage, extra = {}) => JSON.stringify({ workflow: 'chief-research-chief', stage, ...extra });
const at = (minutes) => new Date(Date.UTC(2026, 9, 9, 12, 0) - minutes * 60_000).toISOString();

function job(fields) {
  return { progress: 0, conversation_id: null, cost_usd: 0, final_summary: null, completed_at: null, created_at: at(10), ...fields };
}
function task(fields) {
  return { brief: brief('specialist'), depends_on: [], sequence: 100, started_at: null, completed_at: null, created_at: at(9), not_before: null, wait_info: null, ...fields };
}

test('the confirmed-test registry matches the explicit selection script', () => {
  const sql = readFileSync(new URL('../ops/cleanup/2026-10-09-test-data-selection.sql', import.meta.url), 'utf8');
  const ids = [...sql.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)].map((match) => match[0].toLowerCase());
  assert.equal(new Set(ids).size, 82);
  assert.deepEqual([...CONFIRMED_TEST_JOB_IDS].sort(), [...new Set(ids)].sort());
});

test('no active objective yields an empty current state and does not promote history', () => {
  const completed = job({ id: id(100), project_id: PROJECT, title: 'Launch plan', goal: 'Launch', status: 'completed', completed_at: at(1) });
  const work = currentWork({ jobs: [completed], tasks: [], agents: AGENTS });
  assert.equal(work.empty, true);
  assert.equal(work.current, null);
  assert.deepEqual(work.active, []);
  assert.equal(work.counts.real, 0);
  const legacy = objectiveIndex([completed]);
  assert.equal(legacy.currentId, completed.id, 'the existing operations view is unchanged');
});

test('completed, cancelled and failed objectives are history, with failure reason and owner attention kept', () => {
  const completed = job({ id: id(100), project_id: PROJECT, title: 'Done', goal: 'Done', status: 'completed', completed_at: at(1) });
  const cancelled = job({ id: id(101), project_id: PROJECT, title: 'Stopped', goal: 'Stop', status: 'cancelled', completed_at: at(2) });
  const failed = job({ id: id(102), project_id: PROJECT, title: 'Broke', goal: 'Break', status: 'failed', completed_at: at(3) });
  const failedTask = task({ id: id(201), job_id: failed.id, agent_id: RESEARCH, title: 'Research', status: 'failed', wait_info: { detail: 'The source timed out.' } });
  const approval = { id: id(301), job_id: failed.id, task_id: failedTask.id, status: 'pending', title: 'Retry the paid route?' };
  assert.equal(jobLifecycle(completed).category, 'COMPLETED');
  assert.equal(jobLifecycle(completed).current, false);
  assert.equal(jobLifecycle(cancelled).category, 'CANCELLED');
  assert.equal(currentWork({ jobs: [completed, cancelled, failed], tasks: [failedTask], approvals: [approval], agents: AGENTS }).empty, true);
  const summary = objectiveSummary({ job: failed, tasks: [failedTask], agents: AGENTS, approvals: [approval] });
  assert.equal(summary.lifecycle, 'FAILED');
  assert.equal(summary.lane, 'HISTORY');
  assert.equal(summary.current, false);
  assert.equal(summary.nextAction.code, 'OWNER_REVIEW');
  assert.match(summary.nextAction.text, /timed out/);
  const doneTask = task({ id: id(202), job_id: completed.id, agent_id: RESEARCH, title: 'Old research', status: 'running' });
  assert.equal(taskExecution(doneTask, { job: completed, tasks: [doneTask] }).current, false);
});

test('an employee with no current task is AVAILABLE, and three tasks stay distinct across projects', () => {
  const idle = employeeWorkloads({ agents: AGENTS, jobs: [], tasks: [] }).find((employee) => employee.key === 'creative');
  assert.equal(idle.availability, 'AVAILABLE');
  assert.deepEqual(idle.currentTasks, []);
  const first = job({ id: id(100), project_id: PROJECT, title: 'One', goal: 'One', status: 'running' });
  const second = job({ id: id(101), project_id: OTHER, title: 'Two', goal: 'Two', status: 'running' });
  const tasks = [
    task({ id: id(1), job_id: first.id, agent_id: RESEARCH, title: 'Executing', status: 'running', started_at: at(1) }),
    task({ id: id(2), job_id: first.id, agent_id: RESEARCH, title: 'Assigned', status: 'assigned' }),
    task({ id: id(6), job_id: second.id, agent_id: PRODUCT, title: 'Product', status: 'running', started_at: at(1) }),
    task({ id: id(3), job_id: second.id, agent_id: RESEARCH, title: 'Waiting', status: 'queued', depends_on: [id(6)] }),
    task({ id: id(4), job_id: first.id, agent_id: RESEARCH, title: 'Finished', status: 'done', completed_at: at(2) }),
  ];
  const research = employeeWorkloads({ agents: AGENTS, jobs: [first, second], tasks }).find((employee) => employee.key === 'research');
  assert.equal(research.availability, 'BUSY');
  assert.deepEqual(research.currentTasks.map((item) => item.posture).sort(), ['assigned', 'executing', 'waiting']);
  assert.equal(research.workload.projects, 2);
  assert.equal(research.currentTasks.some((item) => item.title === 'Finished'), false);
  assert.equal(research.completedWork.lifetime, 'UNKNOWN');
  const onlyDone = employeeWorkloads({
    agents: AGENTS,
    jobs: [job({ id: id(110), project_id: PROJECT, title: 'Past', goal: 'Past', status: 'completed', completed_at: at(1) })],
    tasks: [task({ id: id(5), job_id: id(110), agent_id: FINANCE, title: 'Budget', status: 'done', completed_at: at(1) })],
  }).find((employee) => employee.key === 'finance');
  assert.equal(onlyDone.availability, 'AVAILABLE');
});

test('a revision does not duplicate the current assignment, and a finished coding session is not working', () => {
  const objective = job({ id: id(100), project_id: PROJECT, title: 'Revise', goal: 'Revise', status: 'running' });
  const original = task({ id: id(1), job_id: objective.id, agent_id: RESEARCH, title: 'Market', status: 'done', completed_at: at(3) });
  const revision = task({ id: id(2), job_id: objective.id, agent_id: RESEARCH, title: 'Market (revision)', status: 'running', brief: brief('specialist', { revision: 'Tighten the claim', revisesTaskId: original.id }), started_at: at(1) });
  const summary = objectiveSummary({ job: objective, tasks: [original, revision], agents: AGENTS });
  assert.deepEqual(summary.orchestration.currentAssignments.map((item) => item.taskId), [revision.id]);
  assert.equal(summary.orchestration.revisionRound, 1);
  const research = employeeWorkloads({ agents: AGENTS, jobs: [objective], tasks: [original, revision] }).find((employee) => employee.key === 'research');
  assert.deepEqual(research.currentTasks.map((item) => item.taskId), [revision.id]);
  const session = { id: id(9), task_id: id(8), job_id: id(120), title: 'Fix import', status: 'completed', completed_at: at(1) };
  assert.equal(sessionLifecycle(session).working, false);
  assert.equal(sessionLifecycle(session).current, false);
  const stale = task({ id: id(8), job_id: id(120), agent_id: CODING, title: 'Coding', status: 'running', brief: JSON.stringify({ workflow: 'coding-agent' }) });
  const coding = employeeWorkloads({
    agents: AGENTS,
    jobs: [job({ id: id(120), project_id: PROJECT, title: 'Code', goal: 'Code', status: 'running' })],
    tasks: [stale],
    sessions: [session],
  }).find((employee) => employee.key === 'coding');
  assert.equal(coding.availability, 'AVAILABLE');
  assert.equal(coding.currentTasks.length, 0);
});

test('historical benchmarks stay out of current work; a live test is identified and not counted as real', () => {
  const benchmark = job({ id: BENCHMARK, project_id: PROJECT, title: 'Morning Harbor launch', goal: 'A real-looking title', status: 'completed', completed_at: at(1) });
  assert.equal(officeVisible(benchmark), false);
  const live = job({ id: id(100), project_id: PROJECT, title: 'Router smoke', goal: 'smoke the router', status: 'running' });
  const work = currentWork({ jobs: [benchmark, live], tasks: [task({ id: id(1), job_id: live.id, agent_id: CHIEF, title: 'Plan', status: 'running', brief: brief('chief_plan') })], agents: AGENTS });
  assert.equal(work.empty, true);
  assert.equal(work.active.length, 0);
  assert.equal(work.activeTests.length, 1);
  assert.equal(work.activeTests[0].classification.class, 'TEST');
  assert.equal(work.activeTests[0].classification.identified, true);
  assert.equal(work.counts.real, 0);
  assert.equal(work.current, null);
});

test('deliverable summaries are complete or honestly missing, and capacity waits are not owner approvals', () => {
  const present = executiveSummaryOf({ summary: '', content: '## Summary\nThe launch needs two weeks.\n\n## Work\nFull plan that must not be cut.' });
  assert.equal(present.status, 'PRESENT');
  assert.equal(present.text, 'The launch needs two weeks.');
  assert.equal(executiveSummaryOf({ summary: '', content: '## Work\nOnly the full deliverable.' }).status, 'MISSING');
  const waiting = job({ id: id(100), project_id: PROJECT, title: 'Capacity', goal: 'Wait', status: 'running' });
  const held = task({ id: id(1), job_id: waiting.id, agent_id: RESEARCH, title: 'Research', status: 'queued', not_before: '2026-10-09T18:00:00.000Z', wait_info: { reason: 'NO_FREE_CAPACITY', detail: 'Waiting for free model capacity — will resume automatically.' } });
  const life = jobLifecycle(waiting, { tasks: [held], now: Date.parse('2026-10-09T12:00:00.000Z') });
  assert.equal(life.category, 'WAITING');
  assert.equal(life.reason, 'capacity');
  assert.equal(life.ownerAttention.length, 0);
  const items = attentionItems({ jobs: [waiting], tasks: [held], now: Date.parse('2026-10-09T12:00:00.000Z') });
  assert.equal(items.length, 0);
  const finished = job({ id: id(101), project_id: PROJECT, title: 'Quiet', goal: 'Quiet', status: 'completed', completed_at: at(1) });
  assert.equal(attentionItems({ jobs: [finished], tasks: [] }).length, 0);
});

test('unknown numbers stay unknown, and a zero cost without a billing class is not free', () => {
  assert.equal(spendOf(null).basis, 'UNKNOWN');
  assert.deepEqual(attemptBilling({ cost_usd: 0, model: 'some-model', route: [] }), { billing: 'UNKNOWN', basis: 'ZERO_WITHOUT_CLASS' });
  assert.equal(attemptBilling({ cost_usd: 0, model: 'some-model', route: [{ billingClass: 'free' }] }).billing, 'free');
  assert.equal(attemptBilling({ cost_usd: 0, model: 'some-model', route: [{ billingClass: 'paid' }] }).billing, 'paid');
  const worker = normalizeWorker({ key: 'office', enabled: true, health: 'unknown', health_basis: 'UNKNOWN' });
  assert.equal(worker.operational, 'UNKNOWN');
  assert.equal(worker.healthy, 'UNKNOWN');
  assert.equal(worker.authenticated, 'UNKNOWN');
  assert.equal(worker.enabled, true);
  const unmeasured = workerBoard([], { measured: false }).find((entry) => entry.key === 'office');
  assert.equal(unmeasured.enabled, 'UNKNOWN');
  assert.equal(unmeasured.operational, 'UNKNOWN');
  assert.equal(worker.countsAsEmployee, false);
  const disabled = normalizeWorker({ key: 'claude-code', display_name: 'Claude Code', kind: 'cli', enabled: false, health: 'unknown' });
  assert.equal(disabled.operational, 'DISABLED');
  assert.equal(disabled.countsAsEmployee, false);
  const manual = normalizeWorker({ key: 'antigravity', enabled: true, health: 'healthy', last_seen_at: new Date().toISOString() });
  assert.equal(manual.operational, 'MANUAL_ONLY');
  assert.equal(manual.countsAsEmployee, false);
  assert.equal(continuitySummary({}).owner.activeSessions, 'UNKNOWN');
  assert.equal(continuitySummary({}).safety.leaseOwnership, 'enforced-by-runtime');
});

test('a completed objective does not archive its project, and the default project ignores certification names', () => {
  const project = { id: PROJECT, name: 'Fahad AI Office', status: 'active', description: '', default_repository: null };
  const summary = projectSummary({
    project,
    jobs: [job({ id: id(100), project_id: PROJECT, title: 'Done', goal: 'Done', status: 'completed', completed_at: at(1) })],
  });
  assert.equal(summary.archived, false);
  assert.equal(summary.status, 'active');
  assert.equal(summary.overview.activeObjectives, 0);
  assert.equal(summary.completedObjectives.length, 1);
  const projects = [
    { id: id(1), name: 'CERTIFICATION V5.4 (test, safe to delete)', status: 'active' },
    { id: PROJECT, name: 'Fahad AI Office', status: 'active' },
  ];
  assert.equal(recommendProject(projects, id(1)).id, PROJECT);
});

test('cleanup preview is fail-closed, keeps a shared conversation, and does not delete', () => {
  const testId = BENCHMARK;
  const realId = id(100);
  const conversation = id(50);
  const preview = cleanupPreview({
    selectedIds: [testId],
    jobs: [
      { id: testId, title: 'smoke', goal: 'smoke', conversation_id: conversation, status: 'completed' },
      { id: realId, title: 'Glossary', goal: 'Add glossary', conversation_id: conversation, status: 'completed' },
    ],
    tasks: [{ id: id(1), job_id: testId }],
    runs: [], events: [], results: [], handoffs: [], artifacts: [], modelAttempts: [], toolExecutions: [],
    agentSessions: [{ id: id(2), job_id: realId, conversation_id: conversation }],
    agentEvents: [], agentCheckpoints: [], knowledgeItems: [], conversations: [{ id: conversation }], continuityTasks: [],
  });
  assert.equal(preview.executed, false);
  assert.equal(preview.ready, true);
  assert.equal(preview.counts.jobs, 1);
  assert.equal(preview.counts.tasks, 1);
  assert.deepEqual(preview.keptConversations, [conversation]);
  assert.match(preview.sql, /rollback;/);
  assert.doesNotMatch(preview.sql, /\bdelete from\b/i);
  const unsafe = cleanupPreview({ selectedIds: [realId], jobs: [{ id: realId, title: 'Real', goal: 'Real', status: 'completed' }], tasks: [], runs: [], events: [], results: [], handoffs: [], artifacts: [], modelAttempts: [], toolExecutions: [], agentSessions: [], agentEvents: [], agentCheckpoints: [], knowledgeItems: [], conversations: [] });
  assert.equal(unsafe.ready, false);
  assert.equal(unsafe.blockers[0].code, 'NOT_CONFIRMED_TEST');
});

function fixture() {
  const running = job({ id: id(100), project_id: PROJECT, title: 'Active launch', goal: 'Launch the stall', status: 'running', created_at: at(5) });
  const done = job({ id: id(101), project_id: PROJECT, title: 'Completed brief', goal: 'Write the brief', status: 'completed', completed_at: at(30), created_at: at(40) });
  const foreign = job({ id: id(102), project_id: OTHER, title: 'Other project', goal: 'Other', status: 'running', created_at: at(4) });
  const benchmark = job({ id: BENCHMARK, project_id: PROJECT, title: 'Quiet benchmark', goal: 'benchmark the router', status: 'completed', completed_at: at(20), created_at: at(21) });
  return {
    projects: [
      { id: PROJECT, name: 'Fahad AI Office', description: '', status: 'active', default_repository: 'FahadTrail/fahad-ai-office', created_at: at(100) },
      { id: OTHER, name: 'CERTIFICATION V5.4 (test, safe to delete)', description: '', status: 'active', default_repository: null, created_at: at(90) },
    ],
    agents: AGENTS,
    jobs: [running, done, foreign, benchmark],
    tasks: [
      task({ id: id(201), job_id: running.id, agent_id: CHIEF, title: 'Plan', status: 'done', brief: brief('chief_plan'), completed_at: at(4) }),
      task({ id: id(202), job_id: running.id, agent_id: RESEARCH, title: 'Market', status: 'running', started_at: at(2) }),
      task({ id: id(203), job_id: running.id, agent_id: FINANCE, title: 'Budget', status: 'queued', depends_on: [id(202)] }),
      task({ id: id(204), job_id: done.id, agent_id: RESEARCH, title: 'Old market', status: 'done', completed_at: at(30) }),
      task({ id: id(205), job_id: foreign.id, agent_id: PRODUCT, title: 'Foreign', status: 'running', started_at: at(1) }),
    ],
    results: [
      { id: id(301), job_id: done.id, task_id: id(204), agent_id: RESEARCH, kind: 'final', summary: '', content: '## Summary\nThe brief is ready.\n\n## Work\nFull brief.', created_at: at(30) },
      { id: id(302), job_id: benchmark.id, task_id: null, agent_id: CHIEF, kind: 'task', summary: '', content: '## Summary\nBenchmark output.', created_at: at(20) },
    ],
    approvals: [],
    agent_sessions: [
      { id: id(401), workspace_id: PROJECT, job_id: id(103), task_id: id(206), conversation_id: null, title: 'Finished session', objective: 'Done', status: 'completed', phase: 'done', updated_at: at(8), completed_at: at(8), created_at: at(12) },
    ],
    agent_approvals: [],
    events: [{ id: 1, job_id: running.id, type: 'activity', message: 'working', payload: {}, created_at: at(1) }],
    artifacts: [],
    files: [],
    model_attempts: [],
    conversations: [{ id: id(501), project_id: PROJECT, title: 'Launch chat', archived: false, updated_at: at(5), last_message_at: at(5) }],
    coding_workers: [
      { key: 'office', display_name: 'Fahad Office Coding Agent', kind: 'native', enabled: true, health: 'unknown', health_basis: 'UNKNOWN', last_seen_at: null },
      { key: 'claude-code', display_name: 'Claude Code', kind: 'cli', enabled: false, health: 'unknown', health_basis: 'UNKNOWN', last_seen_at: null },
    ],
    runs: [], handoffs: [], tool_executions: [], agent_events: [], agent_checkpoints: [], knowledge_items: [], continuity_tasks: [],
    coding_worker_sessions: [], coding_leases: [], coding_checkpoints: [], coding_handoffs: [],
  };
}

async function withHub(fn) {
  const server = createHubServer({ db: memoryPostgrest(fixture()), store: {}, host: '127.0.0.1', port: 0, accessToken: '', authEnabled: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path) => {
    const response = await fetch(`${base}${path}`);
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  try { return await fn(get, base); }
  finally { server.close(); }
}

test('work API: empty-of-history current state, isolation, results, employees and backward compatible jobs', async () => {
  await withHub(async (get) => {
    const current = await get(`/api/work/current?workspaceId=${PROJECT}`);
    assert.equal(current.status, 200);
    assert.equal(current.body.empty, false);
    assert.equal(current.body.active.length, 1);
    assert.equal(current.body.active[0].id, id(100));
    assert.equal(current.body.activeTests.length, 0);
    assert.equal(current.body.current.id, id(100));
    const history = await get(`/api/work/history?workspaceId=${PROJECT}`);
    assert.ok(history.body.objectives.some((item) => item.id === id(101)));
    assert.ok(history.body.objectives.some((item) => item.id === BENCHMARK && item.classification.class === 'TEST'));
    assert.equal(history.body.objectives.some((item) => item.id === id(100)), false);
    const foreign = await get(`/api/work/objectives/${id(102)}?workspaceId=${PROJECT}`);
    assert.equal(foreign.status, 404);
    const own = await get(`/api/work/objectives/${id(100)}?workspaceId=${PROJECT}&tier=executive`);
    assert.equal(own.status, 200);
    assert.equal(own.body.objective.lifecycle, 'ACTIVE');
    assert.equal(own.body.objective.nextAction.code, 'IN_PROGRESS');
    assert.equal(own.body.objective.technical, undefined);
    const technical = await get(`/api/work/objectives/${id(100)}?workspaceId=${PROJECT}&tier=technical`);
    assert.ok(technical.body.objective.technical);
    const employees = await get(`/api/work/employees?workspaceId=${PROJECT}`);
    const research = employees.body.employees.find((employee) => employee.key === 'research');
    const product = employees.body.employees.find((employee) => employee.key === 'product');
    assert.equal(research.availability, 'BUSY');
    assert.equal(research.currentTasks.length, 1);
    assert.equal(product.availability, 'AVAILABLE');
    const ownerScope = await get(`/api/work/employees?workspaceId=${PROJECT}&scope=owner`);
    const ownerProduct = ownerScope.body.employees.find((employee) => employee.key === 'product');
    assert.equal(ownerProduct.availability, 'BUSY');
    assert.equal(ownerProduct.workload.projects, 1);
    const results = await get(`/api/work/results?workspaceId=${PROJECT}`);
    assert.equal(results.body.results.length, 1);
    assert.equal(results.body.results[0].executiveSummary, 'The brief is ready.');
    assert.equal(results.body.results[0].summaryStatus, 'PRESENT');
    const missing = await get(`/api/work/results/${id(302)}?workspaceId=${OTHER}`);
    assert.equal(missing.status, 404);
    const full = await get(`/api/work/results/${id(301)}?workspaceId=${PROJECT}&view=full`);
    assert.match(full.body.result.fullContent, /Full brief/);
    const projects = await get('/api/work/projects?savedId=' + OTHER);
    assert.equal(projects.body.defaultProjectId, PROJECT);
    const jobs = await get(`/api/jobs?workspaceId=${PROJECT}`);
    assert.equal(jobs.status, 200);
    assert.ok(Array.isArray(jobs.body.jobs));
    const workspaces = await get('/api/workspaces');
    assert.equal(workspaces.status, 200, 'the work prefix must not claim /api/workspaces');
    assert.ok(Array.isArray(workspaces.body.workspaces));
    const workflows = await get(`/api/workflows?workspaceId=${PROJECT}`);
    assert.equal(workflows.status, 200, 'the work prefix must not claim /api/workflows');
    assert.ok(Array.isArray(workflows.body.workflows));
    const contract = await get('/api/work');
    assert.equal(contract.body.contract, 'fahad-work-platform/1');
    const workers = await get('/api/work/workers');
    assert.equal(workers.status, 200);
    const claude = workers.body.workers.find((worker) => worker.key === 'claude-code');
    assert.equal(claude.operational, 'DISABLED');
    assert.equal(claude.countsAsEmployee, false);
    const sessions = await get(`/api/work/sessions?workspaceId=${PROJECT}&scope=history`);
    assert.equal(sessions.body.sessions[0].working, false);
    assert.equal(sessions.body.sessions[0].current, false);
    const attention = await get(`/api/work/attention?workspaceId=${PROJECT}`);
    assert.equal(attention.status, 200);
    assert.equal(attention.body.items.length, 0);
    const preview = await get('/api/work/cleanup-preview');
    assert.equal(preview.body.preview.executed, false);
    assert.match(preview.body.preview.sql, /rollback;/);
    const diagnostics = await get(`/api/work/diagnostics?workspaceId=${PROJECT}`);
    assert.equal(diagnostics.body.summary.costs.totalSpendUsd, 0);
    assert.equal(diagnostics.body.summary.continuity.safety.oneWriter, 'enforced-by-runtime');
  });
});

test('the work stream reconnects with a catch-up refetch and does not push when nothing changed', async () => {
  const db = memoryPostgrest(fixture());
  const stream = new WorkStream({ db, watchMs: 20 });
  const writes = [];
  const listeners = {};
  const response = { writeHead: () => {}, write: (chunk) => writes.push(chunk), end: () => {}, on: (event, fn) => { listeners[event] = fn; }, close: () => listeners.close?.() };
  stream.subscribe(PROJECT, response, { lastEventId: 'stale-cursor' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(writes.some((chunk) => chunk.includes('event: ready')));
  assert.ok(writes.some((chunk) => chunk.includes('event: catchup') && chunk.includes('missed')));
  const before = writes.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(writes.length, before);
  db.tables.events.push({ id: 50, job_id: id(100), type: 'activity', message: 'next', payload: {}, created_at: at(0) });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(writes.some((chunk) => chunk.includes('event: change')));
  response.close();
  assert.equal(stream.rooms.size, 0);
});

test('platform indexes are additive and the cleanup script cannot commit a delete', () => {
  const migration = readFileSync(new URL('../supabase/migrations/20261009160000_platform_work_indexes.sql', import.meta.url), 'utf8');
  assert.match(migration, /create index jobs_project_current_idx/);
  assert.doesNotMatch(migration, /\b(drop|delete|update|alter table)\b/i);
  const preview = readFileSync(new URL('../ops/cleanup/platform-foundation-cleanup-preview.sql', import.meta.url), 'utf8');
  assert.match(preview, /rollback;/);
  assert.doesNotMatch(preview, /\bdelete from\b/i);
});
