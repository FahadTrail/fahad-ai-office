# Phase 2C provider selection

Decision date: 2026-09-23

## Decision

DeepSeek V4.1 Flash is the first live canary. Anthropic remains the production
default and the other target providers remain inactive.

The selection uses current primary documentation and favors the smallest safe
integration that can serve both the Office gateway and an external coding
harness. The canary is text-only inside the Office gateway; OpenCode owns its
coding-tool loop inside a separate controller boundary.

## Comparison

| Provider | Coding and tools | API and operations | Cost posture | First-canary finding |
| --- | --- | --- | --- | --- |
| DeepSeek | V4.1 Flash publishes strong terminal/repository coding results; native Responses, Anthropic compatibility and tool calls | 1M context; documented HTTP 429 behavior; published concurrency of 2,500 for Flash; directly documented by OpenCode | Peak Flash: $0.30/M uncached input, $0.006/M cached input, $1.20/M output; off-peak discounts are ignored by our budget policy | **Selected**: best coding/cost/compatibility combination and the least adapter work |
| Qwen | Qwen3-Coder and function calling are mature | OpenAI-compatible; dual RPM/TPM plus burst controls; regional endpoints, keys and workspace settings add deployment complexity | Qwen3-Coder-Plus starts at CNY 4/M input and CNY 16/M output for shorter requests and rises with context length | Strong second provider, especially when regional/enterprise settings are chosen |
| Kimi / Moonshot | K2.5 is designed for agentic coding and tool use | OpenAI and Anthropic compatibility; public operational/rate-limit detail is less complete than DeepSeek/Qwen | Pricing and account tiers require validation in the selected region/account before production budgeting | Strong agentic candidate after a billing/rate canary |
| GLM / Zhipu | GLM coding models are supported by OpenCode and other coding harnesses | Coding endpoint and rolling five-hour/weekly quota are documented; regional/account constraints need validation | Coding-plan quotas are clear, but production PAYG evidence must be validated for the chosen account | Good ecosystem fit; defer until quota and production pricing are verified |
| MiniMax | M3/M2.5 target coding, tools and long-context agent work | OpenAI-compatible paths and PAYG/token plans; plan throttling can change during peaks | M3 promotional PAYG starts at $0.30/M input and $1.20/M output below 512K; longer contexts cost more | Competitive cost and context; operational throttling makes it a later canary |

## Privacy and security condition

DeepSeek's public privacy policy allows collection and model-improvement use of
submitted content and describes processing/storage in the People's Republic of
China. Therefore Phase 2C does not enable DeepSeek for production Office data.
The live canary uses a synthetic prompt only. The development service must use
a dedicated key, exclude secrets and sensitive data, and apply any available
training opt-out or enterprise data terms before private repository work is
authorized.

OpenCode is selected instead of adding another coding agent because it already
supports DeepSeek and headless JSON execution. Its current headless runner has
reported hangs and missing output on fatal/denied paths, so the controller adds
hard timeouts, one automatic retry, machine-readable-output checks, fixed
controller-side tests and protected-path validation. GitHub publication is
owned by the controller; the model never receives the GitHub token.

## Activation order

1. DeepSeek V4.1 Flash
2. Qwen
3. Kimi / Moonshot
4. GLM / Zhipu
5. MiniMax
6. Gemini
7. Grok

Each activation requires a synthetic live canary, an isolated fallback drill,
cost/limit verification in the real account, privacy review and an explicit
server-side allowlist. No additional provider is enabled merely by appearing
in the catalog.

## Primary references

- DeepSeek: <https://api-docs.deepseek.com/quick_start/pricing/>, <https://api-docs.deepseek.com/quick_start/rate_limit/>, <https://api-docs.deepseek.com/api/create-response/>, <https://api-docs.deepseek.com/news/news260910/>, <https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html>
- Qwen: <https://help.aliyun.com/en/model-studio/qwen-coder>, <https://help.aliyun.com/en/model-studio/compatibility-of-openai-with-dashscope>, <https://help.aliyun.com/en/model-studio/qwen-function-calling>, <https://help.aliyun.com/en/model-studio/rate-limiting-best-practices>, <https://help.aliyun.com/en/model-studio/model-pricing>
- Kimi: <https://github.com/MoonshotAI/Kimi-K2.5>, <https://forum.moonshot.ai/t/kimi-k2-5-api-is-now-available/218>
- GLM: <https://open.bigmodel.cn/glm-coding>
- MiniMax: <https://www.minimax.io/blog/minimax-m3>, <https://www.minimax.io/models/text>, <https://platform.minimax.io/subscribe/token-plan?tab=api-enterprise>
- OpenCode: <https://opencode.ai/docs/cli/>, <https://opencode.ai/docs/permissions/>, <https://opencode.ai/docs/providers/>, <https://github.com/anomalyco/opencode/issues/42268>, <https://github.com/anomalyco/opencode/issues/36413>
