// Cloudflare Workers AI reliability (2026-10-26), follow-up to PR #123.
//
// PR #123 stopped empty tool fields from reaching Workers AI and turned a
// blank answer into a named error. This file pins everything that turns an
// uncertain Cloudflare answer into an honest routing decision, entirely
// offline (no key, no network, no database):
//
//   * the provider's machine error codes survive classification;
//   * a used-up daily neuron allowance rests every Workers AI model, and only
//     that pool (never another provider's quota);
//   * an unstated Workers plan blocks the route (a Paid plan bills overage);
//   * a model whose catalog entry says "no function calling" is never sent
//     tool schemas — by qualification or by the turn gateway;
//   * a free-only turn fails over between free providers and never calls a
//     paid route;
//   * the scoped canary is a dry run by default, has hard caps and a sanitized
//     report, and refuses to run live without a declared free plan;
//   * its no-tool check passes only on the exact expected answer, and a capped
//     run reports partial coverage instead of implying every model was probed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { postJson } from '../src/model-gateway/agentic/http.js';
import { classifyProviderError } from '../src/model-gateway/contracts.js';
import { createModelPool } from '../src/model-gateway/agentic/model-pool.js';
import { parseCatalog, setProviderCatalog } from '../src/model-gateway/agentic/provider-catalogs.js';
import { AgentTurnGateway } from '../src/model-gateway/agentic/turn-gateway.js';
import { MemoryProviderStateStore } from '../src/model-gateway/agentic/provider-state.js';
import { billingSafety, poolCooldowns, poolSummary } from '../src/model-gateway/agentic/capacity-pools.js';
import { qualifyRoute, QUALIFICATION_SUITE_VERSION } from '../src/model-gateway/agentic/qualification.js';
import { userText } from '../src/model-gateway/agentic/conversation.js';
import {
  canaryPreflight, cloudflareCanaryPlan, runCloudflareCanary, matchesExpectedToken, NO_TOOL_EXPECTED,
} from '../src/canary/cloudflare-canary.js';

const ACCOUNT = 'b'.repeat(32);
const TOKEN = 'cf-canary-token-value-0123456789';
const MODEL = '@cf/openai/gpt-oss-120b';
const ENV = { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_PLAN: 'free' };
const GOOD = JSON.stringify({ echo: 'BLUE-HARBOR-42', total: 36, code: 10, tagline: 'Fresh bread every morning', city: 'Porto' });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// Workers AI answers failures as { success: false, errors: [{ code, message }] }.
const workersError = (code, message, status) => json({ success: false, errors: [{ code, message }] }, status);
const usageOf = (prompt = 10, completion = 2) => ({ prompt_tokens: prompt, completion_tokens: completion });

function withCloudflare(models, tools, fn) {
  setProviderCatalog('cloudflare', { ok: true, models, contexts: {}, ...(tools ? { tools } : {}) });
  try { return fn(); } finally { setProviderCatalog('cloudflare', null); }
}

const cloudflareRoutesIn = (env, fetchFn = async () => json({ choices: [{ message: { content: 'ok' } }], usage: usageOf() })) =>
  createModelPool({ env, fetchFn }).filter((route) => route.provider === 'cloudflare');

const qualifiedRecord = () => ({
  suiteVersion: QUALIFICATION_SUITE_VERSION, status: 'qualified', testedAt: new Date().toISOString(),
  skills: { instruction: true, structured: true, reasoning: true, coding: true, writing: true, reading: true, tools: true },
});

