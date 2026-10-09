// One event per runtime start, so the running version and every restart are
// visible from the database even when /healthz cannot be reached (V5.4
// operability). Metadata only: the deployed commit, the code fingerprint and
// the process id. Recording it never blocks or fails the runtime.
//
// The deployed commit comes from logs/deployed-sha, which ops/deploy.sh writes
// only AFTER the new container is up and healthy. Read at boot, that file
// still names the PREVIOUS commit, so the runtime reported the old version
// after every release. The version is therefore trusted only when the file is
// newer than this process (written by this deployment), or when this exact
// code (its fingerprint) was already confirmed at that commit (a plain
// restart). Otherwise the runtime waits for the deployment to write it.

import { statSync } from 'node:fs';
import { codeFingerprint } from '../build-info.js';
import { readDeployedVersion } from '../hub-coding.js';

const SHA_FILE = () => process.env.HUB_DEPLOYED_SHA_FILE || '/app/logs/deployed-sha';
const PROCESS_STARTED = Date.now() - Math.round(process.uptime() * 1000);
const resolved = { started: false, version: null, confirmed: false, source: null };

// Pure: what the running version is, from the file and what is already known.
export function decideVersion({ fileVersion = null, fileWrittenAt = null, processStartedAt, fingerprint = null, known = [] }) {
  if (!fileVersion) return { version: null, confirmed: false, source: null };
  if (fileWrittenAt !== null && fileWrittenAt >= processStartedAt) return { version: fileVersion, confirmed: true, source: 'deployment' };
  if (fingerprint && known.some((entry) => entry.fingerprint === fingerprint && entry.version === fileVersion)) return { version: fileVersion, confirmed: true, source: 'restart' };
  return { version: null, confirmed: false, source: null, stale: fileVersion };
}

// The version /healthz and the Hub report: the confirmed one, or null while a
// deployment has not yet recorded it (never the previous commit). A process
// that does not resolve it (a standalone Hub, tests) reads the file as before.
export function runtimeVersion({ path = SHA_FILE() } = {}) {
  if (!resolved.started) return readDeployedVersion(path);
  return resolved.confirmed ? resolved.version : null;
}

export function runtimeStartedEvent({ version = null, fingerprint = null, pid = null, startedAt = new Date().toISOString(), source = null, stale = null } = {}) {
  return {
    type: 'activity', level: 'info',
    message: `Office runtime started${version ? ` on commit ${version}` : ''}.`,
    payload: { kind: 'runtime_started', version: version || null, codeFingerprint: fingerprint || null, pid: Number.isInteger(pid) ? pid : null, startedAt,
      versionConfirmed: Boolean(version), ...(source ? { versionSource: source } : {}), ...(stale ? { staleVersion: stale } : {}) },
  };
}

function fileState(path) {
  try { return { fileVersion: readDeployedVersion(path), fileWrittenAt: statSync(path).mtimeMs }; } catch { return { fileVersion: null, fileWrittenAt: null }; }
}

async function confirmedVersions(db, fingerprint) {
  if (!fingerprint) return [];
  try {
    const { data } = await db.from('events').select('payload').eq('payload->>kind', 'runtime_started').eq('payload->>codeFingerprint', fingerprint)
      .eq('payload->>versionConfirmed', 'true').order('created_at', { ascending: false }).limit(5);
    return (data || []).map((row) => ({ fingerprint: row.payload?.codeFingerprint, version: row.payload?.version })).filter((entry) => entry.version);
  } catch { return []; }
}

// Records the start once the version is known (at most `waitMs` later).
export async function recordRuntimeStart(db, log = () => {}, { fingerprint = safeFingerprint(), pid = process.pid, path = SHA_FILE(), processStartedAt = PROCESS_STARTED,
  waitMs = 15 * 60_000, pollMs = 5000, sleep = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); }), now = () => Date.now() } = {}) {
  resolved.started = true;
  try {
    const known = await confirmedVersions(db, fingerprint);
    const deadline = now() + waitMs;
    let decision = decideVersion({ ...fileState(path), processStartedAt, fingerprint, known });
    while (!decision.confirmed && now() < deadline) {
      await sleep(pollMs);
      decision = decideVersion({ ...fileState(path), processStartedAt, fingerprint, known });
    }
    Object.assign(resolved, { started: true, version: decision.version, confirmed: decision.confirmed, source: decision.source });
    const { error } = await db.from('events').insert(runtimeStartedEvent({ version: decision.version, fingerprint, pid, source: decision.source, stale: decision.stale }));
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
