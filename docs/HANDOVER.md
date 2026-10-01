# Handover for the next coding agent (Codex / ChatGPT / Claude)

Last updated: 2026-10-01, Coding Continuity Supervisor handover to Codex (top section); product complete (below). Read `AGENTS.md` first; it holds the permanent rules.
This file is the live state. **The release procedure is
`docs/FINAL-RELEASE-RUNBOOK.md`: follow it phase by phase.**

## CODING CONTINUITY SUPERVISOR — HANDOVER TO CODEX (2026-10-01)

> **UPDATE 2026-10-01 — READ THIS FIRST.** Continuity **Phase A is implemented** on branch `claude/continuity-foundation`, PR https://github.com/FahadTrail/fahad-ai-office/pull/102 (**open; migration NOT applied; do not merge without Fahad**). Phase B is not started. The current handover (prompt, checkpoint, exact next action) is the version of this file and of HANDOVER.md **on that branch**, and .continuity/checkpoint.json there. Do **not** start Phase A again from main.

**New work, approved by Fahad:** the Coding Continuity Supervisor. Claude Code locked the architecture and wrote the spec, then stopped. **Codex implements it, starting with Phase A.** Start at `docs/CODEX-CONTINUE.md` (ready-to-paste prompt and the continuity checkpoint).

* **Architecture (locked):** `docs/CODING-CONTINUITY-SUPERVISOR.md`.
* **Build order, phases A–N:** `docs/CONTINUITY-IMPLEMENTATION-PLAN.md`.
* **Rules for every coding worker:** `docs/DEVELOPMENT-CONTRACT.md`.
* **Permanent worker stack:** Fahad Office Coding Agent, Claude Code, OpenAI Codex, Google Antigravity, OpenCode, Kilo Code, Freebuff. Bridges (not workers): OpenHands/ACP, official CLIs, GitHub, worktrees, CI, Supabase, checkpoints.
* **State at handover:** production `2bb17b0` (deploy run 86); main = the docs-only merge of PR #101 on top of `abe447a`; no other open PRs; nothing of the Supervisor is implemented and no migration is written or applied.
* **Next exact action:** create `codex/continuity-phase-a` from `main` and implement Phase A (migration `20261004090000_coding_continuity`, scenario, checkpoint validator, state machine, tests). Do not apply the migration to production; that needs Fahad's approval, and the Phase A PR stays open until then.
* **Supervisor flag:** `CONTINUITY_SUPERVISOR` stays off by default until the Phase N drill passes and Fahad turns it on.
* **Do not touch:** core routing, capacity, FINANCE/AUDIT/fact gate, the V5 UI, deployment files, Hermes.
* **Rollback of this handover:** GitHub Revert of PR #101 (docs only).

## PRODUCT COMPLETE (2026-10-01)

**FAHAD AI OFFICE — COMPLETE AND READY FOR DAILY USE.** Development is stopped. New work happens only when Fahad asks for it. Summary: `docs/PRODUCTION-READY.md`. Daily guide (Arabic): `docs/HOW-TO-USE.md`.

