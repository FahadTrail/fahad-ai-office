# Model providers, free capacity and JEV

This is the source of truth for which AI providers the platform can use, which
of them are free, and why. It was researched on 2026-09-25 from each provider's
official pages, cited below. Free tiers change often. The code treats every
allowance here as **published, not guaranteed**. Only numbers a provider reports
in its own response headers are shown as exact.

Code: `src/model-gateway/agentic/model-pool.js` (routes),
`src/model-gateway/agentic/capabilities.js` (what each model is good for),
`src/model-gateway/agentic/free-quota.js` (free allowances and reset times),
`src/model-gateway/agentic/turn-gateway.js` (routing and rotation).

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

## Provider table

Status legend: **LIVE** means a real canary or real traffic succeeded. **READY —
CREDENTIAL REQUIRED** means the adapter is built and tested and only the key is
missing.

| Provider | Default model | Billing class | Free allowance (published) | Reset | Tools | Coding job? | Private data | Status / blocker |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Anthropic | `claude-opus-5`, `claude-sonnet-5` | paid | none | — | yes | yes | approved | LIVE |
| OpenAI | `gpt-5.3-codex` | paid | none | — | yes | yes | approved | LIVE (not authorized for the project) |
| DeepSeek | `deepseek-flash` | paid (very low) | none | — | yes | yes | approved (opt-out verified) | LIVE |
| Qwen (Alibaba Model Studio) | `qwen3.8-flash` | paid | 1M tokens per model, one-time, 90 days, Singapore region only | one-time | yes | yes | flag `QWEN_API_PRIVATE_DATA_APPROVED` | Key present; account not activated (`AccessDenied.Unpurchased`) |
| Gemini API (AI Studio) | `gemini-flash-latest` | free | Per project/model; Google shows limits only in AI Studio (Flash is about 20 requests/day on the free tier) | midnight Pacific | yes | yes | flag `GEMINI_API_PRIVATE_DATA_APPROVED` (free-tier prompts may be used by Google) | READY — CREDENTIAL REQUIRED |
| Groq | `openai/gpt-oss-120b` | free | Per org/model, e.g. 1,000 requests/day; exact values in response headers | rolling | yes | no (coding 3) | flag | READY — CREDENTIAL REQUIRED |
| OpenRouter | `openai/gpt-oss-120b:free` | free | `:free` models: 20/min, 50/day (1,000/day after $10 credit purchase) | midnight UTC | yes | no (coding 3) | flag | READY — CREDENTIAL REQUIRED |
| GitHub Models | `openai/gpt-4.1` | free | About 150/day low-tier, 50/day high-tier, 10–15/min, 8K in / 4K out per request | rolling | yes | no (8K context) | flag | READY — CREDENTIAL REQUIRED |
| Cerebras | `gpt-oss-120b` | free | 14,400 requests/day, 1M tokens/day, 30/min; small free context | rolling | yes | no (context) | flag | READY — CREDENTIAL REQUIRED |
| Z.ai (GLM) free | `glm-4.7-flash` | free ($0 list price) | rate-limited, no daily cap published | — | yes | no (coding 3) | flag `ZHIPU_API_PRIVATE_DATA_APPROVED` | READY — CREDENTIAL REQUIRED |
| Z.ai (GLM) paid | `glm-5.3-flash` | paid | none | — | yes | yes | flag | READY — CREDENTIAL REQUIRED |
| Kimi (Moonshot) | `kimi-k2.7-code` | paid | none: minimum $1 top-up; $5 voucher after $5 of top-ups | — | yes | yes | flag | READY — CREDENTIAL REQUIRED |
| MiniMax | `MiniMax-M2.7` | paid | none | — | yes | yes | **blocked in code** pending a written data-use policy | READY — CREDENTIAL REQUIRED (public data only) |
| Mistral | `mistral-medium-latest` | paid until stated | Experiment plan is free but rate-limited, monthly cap shown only in the console, and prompts may be used for training | monthly | yes | yes | flag | READY — CREDENTIAL + PLAN REQUIRED |

Notes:

* **Gemini consumer subscription ≠ Gemini API.** Google AI Pro/Ultra (the
  Gemini app) does not include API access. The API is a separate product: a key
  from Google AI Studio (https://aistudio.google.com/apikey). Since 2026-05-28
  AI Studio creates **auth keys** that start with `AQ.`; legacy standard keys
  (`AIza…`) are being retired by Google. Both are accepted by
  `ops/set-secret.sh`, and the adapter sends the key in the `x-goog-api-key`
  header that auth keys require. It is free-tier
  unless billing is enabled on its Cloud project. Free-tier prompts may be used
  to improve Google products, so private repository data stays off it until a
  reviewed **paid** project sets `GEMINI_API_PRIVATE_DATA_APPROVED=true` and
  `GEMINI_BILLING_CLASS=paid` with `GEMINI_PRICING_JSON`.
* **Qwen `AccessDenied.Unpurchased`.** The key is valid, but Model Studio has not
  been activated for the account in the key's region. Fix: sign in to the
  Alibaba Cloud Model Studio console in the **same region as the endpoint**
  (Singapore for `dashscope-intl.aliyuncs.com`) and click *Activate Model
  Studio* / accept the terms. Also confirm the account has no overdue balance
  (Expenses and Costs). The API key must be created in that same region. Nothing
  changes in code.
* **OpenAI** is LIVE on the key but not authorized for the project. That is an
  owner choice recorded in `workspace_provider_permissions`, not a defect.
* Each free-tier provider needs its own key. The Coding Agent's GitHub token
  (`CODING_GITHUB_TOKEN`) is never reused for GitHub Models inference.

Sources:
[Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing),
[Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits),
[Groq rate limits](https://console.groq.com/docs/rate-limits),
[OpenRouter limits](https://openrouter.ai/docs/api-reference/limits),
[GitHub Models rate limits](https://docs.github.com/en/github-models/use-github-models/prototyping-with-ai-models#rate-limits),
[Cerebras rate limits](https://inference-docs.cerebras.ai/support/rate-limits),
[Z.ai pricing](https://docs.z.ai/guides/overview/pricing),
[Mistral rate limits](https://help.mistral.ai/en/articles/698531-why-am-i-hitting-api-rate-limits-and-how-do-i-increase-them),
[Model Studio free quota](https://www.alibabacloud.com/help/en/model-studio/new-free-quota),
[Model Studio error codes](https://www.alibabacloud.com/help/en/model-studio/error-code),
[Kimi pricing](https://platform.moonshot.ai/docs/pricing/chat).

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
`CODING_SUPABASE_ACCESS_TOKEN`. After adding a key, run **Hub → Platform → Open
model pool → Run live canary**. A route is only called verified after that
canary succeeds. To let the Coding Agent's project use the new route, add the
provider to the project's `workspace_provider_permissions`, which is an owner
decision.

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
