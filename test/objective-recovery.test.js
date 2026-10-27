import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubServer } from '../src/hub-server.js';
import { resumeObjective, RESUME_ATTEMPTS } from '../src/hub-job-actions.js';
import { humanError } from '../src/hub-ui/humanize.js';
import { OfficeWorkflow } from '../src/workflow.js';
import { validatePlan } from '../src/chief.js';
import { memoryPostgrest } from '../testing/fixtures/memory-postgrest.js';
import { MemoryStore } from '../testing/fixtures/office-memory-store.js';

const JOB = 'a0000000-0000-4000-8000-000000000001';
const T = (n) => `a0000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;

async function hub(tables) {
  const db = memoryPostgrest(tables);
  const server = createHubServer({ db, store: { createJob: async () => ({}) }, host: '127.0.0.1', port: 0, accessToken: '', authEnabled: false });
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path) => { const response = await fetch(base + path, { method: 'POST' }); return { status: response.status, body: await response.json() }; };
  return { db, post, close: () => new Promise((resolve) => server.close(resolve)) };
}

const failedJob = () => ({
  jobs: [{ id: JOB, status: 'failed', title: 'Launch plan', project_id: 'p', completed_at: '2026-10-27T10:00:00Z', final_summary: 'Failed: Launch budget — provider down' }],
  tasks: [
    { id: T(1), job_id: JOB, status: 'done', attempts: 1, max_attempts: 3 },
    { id: T(2), job_id: JOB, status: 'failed', attempts: 3, max_attempts: 3, wait_count: 48, completed_at: '2026-10-27T10:00:00Z', wait_info: { checkpoint: { completedToolCalls: [1] } } },
    { id: T(3), job_id: JOB, status: 'blocked', attempts: 0, max_attempts: 3 },
  ],
  events: [],
});

test('resume requeues only unfinished steps, keeps delivered work and reopens the objective once', async () => {
  const tables = failedJob();
  const { post, close } = await hub(tables);
  try {
    const first = await post(`/api/jobs/${JOB}/resume`);
    assert.equal(first.status, 200);
    assert.deepEqual([first.body.resumed, first.body.requeued], [true, 2]);
    const [job] = tables.jobs;
    assert.deepEqual([job.status, job.completed_at, job.final_summary], ['running', null, null]);
    const [done, failed, blocked] = tables.tasks;
    assert.deepEqual([done.status, done.attempts], ['done', 1], 'delivered work is untouched');
    assert.deepEqual([failed.status, failed.max_attempts, failed.wait_count, failed.completed_at], ['queued', 3 + RESUME_ATTEMPTS, 0, null]);
    assert.deepEqual(failed.wait_info, { checkpoint: { completedToolCalls: [1] } }, 'the tool checkpoint survives the resume');
    assert.deepEqual([blocked.status, blocked.max_attempts], ['queued', RESUME_ATTEMPTS]);
    assert.equal(tables.events.at(-1).payload.kind, 'objective_resumed');
    assert.equal(tables.events.at(-1).payload.requeued, 2);

    const second = await post(`/api/jobs/${JOB}/resume`);
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'JOB_NOT_RESUMABLE', 'a double click resumes once');
  } finally { await close(); }
});

test('completed objectives and objectives with nothing left are refused with a clear reason', async () => {
  const done = failedJob();
  done.jobs[0].status = 'completed';
  const nothing = failedJob();
  nothing.tasks = [nothing.tasks[0]];
  for (const [tables, code] of [[done, 'JOB_NOT_RESUMABLE'], [nothing, 'NOTHING_TO_RESUME']]) {
    const { post, close } = await hub(tables);
    try {
      const reply = await post(`/api/jobs/${JOB}/resume`);
      assert.equal(reply.status, 409);
      assert.equal(reply.body.code, code);
      assert.equal(tables.jobs[0].status, done === tables ? 'completed' : 'failed', 'nothing changes on a refusal');
    } finally { await close(); }
  }
  const missing = await hub({ jobs: [], tasks: [], events: [] });
  try { assert.equal((await missing.post(`/api/jobs/${JOB}/resume`)).status, 404); } finally { await missing.close(); }
});

test('stop works without a conversation, keeps the step in flight, and the stopped objective can be resumed', async () => {
  const tables = {
    jobs: [{ id: JOB, status: 'running', title: 'Research', project_id: 'p' }],
    tasks: [
      { id: T(1), job_id: JOB, status: 'done', attempts: 1, max_attempts: 3 },
      { id: T(2), job_id: JOB, status: 'running', attempts: 1, max_attempts: 3 },
      { id: T(3), job_id: JOB, status: 'queued', attempts: 0, max_attempts: 3 },
    ],
    events: [],
  };
  const { post, close } = await hub(tables);
  try {
    const stopped = await post(`/api/jobs/${JOB}/stop`);
    assert.deepEqual([stopped.status, stopped.body.stopped], [200, true]);
    assert.equal(tables.jobs[0].status, 'cancelled');
    assert.deepEqual(tables.tasks.map((task) => task.status), ['done', 'running', 'skipped']);
    assert.equal((await post(`/api/jobs/${JOB}/stop`)).body.code, 'JOB_NOT_RUNNING');

    const resumed = await post(`/api/jobs/${JOB}/resume`);
    assert.deepEqual([resumed.status, resumed.body.requeued], [200, 1]);
    assert.equal(tables.jobs[0].status, 'running');
    assert.deepEqual(tables.tasks.map((task) => task.status), ['done', 'running', 'queued']);
  } finally { await close(); }
});

test('end to end: a failed objective resumes after the provider recovers and only the failed work runs again', async () => {
  const goal = 'Plan the launch of a fictional bakery called Morning Harbor.';
  const plan = {
    route: 'orchestrate', plan_summary: 'Launch plan.', synthesis_brief: 'One plan.',
    workstreams: [
      { id: 'market', agent: 'research', title: 'Market research', brief: 'Research the bakery market in the city.', depends_on: [] },
      { id: 'finance', agent: 'finance', title: 'Launch budget', brief: 'Estimate the launch budget from the research.', depends_on: ['market'] },
    ],
  };
  const store = new MemoryStore({ goal });
  let providerUp = false;
  const ran = [];
  const outcome = (text) => ({ text, tokensIn: 10, tokensOut: 5, costUsd: 0, durationMs: 5, turns: 1 });
  const workflow = new OfficeWorkflow({
    store, now: () => store.now,
    plan: async () => ({ ...outcome(JSON.stringify(plan)), plan: validatePlan(JSON.stringify(plan)) }),
    specialist: async (input) => {
      ran.push(input.role);
      if (input.role === 'finance' && !providerUp) throw Object.assign(new Error('Upstream provider returned 500'), { code: 'PROVIDER_ERROR' });
      return outcome(`## Summary\n${input.role} done.\n\n## Work\n${input.title}.\n\n## Handoff\nNext.\n\n## Decisions for Fahad\nNone`);
    },
    synthesize: async () => outcome('# Morning Harbor launch plan\nConsolidated.'),
    direct: async () => outcome('n/a'),
  });
  const drain = async () => { for (let index = 0; index < 60; index += 1) if (!await workflow.runOnce()) return; throw new Error('not idle'); };

  await drain();
  const job = store.jobs[0];
  assert.equal(job.status, 'failed');
  const researchRuns = ran.filter((role) => role === 'research').length;
  assert.equal(researchRuns, 1);

  // The Hub's resume runs against the same rows the runtime uses.
  providerUp = true;
  const db = memoryPostgrest({ jobs: store.jobs, tasks: store.tasks, events: [] });
  const resumed = await resumeObjective(db, job.id);
  assert.ok(resumed.requeued >= 2, 'the failed step and the synthesis behind it are requeued');
  await drain();

  assert.equal(job.status, 'completed');
  assert.equal(ran.filter((role) => role === 'research').length, researchRuns, 'delivered research is not redone');
  assert.equal(store.results.find((result) => result.kind === 'final')?.content, '# Morning Harbor launch plan\nConsolidated.');
});

test('failure reasons read as natural Arabic in the Arabic interface, with the original kept for details', () => {
  assert.match(humanError('The web search provider returned no results for two attempts.', 'ar'), /البحث/);
  assert.match(humanError('Stale: no heartbeat, assumed crashed', 'ar'), /تستأنف/);
  assert.match(humanError('CAPACITY_WAIT_EXHAUSTED: waited 48 times', 'ar'), /سعة مجانية/);
  assert.match(humanError('something unexpected', 'ar'), /^تعثّرت المهمة/);
  assert.equal(humanError('something unexpected'), 'something unexpected', 'English keeps the original wording');
});
