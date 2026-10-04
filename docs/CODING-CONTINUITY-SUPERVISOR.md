# Coding Continuity Supervisor (architecture, locked 2026-10-01)

Status: **Phase A implemented on PR #102 (migration NOT applied); Phases B–N not started.** Codex implements it from `docs/CONTINUITY-IMPLEMENTATION-PLAN.md`. The rest of Fahad AI Office is complete and live; see `docs/PRODUCTION-READY.md`.

## 1. Purpose

Keep software development running across several coding agents. Fahad should never have to copy prompts, re-explain context, or decide who continues.

* Agent A works. When it nears exhaustion or fails, it checkpoints and hands off, and agent B continues.
* **GitHub is the durable truth:** the branch, the commits, `AGENTS.md`, `docs/HANDOVER.md` and the continuity checkpoint.
* **No agent's conversation memory is canonical.**
* **Fahad AI Office is the policy authority:** privacy, budget, free-first routing and owner approvals.

```
FAHAD AI OFFICE (policy: privacy, budget, approvals, Telegram, Hub)
        |
CODING CONTINUITY SUPERVISOR (runtime service: leases, checkpoints, selection, handoff)
        |
  +-- Fahad Office Coding Agent   (native: src/coding-agent)
  +-- Claude Code                 (official CLI, headless)
  +-- OpenAI Codex                (official CLI, non-interactive)
  +-- Google Antigravity          (official CLI/headless only, if it exists)
  +-- OpenCode                    (CLI run / server API)
  +-- Kilo Code                   (CLI, if headless is supported)
  +-- Freebuff                    (MANUAL_OR_SEMI_AUTOMATIC until an official headless path exists)
        |
GitHub (branch per task, worktree per active agent) + CI + Supabase (continuity tables)
```

**Permanent worker stack:** Office Coding Agent, Claude Code, Codex, Antigravity, OpenCode, Kilo Code, Freebuff. All seven appear in every future design.

**Bridges, not workers:**
* OpenHands / ACP (section 12);
* the official CLIs;
* Git worktrees;
* CI.

## 2. What already exists (reuse, do not duplicate)

| Need | Existing piece |
|---|---|
| Native worker with leases | `agent_sessions` + `claim_agent_session` / `renew_agent_session_lease` / token-guarded `save_agent_checkpoint` / `finish_agent_session` (`supabase/migrations/20260925160000_coding_agent_foundation.sql`) |
| Native checkpoints | `agent_checkpoints` (sequence, reason, phase, plan, state, transcript, `git_head`) |
| Event log | `agent_events` (session-scoped), `events` (Office) |
| Model switching inside the native agent | `src/coding-agent/controller.js` + `src/model-gateway/agentic/turn-gateway.js` |
| GitHub branch/PR/CI | `src/coding-agent/github.js`, Tool Broker |
| Owner questions and approvals | `agent_owner_inputs`, `agent_approvals`, Telegram (`src/channels/`) |
| Usage and capacity telemetry | `model_attempts`, `provider_status`, `capacity_snapshots`, `src/hub-capacity.js` |
| Alerts | `src/ops/ops-watch.js` (runs in the runtime every 15 minutes) |

**Rule:** inside one native session, model and provider failover stays in `turn-gateway.js`. The Supervisor works one level up, between different *agents* (CLIs and subscriptions). It never re-implements model routing.

## 3. Supervisor responsibilities

The Supervisor always knows the **baton**:
* current worker, task, project, repository, branch and worktree;
* phase;
* last commit and last checkpoint;
* test and CI status;
* files changed;
* next exact action and next worker;
* handoff status.

Per worker it also tracks:
* session and weekly usage;
* task tokens;
* reset time;
* rate limit and cooldown;
* estimated remaining capacity;
* health and recent failures.

**Every metric carries a basis:** `MEASURED` | `PROVIDER_REPORTED` | `ESTIMATED` | `UNKNOWN`. An unknown value is shown as UNKNOWN and is never filled with a guess.

## 4. Worker session state machine

