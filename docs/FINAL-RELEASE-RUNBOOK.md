# Final release runbook: V4 CLOSED → router → providers → V5.1

Prepared 2026-09-28 (about 21:30 UTC) in a read-only rehearsal sprint.
Nothing in this file has been executed on production. It is the exact path
from **V4 CLOSED** to the three draft PRs running in production, one at a
time, each with a stop condition and a way back.

* **Merging to `main` deploys production** (`.github/workflows/deploy.yml`
  → SSH forced command → root-owned `ops/deploy.sh`). Every merge below is a
  production change and needs Fahad's approval at the moment it happens.
* **Known good production commit:** `13f09ea` (main today; V4 + V4.1).
* No secret appears in this file. Commands that handle secrets prompt for
  them on the server.

Contents:
1. Rehearsal results
2. Migrations
3. Phases A–K (command / expected result / stop condition / rollback)
4. Rollback plan
5. Mistral account finding
6. Final acceptance test
7. 24-hour capacity measurement
8. V5 production readiness
9. Owner checklist

---

## 1. Rehearsal results (local throwaway worktrees only; nothing pushed)

| Step | Result |
|---|---|
| All three PRs branch from `main` `13f09ea` | Yes: no base drift. |
| `main` → PR #72 (`claude/router-efficiency-v1`, `66cf3ee`) | Fast-forward, no conflict. |
| → PR #73 (`claude/provider-expansion-prep`) | Fast-forward (stacked on #72), no conflict. |
| #72 + #73 full suite | **401 / 401 pass** (includes the migration replay against the recorded production schema). |
| + PR #71 (`claude/v5-immersive-office`, `19c13b8`) | One conflict: `docs/HANDOVER.md` (both branches created it). Resolved by keeping the full handover and appending the V5 section. |
| #72 + #73 + #71 full suite | **430 / 430 pass.** |

