// Frame-rate watchdog policy (§14), pure so it is tested in Node.
//
// The 3D Office steps its quality down only when a device is persistently
// slow, and falls back to the simplified Office only after the lowest tier
// has also stayed slow. It never judges a device by its first seconds, by a
// view or mode switch that compiles shaders, or by stalls it does not cause
// (a hidden tab, an off-screen frame, a throttled window):
//
//   * warm-up: nothing is judged until the scene is ready, plus a settle time;
//   * grace: every switch that compiles or rebuilds opens a short window;
//   * median, not mean: a few long compile frames cannot move it;
//   * gaps over pauseMs are pauses (throttling), not frames;
//   * sustained: slowness must last stepAfterMs (and giveUpAfterMs on the
//     lowest tier) without a single good check in between.
export const WATCHDOG = Object.freeze({
  settleMs: 5000, // after ready
  graceMs: 3500, // after a view, mode, quality or size change
  window: 90, // frames in the median
  minFrames: 45,
  pauseMs: 750, // a longer gap is a pause (throttled or hidden), not a frame
  floorFps: 20, // slow below this many frames per second at a 60 fps target…
  floorShare: 0.5, // …or below half of a lower target (30 fps at rest → 15)
  stepAfterMs: 6000,
  giveUpAfterMs: 20000,
});

export const TIERS = Object.freeze(['high', 'balanced', 'lean', 'light']);

// The fps below which a frame budget counts as slow.
export const floorFor = (target) => Math.min(WATCHDOG.floorFps, target * WATCHDOG.floorShare);

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// createWatchdog({ tier }) → { frame(now, delta, target), grace(now, ms), ready(now), pause(), state() }
// frame() returns null, { step: nextTier } or { giveUp: true }.
export function createWatchdog({ tier = 'balanced', options = WATCHDOG } = {}) {
  let current = TIERS.includes(tier) ? tier : 'balanced';
  let readyAt = null; let quietUntil = 0; let slowSince = 0; let lastNow = 0; let gaveUp = false;
  let deltas = []; let targets = [];
  const reset = () => { deltas = []; targets = []; slowSince = 0; };
  const measured = () => { const value = median(deltas); return value ? 1000 / value : null; };
  return {
    ready(now) { readyAt = now; quietUntil = Math.max(quietUntil, now + options.settleMs); reset(); },
    grace(now, ms = options.graceMs) { quietUntil = Math.max(quietUntil, now + ms); reset(); },
    pause() { reset(); },
    tier: () => current,
    state() { const fps = measured(); return { tier: current, fps: fps === null ? null : Math.round(fps), slowForMs: slowSince ? Math.round(lastNow - slowSince) : 0, judging: readyAt !== null }; },
    frame(now, delta, target = 60) {
      lastNow = now;
      if (gaveUp || readyAt === null || now < quietUntil) return null;
      if (!(delta > 0) || delta > options.pauseMs) { slowSince = 0; return null; } // a pause, not a frame
      deltas.push(delta); targets.push(target);
      if (deltas.length > options.window) { deltas.shift(); targets.shift(); }
      if (deltas.length < options.minFrames) return null;
      const fps = measured(); const floor = floorFor(median(targets));
      if (fps >= floor) { slowSince = 0; return null; }
      if (!slowSince) { slowSince = now; return null; }
      const next = TIERS[TIERS.indexOf(current) + 1];
      if (next && now - slowSince >= options.stepAfterMs) { current = next; quietUntil = now + options.graceMs; reset(); return { step: next, fps: Math.round(fps) }; }
      if (!next && now - slowSince >= options.giveUpAfterMs) { gaveUp = true; reset(); return { giveUp: true, fps: Math.round(fps) }; }
      return null;
    },
  };
}

// Errors: a single bad frame is logged and survived; only repeated errors stop the 3D Office.
export function createErrorBudget({ limit = 3, windowMs = 10000 } = {}) {
  let times = [];
  return { record(now) { times = times.filter((at) => now - at < windowMs); times.push(now); return times.length >= limit; }, count: () => times.length };
}