test('Workers AI failures keep the machine code, never the provider message', async () => {
  const call = (fetchFn) => postJson({ fetchFn, url: 'https://api.cloudflare.com/client/v4/x', headers: {}, body: {}, provider: 'cloudflare' }).catch((error) => error);

  const missing = await call(async () => workersError(7000, 'No such model or task', 404));
  assert.equal(missing.status, 404);
  assert.equal(missing.providerCode, 7000);
  assert.equal(missing.reason, 'MODEL_NOT_FOUND', 'a withdrawn model is a route problem, not a bad request');
  assert.doesNotMatch(missing.message, /No such model/, 'provider text never reaches the message');

  const auth = await call(async () => workersError(10000, 'Authentication error', 401));
  assert.equal(auth.status, 401);
  assert.equal(auth.reason, 'CREDENTIAL_INVALID', "Cloudflare's own auth wording rests the key");

  const daily = await call(async () => workersError(4006, 'you have used up your daily free allocation', 400));
  assert.equal(daily.status, 429, 'error 4006 is a quota, whatever the HTTP status says');
  assert.equal(daily.quotaScope, 'day');
  assert.equal(daily.providerCode, 4006);
});

test('a used-up daily neuron allowance rests every Workers AI model, and only that pool', async () => {
  await withCloudflare([MODEL, '@cf/meta/llama-3.3-70b-instruct-fp8-fast'], null, async () => {
    const routes = cloudflareRoutesIn(ENV);
    assert.equal(routes.length, 2);
    const raw = await postJson({
      fetchFn: async () => workersError(4006, 'daily free allocation exhausted', 400),
      url: 'https://api.cloudflare.com/x', headers: {}, body: {}, provider: 'cloudflare',
    }).catch((error) => error);
    const error = classifyProviderError(raw);
    // The gateway copies this detail onto the classified error (turn-gateway.js).
    error.quotaScope = raw.quotaScope;

    const store = new MemoryProviderStateStore();
    await store.recordFailure(routes[0], error);
    const state = await store.snapshot();
    assert.equal(state.get(routes[0].id).health, 'quota_exhausted');

    // One shared pool: the sibling model rests too, because the allowance is
    // per account, not per model.
    assert.ok(poolCooldowns(routes, state).get('cloudflare:neurons'));
    const gateway = new AgentTurnGateway({ pool: routes, stateStore: store, minQualityTier: 1 });
    const evaluations = await gateway.evaluate({
      requiresPrivateData: false, minQualityTier: 1,
      qualifications: new Map(routes.map((route) => [route.id, qualifiedRecord()])),
    });
    assert.ok(evaluations.find((entry) => entry.route.id === routes[0].id).reasons.includes('COOLDOWN_QUOTA_EXHAUSTED'));
    assert.ok(evaluations.find((entry) => entry.route.id === routes[1].id).reasons.includes('COOLDOWN_POOL_QUOTA_EXHAUSTED'));

    const [summary] = poolSummary(routes, state);
    assert.equal(summary.state, 'exhausted');
    assert.equal(summary.lastErrorCode, 'PROVIDER_RATE_LIMIT', 'the failure reason is reported, not hidden');
    assert.equal(summary.published.neuronsPerDay, 10_000, 'the published neuron allowance is shown as a fact');
    assert.ok(summary.nextResetAt, 'reset information when the provider publishes a schedule');
  });
});

test('an unstated Workers plan blocks the route (fail closed); a paid plan is never free', async () => {
  await withCloudflare([MODEL], null, () => {
    const { CLOUDFLARE_PLAN, ...unstated } = ENV;
    const [blocked] = cloudflareRoutesIn(unstated);
    assert.deepEqual(blocked.unavailableReasons, ['PLAN_NOT_VERIFIED']);
    assert.equal(blocked.protocolClient, null, 'no client is built for a blocked route');
    assert.equal(blocked.billingClass, 'free');

    const [paid] = cloudflareRoutesIn({ ...ENV, CLOUDFLARE_PLAN: 'paid' });
    assert.equal(paid.billingClass, 'paid', 'overage could be billed: the route is priced as paid');
    assert.deepEqual(paid.unavailableReasons, ['PRICING_UNKNOWN'], 'and unusable until pricing is stated');

    const [free] = cloudflareRoutesIn(ENV);
    assert.deepEqual(free.unavailableReasons, []);

    const safety = billingSafety([blocked], { env: unstated });
    assert.equal(safety.cloudflare.plan, 'UNVERIFIED');
    assert.equal(safety.cloudflare.executable, 0);
    assert.equal(safety.paidFallbackOnFreeOnly, 'refused');
    assert.equal(billingSafety([free], { env: ENV }).cloudflare.plan, 'free');
    assert.equal(billingSafety([paid], { env: { ...ENV, CLOUDFLARE_PLAN: 'paid' } }).cloudflare.billingClass, 'paid');

    // The plan is the owner's declaration. No surface may present it as
    // verified billing evidence (Cloudflare does not report the plan).
    for (const [routes, env] of [[[free], ENV], [[paid], { ...ENV, CLOUDFLARE_PLAN: 'paid' }], [[blocked], unstated]]) {
      const report = billingSafety(routes, { env }).cloudflare;
      assert.equal(report.planBasis, 'owner-declared');
      assert.equal(report.planVerified, false);
      assert.match(report.planNote, /does not report|not independently verified/i);
    }
    assert.match(billingSafety([free], { env: ENV }).cloudflare.note, /declared by the owner \(not verified by the provider\)/);
  });
});

