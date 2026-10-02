# Coding Continuity Supervisor — Phase N readiness and activation package

> **2026-10-02 update — alternative-worker preparation.** Sections C and D
> below are superseded by `docs/CONTINUITY-VPS-WORKERS.md`: the target chain
> is now **FAHAD OFFICE → OPENCODE → GEMINI CLI** instead of waiting for
> Codex/Claude subscription resets. Both external adapters are real,
> implemented, OFF by default, and built only against verified official CLI
> interfaces; the registry grows to eight workers via a data-only migration
> (fingerprint unchanged); `ops/setup-continuity-workers.sh` and
> `tools/continuity-phase-n-live.mjs --check/--run` prepare and execute the
> isolated live drill with fail-closed termination proof. **Still NOT run
> anywhere: the real authenticated handoff and restart drills** — they need
> the VPS authentication steps, and production stays untouched (no merge, no
> deployment, no migration, all flags OFF). The drill's evidence list and the
> truthful worker status table live in the new runbook; this document's
> original pre-activation analysis remains below as written on 2026-10-01.

Prepared 2026-10-01 from the open PR stack #102 → #104 → #105 → #106. This is a **pre-activation package**, not authorization to change production. None of the PRs is merged; the migration is unapplied; no deployment or production flag change has been made. PR #106 code head `3759ff9621fc2f20f09d7bae8dc7ce28249400fa` passed its Linux validation; this documentation-only follow-up must also pass CI before its head is used as final evidence.

## A. AXE RESULT

`tools/continuity-ui-verify.mjs` runs the real Hub preview with fictional rows, the actual project view, Playwright, and axe-core 4.13.0. Twenty cases (five viewports × light/dark × normal/reduced motion) passed with **0 critical and 0 serious violations**. Axe marked up to six `color-contrast` nodes *incomplete*, not violated, where a gradient prevents its calculation. A conservative manual calculation on the new baton foreground tokens against both ends of the computed gradient gives at least 5.12:1 in light and 4.58:1 in dark for the sampled text. This does not turn incomplete axe results into automatic passes for unrelated pre-existing header gradients. The test checks visible keyboard focus, button names via axe, and mobile menu open/close/focus behavior.

## B. MOBILE VIEWPORT RESULT

375×667, 390×844, 768×1024, 1280×720, and 1440×900 passed in both themes and motion modes: no horizontal overflow, clipped controls, overflowing continuity cards, or timeline-row overlap. The view remains Projects → project → Coding continuity. The mobile sidebar is now inert and `aria-hidden` when closed, exposes `aria-expanded` when opened, traps focus while open, closes with Escape, and restores focus to its trigger. The Continuity view has no drawer or modal of its own.

## C. REAL HANDOFF DRILL

**NOT RUN.** The temporary Git/worktree E2E in `test/continuity-e2e.test.js` exercises the actual `ContinuitySupervisor`, lease manager, checkpointer and worktree manager with fake worker executors. It is useful failure-injection evidence, but is not the required real Office → Codex → third-worker drill. No actual Office continuity session, Codex model execution, third worker, or drill PR/CI exists. The local Codex CLI binary responds to `--version`, but `codex login status` fails because this environment cannot load a home/configuration directory; no credential was read or altered.

## D. THIRD WORKER RESULT

No third adapter is executable in the shipped runtime. Claude Code, Antigravity, OpenCode, Kilo and Freebuff are intentionally disabled/manual. There is no supported test worker path that could truthfully substitute for a third real worker. The documented Phase N acceptance criterion in `docs/CONTINUITY-IMPLEMENTATION-PLAN.md` explicitly requires a real Office → Codex → Claude Code or Antigravity chain, final gates, a PR and CI evidence. Therefore the third worker is a **production activation blocker**, not an optional enhancement.

## E. LEASE RESULT

SQL's partial unique index prevents two ACTIVE/FROZEN leases for the same repository and branch; the rolled-back DB scenario tests competing acquisition, token heartbeat, checkpoint-before-release, freeze and reclaim. The fake-worker E2E observed one ACTIVE lease at a time. This sprint also makes Codex stop await process exit and blocks handoff if exit is unconfirmed. A lost-lease callback tries to stop the old worker and persists a fixed stop verdict; recovery keeps an unconfirmed writer's lease FROZEN. Across restart, recovery now requires independent proof that the prior worker ended; the native Office session can supply a terminal status, while an external CLI without durable death proof cannot be auto-reclaimed. No production one-writer observation has been made.

## F. CHECKPOINT RESULT

