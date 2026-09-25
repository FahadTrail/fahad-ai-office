// Office Runtime v2: one durable Chief → Research → Chief workflow worker.
// It opens no ports and performs no AI work while idle.

import { writeFileSync } from 'node:fs';
import { db, hubAuth, store, log } from './db.js';
import { OfficeWorkflow } from './workflow.js';
import { checkHealth } from './healthcheck.js';
import { CHIEF_MODEL, RESEARCH_MODEL, WORKSPACE_POLICY_ENFORCEMENT_ENABLED } from './config.js';
import { SupabaseWorkspacePolicyStore } from './workspace-policy/supabase-store.js';
import { ToolBroker } from './tool-broker/broker.js';
import { SAFE_CANARY_TOOL_DEFINITIONS, createSafeCanaryMcpClient } from './tool-broker/canary-tools.js';
import { runProductionToolBrokerCanary } from './tool-broker/production-canary.js';
import { SupabaseToolBrokerStore } from './tool-broker/supabase-store.js';
import { createHubServer } from './hub-server.js';
import { runStartupCanary } from './startup-canary.js';
import { configureSharedProviderHealth } from './model-runner.js';
import { SupabaseProviderStateStore } from './model-gateway/agentic/provider-state.js';
import { CanaryRequestRunner } from './canary/canary-requests.js';
import { refreshOpenRouterCatalog } from './model-gateway/agentic/openrouter-catalog.js';
import { rankFreeModels } from './model-gateway/agentic/capabilities.js';

const IDLE_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
// Workspace-scoped jobs always use the fail-closed policy gateway. The global
// flag remains the explicit switch for legacy jobs that have no workspace.
const workspacePolicyStore = new SupabaseWorkspacePolicyStore(db);
const providerStateStore = new SupabaseProviderStateStore(db);
configureSharedProviderHealth(providerStateStore);
const canaryRequests = new CanaryRequestRunner({ db, stateStore: providerStateStore, log });
// OpenRouter free models are discovered from OpenRouter's API at startup and
// every 6 hours; the Hub and the canary read the in-process catalog.
const refreshCatalog = () => refreshOpenRouterCatalog({ log, rank: (left, right) => rankFreeModels(left, right, process.env) }).catch(() => null);
refreshCatalog();
setInterval(refreshCatalog, 6 * 60 * 60 * 1000).unref();
const toolBrokerStore = new SupabaseToolBrokerStore(db);
const { client: safeCanaryClient, transport: safeCanaryTransport } = createSafeCanaryMcpClient();
const toolBroker = new ToolBroker({
  policyStore: workspacePolicyStore,
  auditStore: toolBrokerStore,
  agentStore: toolBrokerStore,
  clients: [safeCanaryClient],
  definitions: SAFE_CANARY_TOOL_DEFINITIONS,
});
const workflow = new OfficeWorkflow({
  store,
  workspacePolicyStore,
  enforceLegacyWorkspacePolicy: WORKSPACE_POLICY_ENFORCEMENT_ENABLED,
  toolBroker,
});
let running = true;
let busy = false;
let lastPollAt = 0;
let heartbeatTimer;
let hubServer;
let toolBrokerCanary = { status: 'pending' };

function heartbeat() {
  writeFileSync('/tmp/fahad-office-health.json', JSON.stringify({
    pid: process.pid, updatedAt: Date.now(), lastPollAt, busy, pollIntervalMs: IDLE_MS,
    toolBrokerCanary: toolBrokerCanary.status,
  }), { mode: 0o600 });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
  if (!running) return;
  running = false;
  hubServer?.close();
  log('Shutdown signal received. Finishing current task, then stopping.');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!Number.isFinite(IDLE_MS) || IDLE_MS < 1000 || IDLE_MS > 60000) throw new Error('Invalid POLL_INTERVAL_MS');
  await checkHealth();
  if (process.env.HUB_ENABLED !== 'false') {
    hubServer = createHubServer({ db, authClient: hubAuth, store });
    log('Fahad AI Hub listening on the protected loopback port 2132.');
  }
  toolBrokerCanary = await runStartupCanary({
    log,
    canary: () => runProductionToolBrokerCanary({
      db,
      broker: toolBroker,
      policyStore: workspacePolicyStore,
      transport: safeCanaryTransport,
    }),
  });
  heartbeatTimer = setInterval(heartbeat, 5000);
  log('------------------------------------------------------------');
  log('Fahad AI Office - Runtime v2 (Chief -> Research -> Chief)');
  log('Agents online: Chief of Staff, Research & Strategy');
  log('Models: Chief=' + CHIEF_MODEL + ', Research=' + RESEARCH_MODEL);
  log('Idle check every ' + IDLE_MS + 'ms. Hub provides the protected task interface.');
  log('------------------------------------------------------------');

  while (running) {
    try {
      busy = true;
      const progressed = await workflow.runOnce();
      // Owner-requested live provider canaries (no-op unless one is queued).
      if (!progressed) await canaryRequests.maybeRun().catch((error) => log('WARN  canary runner:', error.message));
      lastPollAt = Date.now();
      busy = false;
      heartbeat();
      if (!progressed) await sleep(IDLE_MS);
    } catch (error) {
      busy = false;
      lastPollAt = Date.now();
      heartbeat();
      log('RUNTIME ERROR:', error.message || error);
      await sleep(IDLE_MS * 2);
    }
  }

  clearInterval(heartbeatTimer);
  log('Runtime stopped cleanly.');
}

main().catch((error) => {
  log('FATAL:', error.message || error);
  process.exit(1);
});
