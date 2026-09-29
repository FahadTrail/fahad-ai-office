// Owner action queue (Capacity V2, Part 17).
//
// Capacity the Office cannot unlock by itself: a key only the owner can
// create, a privacy review only the owner can make, a billing setting on the
// provider's console. Each item says what it unlocks (from pool-registry
// facts, labelled), the exact safe command, and whether it is already done —
// read from the PRESENCE of a setting, never its value. Keys are always set on
// the server with ops/set-secret.sh (hidden prompt), never pasted into a chat.

const set = (env, name) => Boolean(String(env?.[name] || '').trim());
const flag = (env, name) => /^(1|true|yes)$/i.test(String(env?.[name] || ''));
const secret = (name) => `sudo bash ops/set-secret.sh ${name}`;

const ACTIONS = [
  {
    id: 'mistral-key', facts: { signup: 'https://console.mistral.ai (Experiment plan)', secretEnv: 'MISTRAL_API_KEY', card: 'no (REPORTED)', phone: 'yes — SMS verification (REPORTED)', autoReloadRisk: 'none on the Experiment plan', adapterReady: true, independentPool: true, freeQuota: '≈1B tokens/month, ≈1 RPS (REPORTED; not counted until a live canary)', codingValue: 'high on paper (Codestral included, REPORTED); PUBLIC code only', privacyClass: 'PUBLIC', setupMinutes: 10 }, priority: 1, provider: 'mistral', unlocks: '≈1B tokens/month (REPORTED; exact limit in the Mistral console). PUBLIC data only: free-mode prompts may be used for training.',
    steps: [
      'Sign in at console.mistral.ai, choose the free Experiment plan and verify your phone number (SMS). No card is needed (REPORTED).',
      'Optional, recommended: Admin Console → Privacy → turn OFF "Allow Mistral to use your data for model improvement" (free-mode prompts are used for training by default, REPORTED). Routes stay PUBLIC-only either way until a reviewed privacy flag.',
      'API Keys → Create new key.',
      secret('MISTRAL_API_KEY'),
    ],
    done: (env) => set(env, 'MISTRAL_API_KEY'),
  },
  {
    id: 'llm7-key', facts: { signup: 'https://token.llm7.io', secretEnv: 'LLM7_API_KEY', card: 'no', phone: 'no', autoReloadRisk: 'none', adapterReady: true, independentPool: true, freeQuota: '1M tokens/day rolling, 60 RPM, 250/h (PUBLISHED)', codingValue: 'PUBLIC code only; models vary', privacyClass: 'PUBLIC', setupMinutes: 5 }, priority: 2, provider: 'llm7', unlocks: '1M tokens/day rolling, 60 req/min (PUBLISHED). PUBLIC data only; best-effort service, always behind fallback.',
    steps: ['Create a free token at token.llm7.io.', secret('LLM7_API_KEY')],
    done: (env) => set(env, 'LLM7_API_KEY'),
  },
  {
    id: 'cloudflare-key', facts: { signup: 'https://dash.cloudflare.com → Workers AI → API token', secretEnv: 'CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID', card: 'no (Workers Free plan)', phone: 'no', autoReloadRisk: 'none on the Free plan (overage returns error 4006); upgrading to Workers Paid would bill', adapterReady: true, independentPool: true, freeQuota: '10,000 neurons/day (PUBLISHED; tokens per neuron UNKNOWN until measured)', codingValue: 'small: qwen2.5-coder-32b, gpt-oss-120b; a PRIVATE-coding candidate after the privacy flag', privacyClass: 'NORMAL', setupMinutes: 10 }, priority: 3, provider: 'cloudflare', unlocks: '10,000 neurons/day, reset 00:00 UTC (PUBLISHED). NORMAL data: no training or retention.',
    steps: ['Keep the account on the Workers FREE plan (a used-up allowance then returns error 4006 instead of billing).', 'Create an API token with the "Workers AI" read permission.', secret('CLOUDFLARE_API_TOKEN'), secret('CLOUDFLARE_ACCOUNT_ID')],
    done: (env) => set(env, 'CLOUDFLARE_API_TOKEN') && set(env, 'CLOUDFLARE_ACCOUNT_ID'),
  },
  {
    id: 'ollama-key', facts: { signup: 'https://ollama.com/settings/keys', secretEnv: 'OLLAMA_API_KEY', card: 'no (Free plan)', phone: 'no', autoReloadRisk: 'none', adapterReady: true, independentPool: true, freeQuota: 'small monthly allowance, not published; 1 concurrent', codingValue: 'qwen3-coder, gpt-oss-120b; PRIVATE-coding candidate after the privacy flag, capacity UNKNOWN', privacyClass: 'NORMAL', setupMinutes: 5 }, priority: 4, provider: 'ollama', unlocks: 'Small monthly allowance (not published), 1 concurrent request. NORMAL data: prompts are not logged or trained on.',
    steps: ['Create an API key on ollama.com (Free plan).', secret('OLLAMA_API_KEY')],
    done: (env) => set(env, 'OLLAMA_API_KEY'),
  },
  {
    id: 'opencode-key', facts: { signup: 'https://opencode.ai/zen', secretEnv: 'OPENCODE_ZEN_API_KEY', card: 'UNKNOWN (paid models need a balance; free models do not)', phone: 'no', autoReloadRisk: 'YES — reloads $20 when the balance falls below $5 unless disabled', adapterReady: true, independentPool: true, freeQuota: 'limited-time free models, no numeric limit published', codingValue: 'Big Pickle / Space Bunny untested; promotions can end at any time (routes disappear automatically)', privacyClass: 'per model: NORMAL (Space Bunny, LongCat) or PUBLIC', setupMinutes: 10 }, priority: 5, provider: 'opencode', unlocks: 'OpenCode Zen limited-time free models (no published limit). Zero-retention models are NORMAL; the others PUBLIC.',
    steps: ['Create a Zen API key.', 'In Zen billing: DISABLE auto-reload and keep the balance at $0 (otherwise $20 is charged when the balance drops below $5).', secret('OPENCODE_ZEN_API_KEY')],
    done: (env) => set(env, 'OPENCODE_ZEN_API_KEY'),
  },
  {
    id: 'privacy-review', facts: { signup: null, secretEnv: 'ZHIPU/GROQ/OLLAMA/CLOUDFLARE/OPENCODE_ZEN _PRIVATE_DATA_APPROVED', card: 'no', phone: 'no', autoReloadRisk: 'none', adapterReady: true, independentPool: null, freeQuota: 'unlocks PRIVATE coding on routes that already exist', codingValue: 'the only path to free PRIVATE coding', privacyClass: 'owner decision', setupMinutes: 30 }, priority: 6, provider: null,
    unlocks: 'Free coding on PRIVATE repositories. Today no free route may receive private code, so free coding capacity for private repos is 0.',
    steps: [
      'Read the API data terms. Groq (already configured): its Services Agreement forbids training on inputs/outputs, no retention by default, optional zero data retention — but its free 8K tokens/minute cannot carry coding. Z.ai (GLM Flash, already configured): states API content is not stored; read its Data Processing Addendum for training use before approving. Ollama, Cloudflare Workers AI and OpenCode Zen zero-retention models state no training/retention.',
      'Only if you accept them for private code: sudo bash ops/set-secret.sh ZHIPU_API_PRIVATE_DATA_APPROVED (value: true) — likewise GROQ_API_PRIVATE_DATA_APPROVED, OLLAMA_API_PRIVATE_DATA_APPROVED, CLOUDFLARE_API_PRIVATE_DATA_APPROVED and OPENCODE_ZEN_PRIVATE_DATA_APPROVED.',
      'Or mark PUBLIC repositories as dataClass "PUBLIC" when starting a Coding task (Hub API), which needs no approval.',
    ],
    done: (env) => ['ZHIPU_API_PRIVATE_DATA_APPROVED', 'GROQ_API_PRIVATE_DATA_APPROVED', 'OLLAMA_API_PRIVATE_DATA_APPROVED', 'CLOUDFLARE_API_PRIVATE_DATA_APPROVED', 'OPENCODE_ZEN_PRIVATE_DATA_APPROVED'].some((name) => flag(env, name)),
  },
  {
    id: 'openrouter-credit', facts: { signup: 'https://openrouter.ai/credits', secretEnv: null, card: 'yes ($10 one-time)', phone: 'no', autoReloadRisk: 'OpenRouter auto top-up is opt-in — leave it off', adapterReady: true, independentPool: false, freeQuota: '50 → 1,000 requests/day on the same key-wide pool (PUBLISHED)', codingValue: 'PUBLIC coding: 20× more requests for nemotron-3-ultra', privacyClass: 'PUBLIC', setupMinutes: 5 }, priority: 7, provider: 'openrouter', unlocks: 'OpenRouter :free models go from 50 to 1,000 requests/day after a ONE-TIME $10 credit purchase (PUBLISHED). Costs money: your decision.',
    steps: ['Optional: buy $10 of OpenRouter credit once. The free-only guard keeps :free calls at $0.'],
    done: () => false, optional: true,
  },
  {
    id: 'qwen-activation', facts: { signup: 'https://modelstudio.console.alibabacloud.com (Singapore)', secretEnv: 'QWEN_API_KEY (already set)', card: 'yes (Alibaba Cloud account)', phone: 'yes', autoReloadRisk: 'pay-as-you-go after the free tokens', adapterReady: true, independentPool: true, freeQuota: 'one-time 1M tokens per model for 90 days', codingValue: 'one-time only', privacyClass: 'PRIVATE with QWEN_API_PRIVATE_DATA_APPROVED', setupMinutes: 20 }, priority: 8, provider: 'qwen', unlocks: 'One-time 1M free tokens per model for 90 days, then pay-as-you-go. Not recurring capacity.',
    steps: ['Optional: activate Model Studio (Singapore) in the Alibaba Cloud console.'],
    done: () => false, optional: true,
  },
];

// The queue, highest value first; `done` items stay listed as done.
export function ownerActions({ env = process.env, pools = [], now = Date.now() } = {}) {
  const configured = new Set(pools.map((pool) => pool.provider));
  return ACTIONS.map((action) => {
    const done = action.done(env);
    return {
      id: action.id, priority: action.priority, provider: action.provider, status: done ? 'done' : action.optional ? 'optional' : 'pending',
      unlocks: action.unlocks, steps: action.steps, facts: action.facts || null,
      active: action.provider ? configured.has(action.provider) : null,
    };
  }).toSorted((left, right) => Number(left.status === 'done') - Number(right.status === 'done') || left.priority - right.priority)
    .map((action) => ({ ...action, checkedAt: new Date(now).toISOString() }));
}
