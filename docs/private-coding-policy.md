# Private coding policy (free routes)

Status: **PRIVATE free coding is DISABLED.** No route changes are made by this document.

Last reviewed: 2026-09-30.

## How routing enforces it

Every route has a data class, and every coding session declares the class of its code (`config.dataClass`). The gateway only offers a route a session whose class it allows (`requiredDataClass` / `allowsDataClass` in `src/model-gateway/agentic/pool-registry.js`, reason `PRIVACY_NOT_APPROVED`):

| Class | Meaning | Who may receive it |
|---|---|---|
| PUBLIC | public repositories, public data | any route |
| NORMAL | non-sensitive business text | routes whose terms forbid training and do not keep content |
| PRIVATE | private repositories and code | NORMAL-capable routes **plus** an explicit owner flag `*_API_PRIVATE_DATA_APPROVED=true` |
| CONFIDENTIAL | secrets, personal data, contracts | paid routes with verified terms only; never free |

Unknown or missing classes fail closed to PRIVATE. The free-route guard, the budget and the privacy gate are independent: a route needs all three.

## Evidence standard

* Only **primary** sources count: the provider's terms, data-usage or privacy pages.
* The sandbox cannot open most provider domains (egress policy). The excerpts below come from search results quoting those official pages, and **Fahad must read the linked page before setting any flag**.
* Marketing language ("private by default") is only accepted when the terms or data-usage page say the same.

## Per provider

| Provider (free route) | Training on API data | Retention / logging | Opt-out / ZDR | Class today | Could become | Owner action |
|---|---|---|---|---|---|---|
| **Gemini API (free tier)** | **Yes**: "Unpaid Services" data is used to provide, improve and develop products; human reviewers may read it. The terms say not to submit sensitive, confidential or personal information | per Google policy | none on the free tier | **PUBLIC_ONLY** | PRIVATE only on a paid Cloud project (not planned) | none |
| **Groq** | **No**: Services Agreement §4.2, "not permitted to use Inputs or Outputs for training … unless explicitly granted permission" | not retained by default; reliability/abuse logs ≤ 30 days | **Zero Data Retention** switch in Console → Data Controls (org-wide or per feature) | NORMAL_ALLOWED | **PRIVATE_ELIGIBLE** | 1. Console → Data Controls → enable ZDR. 2. `sudo bash ops/set-secret.sh GROQ_API_PRIVATE_DATA_APPROVED` = `true`. **Coding value is nil on the free tier** (8K tokens/min is below a small coding turn), so this unlocks private *Office* text, not coding |
| **Z.ai GLM Flash** | **Not stated.** Terms (Jingsheng Hengxing Technology Pte. Ltd, Singapore) and the privacy policy say API content "is not stored … processed in real time"; no explicit statement on training was found; independent reviews call the data terms unpublished | "not stored" (stated) | none published | PUBLIC (default) | PRIVATE_ELIGIBLE **only if** Fahad confirms no training in the Terms/DPA | Fahad reads https://docs.z.ai/legal-agreement/terms-of-use and the DPA. Only if they state that API content is not used for training: `sudo bash ops/set-secret.sh ZHIPU_API_PRIVATE_DATA_APPROVED` = `true`. Coding value: small PRIVATE jobs (GLM-4.7-flash and GLM-4.5-flash are CODING_SMALL_TASKS) |
| **Mistral (free Experiment plan)** | **Yes by default** on the free plan (REPORTED); opt-out in Admin Console → Privacy | REPORTED 30 days | opt-out switch; ZDR on request for paid plans (REPORTED) | not active (no key) | NORMAL after opt-out; PRIVATE after review | See owner action 1 in `docs/capacity-v2.md` §9 |
| **OpenRouter `:free`** | **Depends on the upstream provider.** OpenRouter itself does not retain prompts unless opted in, but free models often require allowing providers that may train or log (some free models state that they train, e.g. Laguna S 2.1) | per upstream | ZDR routing exists, but free models mostly need logging allowed | **PUBLIC_ONLY** | none for free models | none |
| **Cloudflare Workers AI** | **No**: data-usage page, "does not use customer content to train any AI models … unless explicit consent" | inference requests processed and discarded | built in | not active (no key) | **PRIVATE_ELIGIBLE** after key + flag | Owner action 3 (token + account id), then a reviewed `CLOUDFLARE_API_PRIVATE_DATA_APPROVED`. Coding value: small tasks only (10K neurons/day) |
| **Ollama Cloud** | no logging or training (vendor statement) | — | — | not active | PRIVATE candidate | deferred on capacity (small unpublished allowance) |
| **OpenCode Zen** | per model: zero-retention providers do not train; some free models train (e.g. Muse Spark) | per model | per model | not active | NORMAL for zero-retention models | disable auto-reload first |

## Decision

* **Today:** PRIVATE free coding = **0 jobs/day**, by design.
* **Fastest legitimate path to free PRIVATE coding:**
  1. **Z.ai** (already integrated, CODING_SMALL_TASKS). This needs Fahad's reading of the Terms/DPA; the evidence is incomplete today.
  2. **Cloudflare Workers AI**: terms are explicit, small quota, needs a key.
* **Groq** is eligible on terms but cannot carry a coding turn on the free tier.
* **CONFIDENTIAL** is never routed to a free provider.

## Tests that enforce this

* `test/capacity-v2.test.js`: data-class gates, and PUBLIC routes never get PRIVATE code.
* `test/capacity-model.test.js`: `requiredDataClass` fails closed; coding capacity per data class.
* `test/coding-qualification.test.js`: a grade never waives tool calling or privacy.
