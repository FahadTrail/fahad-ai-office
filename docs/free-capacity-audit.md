# Free capacity and continuous execution audit (2026-09-28)

This is a READ-ONLY audit. Nothing in production was changed: routing, providers,
jobs and the running V4.1 acceptance job (`abaccdad`) are untouched.

**Evidence labels**
* **MEASURED:** production telemetry (Supabase `zkzibipinjeswhdxnfgf`),
  queried on 2026-09-28 at about 15:00 UTC.
* **DOCUMENTED:** the provider's own page, or `provider-facts.js`, which was
  verified on 2026-09-27.
* **REPORTED:** third-party pages found by search tonight. The sandbox proxy
  blocked the official pages for OpenRouter, Groq, OpenCode and FreeBuff.
* **ESTIMATE:** our own arithmetic, with the assumptions stated.

**Data sources**
* `provider_status` (31 routes).
* `model_attempts`: 603 Office rows and all Coding turns.
* `agent_sessions` (13 sessions) and `agent_events` (395 tool calls, 250
  model turns).
* `tasks`, `events` and `provider_canary_runs` (qualification evidence).
* `workspace_provider_permissions`.
* The router code (`capabilities.js`, `turn-gateway.js`, `pool-runner.js`,
  `office/capacity.js`), run offline against the same pool definitions.

---

## A. Current free capacity

### A1. Independent free/included/promo pools configured today

| # | Pool (one account quota) | Routes behind it | Quota scope | State now | Evidence |
|---|---|---|---|---|---|
| 1 | **Google Gemini API** (one AI Studio project) | `gemini-flash-latest`, `gemini-flash-lite-latest`, `gemma-4-26b-a4b-it`, `gemma-4-31b-it` | **Per model, per project.** The four routes are four sub-quotas of one account. | flash-latest is exhausted until 2026-09-29 07:00 UTC; flash-lite and gemma-26b are healthy. | DOCUMENTED: flash ≈20 RPD, flash-lite ≈500 RPD, shown only in AI Studio. MEASURED: flash-latest ran out after 17 / 21 / 9 successes a day. |
| 2 | **Groq** (one free-plan org) | `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b` | **Per model:** 30 RPM, 1K RPD, **8K tokens/min**, 200K tokens/day each | Healthy. | DOCUMENTED 2026-09-26/27; MEASURED rate-limit headers (8,000 TPM, 1,000 RPD). |
| 3 | **OpenRouter `:free`** (one key) | nemotron-3-ultra/super, dots-3-note, gemma, qwen, ling, laguna … (about 11 seen) | **One pool for the whole key: 50 requests/day** and 20 RPM. 1,000/day only after a one-time $10 credit purchase. | Exhausted until 00:00 UTC. | DOCUMENTED; MEASURED 45 / 53 / 50 successes a day, then 429s. |
| 4 | **Z.ai GLM Flash** (one key) | `glm-4.5-flash`, `glm-4.7-flash` | Free, **1 concurrent request**; daily quota not published. | Healthy (rarely used: 10 calls in total). | DOCUMENTED (LIKELY); MEASURED $0. |
| 5 | Cerebras (PROMO trial) | `gpt-oss-120b`, `qwen-3.8-27b` | The $5 trial credit has expired; there is no permanent free tier. | **Dead:** 66 failures, `PROVIDER_INVALID_REQUEST`. | MEASURED |

**The answer: 4 live independent free pools** (Gemini, Groq, OpenRouter,
Z.ai), plus one dead promo (Cerebras).
* The about 11 OpenRouter free models are **one** pool of 50 requests a day.
* The Gemini and Groq models have per-model quotas, but each provider is still
  one account, so a ban or a policy change hits all of its models together.
* GitHub Models is retired.
* Qwen, Kimi and MiniMax are paid, and their accounts are unfunded or not
  activated.
* DeepSeek, Anthropic and OpenAI are paid and live.

### A2. Which routes each job may use (the real router, production evidence)

The table comes from `AgentTurnGateway.evaluate` run offline with the
production pool, production qualification evidence and the job's real
`maxOutputTokens` (script in *Reproduce*).

