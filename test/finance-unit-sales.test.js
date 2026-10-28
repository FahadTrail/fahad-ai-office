import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateFinance, validateFinance, FINANCE_STATES } from '../src/office/finance.js';
import { ARTIFACT_TYPES } from '../src/office/artifacts.js';

// Production acceptance 2026-10-27 (jobs ace99f39, 196b2d92): a café priced
// per cup could not be expressed — the revenue schema only knew
// subscriptions, the sanitizer dropped anything else, and FINANCE's revenue
// was always "0 from the stated inputs".
const CAFE = {
  currency: 'AED', months: 12,
  items: [
    { category: 'CapEx', item: 'Equipment', one_time: 60000, monthly: 0, month: 1, basis: 'KNOWN' },
    { category: 'Fixed', item: 'Rent', one_time: 0, monthly: 8000, month: 1, basis: 'KNOWN' },
    { category: 'Fixed', item: 'Salaries (3 × 5,000)', one_time: 0, monthly: 15000, month: 1, basis: 'KNOWN' },
  ],
  revenue: { unit_price: 18, units_per_day: 80, days_per_month: 30, unit_cost: 4.5, basis: 'ASSUMPTION' },
};

test('unit sales: units × price, cost per unit, break-even in units and months', () => {
  const calc = calculateFinance(CAFE);
  assert.equal(calc.model, 'unit_sales');
  assert.deepEqual([calc.year_revenue, calc.total_variable, calc.year_costs, calc.net], [518400, 129600, 465600, 52800]);
  assert.deepEqual([calc.contribution_per_unit, calc.break_even_units_per_month, calc.break_even_month], [13.5, 1704, 7]);
  assert.equal(calc.schedule.units[0], 2400);
  const ramp = calculateFinance({ ...CAFE, revenue: { unit_price: 18, units_per_month: [1200, 1800, 2400], unit_cost: 4.5 } });
  assert.deepEqual(ramp.schedule.units.slice(0, 4), [1200, 1800, 2400, 2400], 'a short list carries its last value forward');
  assert.ok(calculateFinance(CAFE).sensitivity.some((entry) => entry.label === 'Price −20%' && entry.year_revenue === 414720));
});

test('the sanitizer keeps unit-sales inputs, so a correct café model validates', () => {
  const clean = ARTIFACT_TYPES.financial_model.clean({ type: 'financial_model', title: 'Café', ...CAFE, claims: { year_revenue: 518400, year_costs: 465600, net: 52800, break_even_month: 7 } });
  assert.deepEqual(clean.revenue, { unit_price: 18, units_per_day: 80, days_per_month: 30, unit_cost: 4.5, basis: 'ASSUMPTION', note: '' });
  const markdown = `## Summary\nالتعادل النقدي التراكمي: الشهر 7.\n\n\`\`\`artifact\n${JSON.stringify({ type: 'financial_model', title: 'Café', ...CAFE, claims: { year_revenue: 518400, year_costs: 465600, net: 52800, break_even_month: 7 } })}\n\`\`\``;
  const result = validateFinance(markdown);
  assert.equal(result.state, FINANCE_STATES.VERIFIED, JSON.stringify(result.issues));
  assert.doesNotThrow(() => JSON.parse(ARTIFACT_TYPES.financial_model.hint), 'the example FINANCE sees is valid JSON');
});
