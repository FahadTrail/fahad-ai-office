// Capacity V2 Part 9 / 12 / 13: coding qualification suite, coding routing
// tiers and the model-handoff checkpoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODING_SUITE_VERSION, codingCandidates, codingGrade, codingTierGaps, contextTestable, gradeCodingAnswer, gradeToolFix,
  longContextFixture, qualifyCodingRoute, runCodeCases,
} from '../src/model-gateway/agentic/coding-qualification.js';
import { MemoryQualificationStore, QUALIFICATION_SUITE_VERSION } from '../src/model-gateway/agentic/qualification.js';
import { AgentTurnGateway } from '../src/model-gateway/agentic/turn-gateway.js';
import { MemoryProviderStateStore } from '../src/model-gateway/agentic/provider-state.js';
import { continuationMessage } from '../src/coding-agent/prompts.js';

const MEDIAN = 'function median(values) { const s = [...values].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }';
const GOOD = {
  read: '3abb', fix: MEDIAN,
  implement: "function slugify(t) { return t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }",
  edge: "function chunk(a, n) { if (!Number.isInteger(n) || n <= 0) throw new RangeError('size'); const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }",
  tests: [[-1, 0, 10, 0], [11, 0, 10, 10], [5, 0, 10, 5], [0, 0, 10, 0]],
  diff: "--- a/src/config.js\n+++ b/src/config.js\n@@ -1,3 +1,3 @@\n export const HOST = 'localhost';\n-const TIMEOUT_MS = 5000;\n+const TIMEOUT_MS = 10000;\n export default { HOST, TIMEOUT_MS };",
  security: { vuln: 'SQL injection', fixed: 'const rows = await db.query("SELECT * FROM users WHERE email = $1", [email]);' },
  async: '15342',
  plan: { files: [{ path: 'src/cli.js', action: 'modify' }, { path: 'test/cli.test.js', action: 'modify' }, { path: 'src/legacy.js', action: 'delete' }] },
  scope: 'src/price.js',
};
const FIXED_SUM = 'export function sumEven(values) {\n  let total = 0;\n  for (let i = 0; i < values.length; i++) if (values[i] % 2 === 0) total += values[i];\n  return total;\n}\n';

test('coding suite graders: correct answers pass, the original bugs and near-misses fail', () => {
  assert.ok(Object.values(gradeCodingAnswer(JSON.stringify(GOOD))).every(Boolean));
  const bad = gradeCodingAnswer(JSON.stringify({
    ...GOOD,
    read: 'abb3',
    fix: 'function median(values) { const sorted = values.sort(); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid] + sorted[mid + 1]) / 2; }',
    edge: 'function chunk(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }',
    tests: [[5, 0, 10, 5], [6, 0, 10, 6], [7, 0, 10, 7], [8, 0, 10, 8]],
    diff: GOOD.diff.replace("export const HOST = 'localhost';", "-export const HOST = 'localhost';\n+export const HOST = '0.0.0.0';"),
    security: { vuln: 'SQL injection', fixed: 'db.query("SELECT * FROM users WHERE email = \'" + email + "\'")' },
    async: '15234',
    plan: { files: [{ path: 'src/cli.js', action: 'modify' }] },
    scope: 'test/price.test.js',
  }));
  assert.deepEqual(Object.entries(bad).filter(([, ok]) => ok).map(([check]) => check), ['implement']);
  assert.ok(Object.values(gradeCodingAnswer('not json at all')).every((value) => value === false));
  assert.equal(gradeToolFix([{ path: 'src/sum.js', content: FIXED_SUM }]), true);
  assert.equal(gradeToolFix([{ path: 'src/sum.js', content: FIXED_SUM }, { path: 'test/sum.test.js', content: '' }]), false, 'editing another file fails');
});

