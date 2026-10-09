// Live Operations (2026-10-09): one objective as it really runs — CHIEF's
// command and delegation tree, agent states, dependencies and waiting reasons,
// revision rounds, handoffs, deliverables, provider switches, the readable
// timeline, Needs Fahad, objective selection, and the Arabic-first board.
// The main fixture is the REAL production acceptance objective of 2026-10-09
// (read-only export, harmless labelled test content).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isTestObjective, objectiveIndex, operationsView, taskOpsState } from '../src/hub-office-ops.js';
import { opsCopy, opsDuration, prettyModel, renderObjectiveStrip, renderOperations, timelineText } from '../src/hub-ui/office-ops.js';
import { memoryPostgrest } from '../testing/fixtures/memory-postgrest.js';
import { previewTables, PREVIEW_WORKSPACE } from '../testing/fixtures/hub-preview-data.js';
import { handleOperationsApi } from '../src/hub-office-ops.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const FIXTURE = JSON.parse(read('test/fixtures/ops-acceptance-2026-10-09.json'));
const AFTER = Date.parse('2026-10-09T11:10:00Z');
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const view = operationsView({ ...FIXTURE, now: AFTER });

// The same objective as it looked at a given moment: rows after `at` do not exist yet.
function asOf(at) {
  const t = Date.parse(at);
  const before = (value) => value && Date.parse(value) <= t;
  const started = (task) => FIXTURE.events.filter((event) => event.task_id === task.id && event.type === 'agent_started').map((event) => event.created_at).sort()[0] || task.started_at;
  const tasks = FIXTURE.tasks.filter((task) => before(task.created_at)).map((task) => ({
    ...task,
    status: before(task.completed_at) ? task.status : before(started(task)) ? 'running' : 'queued',
    completed_at: before(task.completed_at) ? task.completed_at : null,
    started_at: before(started(task)) ? started(task) : null,
  }));
  return operationsView({
    job: { ...FIXTURE.job, status: 'running', completed_at: null }, tasks, agents: FIXTURE.agents,
    results: FIXTURE.results.filter((row) => before(row.created_at)), handoffs: FIXTURE.handoffs.filter((row) => before(row.created_at)),
    events: FIXTURE.events.filter((row) => before(row.created_at)), attempts: FIXTURE.attempts.filter((row) => before(row.started_at)).map((row) => (before(row.ended_at) ? row : { ...row, status: 'started', ended_at: null })),
    artifacts: FIXTURE.artifacts.filter((row) => before(row.created_at)), now: t,
  });
}

test('the objective: real counts, no invented percentage, free spend', () => {
  const o = view.objective;
  assert.equal(o.status, 'completed');
  assert.equal(o.stage, 'completed');
  assert.deepEqual(o.workstreams, { total: 5, completed: 5, working: 0, waiting: 0, blocked: 0 });
  assert.equal(o.handoffs, 10);
  assert.equal(o.spendUsd, 0);
  assert.equal(o.attempts, 14);
  assert.equal(o.freeAttempts, 14);
  assert.equal('percent' in o || 'progress' in o, false, 'no percentage the backend cannot back');
  assert.equal(o.test, true, 'the labelled production test is recognised as a test');
  assert.ok(o.elapsedMs > 9 * 60_000 && o.elapsedMs < 11 * 60_000);
});

test('CHIEF command: delegation tree from real tasks, revision round, synthesis done', () => {
  const chief = view.chief;
  assert.equal(chief.planning, 'done');
  assert.equal(chief.synthesis, 'done');
  assert.equal(chief.revisionRounds, 1);
  assert.equal(chief.actionCode, 'delivered');
  assert.equal(chief.nextCode, null);
  assert.deepEqual(chief.tree.map((node) => [node.label, node.revision, node.after.join('+')]), [
    ['RESEARCH', false, ''], ['PRODUCT', false, 'RESEARCH'], ['FINANCE', false, 'PRODUCT'], ['AUDIT', false, 'FINANCE'], ['FINANCE', true, 'FINANCE+CHIEF'],
  ]);
});

