# Capacity Expansion V2 — free-first coding and continuous execution

This is the living document for branch `claude/capacity-expansion-v2`. It
holds the baseline, provider research, decisions, the capacity model and
owner actions. Every number has a source and a confidence label:

* **MEASURED**: production telemetry.
* **PUBLISHED**: from the provider's own terms or docs.
* **REPORTED**: from a secondary source.
* **ESTIMATED**: derived by us.
* **UNKNOWN**: not available.

## 1. Baseline (production, measured 2026-09-29)

Sources: `provider_status`, `model_attempts` (last 14 days), `agent_sessions`,
`tasks`, `jobs`, all read from Supabase `zkzibipinjeswhdxnfgf`.

### Routes and pools

| | Count | Detail |
|---|---|---|
| Independent free pools with a working key | 7 | Gemini: 4 per-model pools (Flash, Flash-Lite, Gemma 26B, Gemma 31B; the 2.5 ids are listed but have never passed qualification). Groq: 3 per-model pools. Plus the OpenRouter free pool (key-wide) and the Z.ai free pool (1 concurrent request). |
| Healthy free routes | 11 | Groq ×3, Gemini Flash-Lite, Gemma 26B, OpenRouter nemotron-ultra, dots, ling ×2, laguna, glm-4.5-flash |
| Strong free routes (quality ≥ 4 or 120B+) | 3 | groq gpt-oss-120b, OpenRouter nemotron-3-ultra-550b, Gemini Flash (daily quota ≈20 requests) |
| Coding-eligible free routes | **0** | Coding tasks default to `privateData: true`, and **no free route is approved for private data** |
| Privacy-approved routes | 5 | anthropic ×2, openai, deepseek (paid), plus DeepSeek's opt-out flag. All paid. |
| Paid routes with no credit | 5 | kimi, minimax, glm-5.3, qwen (not activated), cerebras (trial ended; 66 failed probes) |

### Usage over 14 days (MEASURED)

| Day | Calls | OK | Failed | Successful tokens | Cached input | Retry calls | Cost |
|---|---|---|---|---|---|---|---|
| 09-25 | 95 | 92 | 3 | 1.18M | 1.07M | 76 | $0.42 |
| 09-26 | 261 | 245 | 16 | 6.65M | 5.85M | 154 | $0.40 |
| 09-27 | 129 | 108 | 21 | 0.57M | 0.23M | 28 | $0.03 |
| 09-28 | 82 | 63 | 19 | 0.48M | 0.04M | 9 | $0.00 |
| 09-29 | 14 | 14 | 0 | 0.13M | 0.00M | 0 | $0.00 |

* Failed attempts carried 0 billed tokens: failures are rejections, not partial answers.
* Reasoning tokens are small (≤ 17K a day).
* Cached input is up to 88% of input on coding days (DeepSeek prefix cache).
* `provider_status` also shows wasted probing:
  * `gemini-2.5-flash` and `-lite`: 238 and 200 `PROVIDER_UNSUITABLE` verdicts, 0 successes;
  * Cerebras: 66 invalid requests.

### Job sizes (MEASURED, completed sessions and jobs)

| Kind | Samples | Tokens (input + output) |
|---|---|---|
| Small coding job (docs line, one test, glossary) | 4 | 72K–153K (median ≈ 120K) |
| Medium coding job (helper + tests, JSDoc pass) | 2 | 348K–621K (≈ 500K) |
| Large coding job (audit, provider integration) | 2 (+1 cancelled) | 2.4M–2.7M |
| Single Office answer | 44 | p50 2.8K, p90 18K |
| Mixed Office project (≥4 tasks) | 9 | p50 65K, p90 223K, ~24 calls |

About 97% of coding tokens are input: the transcript is re-sent every turn.
Cached input makes this cheap on paid DeepSeek; it does not help against free
token-per-day limits.

## 2. Provider discovery (2026-09-29)

### Research method and limits

