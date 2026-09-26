# Coding Agent: why a protected-file approval cannot be granted (2026-09-26)

Status: **documented, not yet fixed**. The fix belongs to the UX & Workflow V2
phase. Observed in sessions `bff739a0` and `99bf6998`, the Qwen `sk-ws-` key
fix. Both agents correctly found that `ops/set-secret.sh` had to change,
stopped with `HUMAN_INPUT_REQUIRED`, and could not continue. The owner had no
way to grant the permission.

## Two different "approval" mechanisms

1. **Tool approvals (working).** A catalog tool whose workspace grant is
   `decision = approval` (merge, Supabase writes, migrations) goes through the
   Tool Broker. The broker answers `APPROVAL_REQUIRED` and the controller
   inserts an `agent_approvals` row (`controller.js → invoke()`); the session
   becomes `awaiting_approval`. The Hub lists the row with **Approve / Reject**
   (`/api/approvals/:id`), and the resumed session replays the exact call.
2. **Protected paths (no approval path).** Protected files (`ops/`,
   `.github/workflows/`, `supabase/migrations/`, `Dockerfile`, compose, key
   files; `policy.js → PROTECTED_CHANGE_PATTERNS`) are refused inside the
   sandbox. Nothing ever creates an approval for them.

## Root cause (four compounding gaps)

1. **The write tools can never write a protected path.**
   * `tools.js` calls `sandbox.writeFile(path, content)` and
     `sandbox.editFile(…)` without `allowProtected`.
   * `assertWritablePath` therefore always throws `PROTECTED_PATH`, whatever the
     session configuration says.
   * The session flag `allowProtectedPaths` (`controller.js →
     normalizeConfig`) is only read by the **finish gate**, which checks
     whether protected files *were* changed. It is never passed to the tools
     that would change them.
2. **No way to set the flag.**
   * `hub-coding.js → validateSessionInput` has no field for
     `allowProtectedPaths`, and neither does the Hub form.
   * It could only be set by writing the `agent_sessions.config` row directly.
   * It is also a boolean for *all* protected paths, which is far too broad.
3. **`request_human` is a dead end.**
   * The agent's only escalation is the `request_human` tool. It throws
     `Stop('blocked', …, HUMAN_INPUT_REQUIRED)`.
   * It creates **no `agent_approvals` row**, so the Hub shows no Approve
     button, only the text in the event feed.
   * The session's only actions are **Cancel** and **Resume**. Resume
     (`resume_agent_session`) just re-queues the session with no answer and no
     grant, so the agent hits the same wall again.
4. **Approval text in the objective is (correctly) not a grant.**
   * Session `99bf6998` said "I explicitly APPROVE modification of
     `ops/set-secret.sh`" in the objective.
   * Prompt text is model input, not an authenticated owner decision.
     Honouring it would let any task text unlock protected files. The agent
     rightly refused to route around the guard with `shell.run`.

In short, protected-path approval was designed as a pre-granted session setting
(`allowProtectedPaths`). That setting has no UI and is not wired to the write
tools. The runtime "ask the owner" path produces a blocked state that cannot
carry an answer or a grant back.

## Recommended architecture (for V2)

Make protected-path changes a first-class, **path-scoped approval**, using the
same machinery that already works for tool approvals:

1. **Request.**
   * Add a controller tool `request_protected_change({ paths, reason, summary })`
     (or extend `request_human` with `kind: 'protected_paths'`).
   * It validates each path against `PROTECTED_CHANGE_PATTERNS` and refuses
     paths that can never be granted: Hermes, `.env*`, key files, secrets
     directories.
   * It inserts an `agent_approvals` row (`tool_name =
     'repo.protected_change'`, payload = exact paths, reason, and the diff
     preview once available), and sets the session to `awaiting_approval`.
2. **Decide.**
   * The Hub shows the row next to existing approvals: exact paths, the reason
     and **Approve / Reject**.
   * The decision is authenticated (owner session), audited, and stored on the
     approval row.
3. **Grant.**
   * On approval the session gets a **path-scoped grant**, for example
     `config.protectedPathGrants = [{ path, approvalId, grantedAt }]`, replacing
     the boolean. Only the approval API can write it; the model and the task
     text cannot.
4. **Enforce.**
   * `repo.write` / `repo.edit` pass `allowProtected` only when the normalized
     path is in the grant list.
   * The finish gate checks that changed protected paths ⊆ granted paths.
   * The PR body lists the granted paths and approval ids.
   * The merge approval still applies separately. Deployment scripts under
     `ops/` still only reach the server through an owner-run root script.
5. **Answer channel.**
   * Replace bare **Resume** for `HUMAN_INPUT_REQUIRED` with **Reply & resume**.
   * The owner's text answer is stored as an owner event and appended to the
     transcript as an owner message, so questions that are not about
     permissions can be answered too.
6. **Tests.**
   * Unapproved paths stay refused.
   * An approval grants exactly the listed paths.
   * A rejected request blocks with a clear reason.
   * Objective text never grants anything.
   * Hermes and `.env` are never grantable.
