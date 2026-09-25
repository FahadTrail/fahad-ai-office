export const TOOL_DECISION = Object.freeze({
  AUTO: 'auto',
  APPROVAL: 'approval',
  DENY: 'deny',
});

export const TOOL_RISKS = Object.freeze(['low', 'medium', 'high', 'critical']);
export const MCP_PROTOCOL_VERSION = '2025-11-25';

const DECISION_ORDER = Object.freeze({ auto: 1, approval: 2, deny: 3 });

export class ToolBrokerError extends Error {
  constructor(message, { code = 'TOOL_BROKER_ERROR', retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = 'ToolBrokerError';
    this.code = code;
    this.retryable = Boolean(retryable);
  }
}

export function normalizeToolDefinition(input = {}) {
  const risk = requiredEnum(input.risk || 'low', TOOL_RISKS, 'risk');
  let minimumDecision = requiredEnum(
    input.minimumDecision || (risk === 'critical' ? TOOL_DECISION.DENY : risk === 'high' ? TOOL_DECISION.APPROVAL : TOOL_DECISION.AUTO),
    Object.values(TOOL_DECISION),
    'minimumDecision',
  );
  if (risk === 'critical') minimumDecision = TOOL_DECISION.DENY;
  if (risk === 'high') minimumDecision = stricterDecision(minimumDecision, TOOL_DECISION.APPROVAL);

  const broker = requiredName(input.broker, 'broker', 80);
  const name = requiredName(input.name, 'name', 128);
  const action = requiredName(input.action || 'invoke', 'action', 80);
  // Sandboxed builds and test suites can legitimately run for many minutes.
  const timeoutMs = integerInRange(input.timeoutMs ?? 15_000, 100, 1_800_000, 'timeoutMs');
  const maxRetries = integerInRange(input.maxRetries ?? 0, 0, 3, 'maxRetries');
  const estimatedCostUsd = nonNegativeNumber(input.estimatedCostUsd || 0, 'estimatedCostUsd');
  if (estimatedCostUsd > 0.1) throw invalid('estimatedCostUsd exceeds the Phase 2E per-call safety ceiling');
  const maxInputBytes = integerInRange(input.maxInputBytes ?? 65_536, 256, 1_048_576, 'maxInputBytes');
  const maxOutputBytes = integerInRange(input.maxOutputBytes ?? 65_536, 256, 1_048_576, 'maxOutputBytes');

  return Object.freeze({
    broker,
    name,
    action,
    server: requiredName(input.server, 'server', 80),
    description: requiredString(input.description, 'description', 1000),
    risk,
    minimumDecision,
    scopes: Object.freeze(stringList(input.scopes || [])),
    agentPermission: requiredName(input.agentPermission, 'agentPermission', 160),
    secretRef: optionalSecretReference(input.secretRef),
    inputSchema: normalizeSchema(input.inputSchema, 'inputSchema'),
    outputSchema: input.outputSchema ? normalizeSchema(input.outputSchema, 'outputSchema') : null,
    timeoutMs,
    maxRetries,
    retrySafe: input.retrySafe === true,
    estimatedCostUsd,
    maxInputBytes,
    maxOutputBytes,
  });
}

export function normalizeToolRequest(input = {}) {
  const context = input.context || {};
  return Object.freeze({
    context: Object.freeze({
      workspaceId: requiredString(context.workspaceId, 'context.workspaceId', 128),
      jobId: requiredString(context.jobId, 'context.jobId', 128),
      taskId: requiredString(context.taskId, 'context.taskId', 128),
      runId: requiredString(context.runId, 'context.runId', 128),
      agentId: requiredString(context.agentId, 'context.agentId', 128),
    }),
    broker: requiredName(input.broker, 'broker', 80),
    tool: requiredName(input.tool, 'tool', 128),
    action: requiredName(input.action || 'invoke', 'action', 80),
    arguments: plainObject(input.arguments || {}, 'arguments'),
    idempotencyKey: requiredString(input.idempotencyKey, 'idempotencyKey', 512),
  });
}

export function effectiveDecision(policyDecision, minimumDecision) {
  const policy = requiredEnum(policyDecision, Object.values(TOOL_DECISION), 'policyDecision');
  const minimum = requiredEnum(minimumDecision, Object.values(TOOL_DECISION), 'minimumDecision');
  return DECISION_ORDER[policy] >= DECISION_ORDER[minimum] ? policy : minimum;
}

export function validateMcpToolResult(value, outputSchema = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('MCP tool result must be an object');
  if (!Array.isArray(value.content)) throw invalid('MCP tool result content must be an array');
  for (const item of value.content) {
    if (!item || typeof item !== 'object' || !['text', 'image', 'audio', 'resource', 'resource_link'].includes(item.type)) {
      throw invalid('MCP tool result contains an unsupported content item');
    }
    if (item.type === 'text' && typeof item.text !== 'string') throw invalid('MCP text content must contain text');
  }
  if (value.isError != null && typeof value.isError !== 'boolean') throw invalid('MCP tool result isError must be boolean');
  if (value.structuredContent != null && !isPlainObject(value.structuredContent)) {
    throw invalid('MCP structuredContent must be an object');
  }
  if (outputSchema) validateJsonValue(value.structuredContent, outputSchema, 'structuredContent');
  const costUsd = nonNegativeNumber(value._meta?.costUsd ?? value.costUsd ?? 0, '_meta.costUsd');
  return Object.freeze({
    content: Object.freeze(value.content.map((item) => Object.freeze({ ...item }))),
    structuredContent: value.structuredContent == null ? null : Object.freeze({ ...value.structuredContent }),
    isError: value.isError === true,
    costUsd,
  });
}

export function validateJsonValue(value, schema, path = 'value') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw invalid(`${path} schema must be an object`);
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some((type) => matchesType(value, type))) throw invalid(`${path} does not match its schema type`);
  if (schema.enum && (!Array.isArray(schema.enum) || !schema.enum.some((candidate) => Object.is(candidate, value)))) {
    throw invalid(`${path} is not an allowed value`);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const required of schema.required || []) {
      if (!Object.hasOwn(value, required)) throw invalid(`${path}.${required} is required`);
    }
    const properties = schema.properties || {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(properties, key)) throw invalid(`${path}.${key} is not allowed`);
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateJsonValue(value[key], child, `${path}.${key}`);
    }
  }
  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) throw invalid(`${path} is too short`);
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) throw invalid(`${path} is too long`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) throw invalid(`${path} has an invalid format`);
  }
  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) throw invalid(`${path} is below its minimum`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) throw invalid(`${path} exceeds its maximum`);
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) throw invalid(`${path} has too many items`);
    if (schema.items) value.forEach((item, index) => validateJsonValue(item, schema.items, `${path}[${index}]`));
  }
  return true;
}