```
STANDBY → ACQUIRING → ACTIVE → DRAINING → CHECKPOINTING → HANDOFF_READY → RELEASED
                         ↘ failure: RATE_LIMITED | QUOTA_EXHAUSTED | AUTH_REQUIRED | UNAVAILABLE | FAILED | ABNORMAL_EXIT
```

* **ACQUIRING:** the worker must hold the write lease (section 6) before it edits anything.
* **ACTIVE → DRAINING** happens when any of these is true:
  * usage reaches the warning threshold (default 85 % of a PROVIDER_REPORTED limit);
  * the burn-rate estimate predicts exhaustion within the next 2 checkpoints;
  * the session nears its age limit;
  * repeated errors occur;
  * a reset is announced.
* **DRAINING:**
  * Start no new large change.
  * Finish the nearest safe atomic step.
  * Run the relevant tests.
  * Checkpoint, then commit and push when the tree is green or the work is explicitly marked WIP.
  * Write the handoff.
  * Release the lease.
* **Never wait for 100 %.** An agent that hits its quota can no longer write its own handover, so the design depends on *periodic* checkpoints (section 5).

## 5. Checkpoints

### 5.1 When

A checkpoint is taken:
* after each milestone, each meaningful code change and each test result;
* after an architecture decision, a model or provider switch, or a CI result;
* every N turns or M minutes. The defaults are 10 turns or 15 minutes, both configurable.

If a worker disappears, the latest checkpoint is at most one interval old.

### 5.2 Schema: `continuity.checkpoint.v1`

```json
{
  "schema": "continuity.checkpoint.v1",
  "checkpoint_id": "uuid",
  "timestamp": "ISO-8601",
  "project_id": "uuid",
  "repository": "owner/repo",
  "branch": "codex/continuity-phase-a",
  "worktree": "path or null",
  "agent_id": "worker key, e.g. codex",
  "agent_type": "native|cli|manual",
  "session_id": "uuid",
  "objective": "one paragraph",
  "phase": "A",
  "status": "ACTIVE|DRAINING|HANDOFF_READY|...",
  "base_commit": "40-hex",
  "last_commit": "40-hex",
  "files_changed": ["path", "..."],
  "diff_summary": "short text",
  "tests_run": "command(s)",
  "tests_passed": 0,
  "tests_failed": 0,
  "ci_status": "success|failure|pending|none",
  "decisions": ["..."],
  "constraints": ["..."],
  "errors": ["..."],
  "quota_state": {"basis": "MEASURED|PROVIDER_REPORTED|ESTIMATED|UNKNOWN", "used_pct": null, "reset_at": null},
  "rate_limit_state": {"limited": false, "retry_after_s": null},
  "next_exact_action": "imperative sentence a new agent can execute",
  "unresolved_items": ["..."],
  "rollback_commit": "40-hex",
  "summary_md": "human-readable summary"
}
```

* **Storage:**
  * The authoritative copy lives in the `coding_checkpoints` row (section 10).
  * A mirror is committed to the branch as **.continuity/checkpoint.json** whenever the agent commits, so GitHub alone is enough to resume.
* **The native agent:** its `agent_checkpoints` rows stay as they are. The Supervisor writes a continuity checkpoint that *references* the native one (`native_checkpoint_id`).

## 6. Write lease

Exactly one worker may write to a given (repository, branch, worktree) at a time.

* **Fields:** `lease_id`, `project_id`, `repository`, `branch`, `worktree`, `worker_key`, `session_id`, `token`, `started_at`, `heartbeat_at`, `expires_at`, `checkpoint_id`, `status` (`ACTIVE` | `RELEASED` | `FROZEN` | `RECLAIMED`).
* **Uniqueness:** a partial unique index allows only one `ACTIVE` lease per (repository, branch).
* **Lifecycle:**
  * Acquire with an RPC that returns a token.
  * Heartbeat with the token (default every 60 s; expires after 5 minutes without one).
  * Release with the token. A release requires a checkpoint id.
  * The mechanics copy the proven `claim_agent_session` / `renew_agent_session_lease` design.
