const DEFAULT_LEASE_SECONDS = 300;
const DEFAULT_HEARTBEAT_MS = 60_000;

function normalizedLease(value) {
  const lease = Array.isArray(value) ? value[0] : value;
  if (!lease?.id || !lease?.token) throw new Error('CONTINUITY_LEASE_MALFORMED');
  return lease;
}
export class LeaseManager {
  constructor({ store, leaseSeconds = DEFAULT_LEASE_SECONDS, heartbeatMs = DEFAULT_HEARTBEAT_MS, clock = globalThis } = {}) {
    if (!store) throw new TypeError('LeaseManager requires a continuity store');
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 3600) throw new TypeError('leaseSeconds must be between 30 and 3600');
    if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1_000 || heartbeatMs >= leaseSeconds * 1000) throw new TypeError('heartbeatMs must be positive and shorter than the lease');
    this.store = store;
    this.leaseSeconds = leaseSeconds;
    this.heartbeatMs = heartbeatMs;
    this.clock = clock;
    this.active = new Map();
  }

  now() {
    const value = typeof this.clock.now === 'function' ? this.clock.now() : Date.now();
    return value instanceof Date ? value : new Date(value);
  }

  async acquire(sessionId, { onLost, onHeartbeat } = {}) {
    const lease = normalizedLease(await this.store.acquireLease(sessionId, this.leaseSeconds));
    const held = { lease, onLost, onHeartbeat, timer: null, heartbeatInFlight: false };
    this.active.set(lease.id, held);
    return lease;
  }

  startHeartbeat(leaseOrId, { onLost, onHeartbeat } = {}) {
    const leaseId = typeof leaseOrId === 'string' ? leaseOrId : leaseOrId?.id;
    const held = this.active.get(leaseId);
    if (!held) throw new Error('CONTINUITY_LEASE_NOT_HELD');
    if (onLost) held.onLost = onLost;
    if (onHeartbeat) held.onHeartbeat = onHeartbeat;
    if (held.timer) return held.timer;
    held.timer = this.clock.setInterval(async () => {
      if (held.heartbeatInFlight) return;
      held.heartbeatInFlight = true;
      try {
        const lease = await this.heartbeat(leaseId);
        await held.onHeartbeat?.(lease);
      } catch (error) {
        this.stopHeartbeat(leaseId);
        await held.onLost?.(error, held.lease);
      } finally {
        held.heartbeatInFlight = false;
      }
    }, this.heartbeatMs);
    held.timer?.unref?.();
    return held.timer;
  }

  stopHeartbeat(leaseOrId) {
    const leaseId = typeof leaseOrId === 'string' ? leaseOrId : leaseOrId?.id;
    const held = this.active.get(leaseId);
    if (held?.timer) this.clock.clearInterval(held.timer);
    if (held) held.timer = null;
  }

  async heartbeat(leaseOrId) {
    const leaseId = typeof leaseOrId === 'string' ? leaseOrId : leaseOrId?.id;
    const held = this.active.get(leaseId);
    if (!held) throw new Error('CONTINUITY_LEASE_NOT_HELD');
    const ok = await this.store.heartbeatLease(held.lease.id, held.lease.token, this.leaseSeconds);
    if (!ok) throw Object.assign(new Error('CONTINUITY_LEASE_HEARTBEAT_REJECTED'), { code: 'CONTINUITY_LEASE_HEARTBEAT_REJECTED' });
    held.lease.heartbeat_at = this.now().toISOString();
    held.lease.expires_at = new Date(this.now().getTime() + this.leaseSeconds * 1000).toISOString();
    return held.lease;
  }

  async release(leaseOrId, checkpointId, finalStatus = 'RELEASED') {
    if (!checkpointId) throw Object.assign(new Error('CONTINUITY_LEASE_CHECKPOINT_REQUIRED'), { code: 'CONTINUITY_LEASE_CHECKPOINT_REQUIRED' });
    const leaseId = typeof leaseOrId === 'string' ? leaseOrId : leaseOrId?.id;
    const held = this.active.get(leaseId);
    if (!held) throw new Error('CONTINUITY_LEASE_NOT_HELD');
    const ok = await this.store.releaseLease(held.lease.id, held.lease.token, checkpointId, finalStatus);
    if (!ok) throw new Error('CONTINUITY_LEASE_RELEASE_REJECTED');
    this.stopHeartbeat(leaseId);
    this.active.delete(leaseId);
    return true;
  }

  async freezeStale({ graceSeconds = 0 } = {}) {
    const frozen = await this.store.freezeStaleLeases(graceSeconds);
    for (const lease of frozen) {
      this.stopHeartbeat(lease.id);
      this.active.delete(lease.id);
    }
    return frozen;
  }

  async reclaim(lease, { verify }) {
    if (lease?.status !== 'FROZEN') throw new Error('CONTINUITY_RECLAIM_REQUIRES_FROZEN_LEASE');
    if (typeof verify !== 'function') throw new TypeError('Safe reclaim requires a branch verification function');
    const verification = await verify(lease);
    if (!verification?.ok) {
      const error = new Error('CONTINUITY_RECLAIM_VERIFICATION_FAILED');
      error.verification = verification || null;
      throw error;
    }
    const reclaimed = await this.store.reclaimLease(lease.id);
    if (!reclaimed) throw new Error('CONTINUITY_RECLAIM_REJECTED');
    return { ...lease, status: 'RECLAIMED', verification };
  }

  isStale(lease, at = this.now()) {
    if (!lease || lease.status !== 'ACTIVE') return false;
    const expiry = Date.parse(lease.expires_at);
    return Number.isFinite(expiry) && expiry < at.getTime();
  }

  stopAll() {
    for (const id of this.active.keys()) this.stopHeartbeat(id);
  }
}

