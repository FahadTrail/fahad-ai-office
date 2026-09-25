# Fahad Coding Agent

The Coding Agent is System A of Fahad AI Office: a controller-driven autonomous
software engineer. The Office (System B: Chief → Research → Chief) is unchanged
and shares the same infrastructure.

```
Hub ──create_coding_session──► agent_sessions (queued)          Supabase
                                     │ claim_agent_session (lease)
                                     ▼
coding-worker ── CodingAgentController ── AgentTurnGateway ── Model Pool
     │                   │                     │  (Anthropic, OpenAI, Gemini,
     │                   │                     │   DeepSeek, Qwen, Kimi, GLM,
     │                   │                     │   MiniMax, OpenRouter, Groq)
     │                   │                     └─ provider_status (health, cooldown, rate limits)
     │                   ├─ save_agent_checkpoint (every turn; transcript + state + patch)
     │                   └─ Tool Broker ── workspace grants (AUTO/APPROVAL/DENY) ── tool_executions audit
     │                                   └─ coding-sandbox MCP server
     └─ Sandbox (uid 1000): files, shell, tests, git   │ controller-owned: push, PR, CI, merge,
                                                        │ deploy status, verification, Supabase API
```

## Lifecycle

`understand → plan → implement → test → debug → (gate) → publish → ci → deploy → verify → report`

* **Model turns** (`understand`…`debug`): the model uses `list_files`, `read_file`,
  `search_code`, `write_file`, `edit_file`, `run_command`, `git_status`, `git_diff`,
  optional `supabase_query` / `supabase_execute` / `supabase_apply_migration`,
  `verify_url`, and the control tools `update_plan`, `record_note`, `finish`,
  `request_human`.
* **Finish gate**: Hermes paths → refused; protected paths (workflows, `ops/`,
  migrations, Docker files, `.env`, keys) → refused unless the session config sets
  `allowProtectedPaths`; secret scan of the full diff; the test command (configured
  or auto-detected) must pass. Failures go back to the model as a tool error.
* **Publish**: commit in the sandbox → git bundle → controller-owned repository →
  push with an explicit `--force-with-lease` → pull request (reused if it exists).
* **CI**: polls check runs and statuses for the pushed head. Failing job logs
  (redacted tail) are handed to the model, which fixes and calls `finish` again
  (at most 3 CI repair rounds).
* **Deploy** (only when the session asked for it): merge through
  `github.pr_merge` (APPROVAL by default), then watch the deploy workflow for the
  merge commit. The existing pipeline's health checks and rollback protect
  production.
* **Verify**: fetch the allowlisted health URL; optionally require a JSON field
  (for this repository `/healthz` → `version`) to match the merge commit.
* **Report**: markdown report stored in `agent_sessions.result` and as the job's
  final result.

## Continuity (provider switching and restarts)

There is exactly one continuity architecture (`src/agent-state/` +
`src/model-gateway/agentic/` + the controller). It replaced the Phase 1
`continuity/` POC and the OpenCode `development/` escape route.

* Every model turn ends with `save_agent_checkpoint`: phase, plan, state
  (files changed/inspected, notes, last test, git heads, PR/CI/deploy/verify,
  routes used, switches), the provider-neutral transcript and a binary
  working-tree patch. Only the current lease holder can write (fencing).
* The turn gateway chooses a route by policy and live health. Transient errors
  retry the same route briefly; rate limits, quota/capacity, outages, auth
  failures and refusals move to the next eligible route. **Before** the next
  provider is called, the controller checkpoints (`reason = provider_switch`)
  and renders a continuation (objective, plan, next action, files changed,
  discoveries, last test output, gate/CI failures, PR, recent activity). A
  failed checkpoint aborts the switch — no provider is billed without durable
  state.
* Provider health (`provider_status`) is shared by all workers and the Office
  runtime; a cooling-down route is skipped without another failed call.
