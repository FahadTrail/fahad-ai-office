// V4.1 financial table fact gate: the FINANCE calculator is the only source
// of monthly financial truth. Every financial table, chart and figure in
// AUDIT's review and CHIEF's answer is checked against it row by row; a
// contradiction blocks, and CHIEF never keeps a contradictory table.
// Replays the live failure of job abaccdad (Sanad Desk) offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficeWorkflow } from '../src/workflow.js';
import { validatePlan } from '../src/chief.js';
import { parseArtifacts } from '../src/office/artifacts.js';
import { FINANCE_STATES, badScheduleTable, calculateFinance, financialTables, publishFinance, scheduleTable, validateFinance } from '../src/office/finance.js';
import { auditOwnTables, chiefGate, enforceAudit, enforceFacts, numericChecks, remainingContradictions, sanitizeFinancial, statesValue } from '../src/office/quality.js';
import { MemoryStore } from '../testing/fixtures/office-memory-store.js';

const block = (value) => `\`\`\`artifact\n${JSON.stringify(value)}\n\`\`\``;
const outcome = (text) => ({ text, tokensIn: 10, tokensOut: 5, costUsd: 0, durationMs: 5 });

// Sanad Desk (job abaccdad): AED 199/month per clinic, 82 clinics by month
// 12, AED 30,000 setup and AED 6,000/month running costs.
const SANAD = {
  type: 'financial_model', title: 'Sanad Desk 12-month model', currency: 'AED', months: 12,
  items: [{ category: 'Build', item: 'Setup', one_time: 30000, monthly: 0 }, { category: 'Run', item: 'Team & hosting', one_time: 0, monthly: 6000 }],
  revenue: { price_monthly: 199, starting_customers: 0, new_customers: [8, 8, 8, 7, 7, 7, 7, 6, 6, 6, 6, 6], churn_rate: 0 },
};
const CLAIMS = { year_revenue: 112236, year_costs: 102000, net: 10236, break_even_month: 12 };
const calc = calculateFinance(SANAD);
const REVENUE = [1592, 3184, 4776, 6169, 7562, 8955, 10348, 11542, 12736, 13930, 15124, 16318];
const CUMULATIVE = calc.schedule.cumulative;

// FINANCE's published (VERIFIED) output.
const financeText = () => {
  const raw = `## Summary\nFirst-year revenue of AED 112,236 against AED 102,000 of costs; net AED 10,236; cash break-even in month 12.\n\n${block({ ...SANAD, claims: CLAIMS })}\n\n## Handoff\nUse it.`;
  return publishFinance(raw, validateFinance(raw));
};
const FINANCE_OUT = { agent_slug: 'finance', task_id: 'task-fin', title: 'Sanad Desk model', content: financeText() };

// A model-written schedule table (the exact shape found in job abaccdad).
const modelTable = (revenue = REVENUE, { title = 'Sanad Desk 12-Month Financial Snapshot (AED)', total = null } = {}) => {
  let running = 0;
  const rows = revenue.map((value, index) => {
    const cost = index === 0 ? 36000 : 6000;
    running += value - cost;
    return [String(index + 1), value.toLocaleString('en-US'), cost.toLocaleString('en-US'), (value - cost).toLocaleString('en-US'), running.toLocaleString('en-US')];
  });
  if (total) rows.push(total);
  return { type: 'table', title, columns: ['Month', 'Revenue', 'Total Cost', 'Net Cash Flow', 'Cumulative Net'], rows };
};
const auditOut = (extra = '') => ({ agent_slug: 'qa-security', task_id: 'task-audit', title: 'Review', content: `## Summary\nReviewed.\n\n${block({ type: 'audit_report', verdict: 'PASS', findings: [] })}${extra}` });

test('calculator reproduces the Sanad Desk figures exactly', () => {
  assert.equal(calc.year_revenue, 112236);
  assert.equal(calc.year_costs, 102000);
  assert.equal(calc.net, 10236);
  assert.equal(calc.break_even_month, 12);
  assert.deepEqual(calc.schedule.revenue, REVENUE);
  assert.equal(CUMULATIVE[11], 10236);
  assert.equal(validateFinance(FINANCE_OUT.content).state, FINANCE_STATES.VERIFIED);
});

