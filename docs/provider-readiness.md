# Provider readiness (prepared during the 24 h burn-in)

Status on 2026-09-30. No provider was activated. The checks below were run offline: `createModelPool` with placeholder keys and fixture catalogs. No key or network call was used.

## Activation path (the same for every provider)

1. The owner creates the key and runs `sudo bash ops/set-secret.sh NAME`. The script:
   * reads the key from a hidden prompt;
   * checks its shape;
   * verifies it against the provider's model list where the provider has one;
   * writes nothing if verification fails;
   * reloads the runtime (and the coding worker when it is enabled);
   * runs the health check.
2. On start, the runtime refreshes the provider's **own** model catalog (`provider-catalogs.js`). Each route exists only while its model is in that catalog. Without a catalog there is no route; the pool never guesses a model id.
3. Background qualification (`qualification.js`) grades the new routes: general skills, then the coding suite (`coding-qualification.js`) for routes with coding + tools skills.
4. Capacity counts a route only after a live success (REPORTED quota is never MEASURED).
5. `npm run canary:agentic` is the owner's explicit live check, plus a failover drill.

## Per provider

| Provider | Secret(s) | Routes created (fixture catalog) | Billing | Data class | Pool | Gaps |
|---|---|---|---|---|---|---|
| **Mistral** | `MISTRAL_API_KEY` **+ `MISTRAL_BILLING_CLASS=free`** | `mistral:mistral-medium-latest` (one model, `MISTRAL_MODEL`) | **paid + `PRICING_UNKNOWN` with the key alone** → free only with the billing class | PUBLIC (free mode trains by default) | `mistral:account` | **Fixed on this branch:** the owner action now includes the billing-class step, and "done" requires it. Codestral needs `MISTRAL_MODEL=codestral-latest` (one model per route today). |
| **LLM7** | `LLM7_API_KEY` | up to 4 admitted families (gpt-oss, qwen coder, deepseek, codestral, glm ≥ 4.5, …); `llama-3.1-8b` rejected | free | PUBLIC | `llm7:free` (1M tokens/rolling 24 h, PUBLISHED) | none; context defaults to 32K when the catalog gives none |
| **Cloudflare Workers AI** | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | the defaults present in the account catalog (`gpt-oss-120b`, `qwen2.5-coder-32b`, `llama-3.3-70b`) | free (error 4006 = daily quota, never billed on the Free plan) | NORMAL; PRIVATE after `CLOUDFLARE_API_PRIVATE_DATA_APPROVED` | `cloudflare:neurons` (`capacity-pools.js`) | tokens per neuron UNKNOWN until measured |
| **Ollama Cloud** | `OLLAMA_API_KEY` | `gpt-oss:120b`, `qwen3-coder:480b`, `deepseek-v3.1:671b` when listed | free | NORMAL; PRIVATE after the flag | `ollama:cloud` (scarce, 1 concurrent) | allowance not published: DEFERRED |
| **OpenCode Zen** | `OPENCODE_ZEN_API_KEY` | only the listed free promotions (`space-bunny-free` NORMAL, `big-pickle` PUBLIC, …); `muse-spark` and paid models excluded | free (promo) | per model | `opencode:free` | **auto-reload must be disabled first** ($20 when below $5) |

Every route above has tool calling and no unavailable reason once its key and catalog exist. None is privacy-approved without an explicit flag. Tests: `test/capacity-v2.test.js`, `test/capacity-model.test.js` (owner actions, including the Mistral billing class).

## After activation (per provider, at $0)

1. Check the catalog: `GET /api/capacity` → the provider's catalog status is `ok`.
2. Qualification: the route shows `qualified`, and a coding grade appears within one qualification cycle.
3. One small PUBLIC coding benchmark pinned to the route:
   `node tools/coding-benchmark.mjs start --task=small --route=<id>`.
4. Record the result as MEASURED in `docs/capacity-v2.md`. Until then the quota stays REPORTED.
