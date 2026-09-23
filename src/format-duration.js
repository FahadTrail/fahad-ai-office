// Pure helper for turning a non-negative millisecond value into a compact
// human-readable string. It has no side effects and is not wired into any
// runtime path.

const UNIT_MS = Object.freeze([
  ['d', 24 * 60 * 60 * 1000],
  ['h', 60 * 60 * 1000],
  ['m', 60 * 1000],
  ['s', 1000],
  ['ms', 1],
]);

export function formatDurationMs(value) {
  const totalMs = toWholeMilliseconds(value);
  if (totalMs === 0) return '0ms';
  const parts = [];
  let remaining = totalMs;
  for (const [label, size] of UNIT_MS) {
    const amount = Math.floor(remaining / size);
    if (amount > 0) {
      parts.push(`${amount}${label}`);
      remaining -= amount * size;
    }
  }
  return parts.join(' ');
}

function toWholeMilliseconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('formatDurationMs requires a finite number of milliseconds');
  }
  if (value < 0) {
    throw new RangeError('formatDurationMs requires a non-negative number of milliseconds');
  }
  return Math.floor(value);
}

export default formatDurationMs;
