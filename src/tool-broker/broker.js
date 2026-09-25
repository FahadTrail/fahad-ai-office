import { createHash } from 'node:crypto';
import { WorkspacePolicyEngine } from '../workspace-policy/engine.js';
import {
  MCP_PROTOCOL_VERSION,
  TOOL_DECISION,
  ToolBrokerError,
  effectiveDecision,
  normalizeToolDefinition,
  normalizeToolRequest,
  validateJsonValue,
  validateMcpToolResult,
} from './contracts.js';

export class ToolBroker {
  constructor({
    policyStore,
    auditStore,
    agentStore = auditStore,
    clients = [],
    definitions = [],
    secretResolver = null,
    approvalStore = null,
    policyEngine = new WorkspacePolicyEngine(),
    now = () => Date.now(),
  } = {}) {
    for (const method of ['getPolicy', 'assertExecutionContext', 'reserveBudget', 'settleBudget']) {
      if (typeof policyStore?.[method] !== 'function') throw new TypeError(`policyStore.${method} is required`);
    }
    for (const method of ['beginExecution', 'finishExecution']) {
      if (typeof auditStore?.[method] !== 'function') throw new TypeError(`auditStore.${method} is required`);
    }
    if (typeof agentStore?.getAgentPermissions !== 'function') throw new TypeError('agentStore.getAgentPermissions is required');
    this.policyStore = policyStore;
    this.auditStore = auditStore;
    this.agentStore = agentStore;
    this.secretResolver = secretResolver;
    this.approvalStore = approvalStore;
    this.policyEngine = policyEngine;
    this.now = now;
    this.clients = new Map(clients.map((client) => [client.name, client]));
    this.definitions = new Map();
    for (const input of definitions) {
      const definition = normalizeToolDefinition(input);
      const key = toolKey(definition.broker, definition.name, definition.action);
      if (this.definitions.has(key)) throw new TypeError(`Duplicate Tool Broker definition: ${key}`);
      if (!this.clients.has(definition.server)) throw new TypeError(`Unknown MCP server: ${definition.server}`);
      this.definitions.set(key, definition);
    }
  }

  async discover(context) {
    await this.policyStore.assertExecutionContext(context);
    const [policy, agent] = await Promise.all([
      this.policyStore.getPolicy(context.workspaceId),
      this.agentStore.getAgentPermissions(context.agentId),
    ]);
    const serverTools = new Map();
    for (const [name, client] of this.clients) serverTools.set(name, new Set((await client.listTools()).map((tool) => tool.name)));
    const available = [];
    for (const definition of this.definitions.values()) {
      if (!serverTools.get(definition.server)?.has(definition.name)) continue;
      if (!agentAllows(agent.allowedTools, definition.agentPermission)) continue;
      try {
        const grant = this.policyEngine.evaluateTool(policy, policyRequest(definition));
        const decision = effectiveDecision(grant.decision, definition.minimumDecision);
        if (decision !== TOOL_DECISION.DENY) available.push(publicDefinition(definition, decision));
      } catch {}
    }
    return Object.freeze(available);
  }

