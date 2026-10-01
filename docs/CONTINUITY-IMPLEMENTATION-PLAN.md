# Coding Continuity Supervisor — implementation plan (for Codex)

Status: **Phase A DONE on branch `claude/continuity-foundation`, PR #102 (open, migration NOT applied). Phase B is next.** The architecture is locked in `docs/CODING-CONTINUITY-SUPERVISOR.md`; this file is the build order. Rules for every phase are in `docs/DEVELOPMENT-CONTRACT.md`.

Paths written in **bold** below do not exist yet; the phase that names them creates them. Existing paths are in `backticks`.

## Ground rules for all phases

* One branch per phase, cut from the latest `main`: `codex/continuity-phase-<letter>` (lowercase letter). One PR per phase. Never push to `main`.
* `node --test` must be green before every push, and CI must be green before merge. Merging to `main` deploys production; **merges need Fahad's approval**.
* The Supervisor ships **off**: `CONTINUITY_SUPERVISOR` is unset/false by default and stays off in production until Phase N passes and Fahad turns it on.
* No change to core routing, capacity, FINANCE/AUDIT/fact gate, the V5 UI, or anything Hermes-related (see `docs/HANDOVER.md` → *DO NOT TOUCH*).
* The native in-session failover in `src/model-gateway/agentic/turn-gateway.js` is not modified. The Supervisor works between agents.
* Tests use fakes: no network, no credentials, no AI calls, no real CLIs (the same rule as the rest of `test/`). External CLIs are reached only through an injectable `spawn` so tests can replace them.
* Every metric carries a basis: `MEASURED`, `PROVIDER_REPORTED`, `ESTIMATED` or `UNKNOWN`. No invented numbers.
* Write a continuity checkpoint (template at the end) into the PR description and into **.continuity/checkpoint.json** at the end of every phase.

## Migrations and production

* `supabase/migrations/` mirrors production one-to-one (`supabase/verify/README.md`), and `test/schema-replay.test.js` compares a replay with `supabase/verify/schema-fingerprint.txt`.
* Therefore the Phase A migration is merged **only together with** Fahad's approval to apply it to production (`apply_migration` on project `zkzibipinjeswhdxnfgf`, then the read-only fingerprint check). Until that approval the Phase A PR stays open; later phases branch from the Phase A branch and are merged after it, in order.
* The migration is additive: new tables and functions only, no change to existing objects.

---

## Phase A — schema and domain types (DONE, PR #102)

**Goal:** the six tables, their RPCs and the pure domain module, with no runtime behaviour.

