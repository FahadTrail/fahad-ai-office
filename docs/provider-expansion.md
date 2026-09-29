# Provider expansion preparation (2026-09-28)

* **Branch:** `claude/provider-expansion-prep`, built on
  `claude/router-efficiency-v1` (PR #72).
* **Status:** not merged and not deployed. No key was requested and no
  provider was activated.

**Evidence labels**
* **VERIFIED:** checked in this repository's code and tests, or on an
  official source.
* **REPORTED:** consistent third-party or issue-tracker reports. The official
  documentation sites (docs.mistral.ai, docs.api.nvidia.com,
  developers.cloudflare.com) were blocked by the sandbox proxy tonight.
* **ASSUMPTION:** a planning value, to be confirmed at setup.
* **UNKNOWN:** not established.

## 1. Mistral: readiness

| # | Item | Status |
|---|---|---|
| 1 | Adapter | **VERIFIED.** It uses the shared Chat Completions adapter (`chat-completions.js`), with Mistral quirks declared as route metadata (`protocolOptions`). |
| 2 | Endpoint | **VERIFIED** (2026-09-27 docs): `https://api.mistral.ai/v1/chat/completions`. The model list is at `/v1/models`, which is used by the catalog check and by key verification. |
| 3 | Model id | `mistral-medium-latest` (alias). **ASSUMPTION** that it is the best default. `MISTRAL_MODEL` overrides it, and the provider-catalog check flags an id Mistral no longer serves. |
| 4 | Tool / function calling | **VERIFIED** that it is supported (Mistral function-calling docs). **REPORTED**, and fixed tonight: tool-call ids must be exactly 9 `[A-Za-z0-9]` characters. Ids are now mapped deterministically, so call/result pairs stay matched (a test covers this). |
| 5 | Structured output | **ASSUMPTION:** reliable JSON in text (the planning score). JSON mode is documented but our adapter does not use it; qualification measures the real behaviour. |
| 6 | Context | 128K, **ASSUMPTION** (published for Medium; confirm the model card). `MISTRAL_CONTEXT_WINDOW` overrides it. |
| 7 | Rate-limit handling | **VERIFIED in code.** A 429 cools the route down. A monthly-allowance 429 now waits for the reset (next month; **ASSUMPTION** that Mistral's month is the calendar month) instead of being probed. The header format is **UNKNOWN**; generic parsing applies. |
| 8 | Error normalisation | **VERIFIED:** the shared `providerError` / `classifyProviderError` path, including account blockers and catalog verdicts. |
| 9 | Health check | **VERIFIED:** `provider_status` plus the live canary (`src/canary/agentic-canary.js`). |
| 10 | Qualification / canary | **VERIFIED:** the background qualifier covers any non-paid route. The canary covers every configured route: a tool round trip plus a failover drill. |
| 11 | Capacity pool | **VERIFIED:** `mistral:account` (one organisation quota), declared in the definition. |
| 12 | Billing class | **VERIFIED:** `paid` by default. It becomes `free` only when the owner sets `MISTRAL_BILLING_CLASS=free` after checking the plan. A paid Mistral route never serves `[free-only]` work. |
| 13 | Privacy | **VERIFIED:** `privacyApproved=false` unless `MISTRAL_API_PRIVATE_DATA_APPROVED`. **REPORTED:** free-mode inputs and outputs may be used for training. |
| 14 | Public-data-only | **VERIFIED:** confidential steps (`requiresPrivateData`) can never select it (a test covers this). |
| 15 | Workspace authorization | **VERIFIED gap:** production has **no** `workspace_provider_permissions` row for Mistral, so the router would refuse it (`WORKSPACE_NOT_AUTHORIZED`). A `*:free` row authorises it only while its billing class is free (a test covers this). |
| — | Message-order quirks (a user turn directly after tool results) | **UNKNOWN** for the current API. The first live canary shows it. |
| — | Free quota | **UNKNOWN officially.** REPORTED: about 1B tokens/month, about 1 request/s, figures only in the Admin Console → Limits. Nothing is hard-coded. |

**Suitability for Office work** (only after qualification passes; public data
only):

| Work | Suitable? | Why |
|---|---|---|
| CHIEF synthesis | **Yes** | reasoning 4 and writing 4 planning estimates; strict job, so no evidence raise |
| FINANCE, routine and critical | **Yes** | Figures stay validated by the finance engine |
| RESEARCH / LEGAL / PRODUCT | **Yes** | Web tools arrive through function calling |
| AUDIT (orchestration) | **Yes** | |
| CODING on private repositories | **No** | Not privacy-approved on the free plan. It would need a paid plan plus Fahad's explicit `MISTRAL_API_PRIVATE_DATA_APPROVED`. |

## 2. Mistral: owner setup (when Fahad decides; do not send keys in chat)

**Order matters:**
* PR #72 (router) and this branch must be merged and deployed **before** the
  key is installed.
* The production code today lacks the tool-call-id fix, so tool steps would
  fail against Mistral.

**Steps:**
1. Open https://console.mistral.ai and sign up. REPORTED: it needs email and
   phone verification, and no card.
2. Choose the free (Experiment) plan. In **Admin → Limits**, note the
   request, token-per-minute and monthly limits shown.
3. Open **API keys** and choose **Create new key**. Copy it once.
4. On the VPS, from an up-to-date checkout:
   `sudo bash ops/set-secret.sh MISTRAL_API_KEY`
   * The input is hidden.
   * The script checks the key with `GET https://api.mistral.ai/v1/models`
     before storing it. HTTP 200 means accepted; 401 means rejected and
     nothing is changed.
5. Only if the plan is the free plan:
   `sudo bash ops/set-secret.sh MISTRAL_BILLING_CLASS` and enter `free`.
   With an older checkout, add the line `MISTRAL_BILLING_CLASS=free` to
   `/opt/fahad-ai-office/.env` and run
   `docker compose -f /opt/fahad-ai-office/docker-compose.yml up -d --no-deps runtime`.
6. Workspace authorization. This is a production data change; Claude or Codex
   runs it only with Fahad's approval:
   ```sql
   insert into public.workspace_provider_permissions (workspace_id, provider, models, secret_ref, enabled)
   values ('2ae856da-00cb-4594-a7e6-710f2011d0c3', 'mistral', array['*:free'], 'env://MISTRAL_API_KEY', true);
   ```
7. Run the live canary: **Hub → Coding Agent → Model pool → Run live canary**,
   or
   `docker exec fahad-office-runtime node src/canary/agentic-canary.js --record`.

   **Expected success:**
   * `mistral:mistral-medium-latest` completes the `add_numbers(17, 25)`
     round trip and answers `42`;
   * the reported cost is `$0` on the free plan;
   * `provider_status.health = healthy` and `verified_at` is set.
8. The background qualifier then records Mistral's skills. Synthesis and
   finance need `status = qualified`.
9. Confirm with one small `[free-only]` Office job. While the other strong
   pools are exhausted, CHIEF synthesis should route to Mistral.

## 3. CHIEF synthesis fallback (offline)

The test is in `test/provider-expansion.test.js`. The state:
* the OpenRouter strong free pool is exhausted;
* Gemini Flash is exhausted;
* Mistral is healthy, qualified and on the free plan.

**Result:** the synthesis turn runs on `mistral:mistral-medium-latest`, and
no exhausted or weaker route is called. Without Mistral, the same state is a
`WAITING_FOR_CAPACITY` decision (also tested).

**The gates are unchanged (tested):**
* unqualified Mistral gives `NOT_YET_QUALIFIED`;
* confidential work gives `PRIVACY_NOT_APPROVED`;
* a paid-by-default plan on a `[free-only]` job gives `PAID_ROUTE_NOT_ALLOWED`.

Fact validation, the FINANCE engine and the CHIEF fact gate run after the
model and are untouched.

## 4. NVIDIA build.nvidia.com (NIM): **do not integrate for Office work**

* **API:** an OpenAI-compatible hosted catalog of 100+ models (DeepSeek,
  Qwen, Kimi, Nemotron, Llama). A free Developer Program key (`nvapi-…`).
  REPORTED: about 40 requests/minute; the credit model has ended.
* **Terms (VERIFIED source):** the NVIDIA API Trial Terms of Service allow
  the API "for limited trial purposes only and **without use of the API
  Service or Generated Content in production**". Production requires NVIDIA
  AI Enterprise, which is paid.
* **Verdict:** the Office is Fahad's working business system, so routing its
  real work through the trial would breach the terms. It would add an
  independent pool technically, but not a legitimate one.
* **Allowed later:** offline evaluation (for example, testing a model before
  choosing a paid provider).
* **Not prepared:** no adapter skeleton was added, to avoid inviting misuse.
  If Fahad ever buys NVIDIA AI Enterprise, the route is one definition
  (OpenAI-compatible) plus a pool declaration.

## 5. Cloudflare Workers AI: **not now**

* **Quota:** REPORTED 10,000 neurons/day, reset at 00:00 UTC. It is a
  separate account pool, and large models use neurons quickly.
* **What it would add:**
  * roughly 1–2M small-model tokens a day, far less on 70B-class models;
  * its models suit classification and short orchestration, jobs that
    already have abundant capacity (3 Groq pools, Flash-Lite, Gemma, GLM).
* **Cost of adding it:** an account id plus a token and another endpoint
  shape, with no gain for the real bottleneck (strong synthesis).
* **Verdict:** revisit only if light jobs ever run out.

## 6. Adding a provider (the abstraction)

A new provider needs:
1. **One definition** in `modelPoolDefinitions` (`src/model-gateway/agentic/model-pool.js`) with:
   * provider, model and protocol;
   * endpoint;
   * `secretEnv` / `secretRef`;
   * context window;
   * a truthful `billingClass` (defaulting to `paid` until verified) and
     pricing if paid;
   * `privacyApproved` from an explicit flag;
   * optional `maxOutputTokens`;
   * `requestTokenLimit` (a per-minute token rate, **not** a window);
   * `quotaPool` (`{ id, label, shared, scarce }`);
   * `protocolOptions` for wire quirks;
   * `catalogBlocked` if the provider has a model list.
2. **An adapter** only if the protocol is new. Chat Completions,
   Anthropic Messages, OpenAI Responses and Gemini already exist.
3. **A capability planning score** in `capabilities.js` REGISTRY. Without
   one, the route inherits its quality tier, labelled `route default`.
   Qualification evidence corrects it.
4. **Optionally, free-allowance facts** in `free-quota.js`: the reset
   schedule and a published daily limit if any. No invented numbers.
5. **A secret** through `ops/set-secret.sh` (add its shape).
6. **A workspace authorization row.**
7. **Proof:** `canary:agentic`, then qualification, then one live free-only
   job.

The contract test ("provider metadata contract" in
`test/provider-expansion.test.js`) fails if a definition misses the fields
the router needs. No router code changes per provider.

## 7. Capacity backend

`GET /api/capacity` (read-only) returns:
* `headline`, one sentence. For example: "5 of 7 free capacity pools are
  available; 1 used up (next reset in about 12 h)."
* `summary`:
  * `freeCapacityNow`;
  * healthy / degraded / exhausted pool counts;
  * `nextReset`;
  * `tokensToday`;
  * `failedAttemptsToday`;
  * `estimatedRemainingRequests`, which is null unless every pool has a
    published limit.
* `pools`: one entry per independent pool, with its models, state, next
  reset, tokens today and this month, failed attempts, and
  `estimatedCapacityLeft` (only from a published limit minus audited use,
  labelled ESTIMATED).
* `usage`, with the TOTAL MODEL USAGE definition.
* `search`: the web-search breaker state.