test('A. headline figures correct but a bad table → AUDIT BLOCKS', () => {
  const bad = badScheduleTable(calc);
  const product = { agent_slug: 'product', task_id: 'task-p', title: 'Plan', content: `## Summary\nRevenue of AED 112,236 in year one.\n\n${block(bad)}` };
  const checks = numericChecks([FINANCE_OUT, product]);
  const finding = checks.findings.find((entry) => entry.owner === 'product');
  assert.ok(finding, 'the bad table is a finding');
  assert.equal(finding.severity, 'blocked');
  assert.equal(finding.code, 'TABLE_YEAR_TOTAL_MISMATCH');
  assert.equal(finding.expected, '112,236');
  assert.equal(finding.actual, '111,489');
  const report = enforceAudit(auditOut().content, checks);
  const artifact = parseArtifacts(report).artifacts.find((entry) => entry.type === 'audit_report');
  assert.equal(artifact.data.verdict, 'BLOCKED');
});

test('B. one wrong monthly row → BLOCK', () => {
  const revenue = [...REVENUE];
  revenue[6] = 10300; // month 7 only (true 10,348)
  const product = { agent_slug: 'product', task_id: 'task-p', title: 'Plan', content: block(modelTable(revenue)) };
  const checks = numericChecks([FINANCE_OUT, product]);
  const finding = checks.findings.find((entry) => entry.owner === 'product');
  assert.equal(finding.severity, 'blocked');
  assert.ok(finding.mismatches.some((entry) => entry.code === 'TABLE_SCHEDULE_MISMATCH' && entry.field === 'table:revenue' && entry.expected === 10348 && entry.actual === 10300));
  // The correct schedule passes.
  const good = numericChecks([FINANCE_OUT, { ...product, content: block(modelTable()) }]);
  assert.equal(good.findings.length, 0, JSON.stringify(good.findings));
});

test('C. correct monthly rows but a wrong annual total → BLOCK', () => {
  const table = modelTable(REVENUE, { total: ['Total', '111,489', '102,000', '9,489', ''] });
  const issues = financialTables(block(table), calc)[0].issues;
  assert.ok(issues.some((entry) => entry.code === 'TABLE_YEAR_TOTAL_MISMATCH' && entry.expected === 112236 && entry.actual === 111489));
  assert.ok(issues.some((entry) => entry.code === 'TABLE_YEAR_TOTAL_MISMATCH' && entry.expected === 10236 && entry.actual === 9489));
  // A Markdown table is checked the same way.
  const markdown = '| Month | Revenue | Net |\n| --- | --- | --- |\n| 1 | 1,592 | -34,408 |\n| Total | 111,489 | 9,489 |';
  const checks = numericChecks([FINANCE_OUT, { agent_slug: 'product', task_id: 'p', title: 'Plan', content: markdown }]);
  assert.equal(checks.findings[0].severity, 'blocked');
  assert.equal(checks.findings[0].code, 'TABLE_YEAR_TOTAL_MISMATCH');
});

test('D. correct totals but a wrong break-even → BLOCK', () => {
  const table = { type: 'table', title: 'Headline figures (AED)', columns: ['Figure', 'Value'], rows: [['Total revenue (12 months)', '112,236'], ['Total costs (12 months)', '102,000'], ['Net (12 months)', '10,236'], ['Cash break-even', 'Month 11']] };
  const checks = numericChecks([FINANCE_OUT, { agent_slug: 'product', task_id: 'p', title: 'Plan', content: block(table) }]);
  assert.equal(checks.findings.length, 1);
  assert.equal(checks.findings[0].code, 'BREAK_EVEN_MISMATCH');
  assert.equal(checks.findings[0].severity, 'blocked');
  const fixed = { ...table, rows: [...table.rows.slice(0, 3), ['Cash break-even', 'Month 12']] };
  assert.equal(numericChecks([FINANCE_OUT, { agent_slug: 'product', task_id: 'p', title: 'Plan', content: block(fixed) }]).findings.length, 0);
});

