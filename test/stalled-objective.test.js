import test from 'node:test';
import assert from 'node:assert/strict';
import { STALLED_REASON, isStalled, jobLifecycle } from '../src/domain/lifecycle.js';
import { nextActionOf } from '../src/domain/objectives.js';
import { currentWork } from '../src/domain/current-work.js';
import { jobStatus } from '../src/hub-ui/office-model.js';
import { humanError } from '../src/hub-ui/humanize.js';

const now = Date.parse('2026-10-28T12:00:00Z');
const job = { id: 'j1', title: 'Launch', goal: 'Launch', status: 'running', created_at: '2026-10-28T10:00:00Z' };
const step = (status, extra = {}) => ({ id: `t-${status}-${Math.random()}`, job_id: 'j1', title: 'Step', status, brief: '{}', depends_on: [], ...extra });

test('a running objective whose steps all finished or failed is NEEDS_OWNER (stalled), never ACTIVE', () => {
  const tasks = [step('done'), step('failed')];
  assert.equal(isStalled(job, tasks, now), true);
  const life = jobLifecycle(job, { tasks, now });
  assert.equal(life.category, 'NEEDS_OWNER');
  assert.equal(life.reason, STALLED_REASON);
  assert.equal(life.current, true, 'it stays visible as current work so Fahad sees it');
  assert.equal(nextActionOf({ job, tasks, now }).code, 'RECOVER_STALLED');
  const work = currentWork({ jobs: [job], tasks, now });
  assert.equal(work.needsOwner.length, 1);
  assert.equal(work.active.length, 0);
});

test('stalled is never claimed without evidence', () => {
  // A queued or running step can still progress.
  assert.equal(jobLifecycle(job, { tasks: [step('done'), step('queued')], now }).category, 'ACTIVE');
  assert.equal(jobLifecycle(job, { tasks: [step('running')], now }).category, 'ACTIVE');
  // No loaded steps (e.g. a truncated list): not judged.
  assert.equal(isStalled(job, [], now), false);
  assert.equal(jobLifecycle(job, { tasks: [], now }).category, 'ACTIVE');
  // Inside the planning grace period.
  assert.equal(isStalled({ ...job, created_at: '2026-10-28T11:45:00Z' }, [step('done')], now), false);
  // An open coding session still works on it.
  assert.equal(jobLifecycle(job, { tasks: [step('done')], sessions: [{ id: 's', job_id: 'j1', status: 'running' }], now }).category, 'ACTIVE');
  // Terminal objectives keep their terminal category.
  assert.equal(jobLifecycle({ ...job, status: 'failed' }, { tasks: [step('failed')], now }).category, 'FAILED');
});

test('the status pill and the failure text say "stalled" in Arabic and English', () => {
  assert.equal(jobStatus({ status: 'running', stalled: true }, 'ar').label, 'متوقفة — تحتاج تدخلك');
  assert.equal(jobStatus({ status: 'running', stalled: true }, 'en').key, 'stalled');
  assert.equal(jobStatus({ status: 'completed', stalled: true }, 'en').key, 'completed');
  assert.match(humanError(STALLED_REASON, 'ar'), /أوقفها ثم استأنفها/);
  assert.match(humanError(STALLED_REASON, 'en'), /Stop it, then resume/);
});