test('mid-run: who works, who waits and for whom — from the rows of that moment', () => {
  const mid = asOf('2026-10-09T10:52:30Z'); // PRODUCT running; FINANCE and AUDIT waiting on it
  assert.deepEqual(mid.nowWorking.map((entry) => entry.key), ['product']);
  const card = (key) => mid.agents.find((agent) => agent.key === key);
  assert.equal(card('research').state, 'COMPLETED');
  assert.equal(card('product').state, 'WORKING');
  assert.equal(card('finance').state, 'WAITING');
  assert.equal(card('finance').waitReason.kind, 'dependency');
  assert.deepEqual(card('finance').waitReason.on.map((dep) => dep.label), ['PRODUCT'], '“Waiting for PRODUCT”, never just “Waiting”');
  assert.equal(card('audit').waitReason.text, 'Waiting for FINANCE');
  assert.equal(mid.chief.actionCode, 'coordinating');
  assert.equal(mid.chief.nextCode, 'synthesize_after');
  assert.deepEqual(mid.chief.nextAfter, ['PRODUCT', 'FINANCE', 'AUDIT']);
  assert.equal(mid.objective.stage, 'workstreams');
  assert.equal(mid.capacity.length, 0);
  assert.equal(mid.needsFahad.length, 0);
});

test('the pipeline: Plan → Assigned → Running → Delivered → Review → Revision → Final', () => {
  assert.deepEqual(view.pipeline.map((lane) => `${lane.label}:${lane.stage}`), [
    'CHIEF:plan', 'RESEARCH:delivered', 'PRODUCT:delivered', 'FINANCE:delivered', 'AUDIT:delivered', 'FINANCE:delivered', 'CHIEF:review', 'CHIEF:final',
  ]);
  const during = asOf('2026-10-09T10:57:00Z'); // FINANCE revision running (started 10:55:54 in the event log)
  assert.equal(during.pipeline.find((lane) => lane.revision).stage === 'revision' || during.pipeline.find((lane) => lane.revision).stage === 'running', true);
  assert.equal(during.pipeline.find((lane) => lane.kind === 'review').stage, 'review');
});

test('revision rounds are told step by step', () => {
  assert.equal(view.revisions.length, 1);
  assert.deepEqual(view.revisions[0].steps.map((step) => `${step.by}:${step.step}`), [
    'finance:draft_delivered', 'chief:revision_requested', 'finance:revision_in_progress', 'finance:revision_delivered', 'chief:accepted',
  ]);
  assert.equal(view.agents.find((agent) => agent.key === 'finance').revision, 'revision delivered');
});

test('handoffs are first-class: from, to, what, tasks, status, result', () => {
  assert.equal(view.handoffs.length, 10);
  const h = view.handoffs.find((entry) => entry.fromKey === 'research' && entry.toKey === 'product');
  assert.ok(h.what && h.what.length > 20, 'what was handed over (the sender’s summary)');
  assert.equal(h.fromTask.title, 'List benefits of a short weekly team check‑in');
  assert.equal(h.toTask.title, 'Create a 5‑item agenda for a 30‑minute weekly check‑in');
  assert.equal(h.status, 'delivered');
  assert.ok(h.result);
  assert.ok(view.handoffs.every((entry) => entry.fromKey !== entry.toKey));
});

test('deliverables link agent → task → deliverable; the final synthesis is separate', () => {
  assert.ok(view.final && view.final.summary.startsWith('The production routing test is complete'));
  const keys = new Set(view.deliverables.map((item) => item.agentKey));
  for (const key of ['research', 'product', 'finance', 'audit']) assert.ok(keys.has(key), `${key} has a visible deliverable`);
  assert.ok(view.deliverables.every((item) => item.taskId && item.taskTitle));
  const model = view.deliverables.filter((item) => item.type === 'financial_model');
  assert.deepEqual(model.map((item) => item.verification), ['NEEDS REVIEW', 'VERIFIED'], 'verified / needs review from the code validation');
  assert.equal(view.deliverables.some((item) => item.type === 'report' && item.agentKey === 'chief'), false, 'CHIEF’s synthesis is not a deliverable row');
});