  async execute(input) {
    const request = normalizeToolRequest(input);
    const definition = this.definitions.get(toolKey(request.broker, request.tool, request.action));
    if (!definition) throw new ToolBrokerError('Tool is not in the controller-owned catalog', { code: 'TOOL_NOT_REGISTERED' });
    enforceJsonSize(request.arguments, definition.maxInputBytes, 'TOOL_INPUT_TOO_LARGE');
    validateJsonValue(request.arguments, definition.inputSchema, 'arguments');
    await this.policyStore.assertExecutionContext(request.context);
    const [policy, agent] = await Promise.all([
      this.policyStore.getPolicy(request.context.workspaceId),
      this.agentStore.getAgentPermissions(request.context.agentId),
    ]);

    if (!agentAllows(agent.allowedTools, definition.agentPermission)) {
      await this.#recordBlocked(request, definition, TOOL_DECISION.DENY, 'TOOL_AGENT_DENIED');
      throw new ToolBrokerError('Agent is not authorized for this tool', { code: 'TOOL_AGENT_DENIED' });
    }

    let grant;
    try {
      grant = this.policyEngine.evaluateTool(policy, policyRequest(definition));
    } catch (error) {
      await this.#recordBlocked(request, definition, TOOL_DECISION.DENY, error.code || 'WORKSPACE_TOOL_DENIED');
      throw error;
    }
    let decision = effectiveDecision(grant.decision, definition.minimumDecision);
    let effectiveRequest = request;
    // An owner-approved request executes exactly once, for exactly the
    // arguments that were shown to the approver. DENY is never overridable.
    if (decision === TOOL_DECISION.APPROVAL && input.approval?.id && this.approvalStore) {
      const consumed = await this.approvalStore.consumeApproval({
        approvalId: input.approval.id,
        callId: input.approval.callId,
        sessionId: input.approval.sessionId,
        argumentsSha256: argumentsSha256(request.arguments),
      });
      if (!consumed) throw new ToolBrokerError('The approval is missing, already used, or does not match these arguments', { code: 'TOOL_APPROVAL_INVALID' });
      decision = TOOL_DECISION.AUTO;
      effectiveRequest = Object.freeze({ ...request, idempotencyKey: `${request.idempotencyKey}:approved` });
    }
    const lease = await this.#begin(effectiveRequest, definition, decision);
    if (decision === TOOL_DECISION.APPROVAL) {
      throw new ToolBrokerError('Tool execution requires explicit approval', { code: 'TOOL_APPROVAL_REQUIRED' });
    }
    if (decision === TOOL_DECISION.DENY) {
      throw new ToolBrokerError('Tool execution is denied by policy', { code: 'TOOL_EXECUTION_DENIED' });
    }
    if (lease.disposition === 'replay') {
      return Object.freeze({
        replayed: true,
        executionId: lease.executionId,
        resultSha256: lease.resultSha256,
        content: Object.freeze([]),
        structuredContent: null,
        isError: false,
        costUsd: 0,
      });
    }
    if (lease.disposition !== 'execute') {
      throw new ToolBrokerError('An execution with this idempotency key is already active or blocked', {
        code: lease.disposition === 'in_progress' ? 'TOOL_EXECUTION_IN_PROGRESS' : 'TOOL_IDEMPOTENCY_BLOCKED',
      });
    }

    const startedAt = this.now();
    let reservation = null;
    let actualCostUsd = 0;
    let attemptCount = Math.max(0, Number(lease.attemptCount || 1) - 1);
    let result;
    try {
      if (definition.estimatedCostUsd > 0) {
        reservation = await this.policyStore.reserveBudget({
          workspaceId: request.context.workspaceId,
          idempotencyKey: `tool:${effectiveRequest.idempotencyKey}`,
          amountUsd: definition.estimatedCostUsd,
        });
      }
      const credential = definition.secretRef ? this.secretResolver?.resolve(definition.secretRef) : null;
      if (definition.secretRef && !credential) {
        throw new ToolBrokerError('No controller-side secret resolver is available', { code: 'TOOL_SECRET_UNAVAILABLE' });
      }
      const client = this.clients.get(definition.server);
      for (let attempt = 1; attempt <= definition.maxRetries + 1; attempt += 1) {
        attemptCount = Math.max(0, Number(lease.attemptCount || 1) - 1) + attempt;
        try {
          const raw = await callWithTimeout(client, {
            name: definition.name,
            arguments: request.arguments,
            credential,
          }, definition.timeoutMs);
          result = validateMcpToolResult(raw, definition.outputSchema);
          if (result.isError) throw new ToolBrokerError('MCP tool reported an execution error', { code: 'MCP_TOOL_ERROR' });
          actualCostUsd = result.costUsd;
          if (!reservation && actualCostUsd > 0) {
            throw new ToolBrokerError('Tool reported cost without a prior budget reservation', { code: 'TOOL_UNBUDGETED_COST' });
          }
          if (reservation && actualCostUsd > Number(reservation.reservedUsd)) {
            throw new ToolBrokerError('Tool cost exceeded its reserved budget', { code: 'TOOL_COST_EXCEEDED' });
          }
          break;
        } catch (error) {
          if (!(definition.retrySafe && isRetryable(error) && attempt <= definition.maxRetries)) throw error;
        }
      }
      if (!result) throw new ToolBrokerError('Tool execution returned no result', { code: 'MCP_TOOL_RESULT_MISSING' });
      const serialized = stableJson({ content: result.content, structuredContent: result.structuredContent, isError: result.isError });
      if (Buffer.byteLength(serialized) > definition.maxOutputBytes) {
        throw new ToolBrokerError('Tool result exceeded the controller output limit', { code: 'TOOL_OUTPUT_TOO_LARGE' });
      }
      const resultSha256 = createHash('sha256').update(serialized).digest('hex');
      await this.auditStore.finishExecution({
        executionId: lease.executionId,
        status: 'succeeded',
        durationMs: elapsed(this.now(), startedAt),
        costUsd: actualCostUsd,
        resultSha256,
        outputBytes: Buffer.byteLength(serialized),
        attemptCount,
        retryCount: Math.max(0, attemptCount - 1),
      });
      return Object.freeze({ ...result, replayed: false, executionId: lease.executionId, resultSha256 });
    } catch (error) {
      await this.auditStore.finishExecution({
        executionId: lease.executionId,
        status: 'failed',
        durationMs: elapsed(this.now(), startedAt),
        costUsd: actualCostUsd,
        outputBytes: 0,
        attemptCount: Math.max(Number(lease.attemptCount || 1), attemptCount),
        retryCount: Math.max(0, attemptCount - 1),
        errorCode: safeErrorCode(error),
      });
      throw wrapExecutionError(error);
    } finally {
      if (reservation) {
        await this.policyStore.settleBudget({
          workspaceId: request.context.workspaceId,
          reservationId: reservation.reservationId,
          idempotencyKey: `tool:${effectiveRequest.idempotencyKey}`,
          actualUsd: actualCostUsd,
        });
      }
    }
  }

