# Fahad AI Office

GitHub is the source of truth for code. Supabase holds the database, results,
events and handoffs. Hostinger runs the production container. Step 3C adds the
first durable multi-agent path: Chief → Research → Chief.

## Provider-neutral model gateway

Phase 2B introduces an in-process `ModelGateway` boundary without changing the
default production route. Anthropic remains the only provider allowed by
default. Provider failover is disabled unless both
`MODEL_GATEWAY_FAILOVER_ENABLED=true` and an explicit
`MODEL_GATEWAY_ALLOWED_PROVIDERS` allowlist are configured server-side.

The gateway normalizes requests, results, usage, errors, retries, durable
pre-switch checkpoints, provider/model attribution and idempotency. The
OpenAI Responses adapter is available behind the same contract but is not
enabled by default. It sends `store: false`, supplies a client request ID and
never receives Office, GitHub or Supabase credentials.

DeepSeek, Kimi, Zhipu/GLM, MiniMax and Qwen are permanent target providers in
the catalog. They intentionally have no adapters in Phase 2B; later adapters
can register with the same gateway contract and policy engine without changing
workflow ownership or durable state.

The action policy is AUTO for routine, reversible work and APPROVAL for merge,
production deploy and production migrations. Policies are supplied through a
rule source, so a future signed policy can authorize tested low-risk automation
without replacing the engine. Destructive actions remain denied by default.

The migration under `supabase/migrations/` adds a service-only
`model_attempts` audit table. It stores provider/model/token/cost/duration and
failure metadata but never prompts, responses, credentials or hidden reasoning.
Apply it only through a separately approved database change before deploying
code that requires the table.

## Runtime

The runtime claims a job, asks Chief to create a constrained plan, persists a
Research task and a dependent Chief review task, and then claims each ready
task through the existing service-role-only RPCs. Research runs separately
with only its authorized web tools. Its stored result is the Chief review's
input; the final task closes the job.

Supabase remains the durable authority. Existing RPCs provide row locking,
dependency enforcement, idempotent completion, retries, stale-task recovery,
handoffs, result storage and job-level token/cost aggregation. No Step 3C
schema migration is required. Operational events contain status and usage,
never chain-of-thought or credentials.

Dependencies are pinned to the versions found in production on 2026-09-21:
Claude Agent SDK 0.3.278 and Supabase JS 2.116.0. `package-lock.json` locks
the dependency tree; builds use `npm ci`.

## Deployment

`.github/workflows/deploy.yml` validates code, runs tests and builds an image
before using the existing `VPS_HOST` and `VPS_SSH_KEY_B64` secrets. Deployments
are serialized and are limited to `main`. The SSH host public key is pinned
to the key read through the authenticated Hostinger console.

The forced SSH command runs root-owned `ops/deploy.sh`, installed at
`/usr/local/bin/fahad-office-deploy`. It fetches main, backs up sources and the
current image, builds the candidate and runs a read-only readiness check.
Only a passing candidate replaces the runtime. Three consecutive Docker
healthy observations are required for success; failed startup or readiness
triggers rollback. Build and preflight failure leave the running container
untouched. Logs and source backups remain in `/opt/fahad-ai-office/logs/`.

The installer in `ops/install-deploy.sh` updates only the Office's helper,
Dockerfile, ignore file and lockfile on an already-hardened server. It needs
root authorization once, does not restart containers, and does not broaden
the existing seven-command sudo whitelist. The workflow never updates these
root-owned files itself. Infrastructure changes require a reviewed root install.

The SSH directory is root-owned with group `deploy` and mode `750` so sshd can
read the existing forced-command public key as the deploy user. `authorized_keys`
remains root-owned and non-writable by deploy; the private key stays root-only.

The legacy `setup.sh` and `deploy-setup.sh` now exit without changing anything.
Their historical contents remain recoverable from Git history.

## Checks

`npm test` runs isolated tests without live credentials or AI calls, including
the normal workflow, dependency and handoff integrity, retry exhaustion,
stale recovery, duplicate claims, and usage/event attribution.
`npm run healthcheck` and `npm run selftest` perform the same read-only
production readiness check: settings, JavaScript syntax, SDK imports, Chief
and Research configuration, database access and workflow RPC visibility. They never claim a
job, modify database records, or invoke Claude. Run them inside the Office
container, where the existing environment is already available.

Docker's health check uses `node src/healthcheck.js --runtime` to verify the
process heartbeat and successful job polling. It makes no network or AI calls.
The startup readiness check verifies database access before polling starts.

## Boundaries

The runtime exposes no ports and keeps its own network and volumes. No command
in this deployment lists, inspects, or controls unrelated containers.
Supabase and Anthropic credentials stay solely in the server's root-owned
`.env`. Do not add them to GitHub, Actions, logs, artifacts, or source files.
`selftest` intentionally no longer performs the historical billable Claude call.

`node src/submit-job.js "<goal>"` is the server-side request entry point. It
uses the existing VPS environment and prints only the new job identifier and
status. The always-on worker then performs the durable workflow.

Rollback restores the prior image and source files and verifies it is running.
An initial rollback target may predate Docker health checks; later targets have
the health check. A real AI task is not part of deployment verification.