test('provider switching is visible with its reason', () => {
  const switches = view.routing.flatMap((entry) => entry.switches.map((change) => `${entry.label}:${change.from}>${change.to}:${change.reason}`));
  assert.deepEqual(switches, ['FINANCE:nemotron-3-ultra-550b-a55b>nemotron-3-super-120b-a12b:PROVIDER_NETWORK', 'CHIEF:gemini-flash-latest>nemotron-3-ultra-550b-a55b:PROVIDER_TRANSIENT']);
  const timeline = view.timeline.filter((entry) => entry.kind === 'switch');
  assert.equal(timeline.length, 2);
  assert.equal(timeline[0].reason, 'network');
});

test('the timeline reads like the Office’s log; internals are kept but technical', () => {
  const plain = view.timeline.filter((entry) => !entry.technical);
  const kinds = plain.map((entry) => entry.kind);
  assert.equal(kinds[0], 'objective');
  assert.ok(kinds.includes('plan') && kinds.includes('assigned') && kinds.includes('start') && kinds.includes('delivered') && kinds.includes('handoff'));
  assert.ok(kinds.includes('revision') && kinds.includes('verified') && kinds.includes('final') && kinds.includes('completed'));
  assert.equal(kinds.at(-1), 'completed');
  assert.ok(view.timeline.some((entry) => entry.technical), 'checkpoints, stage starts and route records stay available as detail');
  assert.ok(plain.every((entry, index) => index === 0 || entry.at >= plain[index - 1].at), 'oldest first');
  assert.equal(plain.filter((entry) => entry.kind === 'review').length, 1, 'the superseded synthesis round is CHIEF’s review');
});

test('task states: dependency, capacity, blocked, needs Fahad', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const byId = new Map([['a', { id: 'a', status: 'running' }], ['b', { id: 'b', status: 'done' }]]);
  assert.equal(taskOpsState({ status: 'queued', depends_on: ['a'] }, { byId, now }), 'WAITING');
  assert.equal(taskOpsState({ status: 'queued', depends_on: ['b'] }, { byId, now }), 'ASSIGNED');
  assert.equal(taskOpsState({ status: 'queued', depends_on: [], not_before: new Date(now + 60_000).toISOString() }, { byId, now }), 'WAITING');
  assert.equal(taskOpsState({ status: 'queued', depends_on: [] }, { byId, now, jobActive: false }), 'BLOCKED');
  assert.equal(taskOpsState({ status: 'running', brief: '{"stage":"synthesis"}' }, { byId, now }), 'REVIEWING');
  assert.equal(taskOpsState({ status: 'done' }, { byId, now, needsFahad: true }), 'NEEDS FAHAD');
});

test('capacity waits explain themselves and are never Needs Fahad', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const tasks = [{ id: 't0', job_id: 'j', agent_id: 'a1', title: 'Chief planning', status: 'done', brief: '{"stage":"chief_plan"}', depends_on: [], sequence: 10, created_at: '2026-10-09T11:40:00Z', started_at: '2026-10-09T11:40:00Z', completed_at: '2026-10-09T11:41:00Z' },
    { id: 't1', job_id: 'j', agent_id: 'a1', title: 'Final synthesis', status: 'queued', brief: '{"stage":"synthesis"}', depends_on: [], sequence: 900, created_at: '2026-10-09T11:50:00Z',
    not_before: '2026-10-09T12:04:00Z', wait_count: 1, wait_info: { reason: 'NO_FREE_CAPACITY', detail: 'gemini gemini-flash-latest until 16:04 cooling down; paid fallback: not allowed for this request (free-only); next automatic retry 16:04.' } }];
  const ops = operationsView({ job: { id: 'j', title: 'X', status: 'running', created_at: '2026-10-09T11:40:00Z' }, tasks, agents: [{ id: 'a1', slug: 'chief-of-staff' }], now });
  assert.equal(ops.capacity.length, 1);
  assert.equal(ops.capacity[0].autoResume, true);
  assert.match(ops.capacity[0].detail, /cooling down/);
  assert.equal(ops.needsFahad.length, 0, 'an internal wait never asks Fahad');
  assert.equal(ops.objective.stage, 'waiting_capacity');
});

