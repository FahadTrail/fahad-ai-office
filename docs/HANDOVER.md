# Handover for the next coding agent (Codex / ChatGPT / Claude)

Last updated: 2026-09-29, after Capacity Expansion V2 (see its section below). Read `AGENTS.md` first; it holds the permanent rules.
This file is the live state. **The release procedure is
`docs/FINAL-RELEASE-RUNBOOK.md`: follow it phase by phase.**

## CAPACITY V2 WAVE 2 (updated 2026-09-29 ~21:00 UTC)

**Production:** `main`, with PRs #77–#84 deployed and healthy. After every restart the Supabase self-check and Telegram report OK.

**Migration** `20261003090000_capacity_snapshots`: applied and verified (fingerprint equal). Snapshots are written daily; `/api/capacity` → `capacity.history`, and now also `capacity.publicCoding`.

**Free public coding works (MEASURED, production, $0).** Session `7986c750`:
* Gemma 26B (Gemini free), pinned; small task on this public repository.
* Wrote `test/pool-registry-allowance.test.js`: 7/7 pass, finish gate passed.
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

**Failover drill:** see the live result in `docs/capacity-v2.md` §8 (session `12a9cad3`, Gemma → GLM-4.7-flash).

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
| Current production commit | `main` `13f09ea` (V4 + V4.1). Rollback point R0. Verify with `/healthz` → `version`. |
| PR #72 router (`claude/router-efficiency-v1`, `66cf3ee`) | Draft, CI green, 392 tests. Merge **first**. |
| PR #73 providers (`claude/provider-expansion-prep`) | Draft, stacked on #72, CI green. Merge **second**, after #72 is verified in production. |
| PR #71 V5.1 (`claude/v5-immersive-office`, `19c13b8`) | Draft, CI green. Merge **last**, only after Fahad's visual approval; merge `main` into it first. |
| Merge order | #72 → deploy → smoke → #73 → deploy → (Mistral) → 24 h measurement → #71. |
| Rehearsal | `main`→#72→#73 fast-forward with no conflicts: **401/401**. Adding #71: one docs conflict (this file, add/add): **430/430**. |
| Migrations | Production has all 30; none of the three PRs adds one. |
| Rollback points | R0 `13f09ea`; R1 = #72 merge; R2 = #73 merge; R3 = #71 merge. Mechanism: GitHub **Revert** on the merged PR (see runbook §4). |
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
