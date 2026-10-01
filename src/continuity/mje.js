export const OFFICE_MEDIUM_BASELINE = Object.freeze({
  source: 'docs/HANDOVER.md CAPACITY FINALIZATION, 2026-09-29',
  tokens: 209_600,
  turns: 21,
  elapsedMinutes: 40.7,
  testsPassed: true,
  basis: 'MEASURED',
});

export function estimateMediumJobEquivalent(samples) {
  const measured = (samples || []).filter((sample) => sample.basis === 'MEASURED' && sample.size === 'medium' && sample.testsPassed === true && Number.isFinite(sample.usageFraction) && sample.usageFraction > 0);
  if (measured.length < 3) return { value: null, basis: 'UNKNOWN', sampleCount: measured.length };
  const averageFraction = measured.reduce((sum, sample) => sum + sample.usageFraction, 0) / measured.length;
  return { value: 1 / averageFraction, basis: 'ESTIMATED', sampleCount: measured.length, averageUsageFraction: averageFraction };
}
