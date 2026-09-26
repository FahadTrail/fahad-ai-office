// Office model execution on the SHARED Model Pool. Office agents ask for a
// job type (research, content, orchestration, …); the same AgentTurnGateway
// that runs the Coding Agent chooses the provider/model: capability, privacy,
// authorization, health/cooldown, context and budget first, then
// free → included → promo → paid.
//
// Continuity: a provider switch (rate limit, outage, injected drill) or an
// escalation (a model's output fails the stage's validation, is empty or
// truncated) is checkpointed first; the next model receives the original task
// plus the work already completed (tool calls and their results), so nothing
// is redone. Escalation excludes the insufficient model for this stage and
// lets the router pick the cheapest remaining suitable model; paid models are
// only reached under the workspace budget.

import { randomUUID } from 'node:crypto';
import { createModelPool, PRICING } from '../model-gateway/agentic/model-pool.js';
import { AgentTurnGateway, estimateTokens } from '../model-gateway/agentic/turn-gateway.js';
import { resolveRouting } from '../model-gateway/agentic/routing-policy.js';
import { userText, toolResult } from '../model-gateway/agentic/conversation.js';
import { authorizedRoutes } from '../workspace-policy/engine.js';
import { findSecretMaterial } from '../coding-agent/policy.js';
import { OFFICE_WEB_TOOLS, createOfficeToolExecutor } from './web-tools.js';

export const DATA_CLASS = Object.freeze({ GENERAL: 'general', CONFIDENTIAL: 'confidential' });

// Office data class. "general" business requests may use free providers
// whose API terms allow logging/training; anything marked confidential or
// containing credentials, card/bank numbers, e-mail addresses or phone numbers
// is only sent to providers approved for private data.
const CONFIDENTIAL_MARKER = /^\s*\[(confidential|private|سري)\]/i;
const SENSITIVE_PATTERNS = [
  /\b\d{13,19}\b/, // card-like numbers
  /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/, // IBAN
  /[\w.+-]+@[\w-]+\.[\w.]+/, // e-mail address
  /(?:\+|00)\d[\d\s-]{8,}\d/, // phone number
];
export function classifyOfficeData(text, { env = process.env } = {}) {
  const value = String(text || '');
  if (String(env.OFFICE_DEFAULT_DATA_CLASS || '').toLowerCase() === DATA_CLASS.CONFIDENTIAL) return { dataClass: DATA_CLASS.CONFIDENTIAL, reason: 'workspace default' };
  if (CONFIDENTIAL_MARKER.test(value)) return { dataClass: DATA_CLASS.CONFIDENTIAL, reason: 'marked confidential' };
  if (findSecretMaterial(value, {})) return { dataClass: DATA_CLASS.CONFIDENTIAL, reason: 'contains credential-shaped material' };
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(value))) return { dataClass: DATA_CLASS.CONFIDENTIAL, reason: 'contains personal or financial identifiers' };
  return { dataClass: DATA_CLASS.GENERAL, reason: 'no confidential marker or sensitive data detected' };
}

// The route Office used before it joined the pool; used only to estimate what
// a free-routed task would have cost there (published list price).
export const PREVIOUS_OFFICE_ROUTE = 'claude-sonnet-5';
export function paidEquivalentUsd(inputTokens, outputTokens, model = PREVIOUS_OFFICE_ROUTE) {
  const price = PRICING[model];
  if (!price) return null;
  return Number(((inputTokens * price.inputPerMillion + outputTokens * price.outputPerMillion) / 1_000_000).toFixed(6));
}

export class EscalationRequired extends Error {
  constructor(message, code = 'OUTPUT_FAILED_VALIDATION') {
    super(message);
    this.code = code;
  }
}

export class OfficeModelRunner {
  constructor({
    env = process.env,
    stateStore,
    policyStore = null,
    routingStore = null,
    poolFactory = (options) => createModelPool(options),
    fetchFn = fetch,
    toolExecutorFactory = createOfficeToolExecutor,
    sleepFn,
    now,
    maxEscalations = 3,
    qualificationStore = null,
  }) {
    if (!stateStore) throw new TypeError('A provider state store is required');
    Object.assign(this, { env, stateStore, policyStore, routingStore, poolFactory, fetchFn, toolExecutorFactory, sleepFn, now, maxEscalations, qualificationStore });
  }

