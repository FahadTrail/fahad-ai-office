import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficeWorkflow, officeRequest } from '../src/workflow.js';
import { OfficeModelRunner, classifyOfficeData } from '../src/office/pool-runner.js';
import { assertPublicUrl, webFetch, webSearch, htmlToText } from '../src/office/web-tools.js';
import { capabilityProfile } from '../src/model-gateway/agentic/capabilities.js';
import { MemoryProviderStateStore } from '../src/model-gateway/agentic/provider-state.js';
import { modelAuthorized, authorizedRoutes } from '../src/workspace-policy/engine.js';
import { MemoryStore } from '../testing/fixtures/office-memory-store.js';

// Scripted models: they answer like the real Office stages would, so the
// workflow, router, tools, checkpoints and events are exercised end to end
// without any network or credentials.
function scriptedModel(name, log, { plan = 'content' } = {}) {
  return {
    async turn({ system, messages, tools }) {
      const prompt = messages.map((message) => message.content.map((block) => block.text || '').join('\n')).join('\n');
      log.push({ route: name, prompt, tools: tools.map((tool) => tool.name) });
      const usage = { inputTokens: 1000, outputTokens: 200, costUsd: name.startsWith('anthropic') ? 0.004 : 0 };
      const reply = (content, stopReason = 'end') => ({ message: { role: 'assistant', content }, usage, stopReason, model: name, durationMs: 5 });
      if (/Return JSON only/.test(prompt)) {
        return reply([{ type: 'text', text: JSON.stringify({ research_required: true, specialist: plan, plan_summary: 'Plan', research_brief: 'Do the work', review_brief: 'Review it' }) }]);
      }
      if (/CHIEF BRIEF/.test(prompt)) {
        const hasResult = messages.some((message) => message.content.some((block) => block.type === 'tool_result'));
        if (tools.length && !hasResult && !/CHECKPOINT/.test(prompt)) {
          return reply([{ type: 'tool_call', id: `call-${name}`, name: 'web_search', arguments: { query: 'office model routing' } }], 'tool_calls');
        }
        return reply([{ type: 'text', text: `Specialist result by ${name}. Source: https://example.com/a` }]);
      }
      return reply([{ type: 'text', text: `Final answer reviewed by ${name}.` }]);
    },
  };
}

function route(id, { billingClass = 'free', costTier = 1, qualityTier = 3, privacyApproved = false, pricing = null, contextWindow = 131_072 } = {}, client) {
  const [provider, ...rest] = id.split(':');
  const definition = { id, provider, model: rest.join(':'), billingClass, costTier, qualityTier, contextWindow, toolCalling: true, privacyApproved, pricing, secretRef: `env://${provider.toUpperCase()}_API_KEY` };
  return { ...definition, capabilities: capabilityProfile(definition, {}), unavailableReasons: [], protocolClient: client };
}

function officeFixture({ goal, plan = 'content', extraRoutes = [], stateStore = new MemoryProviderStateStore() }) {
  const log = [];
  const toolCalls = [];
  const pool = () => [
    route('groq:openai/gpt-oss-120b', { costTier: 1 }, scriptedModel('groq:openai/gpt-oss-120b', log, { plan })),
    route('gemini:gemini-flash-latest', { costTier: 2, qualityTier: 4 }, scriptedModel('gemini:gemini-flash-latest', log, { plan })),
    route('anthropic:claude-sonnet-5', { billingClass: 'paid', costTier: 3, qualityTier: 5, privacyApproved: true, pricing: { inputPerMillion: 2, outputPerMillion: 10 }, contextWindow: 1_000_000 }, scriptedModel('anthropic:claude-sonnet-5', log, { plan })),
    ...extraRoutes.map((entry) => entry(log, plan)),
  ];
  const runner = new OfficeModelRunner({
    stateStore, poolFactory: pool, sleepFn: async () => {},
    toolExecutorFactory: ({ allowSearch }) => async (call) => { toolCalls.push({ ...call, allowSearch }); return { ok: true, result: { query: call.arguments.query, sources: [{ title: 'Example', url: 'https://example.com/a' }] } }; },
  });
  const store = new MemoryStore({ goal });
  const workflow = new OfficeWorkflow({ store, modelRunner: runner, recoveryIntervalMs: Infinity });
  return { store, workflow, log, toolCalls, stateStore };
}

