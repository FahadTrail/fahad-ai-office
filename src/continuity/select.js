export const DATA_CLASSES = Object.freeze(['PUBLIC', 'NORMAL', 'PRIVATE', 'CONFIDENTIAL']);
const BASIS = new Set(['MEASURED', 'PROVIDER_REPORTED', 'ESTIMATED', 'UNKNOWN']);

function supportsPrivacy(capabilities, dataClass) {
  const allowed = capabilities?.privacyClasses || capabilities?.dataClasses || [];
  return allowed.includes(dataClass);
}
function supportsTask(capabilities, task) {
  if (task.requiresHeadless && !capabilities?.headless) return false;
  if (task.size && Array.isArray(capabilities?.taskSizes) && !capabilities.taskSizes.includes(task.size)) return false;
  if (task.capability && Array.isArray(capabilities?.taskTypes) && !capabilities.taskTypes.includes(task.capability)) return false;
  return true;
}
function capacityHeadroom(usage = {}) {
  if (!BASIS.has(usage.basis)) return 0;
  const used = [usage.session_pct, usage.weekly_pct].filter(Number.isFinite);
  if (!used.length) return usage.basis === 'UNKNOWN' ? 0 : 50;
  return Math.max(0, 100 - Math.max(...used));
}
export function evaluateWorker(worker, adapter, task, { now = Date.now() } = {}) {
  const capabilities = adapter?.capabilities?.() || worker.capabilities || {};
  const availability = worker.availability || { ok: false, reason: 'availability not checked' };
  const health = worker.health_state || { status: worker.health || 'unknown', basis: worker.health_basis || 'UNKNOWN' };
  const usage = worker.usage || { basis: 'UNKNOWN' };
  const reasons = [];
  if (!worker.enabled) reasons.push('WORKER_DISABLED');
  if (!availability.ok) reasons.push(availability.reason || 'WORKER_UNAVAILABLE');
  if (health.status === 'down') reasons.push('WORKER_DOWN');
  if (worker.cooldown_until && Date.parse(worker.cooldown_until) > Number(now)) reasons.push('WORKER_COOLDOWN');
  if (usage.quota_exhausted || usage.session_pct >= 100 || usage.weekly_pct >= 100) reasons.push('QUOTA_EXHAUSTED');
  if (!supportsPrivacy(capabilities, task.dataClass || 'NORMAL')) reasons.push('PRIVACY_MISMATCH');
  if (!supportsTask(capabilities, task)) reasons.push('CAPABILITY_MISMATCH');
  if (task.excludeWorkers?.includes(worker.key)) reasons.push('WORKER_EXCLUDED');
  const quality = Number(capabilities.quality?.[task.capability || 'coding'] ?? capabilities.quality ?? 0);
  const fit = Number(capabilities.taskFit?.[task.size || 'medium'] ?? 0);
  const included = capabilities.costClass === 'free' || capabilities.costClass === 'included';
  const speed = Number(capabilities.speed ?? 0);
  const switchPenalty = worker.key === task.lastWorker && !task.meaningfulProgress ? 25 : 0;
  const score = quality * 1_000_000 + capacityHeadroom(usage) * 10_000 + fit * 1_000 + (included ? 100 : 0) + speed - switchPenalty;
  return { worker, adapter, capabilities, availability, health, usage, eligible: reasons.length === 0, reasons, score };
}
export async function selectWorker({ workers, adapters, task, history = null, now = Date.now() }) {
  const evaluated = [];
  for (const worker of workers) {
    const adapter = adapters instanceof Map ? adapters.get(worker.key) : adapters?.[worker.key];
    if (!adapter) {
      evaluated.push({ worker, adapter: null, eligible: false, reasons: ['ADAPTER_MISSING'], score: -Infinity });
      continue;
    }
    const [availability, health, usage] = await Promise.all([adapter.available(), adapter.health(), adapter.usage({ session: task.session || null })]);
    evaluated.push(evaluateWorker({ ...worker, availability, health_state: health, usage }, adapter, task, { now }));
  }
  const loop = history?.detectLoop?.();
  if (loop?.loop) return { selected: null, evaluated, blocker: 'HANDOFF_LOOP_DETECTED', loop };
  const eligible = evaluated.filter((entry) => entry.eligible).sort((a, b) => b.score - a.score || a.worker.key.localeCompare(b.worker.key));
  return { selected: eligible[0] || null, evaluated, blocker: eligible.length ? null : 'NO_ELIGIBLE_WORKER' };
}
export function dedupeQuotaSources(items) {
  const sources = new Map();
  for (const item of items || []) {
    const key = item.quota_source;
    if (!key) continue;
    const previous = sources.get(key);
    if (!previous || Date.parse(item.taken_at || 0) > Date.parse(previous.taken_at || 0)) sources.set(key, item);
  }
  return [...sources.values()];
}

export class HandoffHistory {
  constructor({ maxEntries = 8, repeatedFailureLimit = 3 } = {}) {
    this.maxEntries = maxEntries;
    this.repeatedFailureLimit = repeatedFailureLimit;
    this.entries = [];
  }

  add({ from, to, reason, lastCommit, checkpointId, progress = false }) {
    this.entries.push({ from, to, reason, lastCommit, checkpointId, progress });
    if (this.entries.length > this.maxEntries) this.entries.shift();
  }

  detectLoop() {
    const recent = this.entries.slice(-4);
    const alternating = recent.length === 4 && recent.every((entry) => !entry.progress)
      && recent[0].from === recent[1].to && recent[0].to === recent[1].from
      && recent[0].from === recent[2].from && recent[0].to === recent[2].to
      && recent[1].from === recent[3].from && recent[1].to === recent[3].to;
    if (alternating) return { loop: true, reason: 'alternating workers without progress', entries: recent };
    const tail = this.entries.slice(-this.repeatedFailureLimit);
    const repeated = tail.length === this.repeatedFailureLimit && tail.every((entry) => !entry.progress && entry.reason === tail[0].reason);
    return repeated ? { loop: true, reason: `repeated ${tail[0].reason}`, entries: tail } : { loop: false };
  }
}
