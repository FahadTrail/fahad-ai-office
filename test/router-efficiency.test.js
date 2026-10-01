// Router & token efficiency sprint (branch claude/router-efficiency-v1).
// Regression matrix A–Q from docs/free-capacity-audit.md plus the offline
// replay of the conditions that stalled the Sanad Desk acceptance job.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentTurnGateway } from '../src/model-gateway/agentic/turn-gateway.js';
import { MemoryProviderStateStore } from '../src/model-gateway/agentic/provider-state.js';
import { createModelPool } from '../src/model-gateway/agentic/model-pool.js';
import { setProviderCatalog } from '../src/model-gateway/agentic/provider-catalogs.js';
import { capacityPool, poolSummary } from '../src/model-gateway/agentic/capacity-pools.js';
import { financeJob, relaxedJob, requiredContext } from '../src/model-gateway/agentic/capabilities.js';
import { evidenceCapabilities, QUALIFICATION_SUITE_VERSION } from '../src/model-gateway/agentic/qualification.js';
import { modelUsage } from '../src/model-gateway/agentic/usage-telemetry.js';
import { capacityDecision } from '../src/office/capacity.js';
import { stepJob, stepWebTools } from '../src/office/routing-hints.js';
import { handoffPacket, upstreamBlock } from '../src/office/specialist.js';
import { createOfficeToolExecutor, officeWebTools, searchBreaker } from '../src/office/web-tools.js';
import { modelToolSpecs } from '../src/coding-agent/tools.js';
import { taskSize, turnBudgetAction } from '../src/coding-agent/turn-budget.js';
import { officeAgent } from '../src/office/agents.js';

const NOW = Date.parse('2026-09-28T07:30:00Z');
const KEY = 'placeholder-test-key-000000000000';
const ENV = { GEMINI_API_KEY: KEY, GROQ_API_KEY: KEY, OPENROUTER_API_KEY: KEY, ZHIPU_API_KEY: KEY, DEEPSEEK_API_KEY: KEY, DEEPSEEK_API_TRAINING_OPTOUT_VERIFIED: 'true' };
const OPENROUTER = { models: [
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', admitted: true, contextLength: 262_144, structuredOutput: true },
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', admitted: true, contextLength: 262_144, structuredOutput: true },
] };
const qualified = (skills = {}) => ({ status: 'qualified', suiteVersion: QUALIFICATION_SUITE_VERSION, testedAt: new Date(NOW - 86_400_000).toISOString(),
  skills: { instruction: true, structured: true, reasoning: true, coding: true, writing: true, reading: true, tools: true, ...skills } });
// Production qualification evidence (provider_canary_runs, 2026-09-26/27).
const PRODUCTION_QUALIFICATIONS = new Map([
  ['gemini:gemini-flash-latest', qualified()],
  ['gemini:gemini-flash-lite-latest', qualified({ coding: false })],
  ['gemini:gemma-4-26b-a4b-it', qualified()],
  ['groq:openai/gpt-oss-120b', qualified()],
  ['groq:openai/gpt-oss-20b', qualified()],
  ['groq:qwen/qwen3.8-27b', qualified({ coding: false })],
  ['openrouter:nvidia/nemotron-3-ultra-550b-a55b:free', qualified()],
  ['openrouter:nvidia/nemotron-3-super-120b-a12b:free', qualified()],
  ['zhipu:glm-4.5-flash', qualified()],
  ['zhipu:glm-4.7-flash', qualified()],
]);