DB-first persistence, secret validation, atomic mirror and checkpoint intervals/events are covered by local and Linux tests. Codex handoff now re-inspects the actual worktree head instead of trusting a stale caller checkpoint. Recovery rejects a wrong branch, dirty tree or checkpoint commit that is not an ancestor of HEAD. No actual model-produced checkpoint was written in Phase N.

## G. RECOVERY RESULT

Simulated interruption, stale heartbeat, freeze, verified reclaim, replay-safe continuation and retry of a previously frozen lease pass against a disposable Git repository. An unconfirmed old writer fails closed. A real process/session restart with native Office and Codex has **not** been demonstrated. No completed work may be replayed or claimed as real recovery evidence.

## H. PRIVACY RESULT

Tests cover PUBLIC, NORMAL, PRIVATE and CONFIDENTIAL selections. Only adapters declaring the class are eligible; no match returns `NO_ELIGIBLE_WORKER`, without downgrade. The current native Office capabilities declare all four classes; Codex declares PUBLIC/NORMAL/PRIVATE; disabled adapters cannot be selected even if their row exists. The real account/workspace authorizations still require Phase N verification.

## I. SHARED QUOTA RESULT

`quota_source` deduplication is tested: Codex and ChatGPT-signed Kilo count once as `openai-chatgpt`; Antigravity's `google-ai-pro` and Gemini API's separate source are not conflated. Kilo's seeded source remains `kilo-auto-free` until a verified ChatGPT login changes its row. UNKNOWN usage never invents a percentage, and only provider-reported ≥85% causes automatic draining. This is code/test evidence, not live provider quota evidence.

## J. WORKER TRUTH TABLE

Status cells use the fixed vocabulary. `Production enabled` describes the **Continuity Supervisor**, not an existing Office worker outside it. The Office registry seed is enabled, but the global Supervisor is off.

| Worker | Adapter status | Execution status | Auth status in isolated drill | Data-class eligibility | `quota_source` | Real handoff tested? | Production enabled? | Owner action needed |
|---|---|---|---|---|---|---|---|---|
| Fahad Office Coding Agent | TESTED | PREPARED | NOT_CONFIGURED | PUBLIC, NORMAL, PRIVATE, CONFIDENTIAL | `office-pools` | DISABLED | DISABLED | Provide an isolated native runtime and run Phase N |
| OpenAI Codex | TESTED | PREPARED | NOT_CONFIGURED | PUBLIC, NORMAL, PRIVATE | `openai-chatgpt` | DISABLED | DISABLED | Verify CLI auth and run Phase N; opt-in flag remains off |
| Claude Code | DISABLED | DISABLED | NOT_CONFIGURED | PUBLIC only in current disabled adapter | `anthropic-claude-subscription` | DISABLED | DISABLED | Implement and verify supported executable adapter |
| Google Antigravity | MANUAL_ONLY | DISABLED | NOT_CONFIGURED | PUBLIC only in current disabled adapter | `google-ai-pro` | DISABLED | DISABLED | Verify official headless interface before implementing |
| OpenCode | DISABLED | DISABLED | NOT_CONFIGURED | PUBLIC only in current disabled adapter | `opencode` | DISABLED | DISABLED | Verify supported CLI, legitimate free access, privacy and auto-reload off |
| Kilo Code | MANUAL_ONLY | DISABLED | NOT_CONFIGURED | none until verified | `kilo-auto-free` seeded; `openai-chatgpt` if ChatGPT-signed | DISABLED | DISABLED | Verify headless mode, login and quota source |
| Freebuff | MANUAL_ONLY | DISABLED | NOT_CONFIGURED | PUBLIC manual only | `freebuff` | DISABLED | DISABLED | Owner availability and manual handoff; no scraping |

## K. FAILURE MATRIX

| Injection | Isolated evidence | Result |
|---|---|---|
| Worker interrupted after a commit, before checkpoint | Temporary Git/worktree E2E | Recovery records extra commit; no duplicate edit |
| Stale heartbeat and frozen lease | SQL scenario + supervisor tests | Branch remains blocked until verified reclaim |
| Stop signal sent but process exit not confirmed | Codex adapter + supervisor tests | Handoff blocked; old lease retained/FROZEN |
| DB checkpoint write fails | Checkpointer tests | No false local mirror |
| Secret in checkpoint or usage | Validator/usage tests | Rejected |
| Private task with public-only worker | Selection tests | Explicit no-eligible-worker blocker |
| Quota exhaustion / reported 85% | Selection/supervisor tests | Exhausted worker excluded; reported threshold drains |
| Rate limit or capacity transition with real provider | Not safely reproduced | Phase N evidence pending |
| Recovery after real process restart | Not run | Phase N evidence pending |

