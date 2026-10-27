# Cloudflare qualification investigation (2026-10-27)

Baseline: deployed `8cffacca88aeae217a78ebe271454200ecf7ab3e`. This investigation makes no live provider calls and does not change deployment, qualification records, model permissions, privacy flags, or budgets.

## What the retained evidence proves

The bounded certification's `/tmp/cf-final-qualification.json` retains four request shapes/statuses, sanitized results and aggregated usage. It does not retain raw responses, finish reasons, request IDs or the model's answer. The temporary evidence files were read again during this investigation.

### Llama 3.3 70B

All three requests returned upstream HTTP 200. The combined skill check passed six skills. `requests=3` and the deployed `qualifyRoute` control flow prove that the first tool turn contained a parsed `lookup_price` call whose arguments matched `widget`, so the result-bearing follow-up was sent. `skills.tools=false` proves that the follow-up did not pass `gradeToolAnswer`.

The grader expects 29 (four widgets at $7.25), using the first numeric value in the returned text. The retained report cannot distinguish an incorrect answer, an explanatory answer whose first number was not 29, truncation, or a further tool call with no final text. The original prompt requested a number only. There is no evidence to assign this particular failure to Cloudflare rather than Office serialization/parsing/grading. Request serialization and grading remain unchanged; Llama stays text-only.

### Qwen Coder 32B

One text-only request, with neither tools nor tool_choice, returned upstream HTTP 200. The Office protocol then raised local `HTTP_502`. In this source version there are two such branches: missing `choices[0].message`, or no usable text/function call after parsing that message. Both are `empty_response` failures. The report does not distinguish those branches.

Thus this was **not an observed upstream HTTP 502**. A genuinely unusable provider response, token exhaustion with only reasoning, or a response format the adapter does not understand remain unconfirmed explanations. No native-response fallback, invented text, tool support claim, or qualification promotion is justified by this evidence. Qwen remains unqualified/disabled by existing gates.

Recorded Qwen usage is zero in the accumulator, but this does not establish zero token consumption. The missing-choice branch discarded provider usage before constructing an error, and qualification discarded usage attached to a thrown protocol error. Without the raw response, the actual failed-call usage cannot be recovered retrospectively.

## Confirmed Office defect and scoped fix

- Parse usage before rejecting a missing choice, and attach it to either empty-response error.
- Carry the actual upstream HTTP status separately from the local synthesized status.
- Preserve usage on failed turns exactly once, including prior successful turns. Usage from returned turns is also accumulated before the free-route guard rejects a billed/mismatched result.
- Persist fixed, sanitized response-shape booleans/enums and tool-check progress. No response text, reasoning, prompts, credential, arbitrary error payload or provider prose is copied into the durable report.
- Keep empty responses as failures and retain the existing grader, routing gates and qualification thresholds. A six-skill text pass does not become a tool/coding pass.

Offline regressions cover missing choices and empty messages with reported usage, error accounting after successful turns, durable sanitized readback payloads, successful and mismatched tool answers, truncation/repeated tool calls, and untrusted provider fields.

## Later live verification (not authorized by this change)

After a separately approved deployment of these diagnostics, any separately authorized targeted test should inspect the persisted response shape, local/upstream status and tool-check stage. A Llama tool round trip requires two requests; a Qwen text check requires one. The previous allocation has only one Cloudflare request left, so it cannot cover both. This PR consumes none and does not authorize a deployment, retry or a higher request limit.

Keep GPT-OSS's existing qualification, Llama's text-only qualification and Qwen's disabled state throughout. Do not change privacy policies, paid providers, the $2 monthly budget, or HABRAH.
