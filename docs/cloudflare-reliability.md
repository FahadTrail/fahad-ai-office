# Cloudflare Workers AI reliability

Follow-up to PR #123 (`fix/cloudflare-empty-tools`, commit `d8e2f5d`). That
change stopped empty tool fields from reaching Workers AI and turned a blank
assistant message into a named `empty_response` error. This document covers the
reliability work built on top of it: request shape, error classification,
billing safety, quota accounting, fallback, qualification and the dedicated
canary.

Branch: `feat/cloudflare-reliability` → targets `fix/cloudflare-empty-tools`.
No schema change, no migration, no deployment, no provider call was made for
this work.

## 1. Baseline

| Item | State |
|---|---|
| Provider | Cloudflare Workers AI, OpenAI-compatible `/accounts/{id}/ai/v1/chat/completions` |
| Routes (catalog-gated) | `@cf/openai/gpt-oss-120b`, `@cf/qwen/qwen2.5-coder-32b-instruct`, `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| Allowance | 10,000 neurons/day for the whole account, reset 00:00 UTC (PUBLISHED) |
| Billing risk | On the Workers **Free** plan a used-up allowance returns error 4006 and cannot bill. On a Workers **Paid** plan the same neurons are a credit and the overage is charged. |
| Data class | NORMAL (Cloudflare does not train on or retain inference data); PRIVATE only with `CLOUDFLARE_API_PRIVATE_DATA_APPROVED` |
| Production state | No Cloudflare credential is set in production, so no route can run today. |

## 2. Request shape

Workers AI validates the tool fields per model. A request that asks for tools
without offering any (`tools: []` plus `tool_choice: "auto"`) is refused with
HTTP 400, or answered with an empty message by a model that implements tool
choice. PR #123 introduced the route quirk `omitEmptyTools`; this branch builds
on it:

* every Cloudflare no-tool call sends **neither** `tools` nor `tool_choice`;
* a real tool call still sends a full `tools` array (qualification probe,
  coding turns, Office tool use), and sends **no** `tool_choice`: a live run on
  2026-10-26 was refused with HTTP 400 / code 5006 when the field was present
  (see §4.1). `auto` is the OpenAI default, so the omission changes no intended
  behaviour — it removes a field the schema rejected;
* the Workers AI catalog reports `function_calling` per model. When the
  catalog says `false`, the route is marked `toolCalling: false`: the
  qualification suite skips its tool probe, coding qualification skips the
  route, jobs that require tools rule it out, and the turn gateway sends an
  empty tool list (`turn-gateway.js`). An absent property stays UNKNOWN and
  therefore permissive; a model is never marked tool-less on a guess.

Other chat-completions providers are unchanged: `omitEmptyTools` defaults to
false, so their wire format is byte-identical to before.

## 3. Answer handling

| Provider response | Result |
|---|---|
| text content | normal turn |
| `tool_calls` with a `function.name` | tool call block |
| a tool call with no name | dropped (it could never be answered back) |
| `refusal` field with no content | `refusal` (HTTP 422), not an empty turn |
| `finish_reason: content_filter` | `refusal` (HTTP 422) |
| no choices / no message | `empty_response` (HTTP 502) |
| no text and no tool call | `empty_response` (HTTP 502), recorded as a named failure |

## 4. Error classification

The numeric error code in a Workers AI body
(`{ success: false, errors: [{ code, message }] }`) is now kept as
`error.providerCode`. Only the code is read; the message text never leaves the
adapter.

| Condition | Classified as | Consequence |
|---|---|---|
| HTTP 400 invalid request | `PROVIDER_INVALID_REQUEST` | after 3 in a row the route rests 6 h (24 h from the 9th) |
| HTTP 401 / 403 (`code 10000`, "Authentication error") | `PROVIDER_AUTH` + reason `CREDENTIAL_INVALID` | `auth_error`, 24 h cooldown, the whole key rests |
| HTTP 404, `code 7000` ("No such model or task") | `PROVIDER_UNSUITABLE` + `MODEL_NOT_FOUND` | `unavailable`, 6 h cooldown, qualification backs off 1 → 2 → 4 → 7 days |
| HTTP 429 | `PROVIDER_RATE_LIMIT` | the provider's own reset hint, else the window |
| `code 4006` (daily neurons used up, any HTTP status) | `PROVIDER_RATE_LIMIT`, `status 429`, `quotaScope: 'day'` | `quota_exhausted` until 00:00 UTC; **every** Workers AI model rests (one shared pool) |
| HTTP 5xx / network / timeout | `PROVIDER_TRANSIENT` or `PROVIDER_NETWORK` | short cooldown, failover |
| empty assistant message | `empty_response` (502) | named failure, never a 0-score pass |

A route that is known to be unavailable is not called again while its
cooldown or qualification back-off is active. The 4006 path is pool-wide
because the allowance is per account, not per model.

### 4.1 The 2026-10-26 tool-call rejection (HTTP 400, code 5006)

A live canary on production `27ab29ca` against `@cf/openai/gpt-oss-120b` (declared
free plan) behaved like this: the no-tool call passed (request 1), the first
tool-calling request returned **HTTP 400 with provider code `5006`**
(`PROVIDER_INVALID_REQUEST`), the run stopped after 2 requests, wrote nothing and
never touched another provider.

What the evidence supports, and what it does not:

* `5006` is **not** listed in Cloudflare's published Workers AI error reference
  and **not** in Cloudflare's own SDK map of code → HTTP status, so its meaning
  is not taken on faith. The same code is documented in the field with the
  message `AiError: Bad input: Error: oneOf at '/' not met …` for bodies a
  **per-model input schema** refuses (`cloudflare/cloudflare-os#54`, HTTP 400 on
  this very endpoint). That is evidence of a **body/schema rejection**, not a
  credential, quota, plan or withdrawn-model problem — those have their own
  codes (10000, 4006, 5035, 7000) and their own rows above.
