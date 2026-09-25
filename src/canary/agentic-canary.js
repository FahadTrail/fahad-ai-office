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

async function converse(gateway, messages, { preferredRouteId = null, maxTurns = 4, hooks = {}, prepare = null } = {}) {
  let route = null;
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
    // After a handoff the new model's transcript starts from the continuation.
    if (prepared !== messages) messages.splice(0, messages.length, ...prepared);
    messages.push(result.message);
    const calls = result.message.content.filter((block) => block.type === 'tool_call');
    if (!calls.length) {
      const text = result.message.content.filter((block) => block.type === 'text').map((block) => block.text).join(' ');
      return { route, text, messages };
    }
    messages.push({ role: 'user', content: calls.map((call) => toolResult(call, runTool(call))) });
  }
  return { route, text: '', messages };
}

export async function runAgenticCanary({ env = process.env, stateStore = new MemoryProviderStateStore(), log = console.log, pool = createModelPool({ env }) } = {}) {
  const routable = pool.filter((route) => !route.unavailableReasons.length);
  const report = { startedAt: new Date().toISOString(), routes: [], failover: null };
  for (const route of routable) {
    const gateway = new AgentTurnGateway({ pool: [route], stateStore, minQualityTier: 1 });
    const startedAt = Date.now();
    try {
      const { text, messages } = await converse(gateway, [userText('Use add_numbers to add 17 and 25. Reply with only the result.')]);
      const usedTool = messages.some((message) => message.content.some((block) => block.type === 'tool_call' && block.name === 'add_numbers'));
      const ok = usedTool && /\b42\b/.test(text);
      report.routes.push({ id: route.id, ok, usedTool, answer: text.trim().slice(0, 40), durationMs: Date.now() - startedAt });
    } catch (error) {
      report.routes.push({ id: route.id, ok: false, error: error.code || 'PROVIDER_ERROR', status: error.status || error.cause?.status || null, durationMs: Date.now() - startedAt });
    }
    log(JSON.stringify(report.routes.at(-1)));
  }

  const verified = report.routes.filter((entry) => entry.ok).map((entry) => pool.find((route) => route.id === entry.id));
  if (verified.length >= 2) {
    const [primary, backup] = verified;
    let primaryCalls = 0;
    const injectedPrimary = {
      ...primary,
      protocolClient: {
        async turn(input) {
          primaryCalls += 1;
          if (primaryCalls === 2) {
            throw Object.assign(new Error('INJECTED_FAILURE: simulated rate limit for the failover drill'), { status: 429, type: 'rate_limit_error', retryAfter: '600', injected: true });
          }
          return primary.protocolClient.turn(input);
        },
      },
    };
    const drillStore = new MemoryProviderStateStore();
    const gateway = new AgentTurnGateway({ pool: [injectedPrimary, backup], stateStore: drillStore, minQualityTier: 1 });
    const checkpoints = [];
    const state = { notes: [], filesChanged: [], git: {} };
    const session = { objective: 'Add 17 and 25 with add_numbers, then multiply that sum by 2 with multiply_numbers. Reply with only the final number.', phase: 'implement', iteration: 1 };
    const prepare = async (candidate, info, messages) => {
      if (!info.switching) return { system: SYSTEM, messages };
      const sum = messages.flatMap((message) => message.content).find((block) => block.type === 'tool_result' && block.name === 'add_numbers')?.content;
      state.notes = sum ? [`add_numbers(17, 25) already returned ${sum}.`] : [];
      return { system: SYSTEM, messages: [userText(continuationMessage({
        session, state, plan: [{ title: 'Add 17 and 25', status: sum ? 'done' : 'pending' }, { title: 'Multiply the sum by 2', status: 'pending' }],
        nextAction: 'Multiply the previous sum by 2 with multiply_numbers', recentMessages: messages.slice(-4), reason: 'failover drill', fromRoute: primary.id, toRoute: candidate.id,
      }))] };
    };
    const startedAt = Date.now();
    try {
      const { route, text, messages } = await converse(gateway, [userText(session.objective)], {
        preferredRouteId: primary.id, maxTurns: 5, prepare,
        hooks: { onSwitch: async (change) => { checkpoints.push({ ...change, state: structuredClone(state), at: new Date().toISOString() }); } },
      });
      const backupUsedMultiply = messages.some((message) => message.content.some((block) => block.type === 'tool_call' && block.name === 'multiply_numbers'));
      const redidAddition = messages.some((message) => message.content.some((block) => block.type === 'tool_call' && block.name === 'add_numbers'));
      report.failover = {
        primary: primary.id, backup: backup.id, injectedFailureOnPrimaryCall: 2, checkpointsBeforeSwitch: checkpoints.length,
        finishedOn: route.id, answer: text.trim().slice(0, 40), ok: route.id === backup.id && /\b84\b/.test(text) && backupUsedMultiply && checkpoints.length === 1,
        backupRedidCompletedStep: redidAddition, durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      report.failover = { primary: primary.id, backup: backup.id, ok: false, error: error.code || 'FAILOVER_DRILL_FAILED' };
    }
    log(JSON.stringify({ failover: report.failover }));
  } else {
    report.failover = { ok: false, skipped: `needs two verified routes; have ${verified.length}` };
  }
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
