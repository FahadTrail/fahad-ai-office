import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficeWorkflow } from '../src/workflow.js';
import { validatePlan } from '../src/chief.js';
import { buildJobContext } from '../src/job-context.js';
import { taskTimeline, taskNow, ownerAction, attentionFrom, autoTitle, parseOwnerQuestion, approvalCard, taskView } from '../src/hub-workspace.js';
import { MemoryStore } from '../testing/fixtures/office-memory-store.js';

function chiefReturning(plan, seen = []) {
  return async (args) => {
    seen.push(args);
    const text = JSON.stringify(plan);
    return { text, tokensIn: 10, tokensOut: 5, costUsd: 0, provider: 'groq', model: 'openai/gpt-oss-120b', plan: validatePlan(text) };
  };
}

async function drain(workflow) {
  for (let step = 0; step < 12; step += 1) if (!(await workflow.runOnce())) break;
}

test('the Chief plan contract has three routes; old plans stay valid as "delegate"', () => {
  assert.equal(validatePlan(JSON.stringify({ route: 'answer', answer: 'Hello Fahad!', plan_summary: 'Greeting' })).route, 'answer');
  assert.equal(validatePlan(JSON.stringify({ route: 'answer', answer: 'Hi' })).plan_summary, 'Hi', 'a missing summary is derived from the answer');
  assert.throws(() => validatePlan(JSON.stringify({ route: 'answer', answer: '', plan_summary: 'x' })), /no answer/);
  const dev = validatePlan(JSON.stringify({ route: 'development', plan_summary: 'Add provider X', development_objective: 'Add provider X to the model pool with tests' }));
  assert.equal(dev.development_title, 'Add provider X');
  assert.throws(() => validatePlan(JSON.stringify({ route: 'development', plan_summary: 'x', development_objective: 'short' })), /usable objective/);
  const legacy = validatePlan(JSON.stringify({ research_required: true, specialist: 'seo', plan_summary: 'p', research_brief: 'b', review_brief: 'r' }));
  assert.equal(legacy.route, 'delegate');
  assert.equal(legacy.specialist, 'seo');
  assert.throws(() => validatePlan(JSON.stringify({ route: 'delegate', plan_summary: 'p' })), /research_brief/);
});

test('"answer": the Chief replies in one step with the conversation context in its prompt', async () => {
  const store = new MemoryStore({ goal: 'And what did we decide about the budget?' });
  store.jobContext = async () => ({ text: 'Earlier in this conversation:\nFahad: Plan the launch\nOffice: Budget is $2/month.', project: { id: 'p1', defaultRepository: 'FahadTrail/fahad-ai-office' }, conversationId: 'c1' });
  const seen = [];
  const workflow = new OfficeWorkflow({ store, plan: chiefReturning({ route: 'answer', answer: 'We decided on **$2/month**.', plan_summary: 'Recall the budget' }, seen), recoveryIntervalMs: Infinity });
  await drain(workflow);
  assert.match(seen[0].context, /Budget is \$2\/month/, 'earlier turns reach the Chief');
  assert.equal(store.jobs[0].status, 'completed');
  assert.equal(store.tasks.length, 1, 'no specialist task was created');
  assert.ok(store.results.some((result) => /\$2\/month/.test(result.content)));
});

test('"development": the Chief launches a Coding Agent task linked to the conversation', async () => {
  const store = new MemoryStore({ goal: 'Add provider X to the Office.' });
  const launched = [];
  store.jobContext = async () => ({ text: 'Project: Fahad AI Office', project: { id: 'p1', name: 'Fahad AI Office', defaultRepository: 'FahadTrail/fahad-ai-office' }, conversationId: 'c1' });
  store.createCodingSession = async (input) => { launched.push(input); return { id: 'session-1', title: input.title }; };
  const workflow = new OfficeWorkflow({ store, plan: chiefReturning({ route: 'development', plan_summary: 'Add provider X with tests', development_title: 'Add provider X', development_objective: 'Add provider X to the model pool, with an adapter and tests.' }), recoveryIntervalMs: Infinity });
  await drain(workflow);
  assert.equal(launched.length, 1);
  assert.equal(launched[0].repository, 'FahadTrail/fahad-ai-office');
  assert.equal(launched[0].conversationId, 'c1');
  assert.match(launched[0].objective, /Original request from Fahad: Add provider X/);
  assert.equal(store.jobs[0].status, 'completed');
  assert.ok(store.results.some((result) => /started a development task/.test(result.content)));
  assert.ok(store.events.some((event) => event.payload?.kind === 'task_launched' && event.payload.session_id === 'session-1'));
});

test('"development" without a project repository explains how to fix it instead of failing', async () => {
  const store = new MemoryStore({ goal: 'Fix the login bug.' });
  store.jobContext = async () => ({ text: '', project: { id: 'p1', defaultRepository: null }, conversationId: 'c1' });
  store.createCodingSession = async () => { throw new Error('must not be called'); };
  const workflow = new OfficeWorkflow({ store, plan: chiefReturning({ route: 'development', plan_summary: 'Fix login', development_objective: 'Fix the login bug and add a regression test.' }), recoveryIntervalMs: Infinity });
  await drain(workflow);
  assert.equal(store.jobs[0].status, 'completed');
  assert.ok(store.results.some((result) => /no repository set yet/.test(result.content)));
});

