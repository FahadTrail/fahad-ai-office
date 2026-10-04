export const CONTINUITY_ERROR_CODES = Object.freeze([
  'AUTH_REQUIRED', 'CLI_NOT_FOUND', 'UNSUPPORTED_VERSION', 'RATE_LIMITED', 'QUOTA_EXHAUSTED',
  'WORKER_CRASHED', 'SANDBOX_UNAVAILABLE', 'CHECKPOINT_FAILED', 'LEASE_LOST', 'HANDOFF_FAILED',
  'NO_ELIGIBLE_WORKER', 'PRIVACY_MISMATCH', 'WORKER_TIMEOUT', 'WORKER_STOP_UNCONFIRMED',
  'WORKER_OUTPUT_INVALID', 'WORKTREE_UNSAFE',
]);

// Vendor-neutral Phase-N failure taxonomy. Every external-worker failure must
// be attributable to exactly one of these eight categories, whatever the
// underlying CLI calls it. The runtime keeps its existing codes (checkpoints,
// events and tests already store them); this map is the single shared
// vocabulary drills and reports use to *distinguish* the categories:
//   * SANDBOX_UNAVAILABLE is a run-time classification (the isolation layer
//     failed while a worker ran).
//   * HOST_CAPABILITY_REQUIRED is a readiness classification (the host cannot
//     start that isolation layer, so the worker is unavailable before a turn).
//   * PROCESS_FAILED groups the codes where the worker process itself failed
//     (crash, timeout, invalid output) as opposed to a stop that was never
//     confirmed (STOP_UNCONFIRMED).
// Codes outside this taxonomy (QUOTA_EXHAUSTED, LEASE_LOST, ...) are already
// unambiguous on their own and map to null.
export const FAILURE_TAXONOMY = Object.freeze({
  AUTH_REQUIRED: Object.freeze({ codes: Object.freeze(['AUTH_REQUIRED']) }),
  UNSUPPORTED_VERSION: Object.freeze({ codes: Object.freeze(['UNSUPPORTED_VERSION']) }),
  SANDBOX_UNAVAILABLE: Object.freeze({ codes: Object.freeze(['SANDBOX_UNAVAILABLE']) }),
  HOST_CAPABILITY_REQUIRED: Object.freeze({ authStates: Object.freeze(['HOST_CAPABILITY_REQUIRED']) }),
  RATE_LIMITED: Object.freeze({ codes: Object.freeze(['RATE_LIMITED']) }),
  PROCESS_FAILED: Object.freeze({ codes: Object.freeze(['WORKER_CRASHED', 'WORKER_TIMEOUT', 'WORKER_OUTPUT_INVALID']) }),
  STOP_UNCONFIRMED: Object.freeze({ codes: Object.freeze(['WORKER_STOP_UNCONFIRMED']) }),
  WORKTREE_UNSAFE: Object.freeze({ codes: Object.freeze(['WORKTREE_UNSAFE']) }),
});

// Readiness states win over run-time codes when both are present: a probe
// that reports SANDBOX_UNAVAILABLE together with HOST_CAPABILITY_REQUIRED is
// a readiness answer (the host cannot provide the isolation), while the same
// code raised from a running worker is a run-time SANDBOX_UNAVAILABLE.
export function failureCategory({ code = null, authState = null } = {}) {
  for (const [category, entry] of Object.entries(FAILURE_TAXONOMY)) {
    if (authState && entry.authStates?.includes(authState)) return category;
  }
  for (const [category, entry] of Object.entries(FAILURE_TAXONOMY)) {
    if (code && entry.codes?.includes(code)) return category;
  }
  return null;
}

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
