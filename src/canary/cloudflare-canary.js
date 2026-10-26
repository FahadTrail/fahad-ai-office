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
//   * Live execution only with an explicit --live flag AND a stated free plan
//     (CLOUDFLARE_PLAN=free). A Paid plan bills neuron overage, so an unstated
//     or paid plan refuses to run (fail closed). The plan is the OWNER's
//     DECLARATION: the inference API does not report it, so a live run is
//     never evidence that the account is really on the Workers Free plan.
//   * Explicit allowlist: only ids in CLOUDFLARE_CANARY_MODELS (or the
//     documented defaults) can be probed; anything else is refused and
//     reported, never silently dropped.
//   * No database writes, no provider_status updates, no budget reservations.
//     The report is printed to stdout only.
//   * Hard caps: total requests, output tokens per request and total tokens.
//     The run stops at the first check that does not fit, says where it
//     stopped and reports the resulting coverage (complete, partial, unprobed)
//     so a truncated run is never mistaken for a full one.
//   * Separate checks: a no-tool call (which must omit the tool fields — the
//     PR #123 regression — and answer the expected token EXACTLY) and a real
//     tool-calling round trip.
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

// A full round trip per model is THREE requests: one no-tool call, then a
// tool-calling call and the answer that returns its result. The request cap
// therefore admits the documented three models (3 × 3 = 9) together; a lower
// cap is still honoured and reported as partial coverage.
export const REQUESTS_PER_MODEL = 3;
// Two reportable checks per model (the tool round trip sends two requests).
export const CHECKS_PER_MODEL = 2;

const TWO_CHECKS = Object.freeze([
  { check: 'no-tool', requests: 1 },
  { check: 'tool-calling', requests: 2 },
]);

export const CLOUDFLARE_CANARY_LIMITS = Object.freeze({
  maxRequests: 9,
  maxOutputTokens: 256,
  maxTotalTokens: 6_000,
  timeoutMs: 60_000,
});

// Synthetic, non-private prompts. They ask for public arithmetic and a fixed
// token; nothing from a repository or a customer ever enters this command.
const SYSTEM = 'You are a precise test agent. Follow the instruction exactly.';
// The one answer that proves instruction following. A PASS requires this token
// as the whole answer; merely non-empty text proves nothing.
export const NO_TOOL_EXPECTED = 'CLOUDFLARE-OK';
const NO_TOOL_PROMPT = `Reply with exactly this token and nothing else: ${NO_TOOL_EXPECTED}`;
const TOOL_PROMPT = 'Use the add_numbers tool to add 17 and 25, then reply with only the resulting number.';
const TOOL = Object.freeze({
  name: 'add_numbers',
  description: 'Add two integers and return the sum.',
  inputSchema: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] },
});

