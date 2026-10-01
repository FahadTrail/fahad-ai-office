// Coding Continuity Supervisor: worker session state machine
// (docs/CODING-CONTINUITY-SUPERVISOR.md section 4). The database stores the
// state; this module is the authority on which moves are legal.

export const LIFECYCLE = Object.freeze(['STANDBY', 'ACQUIRING', 'ACTIVE', 'DRAINING', 'CHECKPOINTING', 'HANDOFF_READY', 'RELEASED']);
// COMPLETED is reached only after the completion gates pass (section 16).
export const TERMINAL = Object.freeze(['RELEASED', 'COMPLETED']);
export const FAILURES = Object.freeze(['RATE_LIMITED', 'QUOTA_EXHAUSTED', 'AUTH_REQUIRED', 'UNAVAILABLE', 'FAILED', 'ABNORMAL_EXIT']);
export const STATES = Object.freeze([...LIFECYCLE, 'COMPLETED', ...FAILURES]);

// A failed session never edits again: the Supervisor writes a recovery
// checkpoint (HANDOFF_READY) or closes it (RELEASED). RATE_LIMITED is the one
// transient failure a worker may come back from while it still holds the lease.
const TRANSITIONS = Object.freeze({
  STANDBY: ['ACQUIRING', 'UNAVAILABLE', 'AUTH_REQUIRED'],
  ACQUIRING: ['ACTIVE', 'STANDBY', ...FAILURES],
  ACTIVE: ['DRAINING', ...FAILURES],
  DRAINING: ['CHECKPOINTING', ...FAILURES],
  CHECKPOINTING: ['HANDOFF_READY', 'COMPLETED', ...FAILURES],
  HANDOFF_READY: ['RELEASED'],
  RELEASED: [],
  COMPLETED: [],
  RATE_LIMITED: ['ACTIVE', 'DRAINING', 'HANDOFF_READY', 'RELEASED'],
  QUOTA_EXHAUSTED: ['HANDOFF_READY', 'RELEASED'],
  AUTH_REQUIRED: ['HANDOFF_READY', 'RELEASED'],
  UNAVAILABLE: ['HANDOFF_READY', 'RELEASED'],
  FAILED: ['HANDOFF_READY', 'RELEASED'],
  ABNORMAL_EXIT: ['HANDOFF_READY', 'RELEASED'],
});

export function canTransition(from, to) {
  return Object.hasOwn(TRANSITIONS, from) && TRANSITIONS[from].includes(to);
}

export function nextStates(from) {
  return Object.hasOwn(TRANSITIONS, from) ? [...TRANSITIONS[from]] : [];
}

export function isTerminal(state) {
  return TERMINAL.includes(state);
}
