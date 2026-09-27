import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { auditLockfile, classifyLicense } from '../src/office/license-gate.js';

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));

test('permissive licenses pass; copyleft, source-available and unclear ones go to LEGAL', () => {
  for (const license of ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC', '(MIT OR GPL-3.0)']) assert.equal(classifyLicense(license).gate, 'PASS', license);
  for (const license of ['AGPL-3.0', 'GPL-2.0-only', 'BUSL-1.1', 'SEE LICENSE IN LICENSE.md', 'UNLICENSED', '', 'WTFPL']) assert.equal(classifyLicense(license).gate, 'LEGAL', license);
});

test('every shipped dependency passes the gate or has a recorded LEGAL decision', () => {
  const results = auditLockfile(read('package-lock.json'), read('legal/license-decisions.json').decisions);
  const open = results.filter((entry) => entry.status.startsWith('OPEN'));
  assert.deepEqual(open, [], 'dependencies without a license decision');
  assert.ok(!results.some((entry) => entry.status === 'DO NOT USE'), 'a DO NOT USE dependency is installed');
  assert.ok(results.some((entry) => entry.name === '@anthropic-ai/claude-agent-sdk' && entry.status === 'APPROVED WITH CONDITIONS'));
});
