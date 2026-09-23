import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertDeepSeekApiTrainingOptOut,
  assertNoSecretMaterial,
  assertSafeChangedPaths,
  buildAgentPrompt,
  buildModelEnvironment,
  createOpenCodeConfig,
  DEVELOPMENT_PROVIDER_PROFILES,
  parseOpenCodeEvents,
  safeTaskSlug,
  resolveDevelopmentProviderRoute,
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

test('OpenCode selects only configured and explicitly privacy-authorized providers', () => {
  const env = {
    DEEPSEEK_API_KEY: 'deepseek-secret-1234', DEEPSEEK_API_TRAINING_OPTOUT_VERIFIED: 'true',
    QWEN_API_KEY: 'qwen-secret-123456', QWEN_API_PRIVATE_DATA_APPROVED: 'true',
    QWEN_API_BASE_URL: 'https://workspace-123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    KIMI_API_KEY: 'kimi-secret-123456', KIMI_API_PRIVATE_DATA_APPROVED: 'false',
    MINIMAX_API_KEY: 'minimax-secret-1234', MINIMAX_API_PRIVATE_DATA_APPROVED: 'true',
  };
  const route = resolveDevelopmentProviderRoute({ env });
  assert.deepEqual(route.map(({ provider }) => provider), ['deepseek', 'qwen']);
  assert.throws(() => resolveDevelopmentProviderRoute({ env, model: 'kimi/kimi-k2.7-code' }), (error) => error.code === 'NEEDS_HUMAN_APPROVAL');
  assert.throws(() => resolveDevelopmentProviderRoute({ env, model: 'minimax/MiniMax-M2.7' }), /authorized credential/i);
});

test('OpenCode config is generated for each prepared compatible provider without embedding its key', () => {
  for (const profile of Object.values(DEVELOPMENT_PROVIDER_PROFILES)) {
    const configuredProfile = profile.provider === 'qwen'
      ? { ...profile, baseURL: 'https://workspace-123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1' }
      : profile;
    const config = createOpenCodeConfig({ secretFile: `/private/${profile.provider}.key`, profile: configuredProfile });
    assert.equal(config.model, profile.model);
    assert.equal(config.provider[profile.provider].options.baseURL, configuredProfile.baseURL);
    assert.match(config.provider[profile.provider].options.apiKey, /^\{file:/);
    assert.equal(JSON.stringify(config).includes('secret-value'), false);
  }
});

test('Qwen development routing requires a Singapore workspace endpoint', () => {
  const env = { QWEN_API_KEY: 'qwen-secret-123456', QWEN_API_PRIVATE_DATA_APPROVED: 'true' };
  assert.throws(() => resolveDevelopmentProviderRoute({ env, model: 'qwen/qwen3-coder-flash' }), /authorized credential/i);
  assert.throws(() => createOpenCodeConfig({ secretFile: '/private/qwen.key', profile: DEVELOPMENT_PROVIDER_PROFILES.qwen }), /endpoint is not configured/i);
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

test('development usage honors a provider-specific cache-write rate', () => {
  const events = [{ type: 'step_finish', part: { tokens: { cache: { write: 1_000_000 } }, cost: 0 } }];
  const usage = summarizeOpenCodeUsage(events, DEVELOPMENT_PROVIDER_PROFILES.minimax.pricing);
  assert.equal(usage.cacheWriteTokens, 1_000_000);
  assert.equal(usage.costUsd, 0.375);
});
