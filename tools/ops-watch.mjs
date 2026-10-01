#!/usr/bin/env node
// Repository-checkout entry point; the watchdog lives in src/ops/ops-watch.js
// so it ships in the runtime image (cron: docker compose exec -T runtime node src/ops/ops-watch.js).
import { pathToFileURL } from 'node:url';
import { runOpsWatch } from '../src/ops/ops-watch.js';

export * from '../src/ops/ops-watch.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runOpsWatch();
