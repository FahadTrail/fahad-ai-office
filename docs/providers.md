# Model providers, free capacity and JEV

This is the source of truth for which AI providers the platform can use, which
of them are free, and why. It was **re-verified on 2026-09-26**. The Office
Research agent read each provider's official pages from the production server,
and the results were cross-checked against official changelogs. The same facts,
with their sources, live in `src/model-gateway/agentic/provider-facts.js` and
appear on the dashboard. Free tiers change often, so the code treats every
allowance here as **published, not guaranteed**. Only numbers a provider reports
in its own response headers are shown as exact.

## How a model is chosen

1. **Job first.** Every request names a job: `coding`, `qa_security`,
   `research`, `finance`, `content`, `branding`, `seo` or `classification`. The
   job sets minimum capability scores, tool calling, structured output and
   context size. A model below those minimums is **ineligible** for that job,
   even if it is free (for example `CAPABILITY_CODING_BELOW_4`, or
   `CONTEXT_WINDOW_TOO_SMALL`).
2. **Hard gates.** A route must pass all of these: credential present, workspace
   authorization, privacy review (private data only goes to approved
   providers), health and cooldown, routing policy exclusions, per-route caps,
   and the workspace budget.
3. **Free first.** Eligible routes are ordered by billing class,
   `free → included → promo → paid`. Within a class, `economy` picks the
   cheapest first and then the best job fit; `balanced` and `quality` pick the
   best fit for the job first.
4. **Rotation.** When a route hits a limit, the controller checkpoints, the
   route's state is updated, and the next eligible route continues from the
   checkpoint. A used-up **daily** free allowance is recognized from the
   provider's error wording. Only a boolean is kept; provider text is never
   stored. That route then waits until the provider's next reset, for example
   midnight Pacific for Gemini or midnight UTC for OpenRouter, and becomes
   eligible again on its own. A per-minute limit gives only a short cooldown.
   Nobody is asked which model to use.

## Provider table (checked 2026-09-26)

Status legend:
* **LIVE**: a real canary or real traffic succeeded.
* **READY — CREDENTIAL REQUIRED**: the adapter is built and tested; only the key is missing.
* **BLOCKED — …**: the provider refuses the account; the exact reason is shown.
* **RETIRED**: the provider shut the service down.

| Provider | Models in the pool | Class | Free allowance (published) | Reset | Tools | Private code | Status / blocker |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Anthropic | `claude-opus-5`, `claude-sonnet-5` | paid | none | — | yes | approved | LIVE |
| OpenAI | `gpt-5.3-codex` | paid | none | — | yes | approved | LIVE (not authorized for the project) |
| DeepSeek | `deepseek-flash` | paid (very low) | none | — | yes | approved | LIVE |
| Gemini API | `gemini-flash-latest`, `gemini-flash-lite-latest` (new) | free | Per project/model, shown only in AI Studio; reported about 20 requests/day for Flash and about 500/day for Flash-Lite | midnight Pacific | yes | flag (free-tier prompts may be used by Google) | LIVE |
| Groq | `openai/gpt-oss-120b`, `qwen/qwen3.8-27b` (new), `openai/gpt-oss-20b` (new) | free | Per model: 30 RPM, 1K requests/day, **8K tokens/min**, 200K tokens/day. Llama models are enterprise-only now | rolling (headers) | yes | flag | LIVE. Each request is capped at 8K tokens, so Groq takes short jobs such as orchestration and classification |
| OpenRouter | discovered `:free` catalog (up to 12 admitted) | free (free-only guard) | 20/min and 50/day for the whole key (1,000/day after a one-time $10 purchase) | midnight UTC | yes | never | LIVE |
| Cerebras | `gpt-oss-120b`, `qwen-3.8-27b` | **promo** | **No permanent free tier since 2026-08-17.** Free Trial: $5 of credits after adding a verified payment method, which expire after 30 days, then access stops (no automatic charge). Trial context: 65K / 64K | one-time | yes | flag | READY — CREDENTIAL REQUIRED |
| GitHub Models | — | — | **Retired by GitHub on 2026-07-30** (playground, catalog and inference API) | — | — | — | RETIRED. Never called; no token needed |
| Z.ai (GLM) | `glm-4.7-flash` (200K, function calling), `glm-4.5-flash` | free | $0, one concurrent request | — | yes | flag (Z.ai states it does not store API content) | READY — CREDENTIAL REQUIRED |
| Z.ai (GLM) paid | `glm-5.3-flash` | paid | none | — | yes | flag | READY — CREDENTIAL REQUIRED |
| Qwen (Model Studio) | `qwen3.8-flash` | paid | 1M tokens per model, one-time, 90 days, Singapore/International only | one-time | yes | flag | BLOCKED: `AccessDenied.Unpurchased` (see below) |
| Kimi (Moonshot) | `kimi-k2.7-code` | paid | none (minimum $1 top-up; `kimi-k3` is the flagship; k2.5 and moonshot-v1 were retired on 2026-08-31) | — | yes | flag | READY — CREDENTIAL REQUIRED |
| MiniMax | `MiniMax-M2.7` | paid | none (`MiniMax-M3` exists) | — | yes | **blocked in code** | READY — CREDENTIAL REQUIRED (public data only) |
| Mistral | `mistral-medium-latest` | paid until stated | A free "Experiment" allowance could **not** be confirmed on official pages in 2026-09 | monthly | yes | flag | READY — CREDENTIAL REQUIRED |