const text = (value) => ({ role: 'user', content: [{ type: 'text', text: value }] });
const replyText = (result) => (result?.message?.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('').trim();

// EXACT match, not a substring: "Sure — CLOUDFLARE-OK" and a longer sentence
// fail, because an instruction-following failure must not hide behind
// non-empty text. Case, wrapping quotes/markdown and trailing punctuation are
// tolerated (they are formatting, not extra content).
export function matchesExpectedToken(answer) {
  const normalized = String(answer ?? '')
    .replace(/^[\s"'`*_~]+/, '')
    .replace(/[\s"'`*_~.]+$/, '')
    .toUpperCase();
  return normalized === NO_TOOL_EXPECTED;
}

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
    // Honesty: the plan is a setting the owner stated. Cloudflare's inference
    // API does not report it, so it is never "verified billing evidence".
    planSource: 'CLOUDFLARE_PLAN',
    planBasis: 'owner-declared',
    planVerified: false,
    planNote: 'The Workers plan is not reported by the inference API: this is the owner\'s declaration, not independent evidence of the account\'s billing.',
    blockers,
    liveAllowed: blockers.length === 0,
  };
}

// The dry-run plan: the exact checks and the caps, with no request sent.
// Planning and execution share one stopping rule (stop at the first check that
// does not fit the request budget), so the dry run predicts the real coverage.
export function cloudflareCanaryPlan({ env = {}, models = null, maxRequests = CLOUDFLARE_CANARY_LIMITS.maxRequests, maxOutputTokens = CLOUDFLARE_CANARY_LIMITS.maxOutputTokens } = {}) {
  const preflight = canaryPreflight({ env });
  const { allowlist, selected, refused } = canarySelection({ env, models });
  const budget = Math.max(0, Math.floor(Number(maxRequests) || 0));
  const checks = [];
  let planned = 0;
  let stopped = false;
  for (const model of selected) {
    for (const entry of TWO_CHECKS) {
      const fits = !stopped && planned + entry.requests <= budget;
      if (fits) planned += entry.requests;
      else stopped = true;
      checks.push({
        model, check: entry.check, requests: entry.requests, planned: fits,
        expects: entry.check === 'no-tool'
          ? `exactly the token ${NO_TOOL_EXPECTED} and NO tools / tool_choice field in the request body`
          : 'an add_numbers call, then only the number 42 from its result',
        ...(fits ? {} : { reason: 'REQUEST_CAP' }),
      });
    }
  }
  const coverage = planCoverage({ selected, checks, planned, budget });
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
      requestsRequired: selected.length * REQUESTS_PER_MODEL,
      requestsPerModel: REQUESTS_PER_MODEL,
      maxOutputTokens: Math.max(1, Number(maxOutputTokens) || CLOUDFLARE_CANARY_LIMITS.maxOutputTokens),
      maxTotalTokens: CLOUDFLARE_CANARY_LIMITS.maxTotalTokens,
      timeoutMs: CLOUDFLARE_CANARY_LIMITS.timeoutMs,
      providers: ['cloudflare'],
      allowPaid: false,
      databaseWrites: false,
    },
    dailyAllowance: { ...FREE_ALLOWANCES_FOR_CANARY.cloudflare },
    checks,
    coverage,
    note: coverage.fullCoverage
      ? 'Dry run: nothing was sent. The cap admits a full round trip for every selected model. Add --live to execute with the caps above.'
      : `Dry run: nothing was sent. ${coverage.note} Raise --max-requests to ${coverage.requestsRequired} for full coverage.`,
  };
}

// Which models a run really covers. Partial coverage is a reported fact, never
// silently rounded up to "all models passed".
function planCoverage({ selected, checks, planned, budget, requestCap = budget }) {
  const completeModels = [];
  const partialModels = [];
  const unprobedModels = [];
  for (const model of selected) {
    const own = checks.filter((entry) => entry.model === model);
    const covered = own.filter((entry) => entry.planned).length;
    if (covered === 0) unprobedModels.push(model);
    else if (covered === own.length) completeModels.push(model);
    else partialModels.push({ model, reason: 'REQUEST_CAP', coveredChecks: covered, requiredChecks: own.length });
  }
  const required = selected.length * REQUESTS_PER_MODEL;
  const fullCoverage = selected.length > 0 && completeModels.length === selected.length && planned === required;
  return {
    modelsSelected: selected.length,
    requestsRequired: required,
    requestsPlanned: planned,
    requestCap,
    fullCoverage,
    completeModels,
    partialModels,
    unprobedModels,
    note: fullCoverage
      ? 'full coverage: every selected model gets its no-tool call and its tool round trip'
      : selected.length === 0
        ? 'no model selected: nothing to probe'
        : `PARTIAL COVERAGE: ${completeModels.length} of ${selected.length} selected models fully checked`
          + `${partialModels.length ? `, ${partialModels.length} partly checked` : ''}`
          + `${unprobedModels.length ? `, ${unprobedModels.length} not probed` : ''}`
          + ` (request cap ${requestCap} of ${required} required)`,
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
    note: 'Live run: the planned checks executed with the caps above.',
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
        const toolFieldsOmitted = !('tools' in body) && !('tool_choice' in body);
        // The expected token is the whole answer: non-empty text alone is not
        // a pass, because it hides a model that ignored the instruction.
        const expected = matchesExpectedToken(answer);
        const failure = !toolFieldsOmitted ? 'TOOL_FIELDS_PRESENT' : expected ? null : (answer ? 'EXPECTED_TOKEN_MISMATCH' : 'EMPTY_RESPONSE');
        report.results.push({
          model, check: 'no-tool', ok: toolFieldsOmitted && expected,
          durationMs: now() - started, usage,
          toolFieldsOmitted,
          answered: Boolean(answer),
          expectedTokenMatched: expected,
          ...(failure ? { failure } : {}),
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
  // Actual coverage, from what really ran: a capped run says which models were
  // fully checked, partly checked or never probed.
  report.coverage = executedCoverage(plan, report.results, cap);
  if (!report.coverage.fullCoverage) {
    report.partialCoverage = true;
    report.note = `${report.coverage.note}. `
      + `Raise --max-requests to ${report.coverage.requestsRequired} for full coverage of ${plan.selected.length} model(s).`;
  }
  report.usage = { totalTokens: report.totalTokens, costUsd: 0, billingClass: 'free', basis: 'measured token counts reported by the provider; no cost is charged on the Workers Free plan' };
  return report;
}

// Coverage of an executed run. A model counts as complete only when both of
// its checks ran and neither was skipped.
function executedCoverage(plan, results, requestCap) {
  const completeModels = [];
  const partialModels = [];
  const unprobedModels = [];
  for (const model of plan.selected) {
    const own = results.filter((entry) => entry.model === model);
    const ran = own.filter((entry) => !entry.skipped);
    if (!ran.length) unprobedModels.push(model);
    else if (ran.length === CHECKS_PER_MODEL) completeModels.push(model);
    else partialModels.push({
      model,
      reason: own.find((entry) => entry.skipped)?.skipped || 'INCOMPLETE',
      coveredChecks: ran.length,
      requiredChecks: CHECKS_PER_MODEL,
    });
  }
  const required = plan.selected.length * REQUESTS_PER_MODEL;
  const fullCoverage = plan.selected.length > 0 && completeModels.length === plan.selected.length;
  return {
    modelsSelected: plan.selected.length,
    requestsRequired: required,
    requestsPlanned: plan.caps.plannedRequests,
    requestsSent: results.filter((entry) => !entry.skipped).length,
    requestCap,
    fullCoverage,
    completeModels,
    partialModels,
    unprobedModels,
    note: fullCoverage
      ? 'full coverage: every selected model ran its no-tool call and its tool round trip'
      : `PARTIAL COVERAGE: ${completeModels.length} of ${plan.selected.length} selected models fully checked`
        + `${partialModels.length ? `, ${partialModels.length} partly checked` : ''}`
        + `${unprobedModels.length ? `, ${unprobedModels.length} not probed` : ''}`,
  };
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
  const requestedCap = Number(maxRequests);
  const report = await runCloudflareCanary({
    live,
    models,
    ...(maxRequests != null && maxRequests !== '' && Number.isFinite(requestedCap) ? { maxRequests: requestedCap } : {}),
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
