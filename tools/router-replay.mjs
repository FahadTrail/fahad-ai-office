#!/usr/bin/env node
// Offline before/after router check: eligible routes and independent pools per
// Office job, healthy and under the Sanad Desk stall conditions (OpenRouter free
// pool and Gemini Flash exhausted). Real router code, placeholder keys, no network.
//   node tools/router-replay.mjs [repository-root]   (default: current directory)
const root = new URL(`file://${require_resolve(process.argv[2] || process.cwd())}/`).pathname.replace(/\/$/, "");
function require_resolve(path) { return path.startsWith("/") ? path : `${process.cwd()}/${path}`; }
const { createModelPool } = await import(`${root}/src/model-gateway/agentic/model-pool.js`);
const { AgentTurnGateway } = await import(`${root}/src/model-gateway/agentic/turn-gateway.js`);
const { MemoryProviderStateStore } = await import(`${root}/src/model-gateway/agentic/provider-state.js`);
const { setProviderCatalog } = await import(`${root}/src/model-gateway/agentic/provider-catalogs.js`);
const q = await import(`${root}/src/model-gateway/agentic/qualification.js`);
const NOW = Date.parse('2026-09-28T07:30:00Z');
const K = 'placeholder-test-key-000000000000';
setProviderCatalog('gemini', { ok: true, models: ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemma-4-26b-a4b-it'], contexts: { 'gemma-4-26b-a4b-it': 131072 } });
const pool = createModelPool({ env: { GEMINI_API_KEY: K, GROQ_API_KEY: K, OPENROUTER_API_KEY: K, ZHIPU_API_KEY: K }, openRouterCatalog: { models: [
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', admitted: true, contextLength: 262144, structuredOutput: true },
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', admitted: true, contextLength: 262144, structuredOutput: true }] } }).filter((r) => r.billingClass !== 'paid' && !r.retired && r.provider !== 'cerebras');
const Q = (skills = {}) => ({ status: 'qualified', suiteVersion: q.QUALIFICATION_SUITE_VERSION, testedAt: new Date(NOW - 864e5).toISOString(), skills: { instruction: true, structured: true, reasoning: true, coding: true, writing: true, reading: true, tools: true, ...skills } });
const quals = new Map(pool.map((r) => [r.id, Q(/lite|qwen/.test(r.id) ? { coding: false } : {})]));
const store = new MemoryProviderStateStore({ now: () => NOW });
const gw = new AgentTurnGateway({ pool, stateStore: store, now: () => NOW });
const jobs = { finance: [6000, 4000], research: [6000, 4000], content: [3000, 3000], orchestration: [2000, 2000], synthesis: [9000, 8000] };
const out = {};
for (const sanad of [false, true]) {
  store.rows.clear();
  if (sanad) {
    store.rows.set('openrouter:nvidia/nemotron-3-ultra-550b-a55b:free', { health: 'quota_exhausted', cooldownUntil: '2026-09-29T00:00:00Z' });
    store.rows.set('gemini:gemini-flash-latest', { health: 'quota_exhausted', cooldownUntil: '2026-09-29T07:00:00Z' });
  }
  for (const [job, [inT, outT]] of Object.entries(jobs)) {
    const ev = await gw.evaluate({ requiresPrivateData: false, allowPaid: false, job, estimatedInputTokens: inT, maxOutputTokens: outT, qualifications: quals });
    const ok = ev.filter((e) => e.eligible).map((e) => e.route.id);
    const pools = new Set(ok.map((id) => id.startsWith('openrouter:') ? 'openrouter:free' : id.startsWith('zhipu:') ? 'zhipu:free' : id));
    out[`${sanad ? 'SANAD-STATE ' : 'healthy     '}${job}`] = `${ok.length} routes / ${pools.size} pools`;
  }
}
console.log(JSON.stringify({ total: pool.length, ...out }, null, 1));
