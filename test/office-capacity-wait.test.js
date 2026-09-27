import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficeWorkflow } from '../src/workflow.js';
import { validatePlan } from '../src/chief.js';
import { OfficeModelRunner } from '../src/office/pool-runner.js';
import { capacityDecision, CAPACITY_LIMITS, WAITING_MESSAGE } from '../src/office/capacity.js';
import { capabilityProfile } from '../src/model-gateway/agentic/capabilities.js';
import { MemoryProviderStateStore } from '../src/model-gateway/agentic/provider-state.js';
import { officeState } from '../src/hub-office.js';
import { MemoryStore } from '../testing/fixtures/office-memory-store.js';

const MINUTE = 60_000;
const START = Date.parse('2026-09-27T08:00:00Z');

function route(id, client, extra = {}) {
  const [provider, ...rest] = id.split(':');
  const definition = { id, provider, model: rest.join(':'), billingClass: 'free', costTier: 1, qualityTier: 4, contextWindow: 131_072, toolCalling: true, privacyApproved: false, pricing: null, secretRef: `env://${provider.toUpperCase()}_API_KEY`, ...extra };
  return { ...definition, capabilities: capabilityProfile(definition, {}), unavailableReasons: extra.unavailableReasons || [], protocolClient: client };
}

// One free route; `script` decides each turn (text, a tool call, or a thrown provider error).
function harness({ script, unavailableReasons = [], seed = null } = {}) {
  const clock = { now: START };
  const stateStore = new MemoryProviderStateStore({ now: () => clock.now });
  if (seed) stateStore.rows.set('gemini:gemini-flash-latest', { provider: 'gemini', model: 'gemini-flash-latest', billingClass: 'free', ...seed(clock.now) });
  const calls = [];
  const toolRuns = [];
  const client = {
    async turn({ messages, tools }) {
      const prompt = messages.map((message) => (Array.isArray(message.content) ? message.content.map((block) => block.text || block.content || '').join(' ') : String(message.content))).join('\n');
      calls.push({ prompt, tools: tools.map((tool) => tool.name) });
      const step = script(calls.length, prompt, messages);
      if (step instanceof Error) throw step;
      const usage = { inputTokens: 100, outputTokens: 50, costUsd: 0 };
      if (step.tool) return { message: { role: 'assistant', content: [{ type: 'tool_call', id: `call-${calls.length}`, name: step.tool, arguments: step.args }] }, usage, stopReason: 'tool_calls', model: 'gemini-flash-latest', durationMs: 1 };
      return { message: { role: 'assistant', content: [{ type: 'text', text: step.text }] }, usage, stopReason: 'end', model: 'gemini-flash-latest', durationMs: 1 };
    },
  };
  const runner = new OfficeModelRunner({
    stateStore, now: () => clock.now, sleepFn: async () => {},
    poolFactory: () => [route('gemini:gemini-flash-latest', client, { unavailableReasons })],
    toolExecutorFactory: () => async (call) => { toolRuns.push(call.arguments); return { ok: true, result: { query: call.arguments.query, summary: `facts about ${call.arguments.query}`, sources: [] } }; },
  });
  const store = new MemoryStore({ goal: 'Research the Dubai coffee market.' });
  store.now = START;
  const plan = { route: 'orchestrate', plan_summary: 'Research.', synthesis_brief: 'Summary.', workstreams: [{ id: 'market', agent: 'research', title: 'Market research', brief: 'Research the Dubai coffee pre-order market with sources.', depends_on: [] }] };
  const make = () => new OfficeWorkflow({
    store, modelRunner: runner, now: () => clock.now, recoveryIntervalMs: Infinity,
    plan: async () => ({ text: JSON.stringify(plan), plan: validatePlan(JSON.stringify(plan)), tokensIn: 1, tokensOut: 1, costUsd: 0 }),
  });
  const advance = (ms) => { clock.now += ms; store.now = clock.now; };
  return { store, stateStore, calls, toolRuns, clock, advance, workflow: make(), make };
}

async function drain(workflow, limit = 30) {
  for (let index = 0; index < limit; index += 1) if (!await workflow.runOnce()) return;
}
const specialistTask = (store) => store.tasks.find((task) => task.agent_slug === 'research-strategy');

