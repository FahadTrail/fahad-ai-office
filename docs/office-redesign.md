# The Office redesign — "Daylight Atrium" (2026-10-08)

Status: implemented on branch `claude/the-office-redesign`. **Not merged and
not deployed.** No database migration. The source of truth is the approved
deck *Fahad_AI_Office_-_Final_Design_Spec*. Section numbers (§) below refer to
that deck.

The redesign replaces the V5 immersive scene (`docs/v5-immersive-office.md`,
now history). It keeps the backend truth model, project filtering, SSE,
approvals, tasks, handoffs, accessibility, reduced motion and the fail-safe
simplified Office.

## Principles enforced in code

* Colour and floor light come only from real records. `states.js` maps a real
  employee state to lamp, ring, monitor, pose, chair and flare. `handoffs3d.js`
  starts a pulse only for a real, fresh handoff.
* Red appears only for Blocked, Failed and Needs You (`isRed`, tested).
* Modes change lighting only (`modes.js`). Layout, labels and data are identical
  in Light, Immersive and Auto.
* CHIEF is central (Forum) and visible in Overview.
* No per-department colour themes. Labels never overlap (`labels.js`, greedy
  4-slot placement with LOD) and never cover the focus rectangle.
* Ambient motion (`life.js`: at most two walkers, coffee steam, cloud shade) is
  neutral, only involves really available employees, and stops entirely with
  reduced motion.

## Architecture

Pure modules, tested in Node with no WebGL:

| Module | Role |
| --- | --- |
| `src/hub-ui/office3d/plan.js` | Spatial spec: 48 × 32 m office, Forum, Promenade, zones 00–08, rooms, glass, columns, façade |
| `src/hub-ui/office3d/routes.js` | Handoff paths along the brass inlay, comet timing, lanes, blocked holds |
| `src/hub-ui/office3d/modes.js` | Light 10:30 / Immersive 21:30 / Auto (real clock) keyframes and blending |
| `src/hub-ui/office3d/camera.js` | Overview, Department, Agent, CHIEF, Handoffs, idle orbit, arcs, cutaway (`occluders`) |
| `src/hub-ui/office3d/states.js` | Desk signals, Forum state, stat bar, label priority |
| `src/hub-ui/office3d/labels.js` | Floor label LOD and overlap-free layout, RTL mirrored |
| `src/hub-ui/office3d/texgen.js` | Deterministic, tileable PBR finishes (build time and runtime fallback) |
| `src/hub-ui/office3d/screens.js` | Desk monitors, department displays, the Office Wall |

Scene modules (Three.js r0.186.1, `src/hub-ui/vendor/three.js`):

* `architecture.js`: site, floors, Forum, inlay, instanced columns, façade fins,
  glazed rooms, ceilings, and night fixtures.
* `furniture.js`
* `plants.js`
* `people.js`: procedural skinned rig, wardrobe, clips, and 300 ms crossfades.
* `bake.js`: floor AO by day, light pools by night.
* `handoffs3d.js`
* `life.js`
* `materials.js`
* `builder.js`
* `scene.js`: renderer, quality tiers, post-processing, picking, keys,
  watchdog.

The overlay is `src/hub-ui/office.js`, with `office-copy.js` (English and
Arabic) and `office-presentation.js`. It holds:

* the capsule and the project filter;
* the views and the mode control;
* ⌘K, the bell and Summary;
* the stat bar and the banner;
* toasts and floor labels;
* the agent panel and the sheets.

Renderer choice (`hub-office-view`: auto, 3d or simplified) is separate from
the lighting mode (`hub-office-light-mode`). Small screens (< 1024 px), no
WebGL, or a watchdog trip fall back to the simplified Office.

## API extensions (read-only, additive)

All new fields come from `src/hub-office.js` and `src/hub-office-live.js`; no
schema change.

* `/api/office` agents gain `queue` and `enabled`. The response gains a
  24-hour `deliveries` array.
* `/api/agents/:slug` gains `usage`, `pipeline`, `chain` and `deliveries`.
* Handoffs can report `status: 'blocked'`.

## Assets

`node tools/build-office-assets.mjs` produces everything under
`src/hub-ui/office3d/assets/` (5.5 MB):

* 30 KTX2 PBR maps (Basis ETC1S/UASTC);
* two CC0 EXR HDRIs (day "apartment", night "hall", from @pmndrs/assets);
* the Basis transcoder;
* `manifest.json` and `asset-manifest.js`;
* Archivo (OFL) as `src/hub-ui/fonts/archivo-*.woff2`.

The Hub serves the assets from `/ui/office-assets/`:

* only files listed in the manifest are served;
* ETag and 304;
* Range (206 / 416) and HEAD;
* immutable caching when `?v=` matches.

The licences are recorded in `legal/license-decisions.json`.

## Quality tiers and measurements

| Tier | Pixel ratio | Shadows | Composer | Other |
| --- | --- | --- | --- | --- |
| High | 2× | 4096 | MSAA 4× | GTAO, depth of field in agent view; chosen in Settings |
| Balanced (default) | 1.5× | 2048 | MSAA 4× | bloom at night |
| Lean | 1× | 2048 | MSAA 2× | bloom at night (the same look, fewer pixels) |
| Light | 1× | 1024 | none | weak GPUs, touch devices |

