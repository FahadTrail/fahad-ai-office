// Real Office state → what the place shows (Final Design Spec §05, §03, §11).
// State lives on the desk, never above heads: the task lamp, the monitor,
// the body and the chair. Colour means truth: red only for Blocked, Failed
// and Needs you. Pure; tested in Node.

// Tones: the only colours the Office uses for state.
//   neutral (grey) · working (blue) · done (green) · attention (red) · caution (amber) · offline (grey)
export const TONES = Object.freeze(['neutral', 'working', 'done', 'attention', 'caution', 'offline']);
export const RED_STATES = Object.freeze(['BLOCKED', 'FAILED', 'NEEDS FAHAD']);
const ACTIVE = new Set(['THINKING', 'WORKING', 'TESTING', 'REVIEWING']);

// Desk signals for one employee.
//   lamp:    level 0..1 (2700 K when working), ring: null | 'blocked' | 'approval' | 'failed', flare: on a real completion
//   monitor: screensaver | live | waiting | frozen | approval | error | delivered | off
//   pose:    relaxed | typing | reading | review | phone | blocked | sitback | waiting | empty
//   chair:   occupied | pushed-in
export function deskSignal(employee = {}) {
  const state = employee.state || 'AVAILABLE';
  if (employee.enabled === false) return signal('offline', { lamp: 0, monitor: 'off', pose: 'empty', chair: 'pushed-in' });
  const key = employee.key;
  if (ACTIVE.has(state)) {
    const reading = state === 'THINKING' || state === 'REVIEWING' || key === 'research' || key === 'legal' || key === 'audit';
    const pose = key === 'social' ? 'phone' : key === 'creative' && state === 'REVIEWING' ? 'review' : reading ? 'reading' : 'typing';
    return signal('working', { lamp: 1, monitor: 'live', pose });
  }
  switch (state) {
    case 'NEEDS FAHAD': return signal('attention', { lamp: 0.35, ring: 'approval', monitor: 'approval', pose: 'waiting' });
    case 'BLOCKED': return signal('attention', { lamp: 0.35, ring: 'blocked', monitor: 'frozen', pose: 'blocked' });
    case 'FAILED': return signal('attention', { lamp: 0.35, ring: 'failed', monitor: 'error', pose: 'blocked' });
    case 'COMPLETED': return signal('done', { lamp: 0.25, monitor: 'delivered', pose: 'sitback', flare: true });
    case 'WAITING': case 'QUEUED': return signal('neutral', { lamp: 0, monitor: 'waiting', pose: 'waiting' });
    default: return signal('neutral', { lamp: 0, monitor: 'screensaver', pose: 'relaxed' });
  }
}
function signal(tone, { lamp = 0, ring = null, monitor = 'screensaver', pose = 'relaxed', chair = 'occupied', flare = false }) {
  return { tone, lamp, ring, monitor, pose, chair, flare };
}

// Only these tones may ever be drawn red.
export function isRed(tone) { return tone === 'attention'; }

// The CHIEF Forum (§03): the bronze edge strip on the walnut table is CHIEF's
// status light.
//   idle       strip off; the wall shows Today; the oculus light is the only highlight
//   active     strip at 40 % blue; monitors and routing map live; CHIEF looks up at the wall
//   routing    a real fresh handoff to or from CHIEF: the pulse circles the Forum ring once in 1.2 s; the strip brightens for 400 ms
//   completes  CHIEF really delivered: warm flare over 600 ms, the Delivered counter rolls, a brief sit-back
export const FORUM_STATES = Object.freeze({
  idle: Object.freeze({ strip: 0, tone: 'neutral' }),
  active: Object.freeze({ strip: 0.4, tone: 'working' }),
  routing: Object.freeze({ strip: 0.4, tone: 'working', ringPulse: 1.2, brighten: 0.4 }),
  completes: Object.freeze({ strip: 0, tone: 'done', flare: 0.6 }),
});
export function forumState(state) {
  const chief = state?.employees?.find((employee) => employee.key === 'chief');
  if (!chief) return 'idle';
  if (chief.state === 'COMPLETED') return 'completes';
  if ((state.handoffs || []).some((handoff) => handoff.fresh && (handoff.fromKey === 'chief' || handoff.toKey === 'chief'))) return 'routing';
  return ACTIVE.has(chief.state) ? 'active' : 'idle';
}

