import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateMediumJobEquivalent, OFFICE_MEDIUM_BASELINE } from '../src/continuity/mje.js';

test('MJE stays UNKNOWN before three measured medium jobs and becomes ESTIMATED with sample count', () => {
  const sample = { basis: 'MEASURED', size: 'medium', testsPassed: true, usageFraction: 0.25 };
  assert.deepEqual(estimateMediumJobEquivalent([sample, sample]), { value: null, basis: 'UNKNOWN', sampleCount: 2 });
  assert.deepEqual(estimateMediumJobEquivalent([sample, sample, sample]), { value: 4, basis: 'ESTIMATED', sampleCount: 3, averageUsageFraction: 0.25 });
  assert.equal(OFFICE_MEDIUM_BASELINE.tokens, 209_600);
  assert.equal(OFFICE_MEDIUM_BASELINE.turns, 21);
  assert.equal(OFFICE_MEDIUM_BASELINE.elapsedMinutes, 40.7);
});
