# V4 — visual experience and product polish

V4 changes how the Office looks and feels. It does not rebuild the core. The
workflow, gateway, Tool Broker, security gates and database model are the same.
All V4 work lives in the Hub UI (`src/hub-ui/`) and in read-only Hub APIs.

## Design system (`src/hub-ui/app.css`)

* **Tokens only.** Colours, status colours (`--st-*`), motion (`--ease-*`,
  `--t-*`), radii, shadows, z-index, blur and floor tokens all live in the
  `:root` blocks.
  * Dark is the default.
  * Light applies under `prefers-color-scheme: light` unless the owner picked
    dark, or under `data-theme="light"`.
  * A test rejects raw hex colours outside the token blocks (`app.css`,
    `office.css`, `project.css`).
* **Typography.** Inter (Latin, variable) and IBM Plex Sans Arabic (400–700,
  Arabic subset) are self-hosted `woff2` files under OFL-1.1, recorded in
  `legal/license-decisions.json`. Numbers use tabular figures (`.num`).
* **Contrast.** Every text/background pair meets WCAG AA in both themes:
  axe-core reports 0 violations across 12 routes × 2 themes, down from 706.
  * `--accent-fill` is the button fill behind white text.
  * `--accent` is for links and text.
* **Motion.** Motion is calm and state-driven.
  * The attention pulse stops after 4 cycles.
  * `prefers-reduced-motion` removes motion.

## Live Office (`office.js`, `office.css`, `characters.js`) — lazy-loaded

* **Floor.** A 3×3 floor with CHIEF in the centre and 8 specialist stations.
  * Each station is an SVG workspace drawn by `characters.js`: a role-specific
    screen and an abstract seated figure.
  * Logic (`visualState`), asset (`stationArt`), animation (CSS) and UI
    (`renderOffice`) are kept separate.
* **Real states only.** AVAILABLE, THINKING, RESEARCHING, WORKING, DESIGNING,
  TESTING, WAITING (including WAITING FOR CAPACITY), REVIEWING, NEEDS FAHAD,
  BLOCKED, COMPLETED, FAILED. They are derived from tasks, sessions and
  approvals and are never invented.
* **Handoffs.** Handoffs are drawn as links between stations and can be
  clicked. Each shows FROM / TO / PROJECT / OBJECTIVE / ARTIFACT / STATUS /
  TIME (`handoffView` in `src/hub-office-live.js`).
* **Timeline.** The Office timeline has employee, status and project filters
  (`/api/timeline`).
* **Employee workspace.** Clicking an employee opens a drawer with the tabs
  Now, Artifacts, Handoffs, History, Conversations and Tools. The Tools tab
  shows evidence-based connector states.
* **Small screens.** Below 900 px the floor becomes a list of cards.

## CHIEF home, Command Center, map

* **`/` CHIEF home.** A greeting, Ask CHIEF, suggestions in Emirati Arabic,
  items that need Fahad, and live work.
* **Command Center** (`project.js`, lazy). Shows:
  * a status (NEEDS FAHAD / AT RISK / IN PROGRESS / UP TO DATE / NO ACTIVITY);
  * a progress ring;
  * the latest CHIEF synthesis, only from CHIEF-planned jobs;
  * KPIs;
  * the team roster with each person's current step and latest deliverable;
  * Needs Fahad, next actions, decisions and risks;
  * the timeline, handoffs and artifacts;
  * project memory, which can be edited and removed
    (`PATCH /api/projects/:id/memory/:memoryId`).
* **Project map** (`#/project/<id>/map`). A vertical map of the job and its
  workstreams, with the links between them.

## Artifacts (`library.js`, `artifacts.js`, `export.js`)

* **Library.** Filter by project, employee, type, date and status
  (needs attention / clear), and search titles, objectives and content.
* **Department views:**
  * FINANCE: KPIs, basis bar, category bars, first-year totals, ±20%
    sensitivity.
  * LEGAL: counts and a not-a-lawyer note.
  * AUDIT: verdict, findings, and "send to owner", which opens a direct
    conversation after confirmation.
  * SOCIAL: a calendar board.
  * CREATIVE: a brand preview (wordmark, phone, post). Only the named Google
    Fonts families are loaded, on demand.
  * PRODUCT: kanban, timeline and flow.
  * CODING: a session timeline with PR, CI and deploy state.
* **Shared exports.** CSV (formula cells neutralised), Markdown document, PNG
  (charts and moodboards), and Print / PDF. Everything runs in the browser;
  nothing is sent anywhere.

## Attention, integrations, models, search

* **Needs Fahad.** Items are grouped by level: URGENT, ACTION NEEDED and INFO.
  * Categories: APPROVAL, ANSWER REQUIRED, NEEDS OWNER, FAILED TASK, LEGAL
    DECISION, SECURITY DECISION, COMPLETED and PROJECT COMPLETE.
  * URGENT covers high- or critical-risk approvals and critical security
    findings.
* **Integrations.** States are CONNECTED / CONFIGURED / NOT CONFIGURED /
  ACCOUNT ACTION REQUIRED / UNAVAILABLE. Hermes is not shown.
* **Models.** The advanced view shows a WAITING_FOR_CAPACITY banner when steps
  are waiting for free capacity.
* **Search.** Press ⌘K, Ctrl+K or `/`. `/api/search` searches projects, jobs,
  conversations, artifacts and employees (including Arabic nicknames). A query
  needs at least 2 characters, and LIKE wildcards are escaped.
* **Errors.** `humanize.js` turns technical errors into plain sentences, with
  "View details" for the original text.

## Realtime (`OfficeStream`, `/api/stream`)

* **One watermark per workspace.** The server computes it from:
  * the maximum event id;
  * the latest session update;
  * the pending approval ids;
  * the latest artifact id.
* **Polling.** The watermark is polled every 2.5 s, and only while a browser is
  connected.
* **Browser.** The browser receives a change signal over server-sent events,
  debounces it by 250 ms and reloads the visible page. The fallback poll runs
  every 30–60 s, only if the stream drops.

## Performance

* **Content-hashed URLs.** Assets are served under `?v=<hash>` with
  `immutable` caching. Unversioned requests get `no-cache` plus an ETag (304).
* **Compression.** Text assets are gzipped once at startup.
* **Transfer sizes (gzipped):**

  | Asset | Size | Loading |
  | --- | --- | --- |
  | `app.css` | 12.5 KB | at start |
  | `app.js` | 20.7 KB | at start |
  | `office.js` + `office.css` | 13 KB | lazy |
  | `project.js` | 6.7 KB | lazy |
  | `library.js` | 4 KB | lazy |
  | Inter | 47 KB | font |
  | Plex Arabic | ~42 KB per weight | font |

## Telegram

Telegram replies stay a text summary. Rich artifacts are named, for example
"◧ Table — open in the Hub", so Fahad knows there is something to open.

## Visual QA (development only; never shipped)

* **`tools/hub-preview.mjs`** runs the real Hub server over an in-memory
  database (`testing/fixtures/memory-postgrest.js`). The data is a fictional
  project in `testing/fixtures/hub-preview-data.js`.
* **`tools/ui-screenshots.mjs`** screenshots 19 screens:
  * sizes: 1440 (desktop), 1366 (laptop), tablet and 390 (mobile);
  * themes: dark and light.

  It uses a globally installed Playwright:

  ```sh
  node tools/hub-preview.mjs &     # http://127.0.0.1:2199
  node tools/ui-screenshots.mjs --out ./shots --theme both
  ```
