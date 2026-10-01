# Codex: continue from here

Claude Code designed the Coding Continuity Supervisor (PR #101, merged) and then implemented **Phase A** (PR #102, **open, not merged, migration NOT applied**). Codex continues from there. Everything needed is in this repository; no conversation history is required.

## State at handover (2026-10-01)

| Item | Value |
|---|---|
| Main | `76738ed437abf39ada2f6dc9f161fd522c947f77` (docs-only merge of #101) |
| Production | `2bb17b0347b3dde0ecfa2f22b089a9460d02b458` (deploy run 86, success). Nothing since has deployed. |
| Phase A | **DONE** on branch `claude/continuity-foundation`, PR https://github.com/FahadTrail/fahad-ai-office/pull/102. Open; do not merge without Fahad. |
| Phase A migration | `supabase/migrations/20261004090000_coding_continuity.sql` on that branch. **Not applied to production.** |
| Phase B | **Not started.** No `claude/continuity-phase-b-foundation` branch exists. |
| Phases C–N | Not started. |
| Tests | `node --test` 522/522 on the Phase A branch, including the schema replay and the `coding_continuity` scenario. |
| Live checkpoint | `.continuity/checkpoint.json` on the Phase A branch. |

**Phase A decision you must keep:** an applied 2026-09-22 POC already owns `continuity_checkpoints` and `continuity_handoffs`. The Supervisor tables are therefore `coding_checkpoints` and `coding_handoffs`. Never modify the POC tables. A `FROZEN` lease also blocks its branch until `reclaim_coding_lease`.

## Ready-to-paste prompt for Codex

```
You are continuing Fahad AI Office development from Claude Code. Do not restart or redesign the project.

Repository: FahadTrail/fahad-ai-office (GitHub is the source of truth; no chat history is needed).

1. Read AGENTS.md completely. Its rules are permanent.
2. Read docs/HANDOVER.md, starting with the top section "CLAUDE FINAL IMPLEMENTATION → CODEX".
3. Read docs/CODING-CONTINUITY-SUPERVISOR.md (locked architecture), docs/CONTINUITY-IMPLEMENTATION-PLAN.md
   (phases A–N) and docs/DEVELOPMENT-CONTRACT.md.
4. Inspect GitHub: main is 76738ed (or newer); Phase A is on branch claude/continuity-foundation, PR #102,
   OPEN. Read .continuity/checkpoint.json on that branch.
5. Verify production without changing it: the latest successful "Deploy Fahad AI Office" workflow run must
   have head_sha 2bb17b0347b3dde0ecfa2f22b089a9460d02b458. Never SSH, never touch the server, never read secrets.
6. Review PR #102: `git fetch origin && git checkout claude/continuity-foundation && npm ci && node --test`
   (all green, including test/schema-replay.test.js) and confirm its CI is green. Fix only real defects, on that branch.
7. Do NOT merge PR #102 and do NOT apply the migration. Both wait for Fahad's explicit approval
   (production apply on Supabase project zkzibipinjeswhdxnfgf, then the read-only fingerprint check, then merge).
8. Continue with Phase B on a stacked branch:
   `git checkout -b codex/continuity-phase-b origin/claude/continuity-foundation`.
   Build src/continuity/store.js, src/continuity/lease.js and src/continuity/checkpointer.js with unit tests,
   exactly as Phase B in docs/CONTINUITY-IMPLEMENTATION-PLAN.md says (fake Supabase client and fake clock,
   no runtime wiring, CONTINUITY_SUPERVISOR stays off). Open its PR against claude/continuity-foundation,
   not main, and say it merges only after PR #102.
9. Test: `node --test` green before every push. Never edit supabase/verify/schema-fingerprint.txt by hand.
10. Checkpoint: update .continuity/checkpoint.json (validated by src/continuity/checkpoint.js) with every
    commit, and put a CONTINUITY_CHECKPOINT block in each PR description.
11. Preserve the architecture: the seven permanent workers (Office Coding Agent, Claude Code, Codex,
    Antigravity, OpenCode, Kilo Code, Freebuff), GitHub as truth, Fahad AI Office as policy authority.
    Do not touch core routing, capacity, FINANCE/AUDIT/fact gate, the V5 UI, the POC continuity_* tables
    or anything Hermes-related. No scraping, no consumer logins as an API, no invented quota numbers.
12. Before you run low on capacity, stop at a clean point, commit, push, update the checkpoint, and update
    docs/HANDOVER.md (top section) with branch, PR, tests, CI and the exact next action.
```

## Continuity checkpoint

```
CONTINUITY_CHECKPOINT
agent: Claude Code
next_agent: Codex
repository: FahadTrail/fahad-ai-office
main_commit: 76738ed437abf39ada2f6dc9f161fd522c947f77
production_commit: 2bb17b0347b3dde0ecfa2f22b089a9460d02b458 (deploy run 86, success 2026-10-01T09:24:19Z)
branch: claude/continuity-foundation
commit: head of claude/continuity-foundation (Phase A code 13db29ef744873b450ce805d5beb7403b3d2f13b, then the handover-docs commit on top)
pr: https://github.com/FahadTrail/fahad-ai-office/pull/102 (OPEN, do not merge without Fahad)
objective: Build the Coding Continuity Supervisor so development continues across the seven permanent workers with leases, checkpoints and automatic handoff.
phase: A done; B next
status: HANDOFF_READY
completed: Phase A — migration 20261004090000_coding_continuity (6 tables, 8 RPCs, RLS, 7 seeded workers), scenario coding_continuity.sql, src/continuity/checkpoint.js, src/continuity/states.js, tests, regenerated schema fingerprint
next_action: Review PR #102 (node --test, CI), then create codex/continuity-phase-b from origin/claude/continuity-foundation and build Phase B (store.js, lease.js, checkpointer.js + tests); do not merge #102 or apply the migration.
tests: node --test 522/522 pass on claude/continuity-foundation (includes schema replay + coding_continuity scenario)
ci: see PR #102 checks (validate)
deploy: none; production remains 2bb17b0
blockers: Merging PR #102 needs Fahad's approval to apply migration 20261004090000_coding_continuity to production (Supabase zkzibipinjeswhdxnfgf).
files_changed: supabase/migrations/20261004090000_coding_continuity.sql, supabase/verify/scenarios/coding_continuity.sql, supabase/verify/schema-fingerprint.txt, src/continuity/checkpoint.js, src/continuity/states.js, test/continuity-schema.test.js, test/continuity-checkpoint.test.js, .continuity/checkpoint.json, docs/HANDOVER.md, docs/CODEX-CONTINUE.md, docs/CONTINUITY-IMPLEMENTATION-PLAN.md, docs/CODING-CONTINUITY-SUPERVISOR.md
do_not_touch: src/model-gateway/, src/hub-capacity.js, src/office/finance.js and the AUDIT/CHIEF fact gate, V5/V4 UI, Dockerfile, docker-compose.yml, ops/deploy.sh, applied migrations (including the POC continuity_* tables), production .env and secrets, anything Hermes-related
rollback: close PR #102 unmerged (nothing reached main or production); main 76738ed is unchanged
timestamp: 2026-10-01T13:30:00Z
```

## If something is unclear

* Architecture: `docs/CODING-CONTINUITY-SUPERVISOR.md` wins over this file. Rules: `AGENTS.md` wins over everything.
* A real contradiction: do not guess. Record it in the checkpoint's `unresolved_items` and in `docs/HANDOVER.md`, then continue with the unambiguous parts.