**Columns:**
* **FINANCE:** `finance`.
* **SYNTH.:** CHIEF synthesis (`synthesis`).
* **RESEARCH / PRODUCT / LEGAL:** `research`.
* **SOCIAL / CREATIVE:** `content` / `branding`.
* **CHIEF / AUDIT:** `orchestration`.
* **CODING:** `coding`.

**Cells:** ✔ means eligible. Other cells are reason codes:
* **R<4:** reasoning below 4.
* **W<4:** writing below 4.
* **CTX:** the free-tier request limit counts as a context window that is too
  small.
* **Priv:** the route is not approved for private data.

| Route | FINANCE | SYNTH. | RESEARCH / PRODUCT / LEGAL | SOCIAL / CREATIVE | CHIEF / AUDIT | CODING |
|---|---|---|---|---|---|---|
| gemini-flash-latest (r4) | ✔ | ✔ | ✔ | ✔ | ✔ | Priv |
| gemini-flash-lite-latest (r3) | R<4 | R<4, W<4 | ✔ | ✔ | ✔ | Priv, c3 |
| gemma-4-26b / 31b (r3) | R<4 | R<4 | ✔ | ✔ | ✔ | Priv, c3 |
| OpenRouter nemotron-3-ultra / super (r4) | ✔ | ultra ✔, super W<4 | ✔ | ✔ | ✔ | Priv |
| OpenRouter others (dots, ling, laguna…) | mostly R<4 | ✗ | some ✔ | ✔ | ✔ | Priv |
| groq gpt-oss-120b (r4) | **CTX** | CTX, W<4 | **CTX** | **CTX** | ✔ | Priv, c3 |
| groq qwen3.8-27b (r4) | **CTX** | CTX | **CTX** | **CTX** | ✔ | Priv |
| glm-4.5 / 4.7-flash (r3) | R<4 | R<4 | ✔ | ✔ | ✔ | Priv, c3 |
| cerebras (dead) | cooling | — | cooling | cooling | cooling | Priv |

**Healthy right now:**
* groq ×3
* gemini flash-lite
* gemma-26b
* glm-4.5-flash
* OpenRouter dots / laguna / ling. Their shared daily quota is exhausted, so
  they fail on the first call.

**Eligible for FINANCE and CHIEF synthesis:** only `gemini-flash-latest` and
the two OpenRouter nemotron models (whose shared quota is 50 a day). This
matches the wait list recorded on the Sanad Desk FINANCE task exactly.

**No free route can run CODING.** Coding needs a private-data approval, and no
free route has one. Coding runs on DeepSeek (paid, about 93% cached input).

### A3. Usable free capacity today

**Strong tier** (reasoning ≥4, qualified; the only tier FINANCE and synthesis
may use):
* gemini-flash-latest: about 20 requests a day. MEASURED: it ran out after
  17–21 successes.
* OpenRouter: 50 requests a day, shared with every other job.
* **Total: about 70 calls a day, about 0.3–0.45M tokens a day.** MEASURED:
  OpenRouter carried 0.21–0.34M input tokens a day before hitting its limit.

**General tier** (research, content, orchestration):
* flash-lite: 500 RPD, DOCUMENTED.
* gemma and GLM: quotas unpublished.
* Groq: only the orchestration and classification jobs, because of the CTX
  gate.

| Measure | Documented or observed ceiling | Usable with today's routing |
|---|---|---|
| Tokens a day, all free pools | about 3.5M (flash-lite 500 × about 5K ≈ 2.5M, Groq 3 × 200K = 0.6M, OpenRouter about 0.3M, flash about 0.1M; Gemma/GLM unknown, not counted) | about 2.5–3M for general work; **about 0.4M for strong jobs** |
| Tokens a month | about 105M | about 75–90M general; **about 12M strong** |
| Coding jobs a day (free) | 0 (privacy + capability) | 0. Coding is paid DeepSeek at about $0.005–0.14 per task (MEASURED). |
| Research jobs a day (about 31K tokens and 8 calls each, MEASURED average) | about 80 | about 20–40: web search is failing, so answers are degraded |
| Mixed Office projects a day (about 100K tokens, about 35 calls, about 6 strong-tier calls each; ESTIMATE from medians) | about 10 | **3–5.** The strong tier and OpenRouter's 50 a day are the bottleneck. |