* **Stale lease:**
  1. The Supervisor marks it `FROZEN`.
  2. It locks the worktree, which simply means no new lease is issued until verification.
  3. It verifies that the branch head matches the last checkpoint's `last_commit`. If not, it records the extra commits in the next checkpoint.
  4. It marks the lease `RECLAIMED` and issues a new lease to the next worker.
* **Native sessions:** the native Office agent keeps its own `agent_sessions` lease for its process. The Supervisor's branch lease sits on top. The adapter holds both, so the two never disagree.

## 7. Development contract

Every worker loads, in this order:
1. `AGENTS.md`;
2. `docs/DEVELOPMENT-CONTRACT.md`;
3. `docs/HANDOVER.md`;
4. the latest continuity checkpoint;
5. the PR and branch state.

No worker invents architecture. A worker that disagrees writes the disagreement into `unresolved_items`.

## 8. Worker adapter contract (one interface)

```js
// Every adapter in src/continuity/adapters/* (to be created) exports:
{
  key: 'codex',                       // stable worker key
  capabilities(),                     // { headless, resume, structuredOutput, usageReporting, worktrees, maxContext, privacyClasses }
  async available(),                  // installed + authenticated + not in cooldown → { ok, reason }
  async health(),                     // { status: 'healthy|degraded|down', basis, detail }
  async start({ continuationPacket, worktree, branch, lease }),   // → { session }
  async resume({ session, continuationPacket }),
  async stop({ session, reason }),    // asks the worker to drain: finish step, checkpoint, exit
  async status({ session }),          // → normalized status (below)
  async usage({ session }),           // → { task_tokens, session_pct, weekly_pct, reset_at, basis }
  async checkpoint({ session }),      // → continuity.checkpoint.v1 (adapter collects git + test facts itself)
  async handoff({ session }),         // → final checkpoint + continuation packet text
}
```

**Normalized status:** `{ agent, status, session, usage, quota, reset, health, current_task, checkpoint, error }`.

**Rules:**
* The Supervisor logic never branches on the worker key. Differences live only in `capabilities()`.
* An adapter that cannot do something reports it in `capabilities()` and returns `UNKNOWN`. It never fakes a value.
* **Continuation packet:** a plain-text prompt built from the checkpoint and the contract. Every CLI worker receives the same packet. The template is in the plan.

## 9. Workers

Each CLI adapter starts with a **verification step 0**. Confirm the official CLI and the headless flags on the installed version, and record them in the adapter header. If no official headless path exists, the adapter is `MANUAL_OR_SEMI_AUTOMATIC`.

**Hard rules for every adapter:**
* No scraping.
* No reuse of consumer OAuth tokens as an API.
* No cookie automation.

| Worker | Mechanism (verify at step 0) | Accounting source | Notes |
|---|---|---|---|
| **Fahad Office Coding** | In-process: `create_coding_session` RPC + the existing worker | Office pools (`model_attempts`, `provider_status`) | First native worker. Reuses checkpoints, failover, GitHub and telemetry. |
| **Claude Code** | Official CLI headless mode (print mode, JSON output, session resume) | Claude subscription (separate from the Anthropic API) | A subscription worker, not an API token pool. Usage only where the CLI reports it officially. |
| **Codex** | Official Codex CLI non-interactive mode (exec, JSON events) in a git worktree; reads `AGENTS.md` | ChatGPT/Codex subscription | **The next development agent.** Its adapter comes first after the native one. |
| **Antigravity** | Official CLI/headless only. If none is available, MANUAL | Google AI Pro subscription, **separate** from Gemini API free capacity | Never add it to Gemini API capacity numbers. |
| **OpenCode** | `opencode run` / `opencode serve` API, sessions | Per underlying provider. OpenCode Zen free models only while free, legitimately accessed, data class allows, and **auto-reload OFF** | Zen capacity is tracked separately. |
| **Kilo Code** | Kilo CLI with auto/headless mode if supported | If signed in with ChatGPT/Codex: the **same** source as Codex (do not count twice). Kilo Auto Free: a separate pool only after live verification. | |
| **Freebuff** | `MANUAL_OR_SEMI_AUTOMATIC` | Freebuff allowance, recorded manually | Gets an availability flag, a manual handoff packet and manual usage entry. It is promoted to automatic later without redesign. |

