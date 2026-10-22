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

* Job status: the derived lifecycle wins; an unknown stored status is shown as-is.
* Progress: delivered units / assigned units from the real task graph. A unit is one employee workstream or development task. An open revision is not delivered. Skipped counts as delivered. With no units there is no bar, only a phase.
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
| Live updates | `/api/stream` + polling | Same stream; 30 s safety poll on Office, 5 s on open jobs | Same | Live indicator in screenshots |
| Needs Fahad | Sidebar count, `#/attention` | Office notice, top-bar pill, Settings › Approvals | Same approve/reject RPC | Browser flow; axe |
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

* `node --test`: 777 tests, 776 pass. One failure, `test/platform-foundation.test.js:52`, also fails on `main` at `e09e23d`. It is date-dependent and not in the UI.
* `test/premium-redesign.test.js` (new, 14 tests): presentation rules, shell structure, API usage and write paths, token-only CSS, and the preview's real handlers.
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
* Office progress loads `/api/workflows/:id` per active objective, capped at 12. That is fine for today's volume; a batch endpoint would be a backend change.
