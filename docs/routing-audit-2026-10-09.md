# Production reliability, routing and worker truthfulness audit (2026-10-09)

Status: the fixes are on branch `claude/quirky-shannon-ba3f6e` (open PR). They are **not merged and not deployed**. One additive migration, `20261009090000_close_cancelled_session_runs.sql`, is **not applied** and needs Fahad's approval.

Production evidence was read only, through read-only SQL on project `zkzibipinjeswhdxnfgf`. Nothing in production was changed or deleted.

## 1. Why CHIEF waited (synthesis, about 08:40 UTC)

CHIEF synthesis uses the `synthesis` profile: reasoning ≥ 4, writing ≥ 4, `strictEvidence`. With strict evidence, qualification results can never raise the static scores, so only two free routes met the floor. Both were cooling down, so the step waited. Several healthy free routes had passed all 7 qualification skills.

| Route | Live state | Synthesis decision (before) |
| --- | --- | --- |
| gemini `gemini-flash-latest` | cooldown until 08:41 (transient) | eligible, cooling down |
| nvidia `nemotron-ultra` | network errors, cooldown until 08:55 | eligible, cooling down |
| groq `gpt-oss-120b` | healthy, qualified 7/7 | excluded: `CAPABILITY_WRITING_BELOW_4` |
| nvidia `nemotron-super` | healthy, qualified 7/7 | excluded: writing 3 |
| groq `qwen3.8-27b` | healthy | excluded: writing 3 (Arabic 2) |
| gemini `flash-lite` | healthy | excluded: below the floor |
| gemma-4-26b, glm-4.5/4.7-flash | healthy | excluded: below the floor |
| gemini-2.5-flash / flash-lite | never answered | `NEVER_SUCCEEDED` |
| cerebras | HTTP 400 on every call | dead, still probed daily |
| openrouter gemma `:free` | 429 on the shared allowance | still probed several times a day |
| inkling | authentication error | not set up |
| deepseek-flash (paid) | healthy, 4/4 | `PAID_ROUTE_NOT_ALLOWED` on free-only jobs |
| anthropic (paid) | healthy | usable only if paid is allowed |
| kimi, minimax, qwen paid, glm-5.3 | account or authentication blocked | not set up |

The stale or strict exclusion was the static writing score of 3 on routes with 7/7 qualification evidence.

## 2. Root causes and fixes

1. **Static scores overrode qualification evidence for synthesis.** `relaxedJob('synthesis')` is now a *qualified fallback*: reasoning ≥ 4, writing ≥ 3, and `evidenceRequired`. A free route qualifies only with a current `qualified` record that passed every synthesis skill (`evidenceRequiredGaps`). The full floor is always tried first. The fallback runs only when every full-floor route is busy, and the Office says so (`QUALIFIED_FALLBACK`). Privacy and data-class rules are unchanged; the fallback cannot reach a route that privacy excludes.
2. **Dead routes were probed forever.** Qualification now backs off on consecutive failures. Permanent errors wait 1, 2, 4, then 7 days at most. Transient errors wait an hour, or a day after 6 failures in a row. No credential or provider definition was removed. Routes that never answer show as *Never answered* or *Rarely answers* instead of healthy.
3. **Wait messages were vague.** A waiting step now says which routes are cooling down and until when, and how many routes were excluded, grouped by reason (capability, privacy, not set up, never answers, routing policy). It also gives the paid fallback status and the next automatic retry, in Dubai time. The Hub shows this text on the employee, the Live Office, the chat stage and the capacity banner.
4. **Worker cards were not truthful.** Each worker is classed ACTIVE, CONFIGURED (unavailable), DISABLED, MANUAL-ONLY or EXPERIMENTAL. Each card answers five questions: can it execute now, is it authenticated, is it enabled, does it have real quota, and can the Office hand off to it automatically.
5. **Cancelled Coding sessions left their run 'running'.** `request_agent_session_cancel` cancelled the session and the job but not the carrier run or the task. The new migration fixes the function. It also closes the 9 such runs in production; the preview showed 9 runs, and the 4 blocked sessions are untouched.
6. **The Hub could default to a test or archived project.** `/api/workspaces` now returns `status`. `defaultProject` never picks an archived project, or one whose name says test, demo, certification, sandbox, staging or "safe to delete". It prefers "Fahad AI Office".

Verified as already correct:
* Tokens-per-minute limits are not treated as a context window.
* `minContext` uses the real request size.
* Auto-resume works:
  * `defer_task` raises `max_attempts`, so a wait never consumes a retry;
  * `not_before` together with `claim_next_task` survives restarts;
  * checkpoints prevent duplicate work.
* All 6 historical waits in production resumed by themselves, and none is past due.

## 3. Engine table and Capacity UI

* The engine table has a *Serves* column. It lists the roles each route serves, plus "(qualified fallback)" roles.
* The capacity banner lists each waiting employee and why it waits.
* The model list marks never-answering routes as unavailable.

## 4. Test and demo records

The records were classified and **none was removed**. Deleting jobs would cascade into `model_attempts`, the cost and audit ledger. `tool_executions` and `agent_sessions` are RESTRICT. The records are also release evidence.

* **CONFIRMED TEST:** about 80 jobs, including:
  * probes, canaries, smokes and drills;
  * benchmarks, acceptance, burn-in and load runs;
  * "Office test 1–5" and "V2 check turn 1–4";
  * the Continuity Phase N drills and the V5 production smoke.
* **CONFIRMED REAL:** the early key checks, the Qwen fix and its continuation, the route-id helper and docs jobs, the provider facts, the Telegram greeting, the language check, «كم متخصص في المكتب» and «شو أخبارك اليوم ؟».
* **UNCERTAIN:** Morning Harbor, the bakery tagline, and the Qahwa Run checks.

The Hub already hides finished objectives from the live views. A cleanup can follow the `docs/v5.4-test-data-manifest.md` pattern (preview first, then Fahad approves).

## 5. Production E2E

A labelled, harmless objective (CHIEF + 3 specialists + synthesis) must run **after** this PR is deployed, because production still runs the old routing. It has not been run.

## Owner actions

1. Review and merge the PR (this deploys production).
2. Apply `20261009090000_close_cancelled_session_runs.sql`.
3. Run the labelled E2E objective.
