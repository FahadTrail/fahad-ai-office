# V3.0 operations check — 2026-10-29

Six-task check of the live system after PR #146 (`b4f75d2`). Every figure
below was read from production (Supabase SQL, edge logs, advisors) or GitHub
in this session; nothing is carried over from older records. Statuses:
**DONE** (done and verified), **PARTIAL**, **BLOCKED** (owner step).

The agent environment still cannot reach `office.trimedia.me`, the VPS, or the
database port (its proxy refuses the hosts), so runtime health is read from the
database: the `runtime_started` event, worker heartbeats and edge logs.

## 1. Production and Google Drive — DONE

| Check | Evidence (UTC) |
| --- | --- |
| Deployed version | Event "Office runtime started on commit b4f75d2398a5" 2026-10-29 02:24:45; [deploy run 40805456181](https://github.com/FahadTrail/fahad-ai-office/actions/runs/40805456181) success |
| Restarts (10 in 24 h) | Each one is a deploy (`bcdb95a`, `dad6ac9`, `e24155f` ×2, `b4f75d2`) or the owner's Python image rebuild (5 starts of `5219bbb` between 17:41 and 17:55 on 10-28). No crash loop |
| Coding worker | `office` enabled, healthy, last heartbeat 15:27 on 10-29. Other 7 workers disabled |
| Continuity Supervisor | ON: 745 `freeze_stale_coding_leases` polls in edge logs between 03:00 and 15:28 (about one a minute) |
| Open work | 0 open objectives, 0 open tasks, 0 open coding sessions, 0 leases, 0 pending approvals |
| **Drive search + read** | Objective `7bb71b4e` (02:24): CHIEF planned one RESEARCH workstream → `drive_search` ×4 and `drive_read` ×2, all completed → CHIEF synthesis (2,421 chars) → Telegram notice. RESEARCH read the acceptance Doc in the Office folder and reported its marker `OFFICE-GOOGLE-ACCEPTANCE-OK` |
| CHIEF routing (#146) | The request before the fix (objective `63850aa6`, 01:56) was answered by CHIEF alone with no tools. Both requests after it (`7bb71b4e`, `1a96a5c5`) went CHIEF → RESEARCH → CHIEF |
| Privacy | Drive runs are PRIVATE: RESEARCH ran on `deepseek-flash` (owner privacy-approved, paid) and `web_search` was refused with `SEARCH_NOT_ALLOWED_FOR_DATA_CLASS`. Cost $0.0043 and $0.0082 per objective, under the $0.10 request cap |

**Defect found and fixed.** The question "is Drive connected?"
(`1a96a5c5`) made RESEARCH call `docs_create` and `sheets_create`, so it created
a test Doc and a test Sheet that Fahad never asked for. The rule "create only
if he asks" was only in the fallback brief (`workspacePlan`), and CHIEF had
written its own brief. The rule is now in both write tools' descriptions
(`src/integrations/google-workspace.js`), which RESEARCH always sees. Test:
`test/google-workspace.test.js` (red before, green after). Full suite 885/885.
No scope, credential or routing change. The two files the run created stay in
the Office folder; only Fahad deletes Drive files.

**Not done.** OAuth was not changed. The 8-day refresh-token check is still
scheduled for 2026-11-05. Whether the token survives past 7 days (Google
"Testing" mode) is proven only by that check.

## 2. Backup and restore — BLOCKED (owner)

* The correct project is `zkzibipinjeswhdxnfgf` (`fahad-ai-office`,
  ACTIVE_HEALTHY, PostgreSQL 17.6). Its organization "Fahad Dashboard" is on
  the **Pro** plan, which includes Supabase-managed daily backups. Their list is
  not exposed to the agent tools.
* This environment cannot make the independent copy:
  * no database credential;
  * the database host does not resolve through the proxy;
  * the local `pg_dump` is 16, and the drill refuses tools older than the
    server (17).
  * Copying rows through the SQL tool would put production data in a chat
    transcript, so it was not done.
* The coverage today (metadata only) is below. The owner's drill report should
  match it.

| Data | Today | In the drill |
| --- | --- | --- |
| `public` + `private` | 44 tables, about 2,110 rows, database 23 MB | Yes (row counts + structure) |
| Migration history | 39 rows, last `20261028054117` | Yes |
| `auth` | 2 users | No — Supabase daily backups only; a new e-mail OTP sign-in recreates the owner |
| `storage` | 0 buckets, 0 objects | Nothing to protect |
| `vault` | 0 secrets | Secrets live in the server `.env` |
| `backup_20261028` | 21 tables (in-database snapshot) | Not independent |

Owner command (runs on any machine with Docker, read-only against
production; the password is typed at a hidden prompt; keep the PASS report):

```sh
mkdir -p "$HOME/office-backups"
docker run --rm -it -v "$PWD":/w:ro -v "$HOME/office-backups":/backups -w /w postgres:17 \
  bash supabase/verify/restore-drill.sh --keep-dump /backups
```

The URI is in Supabase Dashboard → Connect → Session pooler (port 5432).

## 3. Coding Agent token: fixture repository access — BLOCKED (owner)

A fine-grained token's repository list is visible and editable only on the
owner's GitHub settings page. The steps are unchanged
([operational closure §2](V3-OPERATIONAL-CLOSURE-2026-10-28.md)). New fact:
`FahadTrail/fahad-office-python-acceptance` is **public**. It holds synthetic
data only. Removing it from the token does not affect production, because the
token value stays the same.

## 4. Budget, models and operations — DONE

| Item | Live value |
| --- | --- |
| Budget (Fahad AI Office workspace) | $2.00/month. Spent **$0.0125**, reserved $0.00, remaining $1.9875. Period ends 2026-11-01 |
| October attempts | 185 in total: 176 free and 9 paid, all on DeepSeek for the two Drive objectives. 25 failed (retried or failed over). Highest objective cost $0.0082 |
| Ops watch | It alerted on both paid batches (02:26, 02:39). They were expected: private data goes only to privacy-approved routes. No free-route billing incident |
| Routes | 45 in total: 30 healthy, 5 rate-limited, 2 quota-exhausted (OpenRouter Nemotron), 2 unavailable (Cerebras, `PROVIDER_INVALID_REQUEST`), 6 auth/credit errors |
| Routes with auth or credit errors | Kimi and MiniMax have no credits. Zhipu `glm-5.3-flash` has no credits. Qwen's account is not activated. The two OpenRouter Inkling routes return `PROVIDER_AUTH`. These are account states, and the router skips them; nothing to fix in code |
| Providers with recent success | Gemini 6/6 healthy (last 02:36 on 10-29), DeepSeek, Cloudflare 3/3 (10-28), Groq 2/3, OpenRouter 13/21 |
| Failover observed | Python session `b904334a`: Gemini transient → Groq rate limit → Cloudflare success. Objective `1a96a5c5`: the synthesis retried after a Gemini network error and finished |
| Security advisor | 0 ERROR. 1 WARN: leaked-password protection (the owner's choice; the Hub uses e-mail OTP). 32 INFO: RLS deny-by-default with no policies, by design |

Nothing was raised or enabled. No paid provider was added.

## 5. External coding workers (Claude Code CLI, Codex CLI) — BLOCKED (owner)

Both adapters exist and are disabled (`coding_workers`). Each needs a vendor
login on the VPS that only Fahad can do:

* **Claude Code CLI**:
  * version `>=2.1.268 <3`;
  * only `claude.ai` subscription or `setup-token` auth is accepted (an API key
    is refused, so there is no surprise billing);
  * runs with `--permission-mode dontAsk` in a supervisor-managed worktree.
* **Codex CLI**:
  * version `>=0.150.0 <1`;
  * needs `codex login`;
  * `workspace-write` sandbox and `approval_policy="never"`;
  * the host must pass `codex sandbox linux -- true`, or the worker reports
    `SANDBOX_UNAVAILABLE`.
* Enabling is the flags `CONTINUITY_CLAUDE_ENABLED` / `CONTINUITY_CODEX_ENABLED`
  in the server `.env`, then a worker restart. See
  `docs/CODING-CONTINUITY-SUPERVISOR.md`.
* This session used no credentials from other tools.

## 6. GitHub and security — PARTIAL

**Private test repository.** It was not created. The GitHub connector
(signed in as FahadTrail) was refused: `403 Resource not accessible by
integration` on repository creation. Owner steps:

1. Create an empty private repository `fahad-office-agent-sandbox`. It is free.
2. Add it to the Coding Agent token with these permissions:
   * Contents: read/write;
   * Pull requests: read/write;
   * Commit statuses: read;
   * Actions: read;
   * Metadata: read.

**Making `fahad-ai-office` private — decision: POSTPONE.**

* **Deploy would break.** `ops/deploy.sh` (lines 63–68) fetches `main`
  anonymously from `https://github.com/FahadTrail/fahad-ai-office.git`. On a
  private repository every deploy fails at that fetch. The fix is server-side:
  * a read-only deploy key, or a read-only fine-grained token in a root-owned
    file;
  * a reviewed `ops/install-deploy.sh` run.

  That is a root change on the VPS that the agent cannot make.
* **Coding Agent: no break.** It clones and pushes with `CODING_GITHUB_TOKEN`
  (`src/coding-agent/sandbox.js`), which already reaches private repositories.
* **Cost: within the free allowance, if no other private repository uses much
  of it.**
  * Each validate run is 1 job of about 1.6 min (billed 2 min). Each deploy is
    1 job of about 3 min (billed 4 min).
  * 410 runs since 2026-09-21 come to roughly 840 billed minutes per 30 days.
  * GitHub Free includes 2,000 private minutes a month.
  * The account's other private repositories share that allowance. Their usage
    and the account plan were not visible to this session.
* **Models.** The Coding Agent on its own repository would have to use PRIVATE
  code privacy. Free public-only routes (OpenRouter and others) stop
  qualifying. Work then goes to privacy-approved routes, mostly paid DeepSeek
  at about $0.004–0.008 per objective today. That is small, but it is no
  longer $0.
* **Order if Fahad approves:**
  1. Read-only deploy credential plus a reviewed `install-deploy.sh` run.
  2. A deploy succeeds on the public repository with the new credential.
  3. Switch the visibility.
  4. Dispatch a deploy and verify `/healthz`.
  5. Run one Coding Agent session with PRIVATE.
