// Narrowly scoped Cloudflare Workers AI validation.
//
// Why a separate command: `npm run canary:agentic` probes EVERY routable
// provider, including other free pools and (with CANARY_INCLUDE_PAID) paid
// ones. This one talks to Cloudflare only, with synthetic, non-private data,
// and cannot reach anything else.
//
// Guarantees:
//   * DRY RUN by default: no network call, no credential needed. It prints the
//     exact requests it would send and the caps it would enforce.
//   * Live execution only with an explicit --live flag AND a verified free
//     plan (CLOUDFLARE_PLAN=free). A Paid plan bills neuron overage, so an
//     unstated or paid plan refuses to run (fail closed).
//   * Explicit allowlist: only ids in CLOUDFLARE_CANARY_MODELS (or the
//     documented defaults) can be probed; anything else is refused and
//     reported, never silently dropped.
//   * No database writes, no provider_status updates, no budget reservations.
//     The report is printed to stdout only.
//   * Hard caps: total requests, output tokens per request and total tokens.
//     The run stops at the cap and says where it stopped.
//   * Separate checks: a no-tool call (which must omit the tool fields, the
//     PR #123 regression) and a real tool-calling round trip.
//   * Sanitized report: no credential, no prompt, no model text. Only
//     booleans, counts, durations, token usage and machine error codes.
//
// Usage:
//   node src/canary/cloudflare-canary.js                  # dry run (default)
//   node src/canary/cloudflare-canary.js --live           # real calls, capped
//   node src/canary/cloudflare-canary.js --live --models=@cf/openai/gpt-oss-120b
//   node src/canary/cloudflare-canary.js --live --max-requests=3

import { ChatCompletionsProtocol } from '../model-gateway/agentic/chat-completions.js';
import { classifyProviderError } from '../model-gateway/contracts.js';
import { toolResult, userText } from '../model-gateway/agentic/conversation.js';
import { FREE_ALLOWANCES as FREE_ALLOWANCES_FOR_CANARY } from '../model-gateway/agentic/free-quota.js';

// The documented Workers AI text-generation models this project configures
// (model-pool.js CLOUDFLARE_DEFAULT). The allowlist is never derived from the
// live catalog: a canary must not silently widen what it probes.
export const CLOUDFLARE_CANARY_MODELS = Object.freeze([
  '@cf/openai/gpt-oss-120b',
  '@cf/qwen/qwen2.5-coder-32b-instruct',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
]);

export const CLOUDFLARE_CANARY_LIMITS = Object.freeze({
  maxRequests: 6,
  maxOutputTokens: 256,
  maxTotalTokens: 6_000,
  timeoutMs: 60_000,
});

// Lowest possible: a no-tool call and a tool call + tool answer per model.
export const REQUESTS_PER_MODEL = 3;

// Synthetic, non-private prompts. They ask for public arithmetic and a fixed
// token; nothing from a repository or a customer ever enters this command.
const SYSTEM = 'You are a precise test agent. Follow the instruction exactly.';
const NO_TOOL_PROMPT = 'Reply with exactly this token and nothing else: CLOUDFLARE-OK';
const TOOL_PROMPT = 'Use the add_numbers tool to add 17 and 25, then reply with only the resulting number.';
const TOOL = Object.freeze({
  name: 'add_numbers',
  description: 'Add two integers and return the sum.',
  inputSchema: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] },
});

