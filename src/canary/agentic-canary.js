// Live agentic canary. Uses REAL provider APIs with synthetic, non-private
// data. It never prints prompts, responses beyond the checked result, or
// credentials.
//
//   1. Tool-calling round trip on every routable model route: the model must
//      call add_numbers(17, 25) and then report 42.
//   2. Failover drill between the first two verified routes: route A performs
//      the first real step, then ONE failure is INJECTED (labelled as such)
//      before A's next call. The gateway checkpoints and route B receives only
//      the durable continuation and must finish the same task (84).
//
// Usage (inside the runtime or coding-worker container):
//   node src/canary/agentic-canary.js [--record]
// --record writes verified_at / outcomes to provider_status (needs Supabase).

import { createModelPool } from '../model-gateway/agentic/model-pool.js';
import { AgentTurnGateway } from '../model-gateway/agentic/turn-gateway.js';
import { MemoryProviderStateStore, SupabaseProviderStateStore } from '../model-gateway/agentic/provider-state.js';
import { toolResult, userText } from '../model-gateway/agentic/conversation.js';
import { continuationMessage } from '../coding-agent/prompts.js';

const TOOLS = [
  { name: 'add_numbers', description: 'Add two integers and return the sum.', inputSchema: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] } },
  { name: 'multiply_numbers', description: 'Multiply two integers and return the product.', inputSchema: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] } },
];
const SYSTEM = 'You are a precise calculator agent. Always use the provided tools for arithmetic. After the final tool result, reply with only the number.';

function runTool(call) {
  const a = Number(call.arguments?.a);
  const b = Number(call.arguments?.b);
  if (call.name === 'add_numbers') return String(a + b);
  if (call.name === 'multiply_numbers') return String(a * b);
  return 'unknown tool';
}

const addUsage = (total, usage) => {
  if (!usage) return total;
  total.inputTokens += usage.inputTokens || 0;
  total.outputTokens += usage.outputTokens || 0;
  total.cachedInputTokens += usage.cachedInputTokens || 0;
  total.costUsd = Number((total.costUsd + (usage.costUsd || 0)).toFixed(8));
  return total;
};
const emptyUsage = () => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 });

async function converse(gateway, messages, { preferredRouteId = null, maxTurns = 4, hooks = {}, prepare = null, trace = null } = {}) {
  let route = null;
  const usage = emptyUsage();
  let rateLimit = null;
  let servedModel = null;
  for (let turn = 0; turn < maxTurns; turn += 1) {
    let prepared = messages;
    const result = await gateway.turn({
      tools: TOOLS, preferredRouteId: route?.id || preferredRouteId, maxOutputTokens: 2000,
      routing: { requiresPrivateData: false, estimatedInputTokens: 2000, minQualityTier: 1 },
      prepare: async (candidate, info) => {
        prepared = prepare ? (await prepare(candidate, info, messages)).messages : messages;
        return { system: SYSTEM, messages: prepared };
      },
      hooks,
    });
    route = result.route;
    addUsage(usage, result.usage);
    rateLimit = result.rateLimit || rateLimit;
    servedModel = result.model || servedModel;
    // After a handoff the new model's transcript starts from the continuation.
    if (prepared !== messages) messages.splice(0, messages.length, ...prepared);
    messages.push(result.message);
    const calls = result.message.content.filter((block) => block.type === 'tool_call');
    trace?.push({ route: route.id, toolCalls: calls.map((call) => call.name), switched: result.switched });
    if (!calls.length) {
      const text = result.message.content.filter((block) => block.type === 'text').map((block) => block.text).join(' ');
      return { route, text, messages, usage, rateLimit, servedModel };
    }
    messages.push({ role: 'user', content: calls.map((call) => toolResult(call, runTool(call))) });
  }
  return { route, text: '', messages, usage, rateLimit, servedModel };
}

// Configuration status of every pool route, without secret values: whether
// the credential variable is present is reported as a boolean only.
export function poolStatus(pool) {
  return pool.map((route) => ({
    id: route.id, provider: route.provider, model: route.model, protocol: route.protocol,
    billingClass: route.billingClass, toolCalling: route.toolCalling, privacyApproved: route.privacyApproved,
    credentialPresent: !route.unavailableReasons.includes('CREDENTIAL_MISSING'),
    status: !route.unavailableReasons.length ? 'CONFIGURED'
      : route.unavailableReasons.includes('CREDENTIAL_MISSING') ? 'NOT CONFIGURED' : 'NOT READY',
    unavailableReasons: [...route.unavailableReasons],
  }));
}

