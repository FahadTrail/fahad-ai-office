# V5 — Immersive 3D Office (beta)

The Live Office has two renderers of the same truth:

```
LIVE OFFICE
├── IMMERSIVE 3D — capable desktops (beta; opt-in)
└── LIGHT 2.5D   — default, mobile, tablet, reduced motion, fallback
```

Both consume one presentation state. The 3D layer is presentation only: if
it fails, the light Office takes over, and nothing else in the Hub is
affected.

## Technology

* **Engine:** Three.js r0.186.1, MIT licence, built with esbuild (MIT). Both
  are dev dependencies only.
* **Bundle:** `node tools/build-three.mjs` tree-shakes the engine into
  `src/hub-ui/vendor/three.js`: about 585 KB, **about 148 KB gzipped**. The
  file is committed and served like any Hub asset (content-hashed, immutable,
  gzipped).
* **Why Three.js:**
  * It is the most maintained WebGL library.
  * It is tree-shakeable into the Hub's vanilla ES modules, with no
    framework.
* **Alternatives rejected:**

  | Option | Licence | Why not |
  | --- | --- | --- |
  | Babylon.js | Apache-2.0 | Several times larger. |
  | TresJS | — | Needs Vue. |
  | CSS 3D | — | Cannot light materials or cast shadows. |

## Loading

* **When it loads:** the engine loads only when the Live Office is in immersive
  mode. It is a dynamic `import()` from `office.js`; no other route references
  it, and a test enforces this.
* **Loading screen:** it shows staged progress and a *Use light Office* button.
* **Modes:** AUTO / IMMERSIVE / LIGHT, via the switch in the Office header.
  * **Rollout step 1:** AUTO keeps the light Office.
  * **Rollout step 2:** Settings → *Office view* lets Fahad allow immersive for
    AUTO on capable desktops.
  * An advanced quality setting is also there.

## Architecture (`src/hub-ui/`)

| Module | Role |
| --- | --- |
| `office-presentation.js` | The single adapter: `/api/office` + `/api/artifacts` → `{ employees, projects, handoffs, artifacts, needsFahad, summary }`, `describeOffice()` for screen readers, `officeMode()` for AUTO/IMMERSIVE/LIGHT. Pure; tested. |
| `office3d/layout.js` | The architectural plan (wings, workspaces, partitions, camera presets). Pure data. |
| `office3d/state-visuals.js` | Real state → screen / board / pose / indicator; CODING lifecycle → engineering panel. Pure. |
| `office3d/characters.js` | Replaceable figure factory, poses and ambient/task motion. |
| `office3d/surfaces.js` | Canvas-drawn screens and wall displays: real artifact, real state, or a quiet abstract pattern. |
| `office3d/scene.js` | Renderer, lighting, architecture, batching, handoffs, labels, camera rig, picking, quality watchdog, fail-safe. |

The renderer never fetches anything. It receives presentation state from
`office.js`, which refreshes it through the existing live stream; there is
no second polling engine. Two read-only fields were added to `/api/office`:

* `workflows[].team`, for Project Mode;
* `coding` (latest session: phase, PR, CI, deploy), for the engineering
  panel.

## The place

| Area | Where | What it shows |
| --- | --- | --- |
| **Executive Atrium** | Centre | CHIEF, with guest chairs and the project wall: real objectives, progress, team and Office status. |
| **Intelligence Wing** | Left | RESEARCH, LEGAL and AUDIT, with document credenzas, the intelligence wall, the document wall and the review board. |
| **Strategy Wing** | Right | PRODUCT (roadmap board and planning stand) and FINANCE (finance screen and second monitor). |
| **Creative Studio** | Back left | CREATIVE (moodboard wall and a material-sample wall) and SOCIAL (content wall and phone stands). |
| **Build Studio** | Back right | CODING, with two monitors, a server cabinet and the engineering panel. |
| **Entrance** | Front | The brand wall and a small lounge. |

## Characters

* **Figures:** abstract, human-like and ceramic-matte, with a thin wing-accent
  collar. There are no faces or names.
* **Poses:** relaxed, focused, working, reading and paused. Each comes from the
  real state.
