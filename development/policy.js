import { resolve, sep } from 'node:path';

export const DEFAULT_MODEL = 'auto';
export const DEVELOPMENT_PROVIDER_PROFILES = Object.freeze({
  qwen: Object.freeze({ provider: 'qwen', model: 'qwen/qwen3-coder-flash', modelId: 'qwen3-coder-flash', apiKeyEnv: 'QWEN_API_KEY', approvalEnv: 'QWEN_API_PRIVATE_DATA_APPROVED', baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', privacyReviewed: true, qualityTier: 4, costTier: 2, pricing: { inputPerMillion: 0.35, cachedInputPerMillion: 0.35, outputPerMillion: 1.75 } }),
  zhipu: Object.freeze({ provider: 'zhipu', model: 'zhipu/glm-5.3-flash', modelId: 'glm-5.3-flash', apiKeyEnv: 'ZHIPU_API_KEY', approvalEnv: 'ZHIPU_API_PRIVATE_DATA_APPROVED', baseURL: 'https://api.z.ai/api/paas/v4', privacyReviewed: true, qualityTier: 4, costTier: 1, pricing: { inputPerMillion: 0.15, cachedInputPerMillion: 0.03, outputPerMillion: 0.50 } }),
  deepseek: Object.freeze({ provider: 'deepseek', model: 'deepseek/deepseek-flash', modelId: 'deepseek-flash', apiKeyEnv: 'DEEPSEEK_API_KEY', approvalEnv: 'DEEPSEEK_API_TRAINING_OPTOUT_VERIFIED', baseURL: 'https://api.deepseek.com', privacyReviewed: true, qualityTier: 4, costTier: 1, pricing: { inputPerMillion: 0.30, cachedInputPerMillion: 0.006, outputPerMillion: 1.20 } }),
  kimi: Object.freeze({ provider: 'kimi', model: 'kimi/kimi-k2.7-code', modelId: 'kimi-k2.7-code', apiKeyEnv: 'KIMI_API_KEY', approvalEnv: 'KIMI_API_PRIVATE_DATA_APPROVED', baseURL: 'https://api.moonshot.ai/v1', privacyReviewed: true, qualityTier: 5, costTier: 3, pricing: { inputPerMillion: 0.95, cachedInputPerMillion: 0.19, outputPerMillion: 4 } }),
  minimax: Object.freeze({ provider: 'minimax', model: 'minimax/MiniMax-M2.7', modelId: 'MiniMax-M2.7', apiKeyEnv: 'MINIMAX_API_KEY', approvalEnv: 'MINIMAX_API_PRIVATE_DATA_APPROVED', baseURL: 'https://api.minimax.io/v1', privacyReviewed: false, qualityTier: 4, costTier: 1, pricing: { inputPerMillion: 0.30, cachedInputPerMillion: 0.06, outputPerMillion: 1.20 } }),
});
export const FORBIDDEN_CHANGE_PATTERNS = Object.freeze([
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:secrets?|credentials?)(?:\/|$)/i,
  /(^|\/)hermes(?:\/|$)/i,
  /^\.github\/workflows\//i,
  /^ops\//i,
  /^supabase\/migrations\//i,
  /^(?:Dockerfile|docker-compose\.ya?ml)$/i,
  /^(?:\.gitattributes|\.gitmodules)$/i,
  /(^|\/)opencode\.jsonc?$/i,
  /(^|\/)\.opencode(?:\/|$)/i,
]);

export function validateObjective(value) {
  const objective = typeof value === 'string' ? value.trim() : '';
  if (objective.length < 12 || objective.length > 6000) throw new Error('Development objective must contain 12 to 6000 characters');
  if (/\0/.test(objective)) throw new Error('Development objective contains an invalid character');
  return objective;
}

export function assertDeepSeekApiTrainingOptOut(value) {
  if (!/^(1|true|yes)$/i.test(String(value || ''))) {
    throw approvalError('DeepSeek API training opt-out must be verified before private repository code is transmitted');
  }
  return true;
}

export function resolveDevelopmentProviderRoute({ env = process.env, model = DEFAULT_MODEL, requiresPrivateData = true } = {}) {
  const requestedProvider = model === 'auto' ? null : String(model).split('/')[0];
  const profiles = Object.values(DEVELOPMENT_PROVIDER_PROFILES)
    .filter((profile) => !requestedProvider || profile.provider === requestedProvider)
    .filter((profile) => typeof env[profile.apiKeyEnv] === 'string' && env[profile.apiKeyEnv].trim().length >= 12)
    .filter((profile) => !requiresPrivateData || (profile.privacyReviewed && /^(1|true|yes)$/i.test(String(env[profile.approvalEnv] || ''))))
    .toSorted((left, right) => (right.qualityTier * 4 - right.costTier * 3) - (left.qualityTier * 4 - left.costTier * 3));
  if (!profiles.length) throw approvalError(requestedProvider
    ? `No authorized credential is available for development provider: ${requestedProvider}`
    : 'No privacy-authorized development provider credential is available');
  return profiles;
}

export function safeTaskSlug(objective) {
  const slug = validateObjective(objective).toLowerCase()
    .normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 42);
  return slug || 'development-task';
}

