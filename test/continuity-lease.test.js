import test from 'node:test';
import assert from 'node:assert/strict';
import { LeaseManager } from '../src/continuity/lease.js';

class FakeClock {
  constructor(now = Date.parse('2026-10-01T12:00:00Z')) { this.time = now; this.timers = new Map(); this.next = 1; }
  now = () => this.time;
  setInterval = (fn, ms) => { const id = this.next++; this.timers.set(id, { fn, ms, at: this.time + ms }); return id; };
  clearInterval = (id) => this.timers.delete(id);
  async advance(ms) { this.time += ms; for (const timer of this.timers.values()) if (timer.at <= this.time) { timer.at += timer.ms; await timer.fn(); } }
}

function store() {
  const leases = new Map();
  return {
    leases,
    async acquireLease(session) {
      if ([...leases.values()].some((lease) => lease.session !== session && lease.status === 'ACTIVE')) throw Object.assign(new Error('CODING_LEASE_HELD'), { code: '55P03' });
      const lease = { id: `lease-${session}`, token: `token-${session}`, session, status: 'ACTIVE', expires_at: '2026-10-01T12:05:00Z' };
      leases.set(lease.id, lease); return { ...lease };
    },
    async heartbeatLease(id, token) { const lease = leases.get(id); return Boolean(lease && lease.token === token && lease.status === 'ACTIVE'); },
    async releaseLease(id, token, checkpoint) { const lease = leases.get(id); if (!checkpoint) throw new Error('checkpoint required'); if (!lease || lease.token !== token) return false; lease.status = 'RELEASED'; return true; },
    async freezeStaleLeases() { const rows = [...leases.values()].filter((lease) => lease.status === 'ACTIVE'); rows.forEach((lease) => { lease.status = 'FROZEN'; }); return rows; },
    async reclaimLease(id) { const lease = leases.get(id); if (lease?.status !== 'FROZEN') return false; lease.status = 'RECLAIMED'; return true; },
  };
}

test('lease manager: one writer, token heartbeat and checkpoint-before-release', async () => {
  const backend = store();
  const clock = new FakeClock();
  const first = new LeaseManager({ store: backend, clock, heartbeatMs: 60_000 });
  const lease = await first.acquire('a');
  await assert.rejects(new LeaseManager({ store: backend, clock }).acquire('b'), /CODING_LEASE_HELD/);
  backend.leases.get(lease.id).token = 'wrong';
  await assert.rejects(first.heartbeat(lease), /HEARTBEAT_REJECTED/);
  backend.leases.get(lease.id).token = lease.token;
  await assert.rejects(first.release(lease, null), /CHECKPOINT_REQUIRED/);
  assert.equal(await first.release(lease, 'checkpoint-1'), true);
  await assert.rejects(first.heartbeat(lease), /NOT_HELD/);
});
test('lease manager: heartbeat timer detects loss and stale leases require verified reclaim', async () => {
  const backend = store();
  const clock = new FakeClock();
  const manager = new LeaseManager({ store: backend, clock, heartbeatMs: 60_000 });
  const lease = await manager.acquire('a');
  let lost = null;
  manager.startHeartbeat(lease, { onLost: (error) => { lost = error; } });
  backend.leases.get(lease.id).token = 'wrong';
  await clock.advance(60_000);
  assert.match(lost.message, /HEARTBEAT_REJECTED/);
  backend.leases.get(lease.id).status = 'ACTIVE';
  const [frozen] = await manager.freezeStale();
  await assert.rejects(manager.reclaim(frozen, { verify: async () => ({ ok: false, head: 'different' }) }), /VERIFICATION_FAILED/);
  const reclaimed = await manager.reclaim(frozen, { verify: async () => ({ ok: true, head: 'a'.repeat(40) }) });
  assert.equal(reclaimed.status, 'RECLAIMED');
});

test('lease manager: five-minute expiry is deterministically stale', () => {
  const clock = new FakeClock();
  const manager = new LeaseManager({ store: store(), clock });
  assert.equal(manager.isStale({ status: 'ACTIVE', expires_at: '2026-10-01T12:05:00Z' }), false);
  clock.time += 300_001;
  assert.equal(manager.isStale({ status: 'ACTIVE', expires_at: '2026-10-01T12:05:00Z' }), true);
  assert.equal(manager.isStale({ status: 'FROZEN', expires_at: '2026-10-01T12:00:00Z' }), false);
});

