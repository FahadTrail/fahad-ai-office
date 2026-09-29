// Capacity V2 Parts 17, 22–26: effective free capacity per job class, coding
// jobs/day, projects/day, /api/capacity v2, owner action queue, snapshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { capacityModel, MEASURED_JOB_TOKENS, poolDailyTokens, routeClasses } from '../src/model-gateway/agentic/capacity-model.js';
import { poolFacts, requiredDataClass } from '../src/model-gateway/agentic/pool-registry.js';
import { ownerActions } from '../src/model-gateway/agentic/owner-actions.js';
import { CapacitySnapshotter, snapshotSummary } from '../src/model-gateway/agentic/capacity-snapshots.js';
import { CODING_SUITE_VERSION } from '../src/model-gateway/agentic/coding-qualification.js';
import { QUALIFICATION_SUITE_VERSION } from '../src/model-gateway/agentic/qualification.js';
import { capacityPool } from '../src/model-gateway/agentic/capacity-pools.js';

const KEY = 'test-key-1234567890abcdef';
const now = Date.parse('2026-09-29T12:00:00Z');
const at = new Date(now - 3600_000).toISOString();
const ALL_SKILLS = { instruction: true, structured: true, reasoning: true, coding: true, writing: true, reading: true, tools: true };
const generalRecord = (status = 'qualified', skills = ALL_SKILLS) => ({ suiteVersion: QUALIFICATION_SUITE_VERSION, status, testedAt: at, skills });
const codingRecord = (grade) => ({ suiteVersion: CODING_SUITE_VERSION, status: 'qualified', grade, testedAt: at });

const route = (id, extra = {}) => ({
  id, provider: id.split(':')[0], model: id.split(':').slice(1).join(':'), billingClass: 'free', unavailableReasons: [],
  capabilities: { reasoning: 4, coding: 4, research: 4 }, contextWindow: 128_000, ...extra,
});

test('pool allowance: published tokens, requests × measured size (ESTIMATED), UNKNOWN never invented, one-time is zero', () => {
  assert.deepEqual(poolDailyTokens(poolFacts({ id: 'groq:x', account: 'groq' })).perDay, 200_000);
  const openrouter = poolDailyTokens(poolFacts({ id: 'openrouter:free', account: 'openrouter' }), { measuredTokensPerRequest: 4_000 });
  assert.equal(openrouter.perDay, 200_000);
  assert.match(openrouter.basis, /ESTIMATED — 50 requests\/day \(PUBLISHED\) × measured 4000/);
  assert.equal(poolDailyTokens(poolFacts({ id: 'zhipu:free', account: 'zhipu' })).perDay, null);
  assert.equal(poolDailyTokens(poolFacts({ id: 'cerebras:free', account: 'cerebras' })).perDay, 0);
  assert.equal(poolDailyTokens(poolFacts({ id: 'llm7:free', account: 'llm7' })).perDay, 1_000_000);
});

test('job classes come from evidence: discovered routes need a pass, failed routes take nothing, coding needs grade + privacy', () => {
  const established = route('groq:m');
  const discovered = route('llm7:m', { requiresQualification: true, dataClass: 'PUBLIC' });
  const normal = route('ollama:m', { requiresQualification: true, dataClass: 'NORMAL' });
  const qualifications = Object.assign(new Map([
    ['llm7:m', generalRecord()], ['ollama:m', generalRecord()], ['groq:bad', generalRecord('failed')],
  ]), { coding: new Map([['ollama:m', codingRecord('CODING_SECONDARY')], ['llm7:m', codingRecord('CODING_PRIMARY')]]) });
  assert.deepEqual([...routeClasses(established, new Map(), { now })], ['general'], 'established route: general only without evidence');
  assert.deepEqual([...routeClasses(route('llm7:new', { requiresQualification: true }), qualifications, { now })], [], 'discovered, untested: nothing');
  assert.deepEqual([...routeClasses(route('groq:bad'), qualifications, { now })], [], 'failed qualification: nothing');
  assert.ok(!routeClasses(discovered, qualifications, { now }).has('coding'), 'PUBLIC route never gets private code');
  assert.ok(routeClasses(discovered, qualifications, { now, codingDataClass: 'PUBLIC' }).has('coding'), 'public repository: allowed');
  assert.ok(!routeClasses(normal, qualifications, { now }).has('coding'), 'NORMAL route without the owner flag: no private code');
  assert.ok(routeClasses({ ...normal, privacyApproved: true }, qualifications, { now }).has('coding'), 'owner-approved: private code allowed');
  assert.ok(routeClasses(discovered, qualifications, { now }).has('strong_reasoning'));
});

