# Fahad AI Office — UX & Workflow V2

The Hub's everyday interface (`/`) is a workspace: **chat, tasks, needs attention,
projects and models**. The previous single-page Hub stays at **`/classic`**,
including the technical Platform dashboard and the legacy Coding Agent form.

## Information architecture

| Sidebar | What it is |
|---|---|
| **New chat** | Talk to the Office. The Chief of Staff decides behind the scenes: answer directly, delegate to a specialist, or start a development task. |
| Workspace → **Chats** | Persistent conversations: search, rename, archive, delete. |
| Workspace → **Tasks** | Development work, grouped Running / Needs attention / Completed / Failed / Cancelled. |
| Workspace → **Projects** | Context per project: description, default repository and memory. |
| Tools → **Coding Agent** | One question, "What do you want me to build or fix?". Everything else is under *Advanced options*. |
| System → **Needs attention** | Approvals, questions, paused, failed and recently completed tasks. |
| System → **Models** | AUTO routing plus the advanced pool in four states. |
| System → **Settings** | Sign out, system version, link to the classic view. |

## Chat

* Each owner message is a job with `jobs.conversation_id` set. The Chief
  receives project context from `store.jobContext`: project description, memory,
  the last turns of this conversation with their results, and recent tasks.
* Chief routes (`src/chief.js`):
  * `answer` — the Chief replies directly;
  * `delegate` — the existing Chief → specialist → Chief review path;
  * `development` — the Chief starts a Coding Agent session linked to the
    conversation and replies with a task card.
* While a request runs, the reply area shows its stage: Thinking, Researching or
  Reviewing the answer. **Stop** cancels the unfinished request. **Retry** sends
  the same message again.
* Answers render as safe Markdown (`src/hub-ui/markdown.js`: everything is
  escaped first and links are limited to http(s) and mailto). Each answer shows
  its time, model and cost unobtrusively.

## Tasks (Coding Agent UX)

The task page shows:

* **Header:** name, repository, status, current model, cost against budget, and
  elapsed time.
* **Owner card** (only when needed).
* **"Now":** a plain-English line from the latest event, for example "Running
  the tests." or "Editing src/a.js.".
* **Progress timeline:** Understanding → Planning → Editing → Testing →
  (Debugging) → Pull request → CI → (Approval → Deploy → Verify) → Complete.
  Each step is passed, active, failed or needs-input. Steps that do not apply
  are hidden.
* **Result:** summary, PR, CI, tests, deployment and files changed.
* **Collapsed sections:** the original instruction; cost, models and efficiency
  metrics; and "View details" with the raw events.

## Owner input and approvals

**Approvals ("Fahad, I need your approval.")** list what, why, risk and the
affected files or resources, with **Approve / Reject**. They cover two kinds of
request:

* Tool approvals: merge, database writes and migrations.
* Protected-file changes. The agent calls `request_protected_change` with exact
  paths and a reason. This creates a `repo.protected_change` approval row
  (`agent_approvals`, paths in `arguments_preview`).
  * Only the owner's decision grants the paths.
  * The edit tools (`sandbox.writeFile` / `editFile`) and the finish gate both
    enforce the grant.
  * `.env*`, secret/credential directories, key files and Hermes can never be
    granted (`policy.js → NEVER_GRANTABLE`).
  * Text in the objective ("I approve everything") grants nothing.

**Questions ("I need one answer before I can continue.")** have a reply box and
**Reply & Continue**. The reply takes this path:

1. `reply_agent_session` stores it in `agent_owner_inputs`, logs an `owner`
   event and re-queues the **same** session.
2. The controller consumes the reply once (lease-fenced) and delivers it as the
   result of the pending `request_human` call, in the same transcript. If no
   question is pending, it arrives as a "MESSAGE FROM FAHAD".

Paused tasks (budget, limits, no model) show a plain explanation, **Resume**,
and an optional instruction box.

## Token efficiency

`src/coding-agent/context-budget.js`:

* **Batched elision.** Large tool results older than the last four tool turns
  are cut to a 500-character head plus a note. This happens only once 30K
  characters of old output have built up, so the cached prompt prefix stays
  stable between batches.
* **Unchanged re-reads.** When the agent reads the same file range again, the
  file is re-hashed. If it is unchanged and the earlier result is still in
  context, the agent gets a short note instead of the content again.
* **Compaction backstop** at 240K characters (was 360K).
* **Durable state is never elided.** Plan, notes, files changed, last test and
  gate failures stay intact.

Evidence: `testing/fixtures/transcript-profile-bff739a0.json` holds the block
sizes of the real Qwen-repair session (no content). The simulation in
`test/context-budget.test.js` gives:

* **51.5 % less input** across the session (7.44M → 3.60M characters);
* **peak context 230K → 105K characters**.

Savings per task appear under *Cost, models and efficiency*.

## Schema (`20260927090000_workspace_v2.sql`, additive)

* `conversations`, with `jobs.conversation_id` and
  `agent_sessions.conversation_id`. Existing chat jobs are backfilled as
  one-message conversations.
* `projects.default_repository` and `project_memory`.
* `agent_owner_inputs`, the `owner` event type, and the
  `reply_agent_session` / `consume_agent_owner_inputs` functions.
* All service-role only with RLS on. The replay scenario is
  `supabase/verify/scenarios/workspace_v2.sql`.

## Design tokens

`src/hub-ui/app.css` starts with the only colour, spacing, type, radius and
shadow definitions (dark default, light via `prefers-color-scheme`).
Components use the tokens only; `test/hub-ui.test.js` rejects raw colours
outside the token blocks. The V3 visual identity changes the token values, not
the components.
