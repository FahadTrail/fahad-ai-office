# UI implementation handover

This is the technical handoff for a later visual redesign. It does not choose pages, colour, type, layout or a replacement for the 3D Office.

The redesign should render the work platform API (`docs/platform-api.md`, contract `fahad-work-platform/1`) instead of reconstructing lifecycle, workload or results from events.

## What exists today

The app is server-rendered JavaScript. There is no React or Next.js app. `src/hub-server.js` serves:

| URL | Role |
| --- | --- |
| `/` | Workspace V2 (`src/hub-ui/index.html`, `src/hub-ui/app.js`) |
| `/classic` | The original single-page Hub chat |
| `/ui/*` | Hashed scripts, styles and fonts |
| `/ui/office-assets/*` | Streamed 3D assets |
| `/healthz` | Runtime version |
| `/api/*` | Owner-gated JSON and SSE |

Workspace V2 navigation is a hash router in `src/hub-ui/app.js`. The sections and what they are for:

| Hash | Purpose |
| --- | --- |
| `#/` `#/home` | Owner home: live objectives, coding now, needs you, results, capacity, team |
| `#/chief` `#/chat/:id` `#/chats` `#/talk/:slug` | CHIEF and direct employee conversations |
| `#/work` `#/new-work` `#/job/:id` `#/workflow/:id` | Objectives and the CHIEF workflow |
| `#/tasks/:filter` `#/task/:id` `#/code` | Coding Agent sessions |
| `#/attention` | Owner attention |
| `#/projects` `#/project/:id` `#/project/:id/deliverables` `#/deliverables` | Projects and the deliverables center |
| `#/office` `#/agent/:slug` `#/employees` | Live Office, including the 3D scene, and employee pages |
| `#/artifacts` `#/artifacts/:type` | Artifact library |
| `#/continuity` | Continuity Supervisor |
| `#/models` | Capacity and cost |
| `#/integrations` | Connector evidence |
| `#/settings` | Theme, language and preferences |

`#/office` lazy-loads `src/hub-ui/office.js`, which loads the 3D scene from `src/hub-ui/office3d/`. Live Operations (`src/hub-ui/office-ops.js`) reads `GET /api/operations`.

## Backend contracts the new UI should use

Prefer `/api/work/*` (`src/hub-platform.js`). The domain selectors live in `src/domain/` and are pure: they do not write rows.

| Need | Selector | Route |
| --- | --- | --- |
| Current work | `currentWork` | `GET /api/work/current` |
| History | `objectiveSummary` | `GET /api/work/history` |
| One objective and its next action | `objectiveSummary`, `orchestrationOf`, `nextActionOf` | `GET /api/work/objectives/:id` |
| Employee workload | `employeeWorkloads` | `GET /api/work/employees` |
| Project container | `projectSummary`, `recommendProject` | `GET /api/work/projects` |
| Results | `resultSummary`, `resultDetail` | `GET /api/work/results` |
| Conversations | `conversationSummary` | `GET /api/work/conversations` |
| Coding sessions | `sessionLifecycle` | `GET /api/work/sessions` |
| Owner attention | `attentionItems` | `GET /api/work/attention` |
| Execution workers | `workerBoard` | `GET /api/work/workers` |
| Technical tier | `costSummary`, `continuitySummary` | `GET /api/work/diagnostics` |
| Live updates | `WorkStream` | `GET /api/work/stream` |

Existing routes stay. `/api/operations`, `/api/office`, `/api/deliverables`, `/api/coding`, `/api/continuity`, `/api/attention` and `/api/stream` still feed the current pages.

## Reusable entities

Keep these distinct. Do not merge them into one table or one screen model.

* **Project** — persistent container (`projects`). Archiving a project is `projects.status = archived`. Finishing an objective does not archive the project.
* **Conversation** — a thread (`conversations`). Owner messages are jobs linked by `conversation_id`.
* **Objective** — a job (`jobs`). CHIEF plans, delegates and synthesizes it.
* **Task** — one employee's unit of work (`tasks`), with dependencies.
* **Result** — a deliverable row (`results`) plus artifacts and files.
* **Coding session** — `agent_sessions`, linked to one job and one task.
* **Office employee** — the nine active roster entries in `src/office/agents.js`.
* **Execution worker** — `coding_workers` (Office runtime, Claude Code, Codex, OpenCode, Gemini CLI, Antigravity, Kilo, Freebuff). Never an Office employee.

## Current versus history