test('capacity model: per-class tokens, coding jobs/day by grade, projects/day free-only vs free-first, health and success rate', () => {
  const routes = [
    route('llm7:a', { requiresQualification: true, dataClass: 'PUBLIC', quotaPool: 'llm7:free' }),
    route('ollama:b', { requiresQualification: true, dataClass: 'NORMAL', privacyApproved: true, quotaPool: 'ollama:cloud' }),
    route('groq:c'),
    route('zhipu:d'),
    { ...route('anthropic:paid'), billingClass: 'paid' },
  ];
  const pools = routes.filter((entry) => entry.billingClass !== 'paid').map((entry) => ({ id: capacityPool(entry).id, state: entry.id === 'groq:c' ? 'exhausted' : 'available' }));
  const qualifications = Object.assign(new Map([['llm7:a', generalRecord()], ['ollama:b', generalRecord()], ['groq:c', generalRecord()]]), {
    coding: new Map([['llm7:a', codingRecord('CODING_PRIMARY')], ['ollama:b', codingRecord('CODING_SECONDARY')]]),
  });
  const llm7Pool = capacityPool(routes[0]).id;
  const attempts = new Map([[llm7Pool, [
    ...Array.from({ length: 8 }, () => ({ status: 'succeeded', input_tokens: 3_000, output_tokens: 500 })),
    ...Array.from({ length: 2 }, () => ({ status: 'failed', input_tokens: 0, output_tokens: 0 })),
  ]]]);
  const model = capacityModel({
    routes, pools, qualifications, now, attemptsByPool: attempts,
    paid: { routeId: 'deepseek:deepseek-flash', pricing: { inputPerMillion: 0.3, cachedInputPerMillion: 0.006, outputPerMillion: 1.2 }, remainingUsd: 1.5, daysLeftInMonth: 2 },
  });
  const byId = Object.fromEntries(model.pools.map((pool) => [pool.id, pool]));
  assert.equal(byId[llm7Pool].successRate, 0.8);
  assert.equal(byId[llm7Pool].effectivePerDay, 800_000, '1M/day × 80% measured success');
  assert.equal(byId['groq:c'].effectiveToday, 0, 'exhausted today');
  assert.equal(byId['groq:c'].effectivePerDay, 200_000, 'but counts per day');
  assert.equal(byId['zhipu:free'].effectivePerDay, null);
  assert.deepEqual(model.unknownAllowancePools, ['zhipu:free', capacityPool(routes[1]).id].toSorted());
  // General: llm7 800K + groq 200K (ollama and zhipu are UNKNOWN, not summed).
  assert.equal(model.perClass.general.tokensPerDay, 1_000_000);
  assert.equal(model.perClass.general.unknownPools, 2);
  assert.equal(model.perClass.general.tokensPerMonth, 30_000_000);
  // Coding (private by default): only the owner-approved ollama route, whose allowance is UNKNOWN.
  assert.equal(model.perClass.coding.tokensPerDay, 0);
  assert.equal(model.perClass.coding.pools, 1);
  assert.equal(model.codingJobsPerDay.small.jobsPerDay, 0);
  // Public repositories: llm7 (PRIMARY) counts.
  const publicModel = capacityModel({ routes, pools, qualifications, now, attemptsByPool: attempts, codingDataClass: 'PUBLIC' });
  assert.equal(publicModel.codingJobsPerDay.small.jobsPerDay, Math.floor(800_000 / MEASURED_JOB_TOKENS.coding.small));
  assert.equal(publicModel.codingJobsPerDay.large.jobsPerDay, 0, '800K/day is below one large job');
  // The default (private) model reports PUBLIC coding capacity separately.
  assert.deepEqual(model.publicCodingJobsPerDay, publicModel.codingJobsPerDay);
  assert.equal(model.perClass.coding_public.tokensPerDay, 800_000);
  assert.equal(model.perClass.coding_public.unknownPools, 1, 'ollama counts as a pool with an UNKNOWN allowance');
  assert.equal(model.publicCodingJobsPerDay.small.unknownPools, 1);
  assert.equal(model.projectsPerDay.freeOnly.p50, Math.floor(1_000_000 / 65_000));
  assert.ok(model.projectsPerDay.freeFirstWithPaidFallback.p50 > model.projectsPerDay.freeOnly.p50);
  assert.equal(model.projectsPerDay.freeFirstWithPaidFallback.paidUsdPerDay, 0.75);
  assert.ok(!model.pools.some((pool) => pool.id.startsWith('anthropic')), 'paid routes are not free pools');
});