export function createOpenCodeConfig({ secretFile, profile = DEVELOPMENT_PROVIDER_PROFILES.deepseek } = {}) {
  const absoluteSecret = resolve(secretFile);
  return {
    $schema: 'https://opencode.ai/config.json',
    model: profile.model,
    share: 'disabled',
    autoupdate: false,
    provider: {
      [profile.provider]: {
        npm: '@ai-sdk/openai-compatible',
        name: profile.provider,
        options: { apiKey: `{file:${absoluteSecret}}`, baseURL: profile.baseURL, timeout: 120000 },
        models: { [profile.modelId]: { name: profile.modelId } },
      },
    },
    permission: {
      '*': 'deny',
      read: {
        '*': 'allow',
        '.env': 'deny',
        '.env.*': 'deny',
        '**/.env': 'deny',
        '**/.env.*': 'deny',
      },
      edit: 'allow',
      glob: 'allow',
      grep: 'allow',
      lsp: 'allow',
      bash: 'deny',
      task: 'deny',
      skill: 'deny',
      question: 'deny',
      webfetch: 'deny',
      websearch: 'deny',
      external_directory: 'deny',
      doom_loop: 'deny',
    },
  };
}

export function buildModelEnvironment({ hostEnv = process.env, configPath, isolatedHome }) {
  const env = {
    PATH: hostEnv.PATH,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    TMPDIR: hostEnv.TMPDIR || hostEnv.TEMP,
    TEMP: hostEnv.TEMP || hostEnv.TMPDIR,
    OPENCODE_CONFIG: configPath,
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    CI: 'true',
    NO_COLOR: '1',
  };
  return Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string' && value));
}

export function buildTestEnvironment({ hostEnv = process.env, isolatedHome }) {
  const env = {
    PATH: hostEnv.PATH,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    TMPDIR: hostEnv.TMPDIR || hostEnv.TEMP || '/tmp',
    TEMP: hostEnv.TEMP || hostEnv.TMPDIR || '/tmp',
    CI: 'true',
    NODE_ENV: 'test',
    NO_COLOR: '1',
  };
  return Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string' && value));
}

export function assertSafeChangedPaths(paths) {
  const normalized = paths.map((path) => String(path).replaceAll('\\', '/').replace(/^\.\//, ''));
  const blocked = normalized.filter((path) => FORBIDDEN_CHANGE_PATTERNS.some((pattern) => pattern.test(path)));
  if (blocked.length) throw approvalError(`Protected paths require human approval: ${blocked.join(', ')}`);
  return normalized;
}

export function assertContainedPath(parent, child) {
  const root = resolve(parent);
  const candidate = resolve(child);
  if (candidate !== root && !candidate.startsWith(root + sep)) throw new Error('Path escapes the isolated development root');
  return candidate;
}

export function assertNoSecretMaterial(text) {
  const value = String(text || '');
  const patterns = [
    /\bsk-[A-Za-z0-9_-]{16,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{16,}\b/,
    /\bghp_[A-Za-z0-9]{16,}\b/,
    /\b(?:SUPABASE_SERVICE_ROLE_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|DEEPSEEK_API_KEY|QWEN_API_KEY|KIMI_API_KEY|ZHIPU_API_KEY|MINIMAX_API_KEY|CONTINUITY_GITHUB_TOKEN)\s*=\s*\S+/i,
  ];
  if (patterns.some((pattern) => pattern.test(value))) throw approvalError('Potential secret material was detected in the proposed diff');
  return true;
}

export function parseOpenCodeEvents(output) {
  const events = String(output || '').split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  if (!events.length) throw new Error('OpenCode returned no machine-readable progress events');
  if (!events.some((event) => event.type === 'step_finish' || event.part?.type === 'step-finish')) {
    throw new Error('OpenCode returned no final usage record');
  }
  return events;
}

export function summarizeOpenCodeUsage(events, pricing = DEVELOPMENT_PROVIDER_PROFILES.deepseek.pricing) {
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    steps: 0,
  };
  for (const event of events || []) {
    if (event.type !== 'step_finish' && event.part?.type !== 'step-finish') continue;
    const part = event.part || {};
    const tokens = part.tokens || {};
    const input = nonNegativeNumber(tokens.input);
    const output = nonNegativeNumber(tokens.output);
    const reasoning = nonNegativeNumber(tokens.reasoning);
    const cacheRead = nonNegativeNumber(tokens.cache?.read);
    const cacheWrite = nonNegativeNumber(tokens.cache?.write);
    const reported = nonNegativeNumber(part.cost);
    const conservative = ((input + cacheWrite) * pricing.inputPerMillion
      + cacheRead * pricing.cachedInputPerMillion
      + (output + reasoning) * pricing.outputPerMillion) / 1_000_000;
    usage.inputTokens += input;
    usage.outputTokens += output;
    usage.reasoningTokens += reasoning;
    usage.cachedInputTokens += cacheRead;
    usage.cacheWriteTokens += cacheWrite;
    usage.totalTokens += nonNegativeNumber(tokens.total) || input + output + reasoning + cacheRead + cacheWrite;
    usage.costUsd += Math.max(reported, conservative);
    usage.steps += 1;
  }
  if (!usage.steps) throw new Error('OpenCode usage accounting is unavailable');
  usage.costUsd = Number(usage.costUsd.toFixed(8));
  return usage;
}

export function redact(value, secrets = []) {
  let safe = String(value || '');
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 8) safe = safe.replaceAll(secret, '[REDACTED]');
  return safe
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-|github_pat_|ghp_)[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .slice(-12000);
}

export function buildAgentPrompt(objective, testFailure = null) {
  const failure = testFailure ? `\n\nController test failure to fix (sanitized):\n${testFailure}` : '';
  return `Implement the development objective below in this repository. Analyze existing patterns, make the smallest safe code change, and add or update tests. Do not access secrets, .env files, Git metadata, external directories, or network services. Do not run shell commands; the controller will run tests and return failures for repair. Do not create commits, branches, pull requests, workflow files, deployment files, migrations, or Hermes-related changes.\n\nObjective:\n${validateObjective(objective)}${failure}`;
}

function approvalError(message) {
  const error = new Error(message);
  error.code = 'NEEDS_HUMAN_APPROVAL';
  return error;
}

function nonNegativeNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