test('Needs Fahad: only genuine owner decisions (approvals, questions)', () => {
  const tables = previewTables(Date.parse('2026-10-09T12:00:00Z'));
  const job = tables.jobs.find((entry) => entry.status === 'running');
  const ops = operationsView({ job, tasks: tables.tasks.filter((task) => task.job_id === job.id), agents: tables.agents, handoffs: tables.handoffs.filter((h) => h.job_id === job.id),
    events: tables.events.filter((event) => event.job_id === job.id), approvals: tables.agent_approvals, sessions: tables.agent_sessions, now: Date.parse('2026-10-09T12:00:00Z') });
  assert.equal(ops.needsFahad.length, 1);
  assert.equal(ops.needsFahad[0].kind, 'approval');
  assert.equal(ops.needsFahad[0].agentKey, 'coding');
  assert.equal(ops.agents.find((agent) => agent.key === 'coding').state, 'NEEDS FAHAD');
  assert.equal(ops.objective.stage, 'needs_fahad');
});

test('objective selection: current = newest active real objective; old tests never become current', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const job = (id, title, status, minutes) => ({ id, title, goal: title, status, created_at: new Date(now - minutes * 60_000).toISOString(), completed_at: status === 'completed' ? new Date(now - (minutes - 5) * 60_000).toISOString() : null });
  const index = objectiveIndex([
    job('1', 'PRODUCTION ROUTING TEST 2026-10-09', 'completed', 60), job('2', 'Launch plan for Qahwa Run', 'completed', 120), job('3', 'V5 production smoke', 'completed', 30), job('4', 'Pricing strategy', 'running', 10),
  ], { now });
  assert.equal(index.currentId, '4');
  assert.deepEqual(index.recent.map((entry) => entry.id), ['2'], 'recent completed objectives are real ones only');
  const idle = objectiveIndex([job('1', 'Canary probe', 'completed', 20), job('2', 'Market scan', 'completed', 90)], { now });
  assert.equal(idle.currentId, '2');
  // A labelled test that is running right now is genuine activity: shown, flagged.
  const running = objectiveIndex([job('9', 'PRODUCTION ACCEPTANCE TEST', 'running', 2)], { now });
  assert.equal(running.currentId, '9');
  assert.equal(running.active[0].test, true);
  for (const title of ['Office test 3', 'V2 check turn 1', 'Continuity Phase N drill', 'Benchmark: coding', 'CERTIFICATION V5.4 (test, safe to delete)', 'Burn-in hour 4', '[drill:finance-error] budget']) assert.equal(isTestObjective({ title }), true, title);
  for (const title of ['Qahwa Run launch plan', 'كم متخصص في المكتب', 'Pricing for the testimonials page']) assert.equal(isTestObjective({ title }), title === 'Pricing for the testimonials page' ? false : false, title);
});

