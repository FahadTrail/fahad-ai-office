// V4.1 reliability closure: deterministic finance, AUDIT numeric checks, the
// CHIEF fact gate, SOCIAL calendar artifacts, dependency-aware scheduling,
// invisible [free-only], and degraded web search.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficeWorkflow, officeRequest } from '../src/workflow.js';
import { validatePlan } from '../src/chief.js';
import { parseArtifacts } from '../src/office/artifacts.js';
import { FINANCE_STATES, calculateFinance, injectFinanceError, publishFinance, validateFinance } from '../src/office/finance.js';
import { chiefGate, cleanOutput, enforceAudit, enforceFacts, evidenceGate, numericChecks, socialCalendar } from '../src/office/quality.js';
import { createOfficeToolExecutor } from '../src/office/web-tools.js';
import { extractFreeOnly } from '../src/office/markers.js';
import { MemoryStore } from '../testing/fixtures/office-memory-store.js';

const block = (value) => `\`\`\`artifact\n${JSON.stringify(value)}\n\`\`\``;
const outcome = (text) => ({ text, tokensIn: 10, tokensOut: 5, costUsd: 0, durationMs: 5 });

// A small subscription model whose figures are easy to check by hand:
// 10 customers join every month, no churn, AED 100/month, AED 1,000 fixed
// costs per month and a AED 5,000 setup cost.
const MODEL = {
  type: 'financial_model', title: 'Pilot model', currency: 'AED', months: 12,
  items: [{ category: 'Build', item: 'Setup', one_time: 5000, monthly: 0 }, { category: 'Run', item: 'Team & hosting', one_time: 0, monthly: 1000 }],
  revenue: { price_monthly: 100, starting_customers: 0, new_customers: 10, churn_rate: 0 },
};
// Revenue months 1..12 = 1000, 2000, …, 12000 → 78,000. Costs = 5,000 + 12×1,000 = 17,000.
// Cumulative: M1 −5,000, M2 −4,000, M3 −2,000, M4 +1,000 → cash break-even month 4.
const RIGHT = { year_revenue: 78000, year_costs: 17000, net: 61000, break_even_month: 4 };
const financeOutput = (claims = RIGHT, summary = 'First-year revenue of AED 78,000 against AED 17,000 of costs; break-even in month 4.') =>
  `## Summary\n${summary}\n\n## Work\nThe model.\n\n${block({ ...MODEL, claims })}\n\n## Handoff\nUse it.\n\n## Decisions for Fahad\nNone`;

test('A. the calculation engine reproduces every total, and a correct table total passes', () => {
  const calc = calculateFinance(MODEL);
  assert.equal(calc.year_revenue, 78000);
  assert.equal(calc.year_costs, 17000);
  assert.equal(calc.net, 61000);
  assert.equal(calc.break_even_month, 4);
  assert.equal(calc.ending_customers, 120);
  assert.deepEqual(calc.schedule.revenue.slice(0, 3), [1000, 2000, 3000]);
  assert.equal(calc.sensitivity.length, 4);
  const table = block({ type: 'table', title: 'Costs', columns: ['Line', 'Year 1 (AED)'], rows: [['Setup', '5,000'], ['Running', '12,000'], ['Total', '17,000']] });
  const result = validateFinance(`${financeOutput()}\n\n${table}`);
  assert.equal(result.state, FINANCE_STATES.VERIFIED, JSON.stringify(result.issues));
});

test('B. a wrong total is rejected (stated claim and table total row)', () => {
  const wrong = validateFinance(financeOutput({ ...RIGHT, year_costs: 19000 }, 'Costs are summarised below.'));
  assert.equal(wrong.state, FINANCE_STATES.INCONSISTENT);
  assert.deepEqual(wrong.issues.map((entry) => [entry.code, entry.expected, entry.actual]), [['TOTAL_MISMATCH', 17000, 19000]]);
  const table = block({ type: 'table', title: 'Costs', columns: ['Line', 'Year 1 (AED)'], rows: [['Setup', '5,000'], ['Running', '12,000'], ['Total', '18,500']] });
  assert.ok(validateFinance(`${financeOutput()}\n\n${table}`).issues.some((entry) => entry.code === 'TABLE_TOTAL_MISMATCH' && entry.expected === 17000));
});

