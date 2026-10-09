// Deterministic finance layer. FINANCE (a model) proposes the structure and
// the assumptions; this module does the arithmetic and decides whether the
// numbers FINANCE states are true. No model is ever asked to add numbers.
//
// Source-of-truth order:
//   deterministic calculation → validated artifact → AUDIT → CHIEF synthesis
//
// A financial_model artifact carries:
//   items    — cost lines: one_time (in `month`, default 1) and recurring
//              costs from `month` on — monthly, annual (a yearly amount) or
//              weekly (52 weeks a year) — each KNOWN / ESTIMATED / ASSUMPTION
//   revenue  — optional: either a subscription model
//                {price_monthly, starting_customers, new_customers (number or
//                 list per month), churn_rate (0–1 per month), trial_months}
//              or an explicit schedule {monthly:[…]} (itself an assumption)
//   variable_cost_per_customer, starting_cash, months (default 12)
//   claims   — the headline figures FINANCE states (year_revenue,
//              year_costs, net, break_even_month, …), checked against code
//
// validateFinance() recalculates everything from those inputs and compares
// every stated number — claims, chart series, table totals, monthly tables
// and the prose summary — with the calculation.

import { ARTIFACT_TYPES } from './artifacts.js';

export const FINANCE_STATES = Object.freeze({ VERIFIED: 'VERIFIED', INCONSISTENT: 'INCONSISTENT', INSUFFICIENT: 'INSUFFICIENT DATA' });

const BLOCK = /```artifact\s*\n([\s\S]*?)```/g;
const MONEY_FIGURE = /(?:AED|USD|US\$|\$|€|£|درهم)\s*~?\s*\d|\d[\d,.]*\s*(?:k|m|mn)?\s*(?:AED|USD|dirhams?|درهم)\b/i;
const MAX_MONTHS = 36;
const round2 = (value) => Math.round(value * 100) / 100;
const WEEKS_PER_MONTH = 52 / 12;

// Financial rounding that keeps totals authoritative: the total is the exact
// sum rounded once to cents, and the monthly values are rounded so they add
// up to exactly that total (largest remainder). Rounding each month first and
// then summing turned AED 13,000 a year into 12 × 1,083.33 = 12,999.96.
export function allocateCents(values) {
  const exact = values.map((value) => Number(value) || 0);
  const cents = exact.map((value) => value * 100);
  const target = Math.round(cents.reduce((total, value) => total + value, 0));
  const floors = cents.map((value) => Math.floor(value + 1e-7));
  let remaining = target - floors.reduce((total, value) => total + value, 0);
  const order = cents.map((value, index) => [value - floors[index], index]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let step = 0; remaining > 0 && order.length; step += 1, remaining -= 1) floors[order[step % order.length][1]] += 1;
  for (let step = order.length - 1; remaining < 0 && order.length; step -= 1, remaining += 1) floors[order[(step + order.length) % order.length][1]] -= 1;
  return floors.map((value) => value / 100);
}
const finite = (value) => (value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : parseAmount(value));

// "AED 43,071", "~229k", "1.2M", "12.5%" → number (percent stays as written).
export function parseAmount(raw) {
  const match = String(raw ?? '').replace(/[٬,](?=\d{3}\b)/g, '').match(/-?\d+(?:\.\d+)?\s*(k|m|mn|million|thousand|ألف|مليون)?/i);
  if (!match) return null;
  const base = Number(match[0].replace(/[^\d.-]/g, ''));
  const unit = (match[1] || '').toLowerCase();
  const scale = unit === 'k' || unit === 'thousand' || unit === 'ألف' ? 1_000 : unit.startsWith('m') || unit === 'مليون' ? 1_000_000 : 1;
  return Number.isFinite(base) ? base * scale : null;
}

// Two figures agree when they differ by no more than the larger of an
// absolute unit and a relative tolerance (rounding such as "~43k").
export function agrees(actual, expected, { relative = 0.01, absolute = 1 } = {}) {
  if (actual === null || expected === null) return false;
  return Math.abs(actual - expected) <= Math.max(absolute, Math.abs(expected) * relative);
}

const perMonth = (value, months, fallback = 0) => {
  if (Array.isArray(value)) {
    const list = value.map(finite);
    return Array.from({ length: months }, (_, index) => list[Math.min(index, list.length - 1)] ?? fallback);
  }
  const single = finite(value);
  return Array.from({ length: months }, () => single ?? fallback);
};