test('GET /api/operations: current objective, workspace scoping, 404 outside the workspace', async () => {
  const now = Date.now();
  const db = memoryPostgrest(previewTables(now));
  const call = async (query) => {
    let status = 0; let body = null;
    const handled = await handleOperationsApi({ db, request: { method: 'GET' }, response: {}, url: new URL(`http://x/api/operations?${query}`), sendJson: (_, code, payload) => { status = code; body = payload; } });
    return { handled, status, body };
  };
  const ok = await call(`workspaceId=${PREVIEW_WORKSPACE}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.view.objective.title, 'Qahwa Run — launch plan');
  assert.ok(ok.body.view.timeline.length > 10);
  assert.equal((await call('workspaceId=nope')).status, 400);
  const other = await call(`workspaceId=22222222-2222-4222-8222-222222222222&jobId=${ok.body.view.objective.id}`);
  assert.equal(other.status, 404, 'an objective is only readable through its own workspace');
  assert.equal((await handleOperationsApi({ db, request: { method: 'GET' }, response: {}, url: new URL('http://x/api/office'), sendJson: () => {} })), false);
});

test('the board renders Arabic-first, RTL-safe, with model names kept as written', () => {
  const html = renderOperations({ data: { objectives: objectiveIndex([FIXTURE.job]), view }, language: 'ar', esc, now: AFTER });
  for (const words of ['العمليات المباشرة', 'قيادة CHIEF', 'يشتغلون الحين', 'ينتظرك يا فهد', 'مسار العمل', 'مركز التسليمات', 'الخط الزمني', 'الخلاصة النهائية', 'جولات التعديل']) assert.ok(html.includes(words), words);
  assert.match(html, /<bdi dir="ltr" class="ops-model" title="nvidia\/nemotron-3-ultra-550b-a55b:free">Nemotron Ultra<\/bdi>/, 'model names are not translated');
  assert.ok(html.includes('٥ من ٥') || html.includes('5 من 5'));
  assert.equal(/\b(undefined|NaN|null)\b/.test(html.replace(/data-[a-z-]+="[^"]*"/g, '')), false);
  const en = renderOperations({ data: { objectives: objectiveIndex([FIXTURE.job]), view }, language: 'en', esc, now: AFTER });
  for (const words of ['Live operations', 'CHIEF command', 'Now working', 'Needs Fahad', 'Workstream pipeline', 'Handoff center', 'FINAL SYNTHESIS', 'Revision rounds', '5 of 5']) assert.ok(en.includes(words), words);
  assert.match(en, /Nobody is running a model right now/);
  // Department filter: only that employee (and CHIEF) remain.
  const filtered = renderOperations({ data: { objectives: { active: [], recent: [] }, view }, language: 'en', esc, filterKey: 'finance', now: AFTER });
  assert.match(filtered, /Showing FINANCE/);
  assert.equal(/data-key="research"/.test(filtered), false);
  assert.ok(renderObjectiveStrip({ data: { view }, language: 'ar', esc }).includes('data-open-ops'));
  assert.equal(renderOperations({ data: { objectives: { active: [], recent: [] }, view: null }, language: 'en', esc }).includes('No objective yet'), true);
});

test('timeline words, durations and model names in both languages', () => {
  const entry = { kind: 'handoff', who: 'RESEARCH', to: 'PRODUCT' };
  assert.equal(timelineText(entry, 'en'), 'RESEARCH → PRODUCT handoff');
  assert.equal(timelineText(entry, 'ar'), 'تسليم من RESEARCH إلى PRODUCT', 'Arabic never relies on an arrow between two Latin names');
  assert.equal(timelineText({ kind: 'assigned', who: 'FINANCE', revision: true }, 'ar'), 'CHIEF أسند تعديلًا إلى FINANCE');
  assert.equal(opsDuration(252_000, 'en'), '4 min 12 s');
  assert.match(opsDuration(252_000, 'ar'), /^[4٤] د [1١][2٢] ث$/);
  assert.equal(prettyModel('nvidia/nemotron-3-ultra-550b-a55b:free'), 'Nemotron Ultra');
  assert.equal(prettyModel('nvidia/nemotron-3-super-120b-a12b:free'), 'Nemotron Super');
  assert.equal(prettyModel('openai/gpt-oss-120b'), 'GPT OSS 120B');
  assert.equal(prettyModel('gemini-flash-latest'), 'Gemini Flash');
  assert.equal(prettyModel('deepseek-flash'), 'DeepSeek Flash');
  for (const language of ['ar', 'en']) {
    const copy = opsCopy(language);
    for (const state of ['AVAILABLE', 'ASSIGNED', 'WORKING', 'REVIEWING', 'WAITING', 'BLOCKED', 'NEEDS FAHAD', 'COMPLETED', 'FAILED']) assert.ok(copy.states[state], `${language} ${state}`);
    for (const kind of ['objective', 'plan', 'assigned', 'start', 'delivered', 'handoff', 'switch', 'revision', 'verified', 'final', 'completed', 'waiting', 'launched']) assert.ok(copy.timeline[kind], `${language} ${kind}`);
  }
});

test('integration: live stream, 3D hooks, small screens, reduced motion', () => {
  const office = read('src/hub-ui/office.js');
  assert.match(office, /ops\.refresh\(\)/, 'operations refresh with every Office load (the shared SSE stream + 30 s safety)');
  assert.match(office, /highlightHandoff\?\.\(detail\)/, 'a handoff chosen in the Handoff Center lights its 3D route');
  assert.match(office, /handoff: \(handoff\) => showHandoff\(handoff, \{ fromFloor: true \}\)/, 'a floor handoff opens its details');
  assert.match(office, /focusChief: \(\) => \{ if \(on3d\(\)\) \{ scrollToStage\(\); go\(\{ name: 'chief' \}\)/, 'CHIEF opens the command view');
  assert.match(office, /const syncFilter = \(\) => ops\.setFilter/, 'a department in view filters the operations');
  assert.match(read('src/hub-ui/office3d/scene.js'), /highlightHandoff\(handoff\) \{ const lit = handoffs\.highlight\(handoff \|\| null\)/);
  assert.match(read('src/hub-ui/office3d/handoffs3d.js'), /const path = handoff \? routePath\(handoff\.fromKey, handoff\.toKey\) : null;\n\s+if \(!path\) return false;/, 'no route record, no light');
  const css = read('src/hub-ui/office.css');
  assert.match(css, /@media \(max-width: 900px\) \{\n\s+\.ops-board \{ display: flex; flex-direction: column; \}\n\s+\.ops-now \{ order: 1; \} \.ops-needs \{ order: 2; \} \.ops-timeline \{ order: 3; \} \.ops-deliverables \{ order: 4; \}/, 'small screens: Working now → Needs Fahad → Timeline → Deliverables');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.ops-row, \.ops-tree-node \{ transition: none !important; \} \}/);
  const ui = read('src/hub-ui/office-ops.js');
  assert.match(ui, /JSON\.stringify\(next, \(key, value\) => \(key === 'elapsedMs' \? undefined : value\)\)/, 'elapsed time never forces a redraw');
  assert.match(ui, /if \(next === filterKey\) return;/, 'camera moves do not redraw the board');
  assert.equal(/setInterval\([^)]*api\(/.test(ui), false, 'no polling of the API from the board');
});

test('Now working names the live model from the started attempt row', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const tasks = [{ id: 't1', job_id: 'j', agent_id: 'a2', title: 'Market scan', status: 'running', brief: '{"stage":"specialist"}', depends_on: [], sequence: 100, created_at: '2026-10-09T11:58:00Z', started_at: '2026-10-09T11:58:30Z' }];
  const attempts = [
    { task_id: 't1', provider: 'gemini', model: 'gemini-flash-latest', status: 'failed', error_code: 'PROVIDER_TRANSIENT', route: [{ billingClass: 'free' }], cost_usd: 0, started_at: '2026-10-09T11:58:31Z', ended_at: '2026-10-09T11:58:40Z' },
    { task_id: 't1', provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', status: 'started', route: [{ billingClass: 'free' }], cost_usd: 0, started_at: '2026-10-09T11:58:41Z', ended_at: null },
  ];
  const ops = operationsView({ job: { id: 'j', title: 'X', status: 'running', created_at: '2026-10-09T11:57:00Z' }, tasks, agents: [{ id: 'a2', slug: 'research-strategy' }], attempts, now });
  assert.equal(ops.nowWorking.length, 1);
  assert.equal(ops.nowWorking[0].model, 'nvidia/nemotron-3-ultra-550b-a55b:free');
  assert.equal(ops.nowWorking[0].billing, 'free');
  assert.equal(ops.nowWorking[0].live, true);
  assert.deepEqual(ops.routing[0].path.map((step) => `${step.model}:${step.status}:${step.error || ''}`), ['gemini-flash-latest:failed:PROVIDER_TRANSIENT', 'nemotron-3-ultra-550b-a55b:started:']);
  assert.equal(ops.routing[0].failures, 1);
});

test('PRODUCTION REGRESSION: an attempt outcome keeps its real start time', () => {
  const source = read('src/model-gateway/agentic/turn-gateway.js');
  assert.match(source, /status: 'succeeded', usage: result\.usage, requestId: result\.requestId, durationMs: result\.durationMs, startedAt: new Date\(startedAt\)\.toISOString\(\) \}/);
  assert.match(source, /status: 'failed', usage: error\.usage \|\| null, startedAt: new Date\(startedAt\)\.toISOString\(\)/);
});
