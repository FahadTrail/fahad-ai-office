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

const IDLE_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
// Workspace-scoped jobs always use the fail-closed policy gateway. The global
// flag remains the explicit switch for legacy jobs that have no workspace.
const workspacePolicyStore = new SupabaseWorkspacePolicyStore(db);
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

function heartbeat() {
  writeFileSync('/tmp/fahad-office-health.json', JSON.stringify({
    pid: process.pid, updatedAt: Date.now(), lastPollAt, busy, pollIntervalMs: IDLE_MS,
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
  const toolCanary = await runProductionToolBrokerCanary({
    db,
    broker: toolBroker,
    policyStore: workspacePolicyStore,
    transport: safeCanaryTransport,
  });
  log('Tool Broker production canary verified:', JSON.stringify({
    workspaceId: toolCanary.workspaceId,
    discovered: toolCanary.discovered,
    replayVerified: toolCanary.replayVerified,
    rejectionTests: {
      agentDenied: toolCanary.agentDenied,
      missingGrantDenied: toolCanary.missingGrantDenied,
      crossWorkspaceDenied: toolCanary.crossWorkspaceDenied,
    },
    budgetDeltaUsd: toolCanary.budgetDeltaUsd,
  }));
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