test('E. the calculator table passes every check', () => {
  const table = scheduleTable(calc);
  assert.equal(table.calculated, true);
  assert.deepEqual(table.rows.at(-1), ['Total', '112,236', '102,000', '10,236', '10,236']);
  assert.deepEqual(financialTables(block(table), calc)[0].issues, []);
  const checks = numericChecks([FINANCE_OUT, { agent_slug: 'product', task_id: 'p', title: 'Plan', content: block(table) }]);
  assert.equal(checks.findings.length, 0);
  // FINANCE's own output with the calculator table stays VERIFIED; a wrong
  // model schedule in FINANCE's own output is INCONSISTENT (strict rows).
  assert.equal(validateFinance(`${FINANCE_OUT.content}\n\n${block(table)}`).state, FINANCE_STATES.VERIFIED);
  const own = validateFinance(`${FINANCE_OUT.content}\n\n${block(badScheduleTable(calc))}`);
  assert.equal(own.state, FINANCE_STATES.INCONSISTENT);
  assert.ok(own.issues.some((entry) => entry.code === 'TABLE_SCHEDULE_MISMATCH'));
});

test('F. a model-written table is replaced by the calculator table or removed', () => {
  const gate = chiefGate([FINANCE_OUT]);
  // Wrong schedule → replaced by the calculator schedule.
  const wrong = enforceFacts(`## Answer\nThe numbers are below.\n\n${block(badScheduleTable(calc))}\n\nNext steps follow.`, gate);
  const tables = parseArtifacts(wrong.text).artifacts.filter((entry) => entry.type === 'table');
  assert.equal(tables.length, 1);
  assert.match(tables[0].title, /calculated by code/);
  assert.doesNotMatch(wrong.text, /111,489|9,489|16,211/);
  assert.equal(wrong.tables, 1);
  assert.equal(wrong.remaining, 0);
  // A correct but model-written schedule is still a second schedule: replaced.
  const restated = enforceFacts(`## Answer\n\n${block(modelTable())}`, gate);
  assert.equal(parseArtifacts(restated.text).artifacts.filter((entry) => entry.type === 'table' && !/calculated by code/.test(entry.title)).length, 0);
  // A wrong Markdown headline table is removed (the validated figures replace it).
  const markdown = enforceFacts('## Answer\n| Figure | Value |\n| --- | --- |\n| Year-1 revenue | AED 111,489 |\n| Net (12 months) | AED 9,489 |\n\nDone.', gate);
  assert.doesNotMatch(markdown.text, /111,489|9,489/);
  assert.match(markdown.text, /Done\./);
  assert.equal(markdown.remaining, 0);
  // A hand-drawn schedule chart that disagrees is removed too.
  const chart = { type: 'chart', title: 'Cumulative cash', labels: REVENUE.map((_, index) => `M${index + 1}`), series: [{ name: 'Cumulative cash', values: CUMULATIVE.map((value, index) => (index === 11 ? 9489 : value)) }] };
  const drawn = sanitizeFinancial(`Chart:\n${block(chart)}`, calc);
  assert.equal(drawn.removed.length, 1);
  assert.equal(parseArtifacts(drawn.text).artifacts.filter((entry) => entry.type === 'chart').length, 0);
});

test('G. prose numbers are still checked (headline, near misses, named months)', () => {
  const gate = chiefGate([FINANCE_OUT]);
  const text = [
    '## Answer',
    'First-year revenue reaches AED 111,489.',
    'Net result over 12 months: AED 9,489.',
    'By month 12, cumulative cash reaches AED 9,489.',
    'Revenue in month 12 is AED 16,211.',
    'Break-even arrives in month 11.',
    'Revenue in month 12 is AED 16,318 and first-year revenue is about AED 112K.',
    'The team is ready.',
  ].join('\n');
  const result = enforceFacts(text, gate);
  for (const wrong of ['111,489', '9,489', '16,211', 'month 11']) assert.ok(!result.text.includes(wrong), wrong);
  assert.match(result.text, /AED 16,318 and first-year revenue is about AED 112K/, 'correct and correctly rounded figures stay');
  assert.match(result.text, /The team is ready\./);
  assert.equal(result.remaining, 0);
  assert.ok(result.removed >= 5);
  // Precision-aware matching.
  assert.equal(statesValue('112K', 112000, 112236), true);
  assert.equal(statesValue('111,489', 111489, 112236), false);
  assert.equal(statesValue('112,236', 112236, 112236), true);
});

