import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the Hermes audit is read-only and never prints secret values', () => {
  const script = readFileSync(new URL('../ops/hermes-audit.sh', import.meta.url), 'utf8');
  const code = script.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  for (const forbidden of [/\brm\s/, /docker\s+(stop|rm|kill|restart|compose|system|volume\s+rm|network\s+rm|image\s+rm|rmi|exec|run|cp)\b/, /systemctl\s+(stop|disable|mask|restart|kill)/,
    /\bkill\b/, /\bprune\b/, /\bsed\s+-i\b/, /\bcurl\b|\bwget\b/, /(^|[^2&])>\s*\/(?!dev\/null)/m, /\bcat\s/, /printenv|\/proc\/[^ ]*environ/]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  assert.match(code, /sed -E 's\/=\.\*\$\/\/'/, 'env values are stripped to names');
  assert.match(script, /Nothing was changed/);
});
