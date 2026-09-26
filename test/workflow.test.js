import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficeWorkflow, SEQUENCES, STAGES, safeError, selectWorkspacePolicyStore } from '../src/workflow.js';
import { MemoryStore } from '../testing/fixtures/office-memory-store.js';

const outcome = (text, extra = {}) => ({
  text, tokensIn: 10, tokensOut: 5, costUsd: 0.01, durationMs: 25, turns: 1, ...extra,
});

function fixture(overrides = {}, options = {}) {
  const store = new MemoryStore();
  const calls = [];
  const plan = overrides.plan || (async ({ onActivity }) => {
    calls.push('chief-plan');
    await onActivity({ turns: 1 });
    return outcome('{"plan":true}', {
      plan: { plan_summary: 'Delegate verified research.', research_brief: 'Find three verified options.', review_brief: 'Review and recommend.' },
    });
  });
  const research = overrides.research || (async ({ onActivity }) => {
    calls.push('research');
    await onActivity({ turns: 2 });
    return outcome('## Findings\nThree verified options.\n\nSources: https://example.test');
  });
  const review = overrides.review || (async ({ research: input, onActivity }) => {
    calls.push('chief-review');
    assert.match(input.content, /Three verified options/);
    await onActivity({ turns: 1 });
    return outcome('Recommendation: apply all three in stages.');
  });
  const workflow = new OfficeWorkflow({
    store, plan, research, review,
    maxAttempts: options.maxAttempts || 3,
    recoveryIntervalMs: options.recoveryIntervalMs ?? 60_000,
    now: () => store.now,
  });
  return { store, calls, workflow };
}

async function drain(workflow, limit = 20) {
  for (let index = 0; index < limit; index += 1) {
    if (!await workflow.runOnce()) return;
  }
  throw new Error('Workflow did not become idle');
}

test('A. normal workflow runs Chief -> Research -> Chief and completes', async () => {
  const { store, calls, workflow } = fixture();
  await drain(workflow);
  assert.deepEqual(calls, ['chief-plan', 'research', 'chief-review']);
  assert.equal(store.jobs[0].status, 'completed');
  assert.deepEqual(store.tasks.map((task) => task.status), ['done', 'done', 'done']);
  assert.equal(store.runs.length, 3);
  assert.equal(store.handoffs.length, 2);
  assert.equal(store.results.filter((result) => result.kind === 'final').length, 1);
});

test('manual DeepSeek preference applies only to tool-free Chief stages', async () => {
  const { store, workflow } = fixture();
  store.jobs[0].requested_provider = 'deepseek';
  const task = { job_id: 'job-1', task_id: 'task-1', run_id: 'run-1', agent_id: 'chief', project_id: 'workspace-1' };
  assert.equal(await workflow.providerPreference(task, STAGES.PLAN), 'deepseek');
  assert.equal(await workflow.providerPreference(task, STAGES.RESEARCH), 'anthropic');
  assert.equal(workflow.modelExecution(task, STAGES.PLAN, 'deepseek', 'deepseek-flash').gatewayContext.provider, 'deepseek');
  assert.equal(workflow.modelExecution(task, STAGES.RESEARCH).gatewayContext.provider, null);
});

test('B. final review remains blocked until Research completes', async () => {
  const { store, workflow } = fixture();
  await workflow.runOnce();
  const research = store.tasks.find((task) => task.sequence === SEQUENCES.RESEARCH);
  const review = store.tasks.find((task) => task.sequence === SEQUENCES.REVIEW);
  assert.deepEqual(review.depends_on, [research.id]);
  assert.equal(review.status, 'queued');
  const claimed = await store.claimNextTask();
  assert.equal(claimed.task_id, research.id);
  const second = await store.claimNextTask();
  assert.equal(second, null);
});

test('C. handoffs preserve task, agent and persisted Research content', async () => {
  const { store, workflow } = fixture();
  await drain(workflow);
  const [toResearch, toChief] = store.handoffs;
  assert.equal(toResearch.from_agent_id, 'chief');
  assert.equal(toResearch.to_agent_id, 'research');
  assert.equal(toChief.from_agent_id, 'research');
  assert.equal(toChief.to_agent_id, 'chief');
  assert.equal(toChief.job_id, store.jobs[0].id);
  const researchResult = store.results.find((result) => result.task_id === toChief.from_task_id);
  assert.match(researchResult.content, /Three verified options/);
});

