#!/usr/bin/env node
// Repository-checkout entry point for the burn-in report; the code lives in
// src/ops/burnin-report.js so it also ships in the runtime image:
//   docker compose exec -T runtime node src/ops/burnin-report.js --since=… --hours=24
import { pathToFileURL } from 'node:url';
import { runBurninReport } from '../src/ops/burnin-report.js';

export * from '../src/ops/burnin-report.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runBurninReport(), null, 2));
}