---

## B. Token consumption (MEASURED, per task, input + output)

| Work | Tasks | Median | Average | Max | Calls per task (avg) |
|---|---|---|---|---|---|
| CHIEF plan | 45 | 1.4K | 2.0K | 4.1K in | 1.6 |
| CHIEF review | 22 | 0.9K | 1.6K | 4.4K in | 1.1 |
| CHIEF synthesis | 8 | 8.1K | 10.7K | 18.5K in | 1.2–3 |
| RESEARCH (specialist) | 3 | 21K | 31K | 63K in | 8.0 |
| FINANCE (specialist) | 9 | 13K | 35K | 93K in | 4.9 (1.6 failed) |
| AUDIT (specialist) | 5 | 6.4K | 8.4K | 16K in | 1.0 |
| LEGAL | 4 | 21K | 23K | 39K in | 8.5 |
| SOCIAL | 6 | 14K | 24K | 63K in | 4.7 |
| PRODUCT | 4 | 8.7K | 11K | 20K in | 4.3 |
| CREATIVE | 4 | 2.3K | 2.3K | 2.2K in | 1.5 |
| **Coding — small** (1–2 files, docs/tests) | 5 | **~120K** | 216K | 621K | 9–34 turns |
| **Coding — medium** (4-file feature + tests) | 1 | 348K | 348K | — | 22 turns |
| **Coding — heavy** (audit, multi-file provider fix) | 3 | 2.4M | 2.1M | 2.67M | 34–70 turns |

**Coding observations:**
* Input is 97–98% of Coding tokens.
* Input per turn grows with the transcript: 8K average on a small task, 57K
  on a heavy one, with a peak of 94K.
* DeepSeek served 93% of that input from cache, so the cost stayed small at
  $0.005–0.14 per completed task.
* Free providers do not cache. A single medium Coding task (348K tokens)
  exceeds one Groq model's whole daily quota (200K tokens).

---

## C. Why capacity ran out (Sanad Desk, job `abaccdad`)

**Timeline (MEASURED from `events`):**
1. **03:37 UTC.** FINANCE started on OpenRouter `nemotron-3-ultra`. It
   produced 4,000 output tokens and then got a 429. OpenRouter's 50-a-day
   pool had been used up by the same night's other jobs (qualification
   runs, CHIEF, RESEARCH, SOCIAL).
2. The task switched to `nemotron-3-super`, which is the **same pool**, and
   got a 429 at once.
3. The only other strong route, `gemini-flash-latest`, was already exhausted.
   Its reset was Pacific midnight, 07:00 UTC.
4. **07:00–07:25 UTC.** Six restarts. Each was stopped by Gemini
   503 / `UNAVAILABLE` on flash-latest, followed by `COOLDOWN_QUOTA_EXHAUSTED`.
   Each restart also ran new `web_fetch` calls against the Office's **own
   GitHub docs**, which are irrelevant to a model with given assumptions.
5. **07:25 UTC.** All three eligible routes are cooling down until
   2026-09-29 00:00 and 07:00 UTC, so the task sleeps about 17 hours.

**Why the other healthy free routes did not help:**
* **gemini-flash-lite, gemma-4, glm-4.5 / 4.7-flash:** excluded by the
  registry's reasoning score of 3. **Production qualification evidence says
  every one of them PASSED the reasoning and structured-output skills.** The
  hand-set planning score overrules the measured evidence.
* **Groq gpt-oss-120b and qwen3.8-27b** (reasoning 4, qualified): excluded
  because the free tier's 8K tokens-per-minute limit is treated as an **8K
  context window**, below FINANCE's `minContext: 32_000`. Yet a real FINANCE
  call is about 2–9K tokens, and the gateway already has the correct
  per-request check (`REQUEST_ABOVE_FREE_TIER_LIMIT`).
* **Paid routes (DeepSeek, Anthropic):** excluded by the job's `[free-only]`
  flag, which is correct and by design.

**Conclusion:** the free pool was not empty. The router admitted only 3 of
about 10 healthy free routes, and 2 of those 3 share one 50-a-day quota.

---

## D. Routing gaps