test('model-written code runs isolated: no process, no file system, no code generation, bounded time', () => {
  assert.equal(runCodeCases(MEDIAN, 'median', [{ args: [[10, 9, 1, 100]], expect: 9.5, unchanged: true }]), true);
  assert.equal(runCodeCases("function f() { return ({}).constructor.constructor('return process')().env; }", 'f', [{ args: [], expect: {} }]), false);
  assert.equal(runCodeCases("function f() { return typeof require + typeof process + typeof fetch; }", 'f', [{ args: [], expect: 'undefinedundefinedundefined' }]), true);
  assert.equal(runCodeCases('function f() { while (true) {} }', 'f', [{ args: [], expect: 1 }]), false);
  assert.equal(runCodeCases('x'.repeat(30_000), 'f', [{ args: [], expect: 1 }]), false);
});

test('coding grades: PRIMARY needs long context; SECONDARY and SMALL_TASKS thresholds; failures are not approved', () => {
  const all = Object.fromEntries(Object.keys(GOOD).map((check) => [check, true]));
  assert.equal(codingGrade({ ...all, tools: true, context: true }), 'CODING_PRIMARY');
  assert.equal(codingGrade({ ...all, tools: true, context: null }), 'CODING_SECONDARY');
  assert.equal(codingGrade({ ...all, tools: false, context: true }), 'CODING_SMALL_TASKS');
  assert.equal(codingGrade({ read: true, fix: true, tests: true, async: true, scope: true, tools: false, context: null }), 'NOT_CODING_APPROVED');
  assert.equal(contextTestable({ contextWindow: 128_000 }), true);
  assert.equal(contextTestable({ contextWindow: 128_000, requestTokenLimit: 8_000 }), false, 'Groq-style per-minute limits skip L');
  assert.match(longContextFixture(), /export const RETRY_LIMIT = 7;/);
});

function scriptedRoute({ id = 'ollama:gpt-oss:120b', contextWindow = 128_000, answers }) {
  let index = 0;
  return {
    id, provider: id.split(':')[0], model: id.split(':').slice(1).join(':'), billingClass: 'free', contextWindow, toolCalling: true, unavailableReasons: [],
    protocolClient: { turn: async () => { const next = answers[index++]; return { message: { role: 'assistant', content: next }, usage: { inputTokens: 100, outputTokens: 50, costUsd: 0 } }; } },
  };
}

test('qualifyCodingRoute runs the suite end to end with a tool loop and records a grade', async () => {
  const route = scriptedRoute({ answers: [
    [{ type: 'text', text: JSON.stringify(GOOD) }],
    [{ type: 'tool_call', id: 't1', name: 'read_file', arguments: { path: 'src/sum.js' } }],
    [{ type: 'tool_call', id: 't2', name: 'write_file', arguments: { path: 'src/sum.js', content: FIXED_SUM } }],
    [{ type: 'text', text: '7' }],
  ] });
  const result = await qualifyCodingRoute(route);
  assert.equal(result.suiteVersion, CODING_SUITE_VERSION);
  assert.equal(result.grade, 'CODING_PRIMARY');
  assert.equal(result.passed, 12);
  assert.equal(result.usage.costUsd, 0);
  const failing = await qualifyCodingRoute({ ...route, protocolClient: { turn: async () => { throw Object.assign(new Error('nope'), { status: 404 }); } } });
  assert.equal(failing.status, 'error');
  assert.equal(failing.errorCode, 'HTTP_404');
});

const general = (id) => [id, { suiteVersion: QUALIFICATION_SUITE_VERSION, status: 'qualified', testedAt: new Date().toISOString(), skills: { coding: true, tools: true, reasoning: true, structured: true, instruction: true, writing: true, reading: true } }];
const codingRecord = (grade) => ({ suiteVersion: CODING_SUITE_VERSION, status: grade === 'NOT_CODING_APPROVED' ? 'failed' : 'qualified', grade, testedAt: new Date().toISOString() });