| Rule | Behaviour |
| --- | --- |
| Open job statuses | `planning`, `running`, `waiting_approval`, `blocked`, `review` |
| Terminal job statuses | `completed`, `failed`, `cancelled` → lane `HISTORY` |
| Current objective | Newest real `ACTIVE`, else `NEEDS_OWNER`, else `WAITING`. Never a completed job |
| Empty office | `active: []`, `current: null`. Recent results stay on the results route |
| Employee | `AVAILABLE` when no current task. Completed tasks are `completedWork` |
| New assignment | Classified from its own task and its own job |
| Capacity wait | `WAITING`, not owner attention |
| Failed job | Stays `FAILED`. A still-pending approval is `OWNER_REVIEW` |
| Historical test | Hidden from current work, normal results and owner attention. Still in history, labelled `TEST` |
| Live test | Returned only as `activeTests`, with `classification.identified` |

`officeVisible` in `src/hub-office.js` still shows active work in the current Office and hides historical tests. `objectiveIndex` in `src/hub-office-ops.js` is unchanged: the current Live Operations page may still fall back to a recent completed objective. The new current-work API does not.

## Navigation dependencies

The current client stores `hub-workspace-id`, theme and language in `localStorage`. `defaultProject` in `src/hub-ui/owner-facts.js` refuses a saved test or certification project. `GET /api/work/projects` returns the same choice as `defaultProjectId`. A new shell should use that field.

Hash routes above are presentation. Replacing them does not require a data migration. Deep links that the current UI shares (`#/chat/:id`, `#/workflow/:id`, `#/task/:id`, `#/project/:id`) should keep working or be redirected until Fahad retires them.

Live updates: the current UI listens to `/api/stream` and refetches. A new UI should listen to `/api/work/stream` and refetch `/api/work/current` and `/api/work/attention` on `change` or `catchup`.

## Conversations and Coding sessions

A conversation detail returns owner messages (the job goal), office replies (the summary section or stored summary — missing stays `MISSING`) and coding references as separate messages with `sessionId`. The session itself is loaded from `/api/work/sessions/:id`. Approvals stay on the session or the attention list.

Creating a conversation is still `POST /api/conversations` (`src/hub-workspace.js`). Creating a coding session is still the Coding API (`src/hub-coding.js`). This foundation does not add a new write path.

## 3D Office boundary

Do not rebuild or remove `src/hub-ui/office3d/` as part of a backend change. The scene reads `/api/office`, `/api/timeline` and `/api/artifacts`. Those routes are still the integration edge. A future scene can subscribe to `/api/work/stream` and read `/api/work/current` plus `/api/work/employees`, but the current scene should keep working until that replacement is designed.

`src/hub-ui/office3d/` is presentation. Business rules do not live there.

## Safe to replace

* Markup, CSS and client rendering in `src/hub-ui/` except where a file is the only caller of a write API.
* Which hash routes exist, once redirects cover the links above.
* The Live Operations board (`office-ops.js`) once it reads `/api/work` instead of treating a recent completed job as current.
* Executive copy. Do not recompute finance totals, verification or lifecycle in the client.

## Do not remove

* `src/workflow.js`, `src/chief.js`, `src/research.js` and `src/office/finance.js` — execution, checkpoints, retries, fact gate and deterministic arithmetic.
* Coding controller, leases, approvals and owner replies (`src/coding-agent/`, `reply_agent_session`).
* Continuity Supervisor execution (`src/continuity/`). The summary API does not enable workers or change leases, handoffs or stop verification.
* Workspace policy, budget, model routing and Tool Broker.
* Auth, RLS and service-role boundaries.
* The 3D asset pipeline until a replacement scene is approved.
* Historical rows. Test cleanup is preview-only.

## Database

`supabase/migrations/20261009160000_platform_work_indexes.sql` adds two partial indexes so current-work and history queries stay on `(project_id, status, time)` as history grows. No columns, policies or functions changed. It is not applied to production.

## Remaining debt

* Live Operations `objectiveIndex` still selects a recent completed objective when nothing is active. The new API does not. Point that page at `/api/work/current` during the redesign.
* `isTestObjective` now includes the explicit 2026-10-09 registry as well as the title pattern. Jobs created after that audit are tests only when the title matches, until a newer explicit list is added.
* Employee lifetime completed counts are `UNKNOWN` on purpose. Do not display them as zero.
* Continuity task rows from the Phase 1 proof of concept are not linked by `job_id`. The cleanup preview reports that count as `UNKNOWN`.
* The current home still shows stored `jobs.progress`. The new summary exposes that integer as `RECORDED` and does not derive a new percentage. A redesign should not draw a bar the API did not report.
* Production test deletion has not been run. The preview is `ops/cleanup/platform-foundation-cleanup-preview.sql` and `GET /api/work/cleanup-preview`.
* No production database was read for this change. Classification of the 82 ids is the audited explicit list, not a fresh production recount.

## Release

Do not merge or deploy until Fahad authorizes it. Applying the index migration is a production change and needs the same approval.