## 10. Data model (additive; Codex writes the migration)

All tables are service-role only with RLS on, following the pattern in `supabase/migrations/20260925160000_coding_agent_foundation.sql`. The migration is additive, with no change to existing tables.

| Table | Purpose | Key columns |
|---|---|---|
| `coding_workers` | registry, one row per worker | `key` text PK, `display_name`, `kind` (native/cli/manual), `quota_source` (dedupe key, e.g. `openai-chatgpt`), `enabled`, `capabilities` jsonb, `health`, `health_basis`, `last_seen_at`, `last_error` |
| `coding_worker_sessions` | one row per worker run | `id` uuid PK, `worker_key` FK, `project_id`, `repository`, `branch`, `worktree`, `objective`, `status` (state machine), `native_session_id` FK→`agent_sessions` (nullable), `started_at`, `heartbeat_at`, `ended_at`, `task_tokens`, `tokens_basis`, `exit_reason` |
| `coding_leases` | the write lease | `id` uuid PK, `repository`, `branch`, `worktree`, `worker_key`, `session_id` FK, `token` uuid, `status`, `started_at`, `heartbeat_at`, `expires_at`, `checkpoint_id`. Unique partial index on (repository, branch) where status = 'ACTIVE'. |
| `coding_checkpoints` | schema v1 rows | `id` uuid PK, `session_id` FK, `sequence`, `payload` jsonb (validated by `schema` = v1), `last_commit`, `status`, `native_checkpoint_id` FK→`agent_checkpoints` nullable, `created_at`. Unique (session_id, sequence). |
| `coding_handoffs` | baton passes | `id` uuid PK, `from_session_id`, `to_session_id` (nullable until accepted), `from_worker`, `to_worker`, `checkpoint_id`, `reason`, `packet` text, `status` (PROPOSED/ACCEPTED/STARTED/FAILED), `created_at`, `accepted_at` |
| `coding_usage_snapshots` | quota and usage samples | `id` bigserial, `worker_key`, `quota_source`, `session_id` nullable, `taken_at`, `session_pct`, `weekly_pct`, `task_tokens`, `reset_at`, `basis`, `raw` jsonb (no secrets) |

**Indexes:**
* sessions: (`status`, `heartbeat_at`);
* checkpoints: (`session_id`, `sequence` desc);
* usage: (`worker_key`, `taken_at` desc);
* handoffs: (`status`, `created_at`).

**Retention:**
* usage snapshots: 90 days;
* checkpoints: kept, though `payload` may be compacted after 30 days to the last 3 per session plus the final one;
* handoffs and leases: kept (small).

**Naming (decided in Phase A):** the applied 2026-09-22 POC migration already owns `continuity_checkpoints` and `continuity_handoffs` (unused by code, never modified), so the Supervisor tables are `coding_checkpoints` and `coding_handoffs`. A `FROZEN` lease also blocks its branch until `reclaim_coding_lease` marks it `RECLAIMED`.

**RPCs:** `reclaim_coding_lease`, `acquire_coding_lease`, `heartbeat_coding_lease`, `release_coding_lease`, `freeze_stale_coding_leases`, `save_continuity_checkpoint` (token-guarded), `propose_handoff`, `accept_handoff`.

## 11. Supervisor service

* Runs inside the existing runtime (`src/index.js`), like the watchdog, behind `CONTINUITY_SUPERVISOR=true`. It is **off by default** until Phase N passes.
* **Event-driven:** worker heartbeats, checkpoints and CI webhooks. Polling is used only for CLIs that emit no events: at most every 60 s for status, and every 5 minutes for usage.
* **Loop:**
  1. Refresh worker availability.
  2. Detect stale leases and run crash recovery (section 14).
  3. Move ACTIVE workers past a threshold into DRAINING.
  4. For each HANDOFF_READY item, select the next worker (section 13), acquire the lease, build the packet, start it.
  5. Notify the owner only per section 15.

## 12. OpenHands / ACP and other bridges