async function drain(workflow) {
  for (let step = 0; step < 12; step += 1) if (!(await workflow.runOnce())) break;
}

const routeEvents = (store) => store.events.filter((event) => event.payload?.kind === 'model_route');

test('Office stages ask for job types; the shared router picks capable FREE models first', async () => {
  const { store, workflow, log } = officeFixture({ goal: 'Write a short welcome paragraph for new customers.' });
  await drain(workflow);
  assert.equal(store.jobs[0].status, 'completed');
  const routes = routeEvents(store).map((event) => [event.payload.agent_slug, event.payload.job, event.payload.route_id, event.payload.billing_class]);
  assert.deepEqual(routes, [
    ['chief-of-staff', 'orchestration', 'groq:openai/gpt-oss-120b', 'free'],
    ['research-strategy', 'content', 'groq:openai/gpt-oss-120b', 'free'],
    ['chief-of-staff', 'synthesis', 'gemini:gemini-flash-latest', 'free'],
  ], 'Groq (writing 3) cannot do the final synthesis; Gemini (4/4) can — nobody pays');
  assert.equal(store.jobs[0].cost_usd, 0);
  assert.equal(store.tasks[1].title, 'Content (job: content)');
  const savings = routeEvents(store)[0].payload.savings;
  assert.match(savings.basis, /^ESTIMATE/);
  assert.ok(savings.paidEquivalentUsd > 0 && savings.estimatedSavingUsd === savings.paidEquivalentUsd);
  assert.ok(!log.some((entry) => entry.route.startsWith('anthropic')), 'the paid route was never called');
  const started = store.events.filter((event) => event.payload?.kind === 'model_stage_started').map((event) => event.payload.job);
  assert.deepEqual(started, ['orchestration', 'content', 'synthesis']);
});

