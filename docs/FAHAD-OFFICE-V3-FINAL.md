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

_Filled in at release; see §9 for the release evidence._

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
| 9 | Coding Agent on an authorised repository | see §5 | |
| 10 | Development cycle to PR, CI and deploy on approval | see §5 | |
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
| V3.0 live cycle on the production worker | see §9 |
| Isolation: sandbox uid 1000, controller credentials unreadable | TESTED in CI inside the runtime image as root |
| Node.js projects (npm, pnpm, yarn, bun) | IMPLEMENTED, TESTED |
| Python projects | IMPLEMENTED, TESTED; the runtime image gains `python3` + `pip` with this release — **PENDING OWNER ACTION** (`sudo bash ops/install-deploy.sh` applies a Dockerfile change; deploys ship only `src/` and the lockfiles) |
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

_Filled in at release._

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

_Filled in at release._

## 12. Limits (truthful)

_Filled in at release._

## 13. Continuation (for the next agent)

_Filled in at release._