  async run({
    job,
    systemPrompt,
    prompt,
    useWebTools = false,
    maxTurns = 8,
    maxOutputTokens = 4000,
    dataClass = DATA_CLASS.GENERAL,
    context = {},
    validate = null,
    hooks = {},
    beforeCall = null,
    onlyProvider = null,
  }) {
    const started = Date.now();
    const pool = this.poolFactory({ env: this.env, fetchFn: this.fetchFn });
    const workspaceId = context.workspaceId || null;
    const policy = workspaceId && this.policyStore ? await this.policyStore.getPolicy(workspaceId) : null;
    // Without a workspace boundary only free routes and the legacy Office
    // provider (Anthropic) are allowed, and paid ones only under a budget.
    let authorizedRouteIds = policy ? authorizedRoutes(pool, policy)
      : pool.filter((route) => route.billingClass !== 'paid' || route.provider === 'anthropic').map((route) => route.id);
    // An explicit provider request on the job narrows, never widens, access.
    if (onlyProvider) authorizedRouteIds = authorizedRouteIds.filter((id) => id.startsWith(`${onlyProvider}:`));
    const workspaceRouting = workspaceId && this.routingStore ? await this.routingStore.getRoutingPolicy(workspaceId).catch(() => null) : null;
    const routing = resolveRouting({ env: this.env, workspace: workspaceRouting });
    // Workspace jobs are bounded by the workspace budget. Legacy jobs without a
    // workspace keep their previous behaviour (Anthropic without a workspace
    // budget), now with free routes tried first.
    const remainingBudgetUsd = policy ? Math.max(0, Number(policy.budget.monthlyLimitUsd) - Number(policy.budget.spentUsd) - Number(policy.budget.reservedUsd)) : Infinity;
    const requiresPrivateData = dataClass !== DATA_CLASS.GENERAL;
    // Qualification evidence for free models (job gates + job-specific order).
    const qualifications = this.qualificationStore ? await this.qualificationStore.snapshot().catch(() => null) : null;
    const gateway = new AgentTurnGateway({
      pool, stateStore: this.stateStore, billingPriority: routing.billingPriority, strategy: routing.strategy,
      minQualityTier: Number(this.env.CODING_MIN_QUALITY_TIER || 4), ...(this.sleepFn ? { sleepFn: this.sleepFn } : {}), ...(this.now ? { now: this.now } : {}),
    });
    const searchRoute = pool.find((route) => route.provider === 'gemini');
    const executeTool = this.toolExecutorFactory({ env: this.env, fetchFn: this.fetchFn, allowSearch: !requiresPrivateData || Boolean(searchRoute?.privacyApproved) });
    const tools = useWebTools ? OFFICE_WEB_TOOLS : [];

    const completed = [];
    const path = [];
    const switches = [];
    const escalations = [];
    const excluded = [];
    const toolsUsed = [];
    const totals = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    let messages = [userText(prompt)];
    let currentRouteId = null;
    let checkpointSequence = 0;
    let lastEvaluation = null;

    const handoff = () => {
      if (!completed.length) return [userText(prompt)];
      const lines = completed.map((entry, index) => `${index + 1}. ${entry.name}(${JSON.stringify(entry.args)}) → ${entry.summary}`);
      return [userText(`${prompt}\n\nCHECKPOINT — work already completed on this task by a previous model. Do NOT repeat these tool calls; build on their results:\n${lines.join('\n')}`)];
    };
    const checkpoint = async (kind, detail) => {
      checkpointSequence += 1;
      const saved = {
        sequence: checkpointSequence, kind, job, at: new Date().toISOString(), ...detail,
        completedToolCalls: completed.map((entry) => ({ name: entry.name, args: entry.args })),
        tokensSoFar: { ...totals },
      };
      await (hooks.onCheckpoint || (async () => {}))(saved);
      return saved;
    };

    for (let turn = 0; turn < maxTurns + this.maxEscalations; turn += 1) {
      const lastTurn = turn >= maxTurns - 1;
      if (lastTurn && completed.length && !messages.some((message) => message.final)) {
        messages.push(Object.assign(userText('Tool budget reached: answer now from the evidence you have, without further tool calls.'), { final: true }));
      }
      const evaluationRouting = {
        requiresPrivateData, estimatedInputTokens: estimateTokens(systemPrompt, messages, tools), authorizedRouteIds,
        allowPaid: routing.allowPaid, billingPriority: routing.billingPriority, strategy: routing.strategy, job,
        policyExcludedRouteIds: [...routing.excludedRoutes, ...excluded], remainingBudgetUsd, qualifications,
        ...(routing.effort ? { effort: routing.effort } : {}),
      };
      let result;
      try {
        result = await gateway.turn({
          tools, preferredRouteId: currentRouteId, maxOutputTokens, routing: evaluationRouting,
          prepare: async (route, info) => {
            if (info.switching) messages = handoff();
            return { system: systemPrompt, messages };
          },
          hooks: {
            beforeCall: beforeCall || undefined,
            onSwitch: async (change) => {
              const reason = change.reason || {};
              const saved = await checkpoint('provider_switch', { fromRoute: change.from, toRoute: change.to, reason });
              switches.push({ from: change.from, to: change.to, code: reason.code || null, injected: Boolean(reason.injected), checkpoint: saved.sequence });
              await (hooks.onProviderSwitch || (async () => {}))({ fromProvider: change.from, toProvider: change.to, reason, checkpointSequence: saved.sequence, injected: Boolean(reason.injected) });
            },
            onAttempt: async (record) => {
              await (hooks.onAttempt || (async () => {}))(officeAttempt(record, context, job));
            },
            reserve: async ({ route, estimateUsd, attemptId }) => {
              if (!(estimateUsd > 0) || !policy || typeof this.policyStore.reserveBudget !== 'function') return null;
              const amountUsd = Math.min(Number(policy.budget.maxRequestUsd || estimateUsd), estimateUsd);
              const idempotencyKey = `office-turn:${context.runId || 'none'}:${attemptId}`;
              const reservation = await this.policyStore.reserveBudget({ workspaceId, idempotencyKey, amountUsd });
              return { ...reservation, idempotencyKey, route: route.id };
            },
            settle: async (reservation, actualUsd) => {
              if (!reservation) return;
              await this.policyStore.settleBudget({ workspaceId, reservationId: reservation.reservationId, idempotencyKey: reservation.idempotencyKey, actualUsd });
            },
            // A free route that was billed anyway: the real cost still lands
            // in the workspace ledger (never raising the budget).
            charge: async ({ amountUsd, attemptId }) => {
              await chargeUnreserved(this.policyStore, workspaceId, `office-incident:${context.runId || 'none'}:${attemptId}`, amountUsd);
            },
            onIncident: async (incident) => {
              await (hooks.onIncident || (async () => {}))({ routeId: incident.route.id, kind: incident.kind, costUsd: incident.costUsd, reportedModel: incident.reportedModel });
            },
          },
        });
      } catch (error) {
        lastEvaluation = error.evaluations || null;
        error.officeRouting = { job, dataClass, path, switches, escalations, evaluations: lastEvaluation };
        throw error;
      }
      const route = result.route;
      currentRouteId = route.id;
      totals.inputTokens += result.usage?.inputTokens || 0;
      totals.outputTokens += result.usage?.outputTokens || 0;
      totals.costUsd = Number((totals.costUsd + (result.usage?.costUsd || 0)).toFixed(8));
      const step = path.at(-1);
      if (step?.routeId === route.id) {
        step.turns += 1;
        step.inputTokens += result.usage?.inputTokens || 0;
        step.outputTokens += result.usage?.outputTokens || 0;
        step.costUsd = Number((step.costUsd + (result.usage?.costUsd || 0)).toFixed(8));
      } else {
        path.push({ routeId: route.id, provider: route.provider, model: route.model, servedModel: result.model || route.model, billingClass: route.billingClass,
          turns: 1, inputTokens: result.usage?.inputTokens || 0, outputTokens: result.usage?.outputTokens || 0, costUsd: result.usage?.costUsd || 0,
          qualification: qualification(route, job) });
      }
      messages.push(result.message);
      const calls = result.message.content.filter((block) => block.type === 'tool_call');
      if (calls.length && tools.length && !lastTurn) {
        const results = [];
        for (const call of calls) {
          const key = `${call.name}:${JSON.stringify(call.arguments || {})}`;
          const previous = completed.find((entry) => entry.key === key);
          const startedAt = Date.now();
          await (hooks.onActivity || (async () => {}))({ turns: turn + 1, hostTool: { name: call.name, status: 'started', id: call.id } });
          const outcome = previous ? { ok: true, result: previous.result, reused: true } : await executeTool(call);
          const content = JSON.stringify(outcome.result).slice(0, 16_000);
          results.push(toolResult(call, content, { isError: !outcome.ok }));
          if (!previous) {
            completed.push({ key, name: call.name, args: call.arguments || {}, result: outcome.result, summary: content.slice(0, 1500) });
            toolsUsed.push(call.name);
          }
          await (hooks.onActivity || (async () => {}))({ turns: turn + 1, hostTool: { name: call.name, status: outcome.ok ? 'completed' : 'failed', id: call.id, durationMs: Date.now() - startedAt } });
        }
        messages.push({ role: 'user', content: results });
        continue;
      }
      const text = result.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
      let failure = null;
      if (!text) failure = new EscalationRequired('The model returned no answer', result.stopReason === 'max_tokens' ? 'OUTPUT_TRUNCATED' : 'EMPTY_OUTPUT');
      else if (validate) {
        try {
          await validate(text);
        } catch (error) {
          failure = error instanceof EscalationRequired ? error : new EscalationRequired(String(error.message || 'Output failed validation').slice(0, 200));
        }
      }
      if (!failure) {
        const equivalent = paidEquivalentUsd(totals.inputTokens, totals.outputTokens);
        return {
          text, provider: route.provider, model: route.model, routeId: route.id, billingClass: route.billingClass, job, dataClass,
          tokensIn: totals.inputTokens, tokensOut: totals.outputTokens, costUsd: totals.costUsd, durationMs: Date.now() - started,
          path, switches, escalations, toolsUsed, checkpoints: checkpointSequence,
          savings: equivalent == null ? null : { basis: `ESTIMATE — same tokens at the ${PREVIOUS_OFFICE_ROUTE} published list price`, paidEquivalentUsd: equivalent, actualUsd: totals.costUsd, estimatedSavingUsd: Number(Math.max(0, equivalent - totals.costUsd).toFixed(6)) },
        };
      }
      // Escalation: this model cannot finish this stage. Keep the completed
      // work, exclude the model for this stage, let the router choose the
      // cheapest remaining suitable model.
      if (escalations.length >= this.maxEscalations) {
        throw Object.assign(new Error(`No model produced a valid ${job} result after ${escalations.length} escalations`), { code: 'OFFICE_ESCALATION_EXHAUSTED', officeRouting: { job, path, switches, escalations } });
      }
      excluded.push(route.id);
      const saved = await checkpoint('escalation', { fromRoute: route.id, reason: { code: failure.code } });
      escalations.push({ from: route.id, code: failure.code, checkpoint: saved.sequence });
      await (hooks.onEscalation || (async () => {}))({ fromRoute: route.id, reason: failure.code, checkpointSequence: saved.sequence });
      messages = handoff();
      currentRouteId = null;
    }
    throw Object.assign(new Error(`The ${job} stage did not finish within its turn budget`), { code: 'OFFICE_TURN_BUDGET_EXHAUSTED' });
  }
}

