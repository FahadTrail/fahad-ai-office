import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgenticCanary } from '../src/canary/agentic-canary.js';

// Simulated providers that behave like tool-using models; the canary logic is
// what is under test here. Live verification runs where real keys exist.
function calculatorModel() {
  let id = 0;
  return {
    async turn({ messages }) {
      const text = messages.flatMap((message) => message.content).map((block) => block.text || block.content || '').join('\n');
      const results = messages.flatMap((message) => message.content).filter((block) => block.type === 'tool_result');
      const reply = (content) => ({ message: { role: 'assistant', content }, stopReason: 'end', usage: { inputTokens: 5, outputTokens: 2, costUsd: 0 }, durationMs: 1 });
      const call = (name, args) => reply([{ type: 'tool_call', id: `t${id++}`, name, arguments: args }]);
      const known = text.match(/add_numbers\(17, 25\) already returned (\d+)/);
      if (/multiply/.test(text)) {
        const product = results.find((block) => block.name === 'multiply_numbers');
        if (product) return reply([{ type: 'text', text: product.content }]);
        const sum = results.find((block) => block.name === 'add_numbers')?.content || known?.[1];
        return sum ? call('multiply_numbers', { a: Number(sum), b: 2 }) : call('add_numbers', { a: 17, b: 25 });
      }
      const sum = results.find((block) => block.name === 'add_numbers');
      return sum ? reply([{ type: 'text', text: sum.content }]) : call('add_numbers', { a: 17, b: 25 });
    },
  };
}

const route = (id, extra = {}) => ({
  id, provider: id.split(':')[0], model: id.split(':')[1], billingClass: 'paid', qualityTier: 5, costTier: 1, contextWindow: 100_000,
  privacyApproved: true, pricing: { inputPerMillion: 1, outputPerMillion: 1 }, unavailableReasons: [], protocolClient: calculatorModel(), ...extra,
});

test('agentic canary verifies tool calling per route and proves continuation across an injected failure', async () => {
  const report = await runAgenticCanary({ pool: [route('anthropic:claude-opus-5'), route('deepseek:deepseek-flash'), route('gemini:g', { unavailableReasons: ['CREDENTIAL_MISSING'] })], log: () => {} });
  assert.deepEqual(report.routes.map((entry) => [entry.id, entry.ok]), [['anthropic:claude-opus-5', true], ['deepseek:deepseek-flash', true]]);
  assert.equal(report.failover.ok, true);
  assert.equal(report.failover.finishedOn, 'deepseek:deepseek-flash');
  assert.equal(report.failover.checkpointsBeforeSwitch, 1);
  assert.equal(report.failover.backupRedidCompletedStep, false, 'the backup continued instead of restarting');
  assert.equal(report.failover.answer, '84');
});

test('agentic canary reports failures without inventing success', async () => {
  const broken = route('openai:x', { protocolClient: { turn: async () => { throw Object.assign(new Error('no'), { status: 401 }); } } });
  const report = await runAgenticCanary({ pool: [broken], log: () => {} });
  assert.equal(report.routes[0].ok, false);
  assert.equal(report.routes[0].error, 'ALL_PROVIDERS_UNAVAILABLE');
  assert.equal(report.failover.ok, false);
});