test('quota exhaustion: the step waits until the quota resets instead of failing, then resumes by itself', async () => {
  const reset = START + 90 * MINUTE;
  const h = harness({
    seed: () => ({ health: 'quota_exhausted', consecutiveFailures: 1, cooldownUntil: new Date(reset).toISOString(), lastErrorCode: 'PROVIDER_RATE_LIMIT' }),
    script: (n, prompt) => ({ text: /Summary\.|synthes/i.test(prompt) ? '## Executive summary\nDone.' : '## Summary\nMarket facts.\n\n## Work\nx\n\n## Handoff\nx\n\n## Decisions for Fahad\nNone' }),
  });
  await drain(h.workflow);
  const task = specialistTask(h.store);
  assert.equal(task.status, 'queued', 'waiting, not failed');
  assert.equal(h.store.jobs[0].status, 'running');
  assert.equal(new Date(task.not_before).toISOString(), new Date(reset).toISOString(), 'retries exactly when the quota resets');
  assert.equal(task.wait_info.reason, 'NO_FREE_CAPACITY');
  assert.deepEqual(task.wait_info.routes.map((entry) => entry.id), ['gemini:gemini-flash-latest']);
  assert.ok(!h.store.events.some((event) => event.type === 'job_failed'));
  const waiting = h.store.events.find((event) => event.payload?.status === 'WAITING_FOR_CAPACITY');
  assert.equal(waiting.message, WAITING_MESSAGE);
  assert.equal(h.calls.length, 0, 'no model was called while nothing is available');

  // Before the reset nothing runs; after it the step resumes and the job completes.
  h.advance(30 * MINUTE);
  await drain(h.workflow);
  assert.equal(specialistTask(h.store).status, 'queued');
  h.advance(61 * MINUTE);
  await drain(h.workflow);
  assert.equal(specialistTask(h.store).status, 'done');
  assert.equal(h.store.jobs[0].status, 'completed');
  assert.equal(specialistTask(h.store).max_attempts, 4, 'the wait did not use up a retry');
});

test('a rate limit mid-step keeps the completed tool calls: the resumed step does not repeat them', async () => {
  let limited = true;
  const h = harness({
    script: (n, prompt) => {
      if (/Summary\./.test(prompt) && !/Market research/.test(prompt)) return { text: '## Executive summary\nDone.' };
      if (/CHECKPOINT/.test(prompt)) return { text: '## Summary\nResumed with the saved search.\n\n## Work\nx\n\n## Handoff\nx\n\n## Decisions for Fahad\nNone' };
      if (!/tool_result|facts about/.test(prompt) && limited) return { tool: 'web_search', args: { query: 'dubai coffee apps' } };
      if (limited) { limited = false; return Object.assign(new Error('rate limited'), { status: 429, retryAfter: '600' }); }
      return { text: 'unexpected' };
    },
  });
  await drain(h.workflow);
  const task = specialistTask(h.store);
  assert.equal(task.status, 'queued', 'waiting after the rate limit');
  assert.equal(h.toolRuns.length, 1);
  assert.deepEqual(task.wait_info.checkpoint.completedToolCalls.map((call) => call.name), ['web_search'], 'the completed search is checkpointed');
  assert.ok(Date.parse(new Date(task.not_before).toISOString()) >= START + 10 * MINUTE - 1000, 'retry after the provider cooldown');

  // A restarted worker (new workflow instance, same durable store) resumes it.
  h.advance(11 * MINUTE);
  const restarted = h.make();
  await drain(restarted);
  assert.equal(specialistTask(h.store).status, 'done');
  assert.equal(h.toolRuns.length, 1, 'the search was not run again');
  const resumedPrompt = h.calls.find((call) => /CHECKPOINT/.test(call.prompt));
  assert.match(resumedPrompt.prompt, /web_search\(\{"query":"dubai coffee apps"\}\)/);
  assert.match(h.store.results.find((result) => result.task_id === specialistTask(h.store).id).content, /Resumed with the saved search/);
  assert.equal(h.store.jobs[0].status, 'completed');
});

test('a permanent blocker fails clearly instead of waiting', async () => {
  const h = harness({ unavailableReasons: ['CREDENTIAL_MISSING'], script: () => ({ text: 'never' }) });
  await drain(h.workflow);
  const task = specialistTask(h.store);
  assert.equal(task.status, 'failed');
  assert.ok(!task.wait_count, 'never waited');
  const failure = h.store.runs.filter((run) => run.task_id === task.id).at(-1).error_message;
  assert.match(failure, /No allowed model can run this step: CREDENTIAL_MISSING/);
  assert.equal(h.store.jobs[0].status, 'failed');
});

test('an account blocker is permanent; waits are bounded and end with the blocker', () => {
  const now = START;
  const blocked = capacityDecision({ code: 'NO_ELIGIBLE_PROVIDER', evaluations: [
    { id: 'qwen:x', reasons: ['COOLDOWN_AUTH_ERROR'], cooldownUntil: new Date(now + 3600_000).toISOString() },
    { id: 'anthropic:y', reasons: ['PAID_ROUTE_NOT_ALLOWED'] },
  ] }, { now });
  assert.equal(blocked.kind, 'blocked');
  assert.match(blocked.summary.text, /COOLDOWN_AUTH_ERROR|PAID_ROUTE_NOT_ALLOWED/);
  // Unknown recovery time → exponential backoff, capped.
  const early = capacityDecision({ code: 'ALL_PROVIDERS_UNAVAILABLE', evaluations: [{ id: 'a:b', reasons: ['FAILED_THIS_TURN'] }] }, { now, waitCount: 0 });
  const late = capacityDecision({ code: 'ALL_PROVIDERS_UNAVAILABLE', evaluations: [{ id: 'a:b', reasons: ['FAILED_THIS_TURN'] }] }, { now, waitCount: 20 });
  assert.equal(Date.parse(early.until) - now, CAPACITY_LIMITS.minWaitMs);
  assert.equal(Date.parse(late.until) - now, CAPACITY_LIMITS.maxBackoffMs);
  // Paid routes excluded by policy never make a step wait for them.
  const mixed = capacityDecision({ code: 'NO_ELIGIBLE_PROVIDER', evaluations: [
    { id: 'free:a', reasons: ['COOLDOWN_QUOTA_EXHAUSTED'], cooldownUntil: new Date(now + 5 * MINUTE).toISOString() },
    { id: 'paid:b', reasons: ['PAID_ROUTE_NOT_ALLOWED'] },
  ] }, { now });
  assert.deepEqual(mixed.info.routes.map((entry) => entry.id), ['free:a']);
  assert.equal(capacityDecision(new Error('boom'), { now }), null, 'ordinary errors keep the normal retry path');
});

