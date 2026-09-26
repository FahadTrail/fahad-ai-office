// Runs owner-requested live provider canaries inside the Office runtime,
// which already holds the provider credentials. Requests are rows in
// provider_canary_runs; nothing runs (and nothing is billed) unless one is
// queued. The report is metadata only.

import { runAgenticCanary } from './agentic-canary.js';
import { parseRouteId } from '../model-gateway/agentic/route-id.js';
import { runtimeDiagnostics } from './runtime-diagnostics.js';
import { refreshOpenRouterCatalog } from '../model-gateway/agentic/openrouter-catalog.js';
import { rankFreeModels } from '../model-gateway/agentic/capabilities.js';

export class CanaryRequestRunner {
  constructor({ db, stateStore, env = process.env, log = () => {}, run = runAgenticCanary, intervalMs = 60_000, now = () => Date.now(), diagnostics = runtimeDiagnostics, refreshCatalog = refreshOpenRouterCatalog, background = false }) {
    // background: the runtime loop starts a claimed canary and keeps
    // processing Office jobs while it runs (a live canary can take minutes).
    this.background = background;
    this.active = null;
    this.refreshCatalog = refreshCatalog;
    this.diagnostics = diagnostics;
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

  // The failover drill's checkpoint is written to the run row and read back
  // from the database before the backup provider is prompted.
  checkpointStore(runId) {
    const db = this.db;
    return {
      location: 'provider_canary_runs.report.failoverCheckpoint',
      async save(checkpoint) {
        const { error } = await db.from('provider_canary_runs').update({ report: { inProgress: true, failoverCheckpoint: checkpoint } }).eq('id', runId);
        if (error) throw Object.assign(new Error('checkpoint write failed'), { code: 'CHECKPOINT_WRITE_FAILED' });
      },
      async load() {
        const { data, error } = await db.from('provider_canary_runs').select('report').eq('id', runId).maybeSingle();
        if (error) throw Object.assign(new Error('checkpoint read failed'), { code: 'CHECKPOINT_READ_FAILED' });
        return data?.report?.failoverCheckpoint || null;
      },
    };
  }

  // Called from the runtime loop; cheap when nothing is queued.
  async maybeRun() {
    if (this.active || this.unavailable || this.now() - this.lastCheck < this.intervalMs) return false;
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
    const execution = this.execute(request)
      .catch((error) => this.log('WARN  provider canary bookkeeping failed:', error?.code || error?.message))
      .finally(() => { this.active = null; });
    this.active = execution;
    if (!this.background) await execution;
    return true;
  }

  async execute(request) {
    try {
      // Current OpenRouter free models before probing (keeps the last good
      // catalog when OpenRouter's catalog API is unavailable).
      await this.refreshCatalog({ env: this.env, log: this.log, rank: (left, right) => rankFreeModels(left, right, this.env) }).catch(() => null);
      const checkpointStore = this.checkpointStore(request.id);
      const report = await this.run({ env: this.env, stateStore: this.stateStore, log: () => {}, checkpointStore });
      const checkpoint = await checkpointStore.load().catch(() => null);
      if (checkpoint) {
        const { recentMessages, ...summary } = checkpoint;
        report.failoverCheckpoint = { ...summary, recentMessageCount: recentMessages?.length || 0, storedIn: 'provider_canary_runs.report' };
      }
      report.runtimeDiagnostics = await this.diagnostics({ env: this.env }).catch((error) => ({ error: String(error?.code || 'DIAGNOSTICS_FAILED').slice(0, 60) }));
      const verified = report.routes.filter((route) => route.ok).map((route) => route.id);
      for (const id of verified) {
        const { provider, model } = parseRouteId(id);
        await this.db.from('provider_status').update({ verified_at: new Date(this.now()).toISOString() })
          .eq('provider', provider).eq('model', model);
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
  }
}
