# Office premium redesign V2.0 (frontend only)

Branch `feat/office-premium-redesign`, from `main` at `e09e23d`. Not merged, not deployed. No backend, schema, migration, prompt, routing, budget, permission or runtime change.

## What changed

Four primary screens in a new shell: a sticky translucent top bar (ف, مكتب فهد / AI Office, المكتب, الأرشيف, Settings gear). Phones get a bottom tab bar instead.

| Screen | Hash | File | Data (existing APIs only) |
| --- | --- | --- | --- |
| المكتب — Office | `#/` | `src/hub-ui/screens.js` `renderOfficeHome` | `/api/work/current`, `/api/workflows/:id`, `/api/attention`, `/api/office`, `/api/tasks`; submit is `POST /api/conversations` |
| المهمة — Job Detail | `#/job/:id` (also `#/workflow/:id`) | `renderJobDetail` | `/api/workflows/:id`, `/api/work/objectives/:id` (operational; technical on demand), `/api/conversations/:id`; Reply & Continue is `POST /api/conversations/:id/messages`, Stop is `.../stop` |
| الأرشيف — Archive | `#/archive` | `renderArchive` | `/api/work/history` (status and text search server-side, cursor paging); date, employee and test filters client-side |
| الإعدادات — Settings | `#/settings/:section` | `src/hub-ui/app.js` `renderSettingsSection` | Each section is the existing page rendered into the panel |

Settings sections: Team (`renderEmployees`), Approvals (`renderAttention`), Models & providers (`renderModels`), Coding workers (`renderTasks` plus `/api/work/workers`), Tools & permissions (`renderIntegrations`), Health & logs (split from the old Settings page), Language & appearance (split from the old Settings page).

Presentation rules are pure and unit-tested in `src/hub-ui/office-model.js` (`test/premium-redesign.test.js`):

* Job status: the derived lifecycle wins; an unknown stored status is shown as-is. A stored `blocked` alone reads متوقف (Blocked), not "Needs your decision": the backend classifies it as `WAITING` unless a real approval or question exists (`src/domain/lifecycle.js`). Only `NEEDS_OWNER` or `waiting_approval` reads بانتظار قرارك.
* Progress: X/Y is delivered assignments out of assigned assignments, and the label says "assignments" (تكليفات). A unit is one workstream or development task, so an employee with two assignments counts twice.
* Revisions: each revision depends on the task it revises (`src/workflow.js` `requestRevisions`), so it replaces that one assignment's state. An open revision is "in revision", a failed one is failed, and a finished one is delivered. A revision without that link is attached only when the employee has exactly one assignment; otherwise it is left out and counted as `untrackedRevisions`. Skipped tasks count as delivered. With no units there is no bar, only a phase. The synthesis stage is done only when every synthesis task is done, so a revision round's final synthesis is still pending.
* Coding sessions outside an objective (from `/api/work/sessions?scope=current`) are "needs you" only for a real approval or question. A plain `blocked` session may be a capacity wait, so it reads متوقف.
* Employee state from `/api/office`: idle is متاح. CHIEF active is ينسّق, others يعمل. A recent delivery is سلّم.

Design tokens: `src/hub-ui/app.css` holds the new palette for light and dark, the employee colours (`--emp-*`, UI-only, keyed by slug) and the materials. Every existing page picks the palette up through the same variable names. The shell and screen styles are in `src/hub-ui/premium.css`. JetBrains Mono is self-hosted (OFL-1.1; decision added to `legal/license-decisions.json`). Icons are inline Lucide paths (ISC).

## Feature preservation

