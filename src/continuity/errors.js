export const CONTINUITY_ERROR_CODES = Object.freeze([
  'AUTH_REQUIRED', 'CLI_NOT_FOUND', 'UNSUPPORTED_VERSION', 'RATE_LIMITED', 'QUOTA_EXHAUSTED',
  'WORKER_CRASHED', 'SANDBOX_UNAVAILABLE', 'CHECKPOINT_FAILED', 'LEASE_LOST', 'HANDOFF_FAILED',
  'NO_ELIGIBLE_WORKER', 'PRIVACY_MISMATCH', 'WORKER_TIMEOUT', 'WORKER_STOP_UNCONFIRMED',
  'WORKER_OUTPUT_INVALID', 'WORKTREE_UNSAFE',
]);

// Vendor-neutral recognition of an OS isolation failure. One external worker's
// sandbox (bubblewrap, landlock, seccomp, a host AppArmor policy) must never
// become the Continuity core's assumption: any worker whose isolation layer
// cannot start is reported as unavailable instead of being treated as a
// successful turn or as a generic crash. Only actual denial wording matches,
// so informational sandbox output on a healthy run never trips it.
const SANDBOX_DENIAL = /(^|\n)\s*bwrap:|no permissions? to create a new namespace/i;
export function sandboxDenial(text) {
  return SANDBOX_DENIAL.test(String(text || ''));
}

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
  const kind = String(event?.error?.codex_error_info || event?.error?.type || event?.error?.code || event?.error?.error || event?.code || event?.subtype || '').toLowerCase();
  const fallback = kind || String(event?.message || event?.error?.message || stderr).toLowerCase();
  if (/auth|unauthori|credential|login|oauth/.test(fallback)) return 'AUTH_REQUIRED';
  if (/quota|billing|insufficient.credit|usage.limit/.test(fallback)) return 'QUOTA_EXHAUSTED';
  if (/rate.limit|too.many.requests|429|overloaded/.test(fallback)) return 'RATE_LIMITED';
  if (/enoent|not.found/.test(fallback)) return 'CLI_NOT_FOUND';
  if (sandboxDenial(stderr) || sandboxDenial(event?.item?.aggregated_output)) return 'SANDBOX_UNAVAILABLE';
  return exitCode === 0 ? null : 'WORKER_CRASHED';
}
