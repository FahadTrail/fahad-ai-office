import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficeWorkflow, SEQUENCES } from '../src/workflow.js';
import { validatePlan } from '../src/chief.js';
import { parseRevisionRequest } from '../src/office/specialist.js';
import { ACTIVE_AGENTS, DISPATCHABLE, OFFICE_AGENTS, officeAgent, parseOutput } from '../src/office/agents.js';
import { MemoryStore } from '../testing/fixtures/office-memory-store.js';

const outcome = (text) => ({ text, tokensIn: 10, tokensOut: 5, costUsd: 0, durationMs: 5, turns: 1 });
const deliverable = (who, body) => `## Summary\n${who} summary.\n\n## Work\n${body}\n\n## Handoff\nNext.\n\n## Decisions for Fahad\nNone`;

// RESEARCH → (PRODUCT ∥ CREATIVE) → FINANCE(after PRODUCT) → CHIEF synthesis.
const PLAN = {
  route: 'orchestrate', plan_summary: 'Launch concept for Morning Harbor.',
  synthesis_brief: 'One launch concept with decisions.',
  workstreams: [
    { id: 'market', agent: 'research', title: 'Market research', brief: 'Research the premium bakery market in the target city.', depends_on: [] },
    { id: 'strategy', agent: 'product', title: 'Business model', brief: 'Define the business model and positioning using the research.', depends_on: ['market'] },
    { id: 'brand', agent: 'creative', title: 'Brand concept', brief: 'Create the brand concept and tone of voice from the research.', depends_on: ['market'] },
    { id: 'finance', agent: 'finance', title: 'Launch budget', brief: 'Estimate launch costs and pricing for the business model.', depends_on: ['strategy'] },
  ],
};

function office({ plan = PLAN, synthesize, specialist, direct, parallelTasks = 1, store = new MemoryStore({ goal: 'Create a launch concept for a fictional premium bakery called Morning Harbor.' }) } = {}) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const workflow = new OfficeWorkflow({
    store, parallelTasks, now: () => store.now,
    plan: async () => { calls.push('plan'); return { ...outcome(JSON.stringify(plan)), plan: validatePlan(JSON.stringify(plan)) }; },
    specialist: specialist || (async (input) => {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      calls.push({ role: input.role, title: input.title, inputs: input.upstream.map((entry) => entry.agent_slug), revision: input.revision, previous: input.previous });
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return outcome(deliverable(input.role, `${input.title} deliverable${input.revision ? ' (revised)' : ''}`));
    }),
    synthesize: synthesize || (async (input) => {
      calls.push({ role: 'synthesis', allowRevision: input.allowRevision, outputs: input.outputs.map((entry) => entry.agent_slug) });
      return outcome('# Morning Harbor launch concept\nConsolidated.');
    }),
    direct: direct || (async (input) => { calls.push({ role: 'direct', agent: input.role }); return outcome(`Direct answer from ${input.role}.`); }),
  });
  return { store, workflow, calls, maxInFlight: () => maxInFlight };
}

async function drain(workflow, limit = 40) {
  for (let index = 0; index < limit; index += 1) if (!await workflow.runOnce()) return;
  throw new Error('Workflow did not become idle');
}

test('the Chief orchestrates several employees with dependencies, handoffs and one synthesis', async () => {
  const { store, workflow, calls } = office();
  await drain(workflow);
  const job = store.jobs[0];
  assert.equal(job.status, 'completed');
  const work = calls.filter((call) => call.role && call.role !== 'synthesis');
  assert.deepEqual(work.map((call) => call.role), ['research', 'product', 'creative', 'finance']);
  assert.deepEqual(work.find((call) => call.role === 'product').inputs, ['research-strategy'], 'product receives the research output');
  assert.deepEqual(work.find((call) => call.role === 'finance').inputs, ['product-tech'], 'finance receives the product output');
  const synthesis = calls.find((call) => call.role === 'synthesis');
  assert.deepEqual(synthesis.outputs.sort(), ['brand-creative', 'business-finance', 'product-tech', 'research-strategy']);
  assert.equal(synthesis.allowRevision, true);
  // Every employee ran under its own identity, as a durable task.
  assert.deepEqual(store.tasks.map((task) => task.agent_slug), ['chief-of-staff', 'research-strategy', 'product-tech', 'brand-creative', 'business-finance', 'chief-of-staff']);
  assert.ok(store.tasks.every((task) => task.status === 'done'));
  // Real handoffs along every dependency edge.
  const edges = store.handoffs.map((handoff) => `${handoff.from_agent_id}>${handoff.to_agent_id}`);
  for (const edge of ['chief>research', 'research>product', 'research>brand', 'product>finance', 'product>chief', 'brand>chief', 'finance>chief']) assert.ok(edges.includes(edge), edge);
  // Durable outputs, the plan as a readable table, and the Chief's final result.
  assert.match(store.results.find((result) => result.task_id === store.tasks[0].id).content, /\| Market research \| RESEARCH \|/);
  assert.equal(store.results.find((result) => result.kind === 'final').content, '# Morning Harbor launch concept\nConsolidated.');
  assert.ok(store.events.some((event) => event.payload?.kind === 'workflow_planned' && event.payload.workstreams.length === 4));
  assert.equal(store.events.filter((event) => event.payload?.kind === 'output_ready').length, 4);
});