test('a model the catalog says cannot call functions is never sent tool schemas', async () => {
  const bodies = [];
  const fetchFn = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return json({ choices: [{ finish_reason: 'stop', message: { content: GOOD } }], usage: usageOf(40, 12) });
  };
  await withCloudflare([MODEL], { [MODEL]: false }, async () => {
    const [route] = cloudflareRoutesIn(ENV, fetchFn);
    assert.equal(route.toolCalling, false);
    const result = await qualifyRoute(route);
    assert.equal(result.status, 'qualified');
    assert.equal(result.skills.tools, false, 'no tool probe is run against a tool-less model');
    assert.equal(bodies.length, 1, 'the combined prompt only');
    assert.ok(!('tools' in bodies[0]) && !('tool_choice' in bodies[0]));
  });
});

test('the turn gateway gives a tool-less route no tools, even when the job passes some', async () => {
  const bodies = [];
  const fetchFn = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return json({ choices: [{ finish_reason: 'stop', message: { content: 'twenty nine' } }], usage: usageOf() });
  };
  await withCloudflare([MODEL], { [MODEL]: false }, async () => {
    const [route] = cloudflareRoutesIn(ENV, fetchFn);
    const gateway = new AgentTurnGateway({ pool: [route], stateStore: new MemoryProviderStateStore(), minQualityTier: 1 });
    const result = await gateway.turn({
      tools: [{ name: 'lookup_price', description: 'Look up a price.', inputSchema: { type: 'object', properties: { item: { type: 'string' } } } }],
      prepare: async () => ({ system: 'S', messages: [userText('hello')] }),
      routing: { requiresPrivateData: false, minQualityTier: 1, qualifications: new Map([[route.id, qualifiedRecord()]]) },
    });
    assert.equal(result.route.id, route.id);
    assert.ok(!('tools' in bodies[0]) && !('tool_choice' in bodies[0]), 'the model cannot accept them');
  });
});

test('a free-only turn fails over between free providers and never reaches a paid route', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url.includes('cloudflare')) return workersError(4006, 'you have used up your daily free allocation', 400);
    if (url.includes('groq')) {
      return json({ model: 'openai/gpt-oss-120b', choices: [{ finish_reason: 'stop', message: { content: 'the answer' } }], usage: usageOf() });
    }
    return json({ choices: [{ finish_reason: 'stop', message: { content: 'paid answer' } }], usage: usageOf() });
  };
  await withCloudflare([MODEL], null, async () => {
    const pool = createModelPool({
      env: { ...ENV, GROQ_API_KEY: 'gsk_test_key_0123456789', DEEPSEEK_API_KEY: 'sk-test-key-0123456789' },
      fetchFn,
    });
    const cloudflare = pool.find((route) => route.id === `cloudflare:${MODEL}`);
    const groq = pool.find((route) => route.provider === 'groq');
    const paid = pool.find((route) => route.provider === 'deepseek');
    assert.ok(cloudflare && groq && paid);

    const gateway = new AgentTurnGateway({ pool: [cloudflare, groq, paid], stateStore: new MemoryProviderStateStore(), minQualityTier: 1 });
    const result = await gateway.turn({
      tools: [],
      prepare: async () => ({ system: 'S', messages: [userText('question')] }),
      routing: {
        requiresPrivateData: false, allowPaid: false, minQualityTier: 1,
        qualifications: new Map([[cloudflare.id, qualifiedRecord()]]),
      },
    });
    assert.equal(result.route.provider, 'groq', 'the other free pool served the turn');
    assert.equal(result.switched, true);
    assert.equal(calls.filter((url) => url.includes('cloudflare')).length, 1, 'a daily quota is not retried inline');
    assert.ok(calls.every((url) => !url.includes('deepseek')), 'the paid route was never called');
    assert.equal(result.attempts.filter((attempt) => attempt.status === 'failed').length, 1);
  });
});

