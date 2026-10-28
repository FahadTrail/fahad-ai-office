# Fahad AI Office V3.0 — final product record

The single, authoritative description of what Fahad AI Office V3.0 is, what
is proven and how, and what is still waiting for Fahad. Release history and
database-protection details stay in `docs/FAHAD-OFFICE-COMPLETION.md`.

Evidence labels (honest, never upgraded without proof):

| Label | Meaning |
| --- | --- |
| IMPLEMENTED | Code exists on `main` |
| TESTED | Automated tests (`node --test`, replay, browser) pass |
| DEPLOYED | Running in production (`/healthz`, `runtime_started`) |
| E2E VERIFIED | A real workflow was observed end to end, with IDs below |
| PENDING OWNER ACTION | Built; needs a step only Fahad can take |
| BLOCKED | Cannot be completed without an external change |
| DEFERRED | Consciously left out of V3.0 |

## 1. Status at a glance

**Verdict: READY FOR DAILY USE — WITH LIMITATIONS (not "fully completed").**
All twelve V3.0 capabilities are implemented and deployed; **10 of 12 are
E2E VERIFIED in production** and the other two are TESTED + DEPLOYED (live
progress view; owner Resume — its first production use will be Fahad's).
What keeps V3.0 from "fully completed" are owner-only steps (§11): Google
OAuth for continuous use, an independent backup/restore drill, and vendor
logins for external coding workers. Python is now E2E VERIFIED (2026-10-28,
see below).

**Update 2026-10-28 evening — Python Coding Agent E2E VERIFIED.** The resume
defect behind the Python acceptance failure was fixed in
[#141](https://github.com/FahadTrail/fahad-ai-office/pull/141)
(merge `bcdb95a`, [deploy #120](https://github.com/FahadTrail/fahad-ai-office/actions/runs/40756500097)
success, event "Office runtime started on commit bcdb95ac25c9" 19:44:17 UTC);
root cause and fix in `docs/coding-agent-publish-verification.md`. Session
`bb02c85e` was resumed with the Hub's `resume_agent_session` at 19:45 UTC:
it warned that its recorded push was not on GitHub, pushed the original
commit `659573e` (authored 17:48) and verified it on the remote, opened
exactly one PR ([fixture #1](https://github.com/FahadTrail/fahad-office-python-acceptance/pull/1),
`refs/pull/1` is the only pull ref), CI passed (1 check), session
`completed`, $0. After the resume the ledger shows only `git.push`,
`github.pr_create` and two `github.ci_status` calls: no file write, edit or
command, so no completed work was redone. The 9 tests pass on `659573e`.

| | |
| --- | --- |
| Production | `main`, deployed by `deploy.yml`; see §9 for each release |
| Tests | `node --test` 867/867; CI `validate` green (tests, runtime image build, sandbox isolation as root) |
| Cost | October 2026: **$0.00** of the $2.00 budget (every V3.0 run on free routes) |
| Security | Supabase advisor 0 ERROR; RLS deny-by-default; no secret in the tree |
| Open P0/P1 defects | none known |

## 2. The twelve V3.0 capabilities

| # | Capability (owner's definition of done) | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Create a project or objective | E2E VERIFIED | Acceptance objectives 2026-10-27 (§9) |
| 2 | CHIEF takes charge | E2E VERIFIED | Every acceptance objective planned by CHIEF |
| 3 | Work is distributed to specialists | E2E VERIFIED | Multi-agent objective `e3113d70`: 7 workstreams, 20 handoffs |
| 4 | Tasks run automatically within permissions | E2E VERIFIED | Same objectives, free routes only, $0 |
| 5 | The right tools and models are used | E2E VERIFIED | Research with web search and sources (`3be79c51`); FINANCE validated in code (`196b2d92`) |
| 6 | Live progress of every employee | DEPLOYED, TESTED (browser) | Living Dashboard, job page, SSE; production UI cannot be driven from the agent sandbox (proxy) |
| 7 | Results and documents are delivered | E2E VERIFIED (synthesis); Word `.docx` TESTED + browser-verified | Final syntheses of the acceptance objectives; Word/PDF/Markdown export (§4) |
| 8 | Revision and resume without losing work | Revision E2E VERIFIED (`196b2d92`); Resume TESTED + DEPLOYED | Resume/Stop endpoints, stalled detection (§3) |
| 9 | Coding Agent on an authorised repository | E2E VERIFIED (2026-10-28) | Session `3cf33b7f` on `FahadTrail/fahad-ai-office` (§5, §9) |
| 10 | Development cycle to PR, CI and deploy on approval | E2E VERIFIED (2026-10-28) | PR #136 → CI → approval → merge `6d473e8` → deploy → `/healthz` version check (§9) |
| 11 | Cost, privacy and permissions | E2E VERIFIED | $2 cap, $0 spent, privacy-forced routing, approvals (§7) |
| 12 | Work continues after a worker stops or a model runs out | E2E VERIFIED | Capacity wait + auto-resume (2026-09-27), failover (2026-09-25, 2026-10-27); stale-run requeue, coding lease reclaim (TESTED) |

## 3. The Office (CHIEF and the team)

* **Flow:** objective → CHIEF plan → up to 8 workstreams across RESEARCH,
  CREATIVE, PRODUCT, FINANCE, CODING, AUDIT, SOCIAL, LEGAL → handoffs →
  one bounded revision round → CHIEF synthesis with a fact gate. Code:
  `src/workflow.js`, `src/chief.js`, `src/office/`.
* **Quality gates:** FINANCE arithmetic is deterministic and validated in code
  (`src/office/finance.js`: VERIFIED / INCONSISTENT / INSUFFICIENT DATA);
  AUDIT runs code checks before its model review; CHIEF's fact gate keeps
  validated figures and removes contradicting ones.
* **Owner recovery:** Stop (`POST /api/jobs/:id/stop`) and Resume
  (`POST /api/jobs/:id/resume`, requeues only unfinished steps; delivered
  work is kept) — `src/hub-job-actions.js`.
* **No false "running" (V3.0):** an objective that is running but has no step
  that can run (all finished or failed, past a 30-minute planning grace) is
  classified NEEDS_OWNER with next action `RECOVER_STALLED`
  (`src/domain/lifecycle.js`), shows "متوقفة — تحتاج تدخلك" on the job page
  with a Stop button, and is announced by the ops watch on Telegram. Stop then
  Resume recovers it. Never judged without the objective's steps loaded.
* **Memory and continuity:** project memory, curated knowledge with expiry,
  typed memory, conversations (`docs/workspace-v2.md`, `docs/office-workflow.md`).
* **Waiting is not failing:** a step with no free model capacity waits
  (`WAITING_FOR_CAPACITY`) and resumes from its checkpoint.

## 4. Deliverables and reports

* Deliverables Center: view, pin, archive, approve, request revision
  (`src/hub-deliverables.js`, `src/hub-ui/deliverables.js`).
* Full reports (an employee's report, CHIEF's synthesis) export as:
  * **Word — a real `.docx`** (V3.0; `src/hub-ui/docx.js`): Office Open XML
    built in the browser with no dependency; headings, lists, tables, quotes,
    code; every Arabic paragraph right-to-left. Verified: valid ZIP with
    correct CRCs, all parts well-formed XML, rendered by LibreOffice to PDF
    with correct Arabic shaping and RTL tables; downloaded from the real job
    page in Chromium at 390 px and 1440 px.
  * **PDF** — the browser's print dialog on the rendered report.
  * **Markdown** — the original text.
* Artifacts additionally export as CSV, Markdown, PNG and print.

## 5. Coding Agent

Pipeline: objective → repository profile → plan → test-first edit → test
gate (protected paths, Hermes isolation, secret scan, tests) → commit → push
→ pull request → CI follow-up and repair → merge approval → merge → deploy
watch → production verification → report. Code: `src/coding-agent/`,
worker `src/coding-worker.js`; full description in `docs/coding-agent.md`.

| Step | Status |
| --- | --- |
| Full cycle with real models, failover, worker restarts, CI repair, merge, deploy (2026-09-25) | E2E VERIFIED (historical rows were removed by the 2026-10-22 cleanup; the record is in `docs/coding-agent.md`) |
| V3.0 live cycle on the production worker (2026-10-28) | **E2E VERIFIED**: TASK → CODE → TEST → PR → CI → APPROVAL → MERGE → DEPLOY → worker restart → resume from checkpoint → VERIFY; $0 (§9) |
| Isolation: sandbox uid 1000, controller credentials unreadable | TESTED in CI inside the runtime image as root |
| Node.js projects (npm, pnpm, yarn, bun) | IMPLEMENTED, TESTED |
| Python projects | **E2E VERIFIED** 2026-10-28: Python 3.11.2 + pip in both containers; session `bb02c85e` → 9 tests → push (verified on GitHub) → PR → CI success, including a resume after a refused push (see §1 update) |
| Go, Rust | DEFERRED: the image has no Go/Rust toolchain. Such a session now stops with the clear blocker `TOOLCHAIN_MISSING` instead of looping on gate failures |
| Code privacy choice in the Hub | IMPLEMENTED (V3.0): "خصوصية الكود" — Private (default; privacy-approved models only) or Public repository (free models may read the code). Before V3.0 every Hub task was private, so free routes were always refused |

## 6. Continuity and external coding workers

* **Continuity Supervisor: ON** in production since 2026-10-04 (edge-log
  poll `freeze_stale_coding_leases` every 60 s, re-checked 2026-10-28).
* Native protections in daily use: Office stale-run requeue, capacity wait
  and auto-resume, coding session checkpoints every turn and lease reclaim
  after a worker restart, idempotent publish (force-with-lease push, one PR
  per branch, one approval consumed once, deploy watched not repeated).
* External workers: adapters exist for Claude Code CLI, Codex CLI, Gemini
  CLI and OpenCode (`src/continuity/`); all are **disabled** in
  `coding_workers` because each needs an interactive vendor login on the VPS.
  **PENDING OWNER ACTION** (§11). Consumer chat apps (Claude app, ChatGPT,
  Cursor, FreeBuff) cannot be driven programmatically and are not integrated.

## 7. Models, cost, privacy

* Free-first routing over a provider pool with per-model capabilities (a
  tool-less model is never sent tools), privacy flags, reset-aware free
  quotas, health and cooldowns, failover from checkpoints, a free-route
  guarantee (a billed or rerouted free call blocks the route and is
  charged to the ledger). Code: `src/model-gateway/agentic/`.
* Budget: **$2.00 per month**, max $0.10 per request; October 2026 spend
  **$0.00** (81 model attempts, all free). Paid routes only within the cap.
* Every attempt records provider, model, tokens, cost, duration and outcome
  (`model_attempts`); the Hub shows the source of each response.
* Cloudflare work is closed (`docs/cloudflare-reliability.md`).

## 8. Tools, integrations, security

| Area | Status |
| --- | --- |
| Tool Broker: discovery, AUTO / APPROVAL / DENY grants, audit (`tool_executions`), redaction, result validation | DEPLOYED, TESTED |
| GitHub (repo, PR, CI, merge, deploy watch), Supabase tools (read; writes need approval), web search/fetch, Telegram | DEPLOYED; Supabase self-check and Telegram pairing re-verified at every start |
| Google Drive/Docs/Sheets (search/read in the Office folder; create-only writes; no delete or share) | IMPLEMENTED, TESTED — **PENDING OWNER ACTION** (OAuth client). Shows "Not configured" until a real call succeeds |
| Hub auth (email OTP), Origin check on writes, RLS deny-by-default (service role only) | DEPLOYED. Supabase security advisor 2026-10-28: 0 ERROR; 1 WARN (leaked-password protection, owner's choice) |
| Bulk-delete guard + append-only audit | APPLIED 2026-10-28; approved cleanups opt in per transaction |
| Deploy: forced-command SSH, candidate build, health observations, automatic rollback | DEPLOYED |
| Hermes separation | Enforced by path, command and gate policies; untouched |

**Backups and recovery.** Supabase manages daily backups for the project
(Pro plan); their list is not visible to the agent tools, so a restore drill
is **PENDING OWNER ACTION**. `backup_20261028` is a snapshot inside the same
database (good against bad deletes, useless if the database is lost).
Recovery plan:

1. Code: revert the merge on `main`; the pipeline redeploys and rolls back on
   a failed health check.
2. Rows deleted by mistake: compare with `backup_20261028`, then reinsert in
   one reviewed transaction (owner approval).
3. Database loss: Supabase Dashboard → Database → Backups → restore the
   latest daily backup (or point-in-time if enabled), then compare
   `supabase/verify/schema-fingerprint.txt` and run `ops/health-snapshot.sql`.
4. Independent copy (recommended, owner): a periodic `pg_dump` of the
   production database to storage Fahad controls.

## 9. Release evidence (V3.0)

### Releases

| PR | Merge | What | Deploy |
| --- | --- | --- | --- |
| [#135](https://github.com/FahadTrail/fahad-ai-office/pull/135) | `f79e5c9` | Stalled objectives (no false "running"), real `.docx`, Coding Agent toolchain truth + Python image, code-privacy choice, V3 docs | Run [40643895814](https://github.com/FahadTrail/fahad-ai-office/actions/runs/40643895814) success; event "Office runtime started on commit f79e5c995633" 06:29:54 UTC |
| [#136](https://github.com/FahadTrail/fahad-ai-office/pull/136) | `6d473e8` | Written, tested, merged and deployed **by the Coding Agent** (below) | Run [40645165109](https://github.com/FahadTrail/fahad-ai-office/actions/runs/40645165109) success; "Office runtime started on commit 6d473e8fbf90" 06:42:43 UTC |
| [#137](https://github.com/FahadTrail/fahad-ai-office/pull/137) | `6f3d238` | `.docx` renders Hub artifacts as lists (found on real content), this record | Run [40649057522](https://github.com/FahadTrail/fahad-ai-office/actions/runs/40649057522) success; public `/healthz` returned HTTP 200 and version `6f3d2382c487` at 08:30 UTC on 2026-10-28 |

### Coding Agent — live cycle (2026-10-28, session `3cf33b7f-d81f-4790-b96a-f8ac52da911c`)

Objective: humanize the new `TOOLCHAIN_MISSING` blocker in
`src/hub-ui/humanize.js`, test first. Settings: repository
`FahadTrail/fahad-ai-office`, code privacy PUBLIC, free routes only, budget
$0.50, merge & deploy, verify `https://office.trimedia.me/healthz`.

| Step | Evidence (agent events, UTC) |
| --- | --- |
| TASK | Session started 06:30:23 by worker `c8cda2cb7045:1`; sandbox on branch `fahad/humanize-the-toolchain-missing-c-3cf33b7f` |
| PLAN | 4-step plan, test first |
| TEST (red) | `node --test test/humanize-toolchain.test.js → exit 1` 06:31:32 |
| CODE | Two rules added (English + Arabic) |
| TEST (green) | targeted test exit 0; full `node --test` exit 0 06:34:21 |
| GATE | `npm ci`, gate `node --test → exit 0`, "Finish gate passed" 06:36:26 |
| PR | Commit `7303ce5`, pushed, PR [#136](https://github.com/FahadTrail/fahad-ai-office/pull/136) 06:36:36 |
| CI | `validate` passed on `7303ce5` 06:38:45 |
| APPROVAL | Merge approval requested 06:38:47; approved 06:39:04 after a diff review (Claude, under Fahad's standing V3.0 pre-approval) |
| MERGE | Merged as `6d473e8` 06:39:17 |
| DEPLOY | Deploy run watched; the deploy **restarted the coding worker mid-session** |
| CONTINUITY | "Resumed from checkpoint 27 by worker 76067c3d72e3:1" 06:46:09 — no step repeated |
| VERIFY | "Production verification passed: HTTP 200, version=6d473e8fbf90 (expected 6d473e8)" 06:46:15 |
| REPORT | Session completed 06:46:16; 19 model attempts (OpenRouter Nemotron Ultra, free), **$0.00**, 35 audited tool executions |

### Office — CHIEF multi-agent acceptance (2026-10-28, objective `c6b4dfcb-eb6d-4aab-9512-ee9b04e91df0`)

Café launch plan (research, budget and break-even, licensing), free routes only.

| | |
| --- | --- |
| Flow | CHIEF plan → RESEARCH and LEGAL in parallel → FINANCE (after research) → AUDIT → CHIEF revision request → FINANCE revision → CHIEF synthesis → CHIEF final synthesis; completed 06:48:26 → 07:07:16 |
| Quality gates | FINANCE returned by code validation (INCONSISTENT, 6 then 7 issues), revised, **VERIFIED**; CHIEF fact gate preserved 8 validated figures and removed 2 contradicting statements |
| Figures (re-checked by hand) | Revenue 16 × 120 × 360 = AED 691,200; total costs 533,400 (216,000 variable + 242,400 fixed + 75,000 one-time); net 157,800; gross margin 68.75 %; cash break-even month 4 |
| Output | Final synthesis 5,969 characters in Gulf Arabic, 12 artifacts, 12 handoffs |
| Models | 52 attempts on Gemini, Groq, OpenRouter and Cloudflare free routes, with automatic failover after Gemini failures; **$0.00** |
| Report export | The real synthesis exported with `src/hub-ui/docx.js` and rendered by LibreOffice: Arabic RTL, mirrored tables; the run exposed raw JSON for a Hub checklist artifact and reversed Arabic inside code — both fixed in the V3.0 records PR |

### Earlier production acceptance still valid

2026-10-27 objectives `3be79c51` (research), `196b2d92` (finance, VERIFIED),
`e3113d70` (7 workstreams, 20 handoffs) — `docs/FAHAD-OFFICE-COMPLETION.md` §R.

## 10. How to use it

**Run the Office.** Hub → المكتب → write the objective in the composer
(Arabic or English) → CHIEF plans and delegates → follow it live on the job
page → read and download the final synthesis (Word / PDF / Markdown). To
change something, reply to CHIEF on the same job or use "طلب تعديل" on a
deliverable. A failed or stopped objective shows "استأنف من حيث وقفت"; a
stalled one shows "أوقف المهمة" — stop it, then resume.

**Add a project.** Hub → project switcher → new project (name, optional
default repository). Its budget and permissions copy the template.

**Run the Coding Agent.** Hub → ⋯ → Coding → describe the change → Options:
repository (owner/name), budget, routing, code privacy (Public only for a
public repository), test command (auto-detected), "merge & deploy" → Start.
The merge always asks for your approval in Needs Fahad.

**When something stalls.** Job page: Stop → Resume. Coding task: Resume on
the task page (continues from its last checkpoint). Telegram announces stuck
objectives, blocked sessions, paid calls and data-loss signals.
`ops/health-snapshot.sql` reads health from the database when the Hub is down.

## 11. Owner actions (only Fahad can do these)

Ordered by value. None blocks daily use of the Office.

1. **Done 2026-10-28:** runtime image rebuilt with Python. **Remaining:**
   remove the Coding Agent credential's temporary access to
   `FahadTrail/fahad-office-python-acceptance` (GitHub → Settings → Developer
   settings → the token's repository access), and decide whether to merge or
   close fixture PR #1.
2. **Google Drive/Docs/Sheets (optional):** create a Google OAuth client
   (Desktop app) with the Drive API enabled, then follow the header of
   `src/ops/google-oauth-setup.js` (client id/secret → consent link → refresh
   token into `.env` via `ops/set-secret.sh` → Office folder id). Actual OAuth
   scopes: `drive.readonly` **and** `drive.file`. Google authorizes reading
   all Drive files; the Office restricts reads to its folder **in application
   code**, not through a folder-scoped OAuth token. `drive.file` permits
   app-created/explicitly opened files. A compromised refresh token therefore
   has a broader read capability than the Office UI. Keep
   `GOOGLE_DRIVE_READ_SCOPE=folder`; never select `drive` without Fahad's
   specific approval. Setup, secret-handling and verification:
   [activation audit](V3-ACTIVATION-AUDIT-2026-10-28.md#google-oauth).
3. **Independent backup:** confirm daily backups in Supabase Dashboard →
   Database → Backups, and run one restore into a scratch project (drill).
   Optionally schedule a `pg_dump` to storage you control.
4. **External coding workers (optional):** to enable Claude Code CLI or Codex
   CLI as continuity workers, log in to each CLI on the VPS as the app user,
   then enable the worker (`ops/setup-continuity-workers.sh`; see
   `docs/CODING-CONTINUITY-SUPERVISOR.md`). Each uses your own subscription;
   nothing is enabled without your login.
5. **Repository visibility (recommended):** make
   `FahadTrail/fahad-ai-office` private **only after explicit approval**.
   The SSH forced-command mechanism can remain, but server git-fetch and
   Coding Agent token access must be verified for a private repository first.
   Actions consumes the account's private-repository allowance and can incur
   overage. Every new coding session must use PRIVATE; PUBLIC-only free
   routes then stop qualifying, so free coding capacity may be unavailable.
   Do not bypass privacy or enable paid routes to compensate. Account billing,
   server fetch credentials and runtime token scopes are not verified by this
   audit. See the [activation audit](V3-ACTIVATION-AUDIT-2026-10-28.md).
6. **A separate test repository for the Coding Agent (optional):** create an
   empty private repository and add it to the Coding Agent's GitHub token,
   so future agent drills never touch the production repository.
7. **Leaked-password protection (optional):** Supabase Auth setting; the Hub
   signs in with e-mail OTP, so impact is low.
8. **DONE (2026-10-28):** #124, #125, #109, #114 closed with review comments;
   API read-back confirmed all four closed, unmerged. All branches retained.

### Old pull requests (reviewed and closed 2026-10-28)

| PR | What it is | Recommendation |
| --- | --- | --- |
| #124 `feat/cloudflare-reliability` (draft) | First version of the Cloudflare fail-closed work | Closed: superseded by merged #126 (`27ab29c`); head is an ancestor of main |
| #125 `claude/focused-rubin-ryev82` (draft) | Cloudflare canary caps | Closed: head has the exact tree of merged #126 |
| #109 `cursor/cloud-agent-environment-2419` (draft) | Cursor Cloud setup notes for AGENTS.md | Closed: environment-specific; durable rules are current, branch preserves optional Cursor notes |
| #114 `v5.4-activation-followup` | Docs after V5.4 activation | Closed: current facts covered by V3 records; cleanup inventory superseded on 2026-10-22; historical evidence retained in PR/branch |

## 12. Limits (truthful)

* The agent sandbox cannot open the production Hub (egress proxy), so
  production UI clicks are verified on the real Hub code over preview data;
  production state is read from Supabase and GitHub.
* Go and Rust repositories are not supported by the worker image.
* External CLI coding workers are disabled (owner logins).
* Google Workspace is not connected (owner OAuth).
* No independent backup or restore drill has been performed by the agent.
* Free model capacity varies; long objectives may wait for capacity (they
  resume by themselves) — that is by design under the $2 cap.

## 13. Continuation (for the next agent)

* Read `AGENTS.md` → *Current state — V3.0*, then this file.
* Development branch convention: work on a branch, one coherent PR per
  release group, CI green, merge, watch `deploy.yml`, confirm the
  `runtime_started` event names the merge commit.
* Next technical steps, in order of value:
  1. Done 2026-10-28 (Python session `bb02c85e`, §1 update).
  2. When Google is connected, run one Office objective that saves a
     document to the Office folder and record the Drive file id.
  3. Optional: Go/Rust toolchains in the image (size and update cost
     first), a scheduled independent backup.
* Nothing is running in the background for this mission; no session holds a
  lease; no approval is pending.