// Picks the drill pair: the cheapest verified route as primary and the
// cheapest verified route of a DIFFERENT provider as backup, so the drill
// proves cross-provider continuation whenever two providers work.
export function failoverPair(verified) {
  const byCost = verified.toSorted((left, right) => left.costTier - right.costTier || right.qualityTier - left.qualityTier);
  const primary = byCost[0];
  if (!primary) return null;
  const backup = byCost.find((route) => route.provider !== primary.provider) || byCost[1];
  return backup ? { primary, backup, crossProvider: backup.provider !== primary.provider } : null;
}

const memoryCheckpoints = () => {
  let saved = null;
  return { save: async (checkpoint) => { saved = structuredClone(checkpoint); }, load: async () => structuredClone(saved) };
};

export async function runAgenticCanary({
  env = process.env, stateStore = new MemoryProviderStateStore(), log = console.log,
  // Canary prompts are trivial; low effort keeps the reasoning spend minimal.
  pool = createModelPool({ env: { ...env, CODING_ANTHROPIC_EFFORT: env.CANARY_ANTHROPIC_EFFORT || 'low' } }),
  checkpointStore = memoryCheckpoints(),
} = {}) {
  const routable = pool.filter((route) => !route.unavailableReasons.length);
  const report = { startedAt: new Date().toISOString(), kind: 'REAL provider calls; failover drill uses ONE injected routing failure', pool: poolStatus(pool), routes: [], failover: null };
  for (const route of routable) {
    const gateway = new AgentTurnGateway({ pool: [route], stateStore, minQualityTier: 1 });
    const startedAt = Date.now();
    try {
      const { text, messages, usage, rateLimit, servedModel } = await converse(gateway, [userText('Use add_numbers to add 17 and 25. Reply with only the result.')]);
      const usedTool = messages.some((message) => message.content.some((block) => block.type === 'tool_call' && block.name === 'add_numbers'));
      const ok = usedTool && /\b42\b/.test(text);
      report.routes.push({ id: route.id, ok, usedTool, answer: text.trim().slice(0, 40), servedModel, durationMs: Date.now() - startedAt, usage, rateLimit });
    } catch (error) {
      report.routes.push({
        id: route.id, ok: false, error: error.code || 'PROVIDER_ERROR', status: error.status || error.cause?.status || null,
        failureClass: error.cause?.failureClass || error.failureClass || null,
        attempts: (error.attempts || []).map((attempt) => ({ code: attempt.error?.code || null, status: attempt.error?.status || null, failureClass: attempt.error?.failureClass || null })),
        durationMs: Date.now() - startedAt,
      });
    }
    log(JSON.stringify(report.routes.at(-1)));
  }

  const verified = report.routes.filter((entry) => entry.ok).map((entry) => pool.find((route) => route.id === entry.id));
  const pair = failoverPair(verified);
  if (pair) {
    const { primary, backup, crossProvider } = pair;
    let primaryCalls = 0;
    const injectedAttempts = new Set();
    const injectedPrimary = {
      ...primary,
      protocolClient: {
        async turn(input) {
          primaryCalls += 1;
          if (primaryCalls === 2) {
            injectedAttempts.add(input.clientRequestId);
            throw Object.assign(new Error('INJECTED_FAILURE: simulated rate limit for the failover drill'), { status: 429, type: 'rate_limit_error', retryAfter: '600', injected: true });
          }
          return primary.protocolClient.turn(input);
        },
      },
    };
    // The drill's health store is separate so the injected failure never puts
    // a real provider into cooldown.
    const gateway = new AgentTurnGateway({ pool: [injectedPrimary, backup], stateStore: new MemoryProviderStateStore(), minQualityTier: 1 });
    const attempts = [];
    const trace = [];
    const session = { objective: 'Add 17 and 25 with add_numbers, then multiply that sum by 2 with multiply_numbers. Reply with only the final number.', phase: 'implement', iteration: 1 };
    let liveMessages = [];
    let restored = null;
    const onSwitch = async (change) => {
      // Durable checkpoint BEFORE the next provider is called.
      const sum = liveMessages.flatMap((message) => message.content).find((block) => block.type === 'tool_result' && block.name === 'add_numbers')?.content;
      await checkpointStore.save({
        sequence: 1, at: new Date().toISOString(), from: change.from, to: change.to, reason: change.reason,
        objective: session.objective, phase: session.phase,
        plan: [{ title: 'Add 17 and 25', status: sum ? 'done' : 'pending' }, { title: 'Multiply the sum by 2', status: 'pending' }],
        notes: sum ? [`add_numbers(17, 25) already returned ${sum}.`] : [],
        nextAction: 'Multiply the previous sum by 2 with multiply_numbers',
        recentMessages: liveMessages.slice(-4),
      });
    };
    const prepare = async (candidate, info, messages) => {
      liveMessages = messages;
      if (!info.switching) return { messages };
      // The backup is prompted ONLY from the checkpoint read back from storage.
      restored = await checkpointStore.load();
      if (!restored) throw Object.assign(new Error('checkpoint missing'), { code: 'CHECKPOINT_NOT_PERSISTED' });
      return { messages: [userText(continuationMessage({
        session: { ...session, objective: restored.objective, phase: restored.phase }, state: { notes: restored.notes, filesChanged: [], git: {} },
        plan: restored.plan, nextAction: restored.nextAction, recentMessages: restored.recentMessages,
        reason: 'failover drill', fromRoute: restored.from, toRoute: candidate.id,
      }))] };
    };
    const startedAt = Date.now();
    try {
      const { route, text, messages, usage } = await converse(gateway, [userText(session.objective)], {
        preferredRouteId: primary.id, maxTurns: 5, prepare, trace,
        hooks: {
          onSwitch,
          onAttempt: async (record) => {
            if (record.status === 'started') return;
            attempts.push({ route: record.route.id, status: record.status, injected: injectedAttempts.has(record.id), code: record.error?.code || null });
          },
        },
      });
      const toolCallsAfterSwitch = messages.flatMap((message) => message.content).filter((block) => block.type === 'tool_call').map((block) => block.name);
      const redidAddition = toolCallsAfterSwitch.includes('add_numbers');
      const backupUsedMultiply = toolCallsAfterSwitch.includes('multiply_numbers');
      report.failover = {
        primary: primary.id, backup: backup.id, crossProvider, injectedFailureOnPrimaryCall: 2,
        checkpointPersisted: Boolean(restored), checkpointRestoredFrom: checkpointStore.location || 'memory',
        primaryCompletedStepBeforeSwitch: Boolean(restored?.notes?.length),
        finishedOn: route.id, answer: text.trim().slice(0, 40), attempts, trace,
        backupRedidCompletedStep: redidAddition, usage, durationMs: Date.now() - startedAt,
        ok: route.id === backup.id && /\b84\b/.test(text) && backupUsedMultiply && Boolean(restored) && !redidAddition,
      };
    } catch (error) {
      report.failover = { primary: primary.id, backup: backup.id, crossProvider, ok: false, error: error.code || 'FAILOVER_DRILL_FAILED', attempts, trace };
    }
    log(JSON.stringify({ failover: report.failover }));
  } else {
    report.failover = { ok: false, skipped: `needs two verified routes; have ${verified.length}` };
  }
  report.totalCostUsd = Number((report.routes.reduce((sum, entry) => sum + (entry.usage?.costUsd || 0), 0) + (report.failover?.usage?.costUsd || 0)).toFixed(8));
  report.finishedAt = new Date().toISOString();
  return report;
}

async function main() {
  const record = process.argv.includes('--record');
  let stateStore = new MemoryProviderStateStore();
  let db = null;
  if (record) {
    const { createClient } = await import('@supabase/supabase-js');
    db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    stateStore = new SupabaseProviderStateStore(db);
  }
  const report = await runAgenticCanary({ stateStore });
  if (db) {
    for (const entry of report.routes.filter((route) => route.ok)) {
      const [provider, ...model] = entry.id.split(':');
      await db.from('provider_status').update({ verified_at: new Date().toISOString() }).eq('provider', provider).eq('model', model.join(':'));
    }
  }
  console.log(JSON.stringify({ summary: { verified: report.routes.filter((route) => route.ok).map((route) => route.id), failover: report.failover } }));
  process.exitCode = report.routes.some((route) => route.ok) ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.code || 'CANARY_FAILED', message: String(error.message || '').slice(0, 200) }));
    process.exitCode = 1;
  });
}