test('the Workers AI catalog exposes per-model function calling', () => {
  const parsed = parseCatalog('cloudflare', {
    result: [
      { name: MODEL, properties: [{ property_id: 'context_window', value: '128000' }, { property_id: 'function_calling', value: true }] },
      { name: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', properties: [{ property_id: 'function_calling', value: false }] },
    ],
  });
  assert.equal(parsed.tools[MODEL], true);
  assert.equal(parsed.tools['@cf/meta/llama-3.3-70b-instruct-fp8-fast'], false);
  // No property at all stays UNKNOWN (permissive), never false.
  const unknown = parseCatalog('cloudflare', { result: [{ name: MODEL }] });
  assert.equal(unknown.tools, undefined);
});

test('the Cloudflare canary is a dry run by default and refuses an unverified plan', async () => {
  let called = 0;
  const fetchFn = async () => { called += 1; return json({}); };

  const plan = cloudflareCanaryPlan({ env: ENV });
  assert.equal(plan.mode, 'dry-run');
  assert.equal(plan.dryRun, true);
  assert.equal(plan.provider, 'cloudflare');
  assert.equal(plan.checks.length, 6, 'a no-tool and a tool check for each documented model');
  assert.deepEqual(plan.caps.providers, ['cloudflare'], 'no other provider can be reached');
  assert.equal(plan.caps.allowPaid, false);
  assert.equal(plan.caps.databaseWrites, false);

  const dry = await runCloudflareCanary({ env: ENV, fetchFn });
  assert.equal(called, 0, 'a dry run sends nothing');
  assert.equal(dry.requestsSent, 0);
  assert.equal(dry.ok, undefined, 'a dry run makes no claim about the provider');

  const preflight = canaryPreflight({ env: ENV });
  assert.equal(preflight.liveAllowed, true);
  assert.equal(preflight.plan, 'free');
  assert.equal(preflight.planBasis, 'owner-declared', 'a stated plan is a declaration, not provider evidence');
  assert.equal(preflight.planVerified, false);
  assert.equal(preflight.planSource, 'CLOUDFLARE_PLAN');
  assert.deepEqual(canaryPreflight({ env: {} }).blockers, [
    'CLOUDFLARE_API_TOKEN_MISSING', 'CLOUDFLARE_ACCOUNT_ID_MISSING_OR_INVALID', 'CLOUDFLARE_PLAN_NOT_VERIFIED',
  ]);

  const unstated = await runCloudflareCanary({ env: { ...ENV, CLOUDFLARE_PLAN: '' }, fetchFn, live: true });
  assert.equal(unstated.executed, false);
  assert.equal(unstated.ok, false);
  assert.match(unstated.note, /CLOUDFLARE_PLAN_NOT_VERIFIED/);

  const paid = await runCloudflareCanary({ env: { ...ENV, CLOUDFLARE_PLAN: 'paid' }, fetchFn, live: true });
  assert.equal(paid.executed, false, 'a paid plan would bill neuron overage');
  assert.ok(paid.preflight.blockers.includes('CLOUDFLARE_PLAN_IS_PAID'));
  assert.equal(called, 0, 'no request left the process');
});

test('the live canary measures a no-tool call and a real tool round trip without leaking input or output', async () => {
  const bodies = [];
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const usage = usageOf(24, 6);
    if (body.tools?.length) {
      const answered = body.messages.some((message) => message.role === 'tool');
      if (answered) return json({ choices: [{ finish_reason: 'stop', message: { content: '42' } }], usage });
      return json({
        choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'add_numbers', arguments: '{"a":17,"b":25}' } },
        ] } }], usage,
      });
    }
    return json({ choices: [{ finish_reason: 'stop', message: { content: 'CLOUDFLARE-OK' } }], usage });
  };

  const report = await runCloudflareCanary({ env: ENV, fetchFn, live: true, models: [MODEL], now: () => Date.parse('2026-10-26T12:00:00Z') });
  assert.equal(report.ok, true, JSON.stringify(report.results));
  assert.equal(report.requestsSent, 3);
  assert.deepEqual(report.results.map((entry) => [entry.check, entry.ok]), [['no-tool', true], ['tool-calling', true]]);
  assert.equal(report.results[0].toolFieldsOmitted, true);
  assert.equal(report.results[0].expectedTokenMatched, true);
  assert.equal(report.results[1].toolName, 'add_numbers');
  assert.equal(report.totalTokens, 90, 'measured usage of the three calls');
  assert.equal(report.usage.costUsd, 0);

  assert.ok(!('tools' in bodies[0]) && !('tool_choice' in bodies[0]), 'the no-tool request keeps the PR #123 shape');
  assert.equal(bodies[1].tools[0].function.name, 'add_numbers', 'the tool probe still sends a real schema');

  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes(TOKEN), 'the credential never appears in a report');
  assert.ok(!serialized.includes('Reply with exactly'), 'prompts are not stored');
  // No answer text at all: the token appears only as the declared expectation
  // in `checks[].expects`, never as something the model said.
  const resultsOnly = JSON.stringify(report.results);
  assert.ok(!resultsOnly.includes('CLOUDFLARE-OK'), 'model output is not stored in a result');
  assert.ok(!resultsOnly.includes('"answer"') && !resultsOnly.includes('"content"'), 'no raw answer or content field');
});