**Overlap analysis (#71 against #72 + #73):**
* Only one overlapping file: `docs/HANDOVER.md` (docs, add/add).
* Backend: #71 changes `src/hub-office.js`, `src/hub-office-live.js` and
  `src/office/artifacts.js`. #72/#73 change `src/hub-workspace.js`,
  `src/hub-capacity.js`, the model gateway and the Office runner. The two
  sets do not overlap, and `/api/office` (V5) and `/api/capacity` (router)
  are independent endpoints.
* Dependencies: #71 adds `three` and `esbuild` as **devDependencies only**.
  The image installs with `npm ci --omit=dev`; the engine ships pre-built
  inside `src/`.
* Migrations: **none** in any of the three PRs.
* Route metadata: only #72/#73 touch routes; #71 touches none.
* Tests: no test conflicts; the suites simply add up.

**Safe merge sequence:** #72 → deploy → verify → #73 → deploy → verify →
(Mistral, optional) → #71 only after Fahad's visual approval, with `main`
merged into the #71 branch first.

## 2. Migrations

* **Production has every repository migration applied.** That is 30, the
  latest being `20261002090000_job_free_only`, checked with the Supabase
  migration list on 2026-09-28.
* **PR #72, #73 and #71 add no migration.** There is nothing to run and
  nothing destructive, and no index, RLS or constraint change. Existing rows
  are untouched.
* The only database write in this release is **optional**: the Mistral
  workspace authorization row (Phase G). It is one additive `insert`, and
  its rollback is one `update … set enabled=false`.
* If a future PR adds a migration:
  * replay it locally first with `npm run db:replay`;
  * update `supabase/verify/schema-fingerprint.txt`;
  * apply it through the Supabase migration tool **before** merging the code
    that needs it;
  * never edit an applied migration.

## 3. Phases

Conventions:
* `HUB` is the public Hub origin: the value of `HUB_PUBLIC_HOST` on the
  server.
* `SQL` means the read-only Supabase SQL editor for project
  `zkzibipinjeswhdxnfgf` (or an agent's read-only SQL tool).

### Phase A: verify V4 CLOSED

**Command (SQL, read-only):**
```sql
select status, final_summary is not null as has_summary, cost_usd from jobs where id='abaccdad-856e-4b8a-9898-b4116e6952e1';
select status, count(*) from tasks where job_id='abaccdad-856e-4b8a-9898-b4116e6952e1' group by status;
select count(*) filter (where cost_usd>0) as paid_attempts, count(*) as attempts from model_attempts where job_id='abaccdad-856e-4b8a-9898-b4116e6952e1';
select type, data->'validation'->>'state' as validation, data->'calculated' as calculated from artifacts where job_id='abaccdad-856e-4b8a-9898-b4116e6952e1' and type in ('financial_model','audit_report') order by created_at;
select count(*) from workspace_routing_policies;
```

**Expected result:**
* The job is `completed` and every task is `done`.
* `paid_attempts = 0` and the job cost is $0.
* There is a FINANCE `financial_model` with validation `VERIFIED` and these
  figures:
  * revenue AED 112,236;
  * costs AED 102,000;
  * net AED 10,236;
  * cash break-even in month 12.
* The drill value was caught and returned to FINANCE (visible in the task
  history and events).
* An AUDIT report exists and its code checks ran.
* The CHIEF final answer does not contain the injected wrong value.
* The final answer was delivered on Telegram (Fahad's chat).
* `workspace_routing_policies` has 0 rows.

**Stop condition:** any of the above is not true. Report
"V4 NOT CLOSED — remaining blocker: …" and do not start Phase B.

**Rollback:** none; this phase only reads.

### Phase B: merge PR #72 (router & token efficiency)

**Command:**
1. Confirm PR #72 CI is green on its current head and it has no merge
   conflict.
2. Fahad has read `docs/router-efficiency.md`.
3. Mark #72 ready for review, then Fahad merges it on GitHub with
   **"Create a merge commit"**, the repository's convention.
4. Record the merge commit hash as `M72`.

**Expected result:** `main` = `M72`, and the deploy workflow starts
automatically.

**Stop condition:** CI is red, or there is a conflict. Do not merge; fix it
on the branch.

**Rollback:** see §4.1 (revert `M72`).

### Phase C: deploy PR #72

**Command:** none; the push to `main` deploys. Watch the **Deploy Fahad AI
Office** workflow run on `main`, then:
```sh
curl -s https://HUB/healthz        # "version" must start with M72
```

**Expected result:**
* The workflow ends with `DEPLOYMENT SUCCESSFUL` and
  `now running commit <M72 short>`.
* `/healthz` reports `M72`.

**Stop condition:** the workflow fails.
* `ops/deploy.sh` has already rolled back by itself. It keeps the previous
  image and reports `ROLLBACK SUCCEEDED`.
* Read the job log, fix on a branch, and do not retry blindly.

**Rollback:** automatic on a failed health check; manual steps in §4.1.

### Phase D: router live smoke test

**Command:**
1. Hub → **Models**: the page loads, and the summary sentence shows models
   available.
2. `curl -s -H "Authorization: Bearer <hub token>" "https://HUB/api/capacity?workspaceId=2ae856da-00cb-4594-a7e6-710f2011d0c3"`
   (or open it in the signed-in Hub). It returns a `headline` and pools
   (openrouter:free, gemini:*, groq:*, zhipu:free, …).
3. Ask CHIEF for one small `[free-only]` task that touches FINANCE, for
   example: "[free-only] FINANCE: 12-month cash plan for a 3-person café,
   revenue AED 40,000/month, costs AED 36,000/month."
4. SQL:
   ```sql
   select provider, model, status, cost_usd from model_attempts where started_at > now()-interval '30 minutes' order by started_at;
   ```

**Expected result:**
* The task completes, or goes WAITING_FOR_CAPACITY and resumes. It never
  fails because of routing.
* FINANCE is offered more than one route: its attempts may use gemini,
  groq, openrouter or zhipu, not only openrouter.
* `cost_usd = 0` on every attempt.
* The FINANCE artifact is `VERIFIED`.

**Stop condition:** any of these:
* a paid attempt on a `[free-only]` job;
* FINANCE numbers without `VERIFIED`;
* an error loop (more than 5 failed attempts in 10 minutes on one task);
* `/api/capacity` returns 500.

**Rollback:** §4.1.

### Phase E: merge PR #73 (provider expansion / Mistral readiness)

**Command:**
1. After #72 is merged, GitHub retargets #73's base to `main` when the
   #72 branch is deleted. Otherwise change the base to `main` by hand
   (PR → Edit → base).
2. #73 then shows only its own two commits. Wait for CI to be green on it.
3. Fahad merges it with a merge commit. Record the hash as `M73`.

**Expected result:** `main` = `M73`, and the deploy starts.

**Stop condition:** CI is red, or the diff shows #72's commits again (the
base was not retargeted).

**Rollback:** §4.2 (revert `M73`).

### Phase F: deploy PR #73

**Command:** watch the deploy workflow, then `curl -s https://HUB/healthz`.

**Expected result:**
* `version` = `M73`.
* **Mistral stays inactive:** there is no key, so Hub → Models lists
  Mistral as "No credential". No other route changes.

**Stop condition:** the deploy fails, or any existing route's status
changes after the deploy.

**Rollback:** §4.2.

### Phase G: Mistral secret setup (only if Fahad has a usable key — see §5)

**Command (on the VPS, as root; each value is prompted, never typed on the
command line):**
```sh
# The deploy checkout carries the reviewed #73 version of the script:
grep -q MISTRAL_BILLING_CLASS /opt/fahad-ai-office/.deploy-repo/ops/set-secret.sh && echo ok
sudo bash /opt/fahad-ai-office/.deploy-repo/ops/set-secret.sh MISTRAL_API_KEY
sudo bash /opt/fahad-ai-office/.deploy-repo/ops/set-secret.sh MISTRAL_BILLING_CLASS
```
* Enter `free` **only if** the Mistral organization has **no payment
  method**. Then the included credits are a hard cap and cannot become a
  bill.
* If a payment method exists, enter `paid`. A paid route never serves
  `[free-only]` work, and Mistral then needs Fahad's paid approval.

Then the workspace authorization (SQL, write, **needs Fahad's approval**):
```sql
insert into public.workspace_provider_permissions (workspace_id, provider, models, secret_ref, enabled)
values ('2ae856da-00cb-4594-a7e6-710f2011d0c3', 'mistral', array['*:free'], 'env://MISTRAL_API_KEY', true);
```

**Expected result:**
* The script prints that the key was accepted: Mistral's `/v1/models`
  answered 200.
* The runtime restarts.
* Hub → Models lists the Mistral routes as `NOT_YET_QUALIFIED`, not
  "No credential".

**Stop condition:**
* The script reports 401 or 403: the key is not API-enabled (see §5). Do not
  continue.
* Any secret appears in a log.

**Rollback:** §4.3. Remove the key with the same script (empty value) and
run `update workspace_provider_permissions set enabled=false where provider='mistral';`.

### Phase H: Mistral live canary + qualification

**Command:**
```sh
docker exec fahad-office-runtime node src/canary/agentic-canary.js --record
```
Or use Hub → Coding Agent → Model pool → **Run live canary**. Then wait
about 30 minutes for the background qualifier (`requested_by =
'auto-qualifier'`).

**Expected result:**
* The Mistral route passes the tool round trip. The 9-character tool-call
  ids are accepted.
* `provider_status` for mistral is healthy, and the cost is $0 for
  `billing_class=free`.
* After qualification, CHIEF synthesis lists Mistral as eligible
  (Hub → Models, or `/api/capacity`).

**Stop condition:**
* any 4xx on the tool round trip (a protocol mismatch);
* a non-zero cost on a `free` route: the free guard blocks the route for
  24 hours, and the billing class must be corrected to `paid`;
* a quota error on the first call (credits unavailable).

**Rollback:** §4.3 (disable the permission row). The code path stays
harmless without the row.

### Phase I: 24-hour capacity measurement

**Command:** run the queries in §7 at T+0 (right after Phase F, or H if
Mistral is on) and at T+24h.

**Expected result:** a filled table (§7) compared with the pre-release
baseline.

**Stop condition:** the failure rate rises above the baseline (23.2%), or
any paid cost appears on free work. Investigate before Phase J.

**Rollback:** not needed; this phase only reads.

### Phase J: V5.1 final merge preparation (#71)

**Command:**
```sh
git fetch origin
git checkout claude/v5-immersive-office
git merge origin/main          # brings in #72 + #73
# conflict expected ONLY in docs/HANDOVER.md: keep main's handover,
# append the V5 section from the branch copy
npm ci && node --test          # rehearsal result: 430/430
git push origin claude/v5-immersive-office
```

**Expected result:** CI is green on #71, and the preview is republished for
Fahad (the same private link).

**Stop condition:** a conflict in any file other than `docs/HANDOVER.md`,
or any test failure.

**Rollback:** do nothing; the branch is not deployed.

### Phase K: merge + deploy #71 (only after Fahad's visual approval)

**Command:**
1. Fahad approves the immersive direction, having seen it in the preview.
2. Fahad merges #71 with a merge commit. Record the hash as `M71`.
3. Watch the deploy, then `curl -s https://HUB/healthz` (version = `M71`).
4. Smoke test:
   * Office → **Light** mode still loads for everyone. AUTO stays on the
     light Office during the beta, unless Fahad enables immersive in
     Settings.
   * Office → **Immersive** on Fahad's desktop: the Office loads, and
     View → Light switches between day, evening and night.
   * A phone gets the light Office.

**Expected result:**
* Nothing changes for anyone who has not opted in.
* Immersive works on Fahad's desktop, and falls back to the light Office
  on a weak GPU.

**Stop condition:** any of these:
* the light Office fails to load;
* a console error on `/`;
* the immersive Office breaks the page instead of falling back.

**Rollback:** §4.5.

## 4. Rollback plan

The known good points, in release order:

| Point | Commit | What runs |
|---|---|---|
| R0 | `13f09ea` | V4 + V4.1 (today) |
| R1 | `M72` | + router |
| R2 | `M73` | + provider readiness (Mistral inactive without a key) |
| R3 | `M71` | + V5.1 (opt-in) |

**General mechanism:** on GitHub, open the merged PR → **Revert** → merge
the revert PR (a merge commit). That push deploys the previous code through
the same checked pipeline, and `ops/deploy.sh` still health-checks and
auto-rolls back a bad candidate. Never force-push `main`. Never edit the
server by hand while a deploy runs.

### 4.1 Bad router deployment (#72)

* **Symptoms:**
  * tasks failing with routing errors;
  * FINANCE or CHIEF never finding a route while `provider_status` is
    healthy;
  * paid attempts on free work.
* **Action:** revert `M72` (merge the revert PR); `/healthz` then shows the
  revert commit.
* If #73 is already merged, revert `M73` first, then `M72`.
* **Data:** the router writes no new tables, so a revert needs no data
  change.

### 4.2 Provider routing issue (#73)

**Action:** revert `M73`; this returns to R1. The Mistral permission row (if
any) can stay; without the #73 code its protocol fixes are gone, so also
disable it:
```sql
update workspace_provider_permissions set enabled=false where provider='mistral';
```

### 4.3 Mistral failure (after Phase G)

**Action**, with no deploy needed:
```sql
update workspace_provider_permissions set enabled=false where provider='mistral';
```
Optionally remove the key:
`sudo bash /opt/fahad-ai-office/.deploy-repo/ops/set-secret.sh MISTRAL_API_KEY`
with an empty value. The router stops offering Mistral immediately after the
next pool refresh.

### 4.4 Migration issue

**None in this release.** If one is added later:
* write the reverse migration as a new timestamped file;
* never edit applied history;
* restore data from the Supabase point-in-time backup only with Fahad's
  approval.

### 4.5 V5 browser / performance issue (#71)

1. **Immediate, no deploy:** any user can switch Office → **Light**. AUTO
   already keeps the light Office unless immersive is enabled in Settings.
   Weak GPUs, phones and tablets fall back automatically.
2. **If the page itself breaks:** revert `M71`. The V5 code is lazy-loaded,
   so a revert removes it completely, and there are no data or migration
   effects.

## 5. Mistral account finding (researched 2026-09-28)

Fahad's account shows **FREE PLAN · $10/month API credits**, but
**API Keys → New key is disabled**, with the message "Upgrade to use your
API keys".

**Research limit:** this environment's network policy blocks
`docs.mistral.ai` and `help.mistral.ai`. The official statements below are
quoted from search-index snippets of those official pages, not from a full
page read. Re-read them in a browser before acting.

**VERIFIED OFFICIAL** (search snippets of Mistral's own pages):
* **Plan and credits.** Mistral's Free plan includes Studio access and
  **$10 per month in API credits** (mistral.ai/pricing).
* **Keys in Free mode.** "Free mode lets you create API keys and use
  included monthly usage within the limits shown on the Limits page", and
  "API access is enabled by default with no credit card required" (Mistral
  docs, "Usage and limits").
* **Limits.** Free mode enforces per-organization requests/second,
  tokens/minute and tokens/month. The exact numbers are shown only on the
  Limits page (admin.mistral.ai → Plateforme → Limits).
* **Activation step.** Mistral's quickstart is titled "Activate Studio and
  generate an API key": Studio must be **activated (in Free mode)** before
  the first key.
* **Vibe path.** A key can also be created from **Code › Vibe CLI**; "the
  same key works in Free mode, with a paid plan, or with pay-as-you-go
  enabled" (Mistral docs, Vibe "API keys and profiles").
* **Old tier gone.** The old "Experiment" tier ("1B tokens/month, 2 RPM")
  is no longer the current offering; its old docs page returns 404. Public
  trackers record the change to "$10/month API credits" between 5 and
  26 September 2026.

**OBSERVED IN FAHAD'S UI:** Free plan; $10/month credits; New key disabled;
"Upgrade to use your API keys".

**UNVERIFIED:**
* Whether phone verification is still required. The old Experiment plan
  required it according to third-party guides; the current docs snippets do
  not mention it.
* Whether geography or account type matters.
* Whether the $10 is spendable through external API keys or only inside
  Studio/Vibe. The docs text "Free mode lets you create API keys and use
  included monthly usage" says API keys; Fahad's UI disagrees.

**LIKELY EXPLANATION:** Fahad's organization has the **Free plan** (the
Vibe/Le Chat subscription level) but **Studio (the API platform) has not
been activated in Free mode** for that organization or workspace. The key
page shows the generic upgrade prompt until Studio is activated. A second
possibility: the key page belongs to a workspace where Fahad is not an
admin.

**Owner action path (free, no payment method):**
1. Sign in at console.mistral.ai with the organization owner account.
2. Open Studio (or admin.mistral.ai → Plateforme) and choose
   **Activate / Continue with Free mode**. Accept the terms, and complete
   phone verification if it is prompted.
3. Open **admin.mistral.ai → Plateforme → Limits**. It should show Free
   mode limits.
4. Open **API Keys → Create new key**.
5. If step 4 is still disabled, try **Code › Vibe CLI → create key**. The
   docs state that key works in Free mode.
6. If both are still disabled, stop.
   * **Do not add a card.** A payment method can turn usage beyond the
     credits into a bill, and it breaks the "free" classification (§3
     Phase G).
   * Ask Mistral support: "Free plan, $10 credits, API key creation disabled
     with 'Upgrade to use your API keys' — is Free mode API access available
     to my organization?"

**Paying is not needed** for the Office to work: Mistral is an extra free
capacity pool, and the Office already waits for free capacity.

Sources:
* [Mistral pricing](https://mistral.ai/pricing/)
* [Activate Studio and generate an API key (Mistral docs)](https://docs.mistral.ai/getting-started/quickstarts/studio/activate-and-generate-api-key)
* [Usage and limits (Mistral docs)](https://docs.mistral.ai/admin/billing-usage/usage-limits)
* [Vibe API keys and profiles (Mistral docs)](https://docs.mistral.ai/vibe/code/cli/api-keys-profiles)
* [Help: free tier limits](https://help.mistral.ai/en/articles/225174-what-are-the-limits-of-the-free-tier)
* [agentdeals issue #1995 (tracker of the change)](https://github.com/robhunter/agentdeals/issues/1995)
* [freetokens issue #307](https://github.com/luongnv89/freetokens/issues/307)

## 6. Final acceptance test (after Phase F, or H)

**Project name:** "Harbor Kiosk launch".
* It is a real, small, fictional-business objective in the real Office.
* It runs **not** as `[free-only]`, so that paid fallback can happen
  legitimately. The $2/month budget caps it.
* **Nothing is faked:** every signal below comes from real rows.

**Objective sent to CHIEF from Telegram:**
> Plan the launch of "Harbor Kiosk", a coffee kiosk in Dubai Marina.
> RESEARCH: 3 current competitor prices with sources. PRODUCT: MVP menu and
> launch checklist. FINANCE: 12-month plan — revenue AED 38,000/month from
> month 2, fixed costs AED 29,000/month, fit-out AED 60,000 one-time.
> SOCIAL: 2-week launch calendar. LEGAL: licences needed in Dubai (flag what
> needs a professional). AUDIT: check every number. CODING: add a
> `harbor-kiosk.md` summary page to the sandbox test repository through a PR.

**PASS criteria** (all required):

| Signal | How to check | PASS |
|---|---|---|
| Handoffs | `tasks` rows for the job + the Office timeline | ≥ 6 employees receive work; the CHIEF → specialist → CHIEF handoffs are visible. |
| Artifacts | `artifacts where job_id=…` | financial_model, content_calendar, compliance_matrix and audit_report present. |
| Deterministic FINANCE | the `financial_model` artifact `data->validation->>state` | `VERIFIED`. The figures equal the calculator's (month-12 net and break-even month match `src/office/finance.js` for the given inputs). |
| AUDIT | audit_report + events | code checks ran before the model review; no "NEEDS WORK" left unresolved. |
| CHIEF fact gate | final answer vs the artifact | every AED figure in the final answer equals the VERIFIED artifact; none contradicts it. |
| Free routing | `model_attempts` | ≥ 60% of tokens on free/promo routes. |
| Paid fallback | `model_attempts` with `cost_usd>0` | if any, only after a free-route failure or wait; the total stays within budget. 0 paid attempts is also a PASS. |
| Capacity pools | `/api/capacity` before and after | pool counters move; no exhausted pool is retried (no repeated `quota_exhausted` on the same pool within its cooldown). |
| Quota failover | `model_attempts` | a quota or rate error on one pool is followed by another pool, not a task failure. PASS also if no quota error happens (record it as "not exercised"). |
| Telegram | Fahad's Telegram chat | the final summary arrives in the same chat. |
| Token telemetry | TOTAL MODEL USAGE (Hub → Models / `/api/capacity` summary) | the job's tokens, successful/failed split and cost are non-zero and plausible. |
| Search circuit breaker | job events | either RESEARCH cites sources, or search is marked `SEARCH_DEGRADED` explicitly. A silent empty search is a FAIL. |
| Coding Agent + GitHub | Hub → Tasks | a PR is opened in the sandbox repository and CI runs. Merging needs Fahad's approval in the Hub; the test passes at "PR opened + CI result recorded". |

**FAIL** if any row fails, or any of these happens:
* a `[free-only]` guarantee is broken;
* a secret appears anywhere;
* the job needs manual database edits to finish.

## 7. 24-hour capacity measurement

**Pre-release baseline** (production, the 24 hours before 2026-09-28
21:30 UTC):
* 82 model calls; 484,869 tokens.
* 38,632 cached tokens; 6,546 reasoning tokens.
* $0.00.
* Failed calls: 23.2%. By provider:
  * openrouter: 54 calls, 7% failed;
  * gemini: 24 calls, 62% failed;
  * groq: 4 calls, 0% failed.
* 3 jobs completed, average 253 minutes; 2 tasks waited for capacity.

**Queries** (run at T+0 and T+24h; replace `'24 hours'` with the window):
```sql
-- Totals: tokens, success/failure split, cached, reasoning, cost, failure rate
select count(*) calls,
  sum(input_tokens+output_tokens) total_tokens,
  sum(input_tokens+output_tokens) filter (where status='succeeded') ok_tokens,
  sum(input_tokens+output_tokens) filter (where status<>'succeeded') failed_tokens,
  sum(cached_input_tokens) cached, sum(reasoning_tokens) reasoning,
  round(sum(cost_usd),4) cost_usd,
  round(100.0*count(*) filter (where status<>'succeeded')/nullif(count(*),0),1) failure_pct
from model_attempts where started_at > now()-interval '24 hours';

-- Free vs paid, per provider (billing from provider_status)
select a.provider, coalesce(p.billing_class,'?') billing, count(*) calls,
  sum(a.input_tokens+a.output_tokens) tokens, round(sum(a.cost_usd),4) cost,
  round(100.0*count(*) filter (where a.status<>'succeeded')/count(*),1) failure_pct
from model_attempts a left join provider_status p on p.provider=a.provider and p.model=a.model
where a.started_at > now()-interval '24 hours' group by 1,2 order by tokens desc;

-- Per capacity pool: use GET /api/capacity (pools + requestsToday + summary)

-- Quota exhaustion and fallbacks
select failure_class, error_code, count(*) from model_attempts
where started_at > now()-interval '24 hours' and status<>'succeeded' group by 1,2 order by 3 desc;
select count(*) fallbacks from (select task_id from model_attempts where started_at > now()-interval '24 hours'
  group by task_id having count(distinct provider) > 1) t;

-- Jobs, latency, capacity waits
select count(*) completed, round(avg(extract(epoch from completed_at-started_at))/60,1) avg_minutes
from jobs where completed_at > now()-interval '24 hours' and status='completed';
select count(*) filter (where wait_count>0) tasks_waited, coalesce(sum(wait_count),0) waits
from tasks where created_at > now()-interval '24 hours';

-- Coding Agent sessions
select count(*) sessions, sum(tokens_in+tokens_out) tokens, round(sum(spent_usd),4) usd,
  count(*) filter (where status='completed') completed
from agent_sessions where created_at > now()-interval '24 hours';
```

**Derived estimates** (write them down with their inputs; these are
estimates, not claims):
* **Free capacity utilisation %** = free tokens used ÷ published free
  allowance of the pools that were healthy. Use only pools whose providers
  publish a limit (`/api/capacity` → `estimatedRemainingBasis`). Pools
  without published limits are listed as "unknown", never guessed.
* **Estimated coding capacity/day** = (free + budgeted paid tokens available
  per day) ÷ (median tokens per completed Coding session over the window).
  If fewer than 3 sessions completed, report "insufficient data".
* **Estimated mixed projects/day** = the same, using the median tokens per
  completed multi-employee job. Include the Phase-6 acceptance job.

## 8. V5 production readiness (#71; reviewed, not changed)

| Check | Status |
|---|---|
| Bundle | Engine 150,432 B gzipped (budget 170,000). All 3D code about 37.7 KB gzipped (budget 40 KB), lazy-loaded only in immersive mode. |
| WebGL fallback | No WebGL2, a software renderer, or a lost context → light Office (tested). |
| Mobile/tablet | Small or touch screens always get the light Office (tested at 820×1180 and 390×844). |
| Accessibility | Every workspace is a DOM button; handoffs are a list; live summary. axe WCAG 2 A/AA: 0 violations on 7 screens × 2 themes. |
| Performance downgrade | The frame-rate watchdog steps high → balanced → light → the light Office. |
| Real data only | Surfaces draw only real state and artifacts; FINANCE numbers only when VERIFIED (tests). |
| Demo data isolation | The fictional preview data lives in the test fixtures and the separate preview builder. Production code never imports them (tests). |
| API compatibility with #72/#73 | No shared source files. Combined suite 430/430. |
| Rebase | **Merge `main` into the #71 branch** after #72/#73 (Phase J). One docs conflict is expected, in the handover only. |

## 9. Owner checklist (Fahad only; everything else is done by agents)

1. Confirm the V4.1 result when it is reported (V4 CLOSED or not).
2. Read `docs/router-efficiency.md`, then approve and merge PR #72.
3. Approve and merge PR #73 after #72 is verified in production.
4. Mistral (optional): follow §5 (activate Studio in Free mode, create a
   key, **no card**), then run the two `set-secret.sh` prompts on the VPS
   (§3 Phase G).
5. Approve the one Mistral workspace-authorization SQL row (Phase G).
6. Send the acceptance objective (§6) to CHIEF from Telegram, and approve
   or decline the Coding PR it opens.
7. Open the V5 preview and give the visual verdict on the immersive
   direction.
8. Approve and merge PR #71, only after item 7.