test('C. a wrong or invented break-even is rejected; "not reached" must be true', () => {
  const late = validateFinance(financeOutput({ ...RIGHT, break_even_month: 7 }, 'Break-even in month 7.'));
  assert.ok(late.issues.some((entry) => entry.code === 'BREAK_EVEN_MISMATCH' && entry.expected === 4 && entry.actual === 7));
  // The Tasleem case: a revenue ramp that never pays back the costs.
  const tasleem = { ...MODEL, items: [{ item: 'MVP', one_time: 25000 }, { item: 'Team', monthly: 12000 }], revenue: { price_monthly: 49, new_customers: [5, 5, 10, 15, 15, 20, 20, 20, 20, 20, 20, 20], churn_rate: 0.05 } };
  const invented = validateFinance(`## Summary\nBreak-even in month 7 with first-year revenue of AED 229,000.\n\n${block({ ...tasleem, claims: { year_revenue: 229000, break_even_month: 7 } })}`);
  assert.equal(invented.state, FINANCE_STATES.INCONSISTENT);
  assert.equal(invented.calculated.break_even_month, null);
  assert.ok(invented.issues.some((entry) => entry.code === 'BREAK_EVEN_NOT_REACHED'));
  assert.ok(invented.issues.some((entry) => entry.code === 'TOTAL_MISMATCH' && entry.actual === 229000));
  const honest = validateFinance(`## Summary\nBreak-even is not reached by month 12.\n\n${block({ ...tasleem, claims: { break_even_month: 'not reached' } })}`);
  assert.equal(honest.state, FINANCE_STATES.VERIFIED, JSON.stringify(honest.issues));
  // No revenue inputs → a break-even claim cannot be reproduced.
  const unsupported = validateFinance(`## Summary\nBreak-even in month 3.\n\n${block({ type: 'financial_model', currency: 'AED', items: [{ item: 'Setup', one_time: 900 }] })}`);
  assert.ok(unsupported.issues.some((entry) => entry.code === 'BREAK_EVEN_UNSUPPORTED'));
});

test('D. chart and monthly-table values that disagree with the schedule are rejected', () => {
  const chart = block({ type: 'chart', title: 'Revenue', labels: ['M1', 'M2', 'M3'], series: [{ name: 'Revenue', values: [1000, 2500, 3000] }] });
  const table = block({ type: 'table', title: 'Ramp', columns: ['Month', 'Customers', 'MRR (AED)'], rows: [['Month 1', '10', '1,000'], ['Month 2', '20', '2,000'], ['Month 3', '30', '3,900']] });
  const result = validateFinance(`${financeOutput()}\n\n${chart}\n\n${table}`);
  assert.deepEqual(result.issues.map((entry) => entry.code).sort(), ['CHART_MISMATCH', 'TABLE_SCHEDULE_MISMATCH']);
  // Publishing drops the wrong chart and draws the calculated schedule.
  const published = publishFinance(`${financeOutput()}\n\n${chart}`, result);
  const charts = parseArtifacts(published).artifacts.filter((entry) => entry.type === 'chart');
  assert.equal(charts.length, 1);
  assert.match(charts[0].title, /calculated/);
  assert.deepEqual(charts[0].data.series[0].values.slice(0, 3), [1000, 2000, 3000]);
});

// ---------------------------------------------------------------- workflow

const PLAN = (workstreams) => ({ route: 'orchestrate', plan_summary: 'Plan.', synthesis_brief: 'One answer.', workstreams });
function office({ plan, specialist, synthesize, goal = 'Pilot launch plan.', parallelTasks = 1, store = new MemoryStore({ goal }) }) {
  const workflow = new OfficeWorkflow({
    store, parallelTasks, now: () => store.now, pollIntervalMs: 10,
    plan: async () => ({ ...outcome(JSON.stringify(plan)), plan: validatePlan(JSON.stringify(plan)) }),
    specialist, synthesize,
  });
  return { store, workflow };
}
async function drain(workflow, limit = 60) {
  for (let index = 0; index < limit; index += 1) if (!await workflow.runOnce()) return;
  throw new Error('Workflow did not become idle');
}
const finalText = (store) => store.results.find((result) => result.kind === 'final').content;