* **Production:** `2bb17b0` (#99 on top of V5 `90142a9`).
* **Rollback:**
  * V5: GitHub Revert of #71.
  * Watchdog: Revert #99, or set `OPS_WATCH=false`.
  * Last known good core: `ab2f26f`.
  * No database rollback is needed.
* **Merged today:**

  | PR | What |
  |---|---|
  | #71 | V5 immersive Office (refreshed onto the core closure; the project page's View tablist no longer contains a button) |
  | #99 | Watchdog runs inside the runtime every 15 min; accurate blocker wording |

  Each deploy: "DEPLOYMENT SUCCESSFUL … container healthy", Supabase tools check verified, Telegram live.
* **QA on the refreshed V5:**
  * All tests pass: 510 on the refreshed V5, 511 with #99.
  * axe WCAG 2 A/AA: 0 violations (12 routes × 2 themes, plus the immersive Office).
  * No horizontal overflow from 1920 down to 390 px.
  * 13 3D views render with no errors; phone, tablet and Light fall back to the light Office.
  * Size: engine 149.9 KB gzipped, scene 37.6 KB.
* **Live smoke (free-only, $0):**
  * **Office job `6fad4ac3`:**
    * CHIEF planned the work and wrote the final answer.
    * RESEARCH fell back to 2 fetched pages when search was rate-limited.
    * FINANCE: INCONSISTENT → VERIFIED (AED 18 margin, 1,500 boxes/month, 50/day).
    * AUDIT flagged both of the supplier's wrong figures (AED 20 and 1,350) as high severity.
    * The fact gate kept 9 validated figures.
  * **Coding `ec81c365`:** passed in 6.5 min; 8,265 characters of test output compacted.
  * **Watchdog:** first run at 09:26Z recorded and sent the 6 known account blockers once; the 09:41Z run sent nothing.
  * **Telegram:** one conversation, no duplicates.
  * **Capacity snapshot (2026-10-01):** all fields present; 4.02M free tokens/day ESTIMATED.
  * **Needs Fahad:** no pending approvals, only the optional provider unlocks.
* **Not verifiable from the agent sandbox:** its proxy blocks the VPS host, so `/healthz`, `/api/office` and `/api/capacity` were not called over HTTP. Deploy logs, startup events and the database confirmed the state instead.

## CORE CLOSURE (2026-09-30, after the 24 h burn-in)

**CORE COMPLETE: READY FOR REAL USE.** Core development is stopped. The next phase is V5/UI only (PR #71). Everything else is optional expansion.

* **Production:** `26dd491` (deploy 84). Last known good before the closure merges: `343a1bf` (deploy 79).
* **Burn-in window:** 2026-09-29T21:56Z → 2026-09-30T21:56Z.
  * No deploy ran inside the window.
  * It was a **stability** burn-in and mostly idle, **not** a continuous-load benchmark. Sustained 24 h throughput is NOT MEASURED; that is an optional future exercise.
* **24 h numbers (MEASURED):**

  | Metric | Value |
  |---|---|
  | Calls | 70 (54 OK, 16 failed, 11 rate-limited) |
  | Tokens | 510,902 OK (486,610 in / 24,292 out); 374,259 cached; 7,151 reasoning; 0 retry tokens |
  | Cost | **$0**; 0 paid calls; 100 % free |
  | Latency | p50 5.5 s, p95 89.6 s |
  | Jobs | 2 created, 2 completed |
  | Coding | 1 small PUBLIC session completed, with 2 real failovers |
  | Capacity waits | 1; 631 s of backoff waits |

  Checkpoints: 0–1 h, 0–6 h and 0–12 h were identical (15 calls). No call ran between 22:17Z and 11:09Z because no work was submitted.
* **Report:** `docker compose exec -T runtime node src/ops/burnin-report.js --since=2026-09-29T21:56:00Z --hours=24` (use `--hours=1|6|12` for the shorter windows).
* **Merged and deployed in order.** Each deploy said "DEPLOYMENT SUCCESSFUL … container healthy", and after each one the startup events showed the Supabase tools check verified and Telegram live.

  | PR | Commit | Change |
  |---|---|---|
  | #92 | `61015d8` | burn-in report + bottleneck analyzer, shipped in the image |
  | #91 | `526c264` | reset-aware backoff (per-minute windows, exact resets) |
  | #96 | `1affc39` | test-output compaction for the Coding Agent |
  | #94 | `f4de1d7` | ops watch (Telegram alerts) |
  | #95 | `26dd491` | Mistral owner action needs `MISTRAL_BILLING_CLASS=free`; provider readiness doc |

  The #94 deploy's first SSH connection timed out before anything reached the VPS (the runtime was up). The one allowed re-run succeeded.
* **Rollback:** GitHub **Revert** on any of these PRs deploys the previous code through the same pipeline. None of them has a migration. Provider kill switches: `workspace_routing_policies.excluded_routes`, or remove a key with `ops/set-secret.sh`.
* **Final smoke (2026-09-30 22:18Z, free-only):**
  * **Coding `8b5f0724`:** passed in 4 min, 153K tokens, $0. Gemini Flash failed → switched to GLM from its checkpoint. #96 saved 8,670 characters (MEASURED).
  * **Office `e445770e`:**
    * CHIEF planned 3 workstreams.
    * FINANCE: INCONSISTENT → returned → **VERIFIED** (AED 12 margin, 1,500 cups/month, 50/day).
    * AUDIT flagged the planted partner figures (AED 14, 1,286 cups) as high-severity errors.
    * The fact gate kept 9 validated figures.
    * RESEARCH reported INSUFFICIENT evidence (search rate-limited, rent sources blocked) instead of inventing numbers.
    * The CHIEF synthesis waits for free capacity until the OpenRouter reset at 00:00 UTC; see bottleneck 1.
* **Owner steps still open (optional):**
  * Add the ops-watch cron on the VPS: `docker compose exec -T runtime node src/ops/ops-watch.js --dry-run` first, then every 15 min without `--dry-run`. The first real run sends one message listing the known account blockers (Qwen not activated; Kimi, MiniMax and GLM-5.3 without credits; inkling refuses the key). It never repeats them.
  * Set `OPS_WATCH_HEALTH_URL` for the `/healthz` probe.
* **Top bottlenecks:**
  1. **Strong-reasoning free capacity is thin.** CHIEF synthesis has only OpenRouter nemotron-ultra (50 requests/day, shared across the key) plus Gemini Flash (5xx all day). Owner options: a Mistral key with `MISTRAL_BILLING_CLASS=free`, a one-time $10 OpenRouter credit (50 → 1,000 requests/day), or the paid fallback when the monthly budget resets.
  2. **Per-minute quota waits** (Gemma 16K/min): 631 s in 24 h. #91 is now live (replay estimate −15 % to −49 % coding wall time).
  3. **GLM-4.5-flash token use** on coding: 153–375K per small job against 87–98K on Gemma.
  4. **Privacy:** free PRIVATE coding is 0 by policy (`docs/private-coding-policy.md`).
  5. **Large coding:** turns of 25–63K exceed free per-minute quotas; UNKNOWN until a large job completes.

## CAPACITY FINALIZATION + 24 H BURN-IN (history, 2026-09-29)

**Merged this sprint:**

| PR | What it changed |
|---|---|
| #86 | The coding suite's ten-task call gets 300 s: a grader artifact, not a capability test |
| #87 | Per-size coding turns (10K/16K/30K); the reported TPM is a limit; compaction happens when only the request size blocks a route |
| #88 | Finalization docs, burn-in SQL, job-summary fix |

**Measured today (production, $0):**

| Measurement | Result |
|---|---|
| Gemma 26B quota | reported by Gemini: **16,000 input tokens/min** (`provider_status.rate_limit`) |
| Free coding turn sizes | small/medium: p50 5.5K, p90 9.1K, max 16.4K |
| Small PUBLIC coding job | completed on Gemma alone (87K tokens, 20 min) and with Gemma → GLM failover (98K, 7.5 min) |
| Medium PUBLIC coding, run 1 (`f94a2cbe`) | blocked at iteration 12: the next turn (≈16.4K) exceeded Gemma's 16K/min. Fixed in #87 by compacting |
| Medium PUBLIC coding, run 2 (`ed64507a`) | running on Gemma after the fix |
| Multi-pool load test (`668ad9a5`) | CHIEF + RESEARCH + FINANCE, free-only, completed at **$0** on Groq (3 models) + OpenRouter (Nemotron-ultra), with Gemini failing over. 29 calls (19 OK), ≈72K tokens. FINANCE validation caught a wrong "net" and was corrected to **VERIFIED** (break-even 1,325 cups/month = 51/day). The CHIEF fact gate kept 8 figures and removed 2 contradictions |
| Free coverage since 2026-09-28 | **100 % of calls free, $0**. Paid fallback is 0 %, partly because the $2 budget is spent ($2.38) |

**Coding grades (c2):**

| Route | Grade |
|---|---|
| Gemma 26B (Gemini) | CODING_PRIMARY, 16K/min |
| GLM-4.7-flash (Z.ai) | CODING_SMALL_TASKS |
| dots-3-note-preview (OpenRouter shared pool) | **CODING_PRIMARY (new)** |
| Groq gpt-oss-120b | SECONDARY, but 8K/min is below a small turn |
| gpt-oss-20b | NOT approved |

Nemotron-ultra, GLM-4.5-flash, Gemini Flash and Gemma 31B are still pending; errors back off and are retried automatically.

**Privacy:** PRIVATE free coding = 0. See `docs/capacity-v2.md` §9 for the per-provider verdicts.

**Owner actions (≤5, ranked):**
1. Mistral key (SMS);
2. LLM7 token;
3. Cloudflare token + account id;
4. Z.ai privacy review;
5. OpenCode Zen key (disable auto-reload).

Exact steps are in `/api/capacity` → `ownerActions`.

**Next command:** wait for the +24 h checkpoint. Then:
* write the final report (phases 19–22);
* decide CORE READY / NOT READY;
* update this file.

## CAPACITY V2 WAVE 2 (history — updated 2026-09-29 ~21:00 UTC)

**Production:** `main`, with PRs #77–#84 deployed and healthy. After every restart the Supabase self-check and Telegram report OK.

**Migration** `20261003090000_capacity_snapshots`: applied and verified (fingerprint equal). Snapshots are written daily; `/api/capacity` → `capacity.history`, and now also `capacity.publicCoding`.

**Free public coding works (MEASURED, production, $0).** Session `7986c750`:
* Gemma 26B (Gemini free), pinned; small task on this public repository.
* Wrote the benchmark's new unit-test file (kept in the sandbox, `publish: none`): 7/7 pass, finish gate passed.
* 7 turns, 86.7K tokens, $0, 20 min wall time.
  * About 10 min of that was provider per-minute cooldowns.
  * It survived a worker restart (resumed from checkpoint 19).

**Five bugs found by the benchmark, all fixed and deployed:**
* #81: the coding worker never loaded catalog-discovered routes.
* #82 (1/2): the static `coding ≥ 4 / reasoning ≥ 4` claims outranked the measured grade.
* #82 (2/2): body-read timeouts leaked as `errorCode "23"`. PUBLIC coding capacity is now reported separately.
* #83: the cooldown wait crashed on a checkpoint reason the DB rejects.
* #84: Gemini's 429 quota numbers were ignored, so the backoff escalated to 8 min on requests that can never pass.

**Coding grades (suite `c2-2026-09`):**

| Route | Grade | Coding-turn capable? |
|---|---|---|
| `gemini:gemma-4-26b-a4b-it` | CODING_PRIMARY | yes: small job MEASURED. Its per-minute input quota throttles turns above ≈16–25K tokens; exact value is logged in `provider_status.rate_limit` after the next 429 (#84). |
| `zhipu:glm-4.7-flash` | CODING_SMALL_TASKS | yes for small (200K context, no request cap; 1 concurrent). Second, independent pool. |
| `groq:openai/gpt-oss-120b` | CODING_SECONDARY | no: 8K TPM is below one turn |
| `groq:openai/gpt-oss-20b` | NOT_CODING_APPROVED | no |
| OpenRouter nemotron-3-ultra/super | queued | pending (the OpenRouter slot was spent on 429ing Gemma routes) |

**Two-pool failover: PASSED live.** Session `12a9cad3`:
* The drill moved Gemma → GLM-4.7-flash.
* Two further real rate limits switched GLM → Gemma → GLM from checkpoints.
* Tests passed; 98K tokens, $0, 7.5 min.
* Details are in `docs/capacity-v2.md` §8.

**Next commands:**
1. Grades: SQL on `provider_canary_runs` with `report->>'kind' = 'coding_qualification'`.
2. Benchmark: `node tools/coding-benchmark.mjs start --route=<id> --task=small|medium`, then `report --session=<id>`. Or copy the config of `7986c750` with `create_coding_session`.
3. Burn-in after 24 h: `node tools/burnin-report.mjs --since=2026-09-29T21:00:00Z`.

**Privacy:** no free route is PRIVATE-eligible.
* Groq: terms are explicit, but 8K TPM rules it out for coding.
* Z.ai: evidence is incomplete; Fahad must read its DPA.
* Private code is never sent to free routes until Fahad sets a flag.

## CAPACITY EXPANSION V2 (branch `claude/capacity-expansion-v2`, PR open, NOT merged)

**Read `docs/capacity-v2.md`.** It is the full record: the baseline, the provider research, what was built (§3), the capacity model and today's production estimate (§4), the owner queue (§5), the deployment waves (§6) and what needs 24 h measurement (§7).

Branched from `main` `199c1d6`. Nothing from this branch is deployed; merging deploys wave 1.

State:
* Tests: `node --test` passes 447/447.
* Schema fingerprint updated for the one new migration, `20261003090000_capacity_snapshots`. It is additive, RLS on, service role only. **Not applied to production**: that needs the owner's approval, and the writer stays off until then.
* New modules, all in `src/model-gateway/agentic/`:
  * `pool-registry.js`, `provider-contract.js`;
  * `coding-qualification.js`, `capacity-model.js`;
  * `owner-actions.js`, `capacity-snapshots.js`.
* Tests: `test/capacity-v2.test.js`, `test/coding-qualification.test.js`, `test/capacity-model.test.js`.
* Behaviour changes, on purpose:
  * Discovered OpenRouter/Gemini routes, and all new-provider routes, need a passed qualification before any job.
  * With qualification evidence present, free routes take **coding** work only with a coding-suite grade matching the job size.
  * Failed qualifications back off (24 h permanent / 1 h transient).
* Production estimate (2026-09-29):
  * ≈3.1M effective free tokens/day (≈94M/month) for general work;
  * **free coding 0/day** (private code, and no free route has a coding grade yet);
  * ≈47 (p50) / 13 (p90) Office projects/day, free-only.

Next actions:
1. Owner reviews and merges the PR (wave 1).
2. Owner sets keys with `sudo bash ops/set-secret.sh NAME` (queue order in capacity-v2 §5) and restarts. There is no deploy, and never a key in chat.
3. The owner approves applying the snapshots migration.
4. After 24 h, compare `/api/capacity` → `capacity` with §4 and update §4/§7.

## RELEASE STATE (read this first)

| Item | State |
|---|---|
| Current production commit | `main` `46ee40a` (2026-09-29): V4 + V4.1 table gate (#74), router (#72), providers (#73), Telegram retry-safe lookup (#75). Verify with `/healthz` → `version`. |
| PR #72 router | **Merged** `2ece692`, deployed; router smoke job `36b1da92` passed at $0 (groq + OpenRouter free pools, Telegram delivered). |
| PR #73 providers | **Merged** `fbc1b8d`, deployed. Mistral inactive (no key). |
| PR #71 V5.1 (`claude/v5-immersive-office`) | Refreshed onto `main` `46ee40a` (merge commit). Merge **only after Fahad's visual approval**. V5 details: `docs/v5-handover.md`. |
| Merge order | #74 → #72 → #73 → #75 done; remaining: #71 after visual approval. |
| Rehearsal | `main`→#72→#73 fast-forward with no conflicts: **401/401**. Adding #71: one docs conflict (this file, add/add): **430/430**. |
| Migrations | Production has all 30; none of the three PRs adds one. |
| Rollback points | R0 `13f09ea`; R1 = #72 merge `2ece692`; R2 = #73 merge `fbc1b8d`; `46ee40a` (#75); R3 = #71 merge. Mechanism: GitHub **Revert** on the merged PR (see runbook §4). |
| Mistral | Code ready (#73); **no key**. Fahad's Free plan shows $10/month credits, but key creation is disabled ("Upgrade to use your API keys"). Likely cause: Studio not activated in Free mode. Owner path in runbook §5; **no card**. |
| V4 status | **V4 CLOSED** (2026-09-29). The remaining blocker, a model-written monthly table (revenue 111,489 / net 9,489) contradicting the VERIFIED FINANCE model (112,236 / 102,000 / 10,236, break-even month 12), was fixed by the financial table gate (PR #74, `docs/v41-reliability.md` → *Financial table gate*). Live acceptance job `ca6c8c0d` ($0): AUDIT blocked and removed the injected table, CHIEF replaced it with the calculator schedule, and Telegram delivered the correct answer. Release order: #72 (merged) → #73 → #71 after Fahad's visual approval. |
| Budget / routing | $2/month; `workspace_routing_policies` empty; no Mistral permission row. |

**Exact next command after V4 CLOSED** (Phase A, then Phase B of the
runbook): re-run the Phase A SQL, then on PR #72 confirm CI is green and ask
Fahad to merge it with a merge commit. Nothing is merged by an agent.


## 0. DO NOT TOUCH

**Merges and production:**
* **Do not merge PR #71** (V5 immersive Office, branch
  `claude/v5-immersive-office`) until V4.1 reports **V4 CLOSED** *and* Fahad
  approves the immersive direction.
* **Do not merge or deploy the router sprint PR** (branch
  `claude/router-efficiency-v1`) until V4.1 is closed *and* Fahad has
  reviewed `docs/router-efficiency.md`. Merging to `main` deploys production.
* **Do not touch V4.1 acceptance job `abaccdad-856e-4b8a-9898-b4116e6952e1`**
  (Sanad Desk, `[free-only]`, Telegram). It resumes by itself at 2026-09-29
  00:00 UTC. Never restart, cancel, re-run or switch it to paid.
* **Do not change production routing**: `workspace_routing_policies` stays
  empty; workspace provider permissions, budgets ($2/month), provider
  settings and secrets stay as they are.
* **Do not change the V4.1 reliability logic:**
  * FINANCE deterministic arithmetic (`src/office/finance.js`);
  * AUDIT numeric checks and the CHIEF fact gate (`src/office/quality.js`).

**Hermes:**
* Hermes is decommissioned: never restore, reconnect, depend on or modify it.
* Never touch its backup `/root/hermes-decommission-backups/20260927T120830Z`,
  its retained directories, or the old Google OAuth.

**Secrets, services and data:**
* No secrets in code, logs, commits or chat. Do not ask Fahad for API keys:
  providers are added one at a time after he reviews the audit.
* No new paid service.
* No destructive migration. This sprint added no migration.

## 1. Branches

| Branch | Content | State |
|---|---|---|
| `main` | Production (merge = deploy), head `13f09ea` | V4 + V4.1 live |
| `claude/fahad-audit-readonly-466kck` | Capacity audit docs, `tools/capacity-matrix.mjs` | Docs only |
| **`claude/router-efficiency-v1`** | **This sprint.** Based on the audit branch. | Draft PR, **do not merge** |
| `claude/v5-immersive-office` | V5 / V5.1 immersive Office (its own handover copy lives there) | Draft PR #71, do not merge |
| **`claude/provider-expansion-prep`** | Mistral readiness, CHIEF synthesis fallback, provider contract, capacity summary. Built **on top of** the router sprint branch. | Draft PR, do not merge (merge after #72) |

## 2. Router sprint: complete

Everything is listed in `docs/router-efficiency.md` (fix table, Sanad replay,
before/after capacity, risks). In short:
* TPM is no longer treated as a context window.
* Context requirements come from the actual request.
* Qualification evidence corrects planning scores.
* FINANCE is split into `finance` and `finance_critical`.
* Independent capacity pools, with pool-wide cooldown.
* Scarce pools are used last for low-value jobs.
* Lower-tier fallback applies only to low-risk jobs.
* A web-search circuit breaker; FINANCE web tools are off by default.
* Safe partial-draft handoff.
* Structured handoff packets between employees.
* A Coding turn budget with compaction and re-plan; compaction now starts
  earlier.
* The TOTAL MODEL USAGE metric, and `GET /api/capacity` (read-only).
* Mistral readiness (inactive without a key).

**Correction to the audit:** CI polling was never done by the model. It is
controller-side and costs 0 tokens. The audit's section J is corrected, and a
test (O) locks this in.

**Files changed:**
* `src/model-gateway/agentic/capacity-pools.js` (new),
  `src/model-gateway/agentic/usage-telemetry.js` (new),
  `src/model-gateway/agentic/capabilities.js`,
  `src/model-gateway/agentic/qualification.js`,
  `src/model-gateway/agentic/turn-gateway.js`,
  `src/model-gateway/agentic/model-pool.js`.
* `src/office/routing-hints.js` (new), `src/office/pool-runner.js`,
  `src/office/web-tools.js`, `src/office/specialist.js`,
  `src/office/capacity.js`.
* `src/coding-agent/turn-budget.js` (new), `src/coding-agent/controller.js`.
* `src/workflow.js`, `src/research.js`, `src/hub-capacity.js` (new),
  `src/hub-workspace.js`.
* Tests: `test/router-efficiency.test.js` (new: A–Q, the turn budget, Mistral,
  the Sanad replay); `test/provider-readiness.test.js` and
  `test/agentic-turn-gateway.test.js` were updated for the new semantics.
* Docs and tools: `docs/router-efficiency.md`, the correction in
  `docs/free-capacity-audit.md`, and `tools/router-replay.mjs` (new).

**Tests:** `node --test` gives 392 pass, 0 fail on the router branch (401 on
the provider-prep branch).

## 2b. Provider expansion prep: complete

Everything is in `docs/provider-expansion.md`:
* **Mistral readiness** (VERIFIED / ASSUMPTION / UNKNOWN), including the
  fixes: 9-character tool-call ids, no empty tools array, a monthly-quota
  wait, a declared pool and a catalog check.
* **Exact owner setup**, including the missing workspace authorization row.
* **CHIEF synthesis fallback test.**
* **NVIDIA and Cloudflare verdicts:** both not integrated, and why.
* **An adding-a-provider checklist** with a metadata contract test.
* **The capacity summary API:** `GET /api/capacity` returns `headline` and
  `summary`.

Files changed:
* `src/model-gateway/agentic/chat-completions.js`,
  `src/model-gateway/agentic/model-pool.js`,
  `src/model-gateway/agentic/capacity-pools.js`,
  `src/model-gateway/agentic/free-quota.js`;
* `src/hub-capacity.js`;
* `ops/set-secret.sh` (`MISTRAL_BILLING_CLASS`, Mistral key verification);
* `test/provider-expansion.test.js`, `docs/provider-expansion.md`.

Tests: `node --test` gives 401 pass, 0 fail.

**Secrets still missing** (do not request them until Fahad decides):
* `MISTRAL_API_KEY` (and `MISTRAL_BILLING_CLASS=free` if the free plan is
  confirmed);
* optionally, a free web-search API key.

**Owner actions**, in order:
1. Review PR #72, then the provider-prep PR.
2. Merge both only after V4 CLOSED.
3. Then follow the Mistral setup in `docs/provider-expansion.md` §2, which
   includes the workspace authorization SQL (it needs approval).

## 3. What remains

1. Check the V4.1 verdict after 00:40 UTC on 2026-09-29 (SQL in §5).
   Report **V4 CLOSED** or **V4 NOT CLOSED — remaining blocker: …**.
2. Fahad reviews `docs/router-efficiency.md`. Only then, and only if V4 is
   closed, merge the router PR. Then:
   * verify `/healthz` shows the new commit;
   * re-measure after 24 hours: waits per task (baseline 4 tasks / 12 waits),
     failed-attempt share (baseline 11%), and strong calls per day.
3. Remaining risk 1: CHIEF synthesis still has only two scarce free pools.
   The fix is Mistral, after Fahad provides `MISTRAL_API_KEY` and confirms the
   quota:
   * set `MISTRAL_BILLING_CLASS=free` only if the quota is verified;
   * run `canary:agentic`;
   * qualification;
   * a free-only live Office job.
4. Optional next efficiency work:
   * cache-friendly prefix ordering for Coding on providers with prompt
     caching;
   * a free web-search API once Fahad approves one (the breaker already
     handles outages).
5. A dashboard UI for `/api/capacity`: keep it simple (pools, not models).

## 4. Commands

```sh
npm ci
node --test                              # full suite, no network or credentials
node --test test/router-efficiency.test.js   # sprint regression matrix + Sanad replay
node tools/router-replay.mjs             # eligible routes/pools per job (healthy + Sanad state)
node tools/capacity-matrix.mjs           # full eligibility matrix with reasons
```

**Exact next command for a new agent:**
`git fetch origin && git checkout claude/router-efficiency-v1 && npm ci && node --test`

## 5. Useful read-only SQL (Supabase `zkzibipinjeswhdxnfgf`)

```sql
-- V4.1 Sanad Desk status and paid attempts (must be 0)
select status, (select json_agg(json_build_object('t',left(title,40),'s',status,'nb',not_before)) from tasks where job_id=j.id) from jobs j where id='abaccdad-856e-4b8a-9898-b4116e6952e1';
select count(*) filter (where cost_usd>0) paid, count(*) all_attempts from model_attempts where job_id='abaccdad-856e-4b8a-9898-b4116e6952e1';
-- Provider health / cooldowns
select provider, model, billing_class, health, cooldown_until from provider_status order by provider, model;
-- Waits per task (re-measure after deployment)
select count(*) filter (where wait_count>0) tasks_waited, sum(wait_count) waits from tasks where created_at > now() - interval '1 day';
```

## 6. Known risks

See `docs/router-efficiency.md` → *Remaining risks*:
* synthesis still depends on scarce pools;
* the Groq 8K per-minute rate limits request size;
* keyword classifiers can misjudge, but fail safe;
* the search breaker is per process.

## 7. Decisions made

* Pools, not models, are the unit of free capacity.
* Scarce pools are ordered last for low-value work, never reserved.
* Evidence may raise a planning score by at most one level (never above 4),
  never for strict jobs.
* Private and confidential work never goes to free routes that are not
  privacy-approved, and `[free-only]` never reaches paid.
* FINANCE without web tools unless it needs current external facts.
* OmniRoute, OpenCode Zen and FreeBuff are not capacity sources. Mistral is
  the next provider (owner key needed).
