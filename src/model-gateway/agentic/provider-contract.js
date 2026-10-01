// Provider contract and route lifecycle (Capacity V2, Parts 16 and 20).
//
// Adding a provider means: a route definition (adapter + metadata) in
// model-pool.js, its pool facts in pool-registry.js, a secret name, a canary
// and qualification. The router never changes. This module states the fields
// every route must declare and checks them, so an incomplete provider fails a
// test instead of routing on guesses.

import { capacityPool } from './capacity-pools.js';
import { poolFacts, routeDataClass } from './pool-registry.js';
import { qualificationValid } from './qualification.js';
import { isCoolingDown } from './provider-state.js';

export const CONTRACT_FIELDS = Object.freeze([
  'provider_id', 'model_id', 'capacity_pool_id', 'billing_class', 'privacy_class', 'context_window', 'rate_limit',
  'tool_support', 'structured_output', 'coding_grade', 'reasoning_grade', 'language_grade', 'health', 'reset', 'cost',
]);

const BILLING = new Set(['free', 'included', 'promo', 'paid']);

// The contract view of one route (what the dashboard and the capacity model
// read). `health` comes from provider_status when a state map is given.
export function routeContract(route, { state = null, now = Date.now() } = {}) {
  const pool = route.capacityPool || capacityPool(route);
  const facts = poolFacts(route);
  const capabilities = route.capabilities || {};
  const routeState = state?.get?.(route.id) || null;
  return Object.freeze({
    provider_id: route.provider,
    model_id: route.model,
    capacity_pool_id: pool.id,
    billing_class: route.billingClass,
    privacy_class: routeDataClass(route),
    context_window: route.contextWindow,
    rate_limit: facts.limits,
    tool_support: route.toolCalling !== false && capabilities.toolCalling !== false,
    structured_output: Boolean(capabilities.structuredOutput),
    coding_grade: capabilities.coding ?? null,
    reasoning_grade: capabilities.reasoning ?? null,
    language_grade: { arabic: capabilities.arabic ?? null },
    health: routeState ? (isCoolingDown(routeState, now) ? routeState.health : routeState.health || 'unknown') : 'unknown',
    reset: { kind: facts.kind, timeZone: facts.resetTimeZone || null },
    cost: route.billingClass === 'paid' ? route.pricing || null : { inputPerMillion: 0, outputPerMillion: 0 },
  });
}

// Missing or invalid contract fields for a route definition.
export function contractViolations(route) {
  const problems = [];
  if (!route?.provider || !/^[a-z0-9-]{2,40}$/.test(route.provider)) problems.push('provider_id');
  if (!route?.model) problems.push('model_id');
  if (!BILLING.has(route?.billingClass)) problems.push('billing_class');
  if (!(Number(route?.contextWindow) > 0)) problems.push('context_window');
  if (!route?.secretEnv && !route?.retired) problems.push('secret_env');
  if (!route?.protocol) problems.push('protocol');
  if (route?.billingClass === 'paid' && !route?.pricing && !route?.retired) problems.push('cost');
  // A free/promo route must say who may receive what: the privacy flag name
  // (for PRIVATE) or a declared data class (PUBLIC/NORMAL). Default PUBLIC is
  // allowed only when the route is explicitly not privacy-approved.
  if (route?.billingClass !== 'paid' && route?.privacyApproved && !route?.privacyFlag) problems.push('privacy_flag');
  if (route?.dataClass && !['PUBLIC', 'NORMAL'].includes(route.dataClass)) problems.push('privacy_class');
  const pool = capacityPool(route || {});
  if (!pool?.id) problems.push('capacity_pool_id');
  return problems;
}

// Route lifecycle (Part 20):
//   NOT_CONFIGURED  no credential/endpoint yet (owner action)
//   RETIRED         the provider or model was withdrawn
//   BLOCKED         the provider's own catalog no longer lists the model, or
//                   an account blocker (no credits, not activated)
//   DISCOVERED      configured, never answered a canary/real call
//   CANARY          answered live calls, qualification not passed yet
//   QUALIFIED       passed the qualification suite (may take work)
//   ACTIVE          qualified (or an established paid route) and healthy
export const LIFECYCLE = Object.freeze(['NOT_CONFIGURED', 'RETIRED', 'BLOCKED', 'DISCOVERED', 'CANARY', 'QUALIFIED', 'ACTIVE']);

export function routeLifecycle(route, { qualifications = null, state = null, now = Date.now() } = {}) {
  const reasons = route.unavailableReasons || [];
  if (route.retired || reasons.includes('PROVIDER_RETIRED')) return 'RETIRED';
  if (reasons.some((reason) => ['CREDENTIAL_MISSING', 'ENDPOINT_NOT_CONFIGURED', 'MODEL_NOT_CONFIGURED'].includes(reason))) return 'NOT_CONFIGURED';
  if (reasons.some((reason) => reason.startsWith('CATALOG_'))) return 'BLOCKED';
  const routeState = state?.get?.(route.id) || null;
  if (routeState?.health === 'auth_error') return 'BLOCKED';
  const record = qualifications?.get?.(route.id);
  const qualified = qualificationValid(record, now) && record.status === 'qualified';
  const answered = Boolean(routeState?.verifiedAt || routeState?.lastSuccessAt || Number(routeState?.requests || 0) > 0);
  if (route.billingClass === 'paid') return answered ? 'ACTIVE' : 'DISCOVERED';
  if (qualified) return answered && !isCoolingDown(routeState, now) ? 'ACTIVE' : 'QUALIFIED';
  return answered ? 'CANARY' : 'DISCOVERED';
}
