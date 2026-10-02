## ALTERNATIVE WORKERS + VPS PHASE N — EXACT RESUME POINT (2026-10-02; supersedes every section below)

Read `AGENTS.md`, the top of `docs/HANDOVER.md`, **`docs/CONTINUITY-VPS-WORKERS.md`** (the new runbook) and `.continuity/checkpoint.json` first. The sections below are history, not current work orders; their evidence and preserved VPS assets remain valid.

**What this sprint did (development + preparation only, production untouched):**

* Verified the current official interfaces and built the alternative chain **FAHAD OFFICE → OPENCODE → GEMINI CLI**: upgraded `src/continuity/adapters/opencode.js` into a real executable adapter and created `src/continuity/adapters/gemini-cli.js`, both OFF by default behind `CONTINUITY_OPENCODE_ENABLED` (+ five owner gate assertions) and `CONTINUITY_GEMINI_CLI_ENABLED`, both wired once through `externalAdaptersFromEnv` in `src/continuity/runtime.js` shared with production, both shown in the Hub's `PREPARED_ADAPTERS`.
* Formalised the eight-category failure taxonomy (`FAILURE_TAXONOMY` / `failureCategory()` in `src/continuity/errors.js`) without renaming any runtime code; the shared external driver is reused unchanged — no duplicate worker infrastructure.
* Grew the registry truthfully: new data-only migration `supabase/migrations/20261005090000_continuity_gemini_worker.sql` adds the disabled `gemini-cli` row (eight workers; scenario updated; fingerprint content unchanged; Phase A migration untouched).
* Shipped `ops/setup-continuity-workers.sh` (`--check` verify-only, `--install` official npm packages, never touches credentials/flags/containers), `docs/CONTINUITY-VPS-WORKERS.md` (install, both official auth flows, flags, taxonomy, drill, rollback, truthful certification table) and `tools/continuity-phase-n-live.mjs` (`--check` / `--run` / `--selftest`): disposable branch and worktrees, isolated persisted store, real chain evidence (lease/session/checkpoint IDs, commit SHAs, stop-before-transfer ordering, one-writer replay, exact-commit resume) and the fail-closed restart sequence (real SIGKILL → OS-verified death proof → refused first recovery → sealed proof → reclaim → resume → completion).
* Targeted tests only, all green: syntax sweep, focused continuity **75/75**, docs path-reference and Hermes separation suites, `npm run db:replay` **33 migrations** plus every scenario, drill `--selftest`; drill `--check` refuses this unauthenticated environment with 11 exact blockers (by design).

**What was NOT done:** no authenticated model turn, no live worker run, no real handoff or restart drill (the `--run` path has never executed with credentials), no merge, no deploy, no migration application, no production flag change, no Hermes access, no force push. Codex and Claude Code remain `IMPLEMENTED / CERTIFICATION DEFERRED`.

**Exact resume point for the next agent:**

1. Read the four files named above; do not redo the interface verification, adapters, registry migration, script or runbook.
2. On the VPS run `bash ops/setup-continuity-workers.sh --check`, then `--install`, then authenticate per `docs/CONTINUITY-VPS-WORKERS.md` (OpenCode official login or provider key by name; Gemini `GEMINI_API_KEY` or the official browser URL/code flow) and assert the drill-shell flags.
3. Run `node tools/continuity-phase-n-live.mjs --check`, then `--run`, and review `.continuity/phase-n-drill/report.json` — a PASS verdict requires every listed evidence item; any gap fails with an exact blocker.
4. Keep #102 → #104 → #105 → #106 open and stacked; ask the owner to close or re-cut #107 and #108.
5. Nothing activates without Fahad: migration application, ordered merges, deploy and `CONTINUITY_SUPERVISOR` / worker-flag activation stay OFF until explicit approval after a PASS report.

## CLOUD-ONLY CLOSURE — EXACT RESUME POINT (2026-10-02; historical — superseded by the section above)

Read `AGENTS.md`, the top of `docs/HANDOVER.md`, `docs/CONTINUITY-PHASE-N-READINESS.md` and `.continuity/checkpoint.json` first. The safe-stop, Graphify and development-only sections below are history, not current work orders. Their evidence and the preserved VPS assets remain valid and untouched.

**What this sprint did (cloud-only, no laptop dependency):**

