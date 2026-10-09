# Work platform API

Additive read API for a future interface. The current Hub pages keep their existing routes. Nothing under `/api/work` writes workflow state or deletes rows.

Contract id: `fahad-work-platform/1`.

## Authorization

Every `/api/work` route sits behind the same Hub owner gate as the rest of `/api/*` (`HUB_ACCESS_TOKEN` or the owner OTP session). Handlers do not accept a caller role. A row whose project is not the requested workspace is `404`, not a cross-project payload.

The work handler matches `/api/work` and `/api/work/` only. `/api/workspaces` and `/api/workflows` stay on their existing handlers.

Reads are idempotent. Repeating a GET does not change jobs, tasks, sessions or approvals.

## Tiers

Pass `tier=executive` (default on lists and project detail), `tier=operational` (default on one objective) or `tier=technical`.

| Tier | What it is for |
| --- | --- |
| executive | Current objective, owner decisions, useful results |
| operational | Assignments, dependencies, revisions, next action |
| technical | Attempts, events, token and cost detail |

Technical fields are omitted until that tier is requested.

## Lifecycle

Derived. Stored statuses are not rewritten.

| Category | Meaning |
| --- | --- |
| `ACTIVE` | Executing, or scheduled with nothing blocking it |
| `WAITING` | Dependency or model capacity. Not an owner approval |
| `NEEDS_OWNER` | A real approval, question or blocked session Fahad must act on |
| `COMPLETED` | Finished. Deliverables stay linked |
| `FAILED` | Stopped unsuccessfully. Reason is recorded or `UNKNOWN` |
| `CANCELLED` | Deliberately stopped |
| `HISTORY` | Lane for every terminal category |

A completed objective is never promoted to `current`. An empty office returns `empty: true`, `active: []` and `current: null`.

## Pagination and search

`limit` defaults to 30 and caps at 100. `cursor` is the opaque id of the last row. An unknown cursor is `400 INVALID_CURSOR`. `q` is a case-insensitive substring over titles, goals and summaries. `hasMore` and `nextCursor` travel with the page.

## Routes

| Method and path | Response |
| --- | --- |
| `GET /api/work` | Contract index |
| `GET /api/work/current?workspaceId=` | `{ empty, current, active, waiting, needsOwner, activeTests, counts }` |
| `GET /api/work/history?workspaceId=&category=&q=&limit=&cursor=` | Terminal objectives, tests included and labelled |
| `GET /api/work/objectives/:id?workspaceId=&tier=` | Objective summary. `404` outside the workspace |
| `GET /api/work/employees?workspaceId=&scope=` | One record per Office employee. `scope=owner` includes every project |
| `GET /api/work/employees/:slug?workspaceId=` | That employee's current tasks, workload and recent completed work |
| `GET /api/work/projects?savedId=&includeArchived=` | Project list and `defaultProjectId` |
| `GET /api/work/projects/:id?tier=` | Overview, active objectives, attention, results, history, costs, conversations, sessions |
| `GET /api/work/results?workspaceId=&q=&includeTests=` | Executive result summaries. Tests hidden unless `includeTests=1` |
| `GET /api/work/results/:id?workspaceId=&view=` | `view=summary` (default), `full` or `technical` |
| `GET /api/work/conversations?workspaceId=&q=&includeArchived=` | Thread index. Messages stay on the detail route |
| `GET /api/work/conversations/:id?workspaceId=` | Chronological messages, linked objective ids, linked session ids, live state, approvals |
| `GET /api/work/sessions?workspaceId=&scope=current\|history` | Coding sessions. Terminal sessions report `working: false` |
| `GET /api/work/sessions/:id?workspaceId=` | One session, its objective and task ids, pending approvals |
| `GET /api/work/attention?workspaceId=` | Owner items only. Capacity waits are absent |
| `GET /api/work/workers` | Execution workers. `countsAsEmployee` is always false |
| `GET /api/work/diagnostics?workspaceId=&section=` | `summary`, `costs`, `continuity` or `workers` |
| `GET /api/work/cleanup-preview` | Explicit-id preview. `executed` is false. SQL ends in `rollback` |
| `GET /api/work/stream?workspaceId=` | SSE. `ready`, `change`, and `catchup` when `Last-Event-ID` is behind |

`current` on an objective is `{ id, title, lifecycle }` or `null`. It is never a completed job.

Employee `availability` is `AVAILABLE`, `ASSIGNED`, `WAITING`, `NEEDS_OWNER` or `BUSY`, from current tasks only. `completedWork.lifetime` is `UNKNOWN` (the recent window is not a lifetime total). `progress` on an objective is the stored integer with basis `RECORDED`, or `null` / `NOT_REPORTED`. The API does not invent a percentage from task counts.

Result `summaryStatus` is `PRESENT` or `MISSING`. A missing summary is null. `verification.status` is `UNKNOWN` with basis `UNMEASURED` unless an audit report or financial model recorded a verdict.

Spend is `UNKNOWN` when attempts were not loaded. A zero-cost attempt is not labelled free unless its route carries a billing class (or the model name is an explicit `:free` model).

## Streaming

`/api/stream` is unchanged. `/api/work/stream` sends `retry: 5000`, an event id, and `refetch` paths. On reconnect, a stale `Last-Event-ID` produces `event: catchup` with `missed: true`. The client refetches `/api/work/current`. The stream does not replay the event log.

## Cleanup

`GET /api/work/cleanup-preview` classifies the explicit ids in `src/domain/work-registry.js` (the same 82 ids as `ops/cleanup/2026-10-09-test-data-selection.sql`). A job outside that set, or a title that is not a confirmed or heuristic test, blocks the preview. A conversation shared with a real job is kept. No delete statement is issued.

The operator script `ops/cleanup/platform-foundation-cleanup-preview.sql` only counts and rolls back. Do not run a production deletion without Fahad's approval.
