import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDrillLeg, DRILL_OBJECTIVE } from '../tools/continuity-phase-n-scope.mjs';
import { validCheckpoint } from '../testing/fixtures/continuity-harness.js';

const facts = () => ({ marker: 'phase-n/gemini.md', markerContent: 'Gemini completed this step.\n',
  changedFiles: ['phase-n/gemini.md', '.continuity/checkpoint.json'],
  priorMarkers: [{ path: 'phase-n/opencode.md', before: 'OpenCode\n', after: 'OpenCode\n' }], checkpoint: validCheckpoint() });

test('every drill leg must add only its own marker with a valid committed checkpoint', () => {
  assert.equal(checkDrillLeg(facts()).ok, true);
  assert.equal(checkDrillLeg({ ...facts(), changedFiles: ['.continuity/checkpoint.json'] }).ok, false);
  assert.equal(checkDrillLeg({ ...facts(), changedFiles: [...facts().changedFiles, 'src/continuity/gates.js'] }).ok, false);
  assert.equal(checkDrillLeg({ ...facts(), markerContent: 'two\nlines\n' }).ok, false);
  assert.equal(checkDrillLeg({ ...facts(), checkpoint: { ...validCheckpoint(), last_commit: 'short' } }).ok, false);
  assert.equal(checkDrillLeg({ ...facts(), priorMarkers: [{ path: 'phase-n/opencode.md', before: 'OpenCode\n', after: null }] }).ok, false);
});

test('the stable drill objective describes the whole chain, never a stale Office-only task', () => {
  assert.match(DRILL_OBJECTIVE, /Office -> OpenCode -> Gemini CLI/);
  assert.match(DRILL_OBJECTIVE, /Execute only the current Next exact action/);
  assert.match(DRILL_OBJECTIVE, /preserve all previous markers/);
  assert.match(DRILL_OBJECTIVE, /Do not repeat an earlier worker step/);
});
