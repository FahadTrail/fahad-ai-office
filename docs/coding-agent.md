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
* The user is only interrupted when no eligible route remains
  (`NO_ELIGIBLE_PROVIDER` / `ALL_PROVIDERS_UNAVAILABLE` → session `blocked`
  with the per-route reasons) or an action needs approval.

## Routing policy (Model Pool)

`src/model-gateway/agentic/model-pool.js` declares every route with protocol,
credential variable, billing class (`included`, `free`, `promo`, `paid`),
quality/cost tier, context window, pricing and privacy review. A route is
routable only when its credential exists, its paid pricing is known, and
(for private repositories) its privacy flag is set. The order is
`CODING_BILLING_PRIORITY` (default `included,free,promo,paid`), then quality,
then cost. Paid routes are excluded when their worst-case turn cost exceeds the
remaining session budget, and each paid turn reserves budget against the
workspace policy before the provider is called.

| Provider | Protocol | Credential | Private-code flag | Notes |
| --- | --- | --- | --- | --- |
| Anthropic (`claude-opus-5`, `claude-sonnet-5`) | Messages API (official SDK) | `ANTHROPIC_API_KEY` | approved | production provider |
| OpenAI (`CODING_OPENAI_MODEL`) | Responses (`store:false`) | `OPENAI_API_KEY` | approved | needs `OPENAI_PRICING_JSON` |
| DeepSeek (`deepseek-flash`) | Chat Completions | `DEEPSEEK_API_KEY` | `DEEPSEEK_API_TRAINING_OPTOUT_VERIFIED` | |
| Qwen (`qwen3.8-flash`) | Chat Completions | `QWEN_API_KEY` + `QWEN_API_ENDPOINT` | `QWEN_API_PRIVATE_DATA_APPROVED` | Singapore workspace endpoint |
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

The Hub **Model pool** view shows, per route: routing rank, class, availability
(`AVAILABLE — EXACT QUOTA UNKNOWN`, `RATE LIMITED — RETRY AFTER hh:mm:ss`,
`NOT CONFIGURED — …`, `… PRIVACY REVIEW PENDING`), provider-reported request
windows (only when the provider sends rate-limit headers), usage and
**estimated** cost, last success/error, tool and context capability, and privacy
status. Nothing is estimated as quota.

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

1. **Review and merge** the Coding Agent pull request (deploys the Hub UI and
   the shared provider-health recording; nothing runs until steps 2–4).
2. **Apply the migration** `supabase/migrations/20260925160000_coding_agent_foundation.sql`
   through the protected database process, then confirm:
   `npm run db:replay` locally, and the production fingerprint check in
   `supabase/verify/README.md`.
3. **Install the worker service** (root, once): `sudo bash ops/install-deploy.sh`
   from a reviewed checkout. This installs the compose file with the opt-in
   `coding-worker` service and does not restart anything.
4. **Configure `.env`** (root-owned): `COMPOSE_PROFILES=coding`,
   `CODING_GITHUB_TOKEN` (fine-grained token: contents + pull requests +
   actions read, limited to the repositories the agent may change), optionally
   `CODING_SUPABASE_ACCESS_TOKEN`, and any additional provider keys and privacy
   flags. Then `docker compose up -d coding-worker` and check
   `docker exec fahad-office-coding-worker node src/coding-agent/verify-isolation.js`.
5. **Live canary**: `docker exec fahad-office-coding-worker node src/canary/agentic-canary.js --record`
   verifies each routable model with a real tool-calling round trip and runs the
   real failover drill (one injected, labelled failure).
6. **First task** from the Hub → Coding Agent, e.g. a small documentation change
   with “merge & deploy” unchecked.

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