function qualification(route, job) {
  const capabilities = route.capabilities || {};
  return `${route.billingClass.toUpperCase()} · ${job} fit: coding ${capabilities.coding}, reasoning ${capabilities.reasoning}, research ${capabilities.research}, writing ${capabilities.writing}${route.toolCalling ? ', tools' : ''}, ${Math.round(route.contextWindow / 1000)}K context`;
}

// Maps a gateway attempt to the Office model_attempts record (db.js shape).
function officeAttempt(record, context, job) {
  const attemptNo = Math.max(1, record.attempt || 1);
  return {
    id: record.id || randomUUID(),
    context,
    attemptNo,
    providerAttempt: attemptNo,
    provider: record.route.provider,
    model: record.route.model,
    stage: context.stage || job,
    status: record.status,
    idempotencyKey: `${context.runId || 'office'}:${context.stage || job}:${record.route.id}:${record.id}`,
    clientRequestId: record.id,
    providerRequestId: record.requestId || null,
    route: [{ provider: record.route.provider, model: record.route.model, billingClass: record.route.billingClass, job }],
    usage: record.usage || {},
    durationMs: record.durationMs || 0,
    error: record.error || null,
    startedAt: record.startedAt || new Date().toISOString(),
    endedAt: record.status === 'started' ? null : new Date().toISOString(),
  };
}

// Charges an unexpected cost that had no reservation: a minimal reservation
// is opened and settled at the real amount (settlement records the actual
// cost even when it exceeds the reservation).
export async function chargeUnreserved(policyStore, workspaceId, idempotencyKey, amountUsd) {
  if (!(amountUsd > 0) || !workspaceId || typeof policyStore?.reserveBudget !== 'function') return false;
  try {
    const reservation = await policyStore.reserveBudget({ workspaceId, idempotencyKey, amountUsd: 0.000001 });
    await policyStore.settleBudget({ workspaceId, reservationId: reservation.reservationId, idempotencyKey, actualUsd: amountUsd });
    return true;
  } catch {
    return false;
  }
}