test('job context is bounded and ordered for the Chief', () => {
  const context = buildJobContext({
    project: { id: 'p', name: 'Fahad AI Office', description: 'd'.repeat(2000), default_repository: 'FahadTrail/fahad-ai-office' },
    memory: [{ kind: 'decision', content: 'Free models first.' }],
    turns: Array.from({ length: 9 }, (_, index) => ({ goal: `question ${index}`, answer: 'x'.repeat(5000) })),
    tasks: [{ title: 'Fix Qwen keys', status: 'completed', result: { summary: 'Merged' } }],
    conversationId: 'c1',
  });
  assert.ok(context.text.length <= 6000);
  assert.match(context.text, /repository FahadTrail\/fahad-ai-office/);
  assert.match(context.text, /\[decision\] Free models first\./);
  assert.match(context.text, /Fix Qwen keys — completed: Merged/);
  assert.equal(context.project.defaultRepository, 'FahadTrail/fahad-ai-office');
});

const session = (overrides = {}) => ({
  id: 's1', title: 'Add provider X', status: 'running', phase: 'implement', config: { deploy: { mode: 'none' } }, state: {},
  iteration: 4, spent_usd: 0.01, created_at: '2026-09-27T10:00:00Z', updated_at: '2026-09-27T10:05:00Z', ...overrides,
});

test('the task timeline speaks in stages with clear states', () => {
  const states = (s, opts) => Object.fromEntries(taskTimeline(s, opts).map((stage) => [stage.key, stage.state]));
  const running = states(session());
  assert.deepEqual([running.understand, running.plan, running.implement, running.test, running.debug, running.approval, running.done], ['passed', 'passed', 'active', 'pending', 'skipped', 'skipped', 'pending']);
  const blocked = states(session({ status: 'blocked', phase: 'test', error_code: 'HUMAN_INPUT_REQUIRED' }));
  assert.equal(blocked.test, 'needs_input');
  assert.equal(blocked.debug, 'skipped', 'debugging only appears when it actually happens');
  const debugged = states(session({ phase: 'publish' }), { events: [{ type: 'phase', payload: { phase: 'debug' } }] });
  assert.equal(debugged.debug, 'passed');
  const noDebug = states(session({ phase: 'publish' }));
  assert.equal(noDebug.debug, 'skipped', 'an unused debugging stage is not shown as pending');
  const merge = states(session({ status: 'awaiting_approval', phase: 'ci', config: { deploy: { mode: 'merge' } } }), { approvals: [{ status: 'pending', tool_name: 'github.pr_merge' }] });
  assert.equal(merge.ci, 'passed');
  assert.equal(merge.approval, 'needs_input');
  assert.equal(merge.deploy, 'pending');
  const failed = states(session({ status: 'failed', phase: 'ci' }));
  assert.equal(failed.ci, 'failed');
  const done = states(session({ status: 'completed', phase: 'done' }));
  assert.equal(done.done, 'passed');
});

test('"what it is doing now" is plain English', () => {
  assert.equal(taskNow(session(), [{ type: 'tool_call', payload: { tool: 'repo.edit', args: { path: 'src/a.js' } } }]), 'Editing src/a.js.');
  assert.equal(taskNow(session(), [{ type: 'tool_result', payload: { tool: 'shell.run', command: 'node --test' } }]), 'Running the tests.');
  assert.equal(taskNow(session(), [{ type: 'model_turn', payload: {} }]), 'Thinking about the next step.');
  assert.equal(taskNow(session({ status: 'blocked', error_code: 'HUMAN_INPUT_REQUIRED' })), 'Waiting for your answer.');
  assert.equal(taskNow(session({ status: 'queued' })), 'Waiting for a worker to pick this up.');
});

test('owner actions: approvals first, then questions, then other pauses', () => {
  const protectedChange = { id: 'a1', status: 'pending', tool_name: 'repo.protected_change', risk: 'high', summary: 'Change ops/set-secret.sh', arguments_preview: { paths: ['ops/set-secret.sh'], reason: 'Accept sk-ws keys' } };
  const approval = ownerAction(session({ status: 'awaiting_approval' }), [protectedChange]);
  assert.equal(approval.kind, 'approval');
  assert.equal(approval.title, 'Fahad, I need your approval.');
  assert.deepEqual(approval.items[0].resources, ['ops/set-secret.sh']);
  assert.equal(approval.items[0].why, 'Accept sk-ws keys');
  assert.equal(approvalCard({ id: 'm', status: 'pending', tool_name: 'github.pr_merge', risk: 'medium', summary: 'Merge PR #5', arguments_preview: { number: 5 } }).what, 'Merge the pull request (this deploys to production)');
  const question = ownerAction(session({ status: 'blocked', error_code: 'HUMAN_INPUT_REQUIRED', blocker: 'Agent needs the owner: Two configs exist — Which config file should I change?' }), []);
  assert.deepEqual([question.kind, question.question, question.reason], ['question', 'Which config file should I change?', 'Two configs exist']);
  assert.equal(parseOwnerQuestion('Agent needs the owner: Only a reason').question, 'Only a reason');
  const budget = ownerAction(session({ status: 'blocked', error_code: 'BUDGET_EXHAUSTED' }), []);
  assert.match(budget.explanation, /budget/i);
  assert.equal(ownerAction(session(), []), null);
});