**Files:**
* **supabase/migrations/20261004090000_coding_continuity.sql** (use the real UTC timestamp at writing time if later; keep the name `coding_continuity`):
  * tables `coding_workers`, `coding_worker_sessions`, `coding_leases`, `coding_checkpoints`, `coding_handoffs`, `coding_usage_snapshots` exactly as in `docs/CODING-CONTINUITY-SUPERVISOR.md` → section 10;
  * check constraints for every enum (session states from section 4 of the architecture, lease status, handoff status, basis);
  * `coding_leases`: unique partial index on (repository, branch) where status = 'ACTIVE';
  * `coding_checkpoints`: unique (session_id, sequence); check that `payload->>'schema' = 'continuity.checkpoint.v1'`; `last_commit` matches `^[0-9a-f]{40}$`;
  * RPCs `acquire_coding_lease`, `heartbeat_coding_lease`, `release_coding_lease` (requires a checkpoint id), `freeze_stale_coding_leases`, `save_continuity_checkpoint` (token-guarded), `propose_handoff`, `accept_handoff`. Copy the locking style of `claim_agent_session` / `renew_agent_session_lease` in `supabase/migrations/20260925160000_coding_agent_foundation.sql` (`security definer`, `set search_path = ''`, row locks, explicit errors);
  * RLS on every table; revoke all from `public`, `anon`, `authenticated`; grant only what `service_role` needs; revoke function execute from `public`/`anon`/`authenticated` and grant it to `service_role` — the same pattern as the foundation migration;
  * seed `coding_workers` with the seven permanent workers (`office`, `claude-code`, `codex`, `antigravity`, `opencode`, `kilo`, `freebuff`), `enabled = false` except `office`, `health = 'unknown'`, and `quota_source` values: `office-pools`, `anthropic-claude-subscription`, `openai-chatgpt`, `google-ai-pro`, `opencode`, `kilo-auto-free` (Kilo's row is changed to `openai-chatgpt` when it is signed in with ChatGPT), `freebuff`.
* **supabase/verify/scenarios/coding_continuity.sql** — rolled-back scenario: acquire → second acquire on the same branch fails → heartbeat with a wrong token fails → save checkpoint → release without checkpoint fails → release with checkpoint → freeze of an expired lease → propose/accept handoff.
* `supabase/verify/schema-fingerprint.txt` — regenerated with the replay (`supabase/verify/README.md` → *Changing the schema*), never by hand.
* **src/continuity/checkpoint.js** — `validateCheckpoint(obj)` for `continuity.checkpoint.v1` (required fields, 40-hex commits, basis enum, no secret-looking strings via the existing redaction helpers), `checkpointToMarkdown(obj)`.
* **src/continuity/states.js** — the state list and the allowed transitions from architecture section 4, `canTransition(from, to)`.
* **test/continuity-schema.test.js** and **test/continuity-checkpoint.test.js**.

**Acceptance:**
* `npm run db:replay` succeeds and the scenario passes; the fingerprint file is regenerated and `test/schema-replay.test.js` is green.
* All transitions in section 4 are accepted; every other pair is rejected.
* An invalid checkpoint (missing `next_exact_action`, short commit, unknown basis, a token-like string) is rejected with a named reason.
* `node --test` green. No file outside the list above changes (plus **.continuity/checkpoint.json** and `docs/HANDOVER.md`).

## Phase B — lease and checkpoint engine

**Files:** **src/continuity/store.js** (thin Supabase wrapper over the Phase A RPCs, injectable client), **src/continuity/lease.js** (acquire/heartbeat timer/release, stale detection), **src/continuity/checkpointer.js** (interval policy: every 10 turns or 15 minutes, plus milestone, test and CI events; writes the row and the **.continuity/checkpoint.json** mirror on commit), **test/continuity-lease.test.js**, **test/continuity-checkpointer.test.js**.

**Acceptance:** with a fake client: a second writer cannot acquire; a missed heartbeat past 5 minutes is detected as stale; release without a checkpoint is refused; the checkpoint interval fires at 10 turns and at 15 minutes (fake clock), whichever is first; the mirror file equals the stored payload.

## Phase C — Supervisor controller

**Files:** **src/continuity/supervisor.js** (the loop in architecture section 11: refresh availability → freeze stale leases and recover → move workers past a threshold to DRAINING → select and start the next worker for each HANDOFF_READY → notify per section 15), **src/continuity/select.js** (section 13 filters and ordering), **src/continuity/packet.js** (continuation packet, template below), **src/continuity/gates.js** (section 16 completion gates), wiring in `src/index.js` behind `CONTINUITY_SUPERVISOR=true` (off by default, like `OPS_WATCH`), **test/continuity-supervisor.test.js**, **test/continuity-select.test.js**.

**Acceptance:** with fake adapters: DRAINING at 85 % of a `PROVIDER_REPORTED` limit and never on `UNKNOWN`; crash recovery (section 14) runs without owner action; selection never picks a worker that fails a hard filter; two workers with the same `quota_source` are counted once; a worker's "success" without passing gates ends as HANDOFF_READY; the runtime does not start the Supervisor when the flag is unset.

## Phase D — Office Coding Agent adapter

**Files:** **src/continuity/adapters/office.js**, **test/continuity-adapter-office.test.js**.

Maps the adapter contract (architecture section 8) onto the existing native worker: `start` → `create_coding_session`; `resume` → `resume_agent_session`; `status` from `agent_sessions` + `agent_events`; `usage` from `model_attempts` (`MEASURED`); `checkpoint` references the latest `agent_checkpoints` row through `native_checkpoint_id`. No change to `src/coding-agent/` beyond, at most, exported helpers.

**Acceptance:** the shared contract checks pass for the Office adapter. They live in **src/continuity/adapter-contract.js**, created here as an exported function that every adapter test calls. It is not placed under test/, because Node runs every file there as a test.

## Phase E — Codex adapter (first external)

**Step 0:** on the installed Codex CLI, confirm the official non-interactive command, JSON event output, resume support and working-directory flag; write the exact verified invocation and CLI version in the adapter header. If a flag does not exist, report it in `capabilities()`; do not guess.

**Files:** **src/continuity/adapters/codex.js**, **src/continuity/worktree.js** (one `git worktree` per active external worker, created from the leased branch, removed after release), **test/continuity-adapter-codex.test.js** (fake spawn replaying recorded JSON events).

**Acceptance:** contract suite passes; usage is `PROVIDER_REPORTED` only if the CLI emits it, else `UNKNOWN`; the adapter reads `AGENTS.md` through the packet, not through hidden prompts.

## Phase F — Claude Code adapter

**Step 0:** confirm the official headless/print mode, JSON output and session resume on the installed CLI. Subscription worker: never use its login as an API key, never scrape the consumer UI.

**Files:** **src/continuity/adapters/claude-code.js**, **test/continuity-adapter-claude-code.test.js**. **Acceptance:** contract suite passes; usage basis as for Codex.

## Phase G — Google Antigravity adapter

**Step 0:** determine whether an official CLI/headless mode exists. If it does not, the adapter is `MANUAL_OR_SEMI_AUTOMATIC` (same shape as Phase J). Its `quota_source` is `google-ai-pro`, never added to Gemini API capacity.

**Files:** **src/continuity/adapters/antigravity.js**, **test/continuity-adapter-antigravity.test.js**. **Acceptance:** contract suite passes in whichever mode step 0 found; a test asserts Gemini API capacity totals are unchanged by it.

## Phase H — OpenCode adapter

**Step 0:** confirm `opencode run` / `opencode serve` and session APIs on the installed version.

**Files:** **src/continuity/adapters/opencode.js**, **test/continuity-adapter-opencode.test.js**. **Rules:** OpenCode Zen is eligible only if the model is currently free, the promotion is active, access is legitimate, the data class permits it, and auto-reload is **off**; otherwise the adapter reports `available() = { ok: false, reason }`. **Acceptance:** contract suite passes; each Zen condition has a failing-case test.

## Phase I — Kilo Code adapter

**Step 0:** confirm a supported headless/auto mode. If none, MANUAL.

**Files:** **src/continuity/adapters/kilo.js**, **test/continuity-adapter-kilo.test.js**. **Rule:** when signed in with ChatGPT/Codex its `quota_source` is `openai-chatgpt` (shared with Codex). Kilo Auto Free is a separate pool only after a live verification. **Acceptance:** contract suite passes; a dedupe test shows Codex + Kilo-on-ChatGPT counted once.

## Phase J — Freebuff (manual or semi-automatic)

**Files:** **src/continuity/adapters/freebuff.js**, **test/continuity-adapter-freebuff.test.js**. Availability flag set by Fahad, a manual handoff packet (the continuation packet as copyable text in the Hub), manual usage entry with basis `MEASURED` (entered) or `UNKNOWN`. No scraping, no automation of its UI. **Acceptance:** contract suite passes in manual mode; promoting it to automatic later only replaces `start/status/usage`.

## Phase K — usage and MJE

**Files:** **src/continuity/usage.js** (snapshots into `coding_usage_snapshots`, sum by `quota_source`), **src/continuity/mje.js** (architecture section 17 formula), **test/continuity-mje.test.js**.

**Acceptance:** MJE is `UNKNOWN` with fewer than 3 measured medium jobs, `ESTIMATED` with the sample count after; the baseline is the measured Office medium benchmark (209.6K tokens, 21 turns, about 40.7 minutes) and no other starting value exists in code.

## Phase L — Hub dashboard

**Files:** **src/hub-continuity.js** (read-only API), a nested view under Projects → project → *Coding continuity* in `src/hub-ui/` (baton card, timeline, workers list per architecture section 17), tests for the API shape and axe for the new view (follow `docs/v4-experience.md` for QA tooling).

**Acceptance:** nothing added to the top-level navigation; axe 0 violations in both themes; every number shows its basis; preview data is fictional.

## Phase M — end-to-end tests

**Files:** **test/continuity-e2e.test.js**: fake Office → fake Codex → fake Claude Code handoff over a real temporary git repository (branch, worktrees, commits), including a killed worker mid-step and recovery from its last checkpoint.

**Acceptance:** the final branch contains every worker's commits in order; exactly one lease was ACTIVE at any time; the recovery checkpoint lists commits made after the crashed worker's last checkpoint.

## Phase N — real handoff drill (with Fahad)

A small real task on a throwaway branch: Office starts → forced DRAINING → Codex continues → forced DRAINING → Claude Code or Antigravity finishes → gates → PR. Record evidence (session ids, checkpoints, commits, CI run) in `docs/HANDOVER.md`. Only after this passes does Fahad decide whether to set `CONTINUITY_SUPERVISOR=true` in production.

---

## Continuation packet template

Every external worker receives this text (filled from the latest checkpoint) as its first prompt:

```
You are continuing work on <repository> as part of the Fahad AI Office coding stack.
Do not restart or redesign. GitHub is the source of truth.

Read first, in order: AGENTS.md, docs/DEVELOPMENT-CONTRACT.md, docs/HANDOVER.md,
then the checkpoint below.

Branch: <branch>   (you hold the write lease; do not push elsewhere)
Base commit: <base_commit>   Last commit: <last_commit>
Objective: <objective>
Phase: <phase>
Done so far: <summary of decisions and completed items>
Tests: <tests_run> → <tests_passed> passed, <tests_failed> failed. CI: <ci_status>
Unresolved: <unresolved_items>
Constraints: <constraints>
Do not touch: <do_not_touch list>

Next exact action: <next_exact_action>

Rules: commit small steps; run `node --test` before each push; update
.continuity/checkpoint.json with every commit; when asked to stop, finish the
current step, write a checkpoint and exit. Never claim success; the
Supervisor runs the completion gates.
```

## Continuity checkpoint template (PR description and handover)

```
CONTINUITY_CHECKPOINT
agent:
next_agent:
repository:
main_commit:
production_commit:
branch:
commit:
pr:
objective:
phase:
status:
completed:
next_action:
tests:
ci:
deploy:
blockers:
files_changed:
do_not_touch:
rollback:
timestamp:
```

Every field gets a concrete value or the word `none`. Never "TBD".
