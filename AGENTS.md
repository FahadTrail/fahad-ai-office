# Fahad AI Office — instructions for coding agents

This file is the durable, provider-neutral handoff for any agent (Claude,
Codex, Gemini, the Fahad Coding Agent itself) working in this repository.
Read it fully before changing anything. `CLAUDE.md` imports it.

## What this is

* **System B — Fahad AI Office**: Chief → Research → Chief multi-agent workflow
  (`src/workflow.js`, `src/chief.js`, `src/research.js`) behind the Hub
  (`src/hub-server.js`). Durable jobs/tasks/runs/events live in Supabase.
* **System A — Fahad Coding Agent**: autonomous development worker
  (`src/coding-agent/`, entry `src/coding-worker.js`). See `docs/coding-agent.md`.
* **Shared infrastructure**: Model Gateway (`src/model-gateway/`, agentic layer
  in `src/model-gateway/agentic/`), provider health (`provider_status`), durable
  agent state (`src/agent-state/`), Tool Broker (`src/tool-broker/`), workspace
  policy (`src/workspace-policy/`), audit (`model_attempts`, `tool_executions`,
  `agent_events`).
* **Hermes** is a separate system. Never read, modify, deploy or share
  credentials with anything Hermes-related. Path, command and gate policies
  enforce this; keep them.

## Production

* VPS (Hostinger) runs Docker container `fahad-office-runtime` (Office worker +
  Hub on :2132 behind Traefik). The opt-in `fahad-office-coding-worker` service
  (compose profile `coding`) runs the Coding Agent when enabled.
* Push to `main` → `.github/workflows/deploy.yml` → SSH forced command →
  root-owned `ops/deploy.sh`: build candidate, read-only healthcheck, switch,
  3 healthy observations, automatic rollback. `/healthz` reports the deployed
  commit (`version`).
* Only `src/`, `package.json` and `package-lock.json` are shipped by a deploy.
  `Dockerfile`, `.dockerignore`, `docker-compose.yml` and `ops/deploy.sh` change
  on the server only via a reviewed root run of `ops/install-deploy.sh`.
* Public Hub domain: Traefik routes `HUB_PUBLIC_HOST` and `HUB_EXTRA_PUBLIC_HOST`
  from `.env` (compose labels). Change it only with
  `sudo bash ops/set-hub-domain.sh <domain>`, which keeps the previous host as
  the extra one. A canary report's `runtimeDiagnostics` shows the running
  settings and HTTPS probes from inside the VPS, with no secrets.
* Supabase project `zkzibipinjeswhdxnfgf` (`fahad-ai-office`). Secrets live only
  in the server's root-owned `.env`.

## Commands

```sh
npm ci                     # dependencies (CI does this before tests)
node --test                # full suite; no network, no credentials, no AI calls
npm run db:replay          # replay all migrations into a throwaway PostgreSQL
npm run verify:sandbox     # (container root) verify sandbox uid isolation
npm run canary:agentic     # LIVE provider canary + failover drill (needs keys)
npm run coding-worker      # run the Coding Agent worker (needs Supabase + keys)
```

Tests that need container root (isolated sandbox) skip elsewhere; CI runs them
inside the built runtime image as root.

## Rules for changes

* Work on a branch, open a PR, keep CI green. Merging to `main` deploys
  production; merges and production migrations need the owner's approval.
* Database: add a new timestamped migration; never edit applied ones. Update
  `supabase/verify/schema-fingerprint.txt` via the replay (see
  `supabase/verify/README.md`) and add a scenario for new functions. Every
  object is service-role only with RLS on unless there is a reviewed reason.
* Never weaken a security test to make it pass. Never log, commit or return
  credentials; tool output is redacted before it reaches models.
* Keep the system provider-neutral: new providers go into the Model Pool with a
  protocol adapter, truthful billing class, pricing and a privacy flag; they are
  claimed "verified" only after `canary:agentic` succeeds with real credentials.
* Do not claim quota numbers a provider does not report.

## Continuity update (2026-10-01, Phase N readiness)

The Coding Continuity Supervisor is implemented in an open, unmerged PR stack: #102 (Phase A, schema), #104 (B, durable runtime foundation), #105 (C-G, supervisor and workers), and #106 (H-M, nested project UI and Phase N readiness fixes). The Phase A production migration is unapplied, and `CONTINUITY_SUPERVISOR` is off by default. Automated Continuity UI axe/viewport checks pass, but the documented real Office → Codex → third-worker Phase N drill has not been run; no third adapter is executable. **Production activation is not ready.** Do not merge, deploy, apply the migration, or activate the flag. Read `docs/CONTINUITY-PHASE-N-READINESS.md`, the top of `docs/HANDOVER.md`, and `.continuity/checkpoint.json` before any further action. The older status below is historical.

## Current status (2026-09-25; historical)

* **Coding Agent V1 is operational in production.** Production runs `main`
  (Office + Hub + the `fahad-office-coding-worker` container, enabled with
  `ops/enable-coding-worker.sh`). Every deployment recreates the worker; the
  worker's code fingerprint (`src/build-info.js`) is logged in each session's
  first event.
