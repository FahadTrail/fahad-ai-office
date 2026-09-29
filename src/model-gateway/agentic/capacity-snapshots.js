// Daily capacity snapshots (Capacity V2, Part 26).
//
// Once per UTC day the Office runtime stores a compact summary of the
// capacity model, so capacity over time (and the effect of each new key or
// qualification) can be measured instead of remembered. Tolerant: when the
// table does not exist yet (migration not applied) it logs once and stops
// trying until the next restart. Metadata only.

export function snapshotSummary(view) {
  const capacity = view?.capacity || {};
  const pick = (entry) => (entry ? { tokensPerDay: entry.tokensPerDay, tokensToday: entry.tokensToday, pools: entry.pools, unknownPools: entry.unknownPools } : null);
  return {
    freeTokensPerDay: capacity.freeTokensPerDay ?? null,
    freeTokensPerMonth: capacity.freeTokensPerMonth ?? null,
    coding: pick(capacity.coding),
    codingJobsPerDay: Object.fromEntries(Object.entries(capacity.coding?.jobsPerDay || {}).map(([size, entry]) => [size, entry.jobsPerDay])),
    strongReasoning: pick(capacity.strongReasoning),
    research: pick(capacity.research),
    finance: pick(capacity.finance),
    projectsPerDay: capacity.projectsPerDay || null,
    healthyPools: capacity.healthyPools ?? null,
    exhaustedPools: capacity.exhaustedPools ?? null,
    independentFreePools: capacity.independentFreePools ?? null,
    lifecycle: capacity.lifecycle || null,
    freeUtilizationToday: capacity.freeUtilizationToday ?? null,
    costUsd: capacity.costUsd || null,
    pools: (capacity.pools || []).map((pool) => ({ id: pool.id, state: pool.state, effectivePerDay: pool.effectivePerDay, classes: pool.classes, codingGrade: pool.codingGrade })),
    tokensToday: view?.summary?.tokensToday ?? null,
    ownerActionsPending: (view?.ownerActions || []).filter((action) => action.status === 'pending').map((action) => action.id),
  };
}

export class CapacitySnapshotter {
  constructor({ db, capacityView, log = () => {}, now = () => Date.now() }) {
    this.db = db;
    this.capacityView = capacityView;
    this.log = log;
    this.now = now;
    this.lastDay = null;
    this.disabled = false;
    this.active = null;
  }

  // Cheap to call on every runtime tick: at most one write per UTC day.
  maybeRun() {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.disabled || this.active || this.lastDay === day || (this.retryAt && this.now() < this.retryAt)) return false;
    this.active = this.run(day).finally(() => { this.active = null; });
    return true;
  }

  async run(day) {
    try {
      const view = await this.capacityView();
      const { error } = await this.db.from('capacity_snapshots')
        .upsert({ snapshot_date: day, taken_at: new Date(this.now()).toISOString(), summary: snapshotSummary(view) }, { onConflict: 'snapshot_date' });
      if (error) {
        if (/capacity_snapshots|does not exist|schema cache|42P01|PGRST205/i.test(`${error.code || ''} ${error.message || ''}`)) {
          this.disabled = true;
          this.log('Capacity snapshots are off until the capacity_snapshots migration is applied.');
        } else {
          this.retryAt = this.now() + 3600_000;
          this.log('WARN capacity snapshot not stored:', error.code || error.message);
        }
        return false;
      }
      this.lastDay = day;
      this.log('Capacity snapshot stored for', day);
      return true;
    } catch (error) {
      this.log('WARN capacity snapshot failed:', error?.code || error?.message);
      this.lastDay = day; // retry tomorrow, never in a tight loop
      return false;
    }
  }
}