function productionPool(fetchFn = async () => { throw new Error('offline'); }) {
  setProviderCatalog('gemini', { ok: true, models: ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemma-4-26b-a4b-it'], contexts: { 'gemma-4-26b-a4b-it': 131_072 } });
  try {
    return createModelPool({ env: ENV, openRouterCatalog: OPENROUTER, fetchFn });
  } finally {
    setProviderCatalog('gemini', null);
  }
}
const exhausted = (until) => ({ health: 'quota_exhausted', cooldownUntil: until, consecutiveFailures: 1, lastErrorCode: 'PROVIDER_RATE_LIMIT' });
const eligibility = (evaluations) => Object.fromEntries(evaluations.map((entry) => [entry.route.id, entry.eligible ? 'OK' : entry.reasons.join('+')]));

test('A. a tokens-per-minute limit is not a context window', () => {
  const groq = productionPool().find((route) => route.id === 'groq:openai/gpt-oss-120b');
  assert.equal(groq.contextWindow, 131_072);
  assert.equal(groq.capabilities.contextWindow, 131_072, 'context window is the model window');
  assert.equal(groq.capabilities.tokensPerMinute, 8000, 'the rate is kept separately');
});

test('B. a request needs only its real context (with margin); oversized requests are still refused', async () => {
  assert.equal(requiredContext(6000, 4000), 12_500);
  assert.equal(requiredContext(1000, 1000), 8000, 'floor');
  const small = { id: 'x:small', provider: 'x', model: 'small', billingClass: 'free', qualityTier: 3, costTier: 1, contextWindow: 16_000, unavailableReasons: [],
    capabilities: { reasoning: 4, research: 4, writing: 4, coding: 3, structuredOutput: true, toolCalling: true, contextWindow: 16_000, arabic: 3 } };
  const gateway = new AgentTurnGateway({ pool: [small], stateStore: new MemoryProviderStateStore() });
  const fits = await gateway.evaluate({ requiresPrivateData: false, job: 'research', estimatedInputTokens: 6000, maxOutputTokens: 4000 });
  assert.equal(fits[0].eligible, true, 'a 7K-token research call does not need 32K');
  const tooBig = await gateway.evaluate({ requiresPrivateData: false, job: 'research', estimatedInputTokens: 14_000, maxOutputTokens: 4000 });
  assert.ok(tooBig[0].reasons.includes('CONTEXT_WINDOW_TOO_SMALL'), 'never truncated silently: a larger request is refused');
  const coding = await gateway.evaluate({ requiresPrivateData: false, job: 'coding', estimatedInputTokens: 2000, maxOutputTokens: 2000 });
  assert.ok(coding[0].reasons.includes('CONTEXT_WINDOW_TOO_SMALL'), 'growing coding sessions keep their fixed floor');
});

test('C. verified qualification corrects a stale planning score — by one level, never for strict jobs', () => {
  const base = Object.freeze({ reasoning: 3, writing: 3, coding: 3, research: 3, structuredOutput: true, source: 'registry' });
  const raised = evidenceCapabilities(base, qualified(), { now: NOW });
  assert.equal(raised.reasoning, 4);
  assert.match(raised.source, /qualification/);
  assert.equal(evidenceCapabilities({ ...base, reasoning: 4 }, qualified(), { now: NOW }).reasoning, 4, 'never above 4');
  assert.equal(evidenceCapabilities(base, qualified(), { strict: true, now: NOW }).reasoning, 3, 'strict jobs: no raise');
  assert.equal(evidenceCapabilities({ ...base, coding: 4 }, qualified({ coding: false }), { now: NOW }).coding, 2, 'a failed skill caps the score');
  assert.equal(evidenceCapabilities(base, { ...qualified(), testedAt: '2026-01-01T00:00:00Z' }, { now: NOW }), base, 'stale evidence changes nothing');
});

test('D/E. routine FINANCE uses more free routes; high-risk financial judgment stays restricted', async () => {
  assert.equal(financeJob('12-month cost model, break-even month and P&L for Sanad Desk'), 'finance');
  assert.equal(financeJob('Should we raise a seed round at a 5M valuation?'), 'finance_critical');
  assert.equal(financeJob('احسب ضريبة القيمة المضافة'), 'finance_critical');
  assert.equal(stepJob(officeAgent('finance'), 'P&L for the pilot'), 'finance');
  const gateway = new AgentTurnGateway({ pool: productionPool(), stateStore: new MemoryProviderStateStore({ now: () => NOW }), now: () => NOW });
  const routine = eligibility(await gateway.evaluate({ requiresPrivateData: false, allowPaid: false, job: 'finance', estimatedInputTokens: 6000, maxOutputTokens: 4000, qualifications: PRODUCTION_QUALIFICATIONS }));
  for (const id of ['gemini:gemini-flash-lite-latest', 'gemini:gemma-4-26b-a4b-it', 'groq:openai/gpt-oss-120b', 'zhipu:glm-4.5-flash']) assert.equal(routine[id], 'OK', id);
  const critical = eligibility(await gateway.evaluate({ requiresPrivateData: false, allowPaid: false, job: 'finance_critical', estimatedInputTokens: 6000, maxOutputTokens: 4000, qualifications: PRODUCTION_QUALIFICATIONS }));
  assert.notEqual(critical['gemini:gemini-flash-lite-latest'], 'OK');
  assert.notEqual(critical['zhipu:glm-4.5-flash'], 'OK');
  assert.equal(critical['gemini:gemini-flash-latest'], 'OK');
});

test('F. a quota-exhausted route is skipped until its reset, then eligible again', async () => {
  const now = { value: NOW };
  const store = new MemoryProviderStateStore({ now: () => now.value });
  store.rows.set('gemini:gemini-flash-latest', exhausted('2026-09-29T07:00:00Z'));
  const gateway = new AgentTurnGateway({ pool: productionPool(), stateStore: store, now: () => now.value });
  const before = await gateway.evaluate({ requiresPrivateData: false, job: 'research', estimatedInputTokens: 3000, maxOutputTokens: 2000 });
  assert.ok(before.find((entry) => entry.route.id === 'gemini:gemini-flash-latest').reasons.includes('COOLDOWN_QUOTA_EXHAUSTED'));
  now.value = Date.parse('2026-09-29T07:00:01Z');
  const after = await gateway.evaluate({ requiresPrivateData: false, job: 'research', estimatedInputTokens: 3000, maxOutputTokens: 2000 });
  assert.equal(after.find((entry) => entry.route.id === 'gemini:gemini-flash-latest').eligible, true);
});

test('G/H. OpenRouter free models are ONE pool: one exhausted member rests all, and work moves to another pool without probing', async () => {
  const pool = productionPool();
  const ultra = pool.find((route) => route.id.includes('ultra'));
  const superRoute = pool.find((route) => route.id.includes('super'));
  assert.equal(capacityPool(ultra).id, 'openrouter:free');
  assert.equal(capacityPool(superRoute).id, 'openrouter:free', 'shared quota recognised');
  assert.notEqual(capacityPool(pool.find((route) => route.id === 'gemini:gemini-flash-latest')).id, capacityPool(pool.find((route) => route.id === 'gemini:gemini-flash-lite-latest')).id, 'Gemini quotas are per model');
  const store = new MemoryProviderStateStore({ now: () => NOW });
  store.rows.set(ultra.id, exhausted('2026-09-29T00:00:00Z'));
  const gateway = new AgentTurnGateway({ pool, stateStore: store, now: () => NOW });
  const view = await gateway.evaluate({ requiresPrivateData: false, job: 'research', estimatedInputTokens: 3000, maxOutputTokens: 2000 });
  const entry = view.find((candidate) => candidate.route.id === superRoute.id);
  assert.ok(entry.reasons.includes('COOLDOWN_POOL_QUOTA_EXHAUSTED'));
  assert.equal(entry.cooldownUntil, '2026-09-29T00:00:00Z');
  const summary = poolSummary(pool, store.rows, { now: NOW });
  assert.equal(summary.filter((row) => row.id === 'openrouter:free').length, 1, 'one pool, not one entry per model');
  assert.equal(summary.find((row) => row.id === 'openrouter:free').state, 'exhausted');
  assert.equal(summary.find((row) => row.id === 'openrouter:free').models.length, pool.filter((route) => route.provider === 'openrouter').length, 'every OpenRouter free model is in the one pool');
});

test('an upstream per-model rate limit rests only that model, not the whole shared pool', async () => {
  const pool = productionPool();
  const ultra = pool.find((route) => route.id.includes('ultra'));
  const store = new MemoryProviderStateStore({ now: () => NOW });
  store.rows.set(ultra.id, { health: 'rate_limited', cooldownUntil: new Date(NOW + 60_000).toISOString() });
  const gateway = new AgentTurnGateway({ pool, stateStore: store, now: () => NOW });
  // Discovered OpenRouter routes take work only once qualified (Capacity V2).
  const view = await gateway.evaluate({ requiresPrivateData: false, job: 'research', estimatedInputTokens: 3000, maxOutputTokens: 2000, qualifications: PRODUCTION_QUALIFICATIONS });
  assert.equal(view.find((entry) => entry.route.id.includes('super')).eligible, true);
});

test('I. WAITING_FOR_CAPACITY only when every eligible pool is unavailable', () => {
  const waiting = capacityDecision({ code: 'NO_ELIGIBLE_PROVIDER', evaluations: [
    { id: 'openrouter:a:free', reasons: ['COOLDOWN_POOL_QUOTA_EXHAUSTED'], cooldownUntil: '2026-09-29T00:00:00Z' },
    { id: 'gemini:gemini-flash-latest', reasons: ['COOLDOWN_QUOTA_EXHAUSTED'], cooldownUntil: '2026-09-29T07:00:00Z' },
    { id: 'deepseek:deepseek-flash', reasons: ['PAID_ROUTE_NOT_ALLOWED'] },
  ] }, { now: NOW });
  assert.equal(waiting.kind, 'wait');
  assert.equal(waiting.until, '2026-09-29T00:00:00.000Z', 'resumes at the earliest known reset');
  assert.equal(capacityDecision({ code: 'SOMETHING_ELSE' }), null, 'a successful route never waits');
});

test('J/K/L. paid fallback for normal jobs; never for free-only; confidential beats free-only', async () => {
  const pool = productionPool();
  const store = new MemoryProviderStateStore({ now: () => NOW });
  for (const route of pool) if (route.billingClass !== 'paid') store.rows.set(route.id, exhausted('2026-09-29T00:00:00Z'));
  const gateway = new AgentTurnGateway({ pool, stateStore: store, now: () => NOW });
  const normal = gateway.order(await gateway.evaluate({ requiresPrivateData: false, allowPaid: true, job: 'research', estimatedInputTokens: 3000, maxOutputTokens: 2000 }), { job: 'research' });
  assert.equal(normal[0]?.id, 'deepseek:deepseek-flash', 'policy-approved paid fallback instead of waiting');
  const freeOnly = await gateway.evaluate({ requiresPrivateData: false, allowPaid: false, job: 'research', estimatedInputTokens: 3000, maxOutputTokens: 2000 });
  assert.deepEqual(freeOnly.filter((entry) => entry.eligible).map((entry) => entry.route.id), [], 'free-only never reaches paid');
  store.rows.clear();
  const confidential = await gateway.evaluate({ requiresPrivateData: true, allowPaid: false, job: 'research', estimatedInputTokens: 3000, maxOutputTokens: 2000 });
  assert.deepEqual(confidential.filter((entry) => entry.eligible).map((entry) => entry.route.id), [], 'no free route is approved for private data');
  assert.ok(confidential.filter((entry) => entry.route.billingClass !== 'paid').every((entry) => entry.reasons.includes('PRIVACY_NOT_APPROVED')));
});

test('M. the web-search circuit breaker stops repeated calls and hides web_search while open', async () => {
  searchBreaker.reset();
  let calls = 0;
  const failing = async () => { calls += 1; throw Object.assign(new Error('429'), { code: 'SEARCH_RATE_LIMITED', status: 429 }); };
  for (let index = 0; index < 3; index += 1) await createOfficeToolExecutor({ search: failing })({ name: 'web_search', arguments: { query: 'q' } });
  assert.equal(calls, 3);
  assert.equal(searchBreaker.status().state, 'SEARCH_DEGRADED');
  assert.ok(!officeWebTools().some((tool) => tool.name === 'web_search'), 'not offered to the model');
  const fourth = await createOfficeToolExecutor({ search: failing })({ name: 'web_search', arguments: { query: 'q' } });
  assert.equal(calls, 3, 'the provider is not called while the breaker is open');
  assert.equal(fourth.result.error, 'SEARCH_DEGRADED');
  searchBreaker.reset();
  await createOfficeToolExecutor({ search: async () => ({ sources: [] }) })({ name: 'web_search', arguments: { query: 'q' } });
  assert.equal(searchBreaker.status().state, 'OK');
});

test('N. FINANCE gets web tools only for current external facts', () => {
  const finance = officeAgent('finance');
  assert.equal(stepWebTools(finance, true, '12-month model: setup AED 30,000, running AED 6,000/month, 8 clinics/month, 3% churn'), false);
  assert.equal(stepWebTools(finance, true, 'Compare against current market price of clinic software in the UAE'), true);
  assert.equal(stepWebTools(officeAgent('research'), true, 'anything'), true);
  assert.equal(stepWebTools(finance, false, 'market price'), false, 'never without authorised tools');
});

test('O. CI and deploy status are controller-side only: the model has no polling tool', () => {
  const names = modelToolSpecs({ supabase: true }).map((tool) => tool.name);
  assert.ok(!names.some((name) => /ci_status|ci|deploy/i.test(name)), names.join(','));
});

test('P. handoff packets keep facts, decisions and artifacts and drop bulk', () => {
  const output = `## Summary\nPilot model done.\n\n## Work\n${'Detailed narrative. '.repeat(400)}\n\n## Validated figures (calculated by code)\n- Year revenue: AED 112,236 (VERIFIED)\n- Break-even: month 12\n\n## Handoff\nAUDIT: check churn.\n\n## Decisions for Fahad\nApprove the AED 30,000 setup budget.\n\`\`\`artifact\n{"type":"table","title":"Costs","columns":["a"],"rows":[["1"]]}\n\`\`\`\n`;
  const packet = handoffPacket(output);
  for (const needed of ['AED 112,236', 'month 12', 'AUDIT: check churn', 'Approve the AED 30,000', '"type":"table"', 'Pilot model done']) assert.ok(packet.includes(needed), needed);
  assert.ok(packet.length < output.length * 0.6, `${packet.length} vs ${output.length}`);
  assert.ok(upstreamBlock([{ agent_slug: 'business-finance', title: 'Model', content: output }]).length > packet.length, 'AUDIT still receives full outputs');
});

test('Q. owner-facing TOTAL MODEL USAGE reconciles successful, failed, cached and reasoning tokens', () => {
  const usage = modelUsage([
    { task_id: 't1', status: 'succeeded', input_tokens: 1000, output_tokens: 200, cached_input_tokens: 800, reasoning_tokens: 50, cost_usd: 0.001, attempt_no: 1 },
    { task_id: 't1', status: 'succeeded', input_tokens: 1500, output_tokens: 300, cost_usd: 0, attempt_no: 1 },
    { task_id: 't2', status: 'failed', input_tokens: 0, output_tokens: 0, attempt_no: 2 },
    { task_id: 't2', status: 'failed', input_tokens: 400, output_tokens: 0, attempt_no: 1 },
  ]);
  assert.equal(usage.totalTokens, 3400);
  assert.equal(usage.totalTokens, usage.successful.inputTokens + usage.successful.outputTokens + usage.failed.inputTokens + usage.failed.outputTokens);
  assert.equal(usage.cachedInputTokens, 800, 'part of input, not added again');
  assert.equal(usage.reasoningTokens, 50);
  assert.deepEqual([usage.successful.calls, usage.failed.calls, usage.retries, usage.toolLoopCalls], [2, 2, 1, 1]);
});

test('lower-tier fallback only for low-risk jobs; scarce pools go last for low-value work', async () => {
  assert.equal(relaxedJob('content').min.writing, 2);
  for (const job of ['finance', 'finance_critical', 'synthesis', 'orchestration', 'research', 'coding', 'qa_security']) assert.equal(relaxedJob(job), null, job);
  const gateway = new AgentTurnGateway({ pool: productionPool(), stateStore: new MemoryProviderStateStore({ now: () => NOW }), now: () => NOW });
  const content = gateway.order(await gateway.evaluate({ requiresPrivateData: false, job: 'content', estimatedInputTokens: 2000, maxOutputTokens: 2000, allowPaid: false, qualifications: PRODUCTION_QUALIFICATIONS }), { job: 'content', qualifications: PRODUCTION_QUALIFICATIONS });
  const scarceIndex = content.findIndex((route) => capacityPool(route).scarce);
  assert.ok(scarceIndex > 0 && content.slice(0, scarceIndex).every((route) => !capacityPool(route).scarce), 'abundant pools first for SOCIAL-type work');
  const synthesis = gateway.order(await gateway.evaluate({ requiresPrivateData: false, job: 'synthesis', estimatedInputTokens: 6000, maxOutputTokens: 8000, allowPaid: false, qualifications: PRODUCTION_QUALIFICATIONS }), { job: 'synthesis', qualifications: PRODUCTION_QUALIFICATIONS });
  assert.ok(synthesis.length && capacityPool(synthesis[0]).scarce, 'high-value synthesis may use the scarce strong pools first');
});

test('Coding turn budget: compact and re-plan, then finish or escalate — never a hard failure', () => {
  assert.equal(taskSize('Document formatRouteId with a JSDoc comment'), 'small');
  assert.equal(taskSize('Add parseRouteId helper for Model Pool route ids'), 'medium');
  assert.equal(taskSize('Refactor the provider integration across the codebase'), 'large');
  assert.equal(turnBudgetAction(10, 'small', {}), null);
  assert.equal(turnBudgetAction(18, 'small', {}).action, 'replan');
  assert.equal(turnBudgetAction(20, 'small', { replan: 18 }), null, 'once per threshold');
  assert.equal(turnBudgetAction(36, 'small', { replan: 18 }).action, 'escalate');
});

test('Mistral is ready but inactive without an owner key; public data only unless approved', () => {
  const idle = createModelPool({ env: {} }).find((route) => route.provider === 'mistral');
  assert.ok(idle.unavailableReasons.includes('CREDENTIAL_MISSING'));
  assert.equal(idle.billingClass, 'paid', 'no free quota is claimed by default');
  const ready = createModelPool({ env: { MISTRAL_API_KEY: KEY, MISTRAL_BILLING_CLASS: 'free' } }).find((route) => route.provider === 'mistral');
  assert.deepEqual(ready.unavailableReasons, []);
  assert.equal(ready.billingClass, 'free');
  assert.equal(ready.privacyApproved, false, 'public/non-private data only');
  assert.equal(ready.capacityPool.id, 'mistral:account');
  assert.equal(ready.capabilities.reasoning, 4);
});

test('SANAD REPLAY: OpenRouter pool and Gemini Flash exhausted — FINANCE continues on another qualified free route instead of waiting', async () => {
  const served = [];
  const fetchFn = async (url, init) => {
    served.push(String(url));
    if (String(url).includes('openrouter')) return new Response(JSON.stringify({ error: { message: 'Rate limit exceeded: free-models-per-day', code: 429 } }), { status: 429, headers: { 'content-type': 'application/json' } });
    if (String(url).includes('generativelanguage')) {
      if (String(url).includes('gemini-flash-latest')) return new Response(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota per day' } }), { status: 429, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '## Summary\nModel ready.' }] } }], usageMetadata: { promptTokenCount: 6000, candidatesTokenCount: 900 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '## Summary\nModel ready.' } }], usage: { prompt_tokens: 6000, completion_tokens: 900 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const pool = productionPool(fetchFn);
  const store = new MemoryProviderStateStore({ now: () => NOW });
  // The state production had at 07:25 UTC on 2026-09-28.
  store.rows.set('openrouter:nvidia/nemotron-3-ultra-550b-a55b:free', exhausted('2026-09-29T00:00:00Z'));
  store.rows.set('openrouter:nvidia/nemotron-3-super-120b-a12b:free', exhausted('2026-09-29T00:00:00Z'));
  store.rows.set('gemini:gemini-flash-latest', exhausted('2026-09-29T07:00:00Z'));
  const gateway = new AgentTurnGateway({ pool, stateStore: store, now: () => NOW, sleepFn: async () => {} });
  const routing = { requiresPrivateData: false, allowPaid: false, job: financeJob('12-month cash model for Sanad Desk: setup AED 30,000, running AED 6,000/month, break-even month'), estimatedInputTokens: 6000, qualifications: PRODUCTION_QUALIFICATIONS };
  assert.equal(routing.job, 'finance');
  const result = await gateway.turn({ tools: [], maxOutputTokens: 4000, routing,
    prepare: async () => ({ system: 'FINANCE', messages: [{ role: 'user', content: [{ type: 'text', text: 'Sanad Desk model' }] }] }) });
  assert.equal(result.route.billingClass, 'free');
  assert.ok(!/openrouter|gemini-flash-latest/.test(result.route.id), `continued on ${result.route.id}`);
  assert.ok(!served.some((url) => url.includes('openrouter')), 'the exhausted OpenRouter pool was not probed');
  assert.ok(!served.some((url) => url.includes('gemini-flash-latest')), 'the exhausted Gemini Flash quota was not probed');
});