test('/api/capacity v2 fields: capacity per class, coding jobs, projects, paid fallback, cost, lifecycle, owner actions', async () => {
  const { capacityView } = await import('../src/hub-capacity.js');
  const { memoryPostgrest } = await import('../testing/fixtures/memory-postgrest.js');
  const db = memoryPostgrest({
    provider_status: [],
    model_attempts: [{ provider: 'groq', model: 'openai/gpt-oss-120b', status: 'succeeded', input_tokens: 3000, output_tokens: 500, cost_usd: 0, attempt_no: 1, task_id: 't1', started_at: at }],
    workspace_policies: [{ monthly_budget_usd: 2, spent_usd: 0.5, reserved_usd: 0 }],
    provider_canary_runs: [],
  });
  const view = await capacityView({ db, now, env: { GROQ_API_KEY: KEY, DEEPSEEK_API_KEY: KEY, DEEPSEEK_API_TRAINING_OPTOUT_VERIFIED: 'true', LLM7_API_KEY: KEY } });
  const capacity = view.capacity;
  for (const field of ['freeTokensPerDay', 'freeTokensPerMonth', 'coding', 'strongReasoning', 'research', 'finance', 'projectsPerDay', 'healthyPools', 'exhaustedPools', 'nextReset', 'freeUtilizationToday', 'paidFallback', 'costUsd', 'lifecycle', 'unknownAllowancePools']) {
    assert.ok(field in capacity, field);
  }
  assert.ok(capacity.freeTokensPerDay > 0);
  assert.equal(capacity.coding.dataClass, 'PRIVATE');
  assert.equal(capacity.publicCoding.dataClass, 'PUBLIC', 'public-repository coding capacity is reported separately');
  assert.ok(capacity.publicCoding.jobsPerDay.small);
  assert.equal(capacity.paidFallback.route, 'deepseek:deepseek-flash');
  assert.equal(capacity.paidFallback.silent, false);
  assert.equal(capacity.paidFallback.remainingUsd, 1.5);
  assert.equal(capacity.freeUtilizationToday, Number((3500 / capacity.freeTokensPerDay).toFixed(4)));
  assert.ok(view.ownerActions.find((action) => action.id === 'llm7-key').status === 'done');
  assert.ok(view.ownerActions.find((action) => action.id === 'mistral-key').status === 'pending');
  assert.ok(!JSON.stringify(view).includes(KEY), 'no credential in the response');
});

test('owner action queue: presence-only status, safe set-secret commands, never a key in chat, pending first', () => {
  const actions = ownerActions({ env: { MISTRAL_API_KEY: KEY, OLLAMA_API_PRIVATE_DATA_APPROVED: 'true' }, now });
  assert.equal(actions.at(-1).status, 'done');
  assert.ok(actions.findIndex((action) => action.status === 'done') > actions.findIndex((action) => action.status === 'pending'));
  assert.equal(actions.find((action) => action.id === 'mistral-key').status, 'done');
  assert.equal(actions.find((action) => action.id === 'privacy-review').status, 'done');
  assert.equal(actions.find((action) => action.id === 'openrouter-credit').status, 'optional');
  const text = JSON.stringify(actions);
  assert.ok(!text.includes(KEY));
  assert.ok(!/paste/i.test(text));
  for (const action of actions) for (const step of action.steps) if (/set-secret/.test(step)) assert.match(step, /sudo bash ops\/set-secret\.sh [A-Z_]+/);
  assert.match(actions.find((action) => action.id === 'opencode-key').steps.join(' '), /DISABLE auto-reload/);
});

