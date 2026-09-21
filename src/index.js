// Office Runtime v1.
// The only always-on process, and deliberately tiny. Holds no AI in
// memory and spends no tokens while idle. Opens no ports.

import { claimNextJob, log } from './db.js';
import { runJob } from './chief.js';
import { writeFileSync } from 'node:fs';
import { checkHealth } from './healthcheck.js';

const IDLE_MS = Number(process.env.POLL_INTERVAL_MS || 5000);

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
  log('Shutdown signal received. Finishing current job, then stopping.');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!Number.isFinite(IDLE_MS) || IDLE_MS < 1000 || IDLE_MS > 60000) throw new Error('Invalid POLL_INTERVAL_MS');
  await checkHealth();
  heartbeatTimer = setInterval(heartbeat, 5000);
  log('------------------------------------------------------------');
  log('Fahad AI Office - Runtime v1');
  log('Agents online: Chief of Staff');
  log('Model: ' + (process.env.CHIEF_MODEL || 'claude-sonnet-5'));
  log('Idle check every ' + IDLE_MS + 'ms. No ports exposed.');
  log('------------------------------------------------------------');

  while (running) {
    try {
      const job = await claimNextJob();
      lastPollAt = Date.now();
      heartbeat();

      if (!job) {
        await sleep(IDLE_MS);
        continue;
      }

      busy = true;
      log('WAKE   job ' + job.id + ' - "' + job.goal.slice(0, 80) + '"');

      await runJob(job);

      busy = false;
      log('SLEEP  office idle, waiting for the next job.');
    } catch (err) {
      busy = false;
      log('RUNTIME ERROR:', err.message || err);
      await sleep(IDLE_MS * 2);
    }
  }

  while (busy) await sleep(500);
  clearInterval(heartbeatTimer);
  log('Runtime stopped cleanly.');
  process.exit(0);
}

main().catch((err) => {
  log('FATAL:', err);
  process.exit(1);
});