* The failing body differed from the passing no-tool body in exactly two fields:
  `tools` and `tool_choice: "auto"`. Messages were plain strings (no
  content-parts arrays, no `content: null` — the shapes #54 documents as
  rejected), and `max_tokens`/`stream` were identical in both calls.
* `tools` in this nested `{ type, function: { name, description, parameters } }`
  shape is accepted on the same endpoint and model: #54's first tools-bound call
  succeeds, and Cloudflare's own `workers-ai-provider` builds exactly this
  envelope. It is not a *flat vs nested* tool-definition problem.
* The remaining field is `tool_choice: "auto"`. Cloudflare's own provider omits
  `tool_choice` unless a caller explicitly forces a choice, and Cloudflare
  documents that gpt-oss does not reliably honour `tool_choice`. `auto` is also
  the OpenAI default when tools are present, so sending it or omitting it asks
  the model for the same behaviour.

**The fix.** Cloudflare routes (and the canary, which mirrors them) send `tools`
without `tool_choice` (`protocolOptions.omitToolChoice`). Every other
chat-completions provider is untouched and still sends `tool_choice: "auto"`.

**Certainty.** The root cause is narrowed by elimination to that field, not
confirmed by the provider: no live call was made after the fix. The canary now
records the shape it sent (`toolsSent`, `toolChoiceSent`) and, when a 400 names
the offending property, the JSON pointers only (`schemaPaths`, e.g.
`/tools/0/function/parameters/type`) — `http.js` keeps nothing else from the
provider message. One bounded live run therefore either passes (confirming the
field) or names the property that is still refused.

**Coverage honesty.** A check that stopped on a provider error is reported as a
failed model (`coverage.failedModels`), never as a covered one: the incident sent
one refused request, not a tool round trip.

## 5. Billing safety (fail closed)

The inference API does not say which Workers plan an account is on, so the
plan is a stated setting:

```sh
sudo bash ops/set-secret.sh CLOUDFLARE_PLAN   # free | paid (not a secret)
```

**`CLOUDFLARE_PLAN` is an owner declaration, not verified billing evidence.**
Cloudflare does not report the Workers plan on the inference API, so every
surface that shows it labels the basis: the canary preflight and
`GET /api/capacity` → `freeOnlySafety.cloudflare` both report
`planBasis: 'owner-declared'` and `planVerified: false`. A wrong declaration
could still bill overage, which is why a live canary is not proof of a free
account either.