// The calculation. Inputs are the (cleaned) artifact data; the output is a
// full monthly schedule plus the derived figures, reproducible from inputs.
export function calculateFinance(data = {}) {
  const months = Math.min(MAX_MONTHS, Math.max(1, Math.round(finite(data.months) || 12)));
  const items = Array.isArray(data.items) ? data.items : [];
  const revenueInput = data.revenue && typeof data.revenue === 'object' ? data.revenue : null;
  const variable = Math.max(0, finite(data.variable_cost_per_customer) || 0);
  const oneTime = Array(months).fill(0);
  const fixed = Array(months).fill(0);
  for (const item of items) {
    const start = Math.min(months, Math.max(1, Math.round(finite(item.month) || 1)));
    if (finite(item.one_time)) oneTime[start - 1] += finite(item.one_time);
    // Recurring: monthly, or a yearly / weekly amount spread exactly (no early rounding).
    const recurring = (finite(item.monthly) || 0) + (finite(item.annual) || 0) / 12 + (finite(item.weekly) || 0) * WEEKS_PER_MONTH;
    if (recurring) for (let month = start; month <= months; month += 1) fixed[month - 1] += recurring;
  }
  const customers = Array(months).fill(0);
  const paying = Array(months).fill(0);
  const revenue = Array(months).fill(0);
  let model = 'costs_only';
  if (revenueInput && Array.isArray(revenueInput.monthly) && revenueInput.monthly.some((value) => finite(value) !== null)) {
    model = 'explicit_schedule';
    perMonth(revenueInput.monthly, months).forEach((value, index) => { revenue[index] = Math.max(0, value); });
  } else if (revenueInput && finite(revenueInput.price_monthly) !== null) {
    model = 'subscription';
    const price = finite(revenueInput.price_monthly);
    const churn = Math.min(1, Math.max(0, finite(revenueInput.churn_rate) || 0));
    const additions = perMonth(revenueInput.new_customers, months);
    const trial = Math.max(0, Math.round(finite(revenueInput.trial_months) || 0));
    let active = Math.max(0, Math.round(finite(revenueInput.starting_customers) || 0));
    for (let index = 0; index < months; index += 1) {
      const churned = Math.round(active * churn);
      active = Math.max(0, active - churned + Math.max(0, Math.round(additions[index] || 0)));
      customers[index] = active;
    }
    // A trial delays billing: customers pay from `trial` months after joining
    // (approximated as the customer base `trial` months earlier).
    for (let index = 0; index < months; index += 1) paying[index] = index - trial >= 0 ? customers[index - trial] : 0;
    for (let index = 0; index < months; index += 1) revenue[index] = round2(paying[index] * price);
  }
  // Exact values first; each schedule is rounded once so its months add up to its total.
  const variableExact = customers.map((count) => count * variable);
  const variableCosts = allocateCents(variableExact);
  const costs = allocateCents(oneTime.map((value, index) => value + fixed[index] + variableExact[index]));
  const net = revenue.map((value, index) => round2(value - costs[index]));
  const startingCash = finite(data.starting_cash);
  const cumulative = [];
  net.reduce((sum, value) => { const next = round2(sum + value); cumulative.push(next); return next; }, 0);
  const sum = (list) => round2(list.reduce((total, value) => total + value, 0));
  const hasRevenue = model !== 'costs_only';
  const totalRevenue = sum(revenue);
  const firstIndex = (predicate) => { const index = cumulative.findIndex(predicate); return index >= 0 ? index + 1 : null; };
  // Payback (cash) break-even: cumulative net cash turns non-negative after
  // having been negative. Operating break-even: first month revenue covers
  // that month's recurring costs (fixed + variable).
  const cashBreakEven = hasRevenue ? (cumulative[0] >= 0 ? 1 : firstIndex((value, index) => index > 0 && value >= 0 && cumulative[index - 1] < 0)) : null;
  const operatingIndex = hasRevenue ? revenue.findIndex((value, index) => value > 0 && value >= fixed[index] + variableCosts[index]) : -1;
  const price = finite(revenueInput?.price_monthly);
  const contribution = price !== null ? round2(price - variable) : null;
  const lastFixed = fixed[months - 1];
  const fixedSchedule = allocateCents(fixed);
  const calculated = {
    months, model, currency: String(data.currency || '').slice(0, 8) || 'USD',
    total_one_time: sum(oneTime), total_fixed: sum(fixedSchedule), total_variable: sum(variableCosts),
    year_costs: sum(costs), monthly_run_rate: round2(lastFixed + variableCosts[months - 1]),
    ...(hasRevenue ? {
      year_revenue: totalRevenue, net: round2(totalRevenue - sum(costs)),
      gross_margin_pct: totalRevenue > 0 ? round2(((totalRevenue - sum(variableCosts)) / totalRevenue) * 100) : null,
      ending_customers: model === 'subscription' ? customers[months - 1] : null,
      ending_mrr: revenue[months - 1],
      break_even_month: cashBreakEven,
      operating_break_even_month: operatingIndex >= 0 ? operatingIndex + 1 : null,
      contribution_per_customer: contribution,
      break_even_customers: contribution && contribution > 0 ? Math.ceil(lastFixed / contribution) : null,
    } : {}),
    ...(startingCash !== null ? { starting_cash: startingCash, ending_cash: round2(startingCash + (cumulative[months - 1] || 0)), runway_months: runway(startingCash, net) } : {}),
    schedule: { revenue, costs, net, cumulative, ...(model === 'subscription' ? { customers, paying } : {}), one_time: allocateCents(oneTime), fixed: fixedSchedule, variable: variableCosts },
  };
  if (hasRevenue && !data.__core) calculated.sensitivity = sensitivities(data);
  return calculated;
}

function runway(cash, net) {
  let balance = cash;
  for (let index = 0; index < net.length; index += 1) {
    balance += net[index];
    if (balance < 0) return index;
  }
  return null; // not exhausted within the modelled period
}

// ±20% on price (or the explicit schedule) and on customer additions.
function sensitivities(data) {
  const variant = (label, change) => {
    const copy = JSON.parse(JSON.stringify(data));
    change(copy.revenue);
    const { year_revenue: yearRevenue, net, break_even_month: breakEven } = calculateFinanceCore(copy);
    return { label, year_revenue: yearRevenue, net, break_even_month: breakEven };
  };
  const scale = (factor) => (revenue) => {
    if (Array.isArray(revenue.monthly)) revenue.monthly = revenue.monthly.map((value) => (finite(value) ?? 0) * factor);
    else revenue.price_monthly = finite(revenue.price_monthly) * factor;
  };
  const volume = (factor) => (revenue) => {
    if (Array.isArray(revenue.monthly)) revenue.monthly = revenue.monthly.map((value) => (finite(value) ?? 0) * factor);
    else revenue.new_customers = Array.isArray(revenue.new_customers) ? revenue.new_customers.map((value) => (finite(value) ?? 0) * factor) : (finite(revenue.new_customers) ?? 0) * factor;
  };
  return [variant('Price −20%', scale(0.8)), variant('Price +20%', scale(1.2)), variant('Customers −20%', volume(0.8)), variant('Customers +20%', volume(1.2))];
}

function calculateFinanceCore(data) {
  return calculateFinance({ ...data, revenue: { ...data.revenue }, __core: true });
}

// ---------------------------------------------------------------- validation

const CLAIMS = Object.freeze({
  year_revenue: { label: 'Year revenue', money: true }, year_costs: { label: 'Year costs', money: true },
  net: { label: 'Net result', money: true }, ending_mrr: { label: 'Monthly revenue in the last month', money: true },
  total_one_time: { label: 'One-time costs', money: true }, monthly_run_rate: { label: 'Monthly run rate', money: true },
  ending_customers: { label: 'Customers at the end', money: false }, gross_margin_pct: { label: 'Gross margin %', money: false, relative: 0.02, absolute: 0.5 },
  break_even_month: { label: 'Break-even month', month: true }, ending_cash: { label: 'Ending cash', money: true },
});

