import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { validateCheckpoint } from './checkpoint.js';

export const CHECKPOINT_EVENTS = Object.freeze(new Set([
  'milestone', 'meaningful_change', 'test', 'ci', 'architecture_decision',
  'provider_switch', 'handoff', 'manual', 'final', 'recovery',
]));

async function atomicJsonWrite(path, payload) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}
export class ContinuityCheckpointer {
  constructor({
    store,
    lease,
    mirrorPath = resolve('.continuity/checkpoint.json'),
    turns = 10,
    intervalMs = 15 * 60_000,
    clock = { now: () => Date.now() },
    writeMirror = atomicJsonWrite,
    env = process.env,
  } = {}) {
    if (!store) throw new TypeError('ContinuityCheckpointer requires a continuity store');
    if (!lease?.id || !lease?.token) throw new TypeError('ContinuityCheckpointer requires the active lease and token');
    this.store = store;
    this.lease = lease;
    this.mirrorPath = mirrorPath;
    this.turnLimit = turns;
    this.intervalMs = intervalMs;
    this.clock = clock;
    this.writeMirror = writeMirror;
    this.env = env;
    this.turnCount = 0;
    this.lastSavedAt = this.now();
    this.lastRow = null;
  }

  now() {
    const value = this.clock.now();
    return value instanceof Date ? value.getTime() : Number(value);
  }

  noteTurn(count = 1) {
    this.turnCount += count;
    return this.due().due;
  }

  due(event = null) {
    if (event && CHECKPOINT_EVENTS.has(event)) return { due: true, reason: event };
    if (this.turnCount >= this.turnLimit) return { due: true, reason: 'turn_interval' };
    if (this.now() - this.lastSavedAt >= this.intervalMs) return { due: true, reason: 'time_interval' };
    return { due: false, reason: null };
  }

  async maybeSave(buildPayload, { event = null, nativeCheckpointId = null } = {}) {
    const decision = this.due(event);
    if (!decision.due) return { saved: false, reason: null, row: null };
    const payload = typeof buildPayload === 'function' ? await buildPayload(decision.reason) : buildPayload;
    const row = await this.save(payload, { nativeCheckpointId });
    return { saved: true, reason: decision.reason, row };
  }

  async save(payload, { nativeCheckpointId = null, mirror = true } = {}) {
    const validation = validateCheckpoint(payload, { env: this.env });
    if (!validation.ok) {
      const error = new Error(`CONTINUITY_CHECKPOINT_INVALID: ${validation.errors.join('; ')}`);
      error.code = 'CONTINUITY_CHECKPOINT_INVALID';
      error.validationErrors = validation.errors;
      throw error;
    }
    const row = await this.store.saveCheckpoint(this.lease.id, this.lease.token, payload, nativeCheckpointId);
    if (!row?.id) throw new Error('CONTINUITY_CHECKPOINT_NOT_PERSISTED');
    if (mirror) await this.writeMirror(this.mirrorPath, payload);
    this.lastRow = row;
    this.turnCount = 0;
    this.lastSavedAt = this.now();
    return row;
  }
}