function normalizeSchema(value, name) {
  const schema = plainObject(value, name);
  if (schema.type !== 'object') throw invalid(`${name} must describe an object`);
  return Object.freeze(structuredClone(schema));
}

function optionalSecretReference(value) {
  if (value == null || value === '') return null;
  const reference = requiredString(value, 'secretRef', 260);
  if (!/^(?:env:\/\/[A-Z][A-Z0-9_]{2,127}|vault:\/\/[A-Za-z0-9][A-Za-z0-9_./:-]{2,255})$/.test(reference)) {
    throw invalid('secretRef must be an opaque env:// or vault:// reference');
  }
  return reference;
}

function matchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isPlainObject(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function stringList(values) {
  if (!Array.isArray(values)) throw invalid('scopes must be an array');
  return [...new Set(values.map((value) => requiredString(value, 'scope', 160)))];
}

function plainObject(value, name) {
  if (!isPlainObject(value)) throw invalid(`${name} must be an object`);
  return Object.freeze(structuredClone(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredName(value, name, maximum) {
  const normalized = requiredString(value, name, maximum);
  if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) throw invalid(`${name} contains unsupported characters`);
  return normalized;
}

function requiredString(value, name, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${name} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > maximum) throw invalid(`${name} is too long`);
  return normalized;
}

function requiredEnum(value, allowed, name) {
  const normalized = requiredString(value, name, 80);
  if (!allowed.includes(normalized)) throw invalid(`${name} is unsupported`);
  return normalized;
}

function nonNegativeNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw invalid(`${name} must be a non-negative number`);
  return number;
}

function integerInRange(value, minimum, maximum, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw invalid(`${name} is outside its allowed range`);
  return number;
}

function stricterDecision(left, right) {
  return DECISION_ORDER[left] >= DECISION_ORDER[right] ? left : right;
}

function invalid(message) {
  return new ToolBrokerError(message, { code: 'INVALID_TOOL_BROKER_INPUT' });
}