| # | Gap | Evidence | Effect |
|---|---|---|---|
| G1 | Registry scores overrule qualification evidence. | flash-lite, gemma, GLM passed reasoning but are scored r3. | Removes 4–5 routes from FINANCE and synthesis. |
| G2 | The Groq TPM limit is used as a context window. | `capabilityProfile`: `contextWindow = min(window, requestTokenLimit)`. | Groq is out of research, content, finance and synthesis entirely. |
| G3 | `minContext` is a fixed floor (32K for finance and research), not the actual request size. | FINANCE call median about 9K. | Excludes small-window routes that could serve the actual call. |
| G4 | FINANCE still requires reasoning 4 although V4.1 moved the arithmetic into deterministic code with a validator. | `finance.js` VERIFIED / INCONSISTENT loop. | The strictest gate protects work that code now checks. |
| G5 | OpenRouter's single 50-a-day pool is spent first by low-value calls. | Qualification runs, CHIEF reviews and research loops ran on OpenRouter at night. | Critical jobs starve. |
| G6 | There is no degradation ladder: a waiting step waits for its ideal tier. | 17-hour wait. | No partial progress. |
| G7 | Dead routes keep being probed. | Cerebras: 66 failures. gemini-2.5-flash / -lite: 180 / 142 `PROVIDER_UNSUITABLE` rows with 0 requests. | Noise, and qualification slots wasted. |
| G8 | Web search is effectively down. | 78 of 80 `web_search` calls failed (`SEARCH_RATE_LIMITED`). | Research is degraded, and each failed search costs a model turn. |
| G9 | FINANCE has web tools for pure-model tasks. | 3 repo fetches per restart on Sanad Desk. | Extra turns and tokens. |
| G10 | A mid-answer 429 discards the partial output. | 4,000 output tokens lost at 03:38. | Wasted strong-tier quota. |

Things the router does correctly:
* the privacy gate for code;
* paid exclusion on `[free-only]` jobs;
* the free-route guarantee;
* checkpoints;
* waiting on the earliest known reset.

---

## E. Providers worth adding (independent capacity only)

The **Verdict** column is the recommendation.

| Provider | Models | Free quota | Reset | Independent? | Tools | Coding | Arabic | Privacy / terms | Integration | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| **Mistral La Plateforme "Experiment"** | Mistral Large / Medium / Small, Codestral, Magistral | REPORTED: about 1B tokens/month, about 1 request/s; exact numbers only in the console | Monthly | **Yes**, a new account pool | Yes | Good (Codestral) | Good (4) | Free-plan prompts may be used for training, so use for public data only; phone verification; commercial use of the free tier is for evaluation | **Low**: the route already exists (`mistral-medium-latest`, default billing class paid). Add a registry score for `mistral-medium` (it currently falls back to the route default). | **ADD FIRST.** The largest independent strong-tier pool (reasoning 4). |
| **NVIDIA build.nvidia.com (NIM)** | DeepSeek V4, Qwen, Kimi, Nemotron, Llama, Mistral… | REPORTED: 40 RPM; credit or trial-based on some accounts | Rolling | **Yes** | Yes (OpenAI-compatible) | Good | Varies | "For prototyping" terms; not for production workloads; logs possible | Low (OpenAI-compatible) | **ADD SECOND** as general and strong public-data capacity, after reading the terms. |
| **Cloudflare Workers AI** | gpt-oss-120b, Qwen, Llama 4, Mistral, Gemma | DOCUMENTED: 10,000 neurons/day | 00:00 UTC | Yes | Partial | Weak or medium | Medium | Cloudflare terms; no training on inputs (REPORTED) | Medium (account id + token) | **Optional.** A small (about 1–2M small-model tokens a day) but very stable overflow for classification and short CHIEF steps. |
| **OpenRouter one-time $10 credit** | same `:free` models | DOCUMENTED: raises the free pool from 50 to **1,000 requests/day** | Daily | Same pool, 20× larger | Yes | — | — | A one-time purchase: **the owner decides**; not a new service | None | **Highest leverage for $10**, but it is spending, so it is Fahad's call. |
| SambaNova Cloud | Llama, DeepSeek, Qwen | REPORTED: 20 RPD / 200K TPD (conflicting reports) | Daily | Yes | Yes | Medium | Medium | Standard | Low | Skip for now (tiny). |
| Groq (existing) | 3 models | 1K RPD, 8K TPM, 200K TPD each | Daily | Existing | Yes | Medium | Weak (qwen) | Good | — | Keep; unlock it with G2. |
| Gemini (existing) | flash, flash-lite, gemma | per model | Pacific midnight | Existing | Yes | Good | Excellent | Free tier: prompts may be used to improve products | — | Keep; unlock flash-lite and gemma with G1. Do **not** open extra projects to multiply the quota. |
| Z.ai GLM Flash (existing) | glm-4.5 / 4.7-flash | free, 1 concurrent | — | Existing | Yes | Medium | Medium | Standard | — | Keep; unlock it with G1. |
| DeepSeek (existing, paid) | deepseek-flash | none (paid, cheap) | — | — | Yes | Strong | Good | Approved for private code | — | Keep as the Coding engine and the paid fallback. |
| Qwen / Alibaba | qwen3.x | 1M tokens per model for 90 days, new international accounts (one-time) | — | Yes (temporary) | Yes | Strong | Medium | Account not activated (`AccessDenied.Unpurchased`) | Done | Only if Fahad activates Model Studio. Temporary. |
| Kimi, MiniMax | — | no free API | — | — | — | Strong | — | Paid | Done | Skip (paid). |
| Cerebras | — | no permanent free tier since 2026-08-17 | — | — | — | — | — | — | Done | Retire the routes (G7). |
| GitHub Models | — | retired 2026-07-30 | — | — | — | — | — | — | — | Gone. |

