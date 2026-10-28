# Coding Agent: verified publish after resume (2026-10-28)

## Incident

Python acceptance session `bb02c85e` (repository
`FahadTrail/fahad-office-python-acceptance`) reached nine passing tests, then:

1. **17:48 UTC** — `git.push` was refused by GitHub with HTTP 403. The Coding
   Agent credential had no write permission on the fixture repository (the
   same credential pushed to `fahad-ai-office` in session `3cf33b7f` that
   morning). The session blocked at `phase=publish`.
2. **18:35 UTC** — after the credential was changed, the session resumed from
   checkpoint 17. The push was **not executed**: `tool_executions` holds only
   the 17:48 row for `git.push-14-…`, and the "Pushed … at 659573e" event came
   0.8 s after the call with no new execution. The session stored
   `pushedHead = 659573e`.
3. `github.pr_create` then got HTTP 422 `Validation Failed` (head branch
   invalid). `git ls-remote` on the fixture repository shows only `main` at
   `e8d4c5d`: the work branch never reached GitHub.

## Root cause

* Coding tool handlers turn a thrown error into a structured tool result
  (`structuredContent.error`, `isError: false`) so the model can read it. The
  Tool Broker therefore audits a refused push as `succeeded`.
* Controller-owned writes use a deterministic idempotency key
  (`tool-iteration-argsHash`). On resume the iteration and arguments were the
  same, so `begin_tool_execution` returned `replay`. A replay has no
  content, so the controller saw no error and accepted it as a push.
* The 422 followed from step 1: GitHub cannot open a PR for a branch that does
  not exist.

## Fix

* `Sandbox.publishBranch` proves the result on the remote: it reads the branch
  head with `git ls-remote` before pushing (already at the tested head means a
  verified no-op, so nothing is pushed twice) and after pushing (the remote
  must hold the tested head, otherwise `PUSH_NOT_VERIFIED`). A recorded lease
  head that is absent from the remote is treated as "never pushed", and the
  branch is created as new; a remote that moved elsewhere is still never
  overwritten.
* Push failures are classified as `PUSH_FORBIDDEN` (403, with the permission
  needed), `PUSH_UNAUTHORIZED` (401), `PUSH_REPOSITORY_NOT_FOUND` or
  `PUSH_FAILED` (lease refused).
* `GitHubClient.createPullRequest` reuses an open PR, then requires the head
  branch on GitHub at the pushed head (`REMOTE_BRANCH_MISSING`,
  `REMOTE_HEAD_MISMATCH`) before it POSTs. A 422 race re-checks for an open PR.
  422 messages now include GitHub's `errors[]` reasons.
* The controller treats a replay of `git.push` or `github.pr_create` as
  unproven: it runs the call again (both are idempotent and self-verifying)
  and records `pushedHead` only from a verified result. A stale stored
  `pushedHead` is reported as a warning event.
* Hub blockers read as the real cause and next action (English and Arabic).

No migration, Tool Broker or policy change. The broker's ledger still records
a handler-level error as `succeeded`. The controller no longer relies on that
ledger for external effects. Making the ledger truthful affects every broker
and is a separate change.

## Tests

`test/coding-agent-publish-verify.test.js` reproduces the production sequence
(refused push → resume → same idempotency key). Without the fix it fails with
the same `HTTP 422`. With the fix the tests show:

* the resumed session pushes for real and opens exactly one PR on the verified
  head;
* a session already holding a false `pushedHead` is repaired;
* publishing is idempotent;
* a PR is never requested for a missing branch.

The fake GitHub API in the harness now answers like GitHub: 422 for a missing
head branch, and `GET /branches/:name`.

## Resuming session bb02c85e after deployment

1. Give the Coding Agent credential **Contents: write** and **Pull requests:
   write** on `FahadTrail/fahad-office-python-acceptance`.
2. Resume the session. Its stored `pushedHead` is false, so the controller
   logs the stale-state warning, pushes `659573e` for real, verifies the
   branch and opens one PR. It does not edit or test anything again.

## Production verification (2026-10-28, after deploy `bcdb95a`)

| Check | Evidence |
| --- | --- |
| Deploy | Run 40756500097 success; "DEPLOYMENT SUCCESSFUL — now running commit bcdb95a; container healthy"; `coding_workers.office` healthy at 19:44:50 |
| Resume | 19:45:07 "Resumed from checkpoint 18 (blocked) by worker cee720b58c50:1" |
| Stale state reported | 19:45:13 warning "The recorded push of 659573e was not on GitHub (stale session state); publishing it now." |
| Real push | new `git.push` execution 19:45:09; `git ls-remote` shows the work branch at `659573e19f8e…` |
| One PR | "Opened pull request #1"; only `refs/pull/1` exists |
| CI | "CI passed on 659573e (1 checks)"; session `completed` 19:45:52, $0 |
| No redone work | after 19:40 only `git.push`, `github.pr_create`, `github.ci_status` ×2; `repo.write` 1 and `repo.edit` 1 in total, both from 17:47 |