test('coding tiers: free routes need the grade for the job size; critical also needs a private-data route; paid unaffected', () => {
  const free = { id: 'ollama:m', billingClass: 'free' };
  const coding = new Map([['ollama:m', codingRecord('CODING_SECONDARY')]]);
  assert.deepEqual(codingTierGaps(free, 'small', coding), []);
  assert.deepEqual(codingTierGaps(free, 'medium', coding), []);
  assert.deepEqual(codingTierGaps(free, 'large', coding), ['CODING_GRADE_TOO_LOW']);
  assert.deepEqual(codingTierGaps(free, 'medium', new Map()), ['CODING_NOT_QUALIFIED']);
  const primary = new Map([['ollama:m', codingRecord('CODING_PRIMARY')]]);
  assert.deepEqual(codingTierGaps(free, 'critical', primary), ['CRITICAL_NEEDS_PRIVATE_ROUTE']);
  assert.deepEqual(codingTierGaps({ ...free, privacyApproved: true }, 'critical', primary), []);
  assert.deepEqual(codingTierGaps({ id: 'anthropic:x', billingClass: 'paid' }, 'critical', new Map()), []);
});

test('gateway applies the coding tier gate for coding jobs when evidence is present', async () => {
  const route = {
    id: 'ollama:gpt-oss:120b', provider: 'ollama', model: 'gpt-oss:120b', billingClass: 'free', dataClass: 'NORMAL', qualityTier: 5, contextWindow: 128_000,
    unavailableReasons: [], capabilities: { coding: 4, reasoning: 4, toolCalling: true, structuredOutput: true, contextWindow: 128_000 }, protocolClient: {},
  };
  const gateway = new AgentTurnGateway({ pool: [route], stateStore: new MemoryProviderStateStore(), minQualityTier: 1 });
  const qualifications = Object.assign(new Map([general(route.id)]), { coding: new Map([[route.id, codingRecord('CODING_SMALL_TASKS')]]) });
  const reasonsFor = async (codingTier) => (await gateway.evaluate({ job: 'coding', dataClass: 'NORMAL', qualifications, codingTier, estimatedInputTokens: 1_000, maxOutputTokens: 1_000 }))[0].reasons;
  assert.ok(!(await reasonsFor('small')).some((reason) => reason.startsWith('CODING_')));
  assert.ok((await reasonsFor('medium')).includes('CODING_GRADE_TOO_LOW'));
  // Private code still never reaches a NORMAL route, whatever its grade.
  const privateReasons = (await gateway.evaluate({ job: 'coding', qualifications, codingTier: 'small', estimatedInputTokens: 1_000, maxOutputTokens: 1_000 }))[0].reasons;
  assert.ok(privateReasons.includes('PRIVACY_NOT_APPROVED'));
});

test('coding candidates: only generally qualified coding+tools routes without a valid coding result, never paid', async () => {
  const mk = (id, billingClass = 'free') => ({ id, provider: id.split(':')[0], billingClass, protocolClient: {}, unavailableReasons: [], capabilities: { coding: 3 } });
  const store = new MemoryQualificationStore();
  await store.save([{ routeId: 'a:1', ...general('a:1')[1] }, { routeId: 'b:1', ...general('b:1')[1] }, { routeId: 'c:1', ...general('c:1')[1], skills: { coding: false, tools: true } }]);
  await store.save([{ routeId: 'b:1', ...codingRecord('CODING_SECONDARY') }], { kind: 'coding_qualification' });
  const snapshot = await store.snapshot();
  const ids = codingCandidates([mk('a:1'), mk('b:1'), mk('c:1'), mk('p:1', 'paid')], { qualifications: snapshot, maxRoutes: 10 }).map((route) => route.id);
  assert.deepEqual(ids, ['a:1']);
});

