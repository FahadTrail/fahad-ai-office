# Development contract (every coding worker)

Applies to every worker in the permanent stack: the Office Coding Agent, Claude Code, Codex, Antigravity, OpenCode, Kilo Code and Freebuff. It adds continuity rules on top of `AGENTS.md`. If the two disagree, `AGENTS.md` wins and the disagreement is recorded in the checkpoint's `unresolved_items`.

## 1. Load order

1. `AGENTS.md`;
2. this file;
3. `docs/HANDOVER.md`;
4. the latest continuity checkpoint: **.continuity/checkpoint.json** on the branch (created from Phase A on) or the CONTINUITY_CHECKPOINT block in the PR or in `docs/CODEX-CONTINUE.md`;
5. the PR, branch and CI state on GitHub.

Conversation memory is never the source of truth. GitHub is.

## 2. Do not restart, do not redesign

* Continue from `next_action` / `next_exact_action`. Do not re-plan finished phases.
* The architecture in `docs/CODING-CONTINUITY-SUPERVISOR.md` is locked. Changing it needs Fahad's approval; propose it in `unresolved_items`.
* Keep the system provider-neutral and free-first. No silent paid fallback.

## 3. Branches and commits

* One branch per task or phase (`codex/continuity-phase-a`, …), cut from the latest `main`. Never push to `main`; never force-push a branch another worker used.
* Small commits with clear messages. Run `node --test` before every push.
* Open a PR per phase. CI must be green. Merging to `main` deploys production and needs Fahad's approval; so does any production migration.
* Database: a new timestamped migration only, never edit an applied one; regenerate `supabase/verify/schema-fingerprint.txt` with the replay; add a scenario for new functions.

## 4. Write lease

* Only the lease holder writes to the branch. Without a lease (before Phase B exists): one worker per branch, declared in the PR's checkpoint block.
* Heartbeat while working. On a stop request: finish the current step, commit, checkpoint, release.

## 5. Checkpoints

* Write one after every milestone, meaningful code change, test result, architecture decision or CI result, and at least every 10 turns or 15 minutes.
* Every field is concrete. Unknown values are `none` or `UNKNOWN`, never invented.
* `next_exact_action` is an imperative sentence another agent can execute without asking.

## 6. Handoff

* Before you run out of capacity: stop at a clean point, commit, push, write the checkpoint, update `docs/HANDOVER.md` if the phase changed.
* The next worker reads the same files and continues. Fahad does not re-explain.

## 7. Completion gates

A worker never declares a task done. It is done only when:
* `node --test` passes (and lint/type/security checks where they exist);
* CI is green on the pushed head;
* the phase's acceptance criteria in `docs/CONTINUITY-IMPLEMENTATION-PLAN.md` are met;
* `git status` is clean.

## 8. Protected behaviour (do not touch without Fahad)

* Core routing and capacity: `src/model-gateway/`, `src/hub-capacity.js`.
* FINANCE arithmetic, AUDIT code checks and the CHIEF fact gate (`src/office/finance.js` and `docs/v41-reliability.md`).
* The V5 immersive Office and the V4 UI, except the nested continuity view of Phase L.
* Deployment files: `Dockerfile`, `docker-compose.yml`, `ops/deploy.sh` (they change only via a reviewed root run of `ops/install-deploy.sh`).
* Hermes and its backup or retained directories: never read, modify, restore or reconnect.

## 9. Security and privacy

* Never print, log, commit or return secrets. Keys are set by Fahad with `sudo bash ops/set-secret.sh NAME`; never ask for them in chat.
* No scraping of consumer UIs, no reuse of consumer login or OAuth tokens as an API, no cookie automation. Official CLIs and APIs only.
* Respect each worker's privacy class. Private data never goes to a provider whose privacy flag does not allow it.
* Never buy anything. Never enable OpenCode auto-reload.

## 10. Quota and usage truth

Every number carries its basis: `MEASURED`, `PROVIDER_REPORTED`, `ESTIMATED` or `UNKNOWN`. Do not claim quota a provider does not report. Count shared sources once (for example, Kilo signed in with ChatGPT shares `openai-chatgpt` with Codex; Antigravity's Google AI Pro is not Gemini API capacity).
