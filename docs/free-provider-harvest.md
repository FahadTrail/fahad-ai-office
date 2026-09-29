# Free provider harvest (Capacity V2, wave 2)

## Sources

* `node tools/omniroute-harvest.mjs --json`, run 2026-09-29 19:0x UTC, over OmniRoute's `PROVIDER_REFERENCE.md` and `FREE_TIERS.md`:
  * 352 providers.
  * 46 CANDIDATE, 173 NO_RECURRING_FREE, 46 NOT_APPLICABLE.
  * 42 REJECTED_WEB_SCRAPING, 35 REJECTED_CONSUMER_LOGIN, 10 REJECTED_TOS.
* Provider terms where reachable (primary, or labelled REPORTED).
* Production telemetry: `provider_status`, `model_attempts`, qualification rows (MEASURED).

OmniRoute is a **discovery source only**. It is not a gateway and not proof
of a quota (see `docs/capacity-v2.md` §2). The 77 rejected entries reuse
consumer logins, browser cookies or reverse-engineered web apps; they are
never used.

## Independent pool rule

* A pool counts once, at its **actual quota source**.
* Gateways and resellers that forward to the same upstream providers add no independent quota. Their provenance, retention and terms are usually unknown, so they are rejected even when they advertise "free" models.
* That covers:
  * `anyapi`, `api-airforce`, `bazaarlink`, `bluesminds`, `chat-oripe`, `cloudcode-one`, `dxnt`, `electronhub`;
  * `fastrouter`, `free-ai`, `kilo-gateway`, `literouter`, `llm-kiwi`, `llmgateway`, `mixlayer`, `mnn-ai`;
  * `naga-ai`, `ofoxai`, `poixe-ai`, `requesty`, `speka`, `tokenreply`, `unorouter`, `void-ai`, `zylo-api`.
* OpenRouter is the one gateway kept: it is already integrated, its `:free` allowance is its own published quota, and it is counted as **one** key-wide pool.

## First-party candidates

