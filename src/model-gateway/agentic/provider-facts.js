// Volatile provider facts, with their source and the date they were checked.
// Shown on the Platform dashboard next to live evidence (canaries, real
// traffic, qualification), so a stale fact is visible as such. Re-check the
// source before relying on a fact older than a month; nothing here is ever
// treated as a live quota.

export const PROVIDER_FACTS_CHECKED = '2026-09-26';

export const PROVIDER_FACTS = Object.freeze({
  gemini: {
    label: 'Google Gemini API (AI Studio)', offer: 'FREE', credentialEnv: 'GEMINI_API_KEY',
    credentialPage: 'https://aistudio.google.com/apikey', scope: 'API key of an AI Studio project without billing (free tier)',
    freeTier: 'Free tier per project and model: Flash ≈20 requests/day, Flash-Lite ≈500/day (limits shown only in AI Studio); resets at midnight Pacific.',
    privacy: 'Free-tier prompts may be used to improve Google products: public/non-private data only.',
    source: 'https://ai.google.dev/gemini-api/docs/rate-limits',
  },
  groq: {
    label: 'Groq', offer: 'FREE', credentialEnv: 'GROQ_API_KEY',
    credentialPage: 'https://console.groq.com/keys', scope: 'API key of a free-plan organization',
    freeTier: 'Free plan: openai/gpt-oss-120b, openai/gpt-oss-20b, qwen/qwen3.8-27b at 30 RPM, 1K requests/day, 8K tokens/minute, 200K tokens/day each; Llama models are enterprise-only.',
    privacy: 'Not reviewed for private code: public/non-private data only.',
    source: 'https://console.groq.com/docs/rate-limits',
  },
  openrouter: {
    label: 'OpenRouter', offer: 'FREE', credentialEnv: 'OPENROUTER_API_KEY',
    credentialPage: 'https://openrouter.ai/settings/keys', scope: 'API key (no credits needed for :free models)',
    freeTier: ':free models: 20 requests/minute and 50 requests/day for the whole key (1,000/day after a one-time $10 credit purchase); free models rotate.',
    privacy: 'Free endpoints may log or train on prompts: never private code.',
    source: 'https://openrouter.ai/docs/api-reference/limits',
  },
  cerebras: {
    label: 'Cerebras Inference', offer: 'PROMO', credentialEnv: 'CEREBRAS_API_KEY',
    credentialPage: 'https://cloud.cerebras.ai/', scope: 'API key; the $5 Free Trial credit is granted after adding a verified payment method',
    freeTier: 'No permanent free tier since 2026-08-17. Free Trial: $5 credits, expire 30 days after grant; then API access stops until credits are bought (no automatic charge). Models: gpt-oss-120b (65K context on trial), qwen-3.8-27b (64K). Token-bucket limits (gpt-oss-120b: 5 RPM, 1M tokens/day).',
    privacy: 'Not reviewed for private code: public/non-private data only.',
    source: 'https://inference-docs.cerebras.ai/support/rate-limits',
  },
  github: {
    label: 'GitHub Models', offer: 'RETIRED', credentialEnv: null,
    credentialPage: null, scope: null,
    freeTier: 'GitHub Models was fully retired on 2026-07-30 (playground, catalog, inference API). No token or permission can enable it; the Coding Agent\'s GitHub token stays repository-only.',
    privacy: '—',
    source: 'https://github.blog/changelog/2026-07-30-github-models-is-now-retired/',
  },
  zhipu: {
    label: 'Z.ai (GLM)', offer: 'FREE', credentialEnv: 'ZHIPU_API_KEY',
    credentialPage: 'https://z.ai/manage-apikey/apikey-list', scope: 'API key (international platform)',
    freeTier: 'GLM-4.7-Flash ("completely free", 200K context, function calling) and GLM-4.5-Flash at $0; free use limited to 1 concurrent request. Paid: GLM-5.3 family.',
    privacy: 'Z.ai states it does not store API content; private code still needs the owner\'s explicit approval (ZHIPU_API_PRIVATE_DATA_APPROVED).',
    source: 'https://docs.z.ai/guides/overview/pricing',
  },
  qwen: {
    label: 'Qwen (Alibaba Cloud Model Studio)', offer: 'PAID (one-time free quota)', credentialEnv: 'QWEN_API_KEY',
    credentialPage: 'https://modelstudio.console.alibabacloud.com/', scope: 'Workspace API key (sk-ws-…; legacy sk- keys still accepted) from the Singapore (International) workspace whose endpoint is QWEN_API_ENDPOINT',
    freeTier: 'New users: 1M free tokens per model for 90 days after activating Model Studio, Singapore/International only; then pay-as-you-go.',
    privacy: 'Private code needs the owner\'s explicit approval (QWEN_API_PRIVATE_DATA_APPROVED).',
    source: 'https://www.alibabacloud.com/help/en/model-studio/new-free-quota',
  },
  kimi: {
    label: 'Kimi (Moonshot)', offer: 'PAID', credentialEnv: 'KIMI_API_KEY',
    credentialPage: 'https://platform.moonshot.ai/console/api-keys', scope: 'API key; minimum $1 top-up',
    freeTier: 'No free API allowance (a $5 voucher after $5 of top-ups). Models: kimi-k3 (flagship), kimi-k2.7-code, kimi-k2.6; kimi-k2.5 and moonshot-v1 retired 2026-08-31.',
    privacy: 'Private code needs the owner\'s explicit approval (KIMI_API_PRIVATE_DATA_APPROVED).',
    source: 'https://platform.moonshot.ai/docs/pricing/chat',
  },
  minimax: {
    label: 'MiniMax', offer: 'PAID', credentialEnv: 'MINIMAX_API_KEY',
    credentialPage: 'https://platform.minimax.io/user-center/basic-information/interface-key', scope: 'API key (pay-as-you-go)',
    freeTier: 'No free API allowance found. Models include MiniMax-M3 (1M context, tool use) and MiniMax-M2.7.',
    privacy: 'Blocked for private data in code: the API data-use terms could not be confirmed (privacy policy page returned no content).',
    source: 'https://platform.minimax.io/docs/guides/pricing',
  },
  mistral: {
    label: 'Mistral (La Plateforme)', offer: 'PAID until stated', credentialEnv: 'MISTRAL_API_KEY',
    credentialPage: 'https://admin.mistral.ai/organization/api-keys', scope: 'API key',
    freeTier: 'The free "Experiment" API allowance could not be confirmed on official pages in September 2026 (tier page 404; plans reportedly restructured). Treated as paid unless the owner states otherwise; free-plan prompts may be used for training.',
    privacy: 'Private code needs the owner\'s explicit approval (MISTRAL_API_PRIVATE_DATA_APPROVED).',
    source: 'https://docs.mistral.ai/getting-started/models/models_overview/',
  },
  deepseek: {
    label: 'DeepSeek', offer: 'PAID', credentialEnv: 'DEEPSEEK_API_KEY', credentialPage: 'https://platform.deepseek.com/api_keys', scope: 'API key',
    freeTier: 'Paid (very low cost).', privacy: 'Approved for private code (training opt-out verified).', source: 'https://api-docs.deepseek.com/quick_start/pricing',
  },
  anthropic: {
    label: 'Anthropic', offer: 'PAID', credentialEnv: 'ANTHROPIC_API_KEY', credentialPage: 'https://console.anthropic.com/settings/keys', scope: 'API key',
    freeTier: 'Paid.', privacy: 'Approved for private code.', source: 'https://www.anthropic.com/pricing',
  },
  openai: {
    label: 'OpenAI', offer: 'PAID', credentialEnv: 'OPENAI_API_KEY', credentialPage: 'https://platform.openai.com/api-keys', scope: 'API key',
    freeTier: 'Paid.', privacy: 'Approved for private code.', source: 'https://openai.com/api/pricing/',
  },
});