## L. DB REPLAY

The Linux `validate` run on `3759ff9` replayed **32 migrations** and passed the `coding_continuity.sql` scenario. This Windows host has no `npm`, Bash, PostgreSQL server binaries or WSL, so `npm run db:replay` could not start locally. Production migration remains unapplied.

## M. FULL TEST COUNT

Linux `node --test` on `3759ff9`: **573 total, 571 passed, 0 failed, 2 skipped** (container-root cases run separately). The container sandbox run: **15/15 passed**. The focused local Continuity suite: **62/62 passed**. Windows `node --test`: 573 total, 543 passed, 9 failed, 21 skipped; the nine failures were `spawn bash ENOENT`. The two real Windows-only URL-to-path bugs were fixed, and their four focused tests pass. No Continuity test was skipped in the focused suite.

## N. CI RESULT

PR #106 `validate` completed **success** on code head `3759ff9`: Node suite 573/571/0/2, 15/15 container sandbox tests, Docker image and privilege-separation check, and 32-migration database replay. [CI run](https://github.com/FahadTrail/fahad-ai-office/actions/runs/36913460692/job/110541576442). The documentation-only follow-up head requires its own successful check before final handoff. Passing CI does not satisfy the missing real Phase N drill.

## O. WINDOWS CLASSIFICATION

`spawn bash ENOENT` and local inability to run npm/db replay are `ENVIRONMENT_ONLY`: Linux CI has the required tools. `new URL(...).pathname` becoming `C:\C:\...` in two tests was a `REAL_CROSS_PLATFORM_BUG`; replaced with `fileURLToPath`, without weakening assertions. Windows full-suite is not a production gate when the matching Linux CI succeeds.

## P–S. PR STATUS

| Item | Current base | Verified state on 2026-10-01 |
|---|---|---|
| P. #102 Phase A | `main` | Open, unmerged, clean/mergeable, `validate` success; migration unapplied |
| Q. #104 Phase B | `claude/continuity-foundation` | Open, unmerged, clean/mergeable, `validate` success |
| R. #105 C–G | `codex/continuity-runtime-core` | Open, unmerged, clean/mergeable, `validate` success |
| S. #106 H–M + Phase N readiness fixes | `codex/continuity-workers` | Open, unmerged, clean/mergeable, `validate` success on `3759ff9`; recheck documentation follow-up head |

Reconfirm bases, ancestry, mergeability and final-head checks via GitHub before any later approval. Nothing should be retargeted or merged merely to prepare this report.

## T. MIGRATION REVIEW

`20261004090000_coding_continuity.sql` is additive: six new `coding_*` tables, eight RPCs and seven registry rows, with no DROP/TRUNCATE/DELETE or mutation of the earlier `continuity_*` POC tables. Each new public table enables RLS; table and RPC privileges are revoked from PUBLIC/anon/authenticated and granted to service_role only. All RPCs are `security invoker` with an empty `search_path`; relations are schema-qualified. The partial unique lease index enforces one writer; session/checkpoint/lease/handoff/usage indexes support the current query patterns. The migration is unapplied, and a production backup/fingerprint must precede its later approved application. Treat it as forward-only: preserve tables and evidence during rollback.

## U. EXACT PRODUCTION ACTIVATION ORDER — **PLAN ONLY**

Every step below is gated on a future explicit owner approval **after** real Phase N passes. Merging to `main` automatically deploys; pause and verify each deploy before advancing.

