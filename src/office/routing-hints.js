// Per-step routing hints derived from the work itself (pure, no I/O).
//
//  - FINANCE: routine interpretation of code-calculated numbers is the job
//    `finance`; investment, valuation, funding, debt or tax judgment is
//    `finance_critical` (stronger models only).
//  - FINANCE gets web tools only when the task needs current external facts
//    (market prices, rates, competitors, "today"); a cost model, P&L,
//    break-even or scenario analysis on given assumptions does not.
import { financeJob } from '../model-gateway/agentic/capabilities.js';

export { financeJob };

const EXTERNAL_FACTS = /\b(market (price|rate|size|data)|current (price|rate|market)|today'?s|latest|this (week|month|year)'?s? (price|rate)|competitor|benchmark|exchange rate|interest rate|inflation|average (salary|rent|price|cost) in|how much does .* cost|look ?up|search|research|source|cite)\b|أسعار السوق|سعر الصرف|المنافسين|ابحث|مصادر/i;

export function needsExternalFacts(text) {
  return EXTERNAL_FACTS.test(String(text || ''));
}

// The routing job for one Office step.
export function stepJob(employee, text) {
  const job = employee?.job || null;
  return job === 'finance' ? financeJob(text) : job;
}

// Whether an Office employee's step is offered web tools.
export function stepWebTools(employee, allowed, text) {
  if (!employee?.webTools || !allowed) return false;
  if (employee.key === 'finance') return needsExternalFacts(text);
  return true;
}