function issue(code, detail, { field = null, expected = null, actual = null, evidence = null } = {}) {
  return { code, field, expected, actual, detail, evidence };
}

// Every artifact block with its raw JSON (parse errors skipped).
export function artifactBlocks(markdown) {
  const blocks = [];
  for (const match of String(markdown || '').matchAll(BLOCK)) {
    try { blocks.push({ raw: JSON.parse(match[1]), source: match[0] }); } catch { /* invalid JSON is dropped elsewhere */ }
  }
  return blocks;
}

// Rewrites artifact blocks in place: fn(raw) → new object (or null to keep).
export function mapArtifactBlocks(markdown, fn) {
  return String(markdown || '').replace(BLOCK, (source, json) => {
    let raw;
    try { raw = JSON.parse(json); } catch { return source; }
    const next = fn(raw);
    return next ? `\`\`\`artifact\n${JSON.stringify(next)}\n\`\`\`` : source;
  });
}

const typeOf = (raw) => String(raw?.type || '').toLowerCase();

// Validates FINANCE's output (Markdown with artifact blocks). Returns the
// state, the calculation, and every inconsistency with expected/actual.
export function validateFinance(markdown) {
  const blocks = artifactBlocks(markdown);
  const modelBlock = blocks.find((block) => typeOf(block.raw) === 'financial_model');
  const cleaned = modelBlock ? ARTIFACT_TYPES.financial_model.clean(modelBlock.raw) : null;
  // The code-written validation section is not FINANCE's claim.
  const prose = String(markdown || '').replace(BLOCK, '').replace(/^## Validated figures \(calculated by code\)[\s\S]*?(?=^## |$(?![\s\S]))/m, '');
  if (!cleaned) {
    const claims = proseClaims(prose);
    // Figures anywhere (prose, Markdown tables, other artifacts) that nothing
    // structured supports: these must not be presented as fact.
    const figures = claims.length > 0 || MONEY_FIGURE.test(String(markdown || ''));
    return {
      state: FINANCE_STATES.INSUFFICIENT, calculated: null, claims: {}, figures,
      issues: [issue('NO_STRUCTURED_MODEL', figures ? 'There is no financial_model artifact, so the stated figures cannot be reproduced by code.' : 'There is no financial_model artifact and no figure to verify.'),
        ...(claims.length ? [issue('UNSUPPORTED_FIGURES', `The text states figures (${claims.map((claim) => `${claim.label} ${claim.raw}`).join('; ')}) that no structured model supports.`)] : [])],
    };
  }
  const calculated = calculateFinance(cleaned);
  const issues = [];
  const hasRevenue = calculated.model !== 'costs_only';
  // 1. Stated headline claims (common key spellings accepted).
  for (const [field, value] of Object.entries(normaliseClaims(cleaned.claims))) {
    const spec = CLAIMS[field];
    if (!spec || value === null || value === undefined || value === '') continue;
    if (spec.month) {
      const stated = typeof value === 'string' && /not|none|never|n\/a|لا|لم/i.test(value) ? null : Math.round(finite(value));
      if (!hasRevenue) issues.push(issue('BREAK_EVEN_UNSUPPORTED', 'A break-even month is stated but the model has no revenue inputs to reproduce it.', { field, actual: stated }));
      else if (stated !== calculated.break_even_month && stated !== calculated.operating_break_even_month) {
        issues.push(issue(calculated.break_even_month === null ? 'BREAK_EVEN_NOT_REACHED' : 'BREAK_EVEN_MISMATCH',
          calculated.break_even_month === null ? `Break-even is stated as month ${stated}, but cumulative cash never turns positive within ${calculated.months} months.`
            : `Break-even is stated as month ${stated}; the schedule reaches it in month ${calculated.break_even_month}.`,
          { field, expected: calculated.break_even_month, actual: stated }));
      }
      continue;
    }
    // A costs-only model has, by definition, no revenue: "revenue 0" and
    // "net = −costs" are true statements of it, not unsupported claims.
    const costsOnly = !hasRevenue ? { year_revenue: 0, net: round2(-calculated.year_costs) } : {};
    const expected = calculated[field] ?? costsOnly[field];
    const stated = finite(value);
    if (expected === undefined || expected === null) {
      issues.push(issue('CLAIM_UNSUPPORTED', `${spec.label} is stated (${value}) but cannot be reproduced from the model's inputs.`, { field, actual: stated }));
    } else if (!agrees(stated, expected, spec)) {
      issues.push(issue('TOTAL_MISMATCH', `${spec.label} is stated as ${fmt(stated)}; the calculation from the stated inputs gives ${fmt(expected)}.`, { field, expected, actual: stated }));
    }
  }
  // 2. Charts must match the calculated schedule they depict.
  for (const block of blocks.filter((entry) => typeOf(entry.raw) === 'chart' && !entry.raw.calculated)) {
    const chart = ARTIFACT_TYPES.chart.clean(block.raw);
    if (!chart) continue;
    for (const series of chart.series) {
      const key = seriesKey(series.name, block.raw.title);
      const expected = key && calculated.schedule[key];
      if (!expected || !hasRevenue && key !== 'costs') continue;
      const mismatch = series.values.findIndex((value, index) => index < expected.length && value !== null && !agrees(value, expected[index], { relative: 0.02 }));
      if (mismatch >= 0) {
        issues.push(issue('CHART_MISMATCH', `Chart "${text(block.raw.title)}" series "${series.name}" shows ${fmt(series.values[mismatch])} for ${chart.labels[mismatch] || `month ${mismatch + 1}`}; the calculated ${key} is ${fmt(expected[mismatch])}.`,
          { field: `chart:${key}`, expected: expected[mismatch], actual: series.values[mismatch], evidence: `${text(block.raw.title)} · ${series.name}` }));
      }
    }
  }
  // 3. Tables: total rows must equal their column sums; monthly tables must
  // match the schedule.
  for (const block of blocks.filter((entry) => typeOf(entry.raw) === 'table')) {
    const table = ARTIFACT_TYPES.table.clean(block.raw);
    if (!table) continue;
    if (block.raw.calculated === true) continue;
    issues.push(...tableScheduleIssues(table, text(block.raw.title), calculated));
  }
  // 4. Prose (summary and body) must not contradict the calculation.
  for (const claim of proseClaims(prose)) {
    if (claim.kind === 'break_even_not') {
      if (hasRevenue && calculated.break_even_month !== null && calculated.break_even_month <= claim.value) {
        issues.push(issue('BREAK_EVEN_MISMATCH', `The text says break-even is not reached by month ${claim.value}; the schedule breaks even in month ${calculated.break_even_month}.`,
          { field: 'text:break_even_month', expected: calculated.break_even_month, actual: null, evidence: claim.quote }));
      }
    } else if (claim.kind === 'break_even') {
      if (!hasRevenue) issues.push(issue('BREAK_EVEN_UNSUPPORTED', `The text says break-even in month ${claim.value}, but the model has no revenue inputs to reproduce it.`, { field: 'text:break_even_month', actual: claim.value, evidence: claim.quote }));
      else if (claim.value !== calculated.break_even_month && claim.value !== calculated.operating_break_even_month && !(calculated.sensitivity || []).some((entry) => entry.break_even_month === claim.value)) {
        issues.push(issue(calculated.break_even_month === null ? 'BREAK_EVEN_NOT_REACHED' : 'BREAK_EVEN_MISMATCH',
          `The text says break-even in month ${claim.value}; ${calculated.break_even_month === null ? `the schedule does not break even within ${calculated.months} months` : `the schedule breaks even in month ${calculated.break_even_month}`}.`,
          { field: 'text:break_even_month', expected: calculated.break_even_month, actual: claim.value, evidence: claim.quote }));
      }
    } else {
      const expected = calculated[claim.kind];
      if (expected === undefined || expected === null) continue;
      // A scenario sentence may quote one of the calculated sensitivities.
      const scenarios = (calculated.sensitivity || []).map((entry) => entry[claim.kind]).filter((value) => typeof value === 'number');
      if (!agrees(claim.value, expected, { relative: 0.03 }) && !scenarios.some((value) => agrees(claim.value, value, { relative: 0.03 }))) {
        issues.push(issue('SUMMARY_MISMATCH', `The text states ${claim.label} of ${claim.raw}; the calculation gives ${fmt(expected)}.`,
          { field: `text:${claim.kind}`, expected, actual: claim.value, evidence: claim.quote }));
      }
    }
  }
  return { state: issues.length ? FINANCE_STATES.INCONSISTENT : FINANCE_STATES.VERIFIED, calculated, claims: cleaned.claims || {}, issues: dedupe(issues), figures: true };
}

const text = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);

