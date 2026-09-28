# Handover for the next coding agent (Codex / ChatGPT / Claude)

Last updated: 2026-09-28, about 19:30 UTC, at the end of the router and token
efficiency sprint. Read `AGENTS.md` first; it holds the permanent rules. This
file is the live state.

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

**Tests:** `node --test` gives 392 pass, 0 fail (at the commit this handover
was written for).

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
