# Handover for the next coding agent (Codex / ChatGPT / Claude)

Last updated: 2026-09-28, about 17:30 UTC. Read `AGENTS.md` first; it holds
the permanent rules. This file is the live state.

## 0. What must NOT be changed

**Merges and production:**
* **Do not merge PR #71** (V5, branch `claude/v5-immersive-office`) until
  **both**:
  * V4.1 reports **V4 CLOSED**, and
  * Fahad approves the immersive visual direction.
* **Do not touch V4.1 acceptance job `abaccdad-856e-4b8a-9898-b4116e6952e1`**
  (Sanad Desk, free-only, Telegram). Its FINANCE step resumes by itself at
  2026-09-29 00:00 UTC (the OpenRouter reset). Never restart, cancel or re-run
  it, and never switch it to paid.
* **Do not change production routing** (`workspace_routing_policies` is empty
  and must stay empty), provider permissions or budgets. The audit in
  `docs/free-capacity-audit.md` is a *plan*; its fixes need Fahad's approval.
* Do not change the FINANCE / AUDIT / CHIEF reliability logic
  (`src/office/finance.js`, `quality.js`, the fact gate).

**Hermes:**
* Hermes is decommissioned. Never restore, reconnect, depend on or modify it.
* Never touch its backup `/root/hermes-decommission-backups/20260927T120830Z`,
  its retained directories, or the Google OAuth of the old Hermes environment.

**Secrets and data:**
* No secrets in code, logs, commits or chat.
* Do not ask Fahad for keys yet: providers are added one at a time after he
  reviews the audit.
* No destructive database operations. Migrations are additive and
  timestamped. Update the fingerprint via replay (see `AGENTS.md`).
* Do not create paid services. Do not raise the budget ($2/month).

## 1. Branches and commits

| Branch | Purpose | Head | State |
|---|---|---|---|
| `main` | Production (merge = deploy) | `13f09ea` | V4 + V4.1 live |
| `claude/fahad-audit-readonly-466kck` | Designated branch: the capacity audit | see `git log` | Docs and a tool only, not deployed. Open a PR only if Fahad asks. |
| `claude/v5-immersive-office` | V5 / V5.1 immersive Office | see `git log` | Draft PR #71, CI green on `2e64253`; V5.1 commits on top |

## 2. Completed

**V4.1 (on main, deployed):**
* deterministic finance;
* AUDIT numeric checks;
* the CHIEF fact gate;
* the SOCIAL calendar;
* dependency-aware scheduling;
* `jobs.free_only`.

Acceptance status:
* job `1a797e28` (AUDIT caught a planted error) passed at $0;
* SOCIAL job `fa6ca885` passed;
* job `abaccdad` (the pre-validation planted error) is **pending**. At 15:00
  UTC it was waiting for the free-model quota, with 28 attempts, $0 and no
  paid attempts.

**V5 (branch):**
* a Three.js immersive Office;
* a private demo preview at https://claude.ai/artifact/Sxu7b13cJNNyeVthVd7jYg
  (fictional data, all writes refused).

**V5.1, started tonight (branch):**
* the sidebar reduced to five primary items plus a collapsed "More";
* image-based PBR lighting (RoomEnvironment through PMREM) on the high and
  balanced tiers;
* material tuning.

The plan is in `docs/v5.1-plan.md`.

**Capacity audit (designated branch):** `docs/free-capacity-audit.md` and
`tools/capacity-matrix.mjs`.

## 3. Exact next tasks (in order)

1. **After 00:40 UTC 2026-09-29:** check job `abaccdad` (the SQL is in §6).
   Verify:
   * FINANCE is VERIFIED: revenue AED 112,236, costs 102,000, net 10,236,
     cash break-even month 12;
   * the planted pre-validation error was caught and returned to FINANCE;
   * AUDIT ran its code checks;
   * the CHIEF final answer does not contain the planted value;
   * Telegram delivery happened;
   * cost is $0 with no paid attempts.

   Then report **V4 CLOSED** or **V4 NOT CLOSED — remaining blocker: …**. A
   check-in trigger (`trig_01UoEd4xoJiiu9NHXXDMgeSB`) fires at 00:40 UTC for
   the Claude session.
2. **V5.1**, following `docs/v5.1-plan.md` §3:
   * summary sentences first;
   * then furniture and architecture density;
   * then characters v2;
   * then night lamps.
