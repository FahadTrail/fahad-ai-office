import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gradeCombined, gradeToolAnswer, qualifyRoute, qualificationGaps, evidenceScore, qualificationCandidates,
  AutoQualifier, MemoryQualificationStore, QUALIFICATION_SUITE_VERSION,
} from '../src/model-gateway/agentic/qualification.js';
import { AgentTurnGateway } from '../src/model-gateway/agentic/turn-gateway.js';
import { MemoryProviderStateStore } from '../src/model-gateway/agentic/provider-state.js';
import { capabilityProfile } from '../src/model-gateway/agentic/capabilities.js';

const GOOD = JSON.stringify({ echo: 'BLUE-HARBOR-42', total: 36, code: 10, tagline: 'Fresh bread every morning', city: 'Porto' });

function model({ combined = GOOD, callsTool = true, toolAnswer = '29', fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async turn(input) {
      calls.push(input);
      if (fail) throw fail;
      const usage = { inputTokens: 50, outputTokens: 20, costUsd: 0 };
      if (!input.tools.length) return { message: { role: 'assistant', content: [{ type: 'text', text: combined }] }, usage, model: input.model };
      const hasResult = input.messages.some((message) => message.content.some((block) => block.type === 'tool_result'));
      if (!hasResult) {
        return callsTool
          ? { message: { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'lookup_price', arguments: { item: 'widget' } }] }, usage, model: input.model }
          : { message: { role: 'assistant', content: [{ type: 'text', text: '29' }] }, usage, model: input.model };
      }
      return { message: { role: 'assistant', content: [{ type: 'text', text: toolAnswer }] }, usage, model: input.model };
    },
  };
}

function route(id, client, overrides = {}) {
  const [provider, ...rest] = id.split(':');
  const definition = { id, provider, model: rest.join(':'), billingClass: 'free', qualityTier: 4, costTier: 1, contextWindow: 128_000, privacyApproved: false, pricing: null, toolCalling: true, ...overrides };
  return { ...definition, capabilities: capabilityProfile(definition, {}), unavailableReasons: [], protocolClient: client };
}

test('the suite is graded deterministically, skill by skill', () => {
  assert.deepEqual(gradeCombined(GOOD), { structured: true, instruction: true, reasoning: true, coding: true, writing: true, reading: true });
  const fenced = gradeCombined('```json\n' + GOOD + '\n```');
  assert.equal(fenced.structured, true, 'fenced JSON still parses');
  assert.equal(fenced.instruction, false, 'but the "JSON only" instruction was not followed');
  const wrong = gradeCombined(JSON.stringify({ echo: 'blue-harbor-42', total: '$36', code: 12, tagline: 'The best bakery in the whole wide world forever and ever', city: 'Lyon' }));
  assert.deepEqual(wrong, { structured: true, instruction: false, reasoning: true, coding: false, writing: false, reading: false });
  assert.equal(gradeCombined('I think the answer is 36').structured, false);
  assert.equal(gradeToolAnswer('$29.00'), true);
  assert.equal(gradeToolAnswer('7.25'), false);
});

test('qualifyRoute runs 3 small $0 calls and records evidence, or an error that is retried later', async () => {
  const good = model();
  const result = await qualifyRoute(route('groq:qwen/qwen3.8-27b', good));
  assert.equal(result.status, 'qualified');
  assert.equal(result.passed, 7);
  assert.equal(result.suiteVersion, QUALIFICATION_SUITE_VERSION);
  assert.equal(good.calls.length, 3);
  const noTools = await qualifyRoute(route('x:no-tools', model({ callsTool: false })));
  assert.equal(noTools.skills.tools, false);
  const limited = await qualifyRoute(route('x:limited', model({ fail: Object.assign(new Error('x'), { status: 429, code: 'PROVIDER_RATE_LIMIT' }) })));
  assert.equal(limited.status, 'error');
  assert.equal(limited.errorCode, 'PROVIDER_RATE_LIMIT');
  const billed = { async turn(input) { return { message: { role: 'assistant', content: [{ type: 'text', text: GOOD }] }, usage: { reportedCostUsd: 0.01 }, model: input.model }; } };
  const guarded = await qualifyRoute(route('x:billed', billed));
  assert.equal(guarded.status, 'error', 'the free-route guard also protects qualification calls');
  assert.equal(guarded.incident, 'paid_on_free_route');
});

