# Fahad AI Office — completion record (authoritative)

This is the single continuation point for the completion mission started
2026-10-27. Any agent (Claude, Codex, Cursor, FreeBuff) continues from
**Continuation point** at the bottom. Older status files (`HANDOVER.md`,
`PRODUCTION-READY.md`, `CODEX-CONTINUE.md`) are history; where they disagree
with this file, this file wins.

Evidence levels used below: **CODE** (implemented), **TESTED** (automated
tests pass), **DEPLOYED** (running in production), **E2E** (a real workflow was
observed end to end), **UNPROVEN** (no current evidence).

## R. Release status — Mission 3 (2026-10-27, authoritative)

**Verdict: READY WITH LIMITATIONS.** Released and live; the data-protection
migration is prepared and replay-proven but **not applied** (backup could not
be proven from the agent's tools — owner step below); Google is **PENDING
OWNER ACTION**.

| Item | Evidence |
| --- | --- |
| PRs | [#131](https://github.com/FahadTrail/fahad-ai-office/pull/131) `81004b2` (release), [#132](https://github.com/FahadTrail/fahad-ai-office/pull/132) `466bc3a` (Arabic negation fix), [#133](https://github.com/FahadTrail/fahad-ai-office/pull/133) `2adb03a` (per-unit sales) |
| CI | Validate run [40577619644](https://github.com/FahadTrail/fahad-ai-office/actions/runs/40577619644): tests, locked runtime image, sandbox privilege separation, container-root sandbox tests — all green |
| Deploy | Run [40577908347](https://github.com/FahadTrail/fahad-ai-office/actions/runs/40577908347) succeeded 20:28 UTC; event 3583 "Office runtime started on commit 81004b25cf72"; Supabase tools self-check and Telegram re-paired; Office coding worker `healthy` (heartbeat 20:32) |
| New code live | First `data_integrity_snapshot` event at 20:30:06 (ops-watch Package A) |
| Budget / privacy | Unchanged after deploy: $2.00 limit, $0.00 spent, $0.00 reserved, policy version 8; same 8 provider permissions |
| Local tests | `node --test` 846/846; `npm run db:replay` 39 migrations, every scenario green; `npm run verify:sandbox` ok (sandbox uid 1000, controller environment unreadable) |
| Browser | 52 Playwright screens (light/dark, 1440/390, edge cases): no console errors, no horizontal overflow; Word/MD/PDF downloads of the final synthesis and the Deliverables report work on both widths; Resume → running → Stop → cancelled → Resume (preview) |

### Production acceptance (free routes only, `free_only`, titled "Acceptance" so they stay out of Office views and Telegram)

| Scenario | Job | Result |
| --- | --- | --- |
| 1 Research | `3be79c51-8889-476a-aefc-855fca4115bc` | **Completed**: CHIEF → RESEARCH → CHIEF synthesis in Gulf Arabic (4,395 chars), 7 artifacts, 2 handoffs; states honestly that commission rates are not published and labels press figures; $0 |
| 2 Finance + revision | `ace99f39-a6f9-4dd0-a6a5-28918e39f865` | Completed, honestly marked NOT CLOSED: FINANCE was returned by code validation, CHIEF ran a revision round, the fact gate removed 10 contradicting statements. Two root causes found and fixed (PR #132, PR #133, below); $0 |
| 2b Finance re-run (after #132) | `196b2d92-b84d-46bb-bb7d-c8c71e3f8cae` | **Completed and CLOSED**: FINANCE INCONSISTENT twice → CHIEF revision → **VERIFIED** after 1 correction round; fact gate preserved 9 validated figures and removed 2 contradicting statements; $0 |
| 3 Multi-agent | `e3113d70-eda6-4e41-94e9-5ea57fce76f7` | **Completed**: 7 workstreams (RESEARCH, CREATIVE, SOCIAL, FINANCE, LEGAL, AUDIT) + synthesis (11,147 chars), 15 artifacts, 20 handoffs; $0 |
| 4 Deliverables | — | Downloads verified in the browser on the preview; production UI click not possible from the agent sandbox (Hub host blocked by its proxy) |
| 5 Resume | — | Endpoint + UI verified locally; first real use on production is Fahad's |

All 81 model attempts across the four objectives: **$0.00** recorded (free routes only: Gemini, Groq,
OpenRouter free). A failed Gemini attempt failed over by itself.

**Defects found by acceptance and fixed (both merged and deployed):**

* PR [#133](https://github.com/FahadTrail/fahad-ai-office/pull/133) (`2adb03a`):
  FINANCE had no way to express per-item sales (a café's cups): the revenue
  schema knew only subscriptions or an explicit schedule, and the sanitizer
  dropped other fields, so revenue was always "0 from the stated inputs". New
  `unit_sales` model (unit_price × units per day/month, unit_cost),
  break-even in units and months; test `test/finance-unit-sales.test.js`.
* PR [#132](https://github.com/FahadTrail/fahad-ai-office/pull/132) (`466bc3a`): the FINANCE prose
checker treated «لن» inside «النقدي» as a negation, so the correct sentence
«التعادل النقدي التراكمي: الشهر 6» was read as "break-even not reached" and
sent FINANCE into a needless revision that degraded its model. Arabic
negation is now matched as a whole word (also when it precedes the phrase);
regression test `test/finance-arabic-negation.test.js`.

### Package status

| Package | Status |
| --- | --- |
| A Data protection | Code LIVE (integrity snapshots, alerts, stuck detection). Migration `20261027200000_bulk_delete_guard` **prepared, replay-proven, NOT applied** |
| B Office & deliverables | LIVE; scenarios 1–3 exercised in production |
| C Coding Agent onboarding | LIVE; a session on a non-Office repository has not run yet |
| D Continuity alerts | LIVE |
| E Google Drive/Docs/Sheets | LIVE code, **PENDING OWNER ACTION** (OAuth) |
| F Model pool | Unchanged; free-first held ($0) |
| G Security (Origin check, honest connector states) | LIVE |
| H Inventory | Done (below); nothing closed |

### Review fixes made during verification (before merge)

* The guard refused deleting **one** real objective (its events cascade). Rows
  removed by ON DELETE CASCADE are now recognised (their parent row is gone)
  and limited to 1000; the parent statement keeps the 25-row limit.
* The opt-in must carry the current transaction id
  (`'<tables>@' || txid_current()`), so a session-wide or leftover setting
  opens nothing.
* Audit moved to `private.bulk_delete_audit`, append-only (DELETE, UPDATE and
  TRUNCATE refused without exception), with role, session user, application
  and client address.
* Google reads are limited in code to the Office folder by default
  (`drive.readonly` would reach the whole Drive); `GOOGLE_DRIVE_READ_SCOPE=drive`
  is the owner's explicit opt-in.

### Owner actions (the only remaining human steps)

1. **URGENT — the history lost on 2026-10-22.** The organisation is on the
   Supabase **Pro** plan (daily backups, 7-day retention). The last backups
   from before the deletion (2026-10-21/22) are about to age out. If the old
   history matters: Supabase Dashboard → project `fahad-ai-office` → Database →
   Backups → restore the 2026-10-22 (pre-21:06 UTC) backup **into a new
   project** (never over production). Nothing was restored by the agent.
2. **Apply the bulk-delete guard.** In the same Backups page confirm a recent
   daily backup exists, then run the file
   `supabase/migrations/20261027200000_bulk_delete_guard.sql` in the SQL
   editor (or tell the agent "backup confirmed, apply the guard"). Expected
   result: 46 triggers named `*_bulk_delete_guard` / `*_truncate_guard`.
   Rollback is at the end of the file. Data is not changed.
3. **Google (optional):** create an OAuth client (Desktop app) with the Drive
   API enabled, then follow the header of `src/ops/google-oauth-setup.js`
   (client id/secret → consent link → refresh token piped into `.env` →
   Office folder id). Until then the connector shows "Not configured".
4. **Repository visibility (recommended):** make the repository private; it
   holds no secrets, but shows the VPS hostname and paths.
5. Optional: close superseded PRs #124, #125; review #109, #114.

### Rollback

* Code: revert merge `81004b2` on `main` (the deploy pipeline redeploys and
  rolls back automatically on a failed healthcheck).
* Migration (once applied): drop the 46 triggers and the two guard functions
  (statements at the end of the migration); keep the audit table.

### Next recommended stage

Use the Office daily; run one Coding Agent task on a small non-Office
repository to prove the new onboarding; connect Google if wanted.

## 0. Mission 2 — implementation without verification (2026-10-27, evening)

Fahad's rule for this mission: **no tests of any kind, no live AI calls, no
PR (it would start CI), no merge, no deploy, no migration, no production
write.** Everything below is on branch `claude/kind-ptolemy-kd5e5j` (pushed;
pushes to this branch do not start CI) and is **IMPLEMENTED — VERIFICATION
PENDING**. Tests were written for every change but none was executed; only
`node --check` syntax checks ran.

| Package | Previously complete | Implemented now | Remaining | Blocker | Verification pending |
| --- | --- | --- | --- | --- | --- |
| A Data incident & recovery safety | Explicit-ID cleanup script with expected counts | Bulk-delete/TRUNCATE guard migration on 23 history tables (opt-in per transaction, audited); ops watch row-count snapshots + data-loss and allowed-bulk-delete alerts; cleanup script opts in | Apply the migration; a backup restore drill | Owner approval for the migration; backups depend on the Supabase plan (not visible from here) | `test/data-safety.test.js`, replay scenario `bulk_delete_guard.sql`, regenerate `schema-fingerprint.txt` |
| B Office experience & deliverables | Versions, pin/archive/approve/revise, artifact exports, Resume/Stop (#130) | Full reports (employee + CHIEF synthesis) download as Word (.doc), PDF (print) or Markdown; failed objectives in Needs Fahad point to Resume, in Arabic | Live use of every flow | None (code) | `test/report-export.test.js` + browser check |
| C Coding Agent | Full lifecycle, protected-file approvals (V2), checkpoints, CI repair | Repository profile: Node (npm/pnpm/yarn/bun), Python, Go, Rust; dependency install once before the test gate; project summary in the system prompt | A live session on a non-Office repository | Sandbox network for installs is unverified | `test/repo-profile.test.js` + one real session |
| D Continuity | Stale-task requeue, coding lease reclaim, capacity wait, owner Resume | Ops watch flags an objective that is running with nothing able to run | Supervisor activation (vendor CLIs) | Vendor CLI logins on the VPS (owner) | `test/data-safety.test.js` (stuck case) |
| E Integrations | GitHub, repo, CI, deploy, Supabase tools, web search/fetch, Telegram | Google Drive/Docs/Sheets connector (read: search/read; write: create-only in one Office folder), privacy-forced routing, honest Integrations state, one-time OAuth setup that never prints the token; tool use now counts only successful calls | Connect it | Owner must create a Google OAuth client and authorize (§6.6) | `test/google-workspace.test.js`; one real Drive call after connecting |
| F Model pool & capacity | Free-first routing, privacy, budget, per-model status/reason/billing/health/roles | Nothing needed (Cloudflare closed and preserved) | — | — | — |
| G Security & operations | RLS deny-by-default, redaction, deploy rollback, ops watch | Hub refuses writes whose `Origin` is not the Hub (sibling-subdomain CSRF); Telegram notices for finished Hub objectives | Repository visibility; scrub VPS hostname if wanted | Owner decision | `test/hub-origin.test.js`, `test/telegram-channel.test.js` |
| H Cleanup & completeness | — | Inventory only (below); nothing closed or deleted | Close superseded PRs | Owner decision | — |

### Commits (branch `claude/kind-ptolemy-kd5e5j`, on top of `main` `4db3672`)

| Commit | Package | Change |
| --- | --- | --- |
| `54800c1` | A | Bulk-delete guard migration `20261027200000`, replay scenario, cleanup opt-in, ops-watch integrity alerts |
| `dcdc601` | E | Google Workspace connector, Office tool wiring, Integrations state, OAuth setup, `set-secret.sh` names |
| `91c7a41` | B | Word/PDF/Markdown export of full reports |
| `83b08d8` | B | Failed objectives in Needs Fahad → Resume (Arabic) |
| `618d462` | C | Repository profile and dependency setup before the gate |
| `980ab94`, `4bcd74a` | D | Stuck-objective alert |
| `1218529` | G | Origin check on Hub writes |
| `b6bc44b` | B/G | Telegram notices for finished Hub objectives |

### §A — the 2026-10-22 data loss (read-only investigation)

* `pg_stat_user_tables`: every operational table was autovacuumed at
  **2026-10-22 21:06:05 UTC**; delete counters show jobs 121, tasks 291, runs
  311, results 313, events 3,534, agent_events 2,927, model_attempts 1,389,
  tool_executions 839, conversations 49 of 50, agent_sessions 40, artifacts
  153 rows removed. Configuration survived (provider_canary_runs 0 deleted,
  provider_status, knowledge_items, grants, policies).
* The Telegram conversation was recreated by the runtime at 21:05:56, so the
  deletion happened just before. No commit, deploy or migration is near that
  time; the only repository delete script works on explicit IDs with expected
  counts and could not select everything. **Cause: a privileged manual or
  agent SQL run, not explained by repository code.** Who ran it is not
  recorded (Postgres logs from that day are not retained).
* Nothing was restored or modified. If the history matters, a Supabase
  point-in-time restore (plan-dependent) to a **new** project is the only
  route; check Dashboard → Database → Backups.

### Engineering decisions

* The bulk-delete guard is a statement-level `AFTER DELETE … REFERENCING OLD
  TABLE` trigger plus `BEFORE TRUNCATE`; limit 25 rows/statement; opt-in is
  `set_config('office.allow_bulk_delete', '<tables>|all', true)` (transaction
  local). It is an accident guard, not a security boundary (a superuser can
  disable triggers).
* Google Workspace uses the owner's own OAuth client (Desktop type, loopback
  redirect) with `drive.readonly` + `drive.file`; writes only create files in
  `GOOGLE_DRIVE_OFFICE_FOLDER_ID`. Tools are offered only when the request
  names Drive/Docs/Sheets, and such a run uses privacy-approved routes only;
  if none is free, it may reach a paid route under the existing $2 cap.
* Word export is an HTML document saved as `.doc` (no new dependency); true
  `.docx` would need a zip library.
* The Coding Agent installs dependencies only when a lockfile/requirements
  file exists and the dependency directory is missing, once per sandbox.

### Configuration requirements (owner)

* Google: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
  `GOOGLE_OAUTH_REFRESH_TOKEN` (via `src/ops/google-oauth-setup.js`),
  `GOOGLE_DRIVE_OFFICE_FOLDER_ID` — all through `sudo bash ops/set-secret.sh`.
  Full steps are in the header of `src/ops/google-oauth-setup.js`.
* Optional: `TELEGRAM_NOTIFY_HUB_RESULTS=false` to silence the new notices.

### Security notes for the public repository

* No credential, `.env`, key or personal e-mail in the tree or history.
* The VPS hostname `srv1964598.hstgr.cloud`, server paths and the Supabase
  project ref are visible (`docker-compose.yml`, `ops/set-hub-domain.sh`,
  docs). Not secrets, but reconnaissance aids; the Hub also answers on the raw
  VPS hostname. Making the repository private is the simple fix (owner).

### §H — open PRs (nothing closed)

* #124 `feat/cloudflare-reliability` and #125 `claude/focused-rubin-ryev82`:
  drafts superseded by merged #126 (`27ab29c`).
* #114 `v5.4-activation-followup`, #109 `cursor/cloud-agent-environment-2419`:
  older documentation/activation follow-ups; review or close.

### Verification order (when Fahad allows it)

1. `npm run db:replay` and regenerate `supabase/verify/schema-fingerprint.txt`
   (the new migration changes it; CI fails until this is done).
2. `node --test` (new: `data-safety`, `google-workspace`, `report-export`,
   `repo-profile`, `hub-origin`, telegram notice case).
3. Browser check of the job page and Deliverables drawer exports.
4. Open the PR → CI → owner merge → deploy.
5. Owner applies `20261027200000_bulk_delete_guard` (reviewed).
6. Live: the five scenarios (§7), one coding session on a small non-Office
   repository, and Google connect + one Drive call if wanted.

## 1. Verified baseline (2026-10-27, read-only checks)

| Fact | Evidence |
| --- | --- |
| Production commit at the start of the mission: `a0b8022e94d9bb002198470ea9b76f7f2b2289b1` | Deploy run [40554067285](https://github.com/FahadTrail/fahad-ai-office/actions/runs/40554067285) succeeded; `runtime_started` event "Office runtime started on commit a0b8022e94d9" |
| **Production commit now: `4db3672c2bb3ae91c3fc8e4121959905a432261b`** (PR #130 merged by Fahad) | Deploy run [40569532162](https://github.com/FahadTrail/fahad-ai-office/actions/runs/40569532162) succeeded 2026-10-27 19:32 UTC; events `runtime_started` "Office runtime started on commit 4db3672c2bb3", Supabase tools self-check and Telegram channel re-paired right after |
| Office coding worker alive | `coding_workers.office`: `healthy`, `MEASURED`, last seen 2026-10-27 18:48 UTC |
| Telegram channel paired | `telegram_channel` events after each of the last deploys |
| Budget | `workspace_policies`: $2.00/month, $0.00 spent, $0.00 reserved, period 2026-10-01 → 2026-11-01, max $0.10 per request |
| Test suite (main) | `node --test`: 822 tests, 822 pass, 0 fail, 0 skipped (local, no network) |
| **Production data was reset** | `jobs`, `tasks`, `runs`, `results`, `agent_sessions`, `model_attempts`, `tool_executions` all have **0 rows**; the oldest remaining `events.id` is 3550 (2026-10-23). No objective and no coding session has run since. |
| Migrations | Production has 37 applied. Repository migration `20261009160000_platform_work_indexes` (two partial indexes, no data change) is **not applied**. |
| Repository visibility | **Public**. No credential, `.env`, key file or personal email found in the tree or in any of the 391 commits (pattern scan for Anthropic/OpenAI/GitHub/Google/Groq/Cerebras/Slack/Telegram tokens, JWTs, private keys). |
| Supabase security advisor | RLS on every public table with no policies (deny-by-default for anon/authenticated; service-role only, as designed). One WARN: leaked-password protection off (the Hub uses email OTP, so low impact). |
| Production reachability from agent sandboxes | Blocked by the sandbox egress proxy (HTTP 403 on CONNECT). `/healthz` was read through deploy evidence, not directly. |

## 2. Inventory

| Area | State | Notes |
| --- | --- | --- |
| CHIEF objective → plan → specialists → synthesis | DONE: CODE, TESTED, DEPLOYED. E2E **UNPROVEN since the reset** | Last real runs predate 2026-10-23; the rows were removed. |
| Multi-agent handoffs, revisions, consults, capacity wait | DONE: CODE, TESTED, DEPLOYED | `office-orchestration`, `office-capacity-wait` tests |
| Owner recovery of a failed/stopped objective | **DONE in this mission** (CODE, TESTED, browser-verified on preview, DEPLOYED `4db3672`); E2E on a real objective UNPROVEN | Was MISSING: a failed objective had no retry, and Stop existed only for conversation jobs |
| Failure reasons in Arabic | **DONE in this mission** | Raw English error was shown in the Arabic UI; now a Gulf-Arabic sentence plus technical details |
| Deliverables Center (view, download, pin/archive/approve/revise) | DONE: CODE, TESTED, DEPLOYED | V5.3 |
| Living Dashboard V2.2, Arabic-first RTL, desktop + mobile | DONE: CODE, TESTED, DEPLOYED | Screenshots: no console errors, no horizontal overflow |
| Approvals / Needs Fahad / Reply & Continue | DONE: CODE, TESTED, DEPLOYED | |
| Free-first routing, privacy flags, $2 cap, free-route guard | DONE: CODE, TESTED, DEPLOYED | Unchanged by this mission |
| Cloudflare routes | CLOSED workstream | GPT-OSS 120B text+tools; Llama 3.3 70B text-only; Qwen Coder disabled. Do not reopen. |
| Coding Agent (plan → edit → test → PR → CI → approval → merge → deploy → verify) | DONE: CODE, TESTED, DEPLOYED; E2E proven 2026-09-25 (see `coding-agent.md`). **UNPROVEN since the reset** | Worker heartbeat is healthy |
| Protected-file approvals | DONE (V2): path-scoped `request_protected_change` + owner grant | `approval-flow-gap.md` is historical |
| Continuity Supervisor (multi-vendor coding workers) | PARTIAL | Code merged, migration applied, only the native `office` worker enabled; Codex/Claude/OpenCode/Gemini CLI disabled. **Not needed for the target workflows**: Office steps already wait/resume and stale runs requeue; native coding sessions checkpoint and resume. Activating it needs authenticated vendor CLIs on the VPS (owner logins). |
| Tool Broker / MCP | DONE for the Coding Agent catalog (repo, git, GitHub PR/CI/merge, deploy status, HTTP verify, Supabase read/write/migration with AUTO/APPROVAL/DENY grants); Office has `web_search` (Gemini grounding) + `web_fetch` | `tool_executions` is empty since the reset |
| Google Drive / document integrations | MISSING / BLOCKED | No server credential and no connector in code. Needs an owner-created OAuth client or service account before any work is meaningful. |
| Consumer app sessions (Claude app, Cursor, ChatGPT, FreeBuff) | Not integrable | Only API/CLI integrations exist. A chat app session cannot be driven by the Office. |
| Backups / recovery | PARTIAL | Supabase-managed backups (plan-dependent, not verified from here); `ops/health-snapshot.sql`; deploy has automatic rollback. A restore drill has not been run. |

## 3. Changes made in this mission

| Change | Files | PR |
| --- | --- | --- |
| `POST /api/jobs/:id/resume`: requeues only failed/blocked/skipped steps (two fresh attempts each, capacity-wait count reset, tool checkpoint kept), then flips the job `failed`/`cancelled` → `running` behind a status guard; delivered steps and results untouched; audit event `objective_resumed` | `src/hub-job-actions.js`, `src/hub-server.js` | [#130](https://github.com/FahadTrail/fahad-ai-office/pull/130) (all rows) |
| `POST /api/jobs/:id/stop` for any running objective; conversation Stop now reuses it | `src/hub-job-actions.js`, `src/hub-workspace.js` | |
| Job screen: "استأنف من حيث وقفت" on failed/stopped objectives, Stop on running ones without a conversation, page restarts refreshing after a resume, composer repaints only on a state flip | `src/hub-ui/screens.js`, `src/hub-ui/office-model.js`, `src/hub-ui/premium.css` | |
| Arabic failure explanations (`humanError(message, 'ar')`) | `src/hub-ui/humanize.js` | |
| Tests: endpoint semantics, refusals, stop→resume, and a full `OfficeWorkflow` run that fails, is resumed through the Hub action and completes **without redoing the delivered research** | `test/objective-recovery.test.js`, `test/premium-redesign.test.js` (write inventory updated) | |

No migration, no schema change, no provider/budget/privacy change, no
production write, no deployment was made by this mission.

## 4. Test evidence

* Full suite after the change: see the PR description (827 tests at the time of writing, 0 failed).
* Browser (Playwright, local preview with fictional data, real Hub handlers):
  failed objective → Resume → job `running`, steps `done, queued, queued`,
  page shows "قيد العمل" → Stop + confirm → `cancelled`, steps
  `done, skipped, skipped` → Resume offered again. No console errors, no
  horizontal overflow at 390 px and 1440 px.

## 5. Risks

1. **Nothing has been exercised in production since the data reset.** All "DONE" items above are code/test/deploy evidence; a live objective must be run before calling the Office proven again.
2. Public repository: no secrets, but architecture, domain, Supabase project ref and ops scripts are visible. RLS denies anon access, so the ref alone grants nothing.
3. Budget period ends 2026-11-01; the rollover function (`20261005230000`) is applied. Confirm on 2026-11-01 that `budget_period_end` moved forward.
4. Stale open PRs: #124 and #125 (superseded by merged #126), #109 and #114 (old docs/activation follow-ups).

## 6. Owner decisions (one batch)

1. ~~Merge this mission's PR~~ **done**: #130 merged and deployed (`4db3672`). Rollback if ever needed: revert the merge commit.
2. **Run the acceptance scenarios** in §7 on production after the deploy (free routes; expected cost $0, worst case a few cents inside the $2 cap).
3. **Repository visibility**: make it private (recommended). Risk: none to the runtime; GitHub Actions then counts against the private-repo minute allowance. Rollback: make it public again.
4. Optional: apply `20261009160000_platform_work_indexes` (two indexes, no data change; rollback `drop index`).
5. Optional: close PRs #124, #125, #109 and #114.
6. Optional, only if wanted: Google Drive — create an OAuth client or service account and store it with `ops/set-secret.sh`; then an agent can build the connector.

## 7. Acceptance scenarios (production, non-sensitive)

Submit each from the Office composer and record job id, status, steps and cost here.

1. Research: «قارن بين ثلاث منصات توصيل طعام في دبي من حيث العمولة على المطاعم، مع ذكر المصادر.»
2. Finance: «احسب تكلفة إطلاق مقهى صغير وهمي في الشارقة: إيجار 8000 درهم شهريًا، معدات 60000 درهم، 3 موظفين براتب 5000 درهم، ونقطة التعادل بسعر كوب 18 درهم.»
3. Multi-agent: «جهّز خطة إطلاق متكاملة لعلامة عطور وهمية اسمها "ندى": بحث سوق، هوية، خطة محتوى، ميزانية، ومراجعة قانونية.»
4. Deliverable: open scenario 3's result, download the final synthesis, pin one deliverable, archive another.
5. Approval & revision: on a scenario 3 deliverable choose "طلب تعديل" with a note; then on a failed or stopped objective use "استأنف من حيث وقفت" and confirm only unfinished steps run again.

## Continuation point

* Production runs `2adb03a` (PRs #131–#133). Read §R first; §0 and below are history.
* Open items: owner actions in §R (backup → apply the guard migration;
  optional Google OAuth; visibility). Do not repeat the §A investigation or
  the Cloudflare work.
* All acceptance objectives completed; the finance re-run closed VERIFIED.
  Production runs `2adb03a` (PRs #131, #132, #133).
