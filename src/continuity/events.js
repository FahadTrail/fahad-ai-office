import { redact } from '../coding-agent/policy.js';
import { sanitizeContinuityValue } from './safe.js';

export const CONTINUITY_EVENTS = Object.freeze([
  'WORKER_STARTED', 'WORKER_STOPPED', 'WORKER_FAILED', 'WORKER_AUTH_BLOCKED',
  'LEASE_ACQUIRED', 'LEASE_HEARTBEAT', 'LEASE_RELEASED', 'LEASE_FROZEN', 'LEASE_RECLAIMED',
  'CHECKPOINT_SAVED', 'WORKER_DRAINING', 'HANDOFF_REQUESTED', 'HANDOFF_PROPOSED',
  'HANDOFF_ACCEPTED', 'HANDOFF_FAILED', 'WORKER_SWITCHED',
  'RECOVERY_STARTED', 'RECOVERY_COMPLETED', 'SESSION_COMPLETED', 'SESSION_FAILED',
]);

export class ContinuityEvents {
  constructor({ store, log = () => {}, env = process.env } = {}) { this.store = store; this.log = log; this.env = env; }
  async emit(event, payload = {}, { level = 'info', message = event } = {}) {
    if (!CONTINUITY_EVENTS.includes(event)) throw new TypeError(`Unknown continuity event: ${event}`);
    const safePayload = sanitizeContinuityValue(payload, this.env);
    const safeMessage = redact(message, this.env, 2000);
    this.log(`continuity ${event}`, safePayload);
    if (this.store?.recordEvent) await this.store.recordEvent(event, { level, message: safeMessage, payload: safePayload });
    return { event, payload: safePayload };
  }
}
