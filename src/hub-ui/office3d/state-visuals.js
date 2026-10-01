// Real Office state → visual behaviour. Pure mapping, kept apart from the
// character models and the renderer so either can change independently.
// Nothing here invents activity: an AVAILABLE employee is at rest.
//
//   screen: idle | focus | active | dim | error     (desk monitor)
//   board:  idle | active | review                   (wall display)
//   pose:   relaxed | focused | working | reading | paused
//   indicator: null | waiting | attention | warning | done | error

const MAP = Object.freeze({
  AVAILABLE: { screen: 'idle', board: 'idle', pose: 'relaxed', indicator: null },
  QUEUED: { screen: 'idle', board: 'idle', pose: 'relaxed', indicator: 'waiting' },
  THINKING: { screen: 'focus', board: 'idle', pose: 'focused', indicator: null },
  WORKING: { screen: 'active', board: 'active', pose: 'working', indicator: null },
  TESTING: { screen: 'active', board: 'active', pose: 'working', indicator: null },
  REVIEWING: { screen: 'active', board: 'review', pose: 'reading', indicator: null },
  WAITING: { screen: 'dim', board: 'idle', pose: 'paused', indicator: 'waiting' },
  'NEEDS FAHAD': { screen: 'focus', board: 'idle', pose: 'paused', indicator: 'attention' },
  BLOCKED: { screen: 'dim', board: 'idle', pose: 'paused', indicator: 'warning' },
  COMPLETED: { screen: 'idle', board: 'active', pose: 'relaxed', indicator: 'done' },
  FAILED: { screen: 'error', board: 'idle', pose: 'paused', indicator: 'error' },
});

export function stateVisual(employee) {
  const base = MAP[employee?.state] || MAP.AVAILABLE;
  return { ...base, ...(employee?.key === 'coding' ? { panel: codingPanel(employee) } : {}) };
}

// The engineering panel follows the Coding Agent's real lifecycle phase.
const PHASES = Object.freeze({
  understand: 'PLANNING', plan: 'PLANNING', implement: 'EDITING', test: 'TESTING', debug: 'DEBUGGING', review: 'REVIEWING',
  publish: 'CI', ci: 'CI', deploy: 'DEPLOYING', verify: 'VERIFYING', report: 'VERIFYING',
});
export const CODING_STAGES = Object.freeze(['PLANNING', 'EDITING', 'TESTING', 'DEBUGGING', 'CI', 'DEPLOYING', 'VERIFYING']);

export function codingPanel(employee) {
  const session = employee?.coding;
  if (!session || !['running', 'queued', 'blocked', 'awaiting_approval'].includes(session.status)) {
    return { stage: null, pr: session?.pr || null, ci: session?.ci || null, deploy: session?.deploy || null, status: session?.status || null };
  }
  return { stage: PHASES[session.phase] || 'PLANNING', pr: session.pr || null, ci: session.ci || null, deploy: session.deploy || null, status: session.status,
    awaiting: session.status === 'awaiting_approval' || employee.state === 'NEEDS FAHAD' };
}

// Ambient motion is allowed everywhere (breathing, a glance) but task motion
// (typing, screen activity) only when the state is really active.
export function motionFor(visual, { reducedMotion = false } = {}) {
  if (reducedMotion) return { ambient: 0, task: 0 };
  return { ambient: 1, task: ['working', 'reading'].includes(visual.pose) ? 1 : visual.pose === 'focused' ? 0.4 : 0 };
}