* The worker lease is renewed every minute. If a worker dies, the lease expires
  (5 minutes) and any worker resumes the session from its latest checkpoint;
  the working tree is re-created from the pushed branch plus the stored patch
  if the sandbox volume was lost.
* If every otherwise-eligible model is only cooling down (rate limit or outage
  with a known reset), the controller checkpoints, records a `waiting` event and
  waits up to 20 minutes for the earliest reset, then continues the same task.
* The user is only interrupted when no eligible route remains
  (`NO_ELIGIBLE_PROVIDER` / `ALL_PROVIDERS_UNAVAILABLE` → session `blocked`
  with the reason for every route, e.g. `BUDGET_INSUFFICIENT`,
  `WORKSPACE_NOT_AUTHORIZED`, `COOLDOWN_RATE_LIMITED`) or an action needs approval.
* Only routes the workspace authorizes (`workspace_provider_permissions`:
  provider enabled, model listed, matching secret reference) are routable.
* **Failover drill** (validation only): session config
  `{"drill": {"failoverAfterIteration": N}}` makes the next call to the model
  that owns the task fail ONCE with a labelled rate limit
  (`DRILL_INJECTED_RATE_LIMIT`) after N model turns. The normal checkpointed
  handoff follows; real provider health is never marked. The Hub does not
  expose this setting.
* Each route may declare `maxOutputTokens` (DeepSeek: 8192,
  `DEEPSEEK_MAX_OUTPUT_TOKENS`); requests are clamped to it.
* Session events carry the worker id (`host:pid`) and the worker's code
  fingerprint (`node src/build-info.js` prints the same value for a checkout),
  so resumes by a different worker and the running code version are visible.

## Routing policy (Model Pool)

A route id has the form `provider:model` (the model part may itself contain
colons, e.g. `openrouter:qwen/qwen3-coder:free`); parse and format it with
`src/model-gateway/agentic/route-id.js` rather than splitting strings by hand.

`src/model-gateway/agentic/model-pool.js` declares every route with protocol,
credential variable, billing class (`free`, `included`, `promo`, `paid`),
quality/cost tier, context window, pricing and privacy review. A route is
routable only when its credential exists, its paid pricing is known, and
(for private repositories) its privacy flag is set.

`src/model-gateway/agentic/routing-policy.js` decides the order. Precedence:
defaults < environment (`CODING_ROUTING_STRATEGY`, `CODING_BILLING_PRIORITY`) <
workspace (`workspace_routing_policies`, Hub → Model pool → Project routing) <
task (`agent_sessions.config.routing`, Hub → new task → Model routing).

* Billing class order, default `free → included → promo → paid`.
* Strategy: `economy` (default — cheapest route that meets the coding quality
  floor `CODING_MIN_QUALITY_TIER`, default 4), `balanced` (best, then cheaper),
  `quality` (strongest first).
* `allowPaid=false` keeps a task on free/included/promo routes.
* `excludedRoutes` and `routeMonthlyBudgetUsd` (per route, per workspace budget
  period, measured from the `model_attempts` audit via `model_usage_summary`).
* The model that currently owns a task keeps it while eligible; the order is
  only consulted when it cannot continue.
* Budgets: per task (`budget_usd`), per project/workspace (monthly policy with a
  per-request maximum, reserved before each paid call), per route (caps above).