test('the no-tool check passes only on the exact expected token, never on non-empty text', async () => {
  assert.equal(NO_TOOL_EXPECTED, 'CLOUDFLARE-OK');
  // Formatting around the token is tolerated (quotes, markdown, a full stop).
  for (const answer of ['CLOUDFLARE-OK', '  CLOUDFLARE-OK\n', '`CLOUDFLARE-OK`', '**CLOUDFLARE-OK**', 'CLOUDFLARE-OK.', 'cloudflare-ok']) {
    assert.equal(matchesExpectedToken(answer), true, JSON.stringify(answer));
  }
  // Extra content is not: the model did not follow the instruction.
  for (const answer of ['', 'CLOUDFLARE-OKAY', 'Sure! CLOUDFLARE-OK', 'CLOUDFLARE-OK — here you go', 'OK']) {
    assert.equal(matchesExpectedToken(answer), false, JSON.stringify(answer));
  }

  const chatty = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.tools?.length) {
      const answered = body.messages.some((message) => message.role === 'tool');
      return answered
        ? json({ choices: [{ message: { content: '42' } }], usage: usageOf() })
        : json({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'add_numbers', arguments: '{"a":17,"b":25}' } }] } }], usage: usageOf() });
    }
    return json({ choices: [{ message: { content: 'Sure! CLOUDFLARE-OK — anything else?' } }], usage: usageOf() });
  };
  const report = await runCloudflareCanary({ env: ENV, fetchFn: chatty, live: true, models: [MODEL] });
  const [noTool] = report.results;
  assert.equal(noTool.answered, true, 'the answer was not empty…');
  assert.equal(noTool.expectedTokenMatched, false, '…but it was not the expected token');
  assert.equal(noTool.ok, false);
  assert.equal(noTool.failure, 'EXPECTED_TOKEN_MISMATCH');
  assert.equal(report.ok, false, 'a chatty answer is not a passing canary');
});