test('independent workstreams run in parallel when the worker allows it', async () => {
  const { workflow, maxInFlight, store } = office({ parallelTasks: 3 });
  await drain(workflow);
  assert.equal(store.jobs[0].status, 'completed');
  assert.equal(maxInFlight(), 2, 'strategy and brand ran at the same time; finance waited for strategy');
});

test('the Chief can request one bounded revision round before the final result', async () => {
  let round = 0;
  const { store, workflow, calls } = office({
    synthesize: async (input) => {
      round += 1;
      calls.push({ role: 'synthesis', allowRevision: input.allowRevision, outputs: input.outputs.map((entry) => entry.content) });
      if (round === 1) return outcome('{"revise":[{"workstream":"brand","instruction":"Make the tone warmer and add two name options."},{"workstream":"nope","instruction":"ignored because unknown"}]}');
      return outcome('Final concept with the revised brand.');
    },
  });
  await drain(workflow);
  assert.equal(store.jobs[0].status, 'completed');
  const revision = calls.find((call) => call.revision);
  assert.equal(revision.role, 'creative');
  assert.match(revision.revision, /warmer/);
  assert.match(revision.previous, /Brand concept deliverable/);
  const syntheses = calls.filter((call) => call.role === 'synthesis');
  assert.deepEqual(syntheses.map((call) => call.allowRevision), [true, false], 'the second synthesis cannot ask again');
  assert.ok(syntheses[1].outputs.some((content) => /\(revised\)/.test(content)), 'the final synthesis uses the revised output');
  assert.equal(store.results.find((result) => result.kind === 'final').content, 'Final concept with the revised brand.');
  assert.ok(store.tasks.some((task) => task.sequence === SEQUENCES.REVISION && task.agent_slug === 'brand-creative'));
});

test('a malformed revision request is never shown as the answer', async () => {
  let round = 0;
  const { store, workflow } = office({
    synthesize: async (input) => { round += 1; return outcome(input.allowRevision ? '{"revise":[{"workstream":"unknown","instruction":"x"}]}' : `Final after ${round} calls.`); },
  });
  await drain(workflow);
  assert.equal(store.results.find((result) => result.kind === 'final').content, 'Final after 2 calls.');
});

test('a development workstream is handed to the Coding Agent with the Office inputs', async () => {
  const plan = { ...PLAN, workstreams: [PLAN.workstreams[0], { id: 'site', agent: 'coding', title: 'Landing page', brief: 'Add a landing page section for Morning Harbor with tests.', depends_on: ['market'] }] };
  const store = new MemoryStore({ goal: 'Research and build a landing page.' });
  const sessions = [];
  store.jobContext = async () => ({ text: '', conversationId: 'conv-1', project: { id: 'ws-1', name: 'Office', defaultRepository: 'FahadTrail/example' } });
  store.createCodingSession = async (input) => { sessions.push(input); return { id: 'session-1' }; };
  const { workflow } = office({ plan, store });
  await drain(workflow);
  assert.equal(store.jobs[0].status, 'completed');
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].repository, 'FahadTrail/example');
  assert.match(sessions[0].objective, /Add a landing page section/);
  assert.match(sessions[0].objective, /INPUTS FROM THE OFFICE:[\s\S]*Research/);
  assert.equal(sessions[0].createdBy, 'chief-of-staff');
  assert.ok(store.events.some((event) => event.payload?.kind === 'task_launched' && event.payload.session_id === 'session-1'));
  assert.equal(store.tasks.find((task) => task.agent_slug === 'coding-agent').status, 'done');
});

test('without a repository the development workstream says so instead of pretending', async () => {
  const plan = { ...PLAN, workstreams: [{ id: 'site', agent: 'coding', title: 'Landing page', brief: 'Add a landing page section with tests please.', depends_on: [] }] };
  const store = new MemoryStore();
  store.jobContext = async () => ({ text: '', project: { id: 'ws-1', defaultRepository: '' } });
  store.createCodingSession = async () => { throw new Error('must not be called'); };
  const { workflow } = office({ plan, store });
  await drain(workflow);
  const output = store.results.find((result) => result.task_id === store.tasks.find((task) => task.agent_slug === 'coding-agent').id);
  assert.match(output.content, /was not started: this project has no repository/);
});

test('a direct conversation goes to that employee, not the Chief', async () => {
  const store = new MemoryStore({ goal: 'Give me three name ideas for a bakery.' });
  store.conversationAgent = async () => 'brand-creative';
  const { workflow, calls } = office({ store });
  await drain(workflow);
  assert.deepEqual(calls, [{ role: 'direct', agent: 'creative' }]);
  assert.equal(store.tasks.length, 1);
  assert.equal(store.tasks[0].agent_slug, 'brand-creative');
  assert.equal(store.results.find((result) => result.kind === 'final').content, 'Direct answer from creative.');
});