| Provider | Actual quota source | Independent pool? | API auth | Free limit | Reset | Privacy | Coding value | Owner action | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| Gemini (Google AI Studio) | Google, per model | Yes, 1 per model | API key | Flash ≈20 RPD, Flash-Lite ≈500 RPD (REPORTED); Flash-Lite ≈2.31M tokens/day ESTIMATED from MEASURED request size | 00:00 Pacific | PUBLIC (free tier may be used to improve products) | Qualified; coding suite running | none | **ACTIVE** |
| Groq | Groq, per model | Yes, 1 per model | API key | 30 RPM, 1K RPD, **8K TPM (MEASURED from headers)**, 200K TPD (PUBLISHED) | rolling | NORMAL per terms (no training, no retention by default; optional zero data retention). Treated PUBLIC until the owner flag | 8K tokens/min is below one agentic coding turn (≈30K input): small checks only | optional privacy flag | **ACTIVE** (general); not a coding pool |
| OpenRouter `:free` | OpenRouter key-wide | Yes, 1 for all `:free` models | API key | 50 RPD, 20 RPM (PUBLISHED); 1,000 RPD after a one-time $10 credit | 00:00 UTC | PUBLIC (upstreams may log) | nemotron-3-ultra qualified; coding suite running | optional $10 | **ACTIVE** |
| Z.ai GLM Flash | Z.ai | Yes, 1 | API key | $0 models; 1 concurrent request; no daily cap published | — | NORMAL per terms (API data not stored, not used for training). Treated PUBLIC until the owner flag | glm-4.5/4.7-flash qualified (general); coding suite running | **privacy flag = best private-coding candidate** | **ACTIVE** |
| Mistral (La Plateforme, Experiment plan) | Mistral | Yes | API key; phone (SMS) verification, no card (REPORTED) | ≈1B tokens/month, ≈1 RPS (REPORTED) | monthly | PUBLIC (free-mode data may be used for training) | Codestral included (REPORTED); not measured | create key with phone verification | **OWNER_ACTION_REQUIRED** |
| LLM7 | LLM7 | Yes | token | 1M tokens/day rolling, 60 RPM, 250/h (PUBLISHED) | rolling 24 h | PUBLIC | public-code only; best-effort service | create token | **OWNER_ACTION_REQUIRED** |
| Cloudflare Workers AI | Cloudflare | Yes | API token + account id | 10,000 neurons/day (PUBLISHED; tokens per neuron model-specific, UNKNOWN until measured) | 00:00 UTC | NORMAL (no training or retention) | small: gpt-oss-120b, qwen2.5-coder-32b | token + account id; stay on Free plan | **OWNER_ACTION_REQUIRED** |
| Ollama Cloud | Ollama | Yes | API key | small monthly allowance, not published; 1 concurrent | monthly from signup | NORMAL (no logging or training) | private-coding candidate, capacity UNKNOWN | create key | **OWNER_ACTION_REQUIRED** (lower priority) |
| OpenCode Zen | OpenCode (US-hosted) | Yes | API key | "limited-time" free models, no published numeric limit | promo | per model: Space Bunny and LongCat zero-retention (NORMAL); Big Pickle, MiMo, Ling train (PUBLIC); Nemotron NVIDIA trial (logged); Muse Spark trains (excluded) | Big Pickle / Space Bunny untested | create key; **disable auto-reload ($20 at <$5)** | **OWNER_ACTION_REQUIRED** |
| Cerebras | Cerebras | Yes | API key | trial credits only (1M tokens/day during trial) | one-time | PUBLIC | — | — | **REJECT** (used up; 67 MEASURED invalid-request failures) |
| SambaNova | SambaNova | Yes | API key | $5 one-time credit, 30 days (REPORTED) | one-time | UNKNOWN | — | — | **DEFER** (no recurring pool) |
| GitHub Models | GitHub | — | — | retired (wave 1 research) | — | — | — | — | **REJECT** |
| Hugging Face Inference | HF | Yes | token | small monthly credit (REPORTED ≈200K tokens/month) | monthly | NORMAL-ish (per provider) | low | — | **LOW_VALUE_DEFER** |
| Together AI | Together | — | API key | no recurring free tier (paid) | — | — | — | — | **DEFER** |
| Fireworks AI | Fireworks | — | API key | trial credit only | one-time | — | — | — | **DEFER** |
| NVIDIA API catalog | NVIDIA | Yes | API key | trial endpoints | trial | logged, "do not submit personal or confidential data" | — | — | **REJECT** for production (trial terms) |
| Cohere | Cohere | Yes | trial key | 1,000 calls/month; trial keys are for testing only | monthly | — | — | — | **REJECT** (trial terms) |
| InternLM | Shanghai AI Lab | Yes | API key | ≈1M input / 3M output tokens per month (REPORTED) | monthly | UNKNOWN | UNKNOWN | account | **LOW_VALUE_DEFER** |
| Arcee AI | Arcee | Yes | API key | ≈5M tokens/month (REPORTED) | monthly | UNKNOWN | UNKNOWN | account | **DEFER** (review terms first) |
| Baidu / Tencent / ModelScope / SiliconFlow | vendors | Yes | real-name identity verification | "uncapped" or credit (REPORTED) | — | UNKNOWN, CN jurisdiction | — | identity verification | **DEFER** |
| Featherless, Morph | vendors | Yes | API key | small or unclear | — | UNKNOWN | Morph is a code-apply model only | — | **LOW_VALUE_DEFER** |

## Conclusion

* **Private free coding:** the only legitimate path with keys that already exist is **Z.ai GLM Flash**. Its API terms state no storage and no training.
  * Fahad reviews the terms and sets `ZHIPU_API_PRIVATE_DATA_APPROVED=true`.
  * GLM Flash must pass the coding suite.
  * It serves one request at a time.
* **Groq** has the same privacy terms, but its free 8K tokens/minute limit cannot carry agentic coding.
* **Public coding:** the Office repository `FahadTrail/fahad-ai-office` is public, so tasks on it may be marked `dataClass: "PUBLIC"` and use any free route with a coding grade.
* **Largest capacity unlock:** Mistral (≈1B tokens/month REPORTED, PUBLIC only), then LLM7 (1M/day PUBLISHED).