test('model handoff carries repository, diff summary, owner decisions and unresolved items', () => {
  const message = continuationMessage({
    session: { objective: 'Add retries', repository: 'owner/app', baseBranch: 'main', workBranch: 'agent/retries', phase: 'implement', iteration: 7 },
    state: { filesChanged: ['src/a.js', 'test/a.test.js'], ownerMessages: ['Use exponential backoff, max 5 tries.'], lastTest: { command: 'npm test', exitCode: 1, at: 'now', output: '1 failed' }, lastGateFailure: 'lint error' },
    plan: [{ title: 'Write test', status: 'done' }, { title: 'Implement retry', status: 'in_progress' }],
    nextAction: 'Fix the failing test', recentMessages: [], reason: 'model handoff', fromRoute: 'a:x', toRoute: 'b:y',
  });
  for (const expected of ['REPOSITORY: owner/app', 'DIFF SUMMARY: 2 file(s) changed on agent/retries vs main', 'Owner: Use exponential backoff', 'Plan step open: Implement retry', 'Last test run failed (exit 1)', 'gate/CI failure is recorded']) {
    assert.ok(message.includes(expected), expected);
  }
  assert.ok(!message.includes('Plan step open: Write test'));
});

test('auto-qualifier grades coding every cycle: one route per provider, max 3, a capped provider never blocks the others', async () => {
  const { AutoQualifier } = await import('../src/model-gateway/agentic/qualification.js');
  const calls = [];
  const mk = (id, coding = 3) => ({
    id, provider: id.split(':')[0], model: id.split(':').slice(1).join(':'), billingClass: 'free', unavailableReasons: [], toolCalling: true, contextWindow: 32_000,
    capabilities: { coding }, protocolClient: { turn: async () => { calls.push(id); throw Object.assign(new Error('rate'), { status: 429 }); } },
  });
  // openrouter routes rank first (higher coding score) but openrouter is capped for the day.
  const pool = [mk('openrouter:a', 5), mk('openrouter:b', 5), mk('gemini:c'), mk('gemini:d'), mk('groq:e'), mk('zhipu:f'), mk('zhipu:g')];
  const store = new MemoryQualificationStore();
  await store.save(pool.map((route) => ({ routeId: route.id, ...general(route.id)[1] })));
  const stateStore = new MemoryProviderStateStore();
  const qualifier = new AutoQualifier({ createPool: () => pool, stateStore, store, dailyProviderCap: { openrouter: 0 } });
  const results = await qualifier.runOnce();
  const tested = results.map((result) => result.routeId);
  assert.equal(tested.length, 3);
  assert.ok(!tested.some((id) => id.startsWith('openrouter:')), 'capped provider skipped');
  assert.equal(new Set(tested.map((id) => id.split(':')[0])).size, 3, 'one route per provider');
  assert.ok(results.backlog >= 2, 'the rest stays in the backlog (short interval)');
  assert.equal((await store.snapshot()).coding.errors.size, 3, 'errors recorded → back-off applies next cycle');
});

test('coding suite records parse diagnostics and gives the main answer room within the route request limit', async () => {
  const budgets = [];
  const mkRoute = (extra) => ({ ...scriptedRoute({ answers: [[{ type: 'text', text: 'not json' }], [{ type: 'text', text: 'done' }]] }), ...extra });
  const wrap = (route) => ({ ...route, protocolClient: { turn: async (input) => { budgets.push(input.maxOutputTokens); return route.protocolClient.turn(input); } } });
  const plain = await qualifyCodingRoute(wrap(mkRoute({ contextWindow: 32_000 })));
  assert.equal(plain.diagnostics.answerParsed, false);
  assert.equal(plain.diagnostics.mainBudget, 8_000);
  const groq = await qualifyCodingRoute(wrap(mkRoute({ contextWindow: 32_000, requestTokenLimit: 8_000 })));
  assert.equal(groq.diagnostics.mainBudget, 6_000);
  assert.equal(budgets[0], 8_000);
});

