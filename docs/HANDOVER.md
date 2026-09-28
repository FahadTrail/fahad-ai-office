# Handover: V5 / V5.1 immersive Office branch

* **This file:** V5-specific state only.
* **The live, complete handover:** the same file on branch
  `claude/provider-expansion-prep` (the newest branch). Read that one first.
  It covers the router sprint (PR #72), provider expansion (PR #73), the
  V4.1 status and the full do-not-touch list.

## Do not touch

* **Do not merge PR #71** (this branch) until V4.1 reports **V4 CLOSED**
  *and* Fahad approves the immersive direction. It stays a draft.
* Do not touch the V4.1 acceptance job `abaccdad`, production routing,
  providers, secrets, Telegram or Hermes.
* Do not touch the FINANCE, AUDIT or CHIEF reliability logic.

## State of this branch

* **Branch:** `claude/v5-immersive-office` (PR #71, draft, unmerged).
* **Latest work:** the V5.1 visual polish pass (2026-09-28). The commit
  hash is in `git log`; its message starts with "V5.1 visual polish".

**V5 (complete):**
* a lazy-loaded Three.js immersive Office over the real presentation state;
* AUTO / IMMERSIVE / LIGHT modes;
* Project Mode and Follow Work;
* a private demo preview: `tools/v5-preview-build.mjs` (fictional data,
  writes refused).

**V5.1 (done so far):**
* five-item navigation (Chief, Employees, Projects, Needs Fahad, Office),
  with the rest under "More";
* one summary sentence on Employees, Needs Fahad, Tasks, Projects, Office,
  Artifacts, Integrations, Models and Chats (`src/hub-ui/summaries.js`);
* image-based PBR lighting on the high and balanced tiers;
* Character V2 (`src/hub-ui/office3d/characters.js`, `WARDROBE`);
* DAY / EVENING / NIGHT with smooth blending
  (`src/hub-ui/office3d/lighting.js`; Office → View → Light);
* architecture, fixtures and department identity
  (`src/hub-ui/office3d/decor.js`); ceiling cutaway in close views;
* department views (Office → Area) and calmer camera framing and easing.

Details: `docs/v5.1-plan.md` section 2b.

## Numbers (headless Chromium, software WebGL, 1440×900, high tier)

| | Before the polish pass | After |
|---|---|---|
| Overview draw calls | 193 | 166 |
| Overview triangles | 57K | 97K |
| CHIEF focus draw calls | 98 | 87 |
| Engine (gzipped) | 149,955 B | 150,430 B (budget 170,000) |
| Scene code, all `office3d/` modules (gzipped) | 24 KB | 34 KB (budget 40 KB) |
| Console errors in 25 QA views | 0 | 0 |
| axe WCAG 2 A/AA, 7 screens × 2 themes | — | 0 violations |

Real-GPU FPS is still unmeasured (software rendering shows about 2 fps on
the high tier, as before).

## Tests

`node --test`: 398 pass, 0 fail. New: `test/v51-visual.test.js`; extended:
`test/hub-summaries.test.js`, `test/v5-immersive.test.js`.

## Remaining visual work (in order)

1. Floor and wood detail per zone (canvas textures, no downloads).
2. Characters pass 3: a standing/walking pose on real handoffs.
3. Day mode depth: still slightly bright in the overview.
4. Check wing views at 1280×720.

## Exact next task

Floor and wood detail per zone, in `src/hub-ui/office3d/scene.js` (floor
texture) and `decor.js`, keeping overview draw calls at or under 200. Then
rebuild the preview and republish it to the same private artifact.

## Commands

```sh
npm ci && node --test
node tools/build-three.mjs                    # engine budget: ≤170 KB gz
node tools/office3d-shots.mjs <dir> --set=v51 # the 12 V5.1 QA views
node tools/office3d-shots.mjs <dir>           # the V5 regression views
node tools/v5-preview-build.mjs <dir>         # private demo preview build
```
