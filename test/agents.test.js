import test from 'node:test';
import assert from 'node:assert/strict';
import { planJob, reviewResearch } from '../src/chief.js';
import { performResearch } from '../src/research.js';
import { buildModelEnvironment, runModel } from '../src/model-runner.js';

const agent = { system_prompt: 'A safe agent prompt.' };
const metrics = { tokensIn: 2, tokensOut: 3, costUsd: 0.004, durationMs: 7, turns: 1 };

test('Chief planning is tool-free and requires a real Research delegation', async () => {
  let options;
  const onAttempt = async () => {};
  const result = await planJob({
    agent,
    goal: 'Research costs',
    execution: { idempotencyKey: 'run:plan', onAttempt },
    run: async (received) => {
      options = received;
      return { text: JSON.stringify({ research_required: true, plan_summary: 'Delegate.', research_brief: 'Research three options.', review_brief: 'Review them.' }), ...metrics };
    },
  });
  assert.deepEqual(options.allowedTools, []);
  assert.deepEqual(options.routingHints, { requiresPrivateData: true, preferQuality: true });
  assert.equal(options.idempotencyKey, 'run:plan');
  assert.equal(options.onAttempt, onAttempt);
  assert.equal(result.plan.research_required, true);
});

test('Research receives only the authorized web tools', async () => {
  let options;
  await performResearch({
    agent,
    goal: 'Research costs',
    brief: 'Find options',
    run: async (received) => { options = received; return { text: 'findings', ...metrics }; },
  });
  assert.deepEqual(options.allowedTools, ['WebSearch', 'WebFetch']);
  assert.deepEqual(options.routingHints, { requiresPrivateData: true, preferQuality: true });
});

test('Chief review is tool-free and consumes the persisted result', async () => {
  let options;
  await reviewResearch({
    agent,
    goal: 'Research costs',
    reviewBrief: 'Review them',
    research: { content: 'Persisted research evidence' },
    run: async (received) => { options = received; return { text: 'final', ...metrics }; },
  });
  assert.deepEqual(options.allowedTools, []);
  assert.deepEqual(options.routingHints, { requiresPrivateData: true, preferQuality: true });
  assert.match(options.prompt, /Persisted research evidence/);
});

test('model subprocess receives Anthropic auth but no Office, GitHub or OpenAI secrets', async () => {
  const env = buildModelEnvironment({
    PATH: '/bin', ANTHROPIC_API_KEY: 'test-anthropic', SUPABASE_SERVICE_ROLE_KEY: 'hidden-db',
    CONTINUITY_GITHUB_TOKEN: 'hidden-github', OPENAI_API_KEY: 'hidden-openai',
  });
  assert.deepEqual(env, { ANTHROPIC_API_KEY: 'test-anthropic', PATH: '/bin' });

  let received;
  const attempts = [];
  async function* fakeQuery(input) {
    received = input;
    yield { type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.001 };
  }
  const output = await runModel({
    prompt: 'safe', systemPrompt: 'safe', model: 'test-model', maxTurns: 1, queryFn: fakeQuery,
    idempotencyKey: 'run:test', gatewayContext: { jobId: 'job', taskId: 'task', runId: 'run', stage: 'test' },
    onAttempt: async (attempt) => attempts.push(attempt),
  });
  assert.equal(received.options.allowedTools.length, 0);
  assert.ok(!('SUPABASE_SERVICE_ROLE_KEY' in received.options.env));
  assert.ok(!('CONTINUITY_GITHUB_TOKEN' in received.options.env));
  assert.ok(!('OPENAI_API_KEY' in received.options.env));
  assert.equal(output.provider, 'anthropic');
  assert.deepEqual(attempts.map((attempt) => attempt.status), ['started', 'succeeded']);
  assert.ok(attempts.every((attempt) => !('prompt' in attempt)));
});