Notes:

* **Qwen `AccessDenied.Unpurchased`.** Model Studio's code for "Access to model
  denied. Please make sure you are eligible for using the model." The key is
  accepted, but the account is not entitled to call models in that region.
  Usually Model Studio has not been activated in the Singapore region, or the
  free quota ended without pay-as-you-go enabled. An overdue balance returns
  `Arrearage` instead. Each owner canary now runs a Qwen diagnosis: the key's
  model list, a 1-token call to the configured model, and a 1-token call to a
  second model. That tells *account not activated*, *model not entitled*, *key
  from another region*, *overdue* and *wrong model id* apart. The canary report
  (`qwenDiagnosis`) and the dashboard show the named blocker and the owner
  action. The route rests for 24 hours per failure, and a restart (which is how
  a credential or account fix arrives) triggers exactly one re-check.
* **Qwen key formats.** Model Studio now issues **workspace-scoped keys**
  (`sk-ws-…`) that belong to one workspace and region, such as the Singapore
  workspace. `ops/set-secret.sh QWEN_API_KEY` accepts them, together with legacy
  account keys (`sk-` followed by letters and digits). Before 2026-09-26 the
  validator accepted only the legacy shape, so a new workspace key was refused
  before it reached `.env`. A workspace key must be paired with the same
  workspace's endpoint (`QWEN_API_ENDPOINT`, e.g.
  `https://ws-….ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions`).
  Both key shapes are redacted from logs, transcripts and tool output.
* **GitHub Models.** Retired, so no token and no permission can enable it. The
  Coding Agent's `CODING_GITHUB_TOKEN` stays repository-only. It was never used
  for inference and must not be broadened.
* **Cerebras** is PROMO, not FREE. The trial credits end and then access stops.
  Nothing is billed unless the owner buys credits.
* **Mistral** stays paid unless the owner states a free plan with
  `MISTRAL_BILLING_CLASS=free`. On a free plan, prompts may be used for training.

## Free capacity: what routes where

Free routes and the jobs they may take (public/non-private data):

| Route | Effective context | Office jobs (capability) |
| --- | --- | --- |
| `gemini-flash-latest` | 1M | research, content, branding, SEO, finance, orchestration, synthesis |
| `gemini-flash-lite-latest` | 1M | research, content, branding, SEO, orchestration, classification |
| `groq` gpt-oss-120b / qwen3.8-27b | 8K per request | orchestration, classification |
| `groq` gpt-oss-20b | 8K per request | orchestration, classification |
| OpenRouter free (e.g. nemotron-3-ultra/super) | 128K+ | research, content, SEO, branding, orchestration; synthesis/finance once qualified |
| Z.ai GLM Flash (with a key) | 200K / 128K | research, content, branding, SEO, orchestration, classification |
| Cerebras trial (with a key) | 65K | research, content, orchestration, classification |