test('data class requirement fails closed: unknown classes become PRIVATE', () => {
  assert.equal(requiredDataClass({ dataClass: 'general' }), 'PRIVATE');
  assert.equal(requiredDataClass({ dataClass: 'public' }), 'PUBLIC');
  assert.equal(requiredDataClass({ dataClass: 'NORMAL' }), 'NORMAL');
  assert.equal(requiredDataClass({ requiresPrivateData: false }), 'PUBLIC');
  assert.equal(requiredDataClass({}), 'PRIVATE');
});

test('capacity snapshots: one per UTC day, metadata only, off when the table is missing, retried later on other errors', async () => {
  const writes = [];
  let clock = now;
  const view = { capacity: { freeTokensPerDay: 5, coding: { tokensPerDay: 0, jobsPerDay: { small: { jobsPerDay: 0 } } }, publicCoding: { tokensPerDay: 9, jobsPerDay: { small: { jobsPerDay: 3 } } }, pools: [{ id: 'p', state: 'available', effectivePerDay: 5, classes: ['general'], codingGrade: 'NOT_CODING_APPROVED', allowance: {} }] }, ownerActions: [{ id: 'x', status: 'pending' }] };
  let failure = null;
  const db = { from: () => ({ upsert: async (row) => { if (failure) return { error: failure }; writes.push(row); return { error: null }; } }) };
  const snapshotter = new CapacitySnapshotter({ db, capacityView: async () => view, now: () => clock });
  assert.equal(snapshotter.maybeRun(), true); await snapshotter.active;
  assert.equal(snapshotter.maybeRun(), false, 'same day: no second write');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].snapshot_date, '2026-09-29');
  assert.deepEqual(writes[0].summary.codingJobsPerDay, { small: 0 });
  assert.deepEqual(writes[0].summary.publicCodingJobsPerDay, { small: 3 });
  assert.deepEqual(writes[0].summary.ownerActionsPending, ['x']);
  assert.ok(!('allowance' in writes[0].summary.pools[0]));
  clock += 86_400_000;
  failure = { code: '42501', message: 'permission denied' };
  snapshotter.maybeRun(); await snapshotter.active;
  assert.equal(snapshotter.maybeRun(), false, 'waits an hour after an error');
  clock += 3_600_001; failure = { code: 'PGRST205', message: "Could not find the table 'public.capacity_snapshots' in the schema cache" };
  snapshotter.maybeRun(); await snapshotter.active;
  assert.equal(snapshotter.disabled, true);
  assert.equal(snapshotSummary({}).freeTokensPerDay, null);
});

test('capacity_snapshots migration is additive, RLS on, service role only', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20261003090000_capacity_snapshots.sql', import.meta.url), 'utf8');
  assert.match(sql, /create table public\.capacity_snapshots/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on table public\.capacity_snapshots from public, anon, authenticated, service_role/);
  assert.match(sql, /grant select, insert, update, delete on table public\.capacity_snapshots to service_role/);
  assert.ok(!/\b(drop|truncate|delete from)\b/i.test(sql.replace(/grant select, insert, update, delete/i, '')), 'no destructive statement');
});

test('/api/capacity: a blocked paid account is never the fallback; stored snapshots come back as history', async () => {
  const { capacityView } = await import('../src/hub-capacity.js');
  const { memoryPostgrest } = await import('../testing/fixtures/memory-postgrest.js');
  const db = memoryPostgrest({
    provider_status: [{ provider: 'qwen', model: 'qwen3.8-flash', health: 'auth_error', cooldown_until: '2026-09-26T19:27:45Z', rate_limit: null }],
    model_attempts: [],
    workspace_policies: [{ monthly_budget_usd: 2, spent_usd: 0.5, reserved_usd: 0 }],
    provider_canary_runs: [],
    capacity_snapshots: [{ snapshot_date: '2026-09-29', taken_at: at, summary: { freeTokensPerDay: 3_122_007, coding: { tokensPerDay: 0 }, codingJobsPerDay: { small: 0 }, independentFreePools: 12, healthyPools: 11 } }],
  });
  const env = { GROQ_API_KEY: KEY, QWEN_API_KEY: KEY, QWEN_API_PRIVATE_DATA_APPROVED: 'true', DEEPSEEK_API_KEY: KEY, DEEPSEEK_API_TRAINING_OPTOUT_VERIFIED: 'true' };
  const view = await capacityView({ db, now, env });
  assert.equal(view.capacity.paidFallback.route, 'deepseek:deepseek-flash', 'qwen (auth_error) is skipped even though it is cheaper');
  assert.equal(view.capacity.history.length, 1);
  assert.equal(view.capacity.history[0].freeTokensPerDay, 3_122_007);
  assert.equal(view.capacity.history[0].independentFreePools, 12);
});

