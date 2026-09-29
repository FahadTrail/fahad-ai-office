#!/usr/bin/env node
// Offline eligibility matrix: which non-paid routes each Office job may use,
// computed by the REAL router (AgentTurnGateway.evaluate) over the Model Pool
// with placeholder keys. No network, no credentials, no model calls.
// Optional: pass qualification evidence as JSON {routeId: {status, skills}}
// (from provider_canary_runs, see docs/HANDOVER.md) to include its gates.
//
//   node tools/capacity-matrix.mjs [qualifications.json]
import { readFileSync } from 'node:fs';
import { createModelPool } from '../src/model-gateway/agentic/model-pool.js';
import { AgentTurnGateway } from '../src/model-gateway/agentic/turn-gateway.js';

const placeholder = 'placeholder-key-not-real-000000';
const env = Object.fromEntries(['GEMINI', 'GROQ', 'OPENROUTER', 'ZHIPU', 'CEREBRAS', 'MISTRAL', 'DEEPSEEK', 'ANTHROPIC'].map((name) => [`${name}_API_KEY`, placeholder]));
const pool = createModelPool({ env, fetchFn: async () => { throw new Error('offline'); } });
const gateway = new AgentTurnGateway({ pool, stateStore: { snapshot: async () => new Map() }, minQualityTier: 4 });
const file = process.argv[2];
const qualifications = file ? new Map(Object.entries(JSON.parse(readFileSync(file, 'utf8'))).map(([id, record]) => [id, { routeId: id, testedAt: new Date().toISOString(), ...record }])) : null;
const JOBS = { finance: 4000, synthesis: 8000, research: 4000, content: 4000, orchestration: 4000, coding: 16000 };
const rows = new Map();
for (const [job, maxOutputTokens] of Object.entries(JOBS)) {
  const evaluations = await gateway.evaluate({ requiresPrivateData: job === 'coding', estimatedInputTokens: 6000, maxOutputTokens, job, allowPaid: false, qualifications });
  for (const entry of evaluations) {
    if (entry.route.billingClass === 'paid') continue;
    const reasons = entry.reasons.filter((reason) => reason !== 'CREDENTIAL_MISSING');
    rows.set(entry.route.id, { ...rows.get(entry.route.id), [job]: reasons.length ? reasons.join('+') : 'OK' });
  }
}
console.table(Object.fromEntries(rows));
