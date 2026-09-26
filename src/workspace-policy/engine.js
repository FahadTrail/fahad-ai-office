import {
  WORKSPACE_POLICY_DECISION,
  WorkspacePolicyError,
  normalizeToolBrokerRequest,
  normalizeWorkspacePolicy,
} from './contracts.js';

const RISK_ORDER = Object.freeze({ low: 1, medium: 2, high: 3, critical: 4 });

export class WorkspacePolicyEngine {
  constructor({ providerSecretRefs = {} } = {}) {
    this.providerSecretRefs = Object.freeze({ ...providerSecretRefs });
  }

  authorizeExecution({ policy: input, request, route }) {
    const policy = normalizeWorkspacePolicy(input);
    if (!policy.enabled) throw denied('WORKSPACE_DISABLED', 'Workspace execution is disabled');
    if (!request.context.workspaceId) throw denied('WORKSPACE_CONTEXT_REQUIRED', 'Workspace context is required');
    if (request.context.workspaceId !== policy.workspaceId) {
      throw denied('CROSS_WORKSPACE_ACCESS_DENIED', 'Workspace policy does not match the execution context');
    }
    if (!request.context.jobId || !request.context.taskId || !request.context.runId) {
      throw denied('WORKSPACE_LINEAGE_REQUIRED', 'Job, task, and run lineage is required');
    }
    for (const candidate of route) this.authorizeProvider(policy, candidate.provider, candidate.model);
    for (const tool of request.allowedTools) {
      this.authorizeTool(policy, { broker: 'model-host', tool, action: 'invoke', scopes: [] });
    }
    const availableUsd = roundUsd(Math.max(0,
      policy.budget.monthlyLimitUsd - policy.budget.spentUsd - policy.budget.reservedUsd,
    ));
    const requestedRemainingUsd = request.budget
      ? Math.max(0, request.budget.limitUsd - request.budget.spentUsd)
      : policy.budget.maxRequestUsd;
    const reservationUsd = roundUsd(Math.min(policy.budget.maxRequestUsd, requestedRemainingUsd));
    if (!(reservationUsd > 0) || availableUsd < reservationUsd) {
      throw denied('WORKSPACE_BUDGET_EXHAUSTED', 'Workspace budget cannot fully reserve this request');
    }
    return Object.freeze({ policy, reservationUsd });
  }

  authorizeProvider(policy, provider, model, { freeOnly = false, nonPaid = false } = {}) {
    const permission = policy.providers.find((candidate) => candidate.provider === provider && candidate.enabled);
    if (!permission) throw denied('WORKSPACE_PROVIDER_DENIED', `Provider ${provider} is not authorized for this workspace`);
    if (!modelAuthorized(permission.models, model, { freeOnly, nonPaid })) {
      throw denied('WORKSPACE_MODEL_DENIED', `Model ${model} is not authorized for this workspace`);
    }
    const expectedReference = this.providerSecretRefs[provider];
    if (!expectedReference || permission.secretRef !== expectedReference) {
      throw denied('WORKSPACE_SECRET_REFERENCE_DENIED', `Provider ${provider} has no matching controller-side secret reference`);
    }
    return permission;
  }

  authorizeTool(policy, input) {
    const { grant, decision, request } = this.evaluateTool(policy, input);
    if (decision === WORKSPACE_POLICY_DECISION.APPROVAL) {
      throw denied('WORKSPACE_TOOL_APPROVAL_REQUIRED', `Tool ${request.tool} requires explicit approval`);
    }
    if (decision !== WORKSPACE_POLICY_DECISION.AUTO) {
      throw denied('WORKSPACE_TOOL_DENIED', `Tool ${request.tool} is not automatically authorized for this workspace`);
    }
    return grant;
  }

  evaluateTool(inputPolicy, input) {
    const policy = normalizeWorkspacePolicy(inputPolicy);
    const request = normalizeToolBrokerRequest(input);
    const grant = policy.tools.find((candidate) => candidate.enabled &&
      candidate.broker === request.broker && candidate.tool === request.tool && candidate.action === request.action);
    if (!grant) throw denied('WORKSPACE_TOOL_DENIED', `Tool ${request.tool} has no enabled workspace grant`);
    if (request.scopes.some((scope) => !grant.scopes.includes(scope))) {
      throw denied('WORKSPACE_TOOL_SCOPE_DENIED', `Tool ${request.tool} requested an unauthorized scope`);
    }
    if (RISK_ORDER[request.risk] > RISK_ORDER[grant.risk]) {
      throw denied('WORKSPACE_TOOL_RISK_DENIED', `Tool ${request.tool} exceeds its authorized risk boundary`);
    }
    if (request.secretRef !== grant.secretRef) {
      throw denied('WORKSPACE_TOOL_SECRET_REFERENCE_DENIED', `Tool ${request.tool} has no matching secret reference`);
    }
    return Object.freeze({ grant, decision: grant.decision, request });
  }
}

function denied(code, message) {
  return new WorkspacePolicyError(message, { code });
}

function roundUsd(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100_000_000) / 100_000_000;
}

// A permission lists exact model ids. The single pattern "*:free" authorizes
// every discovered free-variant model of that provider, and only routes that
// are free-only guarded (OpenRouter's catalog changes; its free models never
// bill). A bare "*" is rejected by the database and never matches here.
// `*:free` authorizes every model of the provider that runs without charge:
// OpenRouter `:free` variants behind the free-only guard, and routes whose
// owner-stated billing class is free or promo (trial credits). It never
// authorizes a paid route, so new free capacity of an already-approved
// provider is usable without widening paid or private-data access.
export function modelAuthorized(models, model, { freeOnly = false, nonPaid = false } = {}) {
  if (models.includes(model)) return true;
  if (!models.includes('*:free')) return false;
  return (freeOnly && /:free$/.test(String(model))) || nonPaid;
}

// Route ids a workspace policy authorizes: provider, model and the
// controller-side secret reference must all match.
export function authorizedRoutes(pool, policy) {
  return pool.filter((route) => (policy?.providers || []).some((permission) => permission.enabled
    && permission.provider === route.provider && modelAuthorized(permission.models, route.model, { freeOnly: Boolean(route.freeOnly), nonPaid: ['free', 'promo'].includes(route.billingClass) })
    && permission.secretRef === route.secretRef)).map((route) => route.id);
}
