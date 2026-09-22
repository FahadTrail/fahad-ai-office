import test from 'node:test';
import assert from 'node:assert/strict';
import { ContinuityController } from '../src/continuity-controller.js';
import { ContinuityError, CostTracker, newTaskEnvelope } from '../src/continuity-core.js';

class Store {
  constructor() { this.events = []; this.checkpoints = []; this.transfers = []; this.usages = []; }
  async createTask(task) { return task; }
  async latestCheckpoint() { return null; }
  async acquireLease() { return { ok: true }; }
  async event(_id, type, _message, payload, level, provider) { this.events.push({ type, payload, level, provider }); }
  async checkpoint(_id, sequence, stage, owner, expected_sha, repoState, payload, progressHash) { const row = { id: 'checkpoint-1', sequence, stage, owner, expected_sha, repoState, payload, progressHash }; this.checkpoints.push(row); return row; }
  async transfer(...args) { this.transfers.push(args); return { owner: args[2] }; }
  async usage(_id, provider, model, usage) { this.usages.push({ provider, model, usage }); }
  async finish(_id, status, result) { this.finished = { status, result }; }
}

test('real primary work survives a simulated 429 and hands off to Claude before PR publication', async () => {
  const task = newTaskEnvelope({ expectedSha: 'a'.repeat(40), budgetUsd: 2 });
  const store = new Store();
  const proposal = { summary: 'proof', path: 'continuity-poc-proof.md', content: `# Continuity proof\n\nInitial work by GPT-5.3-Codex at ${task.expectedSha.slice(0, 12)}\n\n<!-- CONTINUITY_HANDOFF -->\n`, commitMessage: 'docs: add continuity POC proof' };
  const completed = { approved: true, summary: 'verified and continued', path: proposal.path, content: proposal.content.replace('<!-- CONTINUITY_HANDOFF -->', 'Claude Sonnet 5 safely continued this checkpointed task.'), commitMessage: proposal.commitMessage };
  let openaiCalls = 0;
  const providers = {
    openai: { name: 'openai', async complete({ stage }) { openaiCalls++; if (stage === 'verify') throw new ContinuityError('simulated', { status: 429, simulated: true, retryAfter: '0' }); return { data: proposal, usage: { costUsd: 0.01 }, model: 'gpt-5.3-codex' }; } },
    anthropic: { name: 'anthropic', async complete({ input }) { assert.equal(store.transfers.length, 1, 'ownership transfers before Claude runs'); assert.ok(JSON.parse(input).handoffVerification, 'Claude receives the verified structured handoff'); return { data: completed, usage: { costUsd: 0.01 }, model: 'claude-sonnet-5' }; } },
  };
  const workspace = {
    prepare() {}, writeAllowed(_task, path, content) { this.file = { path, content }; }, test() { return { passed: true, output: 'ok' }; },
    snapshot(t, tests) { return { repository: t.repository, branch: t.workingBranch, sha: t.expectedSha, status: '?? continuity-poc-proof.md', files: ['continuity-poc-proof.md'], tests }; },
  };
  const publisher = { async publish() { return { commitSha: 'b'.repeat(40), pullRequestUrl: 'https://github.com/FahadTrail/fahad-ai-office/pull/1', pullRequestNumber: 1 }; } };
  const controller = new ContinuityController({ store, workspace, publisher, providers, sleepFn: async () => {} });
  const result = await controller.run(task);
  assert.equal(result.providers.implementation, 'openai');
  assert.equal(result.providers.continuation, 'anthropic');
  assert.equal(result.taskId, task.id);
  assert.equal(openaiCalls, 3);
  assert.equal(store.checkpoints.length, 2);
  assert.equal(store.transfers.length, 1);
  assert.equal(store.finished.status, 'completed');
  assert.ok(store.events.some((event) => event.type === 'provider_switch'));
  assert.ok(store.events.some((event) => event.type === 'task_continued'));
  assert.equal(workspace.file.content, completed.content);
});

test('a completed idempotent run reports the durable task id', async () => {
  const input = newTaskEnvelope({ expectedSha: 'b'.repeat(40), budgetUsd: 2 });
  const durable = newTaskEnvelope({ expectedSha: input.expectedSha, budgetUsd: 2 });
  const controller = new ContinuityController({
    store: { async createTask() { return { id: durable.id, status: 'completed', result: { tests: { passed: true } } }; } },
  });
  const result = await controller.run(input);
  assert.equal(result.taskId, durable.id);
});

test('a continuity-store failure never causes a second billable provider call', async () => {
  const task = newTaskEnvelope({ expectedSha: 'c'.repeat(40), budgetUsd: 2 });
  let providerCalls = 0;
  const controller = new ContinuityController({
    store: {
      async event() {},
      async usage() { throw new ContinuityError('state persistence unavailable', { status: 503 }); },
    },
    providers: {
      openai: { name: 'openai', model: 'gpt-5.3-codex', async complete() { providerCalls++; return { data: {}, usage: { costUsd: 0.01 }, model: 'gpt-5.3-codex' }; } },
    },
    sleepFn: async () => {},
  });
  await assert.rejects(controller.callProvider(task, 'implement', {}, 'openai', new CostTracker(2)), /state persistence unavailable/);
  assert.equal(providerCalls, 1);
});

test('initial implementation never falls back to the backup provider', async () => {
  const task = newTaskEnvelope({ expectedSha: 'd'.repeat(40), budgetUsd: 2 });
  const store = new Store();
  let anthropicCalls = 0;
  const controller = new ContinuityController({
    store,
    workspace: { prepare() {} },
    publisher: {},
    providers: {
      openai: { name: 'openai', model: 'gpt-5.3-codex', async complete() { throw new ContinuityError('network', { code: 'NETWORK' }); } },
      anthropic: { name: 'anthropic', model: 'claude-sonnet-5', async complete() { anthropicCalls++; return {}; } },
    },
    sleepFn: async () => {},
  });
  await assert.rejects(controller.run(task), /ALL PROVIDERS UNAVAILABLE/);
  assert.equal(anthropicCalls, 0);
  assert.equal(store.finished.status, 'failed');
});
