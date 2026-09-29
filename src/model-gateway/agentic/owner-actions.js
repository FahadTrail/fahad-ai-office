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
    id: 'mistral-key', priority: 1, provider: 'mistral', unlocks: '≈1B tokens/month (REPORTED; exact limit in the Mistral console). PUBLIC data only: free-mode prompts may be used for training.',
    steps: ['Create an API key in the Mistral console (Free mode).', secret('MISTRAL_API_KEY')],
    done: (env) => set(env, 'MISTRAL_API_KEY'),
  },
  {
    id: 'llm7-key', priority: 2, provider: 'llm7', unlocks: '1M tokens/day rolling, 60 req/min (PUBLISHED). PUBLIC data only; best-effort service, always behind fallback.',
    steps: ['Create a free token at token.llm7.io.', secret('LLM7_API_KEY')],
    done: (env) => set(env, 'LLM7_API_KEY'),
  },
  {
    id: 'cloudflare-key', priority: 3, provider: 'cloudflare', unlocks: '10,000 neurons/day, reset 00:00 UTC (PUBLISHED). NORMAL data: no training or retention.',
    steps: ['Keep the account on the Workers FREE plan (a used-up allowance then returns error 4006 instead of billing).', 'Create an API token with the "Workers AI" read permission.', secret('CLOUDFLARE_API_TOKEN'), secret('CLOUDFLARE_ACCOUNT_ID')],
    done: (env) => set(env, 'CLOUDFLARE_API_TOKEN') && set(env, 'CLOUDFLARE_ACCOUNT_ID'),
  },
  {
    id: 'ollama-key', priority: 4, provider: 'ollama', unlocks: 'Small monthly allowance (not published), 1 concurrent request. NORMAL data: prompts are not logged or trained on.',
    steps: ['Create an API key on ollama.com (Free plan).', secret('OLLAMA_API_KEY')],
    done: (env) => set(env, 'OLLAMA_API_KEY'),
  },
  {
    id: 'opencode-key', priority: 5, provider: 'opencode', unlocks: 'OpenCode Zen limited-time free models (no published limit). Zero-retention models are NORMAL; the others PUBLIC.',
    steps: ['Create a Zen API key.', 'In Zen billing: DISABLE auto-reload and keep the balance at $0 (otherwise $20 is charged when the balance drops below $5).', secret('OPENCODE_ZEN_API_KEY')],
    done: (env) => set(env, 'OPENCODE_ZEN_API_KEY'),
  },
  {
    id: 'privacy-review', priority: 6, provider: null,
    unlocks: 'Free coding on PRIVATE repositories. Today no free route may receive private code, so free coding capacity for private repos is 0.',
    steps: [
      'Read the API data terms. Z.ai (GLM Flash, already configured) and Groq state API data is not used for training and not stored (Groq: optional zero data retention in its console); Ollama, Cloudflare Workers AI and OpenCode Zen zero-retention models make similar statements.',
      'Only if you accept them for private code: sudo bash ops/set-secret.sh ZHIPU_API_PRIVATE_DATA_APPROVED (value: true) — likewise GROQ_API_PRIVATE_DATA_APPROVED, OLLAMA_API_PRIVATE_DATA_APPROVED, CLOUDFLARE_API_PRIVATE_DATA_APPROVED and OPENCODE_ZEN_PRIVATE_DATA_APPROVED.',
      'Or mark PUBLIC repositories as dataClass "PUBLIC" when starting a Coding task (Hub API), which needs no approval.',
    ],
    done: (env) => ['ZHIPU_API_PRIVATE_DATA_APPROVED', 'GROQ_API_PRIVATE_DATA_APPROVED', 'OLLAMA_API_PRIVATE_DATA_APPROVED', 'CLOUDFLARE_API_PRIVATE_DATA_APPROVED', 'OPENCODE_ZEN_PRIVATE_DATA_APPROVED'].some((name) => flag(env, name)),
  },
  {
    id: 'openrouter-credit', priority: 7, provider: 'openrouter', unlocks: 'OpenRouter :free models go from 50 to 1,000 requests/day after a ONE-TIME $10 credit purchase (PUBLISHED). Costs money: your decision.',
    steps: ['Optional: buy $10 of OpenRouter credit once. The free-only guard keeps :free calls at $0.'],
    done: () => false, optional: true,
  },
  {
    id: 'qwen-activation', priority: 8, provider: 'qwen', unlocks: 'One-time 1M free tokens per model for 90 days, then pay-as-you-go. Not recurring capacity.',
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
      unlocks: action.unlocks, steps: action.steps,
      active: action.provider ? configured.has(action.provider) : null,
    };
  }).toSorted((left, right) => Number(left.status === 'done') - Number(right.status === 'done') || left.priority - right.priority)
    .map((action) => ({ ...action, checkedAt: new Date(now).toISOString() }));
}