In each job, free models are ordered by capability plus evidence:
qualification skills for that job, then observed reliability. Paid models are
used only when no eligible free or promo model remains, and only within the
workspace budget.

## Free-route guarantee

For every route classified FREE, PROMO or INCLUDED, whatever the provider:

1. **Reported cost.** A response that reports any cost (OpenRouter usage
   accounting, or any provider's `usage.cost`) is refused. Then:
   * the real cost is charged to the workspace budget ledger (the budget is never raised);
   * the route is blocked for 24 hours;
   * the task is checkpointed and continues on the next eligible route;
   * the incident is shown on the Platform dashboard (Office → Free-route incidents).
2. **Silent reroute.** A response from a different vendor or model family
   (a silent reroute or rename) gets the same treatment. Dated or aliased ids of
   the same model (`gemini-flash-latest` → `gemini-3.8-flash`) are accepted.
3. **Removed or renamed models.** Provider model catalogs (Groq, Cerebras,
   Mistral; Gemini, Qwen and Kimi for diagnosis) are read at start, every 6
   hours and before each canary. A model a provider no longer lists is marked
   `CATALOG_MODEL_NOT_IN_PROVIDER_CATALOG` and never called. No guessed
   replacement is used.
4. **Paid fallbacks.** No paid fallback list is ever sent to a free endpoint.
   Discovery never assigns a paid route to FREE. `*:free` workspace
   authorization covers only non-paid routes.
5. **Out of quota.** A free route whose quota is exhausted rests until the
   provider's reset. A route that keeps answering 429 backs off up to 30
   minutes. A first 5xx rests the route for 1 minute. A rejected key or blocked
   account rests every model behind that key for 24 hours (or until the next
   restart).

## Qualification of free models

`src/model-gateway/agentic/qualification.js` runs a small, $0 suite on each
free or promo route: two or three calls, graded deterministically. The skills
are:

* instruction following (exact echo, JSON only);
* structured output;
* reasoning (word problem);
* code reading (public snippet);
* constrained writing;
* reading comprehension;
* tool calling with use of the result.

Results are stored with their date and suite version as metadata-only rows
(`provider_canary_runs`, `requested_by = auto-qualifier`). They stay valid for
30 days.

* A failed skill that a job needs rules the model out of that job.
* **Critical jobs** (synthesis, finance, coding, QA/security) require a passed
  qualification.
* The runtime qualifies untested routes in the background, most capable first.
  It checks every 20 minutes while a backlog exists, every 6 hours otherwise,
  and at most 6 OpenRouter models a day because of the shared allowance. Each
  owner canary also runs one cycle.
* A newly added key or a newly discovered model is absorbed automatically.

## OpenRouter: one key, many free models

`src/model-gateway/agentic/openrouter-catalog.js` discovers OpenRouter's free
models at runtime start, every 6 hours, and before each canary. It reads
OpenRouter's public `/api/v1/models` catalog, plus the key-scoped
`/api/v1/models/user` list, which already applies the account's privacy and
provider settings.

A model is **admitted** only when all of these hold:
* its id ends in `:free`;
* every published price is zero;
* it supports tool calling;
* its context window is at least 16K;
* the key can actually use it.

The best Office-job fits are admitted first, up to `OPENROUTER_MAX_FREE_MODELS`
(default 8). Every other free model is listed on the dashboard with the reason
it was not admitted.

Free-only protection:
* Admitted routes are FREE and flagged `freeOnly`.
* Every call requests OpenRouter usage accounting. A response that reports any
  cost is refused, the real cost is settled against the budget, and the route
  is quarantined for 24 hours while the turn fails over.
* No paid `models` fallback list is ever sent. The workspace budget remains an
  additional safeguard.

Privacy: OpenRouter free endpoints may log or train on prompts. Free
OpenRouter routes are therefore **never** approved for private code,
whatever `OPENROUTER_API_PRIVATE_DATA_APPROVED` says. They serve Office jobs
with non-private data.

Root cause of the first OpenRouter failure (2026-09-25): the static default
`openai/gpt-oss-120b:free` no longer exists as a free variant, so OpenRouter
answered 404 and the route was marked unsuitable. The key was valid. The
catalog now replaces the static default, and a configured model the catalog
rules out is shown as `CATALOG_…` and never called.

A 404 from any provider is recorded with a reason code, never the provider
text. The codes are `DATA_POLICY`, `NO_TOOL_SUPPORT`, `MODEL_NOT_FOUND`,
`PROVIDER_FILTERED`, `PRICE_FILTERED` and `NO_CREDITS`. Route-level reasons
cool the route down for 6 hours instead of retrying it every turn.

Canary behaviour:
* Routes in an active cooldown are skipped.
* Only `CANARY_OPENROUTER_SAMPLE` (default 3) discovered models are probed per
  run, never-verified ones first, to protect the shared free allowance.
* The failover drill prefers a free primary and a free backup at another
  provider.
* Paid routes that succeeded within `CANARY_PAID_REVERIFY_HOURS` (default 24)
  are not re-probed; `CANARY_INCLUDE_PAID=true` forces a full paid check.

## Adding a key

Every credential goes through one command on the server. The input is hidden,
its shape is checked, it is never printed, and only the Office containers are
reloaded:

```sh
sudo bash ops/set-secret.sh GEMINI_API_KEY
```

Allowed names: `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`,
`GITHUB_MODELS_TOKEN`, `CEREBRAS_API_KEY`, `ZHIPU_API_KEY`, `KIMI_API_KEY`,
`QWEN_API_KEY`, `MISTRAL_API_KEY`, `MINIMAX_API_KEY`,
`CODING_SUPABASE_ACCESS_TOKEN`. (`GITHUB_MODELS_TOKEN` is still accepted but
unused, because GitHub Models is retired.)

Adding a key needs nothing further. `set-secret` reloads the Office
containers, and the restart:
* refreshes the provider catalogs;
* lifts account and credential cooldowns once;
* makes the background qualifier call the new free routes within about two
  minutes. That is the live verification: a successful qualification marks the
  route LIVE and records its skills.

Free and promo routes of a provider whose workspace permission lists `*:free`
are then used by the Office at once. Paid providers still need the owner to add
them to the project's `workspace_provider_permissions`. **Hub → Platform →
Open model pool → Run live canary** remains available for an immediate full
check.

## Capability registry

`capabilities.js` scores each model from 1 to 5 on coding, reasoning,
research, writing and speed. It also records tool calling, vision, structured
output, context, cost class and privacy class. The scores are planning
estimates from provider documentation and our live sessions, not benchmarks. A
model that is not listed inherits its route's quality tier and is labelled
`route default`. The owner can override scores with
`MODEL_CAPABILITIES_JSON={"model-id":{"coding":4}}`.

## JEV (TypeSafe AI "System One") — decision: not integrated

What it is: a hosted **decision model**. It returns typed answers (choice,
score, boolean) with calibrated probabilities, not text or code. Its
properties:

* Closed weights, early access with a waitlist, no self-hosting.
* API: `POST https://api.typesafe.ai/v1/systemone` with a bearer key. SDK clients
  are MIT-licensed. It is also listed on OpenRouter as `typesafe/jev-1.13`.
* Pricing about $0.042 per million input tokens.
* No tool execution, no repository or GitHub access, no browser, no
  persistence, and no agent loop.

Comparison with what already exists:

* **Coding engine?** No. It cannot write or edit code.
* **Office agent runtime?** No. It has no loop, tools or memory.
* **Tool or execution layer?** No.
* **Provider/gateway component?** Only as a classifier: "which job is this
  request?" The router already does this deterministically from the explicit
  job. A learned classifier would send every task's text to a third party that
  is still in early access, with no reviewed data-use terms, to replace logic
  that costs nothing and cannot drift.

Therefore JEV is **not integrated**. Nothing of value would be added that the
platform does not already do, and it would add a privacy exposure and an
early-access dependency. If a future need arises for learned, probabilistic
classification of free-text requests into jobs, the plug point is the `job`
parameter of `AgentTurnGateway.evaluate/order`. A classifier can set it, behind
the same privacy flag rule as any other provider.