  #begin(request, definition, decision, errorCode = null) {
    return this.auditStore.beginExecution({
      context: request.context,
      broker: definition.broker,
      tool: definition.name,
      action: definition.action,
      scopes: definition.scopes,
      risk: definition.risk,
      decision,
      secretRef: definition.secretRef,
      idempotencyKey: request.idempotencyKey,
      protocol: MCP_PROTOCOL_VERSION,
      server: definition.server,
      retrySafe: definition.retrySafe,
      maxRetries: definition.maxRetries,
      errorCode,
    });
  }

  async #recordBlocked(request, definition, decision, errorCode) {
    await this.#begin(request, definition, decision, errorCode);
  }
}

export function argumentsSha256(args) {
  return createHash('sha256').update(stableJson(args || {})).digest('hex');
}

function policyRequest(definition) {
  return {
    broker: definition.broker,
    tool: definition.name,
    action: definition.action,
    scopes: definition.scopes,
    risk: definition.risk,
    secretRef: definition.secretRef,
  };
}

function publicDefinition(definition, decision) {
  return Object.freeze({
    broker: definition.broker,
    name: definition.name,
    action: definition.action,
    description: definition.description,
    risk: definition.risk,
    decision,
    scopes: definition.scopes,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
  });
}

async function callWithTimeout(client, input, timeoutMs) {
  const controller = new AbortController();
  let rejectTimeout;
  const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => {
    const error = new ToolBrokerError('Tool execution timed out', { code: 'TOOL_TIMEOUT', retryable: true });
    controller.abort(error);
    rejectTimeout(error);
  }, timeoutMs);
  try {
    return await Promise.race([client.callTool({ ...input, signal: controller.signal }), timeout]);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ToolBrokerError('Tool execution timed out', { code: 'TOOL_TIMEOUT', retryable: true, cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function agentAllows(values, permission) {
  return Array.isArray(values) && values.includes(permission);
}

function toolKey(broker, tool, action) {
  return `${broker}:${tool}:${action}`;
}

function isRetryable(error) {
  return error?.retryable === true || ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(error?.code);
}

function safeErrorCode(error) {
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.code || '') ? error.code : 'TOOL_EXECUTION_FAILED';
}

function wrapExecutionError(error) {
  if (error instanceof ToolBrokerError) return error;
  return new ToolBrokerError('Tool execution failed safely', {
    code: safeErrorCode(error),
    retryable: isRetryable(error),
    cause: error,
  });
}

function elapsed(now, startedAt) {
  return Math.max(0, Math.round(now - startedAt));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function enforceJsonSize(value, maximum, code) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch {
    throw new ToolBrokerError('Tool input must be serializable JSON', { code: 'INVALID_TOOL_BROKER_INPUT' });
  }
  if (Buffer.byteLength(serialized) > maximum) {
    throw new ToolBrokerError('Tool input exceeded the controller size limit', { code });
  }
}