| Provider | Protocol | Credential | Private-code flag | Notes |
| --- | --- | --- | --- | --- |
| Anthropic (`claude-opus-5`, `claude-sonnet-5`) | Messages API (official SDK) | `ANTHROPIC_API_KEY` | approved | production provider |
| OpenAI (`gpt-5.3-codex`) | Responses (`store:false`) | `OPENAI_API_KEY` | approved | list price built in; other models need `OPENAI_PRICING_JSON` |
| DeepSeek (`deepseek-flash`) | Chat Completions | `DEEPSEEK_API_KEY` | `DEEPSEEK_API_TRAINING_OPTOUT_VERIFIED` | |
| Qwen (`qwen3.8-flash`) | Chat Completions | `QWEN_API_KEY` + `QWEN_API_ENDPOINT` | `QWEN_API_PRIVATE_DATA_APPROVED` | Singapore workspace endpoint; `AccessDenied.Unpurchased` = activate the model in Model Studio |
| Kimi (`kimi-k2.7-code`) | Chat Completions | `KIMI_API_KEY` | `KIMI_API_PRIVATE_DATA_APPROVED` | |
| GLM / Zhipu (`glm-5.3-flash`) | Chat Completions | `ZHIPU_API_KEY` | `ZHIPU_API_PRIVATE_DATA_APPROVED` | |
| MiniMax (`MiniMax-M2.7`) | Chat Completions | `MINIMAX_API_KEY` | blocked in code | pending API data-use confirmation |
| Gemini (`GEMINI_MODEL`, default `gemini-2.5-flash`) | generateContent | `GEMINI_API_KEY` | `GEMINI_API_PRIVATE_DATA_APPROVED` | free tier may train on data; `GEMINI_BILLING_CLASS` |
| OpenRouter (`OPENROUTER_MODEL`) | Chat Completions | `OPENROUTER_API_KEY` | `OPENROUTER_API_PRIVATE_DATA_APPROVED` | `:free` models classified free |
| Groq (`GROQ_MODEL`) | Chat Completions | `GROQ_API_KEY` | `GROQ_API_PRIVATE_DATA_APPROVED` | free tier |

Consumer subscriptions (Claude.ai, ChatGPT, Gemini apps) are not API
credentials and are not used. `included` is reserved for providers whose terms
explicitly allow programmatic use of an included allowance with a supported
credential.

The Hub **Model pool** view (`GET /api/model-pool?workspaceId=`) shows, per
route: status (`LIVE` after a real canary or real traffic, `CONFIGURED — NOT YET
VERIFIED`, `RATE LIMITED`, `OFFLINE`, `DEGRADED`, `NOT CONFIGURED`), integration
readiness (`READY`, `READY — CREDENTIAL REQUIRED`, `READY — ENDPOINT REQUIRED`,
`READY — PRICING REQUIRED`), routing rank, billing class, tools/context and
coding suitability, today's requests/tokens/**estimated** cost (UTC day, from
`model_attempts`), lifetime totals (from `provider_status`, includes canaries),
provider-reported rate-limit windows or `EXACT QUOTA NOT AVAILABLE`,
cooldown/reset time, last success/error and active tasks. Nothing is estimated
as quota.

**Live canary**: Hub → Model pool → *Run live canary* (or insert a row into
`provider_canary_runs`). The Office runtime, which holds the provider keys,
claims it within a minute when idle and, with synthetic prompts only, runs a
tool-calling round trip on every configured route, then a failover drill: the
cheapest verified route starts the task, ONE labelled failure is injected
before its second call, the checkpoint is written to the run row and read back,
and the cheapest verified route of a different provider continues from it. The
metadata-only report (per-route result, latency, tokens, estimated cost,
rate-limit headers, provider error type, the attempt trace) is stored on the
run; passing routes get `provider_status.verified_at`. A full run costs about
$0.02.

## Policy: AUTO by default, APPROVAL by exception

Workspace grants (`workspace_tool_grants`, broker `coding`) decide each tool:

| AUTO (sandbox, reversible) | APPROVAL | Floors |
| --- | --- | --- |
| list/read/search/write/edit files, run commands, git status/diff/commit, push feature branch, create/update PR, CI status/logs, deploy status, HTTPS verification, read-only Supabase queries | `github.pr_merge` (medium — the owner may set it to AUTO), `supabase.query_write`, `supabase.migration_apply` (high — irreducible approval floor) | `critical` tools are always DENY; Hermes is never writable |