**Use ACP / OpenHands for:**
* starting ACP-compatible agents through one transport;
* streaming structured events (tool calls, edits) from agents that support ACP;
* a sandboxed runtime when a worker needs one.

**Do not use ACP / OpenHands for:**
* policy;
* worker selection;
* leases;
* quota accounting;
* checkpoints;
* the canonical state.

**Why:** the Supervisor must stay the single controller, and its state must live in Fahad's GitHub and Supabase. A bridge is replaceable; the controller is not.

goose, Cline and similar tools are evaluated as bridges only if one exposes a worker the stack cannot reach otherwise. They are never added as permanent workers just because they exist.

## 13. Selection policy

**Order of criteria:** quality and privacy → available capacity → task fit → cost → speed.

**Hard filters:**
* the privacy class is allowed for the worker's data path;
* the worker is `available()`;
* the worker is not in cooldown;
* the quota is not exhausted;
* the worker has the needed capability (for example, headless).

**By task size:**
* **Large or refactor:** Claude Code or Codex, otherwise the strongest qualified worker.
* **Medium:** the strongest healthy available worker.
* **Small:** native free, OpenCode or Kilo when qualified.

**Rules:**
* Never rotate just because a worker exists.
* Prefer the worker with measured MJE headroom (section 17).

## 14. Crash recovery

1. Detect the heartbeat timeout and mark the session `ABNORMAL_EXIT`.
2. Freeze the lease, which locks the worktree.
3. Load the latest checkpoint and verify the branch head and tree. Any commits made after the checkpoint are added to a recovery checkpoint.
4. Select the next eligible worker.
5. Build the continuation packet.
6. Acquire a new lease and start the worker.

Fahad does nothing.

## 15. Owner notifications (Telegram plus Needs Fahad)

Fahad is contacted only for:
* an expired login;
* a payment requirement;
* a privacy approval;
* all workers unavailable;
* CI failing 3 times on the same step;
* a merge or deploy blocker;
* a needed secret.

Routine handoffs are silent. They appear on the dashboard only.

## 16. Completion gates

A worker never declares success. The Supervisor runs the repository's checks itself:
* tests (`node --test`) plus lint, type and security checks where the repository has them;
* CI on the pushed head;
* the acceptance criteria from the task;
* a clean `git status`.

Only then does the session become `COMPLETED`. Otherwise it is `HANDOFF_READY` with `next_exact_action` set.

## 17. Usage dashboard and MJE

**Hub location:** Projects → project → *Coding continuity*. It is nested, never in the top-level navigation.

**Content:**
* **Baton card:** current worker and state, task, usage with its basis, task tokens, last checkpoint (number and time), last commit, tests, next worker.
* **Timeline:** one row per worker session, with status, tokens and basis.
* **Workers list:** status, task tokens, lifetime tokens where available, tasks completed and failed, average latency, success rate, handoffs, reset time, quota state, last active, last commit.

**MJE (Medium Job Equivalent):**
* **Baseline:** the measured Office medium benchmark. It is the 2026-09-29 run in `docs/HANDOVER.md` → *CAPACITY FINALIZATION*: 209.6K tokens, 21 turns, about 40.7 minutes, tests passed.
* **Recording:** for each worker, record medium jobs completed, usage before and after, elapsed time, tokens where available, turns, quality and tests passed.
* **Formula:** `MJE per session = 1 / (usage consumed by one medium job, as a fraction of the session or weekly limit)`.
* **Labels:** shown as `UNKNOWN` until **3 measured medium jobs** exist for that worker. After that it is `ESTIMATED` with the sample count.
* **No initial values are invented.**

## 18. Capacity accounting

Independent sources:
* Office free and API pools;
* the Claude subscription;
* the ChatGPT/Codex subscription;
* Google AI Pro (Antigravity);
* OpenCode providers and Zen;
* Kilo Auto Free;
* the Freebuff allowance.

**Deduplication:** the dashboard sums per `quota_source`, never per worker. For example, Codex direct and Kilo signed in with ChatGPT share one source, `openai-chatgpt`.
