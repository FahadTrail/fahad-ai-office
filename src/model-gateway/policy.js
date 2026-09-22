import { GatewayError } from './contracts.js';

export const POLICY_DECISION = Object.freeze({ AUTO: 'auto', APPROVAL: 'approval', DENY: 'deny' });

const DEFAULT_ACTION_RULES = Object.freeze({
  read: { decision: POLICY_DECISION.AUTO, maxRisk: 'high' },
  research: { decision: POLICY_DECISION.AUTO, maxRisk: 'medium' },
  test: { decision: POLICY_DECISION.AUTO, maxRisk: 'medium' },
  write_feature_branch: { decision: POLICY_DECISION.AUTO, maxRisk: 'low', requiresReversible: true },
  create_pull_request: { decision: POLICY_DECISION.AUTO, maxRisk: 'low', requiresTests: true, requiresReversible: true },
  merge_main: { decision: POLICY_DECISION.APPROVAL, maxRisk: 'low', requiresTests: true },
  deploy_production: { decision: POLICY_DECISION.APPROVAL, maxRisk: 'low', requiresTests: true },
  apply_production_migration: { decision: POLICY_DECISION.APPROVAL, maxRisk: 'low', requiresTests: true },
  rotate_secret: { decision: POLICY_DECISION.APPROVAL, maxRisk: 'low' },
  destructive: { decision: POLICY_DECISION.DENY, maxRisk: 'high' },
});

const RISK_ORDER = Object.freeze({ low: 1, medium: 2, high: 3, critical: 4 });

export class ActionPolicyEngine {
  constructor({ ruleSource = (action) => DEFAULT_ACTION_RULES[action] } = {}) {
    this.ruleSource = ruleSource;
  }

  evaluate({ action, risk = 'low', testsPassed = false, reversible = false } = {}) {
    const rule = this.ruleSource(action);
    if (!rule) return decision(POLICY_DECISION.DENY, 'No policy rule authorizes this action');
    if (rule.decision === POLICY_DECISION.DENY) return decision(POLICY_DECISION.DENY, 'Policy explicitly denies this action');
    if (!RISK_ORDER[risk] || RISK_ORDER[risk] > RISK_ORDER[rule.maxRisk || 'low']) {
      return decision(POLICY_DECISION.APPROVAL, 'Risk exceeds the automatic policy boundary');
    }
    if (rule.requiresTests && !testsPassed) return decision(POLICY_DECISION.APPROVAL, 'Passing tests are required');
    if (rule.requiresReversible && !reversible) return decision(POLICY_DECISION.APPROVAL, 'The action must be reversible');
    return decision(rule.decision, rule.decision === POLICY_DECISION.AUTO ? 'Policy authorizes automatic execution' : 'Human approval is required');
  }
}

export class RoutingPolicy {
  constructor({
    defaultProvider = 'anthropic',
    allowedProviders = ['anthropic'],
    failoverEnabled = false,
  } = {}) {
    this.defaultProvider = defaultProvider;
    this.allowedProviders = [...new Set(allowedProviders)];
    this.failoverEnabled = Boolean(failoverEnabled);
  }

  route(request, descriptors) {
    const requested = request.provider || this.defaultProvider;
    const order = this.failoverEnabled
      ? [requested, ...this.allowedProviders.filter((name) => name !== requested)]
      : [requested];
    const candidates = order
      .filter((name) => this.allowedProviders.includes(name))
      .map((name) => descriptors.find((descriptor) => descriptor.name === name))
      .filter(Boolean)
      .filter((descriptor) => descriptor.configured)
      .filter((descriptor) => request.capabilities.every((capability) => descriptor.capabilities.includes(capability)));

    if (!candidates.length) {
      throw new GatewayError('No configured provider satisfies the routing policy', {
        code: 'NO_ELIGIBLE_PROVIDER',
        failureClass: 'fatal',
      });
    }
    return candidates;
  }
}

function decision(value, reason) {
  return Object.freeze({ decision: value, reason });
}