| Capability | Before | After | Preserved | Verified by |
| --- | --- | --- | --- | --- |
| Goal to CHIEF | Home / `#/chief` | Office command; `#/chief` kept | Same `POST /api/conversations` | Browser flow: real job row, opens its detail |
| Multi-turn, Reply & Continue | `#/chat/:id` | Job Detail follow-up; chat kept | Same `.../messages` | Browser flow: same conversation, thread shows both turns |
| Stop running work | Chat Stop | Job Detail Stop (confirm); chat kept | Same `.../stop` | Code review |
| Delegation, handoffs, revisions, consults | `#/workflow/:id` | Job Detail tabs + تفاصيل التنفيذ | Same `/api/workflows/:id` | Browser flow, screenshots |
| CHIEF final synthesis | Workflow page | Highlighted card; copy and `.md` download | Same `final` result | Unit test, screenshots |
| Employee deliverables and artifacts | Workflow outputs | Per-employee tabs, type chips, inline artifacts (`renderArtifact`) | Same | Screenshots |
| Live updates | `/api/stream` + polling | Same stream, one load at a time, no polling while the tab is hidden. Safety poll every 2 min with a live stream, otherwise every 30 s (Office) or 8 s (open job); none once a job is terminal | Same | Request counts below |
| Needs Fahad | Sidebar count, `#/attention` | Office notice ("بانتظارك — N أمور تحتاج قرارك", the same count as the Approvals page), top-bar pill, Settings › Approvals | Same approve/reject RPC | Browser flow; axe |
| Coding Agent | `#/code`, `#/tasks`, `#/task/:id` | Same pages; Settings › Coding workers; coding sessions on Office | Same | Legacy screenshots |
| Models, providers, budget, capacity | `#/models`, Settings | Settings › Models & providers, Health & logs | Same | Screenshots |
| Tool permissions and integrations | `#/integrations` | Settings › Tools & permissions | Same | Screenshots |
| Health, continuity, Live Operations | Settings, `#/continuity`, `#/office` | Settings › Health & logs links to each; pages kept | Same | Legacy screenshots |
| Projects, deliverables, chats, artifacts, 3D Office | Sidebar | "All sections" menu (⋯) | Unchanged pages | Legacy screenshots, no console errors |
| Project selection | Sidebar select | ⋯ menu and Office command options | Same `hub-workspace-id` | Code review |
| Search (⌘K) | Sidebar | Top-bar search icon, ⌘K and `/` | Same | Code review |
| Theme and language | Settings | Settings › Language & appearance (تلقائي / فاتح / داكن) | Same keys | Browser flow: persists over reload; RTL↔LTR |
| Owner-only access, OTP sign-in | Login | Unchanged login markup and flow | Same | `hub-ui.test.js` |
| Emergency Pause All | Not implemented in the Hub | — | Nothing to preserve | `grep` of `src/hub-ui` |

Old hashes redirect to their new home: `#/attention`, `#/models`, `#/employees`, `#/integrations` and `#/tasks/:tab` open the matching Settings section. `#/workflow/:id` opens Job Detail. The 3D Office source (`src/hub-ui/office3d/`) is untouched and still reachable at `#/office`.

## Verification

* `node --test`: 784 of 784 pass. `test/platform-foundation.test.js` line 52 used to fail on `main` too (at `e09e23d`). Its fixture time is 2026-10-09 12:00 UTC, but `objectiveIndex()` in `src/hub-office-ops.js` measures its 7-day "recent" window from the real clock, so the test began failing on 2026-10-16. With Fahad's approval, the test now passes that fixture time as `now`. This is a test-only, one-line change; no production code changed.
* Request load on the Office (preview, live stream connected), measured against the first push of this branch:
  * Initial load: 12 → 8 requests.
  * 45 s idle: 6 → 0.
  * After one task completes: one refresh, and only that job's `/api/workflows/:id`; the card moves 3/8 → 4/8.
  * The top bar refresh is 1 request (was 5), debounced to once per second of stream events.
  * Workflow graphs are refetched only when an objective's summary changes, at most 4 at a time.
* `test/premium-redesign.test.js` (new, 21 tests) covers:
  * presentation rules, `blocked` vs owner attention, coding-session attention;
  * assignments, revisions and failed revisions;
  * the refresh scheduler (single flight, coalescing, hidden tab, live vs disconnected polling, stop) and the graph signature;
  * shell structure, API usage and write paths;
  * token-only CSS and the preview's real handlers.
* Browser flows on the local preview (`tools/hub-preview.mjs`, fictional data, real handlers): 18 of 18 checks pass with no page errors.
* axe-core 4.10.2 (WCAG 2.1 A/AA): 0 violations across 9 views × light/dark × desktop/mobile.
* Screenshots: `node tools/redesign-shots.mjs <dir> --edge` gives the 16 required shots plus 32 edge-case shots, with no console errors and no horizontal overflow. The contact sheets are in `docs/office-premium-redesign/`.
* Legacy pages (`tools/ui-screenshots.mjs`, 10 screens × 2 themes × 2 widths): no console errors.

Not verified: anything against production data or live providers. No billable runs and no production reads were made. Safari and Firefox rendering were not checked, and no real device was used (Chromium only).

## Limitations

* Arabic employee names are the Office's own Arabic nicknames (`src/office/agents.js`). Taglines mirror the roster migration. `/api/office` returns neither `name_ar` nor `tagline`, so they are UI copy, not read from `agents`.
* The assignment shown in a tab is the task title. The workflow API does not expose the full brief text.
* Archive date and employee filters apply to the rows already loaded. The summary line says so when more pages exist. The history API has no date or employee parameter.
* Archive rows show the goal as the outcome line. The executive history tier has no result summary.
* Some descriptive text from the backend (coding `now`, failure reasons, next action) is English in the Arabic UI. It is shown as recorded, not translated.
* Office progress loads `/api/workflows/:id` per active objective, capped at 12, cached, and refetched only on change. A batch endpoint would be a backend change.
* The Office notice and the top-bar count use the Approvals page's count (`/api/attention` `counts.action`). That count comes from `ownerAction()` in `src/hub-workspace.js`, which treats every `blocked` coding session as owner action, capacity waits included. The Office cards use the capacity-aware rule above; the count itself is a backend rule and is unchanged.