* Live-validated end to end (see `docs/coding-agent.md` → *Live validation*):
  a real task went objective → plan → test-first failure → fix → checkpoints →
  DeepSeek → controlled failover drill → Claude Sonnet continuation → gate →
  branch push → pull request → CI → merge approval → merge → deployment →
  `/healthz` verification, surviving two worker restarts; a second task
  repaired a real CI failure from the Actions logs.
* Model pool (live canary + real sessions): Anthropic `claude-opus-5`,
  `claude-sonnet-5`, OpenAI `gpt-5.3-codex`, DeepSeek `deepseek-flash` LIVE.
  Workspace authorization: DeepSeek and Anthropic (OpenAI not authorized for
  the project). Qwen: key present, provider answers `AccessDenied.Unpurchased`.
  Kimi, GLM, MiniMax, Gemini, OpenRouter, Groq: no credentials.
* Migrations through `20260925190000_routing_policy_and_usage` are applied; the
  production schema fingerprint equals `supabase/verify/schema-fingerprint.txt`.
* The workspace budget is $2/month.

* Platform expansion (2026-09-25): job-based routing over a capability registry
  (`src/model-gateway/agentic/capabilities.js`), free-quota knowledge with
  reset-aware rotation (`src/model-gateway/agentic/free-quota.js`), new
  free-tier routes (GitHub Models, Cerebras, Z.ai GLM Flash, Mistral) plus
  Gemini/Groq/OpenRouter defaults. The Hub → Platform dashboard has seven
  sections. The Office role registry is `src/office-agents/roles.js`.
  One-command credential setup: `ops/set-secret.sh`. Provider facts and the
  JEV decision (not integrated) are in `docs/providers.md`; the Office
  architecture is in `docs/office-agents.md`.

* Free capacity pass (2026-09-26):
  * Provider facts were re-verified from official pages, with sources in
    `src/model-gateway/agentic/provider-facts.js` and `docs/providers.md`:
    * GitHub Models is retired;
    * Cerebras is trial credits only (PROMO);
    * Groq free is 8K tokens/min;
    * Groq qwen3.8-27b, Groq gpt-oss-20b, Gemini Flash-Lite and Z.ai GLM-4.5-Flash were added.
  * Global free-route guarantee (`free-guard.js`): a billed or silently
    rerouted free call is charged to the ledger, the route is blocked for 24 h,
    and the task fails over.
  * Provider model catalogs (`provider-catalogs.js`).
  * Named account blockers, with the Qwen diagnosis in owner canaries.
  * Background qualification of free models (`qualification.js`) with
    job-specific, evidence-based free ranking.
  * Supabase tools are hidden when their token is absent.

* UX & Workflow V2 (2026-09-27): the Hub's `/` is the Workspace V2 interface
  (`src/hub-ui/`, API `src/hub-workspace.js`); the old Hub stays at `/classic`.
  * Multi-turn chats (`conversations`).
  * Chief routes `answer` / `delegate` / `development`.
  * Project context and memory.
  * Tasks in human language.
  * Owner approvals for exact protected files (`request_protected_change`) and
    Reply & Continue into the same session (`agent_owner_inputs`).
  * Context budget (about 51% less input on a real session profile).

  Details are in `docs/workspace-v2.md`; the migration is
  `20260927090000_workspace_v2`.

* Multi-agent Office (2026-09-28): the Chief orchestrates up to 8 workstreams
  across employees on the existing task graph:
  * parallel execution and handoffs;
  * one bounded revision round;
  * development workstreams handed to the Coding Agent;
  * direct chats with employees;
  * the Live Office, workflow and employee pages;
  * evidence-based connector states.

  Details are in `docs/office-workflow.md`; the migration is
  `20260928090000_office_multi_agent`.