| `CLOUDFLARE_PLAN` | Route | Why |
|---|---|---|
| unset / unknown | exists but **blocked** (`PLAN_NOT_VERIFIED`) | an unknown plan could be Paid, where overage is charged |
| `free` | free route, 10,000 neurons/day, error 4006 instead of a charge | the only state we run |
| `paid` | `billingClass: paid`, so `PRICING_UNKNOWN` until `CLOUDFLARE_PRICING_JSON` is set | can never be selected by free-only work |

Free-only execution (`allowPaid: false`) already refuses every paid route in
the gateway, and the free-route guard (`free-guard.js`) rejects any response
that reports a cost on a route classified free. `GET /api/capacity` →
`freeOnlySafety.cloudflare` reports the stated plan, how many routes are
executable and why the rest are blocked.

## 6. Quota accounting

* The allowance is neurons, not tokens. `freeQuotaStatus` and the pool summary
  report `neuronsPerDay: 10000` as a PUBLISHED fact and never derive a token
  number from it; tokens per neuron stay UNKNOWN until measured.
* Pool: `cloudflare:neurons`, shared by every model (see `capacity-pools.js`).
* `poolSummary` now also reports `lastErrorCode`, `cooldownUntil`, the
  published allowance and `nextResetAt`, so the dashboard can explain a pool
  that is resting without inventing a figure.
* Duplicate work is avoided structurally: a route in cooldown is not selected,
  a daily quota is never retried inline, and qualification applies its own
  back-off. `remaining` stays UNKNOWN because Cloudflare does not report
  neurons used in response headers.

## 7. Fallback

* Ordering is unchanged: free → included → promo → paid, then job fit and
  evidence.
* A used-up Cloudflare allowance fails the turn over to the next *free*
  eligible route; the drilling test proves a paid route is never called.
* Failover context is preserved by the existing checkpoint/handoff path
  (`onSwitch` → `continuationMessage`); Cloudflare is one more route in it.
* Loop prevention is unchanged: one route is tried at most
  `maxAttemptsPerRoute` times, a failed route is excluded for the rest of the
  turn, and the hop count is bounded by the pool size.

## 8. Qualification and coding suitability

* The general suite is unchanged; a Cloudflare route must pass it before any
  job (`requiresQualification`). Tool-less models skip the tool probe and
  therefore cannot claim `tools`.
* Coding qualification only considers routes with `toolCalling !== false`, so
  a text-only model is never graded for coding, and the tier gate
  (`codingTierGaps`) still decides SMALL / MEDIUM / LARGE / CRITICAL.
* No score is raised by this work. Cloudflare models remain `qualityTier` 4
  (`gpt-oss-120b`, qwen coder) or 3 (llama), which is below the coding
  quality floor until a measured coding grade exists.

## 9. Dedicated canary

```sh
npm run canary:cloudflare                                  # dry run (default)
npm run canary:cloudflare -- --live                        # real, capped calls
npm run canary:cloudflare -- --live --models=@cf/openai/gpt-oss-120b
npm run canary:cloudflare -- --live --max-requests=3
```

Unlike `npm run canary:agentic`, this command cannot reach another provider.

| Property | Behaviour |
|---|---|
| Default | dry run: no network, no credential needed, prints the exact planned checks and caps |
| Live gate | requires `--live` **and** a *declared* free plan (`planBasis: 'owner-declared'`, `planVerified: false`); unstated or paid refuses with `executed: false` |
| Allowlist | `CLOUDFLARE_CANARY_MODELS` (defaults to the three documented models); a requested id outside it is reported in `refused` and never probed |
| Data | synthetic arithmetic and a fixed token; no repository or customer content |
| Checks | `no-tool` (asserts no `tools` / `tool_choice` in the body **and** the answer is exactly `CLOUDFLARE-OK`) and `tool-calling` (a real `add_numbers` call from a tools-only body — no `tool_choice` — then only the number `42`; the result records `toolsSent` / `toolChoiceSent`) |
| Caps | 9 requests (3 models × 3: one no-tool call plus a two-call tool round trip each), 256 output tokens per request, 6,000 total tokens, 60 s timeout; these are hard maxima: `--max-requests` or a wider allowlist can lower them, never raise them |
| Errors | the first provider error (credential 10000, neurons 4006, Workers Paid 5035, withdrawn model 7000, timeout, …) stops the run: `stoppedBecause: 'PROVIDER_ERROR'`, `stoppedOnError`, and the remaining models are reported as unprobed |
| Partial runs | the run stops at the first check that no longer fits and reports `coverage` (`completeModels`, `partialModels`, `unprobedModels`, `fullCoverage: false`) plus `stoppedBecause`; a capped run can never read as full coverage |
| Writes | none: no database, no `provider_status`, no budget reservation |
| Report | sanitized JSON: booleans, counts, durations, token usage, machine error codes, `providerCode`, a named `failure` for a check, and on a 400 the refused JSON `schemaPaths` (§4.1). No credential, prompt, provider prose or model output |

