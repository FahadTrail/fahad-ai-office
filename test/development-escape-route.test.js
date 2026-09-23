import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertDeepSeekApiTrainingOptOut,
  assertNoSecretMaterial,
  assertSafeChangedPaths,
  buildAgentPrompt,
  buildModelEnvironment,
  createOpenCodeConfig,
  parseOpenCodeEvents,
  safeTaskSlug,
  summarizeOpenCodeUsage,
} from '../development/policy.js';
import { MAIN_REMOTE_REFSPEC, safeGitArgs } from '../development/escape-route.js';

test('isolated development materializes origin/main from narrow source clones', () => {
  assert.equal(MAIN_REMOTE_REFSPEC, '+refs/heads/main:refs/remotes/origin/main');
});

test('controller Git operations authorize only the isolated worktree', () => {
  const args = safeGitArgs('/isolated/worktree', ['diff', '--check']);
  assert.equal(args[0], '-c');
  assert.match(args[1], /^safe\.directory=/);
  assert.deepEqual(args.slice(-2), ['diff', '--check']);
});

test('private repository execution requires verified DeepSeek API training opt-out', () => {
  assert.equal(assertDeepSeekApiTrainingOptOut('true'), true);
  assert.throws(() => assertDeepSeekApiTrainingOptOut(''), (error) => error.code === 'NEEDS_HUMAN_APPROVAL');
  assert.throws(() => assertDeepSeekApiTrainingOptOut('false'), /training opt-out/i);
});

test('OpenCode policy keeps provider and GitHub secrets outside the model tool environment', () => {
  const config = createOpenCodeConfig({ secretFile: '/private/deepseek.key' });
  const env = buildModelEnvironment({
    hostEnv: {
      PATH: '/usr/bin', HOME: '/real-home', DEEPSEEK_API_KEY: 'never-forward-this',
      CONTINUITY_GITHUB_TOKEN: 'never-forward-that', ANTHROPIC_API_KEY: 'never-forward-either',
    },
    configPath: '/private/opencode.json',
    isolatedHome: '/private/home',
  });
  assert.match(config.provider.deepseek.options.apiKey, /^\{file:.*deepseek\.key\}$/);
  assert.equal(config.permission.bash, 'deny');
  assert.equal(config.permission.external_directory, 'deny');
  assert.equal(config.permission.webfetch, 'deny');
  assert.equal(config.permission.read['.env'], 'deny');
  assert.equal(config.permission.read['**/.env.*'], 'deny');
  assert.equal(env.HOME, '/private/home');
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
  assert.equal(env.CONTINUITY_GITHUB_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test('automatic development blocks privileged paths and secret-looking diffs', () => {
  assert.deepEqual(assertSafeChangedPaths(['src/feature.js', 'test/feature.test.js']), ['src/feature.js', 'test/feature.test.js']);
  for (const path of ['.env', 'Hermes/agent.js', '.github/workflows/release.yml', 'ops/deploy.sh',
    'supabase/migrations/unsafe.sql', 'Dockerfile', '.gitattributes', '.opencode/agent/build.md']) {
    assert.throws(() => assertSafeChangedPaths([path]), (error) => error.code === 'NEEDS_HUMAN_APPROVAL');
  }
  assert.throws(() => assertNoSecretMaterial('+ DEEPSEEK_API_KEY=sk-secret-material-1234567890'), /secret material/i);
});

test('objective becomes a bounded non-shell agent prompt and safe branch slug', () => {
  const objective = 'Add deterministic validation for widget identifiers.';
  const prompt = buildAgentPrompt(objective, 'one test failed');
  assert.match(prompt, /Do not run shell commands/);
  assert.match(prompt, /one test failed/);
  assert.equal(safeTaskSlug(objective), 'add-deterministic-validation-for-widget-id');
  assert.throws(() => buildAgentPrompt('too short'), /12 to 6000/);
});

test('headless OpenCode output must contain machine-readable progress', () => {
  assert.equal(parseOpenCodeEvents('{"type":"step_start"}\n{"type":"step_finish"}\n').length, 2);
  assert.throws(() => parseOpenCodeEvents('plain text only'), /machine-readable/);
  assert.throws(() => parseOpenCodeEvents('{"type":"step_start"}\n'), /final usage record/);
});

test('development usage is recorded at conservative peak rates', () => {
  const usage = summarizeOpenCodeUsage([{
    type: 'step_finish',
    part: {
      type: 'step-finish',
      tokens: { input: 1_000_000, output: 100_000, reasoning: 10_000, cache: { read: 500_000, write: 0 } },
      cost: 0.10,
    },
  }]);
  assert.equal(usage.inputTokens, 1_000_000);
  assert.equal(usage.totalTokens, 1_610_000);
  assert.equal(usage.costUsd, 0.435);
  assert.equal(usage.steps, 1);
});
