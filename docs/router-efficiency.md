# Router and token efficiency sprint (2026-09-28)

* **Branch:** `claude/router-efficiency-v1`.
* **Status:** not merged and not deployed. Production routing, workspace
  policies, providers and the V4.1 acceptance job `abaccdad` were not touched.
* **Source:** `docs/free-capacity-audit.md`.

## What changed

| Fix | Where | Effect |
|---|---|---|
| **TPM ≠ context window** | `capabilities.js` `capabilityProfile` | `contextWindow` is the model's window. A provider's tokens-per-minute rate is kept as `tokensPerMinute` and checked per request (`REQUEST_ABOVE_FREE_TIER_LIMIT`). Groq's 3 models are no longer "8K context". |
| **Context from the actual request** | `capabilities.js` `requiredContext` / `capabilityGaps`, `turn-gateway.js` | A route needs `max(8K, (input + output) × 1.25)` instead of a fixed 16–32K. Oversized requests are still refused (never truncated). Coding and security review (`growingContext`) keep their fixed floor. |
| **Evidence-corrected capability** | `qualification.js` `evidenceCapabilities` | A valid, passed qualification raises a planning score by at most one level, never above 4. A failed skill caps it at 2. High-stakes jobs (`strictEvidence`: coding, security review, final synthesis, high-risk finance) never get a raise. |
| **FINANCE split** | `capabilities.js` `JOB_PROFILES`, `financeJob`; `office/routing-hints.js` | `finance` means routine interpretation of code-calculated numbers: reasoning ≥3, structured output, qualification required. `finance_critical` covers investment, valuation, funding, debt, tax or `[critical]`, and needs reasoning ≥4 and writing ≥4 with strict evidence. |
| **Independent capacity pools** | new `capacity-pools.js`; `model-pool.js` attaches `capacityPool` to every route | OpenRouter `:free` models are **one** pool. Gemini and Groq quotas are per model. Z.ai Flash, Cerebras, Mistral, NVIDIA and Cloudflare are one pool per account. |
| **Pool-wide cooldown** | `turn-gateway.js` `evaluate` (`poolCooldowns`) | When one member of a shared pool reports quota exhaustion, every member rests until the known reset (`COOLDOWN_POOL_QUOTA_EXHAUSTED`). A per-minute 429 rests only that model, because OpenRouter `:free` models have different upstreams. The router goes straight to another pool, so the same exhausted quota is never probed through a sibling model. |
| **Scarce pools last for low-value work** | `turn-gateway.js` `order` | Scarce pools (OpenRouter free, Gemini Flash) are ordered after abundant ones for content, orchestration and classification. High-value jobs (synthesis, finance, AUDIT/security, research, coding) may use them first. Nothing is reserved or blocked. |
| **Lower-tier fallback before waiting** | `capabilities.js` `relaxedJob`, `pool-runner.js` | Only content, branding, SEO and classification may drop one capability level when no route is available. Legal, security, finance, synthesis and CHIEF/AUDIT orchestration never do. |
| **Waiting rules** | `office/capacity.js` | Pool cooldowns count as temporary. The step waits only when every eligible route is cooling down, and resumes at the earliest known reset. Normal jobs reach policy-approved paid routes before any wait. `[free-only]` never reaches paid. Confidential work never reaches a route that is not privacy-approved. |
| **Web-search circuit breaker** | `office/web-tools.js` `searchBreaker`, `officeWebTools()` | After 3 failures in 10 minutes the breaker opens for 15 minutes (doubling up to 60): `web_search` is not offered to models and not called, and the state reads `SEARCH_DEGRADED`. One success closes it. `web_fetch` stays available. |
| **FINANCE web tools off by default** | `office/routing-hints.js` `stepWebTools`, `research.js` | FINANCE gets web tools only when the task needs current external facts (market prices, rates, competitors). A cost model, P&L, break-even or scenario analysis does not. |
| **Partial work preserved safely** | `pool-runner.js` `handoff()` | A draft cut off by the output limit before a route failed is handed to the next model as an **unverified reference**, and the next model writes the complete answer, which is validated as usual. Previously the draft was concatenated with the new model's text. |
| **Structured handoffs** | `office/specialist.js` `handoffPacket` | Employees pass summary, validated figures (verbatim), a shortened deliverable, handoff notes, decisions, open questions and artifacts (verbatim). AUDIT still receives the full outputs; CHIEF synthesis is unchanged. |
| **Coding turn budget** | new `coding-agent/turn-budget.js`, `controller.js` | Task size is small, medium or large, with about 18 / 40 / 80 expected turns. At the expected count the transcript is compacted and the model re-plans. At twice the count it is asked to finish or escalate (a `guard` event). No hard failure; the iteration limit is unchanged. |
| **Earlier compaction** | `controller.js` `compactAtChars` | 240K → 160K characters, about 45K tokens per turn. |
| **CI polling** | (no change needed) | The production audit claim was **wrong**: CI and deploy status are polled by the controller (30 s apart, no model turns), and the model has no CI tool. A test now locks this in. |
| **Owner metric: TOTAL MODEL USAGE** | new `usage-telemetry.js` | Input + output tokens of every model attempt, successful and failed. Cached and reasoning tokens are parts of those totals and are not added again. The metric also reports retries and tool-loop calls. `jobs.tokens_used` and `runs` are older counters. |
| **Capacity API (read-only)** | new `hub-capacity.js`, `GET /api/capacity` | Pools (one per independent quota) with state, next reset, tokens today and this month, failed attempts today, and `estimatedCapacityLeft: null` unless a provider reports one. Also free-capacity totals and the search breaker state. There is no UI yet. |
| **Mistral readiness** | `capabilities.js` (a `mistral-medium` planning score) | The route already exists: `mistral-medium-latest`, `MISTRAL_API_KEY`. It is inactive without a key. It defaults to `paid` until the owner sets `MISTRAL_BILLING_CLASS=free` after verifying the quota. Privacy is off (public data only). It is its own `mistral:account` pool. Qualification and `canary:agentic` apply as for any route. |

