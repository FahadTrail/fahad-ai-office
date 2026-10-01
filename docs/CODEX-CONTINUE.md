# Codex: continue from here

> **UPDATE 2026-10-01 — READ THIS FIRST.** Continuity **Phase A is implemented** on branch `claude/continuity-foundation`, PR https://github.com/FahadTrail/fahad-ai-office/pull/102 (**open; migration NOT applied; do not merge without Fahad**). Phase B is not started. The current handover (prompt, checkpoint, exact next action) is the version of this file and of HANDOVER.md **on that branch**, and .continuity/checkpoint.json there. Do **not** start Phase A again from main.

Claude Code designed the Coding Continuity Supervisor and stopped before implementing it. Codex implements it, starting with Phase A. Everything needed is in this repository. No conversation history is required.

## State at handover (2026-10-01)

* **Product:** Fahad AI Office is complete and live (`docs/PRODUCTION-READY.md`). Do not change core behaviour.
* **Production:** `2bb17b0`, deployed 2026-10-01T09:24Z (deploy run 86, success). `/healthz` reports the deployed commit in `version`.
* **Main:** the squash merge of the handover PR (#101) on top of `abe447a`. The merge only added docs, so production stays at `2bb17b0` (only `src/`, `package.json` and `package-lock.json` ship).
* **Open PRs:** none besides this handover, which is merged before Codex starts.
* **CI:** green on the handover PR.
* **Supervisor:** designed, **not implemented**. No migration written, none applied.

## Ready-to-paste prompt for Codex

```
You are continuing Fahad AI Office development from Claude Code. Do not restart or redesign the project.

Repository: FahadTrail/fahad-ai-office (GitHub is the source of truth; no chat history is needed).

1. Read AGENTS.md completely. Its rules are permanent.
2. Read docs/HANDOVER.md, starting with the top section "CODING CONTINUITY SUPERVISOR — HANDOVER TO CODEX".
3. Read docs/CODING-CONTINUITY-SUPERVISOR.md (locked architecture) and
   docs/CONTINUITY-IMPLEMENTATION-PLAN.md (build order, phases A–N), then
   docs/DEVELOPMENT-CONTRACT.md.
4. Inspect main: `git fetch origin && git log --oneline -5 origin/main`. The newest commit
   is the handover merge on top of abe447a. Run `npm ci && node --test`; everything must pass
   before you change anything.
5. Verify production without changing it: the latest successful run of the GitHub Actions workflow
   "Deploy Fahad AI Office" (.github/workflows/deploy.yml) must have head_sha 2bb17b0347b3dde0ecfa2f22b089a9460d02b458
   (run 86). If Fahad gives you the Hub URL, GET <hub>/healthz and confirm `version` starts with 2bb17b0.
   Never SSH, never touch the server, never read secrets.
6. Create an isolated branch from the latest main: `git checkout -b codex/continuity-phase-a origin/main`.
   Never push to main.
7. Begin Phase A exactly as specified in docs/CONTINUITY-IMPLEMENTATION-PLAN.md:
   migration supabase/migrations/20261004090000_coding_continuity.sql (six additive tables,
   RPCs, RLS service-role only, worker seed), scenario supabase/verify/scenarios/coding_continuity.sql,
   src/continuity/checkpoint.js, src/continuity/states.js and their tests.
   Do not apply the migration to production.
8. Test: `npm run db:replay` (regenerate supabase/verify/schema-fingerprint.txt with the replay,
   never by hand) and `node --test`. Both must be green.
9. Checkpoint: write .continuity/checkpoint.json (schema continuity.checkpoint.v1) and put a
   CONTINUITY_CHECKPOINT block (template in the plan) in the PR description. Push the branch and
   open a PR; keep it open until Fahad approves applying the migration to production.
10. Preserve the architecture: the seven permanent workers (Office Coding Agent, Claude Code,
    Codex, Antigravity, OpenCode, Kilo Code, Freebuff), GitHub as truth, Fahad AI Office as policy
    authority, CONTINUITY_SUPERVISOR off by default. Do not touch core routing, capacity,
    FINANCE/AUDIT/fact gate, the V5 UI or anything Hermes-related. No scraping, no reuse of consumer
    logins as an API, no invented quota numbers, no purchases.
11. If you run low on capacity, stop at a clean point: commit, push, update the checkpoint.
12. Update docs/HANDOVER.md (top section) with what you did, the branch, PR, tests, CI and the exact
    next action, so the next agent can continue the same way.
```

## Continuity checkpoint

```
CONTINUITY_CHECKPOINT
agent: Claude Code
next_agent: Codex
repository: FahadTrail/fahad-ai-office
main_commit: abe447a29c575754eb84ebfd091a4bae469f28d5 (base; main after this handover = squash merge of PR #101 on top of it)
production_commit: 2bb17b0347b3dde0ecfa2f22b089a9460d02b458 (deploy run 86, success 2026-10-01T09:24:19Z)
branch: claude/continuity-supervisor-spec (merged and done); next branch: codex/continuity-phase-a
commit: last commit of claude/continuity-supervisor-spec, squash-merged as PR #101
pr: https://github.com/FahadTrail/fahad-ai-office/pull/101
objective: Build the Coding Continuity Supervisor so development continues across the permanent worker stack (Office Coding Agent, Claude Code, Codex, Antigravity, OpenCode, Kilo Code, Freebuff) with leases, checkpoints and automatic handoff, without Fahad re-explaining anything.
phase: Design complete; implementation Phase A not started
status: HANDOFF_READY
completed: architecture locked (docs/CODING-CONTINUITY-SUPERVISOR.md); phases A–N with files, tests and acceptance (docs/CONTINUITY-IMPLEMENTATION-PLAN.md); worker rules (docs/DEVELOPMENT-CONTRACT.md); this handover; HANDOVER.md and AGENTS.md updated
next_action: Create branch codex/continuity-phase-a from origin/main and write supabase/migrations/20261004090000_coding_continuity.sql plus its scenario, src/continuity/checkpoint.js, src/continuity/states.js and tests, as Phase A of docs/CONTINUITY-IMPLEMENTATION-PLAN.md specifies; do not apply the migration to production.
tests: node --test green on the handover branch (docs-only change; see PR #101 checks)
ci: green on PR #101
deploy: none (docs-only merge; production remains 2bb17b0)
blockers: none for Phase A. Merging Phase A requires Fahad's approval to apply the migration to production (supabase project zkzibipinjeswhdxnfgf).
files_changed: docs/CODING-CONTINUITY-SUPERVISOR.md, docs/CONTINUITY-IMPLEMENTATION-PLAN.md, docs/DEVELOPMENT-CONTRACT.md, docs/CODEX-CONTINUE.md, docs/HANDOVER.md, AGENTS.md
do_not_touch: src/model-gateway/ (core routing), src/hub-capacity.js (capacity), src/office/finance.js and the AUDIT/CHIEF fact gate, the V5/V4 UI (except the nested continuity view in Phase L), Dockerfile, docker-compose.yml, ops/deploy.sh, applied migrations, production .env and secrets, anything Hermes-related
rollback: GitHub Revert of PR #101 (docs only, no deploy, no database change); last known good main abe447a
timestamp: 2026-10-01T11:30:00Z
```

## If something is unclear

* Architecture questions: `docs/CODING-CONTINUITY-SUPERVISOR.md` wins over this file.
* Rules: `AGENTS.md` wins over everything.
* A real contradiction: do not guess. Record it in the checkpoint's `unresolved_items` and in `docs/HANDOVER.md`, then continue with the parts that are unambiguous.