An APPROVAL call records `approval_required`, creates an `agent_approvals` row
(summary + argument hash + redacted preview) and parks the session
(`awaiting_approval`). Approving in the Hub re-queues it; the approval is
consumed exactly once for exactly the approved arguments.

## Security boundaries

* The worker runs as container root in its own container; every model-influenced
  process runs as uid 1000 with a scrubbed environment and cannot read the
  controller's `/proc/<pid>/environ`. Leftover sandbox processes are killed
  after every command.
* File tools resolve real paths inside the worktree and refuse symlink escapes
  and `.git/` writes.
* Credentials are resolved by the Tool Broker only for the tool that needs them
  (`env://CODING_GITHUB_TOKEN`, `env://CODING_SUPABASE_ACCESS_TOKEN`) and never
  enter the sandbox, transcripts, events or audit rows. Tool output is redacted
  before it reaches a model.
* The Office service-role key is used only by the controller for its own state.
  Supabase development work uses a separate Management API token and a
  per-session project allowlist.
* Hermes is excluded by path policy, command policy and the finish gate. It
  shares no container, network, volume or credential with this system.

## Activation runbook (production)

Already done: code merged and deployed, migrations applied and verified, live
canary passed. Remaining (root on the VPS, once):

1. Create a **fine-grained GitHub token**: GitHub → Settings → Developer
   settings → Fine-grained tokens → *Only select repositories*: the repositories
   the agent may change (e.g. `FahadTrail/fahad-ai-office`). Repository
   permissions: **Contents: Read and write**, **Pull requests: Read and write**,
   **Actions: Read**, **Checks: Read**, **Commit statuses: Read** (Metadata: Read
   is automatic). Nothing else — not Workflows, not Administration.
2. On the VPS:

   ```sh
   sudo rm -rf /root/fahad-ai-office-activate
   sudo git clone --depth 1 https://github.com/FahadTrail/fahad-ai-office.git /root/fahad-ai-office-activate
   sudo bash /root/fahad-ai-office-activate/ops/enable-coding-worker.sh
   ```

   The script checks `.env` (Supabase + at least one provider key) before
   changing anything, asks for the token with hidden input, runs
   `ops/install-deploy.sh` (installs the compose file with the opt-in
   `coding-worker`; no restart), adds `COMPOSE_PROFILES=coding`, starts only the
   worker, waits for it to be healthy and runs `verify-isolation.js`. Later
   deployments recreate the worker with each new image automatically.
3. Optional: `CODING_SUPABASE_ACCESS_TOKEN` (Supabase personal access token) in
   `.env` enables the Supabase tools for sessions that allowlist a project.
4. First task: Hub → Coding Agent → a small documentation change with
   “merge & deploy” unchecked.

Undo: `sudo docker compose -f /opt/fahad-ai-office/docker-compose.yml stop coding-worker`
and remove the `COMPOSE_PROFILES`/`CODING_GITHUB_TOKEN` lines from `.env`.

## Troubleshooting (production)

Everything a session does is in Supabase; no server access is needed.

| Question | Where to look |
| --- | --- |
| Is the worker alive / which code does it run? | Create a probe session with `budget_usd = 0.0001`: the worker claims it within seconds, its first `session` event carries `worker` (`container:pid`) and `build.codeFingerprint`; compare with `node src/build-info.js` on a checkout. It then blocks with `NO_ELIGIBLE_PROVIDER` without calling a model. |
| Why is a session blocked? | `agent_sessions.blocker` / `error_code` (per-route reasons for `NO_ELIGIBLE_PROVIDER`) and the last `guard` event. |
| What did it do? | `agent_events` (plan, model turns, tool results, tests, git, ci, deploy, verify), `tool_executions` (every tool call with policy decision), `model_attempts` (every model call, cost, error code). |
| Did it switch models? | `provider_switch` events and `agent_sessions.state.switches`; a drill switch has `payload.drill` / `reason.injected`. |
| Worker restarted mid-task? | The session keeps `status = running` until the 5-minute lease expires, then a new worker logs `Resumed from checkpoint N … by worker <new id>`. Every deployment recreates the worker container. |
| Waiting for me? | `agent_approvals` with `status = 'pending'` (Hub → Coding Agent → Approve / Reject). |
| Provider health / cost | `provider_status`, `model_usage_summary()`, Hub → Model pool. |
| How are route ids parsed? | With `parseRouteId` / `formatRouteId` from `src/model-gateway/agentic/route-id.js`; never split route ids on ":" by hand. |