test('the request cap admits a full three-model round trip and reports partial coverage honestly', async () => {
  const plan = cloudflareCanaryPlan({ env: ENV });
  assert.equal(plan.caps.maxRequests, 9, '3 models × 3 requests each: one no-tool call plus a two-call tool round trip');
  assert.equal(plan.caps.requestsPerModel, 3);
  assert.equal(plan.caps.requestsRequired, 9);
  assert.equal(plan.caps.plannedRequests, 9);
  assert.equal(plan.coverage.fullCoverage, true);
  assert.equal(plan.coverage.completeModels.length, 3);
  assert.deepEqual(plan.coverage.partialModels, []);
  assert.deepEqual(plan.coverage.unprobedModels, []);
  assert.ok(plan.checks.every((entry) => entry.planned));

  // A tighter cap is still strict: the run stops at the first check that does
  // not fit, and the plan says exactly which models that leaves out.
  const tight = cloudflareCanaryPlan({ env: ENV, maxRequests: 6 });
  assert.equal(tight.caps.plannedRequests, 6);
  assert.equal(tight.coverage.fullCoverage, false);
  assert.equal(tight.coverage.completeModels.length, 2);
  assert.deepEqual(tight.coverage.unprobedModels, ['@cf/meta/llama-3.3-70b-instruct-fp8-fast']);
  assert.match(tight.note, /PARTIAL COVERAGE/);

  let called = 0;
  const fetchFn = async (url, init) => {
    called += 1;
    const body = JSON.parse(init.body);
    if (body.tools?.length) {
      const answered = body.messages.some((message) => message.role === 'tool');
      return answered
        ? json({ choices: [{ message: { content: '42' } }], usage: usageOf() })
        : json({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'add_numbers', arguments: '{"a":17,"b":25}' } }] } }], usage: usageOf() });
    }
    return json({ choices: [{ message: { content: 'CLOUDFLARE-OK' } }], usage: usageOf() });
  };

  // Execution follows the same stopping rule, so the dry run predicts reality.
  const run = await runCloudflareCanary({ env: ENV, fetchFn, live: true, maxRequests: 6 });
  assert.equal(called, 6);
  assert.equal(run.requestsSent, 6);
  assert.equal(run.coverage.fullCoverage, false);
  assert.equal(run.partialCoverage, true);
  assert.deepEqual(run.coverage.completeModels, tight.coverage.completeModels);
  assert.deepEqual(run.coverage.unprobedModels, tight.coverage.unprobedModels);
  assert.equal(run.stoppedBecause, 'REQUEST_CAP');
  assert.equal(run.ok, false, 'partial coverage is never a passing canary');
  assert.match(run.note, /PARTIAL COVERAGE/);

  const full = await runCloudflareCanary({ env: ENV, fetchFn, live: true });
  assert.equal(full.requestsSent, 9);
  assert.equal(full.coverage.fullCoverage, true);
  assert.equal(full.partialCoverage, undefined);
  assert.equal(full.ok, true, JSON.stringify(full.results));
});

test('the live canary enforces its request cap and refuses models outside the allowlist', async () => {
  let called = 0;
  const fetchFn = async () => {
    called += 1;
    return json({ choices: [{ finish_reason: 'stop', message: { content: 'CLOUDFLARE-OK' } }], usage: usageOf(5, 2) });
  };

  const capped = await runCloudflareCanary({ env: ENV, fetchFn, live: true, maxRequests: 2 });
  assert.equal(called, 1, 'one no-tool call; the two-call tool check no longer fits');
  assert.equal(capped.stoppedBecause, 'REQUEST_CAP');
  assert.equal(capped.requestsSent, 1);
  assert.ok(capped.results.some((entry) => entry.skipped === 'REQUEST_CAP_PARTIAL'));

  const before = called;
  const refused = await runCloudflareCanary({ env: ENV, fetchFn, live: true, models: ['@cf/other/model'] });
  assert.deepEqual(refused.selected, []);
  assert.deepEqual(refused.refused, ['@cf/other/model']);
  assert.equal(refused.requestsSent, 0);
  assert.equal(refused.ok, false);
  assert.equal(called, before, 'a model outside the allowlist is never probed');
});