test('H. non-financial tables are unaffected', () => {
  const tables = [
    { type: 'table', title: 'MVP scope', columns: ['Feature', 'Priority', 'Owner'], rows: [['Booking', 'P0', 'PRODUCT'], ['Reminders', 'P1', 'PRODUCT']] },
    { type: 'table', title: 'Competitors', columns: ['Competitor', 'Price (AED/month)', 'Annual revenue'], rows: [['Clinicy', '299', '4,000,000'], ['Total revenue (market)', '', '9,000,000']] },
    { type: 'table', title: 'Launch timeline', columns: ['Week', 'Milestone'], rows: [['1', 'Pilot clinic'], ['12', 'Month 12 review']] },
  ];
  const content = `## Plan\n${tables.map(block).join('\n\n')}\n\n| Channel | Budget share |\n| --- | --- |\n| Instagram | 60% |\n| Referrals | 40% |`;
  const checks = numericChecks([FINANCE_OUT, { agent_slug: 'product', task_id: 'p', title: 'Plan', content }]);
  assert.equal(checks.findings.length, 0, JSON.stringify(checks.findings));
  const gate = chiefGate([FINANCE_OUT]);
  const kept = enforceFacts(content, gate);
  assert.equal(kept.tables, 0);
  assert.equal(parseArtifacts(kept.text).artifacts.filter((entry) => entry.type === 'table').length, 3);
  assert.match(kept.text, /\| Instagram \| 60% \|/);
});

test('I. VERIFIED never coexists with contradictory final content', () => {
  const gate = chiefGate([FINANCE_OUT]);
  const contradictory = `## Answer\nFirst-year revenue of AED 111,489.\n\n${block(badScheduleTable(calc))}`;
  assert.ok(remainingContradictions(contradictory, gate) > 0);
  const enforced = enforceFacts(contradictory, gate);
  assert.equal(remainingContradictions(enforced.text, gate), 0);
  // The stored FINANCE validation state describes the stored content (PR #70):
  // a FINANCE text carrying a wrong schedule is never stored as VERIFIED.
  const store = new MemoryStore({ goal: 'x' });
  const workflow = new OfficeWorkflow({ store, now: () => store.now, pollIntervalMs: 10, plan: async () => ({}), specialist: async () => ({}), synthesize: async () => ({}) });
  const drifted = `${FINANCE_OUT.content}\n\n${block(badScheduleTable(calc))}`;
  return workflow.persistOutputs({ job_id: 'job', task_id: 'task' }, { key: 'finance', slug: 'finance' }, drifted, null).then(() => {
    const model = store.artifacts.find((row) => row.type === 'financial_model');
    assert.equal(model.data.validation.state, FINANCE_STATES.INCONSISTENT);
  });
});

test('AUDIT\'s own draft: a wrong table is BLOCKED, removed and resolved by code', () => {
  const checks = numericChecks([FINANCE_OUT]);
  assert.equal(checks.calculated.year_revenue, 112236);
  const draft = `## Summary\nReviewed.\n\n${block({ type: 'audit_report', verdict: 'PASS', findings: [] })}\n\n## Financial snapshot\n${block(badScheduleTable(calc))}`;
  const own = auditOwnTables(draft, checks);
  assert.equal(own.findings.length, 1);
  assert.equal(own.findings[0].severity, 'blocked');
  assert.equal(own.findings[0].resolved, true);
  assert.doesNotMatch(own.text, /111,489|9,489/);
  const report = enforceAudit(own.text, { ...checks, findings: [...checks.findings, ...own.findings] });
  const artifact = parseArtifacts(report).artifacts.find((entry) => entry.type === 'audit_report');
  assert.ok(artifact.data.findings.some((finding) => finding.code === 'TABLE_YEAR_TOTAL_MISMATCH' && finding.actual === '111,489'));
  assert.match(report, /RESOLVED BY CODE/);
  // Resolved: CHIEF is not blocked by it, but its wrong figures stay banned.
  const gate = chiefGate([FINANCE_OUT, { ...auditOut(), content: report }]);
  assert.equal(gate.openAudit.length, 0);
  assert.equal(gate.blocked, false);
  assert.ok(gate.banned.includes(111489) && gate.banned.includes(9489));
});

// ---------------------------------------------------------------- workflow