const text = (value) => ({ role: 'user', content: [{ type: 'text', text: value }] });
const replyText = (result) => (result?.message?.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('').trim();

// The allowlist: the operator's list when set, otherwise the documented
// defaults. Ids are shape-checked so a flag can never inject a URL or a path.
export function canaryAllowlist({ env = {} } = {}) {
  const configured = String(env.CLOUDFLARE_CANARY_MODELS || '').split(',').map((value) => value.trim()).filter(Boolean);
  const listed = configured.length ? configured : [...CLOUDFLARE_CANARY_MODELS];
  return [...new Set(listed.filter((id) => /^@?[A-Za-z0-9._/:-]{2,160}$/.test(id)))];
}

// Selects the models to probe: an explicit request must be a subset of the
// allowlist. A requested id outside it is reported, never probed.
export function canarySelection({ env = {}, models = null } = {}) {
  const allowlist = canaryAllowlist({ env });
  const requested = Array.isArray(models) && models.length
    ? models.map((value) => String(value || '').trim()).filter(Boolean)
    : allowlist;
  return {
    allowlist,
    selected: [...new Set(requested.filter((id) => allowlist.includes(id)))],
    refused: [...new Set(requested.filter((id) => !allowlist.includes(id)))],
  };
}

// Everything the run needs to be safe, checked before any request exists.
export function canaryPreflight({ env = {} } = {}) {
  const token = typeof env.CLOUDFLARE_API_TOKEN === 'string' ? env.CLOUDFLARE_API_TOKEN.trim() : '';
  const account = String(env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const stated = String(env.CLOUDFLARE_PLAN || '').trim().toLowerCase();
  const plan = stated === 'free' || stated === 'paid' ? stated : 'UNVERIFIED';
  const blockers = [];
  if (!token) blockers.push('CLOUDFLARE_API_TOKEN_MISSING');
  if (!/^[a-f0-9]{32}$/i.test(account)) blockers.push('CLOUDFLARE_ACCOUNT_ID_MISSING_OR_INVALID');
  // Fail closed: an unstated plan may be a Paid plan, where the 10,000 daily
  // neurons are a credit and the overage is charged to the account.
  if (plan === 'paid') blockers.push('CLOUDFLARE_PLAN_IS_PAID');
  else if (plan !== 'free') blockers.push('CLOUDFLARE_PLAN_NOT_VERIFIED');
  return {
    // Presence only: the credential value never appears in a report.
    credentialPresent: Boolean(token),
    accountConfigured: /^[a-f0-9]{32}$/i.test(account),
    plan,
    blockers,
    liveAllowed: blockers.length === 0,
  };
}

// The dry-run plan: the exact checks and the caps, with no request sent.
export function cloudflareCanaryPlan({ env = {}, models = null, maxRequests = CLOUDFLARE_CANARY_LIMITS.maxRequests, maxOutputTokens = CLOUDFLARE_CANARY_LIMITS.maxOutputTokens } = {}) {
  const preflight = canaryPreflight({ env });
  const { allowlist, selected, refused } = canarySelection({ env, models });
  const budget = Math.max(0, Number(maxRequests) || 0);
  const checks = [];
  for (const model of selected) {
    checks.push({ model, check: 'no-tool', requests: 1, expects: 'a non-empty answer with NO tools / tool_choice field in the request body' });
    checks.push({ model, check: 'tool-calling', requests: 2, expects: 'an add_numbers call, then the number 42 from its result' });
  }
  let planned = 0;
  const capped = [];
  for (const check of checks) {
    if (planned + check.requests > budget) {
      capped.push({ model: check.model, check: check.check, reason: 'REQUEST_CAP' });
      continue;
    }
    planned += check.requests;
    capped.push({ ...check, planned: true });
  }
  return {
    kind: 'cloudflare-canary',
    mode: 'dry-run',
    live: false,
    dryRun: true,
    provider: 'cloudflare',
    endpointHost: 'api.cloudflare.com',
    preflight,
    allowlist,
    selected,
    refused,
    caps: {
      maxRequests: budget,
      plannedRequests: planned,
      maxOutputTokens: Math.max(1, Number(maxOutputTokens) || CLOUDFLARE_CANARY_LIMITS.maxOutputTokens),
      maxTotalTokens: CLOUDFLARE_CANARY_LIMITS.maxTotalTokens,
      timeoutMs: CLOUDFLARE_CANARY_LIMITS.timeoutMs,
      providers: ['cloudflare'],
      allowPaid: false,
      databaseWrites: false,
    },
    dailyAllowance: { ...FREE_ALLOWANCES_FOR_CANARY.cloudflare },
    checks: capped,
    note: 'Dry run: nothing was sent. Add --live to execute the planned checks with the caps above.',
  };
}

function sanitizeError(error) {
  const classified = classifyProviderError(error);
  return {
    errorCode: classified.code || 'PROVIDER_ERROR',
    failureClass: classified.failureClass || null,
    status: classified.status || null,
    providerType: String(classified.type || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80) || null,
    providerCode: typeof error?.providerCode === 'number' || typeof error?.providerCode === 'string' ? error.providerCode : null,
    reason: classified.reason || null,
  };
}

const usageOf = (result) => ({
  inputTokens: Number(result?.usage?.inputTokens || 0),
  outputTokens: Number(result?.usage?.outputTokens || 0),
});

// Executes the plan. Every request is counted before it is sent; the run
// stops at the request or token cap and reports where it stopped.
export async function runCloudflareCanary({
  env = process.env,
  fetchFn = fetch,
  live = false,
  models = null,
  maxRequests = CLOUDFLARE_CANARY_LIMITS.maxRequests,
  maxOutputTokens = CLOUDFLARE_CANARY_LIMITS.maxOutputTokens,
  maxTotalTokens = CLOUDFLARE_CANARY_LIMITS.maxTotalTokens,
  timeoutMs = CLOUDFLARE_CANARY_LIMITS.timeoutMs,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const plan = cloudflareCanaryPlan({ env, models, maxRequests, maxOutputTokens });
  if (!live) return { ...plan, requestsSent: 0, results: [] };

  const startedAt = new Date(now()).toISOString();
  const report = {
    ...plan, mode: 'live', live: true, dryRun: false, startedAt,
    requestsSent: 0, totalTokens: 0, results: [], stoppedBecause: null,
  };
  if (!plan.preflight.liveAllowed) {
    return { ...report, ok: false, executed: false, finishedAt: new Date(now()).toISOString(), note: `Refused to run: ${plan.preflight.blockers.join(', ')}.` };
  }

  const account = String(env.CLOUDFLARE_ACCOUNT_ID).trim();
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/chat/completions`;
  const cap = plan.caps.maxRequests;
  const tokenCap = Math.max(0, Number(maxTotalTokens) || 0);
  const sentBodies = [];
  const countingFetch = async (url, init) => {
    // The body is captured only to prove the request shape; it is never
    // stored in the report or logged.
    try { sentBodies.push(JSON.parse(init.body)); } catch { sentBodies.push(null); }
    return fetchFn(url, init);
  };
  const protocol = new ChatCompletionsProtocol({
    apiKey: env.CLOUDFLARE_API_TOKEN, endpoint, fetchFn: countingFetch, timeoutMs, omitEmptyTools: true,
  });

  const remainingRequests = () => cap - report.requestsSent;
  const recordTokens = (usage) => { report.totalTokens += usage.inputTokens + usage.outputTokens; };

  for (const model of plan.selected) {
    // --- no-tool check: the PR #123 regression -------------------------
    if (remainingRequests() < 1) { report.results.push({ model, check: 'no-tool', ok: false, skipped: 'REQUEST_CAP' }); report.stoppedBecause = 'REQUEST_CAP'; break; }
    if (tokenCap && report.totalTokens >= tokenCap) { report.results.push({ model, check: 'no-tool', ok: false, skipped: 'TOKEN_CAP' }); report.stoppedBecause = 'TOKEN_CAP'; break; }
    {
      const started = now();
      report.requestsSent += 1;
      const index = sentBodies.length;
      try {
        const result = await protocol.turn({
          provider: 'cloudflare', model, system: SYSTEM,
          messages: [text(NO_TOOL_PROMPT)], tools: [], maxOutputTokens: plan.caps.maxOutputTokens,
        });
        const usage = usageOf(result);
        recordTokens(usage);
        const body = sentBodies[index] || {};
        const answer = replyText(result);
        report.results.push({
          model, check: 'no-tool', ok: Boolean(answer) && !('tools' in body) && !('tool_choice' in body),
          durationMs: now() - started, usage,
          toolFieldsOmitted: !('tools' in body) && !('tool_choice' in body),
          answered: Boolean(answer),
          expectedTokenMatched: /CLOUDFLARE-OK/i.test(answer),
          servedModel: result.model || null,
          rateLimitReported: Boolean(result.rateLimit),
        });
      } catch (error) {
        report.results.push({ model, check: 'no-tool', ok: false, durationMs: now() - started, ...sanitizeError(error) });
      }
      log(JSON.stringify(report.results.at(-1)));
    }

    // --- tool-calling round trip ---------------------------------------
    if (remainingRequests() < 2) {
      report.results.push({ model, check: 'tool-calling', ok: false, skipped: remainingRequests() ? 'REQUEST_CAP_PARTIAL' : 'REQUEST_CAP' });
      report.stoppedBecause = 'REQUEST_CAP';
      break;
    }
    if (tokenCap && report.totalTokens >= tokenCap) {
      report.results.push({ model, check: 'tool-calling', ok: false, skipped: 'TOKEN_CAP' });
      report.stoppedBecause = 'TOKEN_CAP';
      break;
    }
    {
      const started = now();
      let calls = 0;
      try {
        report.requestsSent += 1; calls += 1;
        const first = await protocol.turn({
          provider: 'cloudflare', model, system: SYSTEM,
          messages: [text(TOOL_PROMPT)], tools: [TOOL], maxOutputTokens: plan.caps.maxOutputTokens,
        });
        const firstUsage = usageOf(first);
        recordTokens(firstUsage);
        const call = (first.message?.content || []).find((block) => block.type === 'tool_call' && block.name === TOOL.name);
        if (!call) {
          report.results.push({
            model, check: 'tool-calling', ok: false, durationMs: now() - started, usage: firstUsage,
            toolCalled: false, failure: 'MODEL_DID_NOT_CALL_TOOL',
          });
        } else {
          report.requestsSent += 1; calls += 1;
          const second = await protocol.turn({
            provider: 'cloudflare', model, system: SYSTEM, tools: [TOOL],
            messages: [
              text(TOOL_PROMPT),
              first.message,
              { role: 'user', content: [toolResult(call, String(Number(call.arguments?.a) + Number(call.arguments?.b)))] },
            ],
            maxOutputTokens: plan.caps.maxOutputTokens,
          });
          const secondUsage = usageOf(second);
          recordTokens(secondUsage);
          const answer = replyText(second);
          report.results.push({
            model, check: 'tool-calling', ok: Boolean(call) && /^\s*42\s*$/.test(answer),
            durationMs: now() - started, toolCalled: Boolean(call), toolName: call.name,
            answeredNumber: /^\s*42\s*$/.test(answer),
            usage: { inputTokens: firstUsage.inputTokens + secondUsage.inputTokens, outputTokens: firstUsage.outputTokens + secondUsage.outputTokens },
            calls,
          });
        }
      } catch (error) {
        report.results.push({ model, check: 'tool-calling', ok: false, durationMs: now() - started, calls, ...sanitizeError(error) });
      }
      log(JSON.stringify(report.results.at(-1)));
    }
  }

  report.finishedAt = new Date(now()).toISOString();
  report.ok = report.results.length > 0 && report.results.every((entry) => entry.ok);
  if (!report.stoppedBecause) {
    if (report.requestsSent >= cap && report.results.some((entry) => entry.skipped)) report.stoppedBecause = 'REQUEST_CAP';
    else if (report.results.some((entry) => entry.skipped === 'TOKEN_CAP')) report.stoppedBecause = 'TOKEN_CAP';
  }
  report.usage = { totalTokens: report.totalTokens, costUsd: 0, billingClass: 'free', basis: 'measured token counts reported by the provider; no cost is charged on the Workers Free plan' };
  return report;
}

function argValue(args, name) {
  const prefix = `${name}=`;
  const match = args.find((value) => value === name || value.startsWith(prefix));
  if (!match) return null;
  if (match === name) return '';
  return match.slice(prefix.length);
}

async function main() {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const models = argValue(args, '--models')?.split(',').map((value) => value.trim()).filter(Boolean) || null;
  const maxRequests = argValue(args, '--max-requests');
  const report = await runCloudflareCanary({
    live,
    models,
    ...(maxRequests != null && maxRequests !== '' ? { maxRequests: Number(maxRequests) } : {}),
  });
  console.log(JSON.stringify(report, null, 2));
  // A dry run is always a success: it made no claim about the provider.
  process.exitCode = live ? (report.ok ? 0 : 1) : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: String(error?.code || error?.message || 'CANARY_FAILED').slice(0, 120) }));
    process.exitCode = 1;
  });
}
