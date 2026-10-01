# Codex: continue the Coding Continuity Supervisor

## Phase N readiness update (2026-10-01)

Start with `docs/CONTINUITY-PHASE-N-READINESS.md` and the new top section of `docs/HANDOVER.md`. Automated UI checks, mobile sizes, keyboard/drawer behavior, privacy and shared-quota tests are complete; #106 also contains fail-closed Codex stop, Git-head and stale-writer verification fixes. The real Office → Codex → third-worker handoff and process-restart drill is **not** complete. No third adapter is executable, and this local Codex CLI cannot load its login configuration. The production activation package is a plan only. Check final #106 CI, then arrange supported third-worker implementation/verification and an isolated real Phase N drill; do not merge, migrate, deploy or activate meanwhile. The older sections below explain the stack history.

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

Focused continuity tests passed 54/54 locally and UI/Hub syntax checks passed 9/9. #102, #104, #105, and #106 Linux CI passed; #106 head `4acb2d2` ran 565 Node tests (563 pass, 2 skip), 15 container tests (15 pass), and the full database replay. #105's first run failed because `src/continuity/runtime.js` contained an unrelated-system name caught by the separation guard; `1cdc883` fixed the guard wording without changing the test, and the rerun passed. Windows full-suite results are not authoritative because existing Bash/PATH and URL-to-path issues remain on Windows. The local preview loaded the new view in dark and light with no console error or desktop overflow. Automated axe and mobile visual checks remain; the dedicated agent-browser CLI was unavailable. Verify CI on the latest docs-only head before any merge. Fix any real failures on the owning branch and restack descendants.

The next release gate is Phase N, a real Office → Codex → third-worker handoff on a throwaway branch with commit, checkpoint, lease, and CI evidence. Its third worker's verified headless availability is unresolved. Coordinate that drill with Fahad. Do not apply the migration, merge the stack, deploy, or enable the flag until the requisite evidence and Fahad's explicit approval.

At each new checkpoint, update `.continuity/checkpoint.json`, this file, and the top of `docs/HANDOVER.md`, and put a `CONTINUITY_CHECKPOINT` block in any new PR description. Do not alter core routing, capacity, FINANCE/AUDIT/fact gate, unrelated V5 UI, production, or separate-system resources.
