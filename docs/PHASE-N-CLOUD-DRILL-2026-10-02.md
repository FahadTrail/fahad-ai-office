# Phase N cloud drill — 2026-10-02

Status: BLOCKED. This report is not production-activation approval. PR #106 and its parent stack remain open and unmerged.

## Isolated cloud environment

The drill ran only on the existing VPS. Test files are under `/opt/fahad-phase-n-tools-20261002`; the PR checkout is `/opt/fahad-phase-n-drill-20261002`. A disposable local bare Git origin and worktrees are separate from production. The test image is `fahad-phase-n-test:2baa0e6`. Local Supabase on a separate Docker network is loopback-bound; 32 migrations were replayed there. No production database migration, deployment, flag change, production user job, or paid API model was used.

Official Codex CLI 0.160.0 and Claude Code 2.1.287 are installed under the VPS test tools directory. Their subscription login state is cloud-side in the separate `codex/` and `claude/` directories, not on the owner laptop or in Git. Do not copy or print these directories. This proves laptop independence for this test setup, not a production service or backup guarantee. Graphify remains optional source-controlled tooling; a persistent VPS graph cache was not established or verified by this drill.

## Real execution evidence

- Native Office Coding Agent created an actual session, lease, checkpoint, and disposable-branch commit `08eae1570dbb489465be0f86a3b60cefa65c9f88` on `phase-n/real-drill-c-20261002`. It stopped before the next lease was acquired.
- Office to Codex handoff was accepted. Codex session `04aea46d-e2a1-49a0-b692-75348161623a` started with the Office commit, but made no commit. Its shell actions all failed because bubblewrap could not create a user namespace inside the hardened VPS test container. Codex CLI nevertheless emitted `turn.completed` and exited 0. This is not a successful coding execution.
- An earlier Codex attempt, session `5abe4882-d1da-4a38-a4b2-e57f9d14b074`, hit the subscription usage limit and exited 1. A later standalone Codex reply succeeded after quota reset; it did not prove file-edit execution.
- Claude Code authenticated through Claude.ai and independently created `testing/phase-n-claude-probe.md` with `Claude: ready` in a separate disposable checkout. That was real CLI execution, but it was not a Supervisor handoff or a completed three-worker chain.
- After the failed Codex run, a restarted Supervisor froze and reclaimed the stale lease after confirming the old process had stopped and verifying Git/checkpoint state. With workers deliberately disabled in the test registry, it returned `NO_ELIGIBLE_WORKER`; the test database then had zero ACTIVE or FROZEN coding leases. This is partial recovery evidence, not a passed restart/resume drill.

## Code safety fix and remaining gate

The drill exposed two result-classification defects. PR #106 now recognizes the Codex `usage_limit_exceeded` signal as quota exhaustion and treats a failed `command_execution` bubblewrap bootstrap as worker failure even if Codex reports a completed turn. Targeted adapter tests passed locally (9/9); the final PR CI result must be checked on the latest head.

The required Office to Codex to Claude handoff, three real worker commits, and completed restart/resume drill did **not** pass. The exact blocker is the VPS test container/Ubuntu AppArmor policy denying the Linux user namespace required by Codex workspace-write sandbox. Do not disable the global AppArmor user-namespace restriction or bypass Codex sandbox without an explicit, security-reviewed decision. Resolve this in a scoped isolated runner, then repeat the full real drill and CI before any production activation.