test('a failed workstream blocks what depends on it and fails the objective honestly', async () => {
  const { store, workflow } = office({
    specialist: async (input) => { if (input.role === 'product') throw new Error('provider unavailable'); return outcome(deliverable(input.role, 'ok')); },
  });
  await drain(workflow);
  assert.equal(store.jobs[0].status, 'failed');
  assert.equal(store.tasks.find((task) => task.agent_slug === 'product-tech').status, 'failed');
  assert.equal(store.tasks.find((task) => task.agent_slug === 'business-finance').status, 'blocked');
  assert.ok(!store.results.some((result) => result.kind === 'final'));
});

test('orchestration plans are validated: known employees, no cycles, bounded size', () => {
  const base = { route: 'orchestrate', plan_summary: 'x' };
  const stream = (id, agent, depends = []) => ({ id, agent, title: id, brief: 'a sufficiently long brief for the work', depends_on: depends });
  assert.throws(() => validatePlan(JSON.stringify({ ...base, workstreams: [stream('a', 'astrologer')] })), /unknown employee/);
  assert.throws(() => validatePlan(JSON.stringify({ ...base, workstreams: [stream('a', 'research', ['b']), stream('b', 'creative', ['a'])] })), /cycle/);
  assert.throws(() => validatePlan(JSON.stringify({ ...base, workstreams: [stream('a', 'research', ['zzz'])] })), /unknown workstream/);
  assert.throws(() => validatePlan(JSON.stringify({ ...base, workstreams: Array.from({ length: 9 }, (_, index) => stream(`w${index}`, 'research')) })), /limit is 8/);
  assert.throws(() => validatePlan(JSON.stringify({ ...base, workstreams: [stream('a', 'coding'), stream('b', 'coding')] })), /one development/);
  assert.throws(() => validatePlan(JSON.stringify({ ...base, workstreams: [stream('a', 'chief')] })), /unknown employee/);
  const plan = validatePlan(JSON.stringify({ ...base, workstreams: [stream('b', 'seo', ['a']), stream('a', 'market')] }));
  assert.deepEqual(plan.workstreams.map((entry) => `${entry.id}:${entry.agent}`), ['a:research', 'b:social'], 'aliases map to employees; dependency order');
});

test('the roster: every Office function has its own executable employee; models are never pinned', () => {
  assert.deepEqual(ACTIVE_AGENTS.map((agent) => agent.label), ['CHIEF', 'RESEARCH', 'CREATIVE', 'PRODUCT', 'FINANCE', 'CODING', 'AUDIT', 'SOCIAL', 'LEGAL']);
  for (const key of ['research', 'finance', 'creative', 'product', 'social', 'audit', 'legal', 'coding', 'chief']) assert.ok(officeAgent(key), key);
  // Retired identities keep their history but route new work to their successor.
  assert.equal(officeAgent('business-strategy').retired, true);
  assert.equal(officeAgent('strategy').key, 'product');
  assert.equal(officeAgent('operations').slug, 'operations');
  assert.equal(officeAgent('ops').key, 'product');
  assert.equal(officeAgent('seo').key, 'social', 'SEO is a SOCIAL skill, not an employee');
  assert.ok(!DISPATCHABLE.includes('strategy') && !DISPATCHABLE.includes('operations') && !DISPATCHABLE.includes('chief'));
  // Fahad's Arabic nicknames.
  for (const [word, key] of [['الفاينانس', 'finance'], ['الليغال', 'legal'], ['الريسيرش', 'research'], ['الكرييتف', 'creative'], ['الكودينج', 'coding']]) assert.equal(officeAgent(word)?.key, key, word);
  assert.equal(new Set(OFFICE_AGENTS.map((agent) => agent.slug)).size, OFFICE_AGENTS.length);
  for (const agent of OFFICE_AGENTS) {
    assert.ok(agent.job, `${agent.slug} routes by job type`);
    assert.equal(agent.model, undefined, `${agent.slug} has no fixed model`);
  }
  assert.deepEqual(parseOutput('## Summary\nShort.\n\n## Work\nBody\n\n## Decisions for Fahad\nNone'), { summary: 'Short.', handoff: '', decisions: '' });
  assert.deepEqual(parseRevisionRequest('Plain final text', [{ id: 'a', agent: 'brand' }]), []);
});

test('language follows Fahad\'s message through plan, workstreams and synthesis', async () => {
  const { readFileSync } = await import('node:fs');
  const chief = readFileSync(new URL('../src/chief.js', import.meta.url), 'utf8');
  const specialist = readFileSync(new URL('../src/office/specialist.js', import.meta.url), 'utf8');
  assert.match(chief, /every workstream title and brief, and synthesis_brief in the language of Fahad/);
  assert.match(specialist, /whole deliverable in the language of Fahad\\?'s ORIGINAL OBJECTIVE/);
  assert.match(specialist, /whole result in the language of the ORIGINAL OBJECTIVE/);
});
