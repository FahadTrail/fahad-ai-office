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

Tiers: High (2× pixel ratio, 4096 shadows, MSAA composer, GTAO, depth of field
in agent view, bloom at night), Balanced (1.5×, 2048), Light (1×, 1024, no
composer).

Measured with headless Chromium on software WebGL (SwiftShader), 1440 × 900:

| View | Tier | Draw calls | Triangles |
| --- | --- | --- | --- |
| Day overview | Balanced | 196 | 684 k |
| Night overview | Balanced | 133 | 349 k |
| Agent | Balanced | 132 | 586 k |
| Day overview | High | 250 | 936 k |

Frame rate on a real GPU is **not measured**; software WebGL reports about 0–1
fps for every tier and says nothing about real devices.

Bundle sizes (gzip):

* engine: 224 KB;
* scene modules: 73 KB;
* overlay: 17.5 KB JS and 7.8 KB CSS.

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
