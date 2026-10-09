// Finance totals stay authoritative: AED 13,000 a year is AED 13,000, never
// 12 × 1,083.33 = 12,999.96 (production acceptance, 2026-10-09).
import test from 'node:test';
import assert from 'node:assert/strict';
import { FINANCE_STATES, allocateCents, calculateFinance, validateFinance } from '../src/office/finance.js';
import { ARTIFACT_TYPES } from '../src/office/artifacts.js';

const sum = (list) => Math.round(list.reduce((total, value) => total + value * 100, 0)) / 100;
const block = (data) => `\`\`\`artifact\n${JSON.stringify(data)}\n\`\`\``;

test('allocateCents keeps the exact total and rounds each month once', () => {
  const months = allocateCents(Array(12).fill(13000 / 12));
  assert.equal(sum(months), 13000);
  assert.ok(months.every((value) => value === 1083.33 || value === 1083.34));
  assert.deepEqual(allocateCents([100, 200, 0]), [100, 200, 0]);
  assert.equal(sum(allocateCents([0.005, 0.005, 0.005])), 0.02); // 1.5 cents → 2 cents, spread
  assert.equal(sum(allocateCents([-10 / 3, -10 / 3, -10 / 3])), -10);
});

test('PRODUCTION REGRESSION: an exact monthly accrual of a yearly AED 13,000 totals 13,000', () => {
  // The production FINANCE line: monthly = 13,000 / 12 (unrounded).
  const calc = calculateFinance({ currency: 'AED', items: [{ item: 'Weekly check-in', monthly: 13000 / 12, month: 1 }] });
  assert.equal(calc.year_costs, 13000);
  assert.equal(calc.total_fixed, 13000);
  assert.equal(sum(calc.schedule.costs), 13000);
  assert.equal(sum(calc.schedule.fixed), 13000);
});

test('annual and weekly cost lines spread without losing a cent', () => {
  const yearly = calculateFinance({ currency: 'AED', items: [{ item: 'Licence', annual: 13000 }] });
  assert.equal(yearly.year_costs, 13000);
  // 5 people × 0.5 h × AED 100 = AED 250 a week; 52 weeks = 13,000.
  const weekly = calculateFinance({ currency: 'AED', items: [{ item: 'Weekly check-in', weekly: 250 }] });
  assert.equal(weekly.year_costs, 13000);
  assert.equal(sum(weekly.schedule.costs), 13000);
  // Two years of a weekly cost: 104 weeks.
  assert.equal(calculateFinance({ months: 24, items: [{ item: 'x', weekly: 250 }] }).year_costs, 26000);
});

test('the artifact cleaner keeps annual and weekly lines', () => {
  const cleaned = ARTIFACT_TYPES.financial_model.clean({ currency: 'AED', items: [{ item: 'A', annual: 1200 }, { item: 'B', weekly: 10 }, { item: 'C', monthly: 5 }] });
  assert.equal(cleaned.items[0].annual, 1200);
  assert.equal(cleaned.items[1].weekly, 10);
  assert.equal('annual' in cleaned.items[2], false);
});

test('a claim of AED 13,000 for a 13,000 / 12 monthly line now validates', () => {
  const output = `## Summary\nThe 12-month time cost is AED 13,000.\n\n${block({ type: 'financial_model', title: 'Check-in', currency: 'AED', items: [{ item: 'Check-in', monthly: 13000 / 12, basis: 'ESTIMATED' }], claims: { year_costs: 13000 } })}`;
  const validation = validateFinance(output);
  assert.equal(validation.state, FINANCE_STATES.VERIFIED, JSON.stringify(validation.issues));
  assert.equal(validation.calculated.year_costs, 13000);
});

test('integer models keep their exact schedules (no regression)', () => {
  const calc = calculateFinance({ items: [{ item: 'Setup', one_time: 5000 }, { item: 'Team', monthly: 1000 }], revenue: { price_monthly: 100, new_customers: 10 } });
  assert.equal(calc.year_costs, 17000);
  assert.deepEqual(calc.schedule.costs, [6000, ...Array(11).fill(1000)]);
  assert.equal(calc.year_revenue, sum(calc.schedule.revenue));
  assert.equal(calc.net, Math.round((calc.year_revenue - calc.year_costs) * 100) / 100);
  assert.equal(calc.schedule.cumulative.at(-1), calc.net);
});

test('PRODUCTION REGRESSION: a costs-only model may truthfully state revenue 0 and net = −costs', () => {
  const model = (claims) => `## Summary\nAED 13,000 a year.\n\n${block({ type: 'financial_model', title: 'Check-in', currency: 'AED', items: [{ item: 'Check-in', weekly: 250 }], claims })}`;
  assert.equal(validateFinance(model({ year_costs: 13000, year_revenue: 0, net: -13000 })).state, FINANCE_STATES.VERIFIED);
  // A non-zero revenue, or a wrong net, is still caught.
  assert.equal(validateFinance(model({ year_costs: 13000, year_revenue: 5000 })).state, FINANCE_STATES.INCONSISTENT);
  assert.equal(validateFinance(model({ year_costs: 13000, net: -9000 })).state, FINANCE_STATES.INCONSISTENT);
});

test('PRODUCTION REGRESSION: "AED 250 × 52 = AED 13,000" states 13,000, not 250', () => {
  const output = `## Summary\n- Weekly cost: 5 × 0.5 h × AED 100 = **AED 250**\n- Yearly cost: AED 250 × 52 = **AED 13,000** (KNOWN)\n\n${block({ type: 'financial_model', title: 'Check-in', currency: 'AED', items: [{ item: 'Check-in', weekly: 250, basis: 'KNOWN' }], claims: { year_costs: 13000, year_revenue: 0, net: -13000 } })}`;
  const validation = validateFinance(output);
  assert.equal(validation.state, FINANCE_STATES.VERIFIED, JSON.stringify(validation.issues));
  // A wrong result after "=" is still caught.
  const wrong = validateFinance(output.replace('**AED 13,000** (KNOWN)', '**AED 12,000** (KNOWN)'));
  assert.equal(wrong.state, FINANCE_STATES.INCONSISTENT);
  assert.match(wrong.issues[0].detail, /12,000/);
});