test('free routes that never succeed, or succeed under 20% over ≥20 attempts, are demoted; paid routes and small samples are not', async () => {
  const { AgentTurnGateway } = await import('../src/model-gateway/agentic/turn-gateway.js');
  const { MemoryProviderStateStore } = await import('../src/model-gateway/agentic/provider-state.js');
  const mk = (id, billingClass = 'free') => ({ id, provider: id.split(':')[0], model: id.split(':')[1], billingClass, qualityTier: 5, contextWindow: 128_000, unavailableReasons: [], capabilities: { reasoning: 4, toolCalling: true, contextWindow: 128_000 }, protocolClient: {}, pricing: billingClass === 'paid' ? { inputPerMillion: 1, outputPerMillion: 1 } : null });
  const routes = [mk('free:dead'), mk('free:flaky'), mk('free:good'), mk('free:new'), mk('paid:dead', 'paid')];
  const stateStore = new MemoryProviderStateStore();
  stateStore.rows.set('free:dead', { requests: 0, failures: 41 });
  stateStore.rows.set('free:flaky', { requests: 3, failures: 24 });
  stateStore.rows.set('free:good', { requests: 152, failures: 6 });
  stateStore.rows.set('free:new', { requests: 0, failures: 5 });
  stateStore.rows.set('paid:dead', { requests: 0, failures: 30 });
  const gateway = new AgentTurnGateway({ pool: routes, stateStore, minQualityTier: 1 });
  const reasons = Object.fromEntries((await gateway.evaluate({ requiresPrivateData: false, estimatedInputTokens: 500, maxOutputTokens: 500 })).map((entry) => [entry.route.id, entry.reasons]));
  assert.ok(reasons['free:dead'].includes('NEVER_SUCCEEDED'));
  assert.ok(reasons['free:flaky'].includes('LOW_SUCCESS_RATE'));
  assert.ok(!reasons['free:good'].some((reason) => /SUCCEED|SUCCESS/.test(reason)));
  assert.ok(!reasons['free:new'].some((reason) => /SUCCEED|SUCCESS/.test(reason)), 'small sample: not judged');
  assert.ok(!reasons['paid:dead'].some((reason) => /SUCCEED|SUCCESS/.test(reason)), 'paid routes are governed by budget and health, not this rule');
});

test('a coding grade on a route whose per-minute token limit is below one coding turn does not count as coding capacity', () => {
  const qualifications = Object.assign(new Map([['groq:m', generalRecord()]]), { coding: new Map([['groq:m', codingRecord('CODING_SECONDARY')]]) });
  assert.ok(!routeClasses(route('groq:m', { requestTokenLimit: 8_000 }), qualifications, { now, codingDataClass: 'PUBLIC' }).has('coding'));
  assert.ok(routeClasses(route('groq:m'), qualifications, { now, codingDataClass: 'PUBLIC' }).has('coding'));
});

test('every owner action states card, phone, auto-reload risk, secret name and whether the adapter is ready', () => {
  for (const action of ownerActions({ env: {}, now })) {
    for (const field of ['card', 'phone', 'autoReloadRisk', 'secretEnv', 'adapterReady', 'freeQuota', 'codingValue', 'privacyClass', 'setupMinutes']) {
      assert.ok(field in action.facts, `${action.id}: ${field}`);
    }
  }
  assert.match(ownerActions({ env: {}, now }).find((action) => action.id === 'opencode-key').facts.autoReloadRisk, /^YES/);
  assert.match(ownerActions({ env: {}, now }).find((action) => action.id === 'mistral-key').facts.freeQuota, /not counted until a live canary/);
});