// "first_year_revenue", "annual_revenue", "breakeven" … → the canonical keys.
export function normaliseClaims(claims) {
  const out = {};
  for (const [raw, value] of Object.entries(claims || {})) {
    const key = String(raw).toLowerCase().replace(/[^a-z_]/g, '');
    const canonical = CLAIMS[key] ? key
      : /break/.test(key) ? 'break_even_month'
        : /mrr|monthly_revenue|ending_revenue/.test(key) ? 'ending_mrr'
          : /revenue|sales/.test(key) ? 'year_revenue'
            : /one_?time|setup/.test(key) ? 'total_one_time'
              : /run_?rate|monthly_cost|burn/.test(key) ? 'monthly_run_rate'
                : /cost|expense|spend/.test(key) ? 'year_costs'
                  : /net|profit|loss/.test(key) ? 'net'
                    : /customer/.test(key) ? 'ending_customers' : /margin/.test(key) ? 'gross_margin_pct' : /cash/.test(key) ? 'ending_cash' : null;
    if (canonical && !(canonical in out)) out[canonical] = value;
  }
  return out;
}
export const fmt = (value) => (value === null || value === undefined ? '—' : Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 }));
const dedupe = (issues) => [...new Map(issues.map((entry) => [`${entry.code}:${entry.field}:${entry.actual}`, entry])).values()];

function seriesKey(name, title) {
  const label = `${name} ${title || ''}`.toLowerCase();
  const own = String(name || '').toLowerCase();
  if (/cumulative|cash|تراكمي/.test(own)) return 'cumulative';
  if (/net|profit|loss|صافي/.test(own)) return 'net';
  if (/revenue|mrr|sales|income|إيراد/.test(own)) return 'revenue';
  if (/cost|expense|spend|تكاليف|مصاريف/.test(own)) return 'costs';
  if (/customer|عملاء/.test(own)) return 'customers';
  if (/cumulative/.test(label)) return 'cumulative';
  return null;
}

const TOTAL_ROW = /^\s*(grand\s+)?(total|sum|subtotal|المجموع|الإجمالي)\b/i;

function tableTotalIssues(table, title) {
  const issues = [];
  let start = 0;
  table.rows.forEach((row, index) => {
    if (!TOTAL_ROW.test(String(row[0] || ''))) return;
    const block = table.rows.slice(start, index).filter((entry) => !TOTAL_ROW.test(String(entry[0] || '')));
    start = /subtotal/i.test(row[0]) ? index + 1 : start;
    for (let column = 1; column < row.length; column += 1) {
      // Rates, notes and running balances (cumulative cash) are not sums.
      if (/%|rate|margin|price|month\b|basis|note|cumulative|running|balance|تراكمي/i.test(table.columns[column] || '')) continue;
      const stated = finite(row[column]);
      const values = block.map((entry) => finite(entry[column])).filter((value) => value !== null);
      if (stated === null || values.length < 2) continue;
      const expected = round2(values.reduce((total, value) => total + value, 0));
      if (!agrees(stated, expected, { relative: 0.005 })) {
        issues.push(issue('TABLE_TOTAL_MISMATCH', `Table "${title}" row "${row[0]}" column "${table.columns[column]}" shows ${fmt(stated)}; its rows add up to ${fmt(expected)}.`,
          { field: `table:${table.columns[column]}`, expected, actual: stated, evidence: title }));
      }
    }
  });
  return issues;
}