test('a measured coding grade satisfies the coding quality floor for a free route; claims alone do not', async () => {
  const route = {
    id: 'gemini:gemma', provider: 'gemini', model: 'gemma', billingClass: 'free', qualityTier: 3, contextWindow: 128_000, unavailableReasons: [],
    // Registry scores as in production (Gemma 4: coding 3, reasoning 3).
    capabilities: { coding: 3, reasoning: 3, toolCalling: true, structuredOutput: true, contextWindow: 128_000 }, protocolClient: {},
  };
  const gateway = new AgentTurnGateway({ pool: [route], stateStore: new MemoryProviderStateStore(), minQualityTier: 4 });
  const run = async (coding) => (await gateway.evaluate({
    job: 'coding', dataClass: 'PUBLIC', codingTier: 'small', estimatedInputTokens: 20_000, maxOutputTokens: 4_000,
    qualifications: Object.assign(new Map([general(route.id)]), { coding }),
  }))[0].reasons;
  assert.ok((await run(new Map())).includes('BELOW_QUALITY_FLOOR'), 'no grade: the claimed tier decides');
  assert.ok(!(await run(new Map([[route.id, codingRecord('CODING_PRIMARY')]]))).includes('BELOW_QUALITY_FLOOR'), 'measured grade satisfies the floor');
  assert.ok((await run(new Map([[route.id, codingRecord('NOT_CODING_APPROVED')]]))).includes('BELOW_QUALITY_FLOOR'));
  // Production session d199fc5a: the capability minimums (coding 4,
  // reasoning 4) blocked the graded route even after the floor was met.
  assert.ok((await run(new Map())).includes('CAPABILITY_CODING_BELOW_4'), 'no grade: claimed scores decide');
  assert.deepEqual(await run(new Map([[route.id, codingRecord('CODING_PRIMARY')]])), [], 'graded route is eligible for a small PUBLIC coding turn');
  const small = await run(new Map([[route.id, codingRecord('CODING_SMALL_TASKS')]]));
  assert.deepEqual(small, [], 'a SMALL_TASKS grade serves the small tier');
  const tools = (await new AgentTurnGateway({ pool: [{ ...route, capabilities: { ...route.capabilities, toolCalling: false } }], stateStore: new MemoryProviderStateStore(), minQualityTier: 4 }).evaluate({
    job: 'coding', dataClass: 'PUBLIC', codingTier: 'small', estimatedInputTokens: 20_000, maxOutputTokens: 4_000,
    qualifications: Object.assign(new Map([general(route.id)]), { coding: new Map([[route.id, codingRecord('CODING_PRIMARY')]]) }),
  }))[0].reasons;
  assert.ok(tools.includes('TOOL_CALLING_REQUIRED'), 'the grade never waives tool calling');
});

test('a coding grade below the session tier keeps the capability minimums', async () => {
  const route = {
    id: 'zhipu:glm', provider: 'zhipu', model: 'glm', billingClass: 'free', qualityTier: 3, contextWindow: 200_000, unavailableReasons: [],
    capabilities: { coding: 3, reasoning: 3, toolCalling: true, structuredOutput: true, contextWindow: 200_000 }, protocolClient: {},
  };
  const gateway = new AgentTurnGateway({ pool: [route], stateStore: new MemoryProviderStateStore(), minQualityTier: 4 });
  const reasons = (await gateway.evaluate({
    job: 'coding', dataClass: 'PUBLIC', codingTier: 'medium', estimatedInputTokens: 20_000, maxOutputTokens: 4_000,
    qualifications: Object.assign(new Map([general(route.id)]), { coding: new Map([[route.id, codingRecord('CODING_SMALL_TASKS')]]) }),
  }))[0].reasons;
  assert.ok(reasons.includes('CODING_GRADE_TOO_LOW'));
  assert.ok(reasons.includes('CAPABILITY_CODING_BELOW_4'));
  assert.ok(reasons.includes('BELOW_QUALITY_FLOOR'));
});