const PLAN = (workstreams) => ({ route: 'orchestrate', plan_summary: 'Plan.', synthesis_brief: 'One answer.', workstreams });
function office({ plan, specialist, synthesize, goal }) {
  const store = new MemoryStore({ goal });
  const workflow = new OfficeWorkflow({
    store, parallelTasks: 1, now: () => store.now, pollIntervalMs: 10,
    plan: async () => ({ ...outcome(JSON.stringify(plan)), plan: validatePlan(JSON.stringify(plan)) }),
    specialist, synthesize,
  });
  return { store, workflow };
}
async function drain(workflow, limit = 80) {
  for (let index = 0; index < limit; index += 1) if (!await workflow.runOnce()) return;
  throw new Error('Workflow did not become idle');
}
const FINANCE_RAW = `## Summary\nFirst-year revenue of AED 112,236 against AED 102,000 of costs; net AED 10,236; cash break-even in month 12.\n\n${block({ ...SANAD, claims: CLAIMS })}\n\n## Handoff\nUse it.\n\n## Decisions for Fahad\nNone`;
const SANAD_PLAN = PLAN([
  { id: 'money', agent: 'finance', title: 'Sanad Desk model', brief: 'Model the 12-month costs and revenue.', depends_on: [] },
  { id: 'review', agent: 'audit', title: 'Review', brief: 'Review every figure before the final answer.', depends_on: ['money'] },
]);

test('J + offline replay (job abaccdad): AUDIT blocks the bad table, CHIEF never outputs it', async () => {
  const bad = badScheduleTable(calc);
  assert.deepEqual(bad.rows.at(-1), ['Total', '111,489', '102,000', '9,489', '']);
  assert.equal(bad.rows[11][4], '9,489');
  const synthesized = [];
  const { store, workflow } = office({
    goal: 'Sanad Desk: 12-month financial check.', plan: SANAD_PLAN,
    // The models reproduce the live failure: AUDIT writes its own 12-month
    // snapshot and CHIEF copies it (with the wrong figures in prose too).
    specialist: async (input) => (input.role === 'audit'
      ? outcome(`## Summary\nFigures reviewed.\n\n${block({ type: 'audit_report', verdict: 'PASS', findings: [] })}\n\n## Sanad Desk 12-Month Financial Snapshot\n${block(bad)}`)
      : outcome(FINANCE_RAW)),
    synthesize: async (input) => {
      synthesized.push(input);
      return outcome(`## Executive summary\nSanad Desk earns AED 111,489 in first-year revenue and a net result over 12 months of AED 9,489; break-even in month 12.\n\n${block(bad)}\n\n## Next steps\nSign the pilot clinics.`);
    },
  });
  await drain(workflow);
  // AUDIT blocked the table and it never left AUDIT.
  const auditEvent = store.events.find((event) => event.payload?.kind === 'audit_table_gate');
  assert.ok(auditEvent, 'AUDIT table gate fired');
  assert.equal(auditEvent.payload.blocked[0].actual, '111,489');
  const auditResult = store.results.find((row) => row.agent_slug === 'qa-security' || /Figures reviewed/.test(row.content || ''));
  assert.ok(auditResult);
  const tableValues = (content) => parseArtifacts(content).artifacts.filter((entry) => entry.type === 'table').flatMap((entry) => entry.data.rows.flat());
  assert.ok(!tableValues(auditResult.content).some((cell) => ['111,489', '9,489', '16,211'].includes(cell)), 'the bad table left AUDIT');
  assert.match(auditResult.content, /RESOLVED BY CODE/);
  assert.ok(synthesized[0].outputs.every((output) => !tableValues(output.content).includes('111,489')), 'CHIEF never received the bad table');
  assert.match(synthesized[0].facts, /validated_year_revenue = AED 112,236/);
  assert.match(synthesized[0].facts, /Never write your own monthly schedule/);
  // CHIEF's final answer: only calculator-consistent figures.
  const final = store.results.find((row) => row.kind === 'final').content;
  for (const wrong of ['111,489', '9,489', '16,211']) assert.ok(!final.includes(wrong), `final answer carries ${wrong}`);
  assert.doesNotMatch(final, /Not closed/);
  assert.match(final, /Sign the pilot clinics/);
  assert.match(final, /Revenue over 12 months \| AED 112,236/);
  assert.match(final, /Total costs over 12 months \| AED 102,000/);
  assert.match(final, /Net result over 12 months \| AED 10,236/);
  assert.match(final, /Cash break-even \| month 12/);
  const tables = parseArtifacts(final).artifacts.filter((entry) => entry.type === 'table');
  assert.equal(tables.length, 1);
  assert.match(tables[0].title, /calculated by code/);
  assert.deepEqual(tables[0].data.rows.at(-1), ['Total', '112,236', '102,000', '10,236', '10,236']);
  const enforced = store.events.find((event) => event.payload?.kind === 'fact_gate_enforced');
  assert.equal(enforced.payload.remaining, 0);
  assert.equal(enforced.payload.blocked, false);
  assert.ok(enforced.payload.tables >= 1);
  // Every stored table artifact of the final answer matches the calculator.
  const stored = store.artifacts.filter((row) => row.type === 'table');
  for (const row of stored) assert.deepEqual(financialTables(block({ type: 'table', title: row.title, ...row.data }), calc).flatMap((entry) => entry.issues), [], row.title);
});