// Monthly schedule values must equal the calculator's, up to rounding to a
// whole currency unit (V4.1 table gate: no percentage tolerance).
export const SCHEDULE_TOLERANCE = Object.freeze({ relative: 0.0005, absolute: 1 });
const MONTH_COLUMN = /^(month|period|mo\b|الشهر)/i;

// Which calculated schedule a table column shows (null: not a schedule column).
export function scheduleColumnKey(column) {
  const lower = String(column || '').toLowerCase();
  return /customers/.test(lower) ? (/^(net |active |total |paying )?customers\b/.test(lower) ? 'customers' : null)
    : /cumulative|running (?:cash|total|net)|cash balance|تراكمي/.test(lower) ? 'cumulative'
      : /\bnet\b|profit|loss|cash ?flow|صافي/.test(lower) ? 'net'
        : /^(mrr|revenue|monthly revenue|sales|income)|revenue \(|mrr \(|إيراد/.test(lower) ? 'revenue'
          : /^(total )?(costs?|expenses?|spend)\b|^total cost|تكاليف|مصاريف/.test(lower) ? 'costs' : null;
}

// A table with one row per month and a revenue / costs / net / cumulative
// column is compared, row by row, with the calculated schedule.
function monthlyTableIssues(table, title, calculated, tolerance = SCHEDULE_TOLERANCE) {
  const monthColumn = table.columns.findIndex((column) => MONTH_COLUMN.test(column));
  if (monthColumn < 0) return [];
  const rows = table.rows.filter((row) => !TOTAL_ROW.test(String(row[0] || '')) && !YEAR_ROW.test(String(row[monthColumn] || '')));
  const issues = [];
  table.columns.forEach((column, index) => {
    if (index === monthColumn) return;
    const key = scheduleColumnKey(column);
    const expected = key && calculated.schedule[key];
    if (!expected || (key !== 'costs' && calculated.model === 'costs_only')) return;
    rows.forEach((row) => {
      const month = Math.round(finite(row[monthColumn]) || 0);
      const stated = finite(row[index]);
      if (!month || month > expected.length || stated === null) return;
      if (!agrees(stated, expected[month - 1], tolerance)) {
        issues.push(issue('TABLE_SCHEDULE_MISMATCH', `Table "${title}" shows ${column} ${fmt(stated)} in month ${month}; the calculated ${key} is ${fmt(expected[month - 1])}.`,
          { field: `table:${key}`, expected: expected[month - 1], actual: stated, evidence: title }));
      }
    });
  });
  return issues;
}

// ---------------------------------------------------------------- table gate
// V4.1 table gate: when FINANCE's model is VERIFIED, every financial table,
// chart and figure anywhere else (AUDIT's review, CHIEF's answer, another
// employee's deliverable) is checked against the calculator — every monthly
// row, every total / year row and every labelled headline figure. The
// calculator is the only source of monthly financial truth.

const YEAR_ROW = /^\s*(?:total|sum|year(?:\s*(?:1|one))?|annual|12[\s-]?months?|first[\s-]year|المجموع|الإجمالي|السنة)\b/i;
// Figures about other companies or the market are not ours.
const OTHER_PARTY = /competitor|market size|industry|\b(?:tam|sam|som)\b|منافس|السوق/i;
const SCENARIO = /scenario|sensitiv|[-−+±]\s*\d+\s*%|price\s*[-−+]|customers\s*[-−+]|best case|worst case|سيناريو/i;

// Markdown pipe tables in text: { columns, rows, source }.
export function markdownTables(markdown) {
  const tables = [];
  const body = String(markdown || '').replace(BLOCK, (match) => ' '.repeat(match.length));
  for (const match of body.matchAll(/(?:^[ \t]*\|[^\n]*\|[ \t]*(?:\n|$(?![\s\S]))){2,}/gm)) {
    const lines = match[0].trim().split('\n').map((line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()));
    const rows = lines.slice(1).filter((row) => !row.every((cell) => /^:?-{2,}:?$/.test(cell) || cell === ''));
    if (!rows.length) continue;
    tables.push({ columns: lines[0], rows, source: String(markdown).slice(match.index, match.index + match[0].length) });
  }
  return tables;
}

// Headline figure a labelled row states ("Total revenue (12 months) | 112,236").
function headlineKey(label, context) {
  const text = `${label}`.toLowerCase();
  if (SCENARIO.test(text) || OTHER_PARTY.test(`${text} ${context}`)) return null;
  if (/break[\s-]?even|التعادل/.test(text)) return /operat/.test(text) ? 'operating_break_even_month' : 'break_even_month';
  const annual = /total|year|annual|12[\s-]?month|over \d+ months|إجمالي|سنوي/.test(`${text} ${context}`);
  if (/one[\s-]?time|setup|fit[\s-]?out/.test(text)) return 'total_one_time';
  if (/run[\s-]?rate|monthly (?:cost|burn)|burn rate/.test(text)) return 'monthly_run_rate';
  if (/ending cash|closing cash|cash at (?:the )?end/.test(text)) return 'ending_cash';
  if (!annual) return null;
  if (/revenue|sales|income|إيراد/.test(text)) return 'year_revenue';
  if (/\bnet\b|profit|loss|صافي|cumulative/.test(text)) return 'net';
  if (/costs?|expenses?|spend|تكاليف|مصاريف/.test(text)) return 'year_costs';
  return null;
}

const monthOf = (value) => { const match = String(value ?? '').match(/(?:month|m|الشهر)\s*(\d{1,2})|^\s*(\d{1,2})\s*$/i); return match ? Number(match[1] || match[2]) : null; };
const numbersIn = (value) => [...String(value ?? '').matchAll(/-?\d[\d,]*(?:\.\d+)?\s*(?:k|m|mn|million|thousand)?\b/gi)].map((match) => parseAmount(match[0])).filter((number) => number !== null);

// Every inconsistency between one table and the calculation.
export function tableScheduleIssues(table, title, calculated, tolerance = SCHEDULE_TOLERANCE) {
  // A key/value headline table ("Figure | Value") is not a list to sum: its
  // "Total costs …" row is a headline, compared with the calculation below.
  const headlineTable = /^(figure|metric|kpi|measure|indicator|key figure|headline)/i.test(String(table.columns[0] || ''));
  const issues = [...(headlineTable ? [] : tableTotalIssues(table, title)), ...monthlyTableIssues(table, title, calculated, tolerance)];
  const hasRevenue = calculated.model !== 'costs_only';
  const monthColumn = table.columns.findIndex((column) => MONTH_COLUMN.test(column));
  const last = calculated.months - 1;
  const yearly = { revenue: calculated.year_revenue, costs: calculated.year_costs, net: calculated.net, cumulative: calculated.schedule.cumulative[last] };
  for (const row of table.rows) {
    const label = String(row[0] ?? '');
    // Total / year rows of a schedule table: each schedule column = year total.
    if (monthColumn >= 0 && (YEAR_ROW.test(label) || YEAR_ROW.test(String(row[monthColumn] ?? '')))) {
      table.columns.forEach((column, index) => {
        const key = index === monthColumn ? null : scheduleColumnKey(column);
        const expected = key ? yearly[key] : undefined;
        const stated = finite(row[index]);
        if (expected === undefined || expected === null || stated === null || (key !== 'costs' && !hasRevenue)) return;
        if (!agrees(stated, expected, tolerance)) {
          issues.push(issue('TABLE_YEAR_TOTAL_MISMATCH', `Table "${title}" row "${label}" shows ${column} ${fmt(stated)}; the calculated ${calculated.months}-month ${key} is ${fmt(expected)}.`,
            { field: `table:year_${key}`, expected, actual: stated, evidence: title }));
        }
      });
      continue;
    }
    if (monthColumn >= 0) continue;
    // Labelled headline rows ("Cash break-even | Month 11", "Net (12 months) | 9,489").
    const key = headlineKey(label, `${title} ${table.columns.join(' ')}`);
    if (!key) continue;
    const cells = row.slice(1).join(' ');
    if (/break_even/.test(key)) {
      const stated = monthOf(cells);
      if (!hasRevenue || stated === null) continue;
      if (stated !== calculated.break_even_month && stated !== calculated.operating_break_even_month) {
        issues.push(issue('BREAK_EVEN_MISMATCH', `Table "${title}" states ${label} as month ${stated}; the schedule breaks even in month ${calculated.break_even_month ?? '— (not reached)'}.`,
          { field: 'table:break_even_month', expected: calculated.break_even_month, actual: stated, evidence: title }));
      }
      continue;
    }
    const expected = calculated[key];
    const stated = numbersIn(cells).find((number) => Math.abs(number) >= 100);
    if (expected === undefined || expected === null || stated === undefined) continue;
    if (!agrees(stated, expected, tolerance)) {
      issues.push(issue('TABLE_HEADLINE_MISMATCH', `Table "${title}" states ${label} ${fmt(stated)}; the calculation gives ${fmt(expected)}.`,
        { field: `table:${key}`, expected, actual: stated, evidence: title }));
    }
  }
  return dedupe(issues);
}

// A table that shows a monthly financial schedule (month column + at least
// one revenue / costs / net / cumulative column).
export function isScheduleTable(table) {
  return table.columns.some((column) => MONTH_COLUMN.test(column)) && table.columns.some((column) => ['revenue', 'costs', 'net', 'cumulative'].includes(scheduleColumnKey(column)));
}

// A chart that depicts the schedule (not the calculator's own chart).
function chartIssues(raw, calculated, tolerance) {
  const chart = ARTIFACT_TYPES.chart.clean(raw);
  if (!chart) return { schedule: false, issues: [] };
  const issues = [];
  let schedule = false;
  for (const series of chart.series) {
    const key = seriesKey(series.name, raw.title);
    const expected = key && calculated.schedule[key];
    if (!expected) continue;
    schedule = true;
    series.values.forEach((value, index) => {
      if (index < expected.length && value !== null && !agrees(value, expected[index], tolerance)) {
        issues.push(issue('CHART_MISMATCH', `Chart "${text(raw.title)}" series "${series.name}" shows ${fmt(value)} for ${chart.labels[index] || `month ${index + 1}`}; the calculated ${key} is ${fmt(expected[index])}.`,
          { field: `chart:${key}`, expected: expected[index], actual: value, evidence: `${text(raw.title)} · ${series.name}` }));
      }
    });
  }
  return { schedule, issues: dedupe(issues) };
}

// Every financial table / chart in a text and its inconsistencies with the
// calculation. kind: 'artifact' | 'markdown'; schedule: a monthly schedule.
export function financialTables(markdown, calculated, tolerance = SCHEDULE_TOLERANCE) {
  const found = [];
  for (const block of artifactBlocks(markdown)) {
    const type = typeOf(block.raw);
    if (type === 'table') {
      const table = ARTIFACT_TYPES.table.clean(block.raw);
      if (!table) continue;
      const issues = tableScheduleIssues(table, text(block.raw.title), calculated, tolerance);
      const schedule = isScheduleTable(table);
      if (schedule || issues.length) found.push({ kind: 'artifact', source: block.source, title: text(block.raw.title), schedule, calculated: block.raw.calculated === true, issues });
    } else if (type === 'chart') {
      const { schedule, issues } = chartIssues(block.raw, calculated, tolerance);
      if (schedule || issues.length) found.push({ kind: 'artifact', source: block.source, title: text(block.raw.title), schedule, calculated: block.raw.calculated === true, issues });
    }
  }
  for (const table of markdownTables(markdown)) {
    const title = table.columns.join(' · ').slice(0, 80);
    const issues = tableScheduleIssues(table, title, calculated, tolerance);
    const schedule = isScheduleTable(table);
    if (schedule || issues.length) found.push({ kind: 'markdown', source: table.source, title, schedule, calculated: false, issues });
  }
  return found;
}

// The calculator's own monthly schedule as a table artifact (the only
// monthly financial table the Office presents).
export function scheduleTable(calculated) {
  if (!calculated || calculated.model === 'costs_only') return null;
  const { revenue, costs, net, cumulative } = calculated.schedule;
  const whole = (value) => fmt(Math.round(value));
  return {
    type: 'table', title: `Monthly schedule — calculated by code (${calculated.currency})`, calculated: true,
    columns: ['Month', 'Revenue', 'Costs', 'Net', 'Cumulative cash'],
    rows: [...revenue.map((value, index) => [String(index + 1), whole(value), whole(costs[index]), whole(net[index]), whole(cumulative[index])]),
      ['Total', whole(calculated.year_revenue), whole(calculated.year_costs), whole(calculated.net), whole(cumulative[calculated.months - 1])]],
  };
}

// Owner drill ([drill:finance-table]): the exact failure found in the V4.1
// live acceptance — a model-written monthly table whose revenue drifts from
// the calculator by AED 747 over the year (Sanad Desk: 111,489 revenue,
// 9,489 net instead of 112,236 / 10,236).
export function badScheduleTable(calculated, drift = 747) {
  if (!calculated || calculated.model === 'costs_only') return null;
  const { revenue, costs } = calculated.schedule;
  const total = revenue.reduce((sum, value) => sum + value, 0);
  const bad = revenue.map((value) => Math.round(value * (1 - drift / Math.max(1, total))));
  bad[bad.length - 1] += Math.round(total - drift) - bad.reduce((sum, value) => sum + value, 0);
  let running = 0;
  const rows = bad.map((value, index) => { const flow = value - Math.round(costs[index]); running += flow; return [String(index + 1), fmt(value), fmt(Math.round(costs[index])), fmt(flow), fmt(running)]; });
  const costTotal = Math.round(costs.reduce((sum, value) => sum + value, 0));
  rows.push(['Total', fmt(Math.round(total - drift)), fmt(costTotal), fmt(Math.round(total - drift) - costTotal), '']);
  return { type: 'table', title: `12-Month Financial Snapshot (${calculated.currency})`, columns: ['Month', 'Revenue', 'Total Cost', 'Net Cash Flow', 'Cumulative Net'], rows };
}

const MONEY = '(?:AED|USD|US\\$|\\$|€|درهم)?\\s*~?\\s*(-?\\d[\\d,]*(?:\\.\\d+)?\\s*(?:k|m|mn|million|thousand|ألف|مليون)?)(?!\\d|[,.]\\d|\\s*(?:%|months?|customers|users|شهر|per month|a month|/\\s*mo|monthly|each month|شهري))';

// Headline figures written in prose: break-even month, year revenue/costs/net.
export function proseClaims(prose) {
  const claims = [];
  const body = String(prose || '').replace(/\|[^\n]*\|/g, ' '); // tables are checked separately
  for (const match of body.matchAll(/break[\s-]?even[^.\n|]{0,60}?\bmonth\s*(\d{1,2})\b|\bmonth\s*(\d{1,2})\b[^.\n|]{0,30}?break[\s-]?even|(?:التعادل|نقطة التعادل)[^.\n|]{0,40}?الشهر\s*(\d{1,2})/gi)) {
    const value = Number(match[1] || match[2] || match[3]);
    // "does not break even by month 12" / "no break-even within 12 months".
    const negated = /\b(not|never|no|isn't|won't|beyond|after)\b|لن|لا/i.test(match[0]);
    claims.push({ kind: negated ? 'break_even_not' : 'break_even', label: 'break-even month', value, raw: match[0], quote: quote(body, match.index) });
  }
  const period = '(?:first[\\s-]year|year[\\s-]?(?:one|1)|12[\\s-]month|annual|yearly|السنة الأولى)';
  const patterns = [
    ['year_revenue', 'year-one revenue', new RegExp(`${period}[^.\\n|]{0,25}?(?:revenue|sales|إيرادات)[^.\\n|\\d]{0,30}?${MONEY}`, 'gi')],
    ['year_revenue', 'year-one revenue', new RegExp(`(?:revenue|إيرادات)[^.\\n|\\d]{0,10}?(?:in|for|of)?\\s*${period}[^.\\n|\\d]{0,20}?${MONEY}`, 'gi')],
    ['year_costs', 'year-one costs', new RegExp(`${period}[^.\\n|]{0,25}?(?:costs?|spend|expenses|تكاليف)[^.\\n|\\d]{0,30}?${MONEY}`, 'gi')],
    ['year_costs', 'year-one costs', new RegExp(`(?:total\\s+)?(?:costs?|expenses|تكاليف)[^.\\n|\\d]{0,10}?(?:in|for|of)?\\s*${period}[^.\\n|\\d]{0,20}?${MONEY}`, 'gi')],
  ];
  for (const [kind, label, pattern] of patterns) {
    for (const match of body.matchAll(pattern)) {
      const value = parseAmount(match[1]);
      if (value === null || Math.abs(value) < 100) continue;
      claims.push({ kind, label, value, raw: match[1].trim(), quote: quote(body, match.index) });
    }
  }
  return claims;
}

const quote = (body, index) => body.slice(Math.max(0, index - 20), index + 140).replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- outputs

// A result that cannot be used as-is: inconsistent figures, or figures that
// no structured model supports. (No figures at all is not a failure.)
export const needsCorrection = (validation) => validation.state === FINANCE_STATES.INCONSISTENT || (validation.state === FINANCE_STATES.INSUFFICIENT && validation.figures);

// The validated figures, for CHIEF and the Hub: only what code reproduced.
export function validatedFacts(validation) {
  const calc = validation?.calculated;
  if (!calc || validation.state !== FINANCE_STATES.VERIFIED) return [];
  const money = (value) => `${calc.currency} ${fmt(value)}`;
  const facts = [
    ['validated_total_one_time_costs', 'One-time costs', money(calc.total_one_time)],
    ['validated_year_costs', `Total costs over ${calc.months} months`, money(calc.year_costs)],
    ['validated_monthly_run_rate', `Monthly run rate (month ${calc.months})`, money(calc.monthly_run_rate)],
  ];
  if (calc.model !== 'costs_only') {
    facts.unshift(['validated_year_revenue', `Revenue over ${calc.months} months`, money(calc.year_revenue)]);
    facts.push(['validated_net', `Net result over ${calc.months} months`, money(calc.net)]);
    facts.push(['validated_break_even_month', 'Cash break-even', calc.break_even_month ? `month ${calc.break_even_month}` : `not reached within ${calc.months} months`]);
    facts.push(['validated_ending_mrr', `Revenue in month ${calc.months}`, money(calc.ending_mrr)]);
    if (calc.ending_customers !== null) facts.push(['validated_ending_customers', `Customers at month ${calc.months}`, fmt(calc.ending_customers)]);
    if (calc.gross_margin_pct !== null) facts.push(['validated_gross_margin_pct', 'Gross margin', `${fmt(calc.gross_margin_pct)}%`]);
  }
  if (calc.runway_months !== undefined) facts.push(['validated_runway_months', 'Cash runway', calc.runway_months === null ? `beyond ${calc.months} months` : `${calc.runway_months} months`]);
  return facts.map(([key, label, value]) => ({ key, label, value }));
}

// The deterministic section appended to FINANCE's output.
export function validationSection(validation) {
  const lines = ['## Validated figures (calculated by code)'];
  lines.push(`Validation: **${validation.state}**${validation.state === FINANCE_STATES.VERIFIED ? ' — every stated figure matches the calculation from the stated assumptions.' : ''}`);
  const facts = validatedFacts(validation);
  if (facts.length) {
    lines.push('', '| Figure | Value |', '| --- | --- |', ...facts.map((fact) => `| ${fact.label} | ${fact.value} |`));
  }
  if (validation.issues.length) {
    lines.push('', validation.state === FINANCE_STATES.INSUFFICIENT ? 'Not enough structured data to verify the figures:' : 'These stated figures disagree with the calculation and must not be used:');
    lines.push(...validation.issues.slice(0, 8).map((entry) => `- ${entry.detail}`));
  }
  return lines.join('\n');
}

// FINANCE's output with the financial_model enriched (calculated values and
// validation state stored in the artifact), a code-drawn schedule chart, and
// the validation section. Hand-made charts that disagree are removed.
export function publishFinance(markdown, validation) {
  let output = String(markdown || '').replace(/\n## Validated figures \(calculated by code\)[\s\S]*?(?=\n## |$(?![\s\S]))/g, '');
  const drop = new Set(validation.issues.filter((entry) => entry.code === 'CHART_MISMATCH').map((entry) => entry.evidence?.split(' · ')[0]));
  output = String(output).replace(BLOCK, (source, json) => {
    let raw;
    try { raw = JSON.parse(json); } catch { return source; }
    if (typeOf(raw) === 'chart' && (raw.calculated || drop.has(text(raw.title)))) return '';
    if (typeOf(raw) !== 'financial_model') return source;
    const { schedule, sensitivity, ...headline } = validation.calculated || {};
    return `\`\`\`artifact\n${JSON.stringify({ ...raw, calculated: validation.calculated ? { ...headline, sensitivity } : null,
      validation: { state: validation.state, issues: validation.issues.slice(0, 12) } })}\n\`\`\``;
  });
  const calc = validation.calculated;
  const chart = calc && calc.model !== 'costs_only' && validation.state !== FINANCE_STATES.INSUFFICIENT ? {
    type: 'chart', title: `Revenue, costs and cumulative cash — calculated (${calc.currency})`, kind: 'line', unit: calc.currency, calculated: true,
    labels: calc.schedule.revenue.map((_, index) => `M${index + 1}`),
    series: [{ name: 'Revenue', values: calc.schedule.revenue }, { name: 'Costs', values: calc.schedule.costs }, { name: 'Cumulative cash', values: calc.schedule.cumulative }],
  } : null;
  return [output.replace(/\n{3,}/g, '\n\n').trim(), chart ? `\`\`\`artifact\n${JSON.stringify(chart)}\n\`\`\`` : '', validationSection(validation)].filter(Boolean).join('\n\n');
}

// What FINANCE is told when validation fails: the exact problems plus the
// calculated values it must use (it may change assumptions, not arithmetic).
export function revisionInstruction(validation) {
  const calc = validation.calculated;
  const lines = ['Code validation of your financial model FAILED. Fix these inconsistencies:'];
  lines.push(...validation.issues.slice(0, 10).map((entry) => `- ${entry.detail}`));
  if (validation.state === FINANCE_STATES.INSUFFICIENT) {
    lines.push('Include a "financial_model" artifact with every cost line, a "revenue" block with your revenue assumptions and "claims" with the headline figures you state.');
  }
  if (calc) {
    lines.push('The Office calculates the figures from your assumptions. The calculation of your CURRENT assumptions is:');
    lines.push(...validatedFactsUnchecked(calc).map((fact) => `- ${fact.label}: ${fact.value}`));
    lines.push('Either state exactly these figures, or change the ASSUMPTIONS (and say why). Never state a figure the assumptions do not produce.',
      'Do not hand-draw monthly schedule charts or tables: the Office draws the calculated schedule. If break-even is not reached, say so.');
  }
  return lines.join('\n');
}

function validatedFactsUnchecked(calc) {
  return validatedFacts({ state: FINANCE_STATES.VERIFIED, calculated: calc });
}

// Owner drill ([drill:finance-error]): a deliberately wrong headline total is
// written into FINANCE's output so the validation layer can be proven live.
export function injectFinanceError(markdown) {
  let injected = null;
  const output = mapArtifactBlocks(markdown, (raw) => {
    if (typeOf(raw) !== 'financial_model' || injected !== null) return null;
    const cleaned = ARTIFACT_TYPES.financial_model.clean(raw);
    const calc = cleaned ? calculateFinance(cleaned) : null;
    const field = calc && calc.model !== 'costs_only' ? 'year_revenue' : 'year_costs';
    injected = { field, value: Math.round(((calc?.[field] || 10_000) * 3.7) + 12_345) };
    return { ...raw, claims: { ...(raw.claims || {}), [field]: injected.value } };
  });
  if (!injected) return { text: markdown, injected: null };
  const sentence = `\n\nHeadline: ${injected.field === 'year_revenue' ? 'first-year revenue' : 'first-year costs'} of ${injected.value.toLocaleString('en-US')}.`;
  return { text: output.replace(/(##\s*Summary[^\n]*\n[^\n]+)/i, `$1${sentence}`), injected };
}
