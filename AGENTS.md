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
* Not configured: `CODING_SUPABASE_ACCESS_TOKEN` (the agent's Supabase tools
  fail closed until it is added); the workspace budget is $2/month.

## Next actions

1. Use it: Hub → Coding Agent → project, repository, detailed objective,
   budget, routing → Start; approve merges in the Hub.
2. Optional: Supabase access token for the agent, more providers (keys,
   privacy flags, workspace authorization), each followed by a live canary.
3. Office specialties can reuse the agentic gateway, routing policy and Tool
   Broker when prioritized.
