// Office Runtime v2: one durable Chief → Research → Chief workflow worker.
// It opens no ports and performs no AI work while idle.

import { writeFileSync } from 'node:fs';
import { db, store, log } from './db.js';
import { OfficeWorkflow } from './workflow.js';
import { checkHealth } from './healthcheck.js';
import { CHIEF_MODEL, RESEARCH_MODEL, WORKSPACE_POLICY_ENFORCEMENT_ENABLED } from './config.js';
import { SupabaseWorkspacePolicyStore } from './workspace-policy/supabase-store.js';

const IDLE_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
// Workspace-scoped jobs always use the fail-closed policy gateway. The global
// flag remains the explicit switch for legacy jobs that have no workspace.
const workspacePolicyStore = new SupabaseWorkspacePolicyStore(db);
const workflow = new OfficeWorkflow({
  store,
  workspacePolicyStore,
  enforceLegacyWorkspacePolicy: WORKSPACE_POLICY_ENFORCEMENT_ENABLED,
});
let running = true;
let busy = false;
let lastPollAt = 0;
let heartbeatTimer;

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
  log('Shutdown signal received. Finishing current task, then stopping.');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!Number.isFinite(IDLE_MS) || IDLE_MS < 1000 || IDLE_MS > 60000) throw new Error('Invalid POLL_INTERVAL_MS');
  await checkHealth();
  heartbeatTimer = setInterval(heartbeat, 5000);
  log('------------------------------------------------------------');
  log('Fahad AI Office - Runtime v2 (Chief -> Research -> Chief)');
  log('Agents online: Chief of Staff, Research & Strategy');
  log('Models: Chief=' + CHIEF_MODEL + ', Research=' + RESEARCH_MODEL);
  log('Idle check every ' + IDLE_MS + 'ms. No ports exposed.');
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