* **Motion:**
  * Ambient breathing is always allowed.
  * Task motion (hands at work) happens only when the state is really active.
  * Reduced motion stops all movement.

## Truth rules

* **Wall displays:** only real artifacts, such as CREATIVE's moodboard, the
  PRODUCT board and roadmap, the SOCIAL calendar, the LEGAL matrix and AUDIT's
  verdict.
* **FINANCE:** a VERIFIED model's calculated figures, or a calculator-drawn
  chart. Otherwise it shows "Awaiting validated figures"; hand-drawn FINANCE
  charts never appear.
* **CODING:** the real lifecycle stage (PLANNING → EDITING → TESTING →
  DEBUGGING → CI → DEPLOYING → VERIFYING), PR, CI and "Waiting for your
  approval".
* **Desk monitors:** brightness follows state; they carry no text.
* **Handoffs:** real handoff records, drawn as arcs. A fresh one (under 10
  minutes) sends one light packet. Clicking a handoff opens FROM / TO /
  OBJECTIVE / ARTIFACT / STATUS / TIME.
* **Needs Fahad:** an amber beacon beside CHIEF, which opens Needs Fahad.

## Interaction

* **Clicking an employee** (the 3D workspace or its label button) moves the
  camera to that workspace and opens the existing employee drawer: status,
  task, artifacts, handoffs, history, chat and the full workspace.
* **Clicking a wall display** opens the artifact viewer.
* **Other controls:**
  * **Overview** button, or Escape, returns to the full view.
  * Drag gently orbits and the wheel zooms, within limits.
  * **Project Mode:** choosing a project dims employees outside it and shows
    the project card (progress, working count, handoffs, needs-you and team).
  * **Follow work** (optional) moves the camera only for major events — Needs
    Fahad, a delivery, a fresh handoff, or work starting — at most every 20
    seconds.
* **Ask CHIEF:** stays in the header, outside the scene.

## Quality and fallback

* **Quality tiers:**

  | Tier | Pixel ratio | Shadows |
  | --- | --- | --- |
  | HIGH | 2 | 2048 |
  | BALANCED | 1.5 | 1024 |
  | LIGHT | 1 | none |

* **Choosing a tier:** it is picked from the device, and a frame-rate watchdog
  steps down a tier after 4 s below the floor. Below LIGHT, it falls back to
  the light Office.
* **Automatic light Office:** used when WebGL2 is unavailable, the GPU is a
  software renderer, the width is under 1100 px, the pointer is coarse, or (for
  AUTO) reduced motion is on. A lost WebGL context or a render error also falls
  back with a toast.
* **Batching:** static geometry is merged per material, within each workspace
  so Project Mode can still dim it. The render loop runs only while something
  moves and pauses in hidden tabs.

## Accessibility

* **Every workspace is a real `<button>` label**, with state and task in its
  accessible name. Keyboard focus moves the camera.
* **Everything is reachable without 3D:** handoffs are a button list, the
  project selector and card are DOM, a polite live region describes the whole
  Office, and the canvas is `aria-hidden`.
* **Result:** axe-core finds 0 violations in immersive and light modes, dark
  and light themes.

## Measured (preview harness, headless Chromium with software WebGL)

| Measure | Value |
| --- | --- |
| Draw calls, overview | 191, down from 632 before batching; shadow pass included |
| Draw calls, focused view | about 63–96 |
| Triangles | about 70k |
| Geometries | 74 |
| Textures | 25 |
| JS heap | about 10–13 MB |
| Ready (canvas shown) | 0.7–1.9 s from navigation |

* **Frame rate:** a software renderer is not representative, so real-GPU
  frame rate must be checked in production (owner action).
* **Performance budget:**
  * engine at most 170 KB gzipped;
  * scene code at most 90 KB (both enforced by tests);
  * at most about 200 draw calls in the overview.

## Visual QA

`node tools/office3d-shots.mjs <dir>` renders the real scene over the
fictional preview data. It produces the overview (light and dark), CHIEF,
CODING, CREATIVE, a handoff, Project Mode (two projects), Needs Fahad,
reduced motion, the light Office, and the tablet and mobile fallbacks. It
also writes renderer statistics to `report.json`.