// Human-readable account/credential blockers (provider_status error reasons).
export const BLOCKER_LABELS = Object.freeze({
  ACCOUNT_NOT_ACTIVATED: 'ACCOUNT ACTIVATION REQUIRED',
  ACCOUNT_OVERDUE: 'ACCOUNT BALANCE OVERDUE',
  REGION_NOT_SUPPORTED: 'REGION NOT SUPPORTED',
  MODEL_NOT_ENTITLED: 'MODEL ACCESS REQUIRED',
  PERMISSION_MISSING: 'TOKEN PERMISSION REQUIRED',
  CREDENTIAL_INVALID: 'CREDENTIAL REJECTED',
  NO_CREDITS: 'CREDITS REQUIRED',
});

export function blockerLabel(provider, reason) {
  if (provider === 'qwen' && reason === 'ACCOUNT_NOT_ACTIVATED') return 'MODEL STUDIO ACTIVATION REQUIRED';
  return BLOCKER_LABELS[reason] || null;
}

// The reason part of a stored error code: PROVIDER_AUTH_ACCOUNT_NOT_ACTIVATED → ACCOUNT_NOT_ACTIVATED.
export function blockerReason(code) {
  const value = String(code || '');
  return Object.keys(BLOCKER_LABELS).find((reason) => value.endsWith(`_${reason}`) || value === reason) || null;
}
