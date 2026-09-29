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

## 3. What was built (branch `claude/capacity-expansion-v2`)

| Part | Module | What it does |
|---|---|---|
| Pool registry | `src/model-gateway/agentic/pool-registry.js` | One entry per independent quota: kind (daily / rolling / monthly / one-time / promo / rate-only / paid), reset time zone, published limits, confidence, source URL, owner action. UNKNOWN stays `null`. |
| Data classes | `pool-registry.js`, `turn-gateway.js` | PUBLIC < NORMAL < PRIVATE < CONFIDENTIAL. A route receives data up to its class. PRIVATE needs the owner's per-provider flag; CONFIDENTIAL only the reviewed paid providers. Unknown class strings fail closed to PRIVATE. |
| Provider contract + lifecycle | `provider-contract.js` | 15 contract fields per route (tested over every definition). Lifecycle NOT_CONFIGURED → DISCOVERED → CANARY → QUALIFIED → ACTIVE, plus BLOCKED and RETIRED. |
| New providers | `model-pool.js` → `capacityV2Routes` | OpenCode Zen, LLM7, Ollama Cloud, Cloudflare Workers AI. Each route exists only while the provider's own catalog lists the model, so an ended promotion removes it. All start at `requiresQualification` (no job until qualified). |
| Discovered-route gate | `qualification.js` | Discovered OpenRouter and Gemini routes also need a passed qualification. |
| Qualification back-off | `qualification.js` | A refused model (400/403/404…) is re-tested after 24 h; a transient failure (429/5xx) after 1 h. Before this, dead Gemini 2.5 ids were probed about 74 times a day. |
| Catalog changes | `provider-catalogs.js` → `catalogChanges` | Each refresh logs models added, removed and context-window changes. |
| Coding qualification | `coding-qualification.js` | Suite `c1-2026-09`: 12 deterministic checks (A read, B fix, C implement, D edge cases, E test writing, F diff, G security, H async, I plan, J scope, K tool loop, L long context). Model-written code runs only in a child Node process under `--permission` (no fs, no child processes), with an empty environment, a vm context without code generation, and a timeout. Grades: CODING_PRIMARY / CODING_SECONDARY / CODING_SMALL_TASKS / NOT_CODING_APPROVED. The auto-qualifier runs it once the general backlog is empty (one route per cycle, same caps and back-off). |
| Coding tiers | `coding-qualification.js` → `codingTierGaps`, used by `turn-gateway.js` | small → SMALL_TASKS, medium → SECONDARY, large → PRIMARY, critical → PRIMARY plus a private-data route. Paid routes are unaffected. The tier comes from the owner's `codingTier` on the task (default medium). |
| Coding data class | `coding-agent/controller.js`, `hub-workspace.js` | The owner may set `dataClass` (PUBLIC / NORMAL / PRIVATE / CONFIDENTIAL) and `codingTier` on `POST /api/tasks`. The Chief's path cannot set them. Default stays PRIVATE. |
| Handoff | `coding-agent/prompts.js` → `continuationMessage` | Adds repository and base, diff summary, owner decisions and unresolved items (open plan steps, failing test, recorded gate/CI failure). |
| Capacity model | `capacity-model.js` | See §4. |
| `/api/capacity` v2 | `hub-capacity.js` | Adds a `capacity` block (see §4) and `ownerActions`. |
| Owner action queue | `owner-actions.js` | See §5. |
| Snapshots | migration `20261003090000_capacity_snapshots`, `capacity-snapshots.js` | One compact summary per UTC day. The writer stays off until the migration is applied (owner approval). |
| Secrets | `ops/set-secret.sh` | New names plus three privacy flags. Keys are verified with the provider before storing (hidden prompt; never in chat). |
| Discovery tool | `tools/omniroute-harvest.mjs` | Policy classification of OmniRoute's registry. |

A generic live canary (Part 19) needs no new code. Once a key is set, the
auto-qualifier absorbs the provider's catalog models on its next cycle: it
runs the general suite, then the coding suite, and records health like real
traffic. `npm run canary:agentic` remains the owner-triggered drill.

## 4. Capacity model (Parts 22–25)

```
effective tokens/day (pool, job class) =
    daily allowance       published/reported tokens, or requests/day × MEASURED tokens/request (ESTIMATED)
  × eligibility           qualification (+ coding grade and data class for coding)
  × measured success rate our audited attempts this month (≥ 5 calls, else 1)
  (today: also × health: available 1, degraded 0.5, exhausted 0)
```