* Re-fetched GitHub and verified `codex/continuity-readiness` at `13c3668d1842f018fcdf4615aa9ae101a1c75c1c`, the same SHA as PR #106. Fast-forwarded locally; no force push. Three stale uncommitted 2026-10-01 edits were compared with the remote, found superseded, backed up outside the repository and discarded; their unique findings were carried into `docs/HANDOVER.md`.
* Root-caused the AppArmor blocker as **host-specific**: in this cloud container `unshare --user` works, no AppArmor module is loaded, and `codex sandbox linux -- sh -c 'echo SANDBOX_OK'` runs the real Codex sandbox successfully. The VPS denial came from that hardened test container's policy, not from this repository. No host security was relaxed.
* Made isolation handling portable and fail-closed: `src/continuity/errors.js` gained a vendor-neutral `sandboxDenial()` detector and the `SANDBOX_UNAVAILABLE` code; `src/continuity/adapters/codex.js` uses it instead of one literal `bwrap:` regex and pre-flights the host sandbox; `src/continuity/adapters/external-cli.js` exposes `verifySandbox()` for every external worker and reports `SANDBOX_UNAVAILABLE` / `HOST_CAPABILITY_REQUIRED`.
* Ran the real validations that this environment can honestly support: full `node --test` 582/582, focused continuity suite 68/68, docs path-reference and Hermes separation suites green, and `npm run db:replay` replaying all 32 migrations plus the `coding_continuity` scenario on a real local PostgreSQL 14.

**What was NOT done, and why:** there is **no real executable coding worker** in this environment. The Office adapter has no Supabase or model-provider credential; Codex CLI 0.128.0 is below the required `>=0.150.0` and is not logged in (a flag-free `codex exec --json` reaches OpenAI and fails `401`); Claude Code 2.1.128 is below the required `>=2.1.268` and is not logged in; Gemini CLI and Cursor Agent are installed but unauthenticated and are not registry workers; Antigravity, OpenCode, Kilo and Freebuff are owner-gated or manual; Freebuff exposes no callable worker interface. The Phase 5 multi-worker handoff drill and the Phase 6 restart/resume drill therefore were **not** run, and no scripted substitute was presented as worker evidence.

**Exact resume point for the next agent:**

1. Read the four files named above; do not redo the sync, the AppArmor diagnosis or this documentation.
2. Provide one genuinely executable registry worker on a sandbox-capable host — either an authenticated Codex CLI at `>=0.150.0`, or a native Office adapter pointed at a Supabase instance plus a model provider. Nothing else in the core is missing.
3. Only then run the real disposable-branch drill: Worker A lease → real change → real commit → checkpoint → drain → Worker B from that exact commit → Worker C, plus the restart/recovery pass, capturing session IDs, lease IDs, checkpoint IDs, commit SHAs, branch names and event IDs.
4. Keep #102 → #104 → #105 → #106 open and stacked; ask the owner to close or re-cut #107 and #108, which target `main` and duplicate the stack.
5. Do not merge, retarget, apply the production migration, deploy, or enable `CONTINUITY_SUPERVISOR` / `CONTINUITY_CODEX_ENABLED` / `CONTINUITY_CLAUDE_ENABLED` without Fahad's explicit approval.

## SAFE STOP / EXACT RESUME POINT (2026-10-03; historical — superseded by the section above)

Fahad ordered STOP. No more tests, workers, CI reruns, production changes, merges, deployments, migrations, or flag activation. Preserve all isolated VPS assets and local worktrees. Read `docs/PHASE-N-CLOUD-DRILL-2026-10-02.md`, the top of `docs/HANDOVER.md`, and `.continuity/checkpoint.json` before any later action. The previous Graphify/development-only instructions below are history, not current work orders.

PR #106 branch: `codex/continuity-readiness`; observed head before safe-stop docs was `8c4b871c41266769f51b33941991693c177ef00e`. Safe-stop commits were then published directly to this existing branch because the Windows local checkout cannot authenticate a normal Git push; do not force-push its divergent local history. It has the same adapter/test changes uncommitted locally and must be preserved. The prior CI run at `39508d9` failed its docs path-reference check (a throwaway Claude file was not in this repository); the documentation at `8c4b871` clarified the location. CI was pending when STOP arrived. Do not start or rerun CI; merely inspect the current result if the user later resumes.