The sandbox egress proxy blocks most provider documentation sites
(opencode.ai, docs.sambanova.ai, developers.cloudflare.com, docs.llm7.io,
api.llm7.io). GitHub is reachable. So:

* **PRIMARY:** the provider's own source or terms file on GitHub was read in
  full:
  * OpenCode Zen: `anomalyco/opencode` → `packages/web/src/content/docs/zen.mdx`;
  * LLM7: `chigwell/llm7.io` → `TERMS.md`, `PRIVACY.md`;
  * OmniRoute: https://github.com/diegosouzapw/OmniRoute/blob/main/docs/reference/PROVIDER_REFERENCE.md
    and https://github.com/diegosouzapw/OmniRoute/blob/main/docs/reference/FREE_TIERS.md.
* **OFFICIAL (search):** statements quoted from official-domain search
  results (Cloudflare, Ollama).
* **REPORTED:** secondary aggregators only (freellm.net, costbench, …). Never
  used on its own for a limit that the router relies on.

### Candidates and decisions

| Provider | Free capacity | Source | Terms / privacy | Tools | Coding value | Decision |
|---|---|---|---|---|---|---|
| **Mistral** (La Plateforme, free mode) | ≈1B tokens/month in OmniRoute's catalog (**REPORTED**); limits shown only in the Mistral console | OmniRoute FREE_TIERS; Mistral docs (search) | Free-mode prompts may be used for training → **PUBLIC** | yes | high (Codestral/Devstral/Medium) | Integrated (#73). **OWNER_ACTION_REQUIRED**: key creation is blocked in Fahad's account UI ("Upgrade to use your API keys"). This is the single largest free pool. |
| **LLM7.io** | Free token: **1,000,000 tokens/day** rolling 24 h, 60 req/min, 250 req/h; anonymous 500K/day | **PRIMARY** TERMS.md | "not for production … where guaranteed access is required"; no reselling or proxying to third parties; 5-min response cache; prompt handling for upstream models not stated → **PUBLIC** | via upstream models (UNKNOWN per model) | medium (routes to upstream open models) | **Integrate (wave 1)** as a best-effort free pool with fallback; single user, not resold. Models discovered at runtime from `/v1/models`. |
| **OpenCode Zen** | Limited-time free models; **no published numeric limit** (UNKNOWN) | **PRIMARY** zen.mdx | Per model: `space-bunny-free` and `longcat-2.5-preview-free` are zero-retention with no training (**NORMAL**); `big-pickle`, `mimo-*-free` and `ling-*-free` may use data while free (**PUBLIC**); `nemotron-*-free` are NVIDIA trial endpoints, logged (**PUBLIC**); `muse-spark-*-contributor-free` trains on prompts (**excluded**). ToS: own internal use only. | chat/completions (OpenAI-compatible) | high (a coding-agent gateway; tested for coding) | **Integrate (wave 1)**, dynamic. Only ids that are both in the free list and in the live `/zen/v1/models` catalog. A promotion ending removes the id, which disables the route. Billing guard: keep auto-reload off and a $0 balance (owner action). |
| **Ollama Cloud** | Free plan: "a small amount of monthly usage" on starter cloud models, 1 concurrent request; **no published numbers** (UNKNOWN) | OFFICIAL (ollama.com pricing, search) | "Prompt or response data is never logged or trained on" → **NORMAL** (PRIVATE only after the owner's review flag) | OpenAI-compatible `/v1/chat/completions` | high (gpt-oss 120B, qwen3-coder 480B, deepseek, glm, kimi cloud models) | **Integrate (wave 2)**, quota UNKNOWN, concurrency 1. |
| **Cloudflare Workers AI** | **10,000 neurons/day**, all models share one pool, resets 00:00 UTC; Workers Free plan returns error 4006 when used up (no billing) | OFFICIAL (search: pricing page, community error text) | Cloudflare does not train on customer data and does not retain prompts → **NORMAL** | OpenAI-compatible `/ai/v1/chat/completions` with tool calls | medium (gpt-oss-120b, qwen coder 32B, llama 3.3 70B) | **Integrate (wave 2)**. Needs `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`; the owner must stay on the Workers **Free** plan, otherwise overage bills. |
| SambaNova | 20 req/day, 200K tokens/day (REPORTED); since 2026-08 a payment method is required | REPORTED | unknown | yes | medium | **Owner option, low priority**: small quota and a card. |
| NVIDIA build (NIM) | Trial credits, 40 RPM | REPORTED | Trial terms: "trial use only", logged | yes | high | **Not integrated**: trial/evaluation terms, not for production. Its models are reachable free through OpenRouter and OpenCode Zen as PUBLIC data. |
| Hugging Face Inference Providers | $0.10/month of credits | REPORTED | varies | varies | — | **Not integrated**: trivial capacity. |
| Cohere, Together, Fireworks, DeepInfra, Scaleway, Inception, LongCat, Nebius | One-time signup credits (or trial keys) | OmniRoute FREE_TIERS | Fireworks' ToS forbids proxying; Cohere trial keys are non-production | — | — | **Not integrated**: not recurring (Part 27). |
| GitHub Models | — | github.blog changelog | Retired 2026-07-30 | — | — | Retired (kept for the dashboard only). |
| FreeBuff | Token "obtained via CLI login or automated harvester" | OmniRoute PROVIDER_REFERENCE | Consumer CLI login reused as an API | — | — | **Rejected** (Part 10: no consumer logins). |
| OmniRoute OAuth, cookie and no-auth providers (Kiro, Gemini CLI, Claude Code, Codex app-server, chat.qwen web, DuckDuckGo, Chipotle bot, Cloudflare playground, …) | — | OmniRoute PROVIDER_REFERENCE | Consumer subscriptions, reverse-engineered web apps, ToS "avoid" | — | — | **Rejected** (Part 10). |

### OmniRoute

* OmniRoute (MIT) **does not create capacity**. Its honest headline, ~1.51B
  documented free tokens a month across 42 deduplicated pools, is the sum of
  the same upstream free tiers we can call directly. Its largest contributors:

  | Pool | Tokens / month |
  |---|---|
  | Mistral | 1.00B |
  | llm7 | 150M |
  | Groq | 117M |
  | Gemini | 60M |
  | Cerebras | 30M |
  | Cloudflare | 30M |
  | SambaNova | 30M |

  Mistral is two-thirds of the total.
* A large part of its "free" catalog is consumer OAuth logins, web-cookie
  wrappers and reverse-engineered chatbots. Those are forbidden here.
* **Decision: harvesting tool, not a gateway.**
  * `tools/omniroute-harvest.mjs` reads the published registry and outputs,
    per provider: auth method, free-tier note, recurring or one-time,
    ToS flag and our policy verdict.
  * Running OmniRoute as a gateway would add no new capacity, since it uses
    the same upstream pools. It would hide which pool a call used, break the
    free-only cost guard and per-pool accounting, and would need a second
    server. So it is **not deployed**. The router architecture keeps the
    Fahad policy router as the authority over direct providers and
    aggregators (OpenRouter, OpenCode Zen, LLM7), then paid fallback.

### JEV (Part 15)

JEV 1.13 is TypeSafe AI's decision model, served through OpenCode Zen at
`/zen/v1/systemone` (question → answer from fixed criteria). `jev-1.13-free`
is free "for a limited time"; inputs are not used for training.

* **Decision: not integrated.**
  * Our route and quality decisions are already deterministic code, costing
    0 tokens: finance validation, table gates, capability rules,
    qualification. So there is no measurable model spend to remove.
  * A limited-time free decision model would add a dependency without a
    benefit.
  * Revisit if a model-based gate (e.g. a yes/no escalation decision) ever
    appears in the hot path.
