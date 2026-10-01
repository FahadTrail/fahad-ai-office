export const CONTINUITY_ERROR_CODES = Object.freeze([
  'AUTH_REQUIRED', 'CLI_NOT_FOUND', 'UNSUPPORTED_VERSION', 'RATE_LIMITED', 'QUOTA_EXHAUSTED',
  'WORKER_CRASHED', 'CHECKPOINT_FAILED', 'LEASE_LOST', 'HANDOFF_FAILED',
  'NO_ELIGIBLE_WORKER', 'PRIVACY_MISMATCH', 'WORKER_TIMEOUT', 'WORKER_STOP_UNCONFIRMED',
  'WORKER_OUTPUT_INVALID', 'WORKTREE_UNSAFE',
]);

export function continuityError(code, cause = null) {
  if (!CONTINUITY_ERROR_CODES.includes(code)) throw new TypeError(`Unknown continuity error code: ${code}`);
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

// Prefer provider event fields. Text is a last resort for older CLIs that do
// not emit typed errors, and is never returned verbatim to clients or logs.
export function classifyCliFailure({ event = null, exitCode = null, stderr = '', timedOut = false } = {}) {
  if (timedOut) return 'WORKER_TIMEOUT';
  const kind = String(event?.error?.type || event?.error?.code || event?.error?.error || event?.code || event?.subtype || '').toLowerCase();
  const fallback = kind || String(event?.message || event?.error?.message || stderr).toLowerCase();
  if (/auth|unauthori|credential|login|oauth/.test(fallback)) return 'AUTH_REQUIRED';
  if (/quota|billing|insufficient.credit/.test(fallback)) return 'QUOTA_EXHAUSTED';
  if (/rate.limit|too.many.requests|429|overloaded/.test(fallback)) return 'RATE_LIMITED';
  if (/enoent|not.found/.test(fallback)) return 'CLI_NOT_FOUND';
  return exitCode === 0 ? null : 'WORKER_CRASHED';
}
