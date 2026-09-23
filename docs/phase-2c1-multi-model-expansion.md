# Phase 2C.1 multi-model expansion

Research snapshot: 2026-09-23. This document records architecture inputs; provider pages remain the source of truth for changing prices and limits.

## Decision

Prepare Qwen, Kimi, Zhipu/GLM and MiniMax behind the existing gateway contract. Do not enable them in the production allowlist. Anthropic remains the production default and DeepSeek remains the proven canary. Runtime automatic selection is present but defaults off (`MODEL_GATEWAY_AUTO_SELECT_ENABLED=false`).

For the Development Escape Route, select only among providers that have both a server-side key and a server-side private-data authorization flag. The controller owns provider choice and fallback; OpenCode never receives GitHub, production, database or unrelated provider credentials.

## Official-source comparison

| Provider | Prepared model | API and tools | Published price used for conservative accounting | Limits | API data policy | Private code status |
| --- | --- | --- | --- | --- | --- | --- |
| Qwen / Model Studio | `qwen3.8-flash` | Latest low-latency multimodal Qwen generation model; OpenAI-compatible Chat Completions; function tools; Singapore workspace-dedicated endpoint; 1M context | Singapore list price is CNY 1.094 input / CNY 3.427 output and CNY 0.117 cache-hit input per MTok. Controller uses rounded USD ceilings of $0.20 / $0.60 / $0.03 to avoid undercounting FX movement. | Dynamic Singapore TPM tier; normal-use RPM is provider managed | Model Studio states ordinary API customer data is not used for model training without authorization and retains conversation data only for the minimum service period. Do not use a personal Coding Plan key for private source. | Eligible only after `QWEN_API_PRIVATE_DATA_APPROVED=true` plus an explicit Singapore workspace URL in `QWEN_API_BASE_URL` / `QWEN_API_ENDPOINT`. `qwen3-coder-next` was rejected because the console schedules retirement on 2026-10-10. |
| Kimi / Moonshot | `kimi-k2.7-code` | OpenAI-compatible Chat Completions and Responses; native tool calls; automatic context cache; coding model up to 256K | $0.95 input, $0.19 cache read, $4 output per MTok | Concurrency/RPM/TPM/TPD; tier is based on cumulative top-up and exposed in console/headers | Kimi API explicitly says API inputs and outputs are not used to train/improve models and are not persistently stored for training | Eligible after `KIMI_API_PRIVATE_DATA_APPROVED=true` |
| Zhipu / Z.AI | `glm-5.3-flash` | OpenAI-compatible Chat Completions; function calling; 200K-class context | $0.15 input, $0.03 cached input, $0.50 output per MTok | Account/model rate limits shown in the Z.AI console; gateway handles 429 with retry/fallback | API DPA makes Z.AI a processor, limits processing to API service delivery/instructions, and states prompt/output content is processed in real time and not stored | Eligible after `ZHIPU_API_PRIVATE_DATA_APPROVED=true` |
| MiniMax | `MiniMax-M2.7` | OpenAI and Anthropic compatibility; tool use/interleaved thinking; 204.8K context (M3 offers 1M) | $0.30 input, $0.06 cache read, $0.375 cache write, $1.20 output per MTok | M2.7: 500 RPM / 20M TPM; pay-as-you-go recommended for production | The reviewed public API privacy materials did not provide a sufficiently explicit no-training statement for API prompts/outputs | Blocked for private code until contractual/API-policy confirmation; adapter may be tested only with synthetic public data |

Official references:

- Qwen API and regional endpoints: https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions
- Qwen pricing: https://help.aliyun.com/en/model-studio/model-pricing
- Model Studio privacy: https://help.aliyun.com/en/model-studio/privacy-notice
- Kimi API/data security: https://www.kimi.ai/help/kimi-api/api-data-security
- Kimi Chat Completions: https://platform.kimi.ai/docs/api/chat
- Kimi rate limits: https://www.kimi.ai/help/kimi-api/api-rate-limits
- Z.AI OpenAI compatibility and tool calls: https://docs.z.ai/guides/develop/openai/python
- Z.AI pricing: https://docs.z.ai/guides/overview/pricing
- Z.AI API DPA: https://docs.z.ai/legal-agreement/privacy-policy
- MiniMax OpenAI compatibility: https://platform.minimax.io/docs/api-reference/text-openai-api
- MiniMax rate limits: https://platform.minimax.io/docs/guides/rate-limits
- MiniMax pricing: https://platform.minimax.io/subscribe/token-plan?tab=api-enterprise
- MiniMax platform terms/privacy entry point: https://platform.minimax.io/docs/guides/privacy-policy

## Implementation and safety

- A shared Chat Completions adapter normalizes response text, tokens, cached tokens, cost, duration and request IDs.
- Four thin provider adapters pin official HTTPS endpoints, current coding models, capabilities and conservative pricing.
- All four models support provider-native function calling, but the runtime gateway deliberately does not advertise host-tool capability until a separate audited tool-schema translation exists. OpenCode supplies its own isolated edit/read tools through its compatible SDK path.
- Provider catalog metadata supplies privacy eligibility, context window, cost tier and quality tier.
- Optional automatic runtime routing filters by required capability, provider health, context size, private-data eligibility and allowlist, then scores cost versus quality.
- Ordered runtime routing remains the default. Existing checkpoints, idempotency, attempt logging and budget stops remain in the gateway and execute before a fallback provider is billed.
- OpenCode generates a single-provider configuration per attempt from a controller-owned secret file. The file is removed before tests run. On provider failure the controller records a non-secret reason and continues with the next eligible provider in the same isolated worktree.
- MiniMax is deliberately marked ineligible for private data. No key or approval flag can bypass the missing policy review unless the code's reviewed-policy marker is changed in a future audited PR.

## Activation sequence

1. Qwen synthetic canary, then harmless isolated OpenCode task. It combines strong coding focus, long context and explicit no-training language.
2. Zhipu synthetic canary and fallback exercise. It is the lowest published routine-work cost and has strong API DPA language.
3. Kimi coding canary for difficult/long-horizon work; use after cost ceilings and rate tier are confirmed.
4. MiniMax synthetic-only canary; private-code activation remains blocked pending written API data-use confirmation.

Each provider activation requires a separate key, funding if applicable, server-side private-data approval flag, synthetic live request, controlled failover to Anthropic/another authorized provider, harmless OpenCode task, token/cost evidence and a secret-leak scan. No production allowlist change is part of Phase 2C.1 preparation.
