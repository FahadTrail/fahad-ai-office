// Runs owner-requested live provider canaries inside the Office runtime,
// which already holds the provider credentials. Requests are rows in
// provider_canary_runs; nothing runs (and nothing is billed) unless one is
// queued. The report is metadata only.

import { runAgenticCanary } from './agentic-canary.js';

export class CanaryRequestRunner {
  constructor({ db, stateStore, env = process.env, log = () => {}, run = runAgenticCanary, intervalMs = 60_000, now = () => Date.now() }) {
    this.db = db;
    this.stateStore = stateStore;
    this.env = env;
    this.log = log;
    this.run = run;
    this.intervalMs = intervalMs;
    this.now = now;
    this.lastCheck = 0;
    this.unavailable = false;
  }

  // Called from the runtime loop; cheap when nothing is queued.
  async maybeRun() {
    if (this.unavailable || this.now() - this.lastCheck < this.intervalMs) return false;
    this.lastCheck = this.now();
    const { data, error } = await this.db.rpc('claim_provider_canary_run');
    if (error) {
      if (/Could not find the function|does not exist|PGRST20/i.test(`${error.message} ${error.code}`)) {
        this.unavailable = true;
        this.log('Provider canary requests are not installed yet; skipping.');
        return false;
      }
      this.log('WARN  canary claim failed:', error.message);
      return false;
    }
    const request = Array.isArray(data) ? data[0] : data;
    if (!request?.id) return false;
    this.log('Running requested live provider canary', request.id);
    try {
      const report = await this.run({ env: this.env, stateStore: this.stateStore, log: () => {} });
      const verified = report.routes.filter((route) => route.ok).map((route) => route.id);
      for (const id of verified) {
        const [provider, ...model] = id.split(':');
        await this.db.from('provider_status').update({ verified_at: new Date(this.now()).toISOString() })
          .eq('provider', provider).eq('model', model.join(':'));
      }
      await this.db.from('provider_canary_runs').update({
        status: 'completed', completed_at: new Date(this.now()).toISOString(), report,
      }).eq('id', request.id);
      this.log('Provider canary completed:', JSON.stringify({ verified, failover: report.failover?.ok ?? null }));
    } catch (error) {
      await this.db.from('provider_canary_runs').update({
        status: 'failed', completed_at: new Date(this.now()).toISOString(), error: String(error?.code || error?.message || 'CANARY_FAILED').slice(0, 200),
      }).eq('id', request.id);
      this.log('WARN  provider canary failed:', error?.code || error?.message);
    }
    return true;
  }
}