A free web-search API is also worth considering, to fix G8 (for example
Brave Search or Tavily free tiers). Their quotas were not re-verified tonight,
so verify before choosing.

## F. OmniRoute verdict

**Do not deploy it in the production path.**
* It is an MIT gateway in front of 290+ providers. It adds **no quota of its
  own**: it only relays to accounts we would have to create anyway, and we can
  call those directly with per-call billing truth.
* It aggregates free tiers of providers whose terms forbid proxying or
  impersonating clients (REPORTED: accounts get banned).
* It had a published vulnerability (CVE-2026-49352, REPORTED), insecure
  defaults, and unencrypted credential storage unless configured.
* Its internal fallback would silently defeat `free-guard.js` and our
  per-provider privacy flags.

The proposed chain (policy router → direct → OpenRouter → OpenCode Zen →
OmniRoute → paid) is **technically possible but not legally or operationally
reasonable** at the OmniRoute layer.

Use it only as a **research catalog**, to discover providers that we then
integrate directly.

## G. OpenCode Zen verdict

**Not as an Office provider.**
* Its free models (Big Pickle, DeepSeek V4 Flash, MiMo, Nemotron 3 Ultra,
  North Mini Code) are **promotional and rotating**.
* Their limits are unpublished: users hit "Free usage exceeded" (issue
  #28055).
* Several free models **log or train on prompts** during the free period
  (REPORTED).
* It is designed for the OpenCode client.

It adds a small, unstable, non-private pool. Revisit it only if we adopt
OpenCode as an optional Coding backend (already evaluated: needs Tool-Broker
wrapping). OpenCode itself (MIT) remains a reasonable future backend; Zen's
free tier is not a capacity plan.

## H. JEV verdict

**Not free, but nearly zero cost:**
* $0.042 per million input tokens; output is free.
* The waitlist was removed on 2026-09-20.
* API: `POST /v1/systemone`. It is also listed on OpenRouter as
  `typesafe/jev-1.13`.
* It returns typed decisions with calibrated probabilities and cannot write
  text or code.

**Right uses** (the plug points already exist):
1. **Escalation gate:** "is this free-model answer good enough, or escalate?"
   with a confidence threshold.
2. **Quality gate:** "does this output satisfy the brief?" (yes/no plus
   probability), before CHIEF synthesis.
3. **Free-text job classification** for Telegram messages, where the job is
   not explicit.

**Wrong uses:**
* Writing, coding, research.
* Route selection. The policy router is deterministic and auditable; keep it.

**Recommendation:** an offline pilot on stored, non-private Office outputs to
measure agreement with AUDIT and CHIEF decisions before any live use. It needs
its own key (`JEV_API_KEY`) and a data-use terms review, and it is **not
needed to fix capacity**.

## I. FreeBuff verdict

**Reject as a capacity source.**
* FreeBuff is the ad-supported free distribution of Codebuff: a CLI, web and
  desktop coding **product**.
* It allows 5 free sessions a day (REPORTED), shows ads in-session, and has
  **no API for a third-party backend**.
* Wiring it into the Office would mean automating a consumer product, which is
  a terms-of-use risk.
* Its models (MiMo, DeepSeek V4, MiniMax M3) are reachable through legitimate
  APIs if needed.

---

## J. Efficiency savings

| Area | Waste found (MEASURED) | Fix | Estimated saving |
|---|---|---|---|
| ~~Coding: CI polling by the model~~ **CORRECTED 2026-09-28** | The 23 `github.ci_status` rows are **controller polls** (30 s apart, no model turn in between; the model has no CI tool). They cost **0 model tokens**. | No change needed. A regression test now locks CI/deploy polling to the controller (`test/router-efficiency.test.js` O). | 0% (the original claim was wrong) |
| Coding: turn budget on small tasks | A JSDoc-only change took 34 turns and 621K tokens, against 70–150K for similar tasks | Task-size estimate, then a turn cap and a forced "finish now" (as the Office already does) | Up to 70% on outliers |
| Coding: transcript growth | Input per turn 8K → 57K average | Rolling summary of old tool results (compaction exists; lower its trigger); read-dedupe (exists: 5 repeats of 112 reads) | 20–35% |
| Coding overall | — | Turn budget + transcript compaction (rows above; the CI row was a wrong claim) | **about 15–30% of Coding tokens (ESTIMATE, revised down from 40–55%)** |
| Office: failing web search | 78 of 80 searches failed, each costing a turn | A global search circuit breaker (per hour, not per task) plus a real free search API | 5–10% of research tokens, plus much better research |
| Office: FINANCE web tools | Repo fetches on given-assumption tasks | `webTools: false` for FINANCE unless the brief asks for market data | 10–20% of FINANCE tokens |
| Office: partial answer lost on 429 | 4,000 output tokens discarded | Keep the partial and continue on the next route (continuation already exists for length cut-offs) | Strong-tier quota |
| Office: qualification on dead routes | Cerebras and gemini-2.5: hundreds of failures | Retire dead routes; never qualify on OpenRouter after 18:00 UTC | Protects the 50/day pool |
| Office: handoff context | Specialists receive prior outputs in full | Pass artifact summaries and validated facts instead of full prose | 10–20% of specialist input |
| Office overall | — | — | **25–40% of Office tokens** |

---

## K. Expanded capacity estimate (tokens a day, all ESTIMATE)

**Conservative scenario:**
* Change: router fixes G1–G5 only; no new providers.
* Strong tier: about 1.2M a day (Groq 3 × 0.2M, flash, OpenRouter, flash-lite
  and gemma promoted).
* General tier: about 3M a day.
* Mixed projects: about 10–15 a day.
* Coding free jobs: 0.

**Realistic scenario:**
* Change: + Mistral Experiment (about 30M a day at 1B/month) + NVIDIA NIM
  (about 40 RPM, bounded by terms; count 2–5M) + router fixes.
* Strong tier: about 10–30M a day (Mistral dominates).
* General tier: about 8–35M a day.
* Mixed projects: 30–100 a day, more than the Office generates.
* Coding free jobs: 0 (privacy), or 5–20 a day if Fahad allows public-repo
  coding on free routes.

**Theoretical maximum scenario:**
* Change: + the OpenRouter $10 credit (1,000 RPD) + Cloudflare + SambaNova +
  Qwen trial.
* Strong tier: about 35M a day.
* General tier: about 40M a day.
* Mixed projects: 100+ a day.
* Coding free jobs: as above.

Documented quota and assumptions are separate:
* **Only these numbers are documented:** Gemini (per-model RPD in AI Studio),
  Groq (1K RPD / 200K TPD), OpenRouter (50 or 1,000 RPD), Cloudflare (10K
  neurons a day).
* **Reported:** Mistral's about 1B tokens a month.
* **Unpublished** (verify in each console): NIM, Gemma and GLM daily caps.

**Private code stays on approved routes** (DeepSeek and Anthropic). No free
route adds Coding capacity for private repositories unless the owner changes
that policy.

---

## L. Owner actions (do not do anything yet — one provider at a time, after review)

| Order | Provider | Website | Account | Card | Key | OAuth | Free quota | Env name we would store | Can wait? |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Mistral La Plateforme | console.mistral.ai | Yes (email + phone verification) | No (Experiment plan) | Yes | No | about 1B tokens/month (verify in Admin → Limits) | `MISTRAL_API_KEY`, plus the non-secret `MISTRAL_BILLING_CLASS=free` (the route defaults to paid) | No: this is the main fix |
| 2 | NVIDIA Developer / build.nvidia.com | build.nvidia.com | Yes (NVIDIA Developer Program) | No | Yes (`nvapi-…`) | No | 40 RPM (verify credits and terms) | `NVIDIA_API_KEY` | Yes, after Mistral |
| 3 | OpenRouter credit (optional spend) | openrouter.ai/settings/credits | Existing | **Yes: a one-time $10** | Existing key | No | 50 → 1,000 requests/day | (none new) | Yes. Fahad decides on the spend. |
| 4 | Cloudflare Workers AI | dash.cloudflare.com | Yes (free) | No | API token with Workers AI scope | No | 10K neurons/day | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | Yes |
| 5 | Free web search (Brave or Tavily) | brave.com/search/api or tavily.com | Yes | Brave: may ask for a card; Tavily: no | Yes | No | Verify | `BRAVE_SEARCH_API_KEY` or `TAVILY_API_KEY` | Yes, but it fixes research quality |
| — | JEV (pilot only) | typesafe.ai | Yes | Top-up | Yes | No | none (about $0.04/M) | `JEV_API_KEY` | Yes: optional, not for capacity |

Not recommended: OmniRoute, OpenCode Zen, FreeBuff, SambaNova (tiny),
Cerebras (no free tier).

---

## M. Implementation plan (no production change until approved)

1. **Router fixes on a branch.** All are covered by unit tests plus an offline
   eligibility matrix test.
   * **G1:** evidence-based capability. A valid qualification that passed
     `reasoning` and `structured` raises the effective reasoning to at least
     4 for the jobs whose skills it passed. A failed skill lowers it.
     Planning scores remain the default.
   * **G2:** stop folding `requestTokenLimit` into `contextWindow`. Use the
     existing per-request check (`REQUEST_ABOVE_FREE_TIER_LIMIT`) plus a
     `tokensPerMinute` pacing wait.
   * **G3:** `minContext` becomes "estimated request + output + 20% margin"
     with a job floor of 8K, instead of a fixed 32K.
   * **G4:** set FINANCE to `min.reasoning: 3` when the deterministic finance
     validator is active. INCONSISTENT results already return to FINANCE.
   * **G5:** pool reservations. Keep 60% of each pool that has a daily
     request cap for critical jobs (finance, synthesis). Qualification may
     use OpenRouter only when more than 30 requests remain.
   * **G6:** a degradation ladder. After 2 waits (or 60 minutes) on a
     non-critical job, admit the next tier. Critical jobs keep their
     validator as the safety net.
2. **Efficiency** (section J): the CI-poll guard, small-task turn caps, the
   search circuit breaker, FINANCE `webTools: false` by default, and keeping
   partial output on a 429.
3. **Providers**, one at a time (section L):
   * add the key;
   * `canary:agentic`;
   * qualification;
   * a privacy flag of **false** (public data only);
   * a live free-only Office job;
   * a telemetry review.
4. **Retire** the Cerebras and gemini-2.5 routes (G7).
5. **Dashboard:** show "independent pools", not "models", with each pool's
   daily remaining quota.

**Validation:** re-run this audit's matrix and telemetry queries after one
week and compare the waits per task (baseline: 4 tasks, 12 waits in total)
and the strong-tier calls per day.

---

## N. Reproduce

The offline eligibility matrix is `node tools/capacity-matrix.mjs` (added with
this audit). It runs the real `AgentTurnGateway.evaluate` over the pool with
placeholder keys and no network.

The telemetry queries are listed in `docs/HANDOVER.md` → *Capacity audit
queries*.