Last completed real step: Office session `7361d625-fa8e-486a-8891-126abd10b13d` committed `08eae1570dbb489465be0f86a3b60cefa65c9f88` on disposable branch `phase-n/real-drill-c-20261002`, released its lease, and handed off to Codex session `04aea46d-e2a1-49a0-b692-75348161623a`. Codex authenticated and took ownership, but all shell commands failed because bubblewrap could not create a user namespace; it made no commit. Claude Code independently authenticated and wrote a disposable test file in a separate checkout; no Supervisor handoff to Claude occurred. A restarted test Supervisor verified the old Codex process stopped and Git/checkpoint matched, reclaimed its stale lease, and stopped with `NO_ELIGIBLE_WORKER`; zero ACTIVE/FROZEN test leases remained.

Exact blocker: the VPS test container and Ubuntu AppArmor user-namespace policy deny the namespace required by Codex workspace-write sandbox. Do not disable AppArmor or bypass the sandbox. On a future explicit resume, first read-only inspect the preserved test assets, PR head, and CI; arrange a scoped security-reviewed isolated runner, then redo the real Codex-to-Claude handoff and completed restart/recovery drill. Production CONTINUITY_SUPERVISOR was checked OFF, and production containers remained healthy.

# Codex: continue the Coding Continuity Supervisor

## Current handoff: optional Graphify pilot (2026-10-02)

Fahad authorized a final **development-only** Graphify pilot on the existing open #106 branch. Read `docs/GRAPHIFY.md` and the top of `docs/HANDOVER.md`. Official `graphifyy[sql]==0.9.73` was installed only in an ignored local virtual environment. The code-only graph and HTML/report are generated locally and ignored; no docs/media semantic model processing is enabled. The wrapper can build, update and query it, while `src/continuity/code-intelligence.js` provides bounded optional navigation hints. Coding Agent usage requires `CODING_GRAPHIFY_ENABLED=true` and a prebuilt graph in its own checkout; absence/failure falls back silently. No Supervisor control path depends on Graphify. Benchmark instrumentation is ready, but no savings are claimed.

The #106 starting remote head for the pilot was `bcd572f520f0f900bd99a9c065ea4cc852d38c2c`, so the local-only/push-authentication statements in the section below are historical. Do not run the final Continuity test phase, real drill, migration, merge, deploy or activation without a new user instruction. Static syntax and targeted Graphify commands are the only verification in this sprint.

The **new Graphify pilot commits** (`36f11f1`, `9465be2`) are local only until GitHub write authentication is restored; remote #106 still points to `bcd572f`. Preserve this checkout and push without force, then confirm the PR head. This is a new publication blocker, distinct from the historical one for the earlier Continuity commits.

## Current handoff: development complete, testing intentionally deferred (2026-10-02)

Fahad's latest instruction was development only; do not continue the Phase N/readiness work in the historical sections below. The existing #106 branch now contains implementation commit `8ea3f5a512c0b45ce876939fba812dc099a328c6`: Office, Codex and Claude Code have executable adapter code; the latter two require explicit enable flags, an installed supported CLI, a verified login, and the owner enabling their registry entries. No claim of a successful real invocation is made. The shared CLI driver, safe stop, same-worker CLI resume metadata, branch/worktree transfer, recovery guards, owner API controls, nested UI and event/error model are implemented. Read the new top of `docs/HANDOVER.md` and `.continuity/checkpoint.json` for exact state.

No full tests, DB replay, browser/accessibility/mobile tests or real worker drill were run after this implementation. Existing `test/continuity-adapters.test.js` still describes the old Codex constructor and deprecated flag; update it in the **next testing phase** before executing it. The earlier implementation and docs commits were subsequently pushed to #106; the old authentication blocker is resolved. Keep #102/#104/#105/#106 open; no migration, merge, deploy or flag activation. Do not begin testing automatically: wait for Fahad's next direction.

## Phase N readiness update (2026-10-01; historical, pre-development)

