import test from 'node:test';
import assert from 'node:assert/strict';
import defaultFormat, { formatDurationMs } from '../src/format-duration.js';
import { formatDurationMs as fromAlias } from '../src/format-duration-ms.js';
import { formatDurationMs as fromUtils } from '../src/utils.js';

test('formats zero and sub-second values in milliseconds', () => {
  assert.equal(formatDurationMs(0), '0ms');
  assert.equal(formatDurationMs(1), '1ms');
  assert.equal(formatDurationMs(999), '999ms');
});

test('formats seconds, minutes, hours and days with non-zero units', () => {
  assert.equal(formatDurationMs(1000), '1s');
  assert.equal(formatDurationMs(1500), '1s 500ms');
  assert.equal(formatDurationMs(60_000), '1m');
  assert.equal(formatDurationMs(61_001), '1m 1s 1ms');
  assert.equal(formatDurationMs(3_600_000), '1h');
  assert.equal(formatDurationMs(3_661_001), '1h 1m 1s 1ms');
  assert.equal(formatDurationMs(86_400_000), '1d');
  assert.equal(formatDurationMs(90_061_001), '1d 1h 1m 1s 1ms');
});

test('is pure and truncates fractional milliseconds', () => {
  assert.equal(formatDurationMs(1999.9), '1s 999ms');
  assert.equal(formatDurationMs(500), formatDurationMs(500));
  assert.equal(defaultFormat, formatDurationMs);
});

test('rejects negative, non-finite and non-numeric input', () => {
  assert.throws(() => formatDurationMs(-1), RangeError);
  assert.throws(() => formatDurationMs(Number.NaN), TypeError);
  assert.throws(() => formatDurationMs(Infinity), TypeError);
  assert.throws(() => formatDurationMs('1000'), TypeError);
  assert.throws(() => formatDurationMs(null), TypeError);
});

test('re-exports resolve to the same implementation', () => {
  assert.equal(fromAlias, formatDurationMs);
  assert.equal(fromUtils, formatDurationMs);
});