## 10. Monitoring

`GET /api/capacity` now adds (all additive):

* `freeOnlySafety.cloudflare` — the owner-declared plan (`planBasis: 'owner-declared'`, `planVerified: false`), executable routes, blocked
  reasons, and `paidFallbackOnFreeOnly: refused`;
* per pool: `qualification { qualified, failed, untested }`, `published`
  (including `neuronsPerDay`), `resetKind`, `nextResetAt`, `lastErrorCode`,
  `cooldownUntil`.

The per-route pool table already lives on the Coding page
(`src/hub-coding.js`); nothing was duplicated.

## 11. Verification status

Verified offline (this branch):

* `npm ci` and `node --test`: 813 tests, 810 pass, 0 fail, 3 skipped (the
  container-root sandbox tests, as documented).
* `test/cloudflare-reliability.test.js` (14 tests) covers error codes, shared
  neuron cooldown, the plan gate and its `owner-declared` basis, tool
  capability in qualification and in the gateway, free-only failover, catalog
  parsing, the canary (dry run, refusal, live shape, exact-token no-tool check,
  9-request full coverage vs. reported partial coverage, redaction), the
  `schemaPaths` sanitiser (pointers only, no provider prose) and the 400/5006
  incident replayed offline: the refused tool call, its named failure and the
  field it named.
* `test/cloudflare-routes.test.js` (PR #123) still passes with the new
  `CLOUDFLARE_PLAN=free` fixture, plus the tool-shape test: a Cloudflare tool
  request carries the schema and no `tool_choice`, while every other provider
  still sends `auto`.

NOT verified, and cannot be from here:

* any real Workers AI call, latency, token counts or cost;
* whether this account's catalog actually lists the three models;
* whether each model reports `function_calling`, so the tool-less path is
  covered by fixtures only;
* **whether the 400/5006 rejection is really `tool_choice`** (§4.1): the fix is
  narrowing by elimination, and one bounded live run is what confirms it;
* tokens per neuron, and therefore the real value of 10,000 neurons/day.

## 12. Remaining owner actions

1. Keep the account on the Workers **Free** plan.
2. Create an API token with the Workers AI read permission.
3. `sudo bash ops/set-secret.sh CLOUDFLARE_API_TOKEN`
4. `sudo bash ops/set-secret.sh CLOUDFLARE_ACCOUNT_ID`
5. `sudo bash ops/set-secret.sh CLOUDFLARE_PLAN` → `free` (without it the route
   stays blocked).
6. Optional, for private code only after reading the terms:
   `CLOUDFLARE_API_PRIVATE_DATA_APPROVED=true`.

Keys are never pasted into a chat and never committed.

## 13. Next controlled live validation

1. `npm run canary:cloudflare` (dry run) on the server: confirm the allowlist,
   the plan gate and the caps.
2. `npm run canary:cloudflare -- --live --max-requests=3`: one model, one
   no-tool call and one tool round trip. This validates the PR #123 shape and
   the tool path with real responses at a bounded spend, and it is the run that
   confirms or refutes the `tool_choice` finding in §4.1: read
   `results[].toolChoiceSent` (must be `false`) and, if the tool call is still
   refused, `results[].schemaPaths` — it names the property Workers AI refused.
3. If it passes: `--live` with the full allowlist (9 requests, one full round
   trip per model), then read `GET /api/capacity` for the qualification state
   and the neuron pool. Read `coverage` in the report: `fullCoverage: true` is
the only result that covers all three models.
4. Only then qualify the routes in the background cycle and measure tokens per
   neuron from `model_attempts`; record the result as MEASURED in
   `docs/capacity-v2.md`.