test('evidence gates jobs: failed skills rule a free model out; critical jobs need a pass; paid routes are unaffected', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const record = (skills, status = 'qualified') => ({ suiteVersion: QUALIFICATION_SUITE_VERSION, testedAt: new Date(now - 3600_000).toISOString(), status, skills });
  const all = { instruction: true, structured: true, reasoning: true, coding: true, writing: true, reading: true, tools: true };
  const qualifications = new Map([
    ['a:good', record(all)],
    ['b:notools', record({ ...all, tools: false })],
    ['c:weak', record({ ...all, reasoning: false, writing: false, coding: false }, 'partial')],
  ]);
  const free = (id) => ({ id, billingClass: 'free' });
  assert.deepEqual(qualificationGaps(free('a:good'), 'synthesis', qualifications, now), []);
  assert.deepEqual(qualificationGaps(free('b:notools'), 'research', qualifications, now), ['QUALIFICATION_FAILED_TOOLS']);
  assert.deepEqual(qualificationGaps(free('b:notools'), 'content', qualifications, now), []);
  assert.deepEqual(qualificationGaps(free('c:weak'), 'synthesis', qualifications, now), ['QUALIFICATION_FAILED_REASONING', 'QUALIFICATION_FAILED_WRITING', 'NOT_QUALIFIED_FOR_CRITICAL_JOB']);
  assert.deepEqual(qualificationGaps(free('d:untested'), 'synthesis', qualifications, now), ['NOT_YET_QUALIFIED']);
  assert.deepEqual(qualificationGaps(free('d:untested'), 'content', qualifications, now), [], 'untested models may still do non-critical work');
  assert.deepEqual(qualificationGaps({ id: 'p:paid', billingClass: 'paid' }, 'synthesis', qualifications, now), []);
  const stale = new Map([['a:good', { ...record(all), testedAt: new Date(now - 40 * 24 * 3600_000).toISOString() }]]);
  assert.deepEqual(qualificationGaps(free('a:good'), 'finance', stale, now), ['NOT_YET_QUALIFIED'], 'evidence expires');
});

test('free routing is job-specific and evidence-based, not one universal ranking', async () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const stamp = { suiteVersion: QUALIFICATION_SUITE_VERSION, testedAt: new Date(now - 60_000).toISOString(), status: 'qualified' };
  const writer = route('w:writer', model(), { capabilities: undefined });
  const tooler = route('t:tooler', model());
  const qualifications = new Map([
    ['w:writer', { ...stamp, skills: { instruction: true, structured: true, reasoning: true, coding: false, writing: true, reading: true, tools: false } }],
    ['t:tooler', { ...stamp, skills: { instruction: true, structured: true, reasoning: true, coding: true, writing: false, reading: true, tools: true } }],
  ]);
  const gateway = new AgentTurnGateway({ pool: [route('w:writer', model()), tooler], stateStore: new MemoryProviderStateStore({ now: () => now }), now: () => now });
  const order = async (job) => gateway.order(await gateway.evaluate({ requiresPrivateData: false, job, qualifications }), { job, qualifications, strategy: 'economy' }).map((entry) => entry.id);
  assert.deepEqual(await order('content'), ['w:writer'], 'the model that failed writing is not offered content');
  assert.deepEqual(await order('research'), ['t:tooler'], 'the model that failed tools is not offered research at all');
  assert.equal(writer.id, 'w:writer');
  const state = new MemoryProviderStateStore({ now: () => now });
  for (let index = 0; index < 5; index += 1) await state.recordSuccess(route('t:tooler', null), { usage: {} });
  assert.ok(evidenceScore({ route: { id: 't:tooler' }, state: (await state.snapshot()).get('t:tooler') }, 'research', qualifications, now) > 1, 'reliability adds to evidence');
});

test('the background qualifier absorbs new free routes, respects cooldowns and the shared OpenRouter allowance', async () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const openrouter = Array.from({ length: 5 }, (_, index) => route(`openrouter:m${index}:free`, model(), { freeOnly: true }));
  const pool = [route('cerebras:gpt-oss-120b', model(), { billingClass: 'promo' }), route('deepseek:deepseek-flash', model(), { billingClass: 'paid' }), ...openrouter,
    Object.assign(route('zhipu:glm-4.7-flash', model()), { unavailableReasons: ['CREDENTIAL_MISSING'], protocolClient: null })];
  const stateStore = new MemoryProviderStateStore({ now: () => now });
  const store = new MemoryQualificationStore();
  const qualifier = new AutoQualifier({ createPool: () => pool, stateStore, store, now: () => now, maxRoutes: 10, dailyProviderCap: { openrouter: 3 } });
  const first = await qualifier.runOnce();
  const tested = first.map((result) => result.routeId);
  assert.ok(tested.includes('cerebras:gpt-oss-120b'), 'promo (trial) routes are qualified');
  assert.ok(!tested.includes('deepseek:deepseek-flash'), 'paid routes are not');
  assert.ok(!tested.includes('zhipu:glm-4.7-flash'), 'routes without a credential are not');
  assert.equal(tested.filter((id) => id.startsWith('openrouter:')).length, 2, 'per-cycle OpenRouter limit');
  assert.ok(first.backlog > 0);
  const second = await qualifier.runOnce();
  assert.equal(second.filter((result) => result.routeId.startsWith('openrouter:')).length, 1, 'daily OpenRouter cap reached');
  assert.equal((await stateStore.snapshot()).get('cerebras:gpt-oss-120b').health, 'healthy', 'qualification counts as real traffic');
  const candidates = qualificationCandidates(pool, { qualifications: await store.snapshot(), state: await stateStore.snapshot(), now, maxRoutes: 10 });
  assert.ok(!candidates.some((entry) => entry.id === 'cerebras:gpt-oss-120b'), 'qualified routes are not re-tested until the evidence expires');
});