1. Confirm real Phase N evidence, current PR heads/checks, production version, no active incident, clean migration history, working verified backup/restore point, and supervisor flag OFF. Stop on any mismatch.
2. Apply only the reviewed `20261004090000_coding_continuity.sql` through the tracked Supabase migration mechanism in the approved maintenance window; do not run it from this report.
3. Run `supabase/verify/fingerprint.sql` read-only against production and compare line-for-line with `supabase/verify/schema-fingerprint.txt`; confirm the migration history row and service-role grants/RLS. Stop on mismatch.
4. Merge #102 to `main` **preserving ancestry with a merge commit**; wait for its deploy and confirm `/healthz` version and startup while supervisor remains OFF.
5. Retarget #104 from the Phase A branch to `main`, verify only Phase B commits/diff and fresh CI, merge with a merge commit, wait for deploy and confirm health with flag OFF.
6. Retarget #105 to `main`, verify only C–G commits/diff and fresh CI, merge with a merge commit, wait for deploy and confirm health with flag OFF.
7. Retarget #106 to `main`, verify only H–M/readiness commits/diff and fresh CI, merge with a merge commit, wait for deploy and confirm health with flag OFF.
8. Confirm final deployed commit, startup logs, Hub/API availability and no migration/schema drift.
9. Confirm worker registry truth, supported adapter availability, workspace/worktree roots, privacy policy and budget; unsupported rows remain disabled.
10. Only when runtime is healthy, set `CONTINUITY_SUPERVISOR=true` through the approved server configuration path; enable Codex separately only if its CLI/auth is verified. Restart via the approved deployment mechanism.
11. Run a small approved production smoke in a disposable PUBLIC repository/branch; record IDs and cost.
12. Observe exactly one ACTIVE lease for that repository/branch and reject a competing writer.
13. Save and read back a validated checkpoint and atomic mirror; scan for secrets.
14. Force a safe drain and handoff only to an operational eligible worker; verify baton, branch and commit continuity.
15. Exercise bounded interruption/restart recovery only with confirmed old-worker termination; reject unconfirmed reclaim.
16. Verify the project-nested UI at desktop/mobile, both themes and keyboard, with accurate status/basis.
17. Verify events, quota snapshots, monitoring and rollback readiness; watch for stale leases, duplicate edits and unintended paid calls.
18. Record the final production verdict and owner sign-off. Keep the flag OFF or roll back immediately on any failed gate.

The current stacked PR bases **must not** be merged as-is into their parent branches during activation; each descendant is retargeted to `main` only after its predecessor is merged and deployed. Preserve commit ancestry to avoid duplicate changes.

## V. ROLLBACK PLAN

1. **First action for any runtime/supervisor incident:** set `CONTINUITY_SUPERVISOR=false` and restart by the approved path; leave worker rows, checkpoints and event evidence intact.
2. **Migration application problem:** stop before any merge or flag change; verify migration history/fingerprint and restore from the verified backup only if required and explicitly approved. Prefer a reviewed additive forward repair. Never drop continuity tables as the first action.
3. **Runtime deploy failure:** let the existing deployment rollback return to the last healthy image; confirm `/healthz`. If code rollback is needed, revert #106, #105 and #104 in reverse order with review and CI. Keep #102's applied migration tracked rather than deleting its schema history.
4. **Supervisor failure:** keep flag OFF, inspect startup/events and the last checkpoint, correct code/config on a new PR, and re-run the smoke before re-enabling.
5. **Lease deadlock or unconfirmed old writer:** keep flag OFF and the branch frozen; inspect session/heartbeat/process and checkpoint. Reclaim only through the token/verified branch path after old-writer termination is proven. Never delete lease rows to force progress.
6. **Bad handoff or lost diff:** stop both workers, preserve worktrees and evidence, compare the checkpoint with Git and the remote branch, then resume from a verified commit on a reviewed path. Do not reset the branch or discard dirty work.
7. **UI regression:** keep flag OFF if controls are misleading; roll back #106 UI changes or the final deploy after review, while preserving the database and runtime evidence.

## W. REMAINING BLOCKERS

The **real Phase N chain** is missing: no isolated native Office continuity execution, no authenticated Codex execution in this environment, no executable third adapter, no live three-worker commit/lease/checkpoint/CI proof, and no real process-restart drill. The Codex CLI stop/branch/reclaim guards now fail closed, but a CLI process after restart cannot be considered dead without durable proof. Do not apply the migration, merge, deploy or enable the supervisor on the strength of fake-worker tests.

## X. FINAL READINESS VERDICT

CONTINUITY NOT READY — blocker: the required real Phase N three-worker handoff and restart drill cannot be executed with the current isolated runtime and executable worker interfaces.

## Y. CLOUD-ONLY CLOSURE SPRINT (2026-10-02) — SUPERSEDES X

Re-run of this package from a Freebuff cloud workspace, starting from PR #106 head `13c3668d1842f018fcdf4615aa9ae101a1c75c1c`. Cloud-only: nothing was read from or written to the owner's laptop, and no production surface was touched.

### Y.1 Sync

GitHub was fetched and the branch head verified as `13c3668d1842f018fcdf4615aa9ae101a1c75c1c`, identical to the PR #106 head. The local branch was fast-forwarded to it; no force push. Three stale uncommitted edits (`.continuity/checkpoint.json`, `docs/CODEX-CONTINUE.md`, `docs/HANDOVER.md`, from the 2026-10-01 readiness run) were compared against the remote, found superseded by the later history, backed up outside the repository and discarded; their unique findings were carried into `docs/HANDOVER.md`.

### Y.2 AppArmor root cause