test('J (drill): [drill:finance-table] injects the bad table into AUDIT and CHIEF; both are caught', async () => {
  const { store, workflow } = office({
    goal: '[drill:finance-table] Sanad Desk: 12-month financial check.', plan: SANAD_PLAN,
    specialist: async (input) => (input.role === 'audit' ? outcome(`## Summary\nFigures reviewed.\n\n${block({ type: 'audit_report', verdict: 'PASS', findings: [] })}`) : outcome(FINANCE_RAW)),
    synthesize: async (input) => {
      assert.doesNotMatch(input.goal, /drill/);
      return outcome('## Executive summary\nSanad Desk reaches cash break-even in month 12 with first-year revenue of AED 112,236.');
    },
  });
  await drain(workflow);
  const drills = store.events.filter((event) => event.payload?.kind === 'finance_table_drill');
  assert.deepEqual(drills.map((event) => [event.payload.stage, event.payload.revenue, event.payload.net]), [['audit_draft', '111,489', '9,489'], ['chief_draft', '111,489', '9,489']]);
  assert.ok(store.events.some((event) => event.payload?.kind === 'audit_table_gate'));
  const audit = store.artifacts.find((row) => row.type === 'audit_report');
  assert.ok(audit.data.findings.some((finding) => finding.severity === 'blocked' && finding.actual === '111,489' && finding.resolved === true));
  const final = store.results.find((row) => row.kind === 'final').content;
  assert.ok(!final.includes('111,489') && !final.includes('9,489'));
  assert.doesNotMatch(final, /Not closed/);
  assert.match(final, /first-year revenue of AED 112,236/);
});

test('a wrong table from another employee is BLOCKED, returned to its owner, and resolved by the revision', async () => {
  const plan = PLAN([
    { id: 'money', agent: 'finance', title: 'Sanad Desk model', brief: 'Model the 12-month costs and revenue.', depends_on: [] },
    { id: 'scope', agent: 'product', title: 'Pilot plan', brief: 'Write the pilot plan with the business case.', depends_on: ['money'] },
    { id: 'review', agent: 'audit', title: 'Review', brief: 'Review every figure before the final answer.', depends_on: ['scope'] },
  ]);
  const revisions = [];
  const { store, workflow } = office({
    goal: 'Sanad Desk pilot plan.', plan,
    specialist: async (input) => {
      if (input.role === 'finance') return outcome(FINANCE_RAW);
      if (input.role === 'audit') return outcome(`## Summary\nReviewed.\n\n${block({ type: 'audit_report', verdict: 'PASS', findings: [] })}`);
      if (input.revision) { revisions.push(input.revision); return outcome('## Summary\nPilot plan; the monthly figures are FINANCE\'s calculated schedule.'); }
      return outcome(`## Summary\nPilot plan.\n\n${block(badScheduleTable(calc))}`);
    },
    synthesize: async () => outcome('## Executive summary\nThe pilot is ready; cash break-even in month 12.'),
  });
  await drain(workflow);
  const audit = store.artifacts.find((row) => row.type === 'audit_report');
  assert.equal(audit.data.verdict, 'BLOCKED');
  assert.ok(audit.data.findings.some((finding) => finding.owner === 'product' && finding.severity === 'blocked' && finding.actual === '111,489'));
  assert.equal(revisions.length, 1, 'returned to PRODUCT');
  assert.match(revisions[0], /AUDIT numeric finding \(BLOCKED\)/);
  const final = store.results.find((row) => row.kind === 'final').content;
  assert.doesNotMatch(final, /Not closed|111,489|9,489/);
  assert.match(final, /Cash break-even \| month 12/);
});