// The ten system states (§11), each derived from real rows.
//   no tasks    ambient only; the wall shows "All clear"
//   one task    one lamp, one live monitor
//   several     many lamps, parallel pulses
//   overloaded  "Queue n" on the department display (amber)
//   blocked     red lamp ring, a dot held at the door
//   failed      solid red square, error on the monitor
//   completed   lamp flare, the counter rolls
//   approval    red hollow ring, pulsing every 6 s
//   offline     an empty chair pushed in (only when an employee is disabled)
//   provider    model capacity unavailable: agents idle, a banner (amber)
export const OVERLOAD_QUEUE = 3;
export function systemState(state) {
  const employees = state?.employees || [];
  const working = employees.filter((employee) => employee.enabled !== false && ACTIVE.has(employee.state));
  const of = (states) => employees.filter((employee) => states.includes(employee.state)).map((employee) => employee.key);
  const capacityWait = employees.filter((employee) => employee.state === 'WAITING' && (employee.resumesAt || /free model capacity/i.test(employee.detail || ''))).map((employee) => employee.key);
  return {
    load: working.length === 0 ? 'none' : working.length === 1 ? 'one' : 'several',
    working: working.map((employee) => employee.key),
    overloaded: employees.filter((employee) => Number(employee.queue || 0) >= OVERLOAD_QUEUE).map((employee) => ({ key: employee.key, queue: Number(employee.queue) })),
    blocked: of(['BLOCKED']),
    failed: of(['FAILED']),
    approval: of(['NEEDS FAHAD']),
    completed: of(['COMPLETED']),
    offline: employees.filter((employee) => employee.enabled === false).map((employee) => employee.key),
    providerWait: capacityWait,
    allClear: working.length === 0 && !employees.some((employee) => RED_STATES.includes(employee.state)) && !Number(state?.needsFahad || 0),
  };
}

// The ruled stat bar (§08): Working · Needs you · Blocked · Delivered today.
// Red only when a count is above 0 (and only for Needs you and Blocked).
// Delivered today counts real deliveries since the viewer's local midnight.
export function statBar(state, { deliveries = [], now = Date.now() } = {}) {
  const employees = state?.employees || [];
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const delivered = deliveries.filter((delivery) => Date.parse(delivery.at) >= midnight.getTime() && Date.parse(delivery.at) <= now).length;
  const working = employees.filter((employee) => ACTIVE.has(employee.state)).length;
  const needsYou = Number(state?.needsFahad || 0);
  const blocked = employees.filter((employee) => ['BLOCKED', 'FAILED'].includes(employee.state)).length;
  return [
    { id: 'working', value: working, tone: 'neutral' },
    { id: 'needs', value: needsYou, tone: needsYou > 0 ? 'attention' : 'neutral' },
    { id: 'blocked', value: blocked, tone: blocked > 0 ? 'attention' : 'neutral' },
    { id: 'delivered', value: delivered, tone: 'neutral' },
  ];
}

// Label priority: the focus first, then attention, work, deliveries, rest.
export function labelPriority(employee, focusKey = null) {
  if (employee.key === focusKey) return 0;
  // CHIEF stays central and visible in the Overview (§02): placed before every department.
  if (employee.key === 'chief') return 0.5;
  const tone = deskSignal(employee).tone;
  return { attention: 1, working: 2, done: 3, caution: 3, neutral: 4, offline: 5 }[tone] ?? 4;
}
