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
the catalog. Phase 2C adds only DeepSeek as a disabled-by-default canary through
its stateless Responses endpoint. It receives no Office metadata and uses peak
PAYG pricing for conservative budget accounting. The other confirmed targets
remain inactive and can register with the same gateway contract and policy
engine without changing workflow ownership or durable state.

The isolated canary records only provider, model, token, cost, duration,
attempt and checkpoint evidence; it never prints provider text, request headers
or credentials. A simulated outage must persist its isolated checkpoint before
the proven Anthropic adapter can take over. Production remains Anthropic-only
unless both the failover flag and an explicit server-side allowlist are changed.

## Development escape route

Phase 2C also defines an isolated OpenCode execution service under
`development/`. OpenCode is pinned in a separate image and uses DeepSeek for
repository analysis and edits. The coding model has no shell, web, subagent,
external-directory, Git or GitHub access. Its provider key is read from a
controller-owned file outside the task worktree and is not present in tool
environment variables.

The controller creates a clean worktree from `origin/main`, retries transient
headless failures, runs the fixed test suite itself, returns redacted failures
for repair, scans the diff for secrets and protected paths, and only then owns
the commit, branch push and safe PR creation. Workflow, deployment, migration,
credential, local OpenCode override and Hermes paths cannot be changed through
the automatic route. Merge and production deployment remain approval-gated.

This service is not part of the production runtime image and is not activated
until a separately stored DeepSeek credential, provider billing and the live
canary are approved and verified.

The action policy is AUTO for routine, reversible work and APPROVAL for merge,
production deploy and production migrations. Policies are supplied through a
rule source, so a future signed policy can authorize tested low-risk automation
without replacing the engine. Destructive actions remain denied by default.

The migration under `supabase/migrations/` adds a service-only
`model_attempts` audit table. It stores provider/model/token/cost/duration and
failure metadata but never prompts, responses, credentials or hidden reasoning.
Apply it only through a separately approved database change before deploying
code that requires the table.

## Workspace policy boundary

Phase 2D adds an optional fail-closed policy boundary around the existing
Model Gateway; the gateway itself and its provider adapters are unchanged.
When `WORKSPACE_POLICY_ENFORCEMENT_ENABLED=true`, every model request must carry
workspace, job, task and run lineage that Supabase verifies before any provider
call. The selected route, every possible fallback model, each host tool and the
controller-side secret reference must have an exact workspace grant.

Workspace budgets are reserved atomically before execution and settled with
the measured provider cost afterward. This prevents concurrent runs from
independently spending the same remaining budget. Only opaque `env://` or
`vault://` references are stored; credential values remain solely in the
controller environment. Tool grants already use broker, tool, action, scope and
risk fields so a later Tool Broker/MCP layer can consume the same deny-by-default
policy without redesigning the Model Gateway.

The Phase 2D migration is inert until a service-side policy is configured and
the feature flag is enabled. Its tables and budget RPCs are service-role-only,
and a model-attempt trigger rejects job/task/run lineage from another workspace.
Production activation, migration application, merge and deployment remain
separately approval-gated.

## Tool Broker and MCP foundation

Phase 2E adds a central, deny-by-default Tool Broker and a provider-neutral MCP
client layer. Chief orchestration can receive a workspace/job/task/run/agent-
bound broker session without changing existing model routing. Discovery is
intersected with a controller-owned catalog, exact workspace grants and active
agent permissions; MCP server annotations never grant authority.

The policy model supports `AUTO`, `APPROVAL` and `DENY`. High-risk tools cannot
become less restrictive than approval, and critical tools are denied. Secret
values resolve only inside the broker-owned transport. Costed tools use the
existing workspace reservation and settlement path. Every attempt records
lineage, authorization, timing, retry/idempotency, hashes and cost in a
service-role-only ledger without storing arguments, results, prompts or secret
values.

The initial zero-network canary contains only a bounded echo and local clock.
It proves the complete Agent → Broker → Policy → MCP → Result → Audit path but
is not enabled in production. See `docs/phase-2e-tool-broker-mcp.md`.

## Fahad AI Hub MVP

The runtime now serves one small, same-origin Hub interface on the loopback
port `2132` (set `HUB_ENABLED=false` to disable it). The interface lists
projects, submits a workspace-scoped goal to the existing `jobs` queue, and
polls the durable Supabase state for task status, agent handoffs, provider and
model attempts, fallback events, Tool Broker activity, budget and the final
result. It does not implement a second orchestration path.

The container publishes the port only on the VPS loopback interface so the
existing protected reverse-proxy/tunnel remains the access boundary. If the
Hub is ever bound to a non-loopback address, configure `HUB_ACCESS_TOKEN`; the
API then requires `Authorization: Bearer <token>` and never accepts a token in
the URL.

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
`npm run canary:tool-broker` runs the zero-network, zero-secret Phase 2E MCP
canary and performs no external calls or database writes.
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
Supabase and provider credentials stay solely in the server's root-owned
`.env`. Do not add them to GitHub, Actions, logs, artifacts, or source files.
`selftest` intentionally no longer performs the historical billable Claude call.

`node src/submit-job.js "<goal>"` is the server-side request entry point. It
uses the existing VPS environment and prints only the new job identifier and
status. The always-on worker then performs the durable workflow.

Rollback restores the prior image and source files and verifies it is running.
An initial rollback target may predate Docker health checks; later targets have
the health check. A real AI task is not part of deployment verification.