## Offline Sanad Desk replay

The test is `SANAD REPLAY` in `test/router-efficiency.test.js`. It uses the
production state at 07:25 UTC on 2026-09-28:
* the OpenRouter free pool exhausted until 00:00 UTC;
* Gemini Flash exhausted until 07:00 UTC;
* production qualification evidence;
* a `[free-only]` FINANCE step (6K input tokens, 4K output).

**Result:** the step completes on another qualified free route. The exhausted
OpenRouter pool and Gemini Flash are **not called**. Before the fix, the
router's only eligible FINANCE route was the other OpenRouter model, on the
same exhausted quota, so the step waited about 17 hours.

`node tools/router-replay.mjs [repository-root]` prints the eligible routes
and pools per job. It runs the real router with placeholder keys and no
network.

| Job | Before: healthy | Before: Sanad state | After: healthy | After: Sanad state |
|---|---|---|---|---|
| FINANCE (routine) | 3 routes / 2 pools | **1 route / 1 pool** (the exhausted pool) | 10 / 8 | **7 / 6** |
| RESEARCH / PRODUCT / LEGAL | 7 / 5 | 5 / 4 | 10 / 8 | 7 / 6 |
| SOCIAL / CREATIVE (content) | 7 / 5 | 5 / 4 | 10 / 8 | 7 / 6 |
| CHIEF / AUDIT (orchestration) | 10 / 8 | 8 / 7 | 10 / 8 | 7 / 6 |
| CHIEF synthesis | 2 / 2 | **0** | 2 / 2 | **0 (unchanged — see risks)** |

## Capacity before and after (per day)

* **MEASURED** means production telemetry: `docs/free-capacity-audit.md`.
* **ESTIMATE** means our arithmetic: documented quotas, with assumptions
  stated.

| Metric | Before | After |
|---|---|---|
| Pools eligible for routine FINANCE | 2 (MEASURED: flash about 20 RPD, OpenRouter 50 RPD) | 8 (Groq ×3 at 1K RPD / 200K TPD each, flash-lite about 500 RPD, gemma, GLM, flash, OpenRouter) |
| Strong capacity for FINANCE | about 70 calls, about 0.4M tokens (MEASURED) | about 1.5–3M tokens (ESTIMATE: Groq 0.6M + flash-lite about 2M + the rest; Gemma and GLM unpublished, not counted) |
| Strong capacity for CHIEF synthesis | about 70 calls (MEASURED) | unchanged, but low-value work no longer spends it |
| Mixed Office projects per day | 3–5 (ESTIMATE from MEASURED medians) | about 10–15 (ESTIMATE: synthesis stays the limit at about 1.2 strong calls per project) |
| Failed or retry overhead | 67 of 603 Office attempts failed (11%, MEASURED); same-pool retries and 6 Sanad restarts against exhausted quotas | same-pool retries removed by pool cooldown (tested). The share of failed attempts must be re-measured after deployment. |
| Tokens per mixed project | about 100K (ESTIMATE from MEASURED medians) | about 80–90K (ESTIMATE: handoff packets −10–20% of specialist input, FINANCE without web tools, the search breaker) |
| Coding tokens | small tasks about 120K median, one outlier 621K (MEASURED) | about −15–30% on long sessions (ESTIMATE: compaction at about 45K tokens per turn plus the turn budget; the outlier is re-planned at 18 turns) |

## Remaining risks

1. **CHIEF synthesis still depends on two scarce pools** (Gemini Flash and
   OpenRouter free). A `[free-only]` job can still wait for synthesis until a
   reset. Adding Mistral (strong tier, own pool) is the fix. Lowering
   synthesis requirements would be unsafe.
2. **Groq requests are limited to 8K tokens per minute.** Longer requests
   still exclude Groq (a correct rate limit), and a long answer continues
   over several calls.
3. **Evidence raises depend on the qualification suite** (basic skills). The
   raise is limited to +1 level and is excluded for strict jobs.
4. **The breaker is per process.** The Hub and the worker each keep their
   own; that is acceptable because both recover on success.
5. **The keyword classifiers** (`financeJob`, `needsExternalFacts`,
   `taskSize`) can misjudge. They fail safe: an unrecognised finance task is
   routine, but its figures are validated by code, and `[critical]` forces the
   strong tier.
6. **Production behaviour must be re-measured after deployment:**
   waits per task, failed-attempt share, and strong calls per day.
