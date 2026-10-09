// Work classification for operational views.
//
// Authoritative classification (the explicit 2026-10-09 confirmed-test registry)
// wins over title text. A title pattern is only a heuristic for jobs that have
// no registry row. Unlisted work is UNCLASSIFIED and is treated as real: a
// missing label never hides a genuine objective.

import { CONFIRMED_TEST_JOB_IDS } from './work-registry.js';

export const WORK_CLASSES = Object.freeze(['TEST', 'REAL', 'UNCERTAIN']);
export const CLASSIFICATION_BASIS = Object.freeze(['REGISTRY', 'HEURISTIC', 'UNCLASSIFIED']);

// The same historical markers the Office already uses. Kept here so the
// domain and the existing views share one pattern.
export const TEST_OBJECTIVE_PATTERN = /\b(test(?:ing)?|smoke|canary|probe|drill|benchmark|certification|demo|acceptance|burn[- ]?in|load test|qa check|v2 check|safe to delete)\b|\[(?:drill|test)[^\]]*\]/i;

const KIND_PATTERNS = Object.freeze([
  ['benchmark', /\bbenchmark\b/i],
  ['certification', /\bcertification\b/i],
  ['smoke', /\bsmoke\b/i],
  ['canary', /\bcanary\b/i],
  ['drill', /\bdrill\b|\[drill/i],
  ['demo', /\bdemo\b/i],
  ['acceptance', /\bacceptance\b/i],
  ['burn-in', /\bburn[- ]?in\b/i],
]);

export function testKind(job) {
  const text = `${job?.title || ''} ${String(job?.goal || '').slice(0, 300)}`;
  return KIND_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] || (TEST_OBJECTIVE_PATTERN.test(text) ? 'test' : null);
}

export function isHeuristicTestObjective(job) {
  return TEST_OBJECTIVE_PATTERN.test(`${job?.title || ''} ${String(job?.goal || '').slice(0, 300)}`);
}

export function isConfirmedTest(job) {
  const id = String(job?.id || '').toLowerCase();
  return Boolean(id) && CONFIRMED_TEST_JOB_IDS.has(id);
}

// One classification. `operational` is false for historical tests (they stay
// out of current work). A genuinely open test stays identifiable and is not
// relabelled as real work.
export function classifyWork(job, { open = false } = {}) {
  if (!job) return { class: 'UNCERTAIN', basis: 'UNCLASSIFIED', kind: null, operational: false, identified: false };
  if (isConfirmedTest(job)) {
    return { class: 'TEST', basis: 'REGISTRY', kind: testKind(job) || 'test', operational: Boolean(open), identified: true };
  }
  if (isHeuristicTestObjective(job)) {
    return { class: 'TEST', basis: 'HEURISTIC', kind: testKind(job) || 'test', operational: Boolean(open), identified: true };
  }
  return { class: 'REAL', basis: 'UNCLASSIFIED', kind: null, operational: true, identified: false };
}

// Registry or heuristic test work. Open versus historical is the caller's
// decision: an open test is still a test, and a finished one stays a test.
export function isTestWork(job) {
  return isConfirmedTest(job) || isHeuristicTestObjective(job);
}