3. **Capacity:** wait for Fahad's review of `docs/free-capacity-audit.md`.
   Then, on a new branch, implement the router fixes G1–G6 behind tests. Use
   `tools/capacity-matrix.mjs` to show before and after. Do not deploy
   without approval.

## 4. Files touched recently

**V5 and V5.1:**
* `src/hub-ui/office3d/*`;
* `src/hub-ui/office.js`, `office.css`, `office-presentation.js`;
* `src/hub-ui/index.html` (the sidebar), `app.js` (`markNav`), `app.css`
  (`.nav-more`, `.nav-sub`);
* `tools/three-entry.js` (PMREMGenerator, RoomEnvironment) and
  `src/hub-ui/vendor/three.js`, rebuilt with `node tools/build-three.mjs`;
* `tools/v5-preview-build.mjs`, `tools/v5-preview-shim.js`;
* `testing/fixtures/v5-demo-data.js`;
* `test/v5-immersive.test.js`, `test/v5-preview.test.js`.

**Audit:**
* `docs/free-capacity-audit.md`, `tools/capacity-matrix.mjs`.

## 5. Tests and commands

```sh
npm ci
node --test                          # 387 tests, no network or credentials
node tools/build-three.mjs           # rebuild the tree-shaken engine (budget: ≤170 KB gz)
node tools/office3d-shots.mjs <dir>  # 3D visual QA over the preview fixture
node tools/v5-preview-build.mjs <dir>  # static private demo preview (fictional data)
node tools/capacity-matrix.mjs [qualifications.json]  # router eligibility matrix, offline
npm run db:replay                    # only if migrations change
```

Headless Chromium needs `--use-angle=swiftshader --enable-unsafe-swiftshader
--ignore-gpu-blocklist` (see `tools/office3d-shots.mjs`). Software rendering
FPS is not representative.

## 6. Capacity audit queries (read-only, Supabase `zkzibipinjeswhdxnfgf`)

```sql
-- Sanad Desk status
select status, free_only, (select json_agg(json_build_object('t',left(title,40),'s',status,'nb',not_before)) from tasks where job_id=j.id) from jobs j where id='abaccdad-856e-4b8a-9898-b4116e6952e1';
-- Paid attempts on that job (must be 0)
select count(*) filter (where cost_usd>0) from model_attempts where job_id='abaccdad-856e-4b8a-9898-b4116e6952e1';
-- Provider health
select provider, model, billing_class, health, cooldown_until, requests_total, failures_total from provider_status order by requests_total desc;
-- Daily free usage and first 429
select started_at::date, provider, count(*) filter (where status='succeeded'), sum(input_tokens), min(started_at) filter (where http_status=429) from model_attempts group by 1,2 order by 1,2;
-- Qualification evidence
with r as (select completed_at, jsonb_array_elements(report->'results') x from provider_canary_runs where requested_by='auto-qualifier' and status='completed') select distinct on (x->>'routeId') x->>'routeId', x->>'status', x->'skills' from r order by x->>'routeId', completed_at desc;
```

## 7. Known blockers

* The production Hub is not reachable from the Claude sandbox. Verify through
  SQL and GitHub Actions.
* The official pages of OpenRouter, Groq, OpenCode and FreeBuff were blocked
  by the sandbox proxy tonight. The audit marks those facts REPORTED or
  2026-09-27 DOCUMENTED.
* A deploy SSH step sometimes times out. One "re-run failed jobs" fixes it.
* The VPS deploy key only deploys `main` (a forced command). A hosted preview
  on a subdomain needs Fahad (root: DNS and Traefik).

## 8. Decisions made

* The V5 preview is a private claude.ai artifact (static, fictional data) and
  not a VPS subdomain, so production is never touched.
* Employee click in 3D: the first click flies the camera to the workspace;
  a second click (or Enter) opens the panel.
* Capacity: OmniRoute, OpenCode Zen and FreeBuff are rejected as capacity
  sources. JEV is an optional quality/escalation-gate pilot only. Add Mistral
  first, then NVIDIA NIM. The OpenRouter $10 credit is Fahad's decision.
* Private code stays on privacy-approved routes (DeepSeek, Anthropic). Free
  routes are for public-data work only.