**Host-specific, not a Continuity defect.** In this container `unshare --user` succeeds, the AppArmor module is not loaded, and `codex sandbox linux -- sh -c 'echo SANDBOX_OK'` completes. The 2026-10-02 VPS `bwrap: No permissions to create a new namespace` failure came from that hardened test container's Ubuntu AppArmor/user-namespace policy. The Continuity core only spawns the worker CLI and never enters a sandbox itself. No host security was relaxed and no sandbox was bypassed.

### Y.3 Portable isolation change (smallest safe fix)

* `src/continuity/errors.js`: vendor-neutral `sandboxDenial()` plus the new `SANDBOX_UNAVAILABLE` code, used by the shared driver classifier so every external worker's isolation failure is recognised, not only Codex's wording.
* `src/continuity/adapters/codex.js`: uses that detector instead of one literal `bwrap:` regex, and pre-flights the host sandbox (`codex sandbox linux -- true`) so a host that cannot run the workspace-write sandbox reports the worker unavailable before a turn is spent.
* `src/continuity/adapters/external-cli.js`: `verifySandbox()` for every external worker, reported as `SANDBOX_UNAVAILABLE` with `HOST_CAPABILITY_REQUIRED`, and mapped to its own error code instead of `AUTH_REQUIRED`.

All three changes are additive and fail closed. Coverage lives in `test/continuity-adapters.test.js`.

### Y.4 Real workers in this environment: none

| Registry worker | Why it cannot execute here |
|---|---|
| Fahad Office Coding Agent | No `freebuff-env` files, so no Supabase URL/service credential and no model-provider key |
| OpenAI Codex | `codex-cli 0.128.0` < required `>=0.150.0`; `codex login status` = Not logged in; a flag-free `codex exec --json` reaches OpenAI and fails `401 Unauthorized` |
| Claude Code | `2.1.128` < required `>=2.1.268`; print-mode probe reports Not logged in; subscription-only auth by design |
| Google Antigravity | `OFFICIAL_HEADLESS_INTERFACE_NOT_CONFIGURED` |
| OpenCode | `ZEN_MODEL_NOT_VERIFIED_FREE` and the other owner gates |
| Kilo Code | `SUPPORTED_HEADLESS_MODE_NOT_CONFIGURED` |
| Freebuff | `OWNER_DISABLED`; no Freebuff CLI, MCP server or HTTP endpoint exists in this sandbox |

Gemini CLI 0.40.1 and Cursor Agent 2026.09.10 are also installed and also unauthenticated; neither is a registry worker. Freebuff therefore exposes no callable worker interface, and that is reported rather than worked around.

### Y.5 Drills

**Phase 5 (multi-worker handoff) and Phase 6 (restart/recovery) were not run:** zero executable registry workers. No scripted stand-in was presented as real-worker evidence, and no mock was promoted to a certification claim. Section C, section E, section F and section G of this package therefore keep their previous status.

### Y.6 What was validated for real

* Full `node --test`: **582 passed, 0 failed, 0 skipped** after `npm ci`.
* Focused continuity suite (adapters, supervisor, lease, e2e, store, schema, worktree, checkpoint, checkpointer, select, gates, packet, mje, usage, UI, office adapter, code-intelligence): **68 passed, 0 failed**.
* `test/docs-references.test.js` and `test/hermes-separation.test.js` green.
* `npm run db:replay`: all 32 migrations replayed and the `coding_continuity` scenario green on a real local PostgreSQL 14. The generated fingerprint content equals `supabase/verify/schema-fingerprint.txt` line for line after sorting; raw line order differs only because this sandbox's collation differs, so the committed fingerprint file was deliberately not regenerated.
* PR state read-only on 2026-10-02: #102 `53d2479`, #104 `36a5c87`, #105 `1cdc883`, #106 `13c3668` all OPEN and `MERGEABLE` on the correct stacked bases, `validate` passing; #107 and #108 still OPEN against `main` and duplicating the stack.

### Y.7 Verdict

**CONTINUITY CORE BLOCKED — blocker: no real executable coding worker is available in this environment.**

This is narrower than a design failure: the core's schema, leases, checkpoints, supervisor, freeze/reclaim guards, one-writer rules, privacy and quota selection, completion gates and UI are green and unchanged. The missing piece is a worker that can actually execute. Codex and Claude Code remain `IMPLEMENTED / TESTED IN CODE / LIVE CERTIFICATION DEFERRED` and stay disabled in production; neither is claimed as certified.

The exact next action is in `.continuity/checkpoint.json` → `next_exact_action` and at the top of `docs/CODEX-CONTINUE.md`.