* An UNKNOWN allowance is listed in `unknownAllowancePools` and never summed.
* Job classes are general, coding, strong_reasoning, research and finance.
* Coding jobs/day: effective coding tokens of pools whose grade meets the tier, divided by the measured job size (120K / 500K / 2.5M).
* Projects/day:
  * free-only: general tokens divided by 65K (p50) or 223K (p90);
  * free-first: adds the remaining monthly budget spread over the days left, at the cheapest privacy-approved paid route's list price (50% cached input).

### Production estimate today (2026-09-29, from production qualifications, states and 14-day attempts)

| Pool | Effective tokens/day | Basis |
|---|---|---|
| Gemini Flash-Lite | 2.31M | ESTIMATED: 500 RPD (REPORTED) × measured 4.6K tokens/request |
| Groq gpt-oss-120b | 200K | PUBLISHED TPD |
| Groq gpt-oss-20b | 200K | PUBLISHED TPD |
| Groq qwen3.8-27b | 100K | PUBLISHED × measured 50% success |
| OpenRouter free (shared) | ≈280K | ESTIMATED: 50 RPD (PUBLISHED) × measured ≈6.1K × 92% |
| Gemini Flash | 33K | ESTIMATED: 20 RPD × 4.4K × measured 38% success |
| Gemma 26B / 31B, Z.ai Flash | UNKNOWN | no published allowance |
| Cerebras | 0 | one-time trial, used up |

**Total: ≈3.1M effective free tokens/day (≈94M/month) for general, research
and finance work, of which about 0.33M/day is strong reasoning.** Flash-Lite's
number rests on a REPORTED limit; the 24-hour measurement decides it.

* **Free coding: 0 jobs/day.**
  * Coding is PRIVATE by default, and no free route is approved for private data.
  * No route has passed the coding suite yet; it starts after deploy.
* Office projects/day, free-only: about 47 (p50) or 13 (p90).
* Free-first with paid fallback adds nothing this month: the $2 budget is already spent ($2.38 over 14 days, mostly Anthropic).

### What each owner action adds (ESTIMATED)

* Mistral: ≈1B tokens/month REPORTED, about 33M/day. That would be ≈10× today's total, PUBLIC data only.
* LLM7: 1M tokens/day PUBLISHED, PUBLIC.
* Cloudflare: 10K neurons/day. The token equivalent depends on the model (UNKNOWN until measured); NORMAL data.
* Ollama: small, unpublished; NORMAL data, and PRIVATE with the owner flag. This is the realistic first private free coding pool once it passes the coding suite.

## 5. Owner action queue (Part 17)

`GET /api/capacity` → `ownerActions` lists these in priority order. Status
comes from the presence of a setting, never its value.

1. Set `MISTRAL_API_KEY`.
2. Set `LLM7_API_KEY`.
3. Cloudflare: stay on the Workers Free plan, then set the token and the account id.
4. Set `OLLAMA_API_KEY`.
5. OpenCode Zen: disable auto-reload and keep a $0 balance, then set the key.
6. Privacy review for private code (the three flags), or mark public repositories `dataClass: "PUBLIC"`.
7. Optional: a one-time $10 OpenRouter credit (50 → 1,000 requests/day).
8. Optional: Qwen activation (one-time credit only).

Every key is set on the server with `sudo bash ops/set-secret.sh NAME`,
which uses a hidden prompt. Never paste a key into a chat.

## 6. Deployment waves

* **Wave 1** (this PR; safe to deploy after CI):
  * back-off;
  * qualification gates;
  * coding suite and tiers;
  * capacity model and API;
  * owner queue.
* Wave 1 changes nothing for traffic that works today:
  * paid routes are unaffected;
  * established free routes keep their jobs;
  * new providers stay inert without keys.
* **Wave 2** (owner): keys through `set-secret.sh`, then a restart. The auto-qualifier then qualifies the new routes, with no deploy.
* **Wave 3** (owner approval): apply migration `20261003090000_capacity_snapshots` to production; snapshots start the next day.

## 7. Needs live 24-hour measurement

* Gemini Flash-Lite's real daily request limit (REPORTED 500).
* Tokens per request per pool on real traffic, which replaces the assumed 6K where no measurement exists.
* Coding-suite grades of the configured free models (the first cycles after deploy).
* Cloudflare tokens per neuron for the chosen models.
* LLM7, Ollama and Zen limits once keys exist.
