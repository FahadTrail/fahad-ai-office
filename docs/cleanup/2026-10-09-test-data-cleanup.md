# Production test-data audit (2026-10-09)

This audit covers every job in production on 2026-10-09: 103 in total, all in the "Fahad AI Office" project. It was read-only. The explicit-ID selection is in `ops/cleanup/2026-10-09-test-data-selection.sql`.

## Classification

| Class | Jobs | What |
| --- | --- | --- |
| CONFIRMED TEST | 82 | All of these runs: <ul><li>probes, canaries, rollback checks, verification and smoke runs</li><li>Office test 1–5, V2 check turns 1–4, the capability test, the direct-chat test</li><li>the Chief→Coding handoff test and the Telegram connection test</li><li>V4 / V4.1 acceptance and the deliberate-failure drill</li><li>the router smoke and the benchmarks (including the 4 blocked benchmark sessions)</li><li>load and burn-in runs, final and launch smokes, the Qahwa Run closure checks</li><li>the 14 Continuity Phase N drill legs, the two V5 production smokes and the 2026-10-09 routing test</li></ul> |
| CONFIRMED REAL | 14 | All of these jobs: <ul><li>the Supabase OTP research</li><li>the four route-id Coding tasks</li><li>the three provider-facts jobs</li><li>the Qwen fix and its continuation</li><li>the Model Studio key fact-check</li><li>"Add Glossary to office-workflow.md"</li><li>«كم متخصص في المكتب»</li><li>«شو أخبارك اليوم ؟»</li></ul> |
| UNCERTAIN | 7 | «أول وظيفة», the bakery tagline, the Morning Harbor SEO brief and launch concept, the read-only capability audit brief, "Language check" and "Hello". |

## Preview (read-only)

The preview of deleting the 82 CONFIRMED TEST jobs counted these rows:

| Table | Rows |
| --- | --- |
| jobs | 82 |
| tasks | 186 |
| runs | 207 |
| events | 2,263 |
| results | 204 |
| handoffs | 139 |
| artifacts | 114 |
| model_attempts | 934 (historical cost $1.665824) |
| tool_executions | 445 |
| agent_sessions | 29 |
| agent_events | 1,735 |
| agent_checkpoints | 562 |
| knowledge_items | 27 (all from test jobs) |
| conversations | 30 to 32 (only those whose every job is a test and that no other session uses) |
| continuity_tasks | 2 (the 2026-09-22 Phase 1 proof of concept) |

Fail-closed checks found nothing outside the selection that depends on it. One exception was handled: a test conversation is still used by the real "Add Glossary" Coding session, so that conversation is kept.

Evidence the Hub relies on is kept on real jobs:
* Telegram delivery is evidenced by «كم متخصص في المكتب».
* Web search is evidenced by the provider-facts jobs.

So the connector states stay truthful.

## Status

**Hidden, not deleted.** The rollout's automated safety policy blocked the bulk delete (permission classifier), so no production row was deleted. Every rule except deletion is in place in code:
* `officeVisible` / `isTestObjective` keep historical test objectives out of these views:
  * the Office;
  * the timeline and handoffs;
  * deliveries;
  * the command center;
  * the Deliverables Center;
  * the attention list;
  * Live Operations.
* Active work always shows.

Fahad can approve the delete. It would run as one transaction:
1. It uses the explicit IDs in the selection file.
2. It runs the fail-closed checks above.
3. Each delete must match the preview counts exactly.
4. It deletes in foreign-key order: tool_executions, then agent_sessions, then knowledge_items, then jobs (which cascades), then conversations, then continuity_tasks.
5. It writes one `test_data_cleanup` audit event.

`workspace_policies.spent_usd` is not changed.