test('after the wait limit the step fails with the real blocker', async () => {
  const h = harness({
    seed: (now) => ({ health: 'rate_limited', consecutiveFailures: 3, cooldownUntil: new Date(now + 1000 * 3600_000).toISOString() }),
    script: () => ({ text: 'never' }),
  });
  await drain(h.workflow);
  const task = specialistTask(h.store);
  task.wait_count = CAPACITY_LIMITS.maxWaits;
  task.not_before = null;
  await drain(h.workflow);
  assert.equal(task.status, 'failed');
  assert.match(h.store.runs.filter((run) => run.task_id === task.id).at(-1).error_message, /Waited 48 times for free model capacity; none recovered\. Blocker: gemini:gemini-flash-latest COOLDOWN_RATE_LIMITED/);
});

test('the Office shows who is waiting for capacity', () => {
  const now = START;
  const states = officeState({
    agents: [{ id: 'a1', slug: 'research-strategy' }],
    jobs: [{ id: 'j1', status: 'running', title: 'X' }],
    tasks: [{ id: 't1', job_id: 'j1', agent_id: 'a1', title: 'Market research', status: 'queued', depends_on: [], brief: '{"stage":"specialist"}', created_at: new Date(now).toISOString(),
      not_before: new Date(now + 30 * MINUTE).toISOString(), wait_info: { reason: 'NO_FREE_CAPACITY', expected_at: new Date(now + 30 * MINUTE).toISOString() } }],
    now,
  });
  assert.equal(states.get('research-strategy').state, 'WAITING');
  assert.match(states.get('research-strategy').detail, /Waiting for free model capacity — will resume automatically/);
});

test('free-only mode: when free capacity is exhausted a healthy paid route is never called — the step waits', async () => {
  const clock = { now: START };
  const stateStore = new MemoryProviderStateStore({ now: () => clock.now });
  stateStore.rows.set('gemini:gemini-flash-latest', { provider: 'gemini', model: 'gemini-flash-latest', billingClass: 'free', health: 'quota_exhausted', cooldownUntil: new Date(START + 60 * MINUTE).toISOString() });
  const paidCalls = [];
  const paid = { async turn() { paidCalls.push(1); return { message: { role: 'assistant', content: [{ type: 'text', text: 'paid answer' }] }, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 }, stopReason: 'end', model: 'claude-sonnet-5', durationMs: 1 }; } };
  const free = { async turn() { throw new Error('must not be called while cooling down'); } };
  const runner = new OfficeModelRunner({
    stateStore, now: () => clock.now, sleepFn: async () => {},
    routingStore: { getRoutingPolicy: async () => ({ allowPaid: false }) },
    poolFactory: () => [route('gemini:gemini-flash-latest', free), route('anthropic:claude-sonnet-5', paid, { billingClass: 'paid', pricing: { inputPerMillion: 3, outputPerMillion: 15 }, qualityTier: 5 })],
    toolExecutorFactory: () => async () => ({ ok: true, result: {} }),
  });
  const store = new MemoryStore({ goal: 'Research.', projectId: 'ws-1' });
  store.now = START;
  const plan = { route: 'orchestrate', plan_summary: 'x', synthesis_brief: 'x', workstreams: [{ id: 'm', agent: 'research', title: 'Market research', brief: 'Research the market carefully with sources.', depends_on: [] }] };
  const workflow = new OfficeWorkflow({ store, modelRunner: runner, now: () => clock.now, recoveryIntervalMs: Infinity,
    plan: async () => ({ text: '{}', plan: validatePlan(JSON.stringify(plan)), tokensIn: 1, tokensOut: 1, costUsd: 0 }) });
  store.jobContext = async () => ({ text: '', project: { id: 'ws-1', name: 'x' } });
  await drain(workflow);
  assert.equal(paidCalls.length, 0, 'no hidden paid fallback');
  const task = specialistTask(store);
  assert.equal(task.status, 'queued');
  assert.deepEqual(task.wait_info.routes.map((entry) => entry.id), ['gemini:gemini-flash-latest'], 'waits only for the free route');
});
