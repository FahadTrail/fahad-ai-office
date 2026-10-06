// One event per runtime start, so the running version and every restart are
// visible from the database even when /healthz cannot be reached (V5.4
// operability). Metadata only: the deployed commit, the code fingerprint and
// the process id. Recording it never blocks or fails the runtime.

import { codeFingerprint } from '../build-info.js';
import { readDeployedVersion } from '../hub-coding.js';

export function runtimeStartedEvent({ version = null, fingerprint = null, pid = null, startedAt = new Date().toISOString() } = {}) {
  return {
    type: 'activity', level: 'info',
    message: `Office runtime started${version ? ` on commit ${version}` : ''}.`,
    payload: { kind: 'runtime_started', version: version || null, codeFingerprint: fingerprint || null, pid: Number.isInteger(pid) ? pid : null, startedAt },
  };
}

export async function recordRuntimeStart(db, log = () => {}, { version = readDeployedVersion(), fingerprint = safeFingerprint(), pid = process.pid } = {}) {
  try {
    const { error } = await db.from('events').insert(runtimeStartedEvent({ version, fingerprint, pid }));
    if (error) log('WARN runtime start not recorded:', error.message);
    return !error;
  } catch (error) {
    log('WARN runtime start not recorded:', error?.message || 'error');
    return false;
  }
}

function safeFingerprint() {
  try { return codeFingerprint(); } catch { return null; }
}
