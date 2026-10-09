// The native Coding worker's presence. The worker used to write its heartbeat
// only to a local file (the container health check), so its registry row in
// coding_workers stayed health "unknown" with no last_seen_at, forever. The
// worker now stamps that row on a timer — independent of the session loop, so
// a long session never makes it look gone — and the Hub derives one honest
// status from measured facts only.

export const PRESENCE_INTERVAL_MS = 60_000;
// Three missed beats: the worker is offline (stopped, crashed or cut off).
export const OFFLINE_AFTER_MS = 3 * PRESENCE_INTERVAL_MS + 15_000;

export function presencePatch(now = new Date()) {
  return { health: 'healthy', health_basis: 'MEASURED', last_seen_at: now.toISOString(), last_error: null, updated_at: now.toISOString() };
}

// Stamps coding_workers[key] now and every intervalMs. Never throws.
export function startPresence({ db, key = 'office', log = () => {}, intervalMs = PRESENCE_INTERVAL_MS, now = () => new Date() }) {
  let warned = false;
  const beat = async () => {
    try {
      const { error } = await db.from('coding_workers').update(presencePatch(now())).eq('key', key);
      if (error && !warned) { warned = true; log('WARN worker presence not recorded:', error.message); }
      if (!error) warned = false;
    } catch (error) {
      if (!warned) { warned = true; log('WARN worker presence not recorded:', error?.message || 'error'); }
    }
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();
  return { beat, stop: () => clearInterval(timer) };
}

// One status, only from what is measured: switched off, no beat yet, beat
// too old, a session waiting on Fahad, a session running, or idle.
//   DISABLED · UNKNOWN · OFFLINE · BLOCKED · ACTIVE · IDLE
export function workerLiveStatus({ enabled, lastSeenAt = null, running = 0, blocked = 0, now = Date.now() }) {
  if (!enabled) return { status: 'DISABLED', detail: 'Switched off' };
  if (!lastSeenAt) return { status: 'UNKNOWN', detail: 'Has not reported since it was enabled' };
  const age = now - Date.parse(lastSeenAt);
  if (!Number.isFinite(age) || age > OFFLINE_AFTER_MS) return { status: 'OFFLINE', detail: `No heartbeat for ${Math.round(Math.max(0, age) / 60_000)} min` };
  if (running > 0) return { status: 'ACTIVE', detail: `${running} task${running === 1 ? '' : 's'} running` };
  if (blocked > 0) return { status: 'BLOCKED', detail: `${blocked} task${blocked === 1 ? '' : 's'} waiting for Fahad` };
  return { status: 'IDLE', detail: 'Online, no task running' };
}