Start with `docs/CONTINUITY-PHASE-N-READINESS.md` and the new top section of `docs/HANDOVER.md`. Automated UI checks, mobile sizes, keyboard/drawer behavior, privacy and shared-quota tests are complete; #106 also contains fail-closed Codex stop, Git-head and stale-writer verification fixes. Code head `3759ff9` passed Linux CI, including 573 Node tests, 15 container tests and 32-migration replay; check the documentation-only follow-up head too. The real Office → Codex → third-worker handoff and process-restart drill is **not** complete. No third adapter is executable, and this local Codex CLI cannot load its login configuration. The production activation package is a plan only. Arrange supported third-worker implementation/verification and an isolated real Phase N drill; do not merge, migrate, deploy or activate meanwhile. The older sections below explain the stack history.

The authoritative current state is the top section of `docs/HANDOVER.md` and `.continuity/checkpoint.json`. Read `AGENTS.md` first, then `docs/CODING-CONTINUITY-SUPERVISOR.md`, `docs/CONTINUITY-IMPLEMENTATION-PLAN.md`, and `docs/DEVELOPMENT-CONTRACT.md`. GitHub contains the complete branch stack; no prior chat is needed.

## Current stack (2026-10-01)

| Order | Branch | PR | Scope |
|---|---|---|---|
| 1 | `claude/continuity-foundation` | [#102](https://github.com/FahadTrail/fahad-ai-office/pull/102) | Phase A schema, RPCs, validator; migration unapplied |
| 2 | `codex/continuity-runtime-core` | [#104](https://github.com/FahadTrail/fahad-ai-office/pull/104) | Phase B store, lease, checkpointer |
| 3 | `codex/continuity-workers` | [#105](https://github.com/FahadTrail/fahad-ai-office/pull/105) | Phases C-G supervisor, adapters, API, recovery |
| 4 | `codex/continuity-readiness` | [#106](https://github.com/FahadTrail/fahad-ai-office/pull/106) | Phases H-M project view and temporary Git recovery drill |

All PRs are open and unmerged. #102 is based on `main`; each later PR targets the branch immediately above it in this table. The Phase A branch was refreshed onto `main` commit `dfe216161fab509e21bfde0cc1126f7662d1abf3`. Production was last recorded at `2bb17b0347b3dde0ecfa2f22b089a9460d02b458`; no production action was taken in this sprint.

The migration `supabase/migrations/20261004090000_coding_continuity.sql` has **not** been applied. It uses `coding_checkpoints` and `coding_handoffs` because the older, applied POC owns `continuity_checkpoints` and `continuity_handoffs`. Do not touch the POC tables. A frozen branch lease blocks writers until verified reclaim.

## What is operational in code

The supervisor is wired behind `CONTINUITY_SUPERVISOR=true` and is off by default. The native Office adapter is available; Codex requires the separate `CONTINUITY_CODEX_ENABLED` flag and a verified local CLI. Claude Code, Antigravity, OpenCode, Kilo, and Freebuff remain truthful disabled/manual adapters until their supported interfaces and account conditions are verified. Do not describe all seven as automatic.

The project-nested dashboard is under Projects → project → Coding continuity. The recovery E2E uses a disposable local Git repository and worktrees; it is not the Phase N real multi-worker drill.

## Validation and next action

Focused Continuity tests passed 62/62 locally; the fictional-data browser audit passed 20/20 viewport/theme/motion cases with no critical or serious axe findings. #102, #104, #105, and #106 Linux CI passed; #106 code head `3759ff9` ran 573 Node tests (571 pass, 2 skip), 15 container tests (15 pass), and replayed 32 migrations. #105's first run failed because `src/continuity/runtime.js` contained an unrelated-system name caught by the separation guard; `1cdc883` fixed the runtime wording without changing the test, and the rerun passed. Windows full-suite results are not authoritative because existing Bash/PATH issues remain on Windows; the two real URL-to-path test bugs were fixed. Verify CI on the latest docs-only head before any later approval.

The next release gate is Phase N, a real Office → Codex → third-worker handoff on a throwaway branch with commit, checkpoint, lease, and CI evidence. Its third worker's verified headless availability is unresolved. Coordinate that drill with Fahad. Do not apply the migration, merge the stack, deploy, or enable the flag until the requisite evidence and Fahad's explicit approval.

At each new checkpoint, update `.continuity/checkpoint.json`, this file, and the top of `docs/HANDOVER.md`, and put a `CONTINUITY_CHECKPOINT` block in any new PR description. Do not alter core routing, capacity, FINANCE/AUDIT/fact gate, unrelated V5 UI, production, or separate-system resources.