test('E. CHIEF cannot replace a validated financial value with a different number', async () => {
  const { store, workflow } = office({
    plan: PLAN([{ id: 'money', agent: 'finance', title: 'Pilot model', brief: 'Model the pilot costs and revenue.', depends_on: [] }]),
    specialist: async () => outcome(financeOutput()),
    synthesize: async (input) => {
      assert.match(input.facts, /validated_year_revenue = AED 78,000/);
      assert.match(input.facts, /validated_break_even_month = month 4/);
      return outcome('## Executive summary\nFirst-year revenue is about AED 229,000 and break-even arrives in month 7.\nThe team is ready.\n\n| Figure | Value |\n| --- | --- |\n| Year-1 revenue | AED 229,000 |\n| Year-1 costs | AED 17,000 |');
    },
  });
  await drain(workflow);
  const text = finalText(store);
  assert.doesNotMatch(text, /229,000|month 7/);
  assert.match(text, /The team is ready\./);
  assert.match(text, /Year-1 costs \| AED 17,000/, 'a correct row stays');
  assert.match(text, /## Validated financial figures \(calculated by code\)[\s\S]*AED 78,000[\s\S]*month 4/);
  assert.ok(store.events.some((event) => event.payload?.kind === 'fact_gate_enforced' && event.payload.removed >= 2));
});

test('F. AUDIT catches a deliberate finance inconsistency with code, whatever its model writes', () => {
  const wrong = financeOutput({ ...RIGHT, year_revenue: 229000 }, 'Revenue is strong.');
  const checks = numericChecks([{ agent_slug: 'business-finance', title: 'Pilot model', content: wrong, task_id: 't1' }]);
  assert.equal(checks.findings.length, 1);
  assert.deepEqual([checks.findings[0].type, checks.findings[0].severity, checks.findings[0].owner, checks.findings[0].expected, checks.findings[0].actual],
    ['NUMERIC_INCONSISTENCY', 'blocked', 'finance', '78,000', '229,000']);
  // The model's report missed it and said PASS: code adds the finding.
  const report = enforceAudit(`## Summary\nLooks fine.\n\n${block({ type: 'audit_report', verdict: 'PASS', findings: [] })}`, checks);
  const audit = parseArtifacts(report).artifacts.find((entry) => entry.type === 'audit_report');
  assert.equal(audit.data.verdict, 'BLOCKED');
  assert.equal(audit.data.findings[0].type, 'NUMERIC_INCONSISTENCY');
  assert.match(report, /## Code checks \(deterministic\)[\s\S]*FAILED \(BLOCKED, owner FINANCE\)/);
  // A correct model passes.
  assert.equal(numericChecks([{ agent_slug: 'business-finance', title: 'Pilot model', content: financeOutput() }]).findings.length, 0);
});

test('G. FINANCE is returned automatically and its corrected model is published as VERIFIED', async () => {
  const calls = [];
  const { store, workflow } = office({
    plan: PLAN([{ id: 'money', agent: 'finance', title: 'Pilot model', brief: 'Model the pilot costs and revenue.', depends_on: [] }]),
    specialist: async (input) => {
      calls.push(input.revision || null);
      return outcome(input.revision ? financeOutput() : financeOutput({ ...RIGHT, year_revenue: 229000, break_even_month: 7 }, 'Revenue of AED 229,000 in the first year; break-even in month 7.'));
    },
    synthesize: async () => outcome('## Executive summary\nDone.'),
  });
  await drain(workflow);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /Code validation of your financial model FAILED[\s\S]*229,000[\s\S]*78,000/);
  const saved = store.artifacts.find((row) => row.type === 'financial_model');
  assert.equal(saved.data.validation.state, 'VERIFIED');
  assert.equal(saved.data.calculated.year_revenue, 78000);
  const events = store.events.filter((event) => event.payload?.kind === 'finance_validation');
  assert.deepEqual(events.map((event) => [event.payload.state, Boolean(event.payload.final)]), [['INCONSISTENT', false], ['VERIFIED', true]]);
  assert.doesNotMatch(finalText(store), /229,000/);
});

test('deliberate failure drill: a wrong total injected before validation never reaches CHIEF', async () => {
  const seen = [];
  const { store, workflow } = office({
    goal: '[drill:finance-error] Pilot launch plan.',
    plan: PLAN([{ id: 'money', agent: 'finance', title: 'Pilot model', brief: 'Model the pilot costs and revenue.', depends_on: [] }]),
    specialist: async () => outcome(financeOutput()),
    synthesize: async (input) => { seen.push(input.outputs.map((entry) => entry.content).join('\n')); return outcome('## Executive summary\nDone.'); },
  });
  await drain(workflow);
  const drill = store.events.find((event) => event.payload?.kind === 'finance_drill');
  assert.equal(drill.payload.stage, 'before_validation');
  const injected = drill.payload.value.toLocaleString('en-US');
  assert.ok(store.events.some((event) => event.payload?.kind === 'finance_validation' && event.payload.returned));
  assert.ok(!seen.join('').includes(injected), 'CHIEF never received the injected figure');
  assert.ok(!finalText(store).includes(injected));
  assert.equal(store.artifacts.find((row) => row.type === 'financial_model').data.validation.state, 'VERIFIED');
});

test('deliberate failure drill after validation: AUDIT and CHIEF catch it and FINANCE corrects it', async () => {
  const synthesized = [];
  const plan = PLAN([
    { id: 'money', agent: 'finance', title: 'Pilot model', brief: 'Model the pilot costs and revenue.', depends_on: [] },
    { id: 'review', agent: 'audit', title: 'Review', brief: 'Review everything before the final answer.', depends_on: ['money'] },
  ]);
  const { store, workflow } = office({
    goal: '[drill:finance-error-audit] Pilot launch plan.', plan,
    specialist: async (input) => (input.role === 'audit'
      ? outcome(`## Summary\nReviewed.\n\n${block({ type: 'audit_report', verdict: 'PASS', findings: [] })}`)
      : outcome(financeOutput())),
    synthesize: async (input) => { synthesized.push(input.facts); return outcome('## Executive summary\nRevenue of AED 78,000 in the first year.'); },
  });
  await drain(workflow);
  const drill = store.events.find((event) => event.payload?.kind === 'finance_drill');
  assert.equal(drill.payload.stage, 'after_validation');
  const audit = store.artifacts.find((row) => row.type === 'audit_report');
  assert.equal(audit.data.verdict, 'BLOCKED');
  assert.ok(audit.data.findings.some((finding) => finding.type === 'NUMERIC_INCONSISTENCY' && finding.owner === 'finance'));
  assert.ok(store.events.some((event) => event.payload?.kind === 'revision_requested' && event.payload.revisions[0].workstream === 'money'), 'CHIEF returned it to FINANCE without asking a model');
  assert.equal(synthesized.length, 1, 'only the final synthesis ran a model');
  assert.match(synthesized[0], /validated_year_revenue = AED 78,000/);
  const final = finalText(store);
  assert.ok(!final.includes(drill.payload.value.toLocaleString('en-US')));
  assert.doesNotMatch(final, /Not closed/);
});

test('H. PRODUCT starts as soon as RESEARCH is done, before the unrelated slow LEGAL finishes', async () => {
  const log = [];
  const plan = PLAN([
    { id: 'market', agent: 'research', title: 'Market', brief: 'Research the market for the pilot.', depends_on: [] },
    { id: 'law', agent: 'legal', title: 'Rules', brief: 'List the rules that apply to the pilot.', depends_on: [] },
    { id: 'scope', agent: 'product', title: 'Scope', brief: 'Define the MVP scope from the research.', depends_on: ['market'] },
  ]);
  const { workflow } = office({
    plan, parallelTasks: 3,
    specialist: async (input) => {
      log.push(`start:${input.role}`);
      await new Promise((resolve) => setTimeout(resolve, input.role === 'legal' ? 120 : 5));
      log.push(`end:${input.role}`);
      return outcome(`## Summary\n${input.role} done.\n\n## Work\nDone.`);
    },
    synthesize: async () => outcome('## Executive summary\nDone.'),
  });
  await drain(workflow, 200);
  assert.ok(log.indexOf('start:product') > log.indexOf('end:research'));
  assert.ok(log.indexOf('start:product') < log.indexOf('end:legal'), log.join(' '));
  assert.ok(log.indexOf('end:product') < log.indexOf('end:legal'), 'PRODUCT even finishes while LEGAL is still working');
});

test('I. [free-only] restricts routing but is never stored or shown as text', async () => {
  assert.deepEqual(extractFreeOnly('[free-only] Plan the launch'), { text: 'Plan the launch', freeOnly: true });
  assert.deepEqual(extractFreeOnly('خطة [مجاني فقط] الإطلاق'), { text: 'خطة الإطلاق', freeOnly: true });
  // Persistence: the marker becomes jobs.free_only.
  const inserted = [];
  const db = { from: () => ({ insert: (values) => { inserted.push(values); return { select: () => ({ single: async () => ({ data: { id: 'j1', ...values }, error: null }) }) }; } }) };
  // db.js needs connection settings at import; nothing connects in this test.
  process.env.SUPABASE_URL ||= 'http://127.0.0.1:9';
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-only';
  const { SupabaseStore } = await import('../src/db.js');
  const store = new SupabaseStore(db);
  await store.createJob({ title: '[free-only] Plan the launch', goal: '[free-only] Plan the launch', projectId: 'ws-1' });
  assert.deepEqual([inserted[0].goal, inserted[0].title, inserted[0].free_only], ['Plan the launch', 'Plan the launch', true]);
  // Routing: the stored flag reaches every model call; the text never has it.
  const memory = new MemoryStore({ goal: 'Plan the launch' });
  memory.jobs[0].free_only = true;
  const runs = [];
  const workflow = new OfficeWorkflow({
    store: memory, now: () => memory.now,
    modelRunner: { run: async (args) => { runs.push(args); return { ...outcome(args.prompt.includes('Return JSON only') ? JSON.stringify(PLAN([{ id: 'a', agent: 'research', title: 'Market', brief: 'Research the market for the pilot.', depends_on: [] }])) : '## Summary\nDone.'), path: [] }; } },
    plan: async ({ run, goal }) => { const result = await run({ prompt: `Return JSON only ${goal}`, systemPrompt: '' }); return { ...result, plan: validatePlan(result.text) }; },
    specialist: async ({ run, goal }) => run({ prompt: goal, systemPrompt: '' }),
    synthesize: async ({ run, goal }) => run({ prompt: goal, systemPrompt: '' }),
  });
  await drain(workflow);
  assert.ok(runs.length >= 3);
  assert.ok(runs.every((args) => args.allowPaid === false));
  assert.ok(runs.every((args) => !/free-only/.test(args.prompt)));
});

test('J. [free-only] and [confidential] compose: both restrictions hold', () => {
  const both = officeRequest('[free-only] [confidential] Board figures');
  assert.deepEqual([both.freeOnly, both.dataClass, both.goal], [true, 'confidential', 'Board figures']);
  const stored = officeRequest('[confidential] Board figures', process.env, { freeOnly: true });
  assert.deepEqual([stored.freeOnly, stored.dataClass], [true, 'confidential']);
  assert.equal(officeRequest('Board figures').freeOnly, false);
});

test('K. a SOCIAL calendar table becomes a structured calendar artifact; times are assumptions', () => {
  const text = ['## Summary\nTwo weeks of posts.', '## Work', '| Date | Platform | Format | Hook | CTA | Posting time |', '|---|---|---|---|---|---|',
    '| Week 1 Mon | Instagram | Reel | Stop losing deliveries | Start trial | 7 PM |', '| Week 1 Tue | LinkedIn | Post | Why we built it | Book a demo | 9 AM |',
    '| Week 1 Wed | Instagram | Story | Behind the scenes | Reply | |'].join('\n');
  const result = socialCalendar(text);
  assert.equal(result.converted, 3);
  const calendar = parseArtifacts(result.text).artifacts.find((entry) => entry.type === 'content_calendar');
  assert.equal(calendar.data.entries.length, 3);
  assert.deepEqual([calendar.data.entries[0].cta, calendar.data.entries[0].time, calendar.data.entries[0].time_basis], ['Start trial', '7 PM', 'ASSUMPTION']);
  assert.doesNotMatch(result.text, /\| Week 1 Mon/);
  // An artifact the model wrote keeps its entries; unverified times are labelled.
  const own = socialCalendar(block({ type: 'content_calendar', entries: [{ date: 'Mon', platform: 'IG', hook: 'Hi', time: '12 AM' }] }));
  assert.equal(parseArtifacts(own.text).artifacts[0].data.entries[0].time_basis, 'ASSUMPTION');
});

test('L. process narration never reaches the delivered output', () => {
  const raw = 'Now I have current platform data. Let me build the 14-day launch calendar using the brand moodboard.\n\n## Summary\nA 14-day calendar.\n\n## Work\nLet me check the numbers.\nPosts go out daily.\n\nNow we launch in Dubai first.';
  const clean = cleanOutput(raw);
  assert.ok(clean.startsWith('## Summary'));
  assert.doesNotMatch(clean, /Now I have|Let me/);
  assert.match(clean, /Posts go out daily\./);
  assert.match(clean, /Now we launch in Dubai first\./, 'ordinary sentences stay');
  assert.equal(cleanOutput('I\'ll research this now.\nThe market has three players.'), 'The market has three players.');
});

test('M. search degradation is recorded once, falls back to fetch, and evidence is labelled honestly', async () => {
  let searches = 0;
  const executor = createOfficeToolExecutor({
    search: async () => { searches += 1; throw Object.assign(new Error('quota'), { code: 'SEARCH_RATE_LIMITED', status: 429 }); },
    fetchPage: async ({ url }) => (url.includes('down') ? { url, error: 'HTTP 500' } : { url, status: 200, text: 'ok' }),
  });
  const first = await executor({ name: 'web_search', arguments: { query: 'competitors' } });
  const second = await executor({ name: 'web_search', arguments: { query: 'pricing' } });
  assert.equal(searches, 1, 'the failing provider is not called again');
  assert.deepEqual([first.ok, first.result.error, second.result.error], [false, 'SEARCH_DEGRADED', 'SEARCH_DEGRADED']);
  await executor({ name: 'web_fetch', arguments: { url: 'https://a.example.com/pricing' } });
  await executor({ name: 'web_fetch', arguments: { url: 'https://down.example.com/' } });
  const report = executor.report();
  assert.deepEqual([report.searchDegraded, report.fetchOk, report.fetchFailures, report.fetchedUrls], [true, 1, 1, ['https://a.example.com/pricing']]);
  const text = `## Summary\nThree competitors.\n\n${block({ type: 'evidence', claims: [
    { claim: 'A charges AED 99', status: 'VERIFIED', source: 'https://a.example.com/pricing' },
    { claim: 'B charges AED 79', status: 'VERIFIED', source: 'https://b.example.com/pricing' }] })}`;
  const gated = evidenceGate(text, report);
  assert.equal(gated.insufficient, true);
  const claims = parseArtifacts(gated.text).artifacts[0].data.claims;
  assert.deepEqual(claims.map((claim) => claim.status), ['VERIFIED', 'UNKNOWN']);
  assert.match(gated.text, /## Evidence quality[\s\S]*INSUFFICIENT EVIDENCE/);
  // A normal (non-degraded) run is untouched.
  assert.equal(evidenceGate(text, { searchDegraded: false }).text, text);
});

test('CHIEF gate: unverified finance blocks the close and hides its figures', () => {
  const wrong = financeOutput({ ...RIGHT, year_revenue: 229000 }, 'Revenue is strong.');
  const gate = chiefGate([{ agent_slug: 'business-finance', title: 'Pilot model', content: wrong, task_id: 't1' }]);
  assert.equal(gate.blocked, true);
  assert.deepEqual(gate.banned, [229000]);
  const { text } = enforceFacts('Revenue will be AED 229,000 in year one.\nWe hire two people.', gate);
  assert.doesNotMatch(text, /229,000/);
  assert.match(text, /did not pass validation/);
  const drill = injectFinanceError(financeOutput());
  assert.ok(drill.injected.value > 78000);
  assert.equal(validateFinance(drill.text).state, FINANCE_STATES.INCONSISTENT);
});

test('no false alarms: scenarios, monthly figures, competitors and ordinary sentences are left alone', () => {
  const calc = calculateFinance(MODEL);
  const pessimistic = calc.sensitivity.find((entry) => entry.label === 'Customers −20%');
  const text = financeOutput({ first_year_revenue: 78000, breakeven: 4, total_costs: 17000 },
    `First-year revenue of AED 78,000. If customers are 20% fewer, first-year revenue would be AED ${pessimistic.year_revenue.toLocaleString('en-US')}. Over a 12-month horizon costs peak at AED 1,000 per month.`);
  assert.equal(validateFinance(text).state, FINANCE_STATES.VERIFIED, JSON.stringify(validateFinance(text).issues));
  const gate = chiefGate([{ agent_slug: 'business-finance', title: 'Pilot model', content: financeOutput(), task_id: 't1' }]);
  const { text: chief, removed } = enforceFacts('Great, demand is strong.\nThe main competitor reports annual revenue of AED 5,000,000.\nFirst-year revenue is AED 78,000.', gate);
  assert.equal(removed, 0);
  assert.match(chief, /Great, demand is strong\.[\s\S]*competitor[\s\S]*AED 78,000/);
  assert.equal(cleanOutput('## Summary\nGreat, demand is strong.\nLet me show you the plan: three steps.'), '## Summary\nGreat, demand is strong.\nLet me show you the plan: three steps.');
});
