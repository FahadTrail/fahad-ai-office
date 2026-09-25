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

## Current status (2026-09-25)

* Production runs `main` with P0 (reproducible migrations, non-fatal startup
  canary). The Coding Agent code, migration, Hub UI and worker service are in
  the open PR from branch `claude/fahad-audit-readonly-466kck`; activation
  steps are in `docs/coding-agent.md` → *Activation runbook*.
* Verified in this repository: end-to-end runs with scripted models over real
  tools, real uid isolation, crash/restart resume, SQL scenarios. Not yet
  verified: live model providers through the new agentic protocols (needs the
  production keys), the worker in production, GitHub/Supabase tools against
  real APIs with the Coding Agent's own tokens.

## Next actions

1. Owner: review/merge the PR, approve the migration, root-install the worker,
   add `CODING_GITHUB_TOKEN` and `COMPOSE_PROFILES=coding`.
2. Run `canary:agentic --record` in the worker container; record results.
3. First low-risk Coding Agent task from the Hub; then enable more providers
   (keys + privacy flags), each followed by the canary.
4. Office specialties (Product/Tech, QA/Security, …) can reuse the agentic
   gateway and Tool Broker when prioritized.
