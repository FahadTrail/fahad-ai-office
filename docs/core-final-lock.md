# Core Final Lock

Purpose: the checklist and procedures that make the core (router, providers, Coding Agent, Office workflow, Hub API) safe to freeze.

Status keys:
* **EXISTS**: in production today.
* **PREPARED**: built on a branch or PR, deployed after the burn-in.
* **GAP**: must be closed before the lock.

## 1. Health and monitoring

| # | Item | Status | How |
|---|---|---|---|
| 1 | Production health | EXISTS | Docker healthcheck + `src/healthcheck.js` (required RPCs, runtime heartbeat). `/healthz` returns the deployed commit (`version`). Deploy: 3 healthy observations or automatic rollback (`ops/deploy.sh`). |
| 2 | Provider health | EXISTS | `provider_status` (health, cooldown, consecutive failures, reported `rate_limit`). `/api/capacity` → pools with state available / degraded / exhausted. Demotion of routes that never succeed (`NEVER_SUCCEEDED`, `LOW_SUCCESS_RATE`). |
| 3 | Quota / reset monitoring | EXISTS | Reset schedules per provider (`free-quota.js`), daily snapshots (`capacity_snapshots`), provider-reported per-minute quotas (Gemini `QuotaFailure`, Groq headers). |
| 4 | Paid-fallback alerts | **GAP → PREPARED** | Paid calls are budget-gated (the workspace budget blocks them at $2/month) and visible in `model_attempts.cost_usd`, but no push alert exists. `tools/ops-watch.mjs` (see §5) alerts on any paid call in the window. |
| 5 | Unexpected-cost alerts | **GAP → PREPARED** | The free-route guard blocks and charges a route that bills or reroutes (`free-guard.js`, event `guard`). `ops-watch` alerts on any `paid_on_free_route` / `free_route_model_mismatch` incident and on any paid call. |
| 6 | Auth-failure alerts | **GAP → PREPARED** | Account blockers set `health = auth_error` (`provider-state.js`). `ops-watch` alerts when a route with a key enters `auth_error`. |
| 7 | Provider outage handling | EXISTS | Failover per turn (`turn-gateway.js`); cooldowns; capacity waits with auto-resume (`WAITING_FOR_CAPACITY`, `defer_task`); size compaction when only the request size blocks (#87); **reset-aware backoff PREPARED** (the "[after burn-in] reset-aware backoff" PR). |
| 8 | Coding checkpoint recovery | EXISTS, live-proven | Durable checkpoints (`agent_checkpoints`), leases, resume after worker restart (sessions `7986c750`, `f94a2cbe`, `ed64507a`). Checkpoint reasons are contract-tested against the DB constraint (#83). |
| 9 | Telegram health | EXISTS | Startup event `telegram_channel` (`ok`, `owner_paired`); pending items re-announced after restart. |
| 10 | Supabase health | EXISTS | Healthcheck RPC list; startup `supabase_tools_check` (read-only role, project scope, write guard). |
| 11 | GitHub integration health | EXISTS (partial) | The Coding Agent publishes through the Tool Broker (branch push, PR, CI read). Health is visible per session; there is no standalone probe. `ops-watch` reports sessions blocked on GitHub errors. |

## 2. Recovery

| # | Item | Status | Procedure |
|---|---|---|---|
| 12 | Rollback procedure | EXISTS | Automatic: `ops/deploy.sh` restores the previous `src/` when the candidate fails the healthcheck. Manual: GitHub **Revert** on the PR → the push deploys the previous code (same pipeline). |
| 13 | Disaster recovery | EXISTS (documented) | State lives in Supabase (`zkzibipinjeswhdxnfgf`); the VPS is stateless apart from `.env`. Rebuild: fresh VPS → `ops/install-deploy.sh` (root, reviewed) → restore `.env` from the owner's secret store with `ops/set-secret.sh` → push/redeploy `main`. |
| 14 | Backup verification | **GAP** (owner) | Supabase managed backups: Fahad confirms in the Supabase dashboard → Database → Backups that daily backups (or PITR) exist for the project. Migrations are replayable: `npm run db:replay` + schema fingerprint (`supabase/verify/`). |
| 15 | Deployment rollback drill | PREPARED | After the burn-in: revert the last docs-only commit is not a drill (it does not deploy); the drill is a revert of a harmless `src/` change, observing the "DEPLOYMENT SUCCESSFUL" log and `/healthz` version flip back. |
| 16 | Provider kill switches | EXISTS | Per workspace: `workspace_routing_policies.excluded_routes` (Hub → Models → routing policy). Per provider: remove its key with `ops/set-secret.sh` (route becomes `CREDENTIAL_MISSING`) or set `<PROVIDER>_BILLING_CLASS`. Free-only per job: `jobs.free_only`. |

## 3. Guarantees (tests)

| # | Item | Status | Tests |
|---|---|---|---|
| 17 | Free-only guarantee | EXISTS | `free-guard` tests (billed/rerouted free call → charged, blocked 24 h, failover); `allowPaid:false` / `free_only` routing tests; burn-in: 0 paid calls. |
| 18 | Privacy enforcement | EXISTS | Data-class gates (`test/capacity-v2.test.js`, `test/capacity-model.test.js`); unknown class fails closed to PRIVATE; `docs/private-coding-policy.md`. |
| 19 | Production smoke test | PREPARED | §4 below (10 minutes, read-only apart from one $0 job). |
| 20 | Final acceptance checklist | PREPARED | §6 below. |

## 4. Production smoke test (after every lock-relevant deploy)

1. `/healthz` returns the expected commit.
2. Startup events: `supabase_tools_check.ok = true`, `telegram_channel.ok = true`.
3. `/api/capacity` returns 200 and `capacity.publicCoding` is present.
4. One free-only Office question (CHIEF answer) completes at $0.
5. One small PUBLIC coding benchmark (`tools/coding-benchmark.mjs start --task=small`, unpinned) completes, or reaches its first turn, at $0.
6. `model_attempts` in the window: 0 paid calls.
7. No route with a key in `auth_error`.
8. The capacity snapshot for the day is written.

## 5. Alert watchdog (`tools/ops-watch.mjs`, PREPARED)

A read-only script, run from cron on the VPS every 15 minutes. It sends at most one Telegram message per new finding, through the existing bot and owner chat. It changes no routing and no state; it only reads.

| Alert | Condition |
|---|---|
| Paid call | any `model_attempts.cost_usd > 0` in the window |
| Free-route incident | Office `events` (`payload.kind = 'free_route_incident'`) or Coding `agent_events` `guard` (`FREE_ROUTE_INCIDENT`) with `paid_on_free_route` / `free_route_model_mismatch` |
| Auth failure | `provider_status.health = 'auth_error'` for a configured route |
| Capacity starvation | a task failed after 48 capacity waits |
| Coding blocked | an `agent_sessions` row `blocked` in the window, with its error code |
| Hub down | `OPS_WATCH_HEALTH_URL` (e.g. `http://127.0.0.1:2132/healthz`) fails; re-announced hourly. The runtime heartbeat itself is a file inside the container, watched by the Docker healthcheck |

## 6. End-of-burn-in execution plan (Track K)

At **2026-09-30T21:56Z**, in order, with no waiting between steps:

1. **Report.** Run the collector for the exact window:
   `node tools/burnin-report.mjs --since=2026-09-29T21:56:00Z --hours=24`
   (on the VPS; or the checkpoint SQL in `docs/capacity-v2.md` §9).
2. **Validate the numbers.** Tokens per provider sum to the total; 0 paid calls unless a paid fallback was intended; coding sessions match `agent_sessions`; the snapshot for 2026-09-30 exists.
3. **Compare with the baseline.**
   * Estimated capacity (2026-09-29): 3.09M free tokens/day, strong reasoning 0.58M/day, 47 (p50) / 13 (p90) projects/day.
   * Measured before the burn-in: 100 % free since 2026-09-28; small job 87–98K tokens / 7.5–20 min; medium 210K / 41 min.
4. **Bottlenecks:** the report's ranked `bottlenecks` list.
5. **Approve or reject the prepared PRs**, in this order:
   * reset-aware backoff;
   * burn-in report and bottleneck analyzer;
   * alert watchdog;
   * any provider readiness PR.
   Each needs green CI; none changes privacy or free/paid policy.
6. **Merge** the approved PRs one at a time (each push deploys).
7. **Deploy verify** after each: the deploy log says "DEPLOYMENT SUCCESSFUL", `/healthz` shows the new version, and the startup events are OK.
8. **Smoke:** §4.
9. **Core Final Lock:** tick §1–§3; close the GAP rows (backup confirmation is Fahad's).
10. **Final production acceptance:** §7; HANDOVER updated; verdict CORE READY / NOT READY.

## 7. Final acceptance checklist

- [ ] Free-first works: ≥ 95 % of calls free in the burn-in.
- [ ] Paid fallback is controlled: every paid call was allowed by policy and budget.
- [ ] Public coding works: small and medium jobs completed at $0.
- [ ] Two-pool failover works: session `12a9cad3` passed, plus any real switches in the window.
- [ ] Capacity telemetry is trustworthy: the report numbers are reconciled (step 2).
- [ ] The router is stable: no crash loops and no controller errors in the window.
- [ ] Provider health is stable: no unexplained `auth_error`; dead routes are demoted.
- [ ] The burn-in is complete: 24 h window covered.
- [ ] Privacy is enforced: no PRIVATE session on a PUBLIC route.
- [ ] Rollback is ready: the automatic rollback exists and a manual revert is documented.
- [ ] No critical blocker is open.