* Office evolution (2026-09-27): nine employees — CHIEF, RESEARCH, CREATIVE,
  PRODUCT, FINANCE, CODING, AUDIT, SOCIAL, LEGAL (Business Strategy and
  Operations retired, history kept); Arabic nicknames; structured artifacts
  (`public.artifacts`) drawn by the Hub; curated `knowledge_items` with
  expiry; typed memory; internal consults; Living Office, Employees,
  Artifacts, Integrations and the Project Command Center; light/dark theme.
  Telegram → CHIEF channel (`src/channels/`) is built and tested; it starts
  only when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_CHAT_ID` are set.
  License gate: `test/license-gate.test.js` + `legal/license-decisions.json`.
  Hermes: read-only `ops/hermes-audit.sh`, plan in `docs/hermes-decommission.md`
  (not ready; never touch Hermes before Fahad's single final approval).
  Migration `20260929090000_office_final_roster` is applied in production.

* Closure sprint (2026-09-27): Office steps wait for free model capacity
  (`WAITING_FOR_CAPACITY`, `defer_task`, auto-resume from checkpoint) instead
  of failing; the Coding worker runs a read-only Supabase tools self-check at
  start (event `supabase_tools_check`); Telegram re-announces pending items
  after restarts and sends Needs-Fahad questions; `tools/hermes-decision.mjs`
  turns the Hermes audit into one decision. Migration
  `20260930090000_office_capacity_wait`.
  Live-verified free-only at $0 (2026-09-27): a FINANCE → CODING consult
  whose FINANCE follow-up hit WAITING_FOR_CAPACITY, auto-resumed 6 minutes
  later from its checkpoint and finished (AED estimate with KNOWN/ESTIMATED/
  ASSUMPTION); a long CHIEF synthesis (7.6K chars, 6 distinct sections,
  artifacts intact). Supabase Coding tools self-check VERIFIED in production
  (read-only role, project scope and write guard enforced, no secret exposed).

* Hermes was operationally decommissioned by Fahad (2026-09-27). Its backup
  and retained directories are off-limits: the Office never restores,
  reconnects, depends on or modifies them.

* V4 visual experience (2026-09-27), UI only with no core rebuild. It covers:
  * the design system and tokens, with self-hosted Inter and IBM Plex Sans
    Arabic;
  * the lazy-loaded Live Office with real states and clickable handoffs;
  * the CHIEF home;
  * the Command Center executive view plus the project map;
  * the artifact library with department views and shared exports;
  * Needs Fahad levels, integration states and search;
  * SSE realtime (`/api/stream`);
  * content-hashed, gzipped assets;
  * axe-clean WCAG AA in both themes.

  Details are in `docs/v4-experience.md`. Visual QA runs through
  `tools/hub-preview.mjs` + `tools/ui-screenshots.mjs`, using fictional
  preview data only.

* V4.1 reliability closure (2026-09-28): FINANCE arithmetic is deterministic
  (`src/office/finance.js`: calculation, validation, VERIFIED /
  INCONSISTENT / INSUFFICIENT DATA, automatic return to FINANCE).
  * AUDIT runs code checks before its model review.
  * The CHIEF fact gate preserves validated figures and removes contradicting
    ones.
  * SOCIAL calendars are structured artifacts, and process narration is
    stripped.
  * Scheduling is dependency-aware (no batch barrier).
  * `[free-only]` is stored as `jobs.free_only` (migration
    `20261002090000_job_free_only`).
  * Search degradation is explicit.

  Details are in `docs/v41-reliability.md`.

* V5 immersive Office (beta, branch `claude/v5-immersive-office`, merged only
  after V4 is closed): a lazy-loaded Three.js Office — atrium, wings and
  studios; real states, artifacts and handoffs; Project Mode; Follow work;
  fail-safe fallback to the light Office. AUTO keeps the light Office until
  Fahad enables immersive in Settings. Details are in
  `docs/v5-immersive-office.md`; rebuild the engine with
  `node tools/build-three.mjs`.
* Core closure (2026-09-30): **CORE COMPLETE: READY FOR REAL USE**, with core development stopped.
  * Production runs `26dd491`.
  * After a 24 h stability burn-in (0 paid calls, no incidents), #92, #91, #96, #94 and #95 were merged and deployed one at a time.
  * The final smoke test passed.
  * The next phase is V5/UI only.
  * State, numbers, rollback and bottlenecks are in `docs/HANDOVER.md` → *CORE CLOSURE*.

* Product complete (2026-10-01): **FAHAD AI OFFICE — COMPLETE AND READY FOR DAILY USE**.
  * V5 (#71) and the in-runtime watchdog (#99) are live (`2bb17b0`).
  * Development is stopped.
  * See `docs/PRODUCTION-READY.md` and `docs/HOW-TO-USE.md`.

* Coding Continuity Supervisor (2026-10-01): designed by Claude Code; **Phase A implemented on PR #102 (open; migration not applied, needs Fahad)**; Codex continues with Phase B.
  * Permanent coding worker stack (keep all seven in every design): Fahad Office Coding Agent, Claude Code, OpenAI Codex, Google Antigravity, OpenCode, Kilo Code, Freebuff.
  * GitHub is the durable truth; Fahad AI Office is the policy authority.
  * Start at `docs/CODEX-CONTINUE.md`; architecture in `docs/CODING-CONTINUITY-SUPERVISOR.md`, phases in `docs/CONTINUITY-IMPLEMENTATION-PLAN.md`, worker rules in `docs/DEVELOPMENT-CONTRACT.md`.

## Next actions

1. Codex: confirm CI and DB replay on #106's final Phase N-readiness head; then resolve the executable third-worker and isolated Office/Codex environment blocker and run the documented real Phase N drill. Keep #102/#104/#105/#106 open and unmerged, with the migration unapplied and Supervisor off. The activation order and rollback plan are in `docs/CONTINUITY-PHASE-N-READINESS.md`.
2. Use it: Hub → Coding Agent → project, repository, detailed objective,
   budget, routing → Start; approve merges in the Hub.
3. Optional: Supabase access token for the agent, more providers (keys,
   privacy flags, workspace authorization), each followed by a live canary.
4. Office specialties can reuse the agentic gateway, routing policy and Tool
   Broker when prioritized.
