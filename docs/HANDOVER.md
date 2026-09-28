# Handover: V5 / V5.1 immersive Office branch

* **This file:** V5-specific state only.
* **The live, complete handover:** the same file on branch
  `claude/provider-expansion-prep` (the newest branch). Read that one first.
  It covers the router sprint (PR #72), provider expansion (PR #73), the
  V4.1 status and the full do-not-touch list.

## Do not touch

* **Do not merge PR #71** (this branch) until V4.1 reports **V4 CLOSED**
  *and* Fahad approves the immersive direction.
* Do not touch the V4.1 acceptance job `abaccdad`, production routing,
  Telegram or Hermes.
* Do not touch the FINANCE, AUDIT or CHIEF reliability logic.

## State of this branch

**V5 (complete):**
* a lazy-loaded Three.js immersive Office over the real presentation state;
* AUTO / IMMERSIVE / LIGHT modes;
* Project Mode and Follow Work;
* a private demo preview: `tools/v5-preview-build.mjs` (fictional data,
  writes refused).

**V5.1 (in progress):**
* Done:
  * five-item navigation (Chief, Employees, Projects, Needs Fahad, Office),
    with the rest under "More";
  * image-based PBR lighting on the high and balanced tiers;
  * a one-sentence summary at the top of Employees, Needs Fahad, Tasks and
    Projects (`src/hub-ui/summaries.js`, tested in
    `test/hub-summaries.test.js`).
* Plan: `docs/v5.1-plan.md`.

## Next tasks here (in order)

1. Furniture and architecture density in the 3D scene (merged static
   meshes; keep about 200 draw calls or fewer).
2. Characters v2 (`src/hub-ui/office3d/characters.js` only).
3. Night lamps and time-of-day warmth.
4. Rebuild the private preview and republish it (same artifact URL, see
   the main handover).

## Commands

```sh
npm ci && node --test
node tools/build-three.mjs            # engine budget: ≤170 KB gz
node tools/office3d-shots.mjs <dir>   # 3D screenshot QA (fictional data)
node tools/v5-preview-build.mjs <dir> # private demo preview build
```