The day overview draws 160 calls, down from 196 before hardening. These calls
include the shadow pass, which now runs only on the frames that need it.

Measured with headless Chromium on software WebGL (SwiftShader), 1440 × 900, Balanced:

| View | Draw calls | Triangles |
| --- | --- | --- |
| Day overview | 160 | 684 k |
| Night overview | 117 | 349 k |
| CHIEF | 130 | 682 k |
| Department | 127 | 678 k |
| Agent | 115 | 608 k |
| Handoffs (night) | 122 | 349 k |

Software WebGL reports about 0–1 fps on every tier and says nothing about
real devices. Real-device frame rate comes from the QA panel in the preview
build (see QA tools).

Bundle sizes (gzip):

* engine: 224 KB;
* scene modules: about 76 KB;
* overlay: about 17.8 KB JS and 7.8 KB CSS.

## Real-device hardening (2026-10-08)

On a normal laptop, the real-device preview fell back to the simplified
Office. These were the causes, and how each is fixed.

### Watchdog false positives

**Cause.**
* The old watchdog used the *mean* frame time of the last 90 frames.
* It stepped quality down after 4 s below 24 fps.
* Expected first-load stalls dragged that mean down. They came from:
  * shader compiles;
  * a recompile of every textured material as each KTX2 set arrived;
  * HDRI conversion;
  * the night bloom compile;
  * the sun light being removed at night, which recompiled every material on each Light and Immersive switch.
* Every step down rebuilt the composer, which compiled again, so the cascade could reach Light and then fall back.
* Machines reporting 8 GB and 8 cores started on High.

**Fix.** The watchdog moved to `src/hub-ui/office3d/perf.js`, which is pure and tested:

* nothing is judged until the scene is ready, plus 5 s;
* every view, mode, quality or size change opens a grace window;
* it uses the median frame time;
* gaps over 750 ms count as pauses (throttling), but only while the page has no focus:
  * a focused, visible page is not throttled, so there a gap is a slow frame;
  * gaps over 5 s are always pauses, such as a suspended page or a debugger;
* it steps down only after 6 s of continuous slowness, through High, Balanced, Lean and Light;
* it falls back only after 20 s more on Light.

### First-load spikes

**Fix.**
* Materials start with neutral 1×1 maps, so streamed textures swap in without a recompile.
* Programs are compiled before judging starts (`compileAsync` where the GPU supports it).
* The sun stays in the scene at night with intensity 0.
* If KTX2 decoding fails, finishes are generated one per frame.

### Device detection

**Cause.** Any viewport under 1024 px fell back, even a laptop window or a side panel, and even when 3D was chosen.

**Fix.**
* Only phones and tablets (coarse pointer or a small screen) and viewports under 640 × 420 use the simplified Office.
* Balanced is the default tier; High is chosen in Settings.

### Errors

**Cause.** Any single frame error, or a lost WebGL context, fell back permanently.

**Fix.**
* One bad frame is survived; three within 10 s stop the 3D Office.
* A lost context is restored with a fresh mount, at most twice in ten minutes.

### Cost

* Shadows are drawn on demand: at most 15 times a second while something moves, and not at all at night once the map exists.
* The seven task chairs are three instanced meshes instead of 21.
* Rendering stops while the Office is off-screen.

### Label fix

* CHIEF's label is placed right after the focused desk, so it stays visible in a narrow Overview.

QA tools set `hub-office-watchdog` to `off` so their screenshots stay deterministic on software GPUs. The Hub never sets it.

## QA tools

```sh
node tools/hub-preview.mjs                        # fictional preview Hub (moments: work, many, blocked, idle)
node tools/office-shots.mjs <dir> [--quality=balanced] [--only=…] [--stage]   # the ten design views + report.json
AXE_SCRIPT=<axe.min.js> node tools/office-a11y.mjs <dir>   # axe, keyboard and RTL audit (6 cases)
```

The ten views are:

1. day overview;
2. night overview;
3. CHIEF focus;
4. department;
5. agent;
6. handoffs;
7. blocked;
8. many working;
9. idle;
10. executive summary.

The contact sheet of all ten views (final commit, Balanced tier, fictional
preview data) is `docs/office-redesign/office-redesign-10-views.png`.

The accessibility audit last ran on 2026-10-08:

* 0 serious or critical findings in all 6 cases;
* Arabic `dir="rtl"`, with 9 of 9 floor labels reachable by Tab;
* the agent panel opens on the inline end.

## Known limitations

* Characters are procedural skinned figures, not motion capture. The far LOD
  freezes the pose instead of switching to impostor billboards.
* No CC0 night-city HDRI was reachable; night uses an interior "hall" HDRI.
* MSAA is used instead of TAA.
* The "Delivered" counter redraws; it does not roll.
* Real-GPU frame rate has not been measured.
* The hex values in `FINAL_DESIGN_SPEC_FOR_CODEX.md` were not available; colours
  follow the deck.