test('needs attention ranks actions before failures before completions', () => {
  const items = attentionFrom({
    sessions: [
      session({ id: 'done', status: 'completed', result: { summary: 'Merged' }, completed_at: '2026-09-27T11:00:00Z' }),
      session({ id: 'ask', status: 'blocked', error_code: 'HUMAN_INPUT_REQUIRED', blocker: 'Agent needs the owner: x — Which one?' }),
      session({ id: 'bad', status: 'failed', blocker: 'boom' }),
    ],
    approvals: [],
    failedJobs: [{ id: 'j', title: 'Research', conversation_id: 'c', created_at: '2026-09-27T09:00:00Z' }],
  });
  assert.deepEqual(items.map((item) => item.kind), ['question', 'failed', 'failed', 'completed']);
  assert.equal(items[0].detail, 'Which one?');
});

test('titles are short and readable; task view exposes efficiency metrics', () => {
  assert.equal(autoTitle('Research the best free LLM APIs for our office. Then compare them.'), 'Research the best free LLM APIs for our office.');
  assert.ok(autoTitle('x '.repeat(100)).length <= 60);
  assert.equal(autoTitle('[confidential] Budget plan'), 'Budget plan');
  const view = taskView(session({ provider_switches: 1, current_route: 'deepseek:deepseek-flash' }), {
    events: [{ type: 'checkpoint', message: 'Transcript compacted into a durable continuation summary.' }],
    attempts: [{ provider: 'deepseek', model: 'deepseek-flash', input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50 }],
  });
  assert.deepEqual([view.metrics.modelCalls, view.metrics.inputTokens, view.metrics.cachedInputTokens, view.metrics.modelSwitches, view.metrics.compactions], [1, 1000, 900, 1, 1]);
  assert.equal(view.currentModel, 'deepseek:deepseek-flash');
});

test('the Model Pool is shown in four owner-facing states; a blocked account never hides the others', async () => {
  const { modelsView, simpleModelStatus } = await import('../src/hub-workspace.js');
  assert.equal(simpleModelStatus({ status: 'BLOCKED — MODEL STUDIO ACTIVATION REQUIRED', accountBlocker: { text: 'Activate Model Studio' } }).status, 'ACCOUNT ACTION REQUIRED');
  assert.equal(simpleModelStatus({ status: 'RATE LIMITED', cooldownUntil: '2026-09-26T20:00:00Z' }).status, 'COOLDOWN');
  assert.equal(simpleModelStatus({ status: 'LIVE' }).status, 'AVAILABLE');
  assert.equal(simpleModelStatus({ status: 'CONFIGURED — NOT YET VERIFIED' }).status, 'AVAILABLE');
  assert.equal(simpleModelStatus({ status: 'NOT CONFIGURED' }).status, 'UNAVAILABLE');
  const view = modelsView({ routes: [
    { id: 'qwen:qwen3.8-flash', provider: 'qwen', model: 'qwen3.8-flash', status: 'BLOCKED — MODEL STUDIO ACTIVATION REQUIRED', billingClass: 'PAID' },
    { id: 'deepseek:deepseek-flash', provider: 'deepseek', model: 'deepseek-flash', status: 'LIVE', billingClass: 'PAID', routingRank: 1 },
    { id: 'github:x', provider: 'github', model: 'x', status: 'RETIRED', retired: true, billingClass: 'FREE' },
  ] });
  assert.equal(view.mode, 'AUTO');
  assert.deepEqual(view.models.map((model) => model.id), ['deepseek:deepseek-flash', 'qwen:qwen3.8-flash']);
  assert.deepEqual(view.counts, { AVAILABLE: 1, 'ACCOUNT ACTION REQUIRED': 1 });
});

test('chat progress is described in plain words', async () => {
  const { chatStage } = await import('../src/hub-workspace.js');
  assert.equal(chatStage({ status: 'planning' }), 'Thinking');
  assert.equal(chatStage({ status: 'running' }, [{ title: 'Research the request', status: 'running' }]), 'Researching');
  assert.equal(chatStage({ status: 'running' }, [{ title: 'Chief final review', status: 'assigned' }]), 'Reviewing the answer');
});

test('the Chief answers in the language of the current message', async () => {
  const { readFileSync } = await import('node:fs');
  const chief = readFileSync(new URL('../src/chief.js', import.meta.url), 'utf8');
  assert.match(chief, /same language as Fahad\\'s current message/);
  assert.doesNotMatch(chief, /in Fahad\\'s language\)/);
});
