# Live Operations (2026-10-09)

Live Operations is the Office's command layer for one objective, under the 3D Office (and in the simplified Office). It answers these questions at any moment:
* what is happening;
* who is doing it;
* what has finished;
* who waits and why;
* what was delivered;
* what CHIEF does next;
* whether Fahad must act.

## Data — `GET /api/operations?workspaceId=…[&jobId=…]`

`src/hub-office-ops.js` (`operationsView`) is pure. It reads only these rows:
* the job and its tasks;
* handoffs, results and artifacts;
* the event log;
* `model_attempts`;
* approvals and Coding Agent sessions.

It invents nothing:
* Progress is "n of m workstreams", never a made-up percentage.
* A state needs a row.
* A handoff needs a record.

| Part | Source |
| --- | --- |
| Objective | `jobs`, task counts, spend from `model_attempts` |
| CHIEF command and delegation tree | `chief_plan`, `specialist` and `synthesis` tasks and their `depends_on`; a superseded synthesis round is CHIEF's review |
| Agent cards | the employee's current task, the first `agent_started` event (start time), the latest attempt (model, free/paid), wait and block reasons |
| Now working | `running` tasks only; the live model comes from the `started` attempt row |
| Pipeline | Plan → Assigned → Running → Delivered → Review → Revision → Final |
| Revision rounds | `revision_requested` events and the revision tasks |
| Handoff center | `handoffs`, with from/to tasks, what was handed over, status and result |
| Timeline | the event log in readable words; checkpoints, stage starts and route records are technical detail |
| Deliverables | artifacts (with VERIFIED / NEEDS REVIEW from code validation) and outputs; FINAL SYNTHESIS is separate |
| Needs Fahad | pending approvals and questions only; an internal wait never appears here |
| Capacity | `not_before` and `wait_info`: routes cooling down, paid fallback, next retry, auto-resume |

The **current objective** is the newest active real objective. If none is active, it is the most recent completed real one. Historical test, demo, certification, smoke or benchmark objectives never become current. They are also hidden from the normal Office views by `officeVisible`. A labelled test that is running right now is genuine activity, so it is shown and flagged.

## Interface — `src/hub-ui/office-ops.js`

The interface is Arabic-first with English. Model and provider names stay in Latin script, left-to-right.

Each update rides the shared SSE stream (`/api/stream`), plus the Office's 30-second safety refresh. Elapsed times tick locally, and the board never polls.

Connections to the 3D Office:
* An agent card focuses that agent's desk.
* CHIEF opens the CHIEF panel with the command view.
* A Handoff Center entry lights the real route on the floor and opens its details in the side sheet.
* A floor handoff opens the same details.
* A department view filters the board.
* The overview shows a compact objective strip.

On small screens the order is Objective → Working now → Needs Fahad → Timeline → Deliverables.

## Fixes shipped with it

* **Finance.** Totals are exact, and schedules use largest-remainder cents, so AED 13,000 stays AED 13,000. A costs-only model may state "revenue 0" and "net = −costs". Lines can be annual or weekly.
* **Version.** `/healthz` and `runtime_started` report the deployed commit. The runtime no longer trusts a `deployed-sha` file older than itself.
* **Coding worker.** It writes a heartbeat to `coding_workers.office`. Its status is DISABLED, UNKNOWN, OFFLINE, BLOCKED, ACTIVE or IDLE, from measured facts only.
* **Gateway.** Attempt outcomes keep their real start time.

QA: `node --test`; `test/live-operations.test.js` replays the real production acceptance objective of 2026-10-09.