test('Office failover drill: free model A → injected rate limit → checkpoint → free model B continues without redoing work', async () => {
  const stateStore = new MemoryProviderStateStore();
  const { store, workflow, log, toolCalls } = officeFixture({ goal: '[drill:failover] Research how teams route AI work to free models.', plan: 'research', stateStore });
  await drain(workflow);
  assert.equal(store.jobs[0].status, 'completed');
  assert.ok(!log.some((entry) => /\[drill/.test(entry.prompt)), 'drill markers never reach a model');
  const research = routeEvents(store).find((event) => event.payload.job === 'research').payload;
  assert.deepEqual(research.path.map((step) => step.routeId), ['groq:openai/gpt-oss-120b', 'gemini:gemini-flash-latest']);
  assert.equal(research.switches[0].injected, true, 'reported as a simulated failure');
  assert.equal(research.switches[0].code, 'DRILL_INJECTED_RATE_LIMIT');
  assert.equal(toolCalls.length, 1, 'the web search done by model A was not redone by model B');
  const handoff = log.find((entry) => entry.route === 'gemini:gemini-flash-latest' && /CHIEF BRIEF/.test(entry.prompt));
  assert.match(handoff.prompt, /CHECKPOINT — work already completed/);
  assert.match(handoff.prompt, /web_search\(\{"query":"office model routing"\}\)/);
  const checkpointIndex = store.events.findIndex((event) => event.payload?.kind === 'model_checkpoint');
  const switchIndex = store.events.findIndex((event) => event.payload?.kind === 'provider_switch');
  assert.ok(checkpointIndex >= 0 && checkpointIndex < switchIndex, 'the durable checkpoint is written before ownership changes');
  const groqHealth = (await stateStore.snapshot()).get('groq:openai/gpt-oss-120b');
  assert.deepEqual([groqHealth.health, groqHealth.consecutiveFailures, groqHealth.cooldownUntil], ['healthy', 0, null], 'an injected failure never marks the real provider unhealthy');
  assert.equal(store.jobs[0].cost_usd, 0);
});

test('Office escalation drill: an insufficient result escalates to the next suitable model from the checkpoint', async () => {
  const { store, workflow } = officeFixture({ goal: '[drill:escalate] Summarize our three product lines for a flyer.' });
  await drain(workflow);
  assert.equal(store.jobs[0].status, 'completed');
  const plan = routeEvents(store).find((event) => event.payload.job === 'orchestration').payload;
  assert.deepEqual(plan.path.map((step) => step.routeId), ['groq:openai/gpt-oss-120b', 'gemini:gemini-flash-latest'], 'cheapest remaining suitable model, still free');
  assert.deepEqual(plan.escalations.map((entry) => entry.code), ['DRILL_INJECTED_INSUFFICIENT']);
  assert.ok(store.events.some((event) => event.payload?.kind === 'model_escalation'));
});

test('a weak free model never gets a job it cannot do, even though it is the cheapest', async () => {
  const weak = (log, plan) => route('openrouter:liquid/lfm-2.5-2.6b:free', { costTier: 0, qualityTier: 1 }, scriptedModel('openrouter:liquid/lfm-2.5-2.6b:free', log, { plan }));
  const { store, workflow, log } = officeFixture({ goal: 'Write a tagline for a bakery.', extraRoutes: [weak] });
  await drain(workflow);
  assert.ok(!log.some((entry) => entry.route.includes('lfm')), 'lfm-2.6b (writing 2, reasoning 2) is never used');
  assert.equal(store.jobs[0].status, 'completed');
});

test('confidential Office work only reaches providers approved for private data, and web search is disabled for it', async () => {
  const { store, workflow, log, toolCalls } = officeFixture({ goal: '[confidential] Research options and email the summary to fahad@example.com', plan: 'research' });
  await drain(workflow);
  assert.equal(store.jobs[0].status, 'completed');
  assert.ok(log.every((entry) => entry.route.startsWith('anthropic:')), 'free providers (not approved for private data) never saw it');
  assert.ok(routeEvents(store).every((event) => event.payload.data_class === 'confidential'));
  assert.ok(toolCalls.every((call) => call.allowSearch === false));
  assert.ok(!log.some((entry) => /\[confidential\]/.test(entry.prompt)));
});

test('Office data classes and drill markers', () => {
  assert.equal(classifyOfficeData('Write a blog post about coffee').dataClass, 'general');
  assert.equal(classifyOfficeData('[confidential] merger plan').dataClass, 'confidential');
  assert.equal(classifyOfficeData('Contact me at a.b@example.com').dataClass, 'confidential');
  assert.equal(classifyOfficeData('IBAN DE89370400440532013000 details').dataClass, 'confidential');
  assert.equal(classifyOfficeData(`key ${['sk', 'ant', 'x'.repeat(30)].join('-')}`).dataClass, 'confidential');
  assert.equal(classifyOfficeData('Anything', { env: { OFFICE_DEFAULT_DATA_CLASS: 'confidential' } }).dataClass, 'confidential');
  const request = officeRequest('[drill:failover] [drill:escalate] Plan a launch');
  assert.deepEqual(request.drills, { failover: true, escalate: true });
  assert.equal(request.goal, 'Plan a launch');
  assert.deepEqual(officeRequest('[drill:failover] x', { OFFICE_DRILLS_ENABLED: 'false' }).drills, { failover: false, escalate: false });
});

test('workspace authorization: "*:free" admits only free-only guarded free variants', () => {
  assert.equal(modelAuthorized(['*:free'], 'nvidia/nemotron-3-super-120b-a12b:free', { freeOnly: true }), true);
  assert.equal(modelAuthorized(['*:free'], 'nvidia/nemotron-3-super-120b-a12b:free', { freeOnly: false }), false);
  assert.equal(modelAuthorized(['*:free'], 'anthropic/claude-sonnet-5', { freeOnly: true }), false);
  assert.equal(modelAuthorized(['*'], 'x:free', { freeOnly: true }), false);
  const pool = [
    { id: 'openrouter:a/b:free', provider: 'openrouter', model: 'a/b:free', freeOnly: true, secretRef: 'env://OPENROUTER_API_KEY' },
    { id: 'openrouter:a/paid', provider: 'openrouter', model: 'a/paid', freeOnly: false, secretRef: 'env://OPENROUTER_API_KEY' },
  ];
  assert.deepEqual(authorizedRoutes(pool, { providers: [{ provider: 'openrouter', models: ['*:free'], secretRef: 'env://OPENROUTER_API_KEY', enabled: true }] }), ['openrouter:a/b:free']);
  // Owner-stated free/promo routes of an approved provider are covered; paid ones never.
  const groq = [
    { id: 'groq:qwen/qwen3.8-27b', provider: 'groq', model: 'qwen/qwen3.8-27b', billingClass: 'free', secretRef: 'env://GROQ_API_KEY' },
    { id: 'groq:paid-model', provider: 'groq', model: 'paid-model', billingClass: 'paid', secretRef: 'env://GROQ_API_KEY' },
    { id: 'groq:unknown', provider: 'groq', model: 'unknown', secretRef: 'env://GROQ_API_KEY' },
  ];
  assert.deepEqual(authorizedRoutes(groq, { providers: [{ provider: 'groq', models: ['*:free'], secretRef: 'env://GROQ_API_KEY', enabled: true }] }), ['groq:qwen/qwen3.8-27b']);
});

test('web tools refuse private, local, Hermes and non-web targets and extract readable text', async () => {
  const publicResolve = async () => [{ address: '93.184.216.34' }];
  for (const [url, resolve] of [
    ['http://127.0.0.1/', publicResolve], ['http://localhost/x', publicResolve], ['file:///etc/passwd', publicResolve],
    ['https://example.com:8443/', publicResolve], ['https://hermes.example.com/', publicResolve], ['https://user:pw@example.com/', publicResolve],
    ['https://internal.example.com/', async () => [{ address: '10.1.2.3' }]], ['https://meta.example.com/', async () => [{ address: '169.254.169.254' }]],
    ['https://v6.example.com/', async () => [{ address: '::1' }]],
  ]) {
    await assert.rejects(assertPublicUrl(url, { resolve }), /allowed|private|reserved|resolve/i, url);
  }
  const redirecting = async (url) => (url.includes('start')
    ? new Response('', { status: 302, headers: { location: 'http://192.168.1.1/admin' } })
    : new Response('<html><title>T</title><body><script>x()</script><p>Hello</p></body></html>', { headers: { 'content-type': 'text/html' } }));
  const privateHop = async (host) => (host === 'example.com' ? [{ address: '93.184.216.34' }] : [{ address: '192.168.1.1' }]);
  await assert.rejects(webFetch({ url: 'https://example.com/start' }, { fetchFn: redirecting, resolve: privateHop }), /private|reserved/);
  const page = await webFetch({ url: 'https://example.com/page' }, { fetchFn: redirecting, resolve: publicResolve });
  assert.deepEqual([page.title, page.text], ['T', 'Hello']);
  assert.equal(htmlToText('<style>a{}</style><div>A&amp;B</div>').text, 'A&B');

  const sent = [];
  const search = await webSearch({ query: 'free models' }, { env: { GEMINI_API_KEY: 'AIzaTestKey_0123456789abcdefghijklmn' }, fetchFn: async (url, init) => {
    sent.push({ url, init });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '- fact' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://source.example/a', title: 'source.example' } }] } }] }));
  } });
  assert.deepEqual(search.sources, [{ title: 'source.example', url: 'https://source.example/a' }]);
  assert.ok(!sent[0].url.includes('AIza'), 'the key travels in a header, never the URL');
  assert.deepEqual(JSON.parse(sent[0].init.body).tools, [{ google_search: {} }]);
  await assert.rejects(webSearch({ query: 'x' }, { env: {} }), /not configured/);
});