test('D. temporary Research failure retries without duplicate result', async () => {
  let attempts = 0;
  const { store, workflow } = fixture({
    research: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary provider failure');
      return outcome('## Findings\nThree verified options.');
    },
  });
  await drain(workflow);
  const researchTask = store.tasks.find((task) => task.sequence === SEQUENCES.RESEARCH);
  assert.equal(researchTask.attempts, 2);
  assert.equal(store.results.filter((result) => result.task_id === researchTask.id).length, 1);
  assert.equal(store.events.filter((event) => event.type === 'retry').length, 1);
  assert.equal(store.jobs[0].status, 'completed');
});

test('E. exhausted Research failure blocks review and fails the job', async () => {
  let reviewCalls = 0;
  const { store, workflow } = fixture({
    research: async () => { throw new Error('permanent research failure'); },
    review: async () => { reviewCalls += 1; return outcome('must not run'); },
  }, { maxAttempts: 2 });
  await drain(workflow);
  const review = store.tasks.find((task) => task.sequence === SEQUENCES.REVIEW);
  assert.equal(review.status, 'blocked');
  assert.equal(store.jobs[0].status, 'failed');
  assert.equal(reviewCalls, 0);
});

test('F. stale task recovery fails the abandoned run and safely retries', async () => {
  const { store, workflow } = fixture({}, { recoveryIntervalMs: 1 });
  await workflow.runOnce();
  const abandoned = await store.claimNextTask();
  assert.equal(abandoned.agent_slug, 'research-strategy');
  store.tasks.find((task) => task.id === abandoned.task_id).stale = true;
  store.now += 2;
  await drain(workflow);
  const researchTask = store.tasks.find((task) => task.sequence === SEQUENCES.RESEARCH);
  assert.equal(researchTask.attempts, 2);
  assert.equal(store.runs.filter((run) => run.task_id === researchTask.id && run.status === 'failed').length, 1);
  assert.equal(store.jobs[0].status, 'completed');
});

test('G. claim locking prevents simultaneous duplicate execution', async () => {
  const { store, workflow } = fixture();
  await workflow.runOnce();
  const [first, second] = await Promise.all([store.claimNextTask(), store.claimNextTask()]);
  assert.ok(first?.task_id);
  assert.equal(second, null);
  assert.equal(store.runs.filter((run) => run.task_id === first.task_id).length, 1);
});

test('H. cost, model and operational events stay attached to the correct records', async () => {
  const { store, workflow } = fixture();
  await drain(workflow);
  assert.equal(store.jobs[0].tokens_used, 45);
  assert.equal(store.jobs[0].cost_usd, 0.03);
  assert.ok(store.runs.every((run) => run.model && run.tokens_in === 10 && run.tokens_out === 5));
  const metrics = store.events.filter((event) => event.type === 'activity' && event.payload?.provider);
  assert.equal(metrics.length, 3);
  assert.ok(metrics.every((event) => event.jobId && event.taskId && event.runId));
  assert.deepEqual(metrics.map((event) => event.payload.provider), ['anthropic', 'anthropic', 'anthropic']);
  assert.ok(store.events.some((event) => event.type === 'job_completed'));
});

test('errors redact credential-shaped values before persistence', () => {
  const credentialShapedFixture = 'sk-' + 'example123456789';
  assert.equal(safeError(new Error('Bearer secret-value ' + credentialShapedFixture)), 'Bearer [REDACTED] [REDACTED]');
});

test('workspace-scoped jobs enforce policy while legacy jobs remain unchanged', () => {
  const policyStore = { marker: 'policy-store' };
  assert.equal(selectWorkspacePolicyStore({ policyStore, workspaceId: 'workspace-1' }), policyStore);
  assert.equal(selectWorkspacePolicyStore({ policyStore, workspaceId: null }), null);
  assert.equal(selectWorkspacePolicyStore({ policyStore, workspaceId: null, enforceLegacy: true }), policyStore);
  assert.equal(selectWorkspacePolicyStore({ policyStore: null, workspaceId: 'workspace-1' }), null);
});