## Live validation (production, 2026-09-25)

Session `c2e43e40-b4e5-482f-b265-64d675417498` ran on the production worker with
real models and real tools:

* Objective: add `src/model-gateway/agentic/route-id.js` test-first, use it in
  `src/canary/canary-requests.js`, document it. Routing economy, effort low,
  budget $0.45, drill after 7 turns.
* DeepSeek `deepseek-flash` ran the security self-check (sandbox uid 1000, no
  credential variables), inspected the repository, planned, wrote the failing
  test first and ran it. The drill injected one labelled rate limit; the
  controller checkpointed and Claude `claude-sonnet-5` continued from the
  checkpoint (implementation, refactor, docs, tests) without repeating work.
* Test gate passed; the agent committed, pushed its branch with its own token,
  opened pull request #32 and followed its CI to green.
* The merge waited for approval (`github.pr_merge` = APPROVAL), was approved
  once and consumed once; the agent merged, then watched the deployment.
* The worker was restarted twice by deployments while the session held its
  lease; each time a new worker resumed it from the latest checkpoint.

Follow-up sessions on the same worker (DeepSeek only, $0.007–0.027 each):

* `8e10f499` (PR #35, merged): the objective contained a deliberately wrong
  module path; the agent noticed it did not exist, used the real path and
  explained the deviation in the pull request.
* `ddd54d04` (drill branch `ci-drill/canary-model-filter`, PR #36, closed): a
  planted regression that only the full suite catches; the agent found it with
  the full suite, traced it to the planted commit and fixed it.
* `37685993` (drill branch `ci-drill/actions-only-assertion`, PR #37, closed):
  a planted assertion that runs only on GitHub Actions. CI failed, the
  controller fetched the Actions log with the agent's own token, the agent
  reproduced it with `GITHUB_ACTIONS=true`, fixed it, pushed again, updated the
  same pull request and CI passed.

Defects found by these runs and fixed in production: CI/deploy polls replayed
by the Tool Broker instead of re-executing; masked test failures
(`…; echo "exit=$?"`); drill/wait events rejected by the `agent_events`
constraint; unhelpful "no eligible model" blockers; model-attempt audit rows
colliding on failover turns; CI log excerpts that showed only the tail (now
failure lines + tail). Tool-level errors a handler returns to the model (for
example `EDIT_NOT_FOUND`) appear as warning events; their broker row stays
`succeeded` because the tool itself ran.

## Verification in this repository

* `node --test` — protocol translations, routing/failover, provider health,
  sandbox security (symlinks, commands, secrets), guards (no-progress, budget,
  Hermes), Hub APIs, the canary logic, and two end-to-end runs.
* `test/coding-agent-e2e.test.js` — scripted models (deterministic, **not**
  LLMs) drive the real controller, broker, sandbox, shell (`npm test`), git,
  bundles and pushes: a controlled test failure is fixed, a 429 forces a
  checkpointed handoff to the second route which continues the same task, a
  controlled CI failure is repaired, the merge waits for approval, deployment is
  observed and production verification passes. It runs in both unisolated and
  isolated (uid-dropping) modes. A second test SIGKILLs a worker process mid-task
  and a new process resumes from the checkpoint without redoing completed work.
* `supabase/verify/replay.sh` — replays all migrations and runs
  `supabase/verify/scenarios/*.sql` (lease fencing, approvals, lineage, grants).
