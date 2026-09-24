import { GatewayError } from '../model-gateway/contracts.js';

export const WORKSPACE_POLICY_DECISION = Object.freeze({
  AUTO: 'auto',
  APPROVAL: 'approval',
  DENY: 'deny',
});

const TOOL_RISKS = Object.freeze(['low', 'medium', 'high', 'critical']);

export class WorkspacePolicyError extends GatewayError {
  constructor(message, details = {}) {
    super(message, { failureClass: 'approval', ...details });
    this.name = 'WorkspacePolicyError';
  }
}

export function normalizeWorkspacePolicy(input = {}) {
  const workspaceId = requiredString(input.workspaceId, 'workspaceId');
  const budget = input.budget || {};
  const monthlyLimitUsd = positiveNumber(budget.monthlyLimitUsd, 'budget.monthlyLimitUsd');
  const maxRequestUsd = positiveNumber(budget.maxRequestUsd, 'budget.maxRequestUsd');
  const spentUsd = nonNegativeNumber(budget.spentUsd || 0, 'budget.spentUsd');
  const reservedUsd = nonNegativeNumber(budget.reservedUsd || 0, 'budget.reservedUsd');
  if (maxRequestUsd > monthlyLimitUsd) {
    throw invalid('budget.maxRequestUsd cannot exceed budget.monthlyLimitUsd');
  }

  const providers = normalizeProviders(input.providers || []);
  const tools = normalizeTools(input.tools || []);
  return Object.freeze({
    workspaceId,
    enabled: input.enabled === true,
    version: nonNegativeInteger(input.version || 0, 'version'),
    budget: Object.freeze({
      monthlyLimitUsd,
      maxRequestUsd,
      spentUsd,
      reservedUsd,
      periodStart: optionalString(budget.periodStart),
      periodEnd: optionalString(budget.periodEnd),
    }),
    providers: Object.freeze(providers),
    tools: Object.freeze(tools),
  });
}

export function normalizeSecretReference(value) {
  const reference = requiredString(value, 'secretRef');
  if (!/^(?:env:\/\/[A-Z][A-Z0-9_]{2,127}|vault:\/\/[A-Za-z0-9][A-Za-z0-9_./:-]{2,255})$/.test(reference)) {
    throw invalid('secretRef must be an opaque env:// or vault:// reference');
  }
  return reference;
}

export function normalizeToolBrokerRequest(input = {}) {
  const risk = requiredString(input.risk || 'low', 'risk');
  if (!TOOL_RISKS.includes(risk)) throw invalid(`Unsupported tool risk: ${risk}`);
  return Object.freeze({
    broker: requiredString(input.broker || 'model-host', 'broker'),
    tool: requiredString(input.tool, 'tool'),
    action: requiredString(input.action || 'invoke', 'action'),
    scopes: Object.freeze(normalizeStringList(input.scopes || [])),
    risk,
    secretRef: input.secretRef == null ? null : normalizeSecretReference(input.secretRef),
  });
}

function normalizeProviders(values) {
  if (!Array.isArray(values)) throw invalid('providers must be an array');
  const seen = new Set();
  return values.map((value) => {
    const provider = requiredString(value?.provider, 'provider');
    if (seen.has(provider)) throw invalid(`Duplicate provider permission: ${provider}`);
    seen.add(provider);
    const models = normalizeStringList(value.models || []);
    if (!models.length) throw invalid(`Provider ${provider} must authorize at least one model`);
    return Object.freeze({
      provider,
      enabled: value.enabled === true,
      models: Object.freeze(models),
      secretRef: normalizeSecretReference(value.secretRef),
    });
  });
}

function normalizeTools(values) {
  if (!Array.isArray(values)) throw invalid('tools must be an array');
  const seen = new Set();
  return values.map((value) => {
    const request = normalizeToolBrokerRequest(value);
    const key = `${request.broker}:${request.tool}:${request.action}`;
    if (seen.has(key)) throw invalid(`Duplicate tool grant: ${key}`);
    seen.add(key);
    const decision = requiredString(value.decision || WORKSPACE_POLICY_DECISION.DENY, 'decision');
    if (!Object.values(WORKSPACE_POLICY_DECISION).includes(decision)) throw invalid(`Unsupported tool decision: ${decision}`);
    return Object.freeze({ ...request, enabled: value.enabled === true, decision });
  });
}

function normalizeStringList(values) {
  if (!Array.isArray(values)) throw invalid('Expected an array of strings');
  return [...new Set(values.map((value) => requiredString(value, 'list item')))];
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${name} must be a non-empty string`);
  return value.trim();
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw invalid(`${name} must be greater than zero`);
  return number;
}

function nonNegativeNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw invalid(`${name} must be a non-negative number`);
  return number;
}

function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw invalid(`${name} must be a non-negative integer`);
  return number;
}

function invalid(message) {
  return new WorkspacePolicyError(message, { code: 'INVALID_WORKSPACE_POLICY' });
}
