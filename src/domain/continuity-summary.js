// Compact Continuity summary. Safety behaviour is reported as enforced by
// the runtime, not switched on here. Counts are UNKNOWN when the rows were
// not loaded. Disabled workers stay disabled.

const OPEN_SESSION = new Set(['STANDBY', 'ACQUIRING', 'ACTIVE', 'DRAINING', 'CHECKPOINTING', 'HANDOFF_READY', 'RATE_LIMITED', 'QUOTA_EXHAUSTED', 'AUTH_REQUIRED']);

export function continuitySummary({ supervisorEnabled = false, sessions = null, leases = null, checkpoints = null, handoffs = null } = {}) {
  const count = (rows, predicate = () => true) => (rows == null ? 'UNKNOWN' : rows.filter(predicate).length);
  return {
    supervisorEnabled: Boolean(supervisorEnabled),
    owner: {
      activeSessions: count(sessions, (session) => OPEN_SESSION.has(session.status)),
      failedSessions: count(sessions, (session) => ['FAILED', 'ABNORMAL_EXIT'].includes(session.status)),
      pendingHandoffs: count(handoffs, (handoff) => ['PROPOSED', 'ACCEPTED'].includes(handoff.status)),
    },
    safety: {
      leaseOwnership: 'enforced-by-runtime',
      oneWriter: 'enforced-by-runtime',
      stopVerification: 'enforced-by-runtime',
      activeLeases: count(leases, (lease) => lease.status === 'ACTIVE'),
      checkpoints: count(checkpoints),
      resume: supervisorEnabled ? 'available' : 'supervisor-off',
      retryAndFallback: 'unchanged',
    },
    advanced: { endpoint: '/api/continuity' },
  };
}
