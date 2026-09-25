// Routing policy: which model the controller asks next. Configurable per
// workspace (workspace_routing_policies) and per task (session config
// `routing`), task settings winning. The policy never widens access: it can
// only reorder, exclude or cap routes that the workspace already authorizes.
//
//   strategy  economy  — cheapest eligible route first (default; free-first)
//             balanced — highest quality first, then cheapest
//             quality  — highest quality first, then most capable context
//   billingPriority — class order, default free → included → promo → paid
//   allowPaid       — false keeps the task on free/included/promo routes
//   excludedRoutes  — route ids never used
//   routeMonthlyBudgetUsd — { routeId: usd } cap per route per budget period

export const BILLING_CLASSES = Object.freeze(['free', 'included', 'promo', 'paid']);
export const STRATEGIES = Object.freeze(['economy', 'balanced', 'quality']);
export const DEFAULT_ROUTING = Object.freeze({
  strategy: 'economy',
  billingPriority: BILLING_CLASSES,
  allowPaid: true,
  excludedRoutes: Object.freeze([]),
  routeMonthlyBudgetUsd: Object.freeze({}),
});

const ROUTE_ID_RE = /^[a-z0-9_-]{1,40}:[A-Za-z0-9._:/-]{1,120}$/;

// Validates untrusted input (Hub body, stored row, session config). Unknown
// or malformed fields are dropped rather than guessed.
export function normalizeRouting(input = {}) {
  const value = input && typeof input === 'object' ? input : {};
  const out = {};
  if (STRATEGIES.includes(value.strategy)) out.strategy = value.strategy;
  const priority = Array.isArray(value.billingPriority ?? value.billing_priority) ? (value.billingPriority ?? value.billing_priority) : null;
  if (priority) {
    const unique = [...new Set(priority.filter((entry) => BILLING_CLASSES.includes(entry)))];
    if (unique.length) out.billingPriority = unique;
  }
  const allowPaid = value.allowPaid ?? value.allow_paid;
  if (typeof allowPaid === 'boolean') out.allowPaid = allowPaid;
  const excluded = value.excludedRoutes ?? value.excluded_routes;
  if (Array.isArray(excluded)) out.excludedRoutes = [...new Set(excluded.filter((id) => typeof id === 'string' && ROUTE_ID_RE.test(id)))].slice(0, 50);
  const caps = value.routeMonthlyBudgetUsd ?? value.route_monthly_budget_usd;
  if (caps && typeof caps === 'object' && !Array.isArray(caps)) {
    out.routeMonthlyBudgetUsd = Object.fromEntries(Object.entries(caps)
      .filter(([id, usd]) => ROUTE_ID_RE.test(id) && Number.isFinite(Number(usd)) && Number(usd) >= 0 && Number(usd) <= 10_000)
      .slice(0, 50)
      .map(([id, usd]) => [id, Number(usd)]));
  }
  return out;
}

export function envRouting(env = process.env) {
  const priority = String(env.CODING_BILLING_PRIORITY || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  return normalizeRouting({ billingPriority: priority.length ? priority : undefined, strategy: env.CODING_ROUTING_STRATEGY });
}

// Precedence: defaults < environment < workspace < task.
export function resolveRouting({ env = process.env, workspace = null, task = null } = {}) {
  return Object.freeze({ ...DEFAULT_ROUTING, ...envRouting(env), ...normalizeRouting(workspace || {}), ...normalizeRouting(task || {}) });
}

// Routes whose per-route cap is used up in the current budget period.
export function exhaustedRoutes(routing, spendByRoute = new Map()) {
  return Object.entries(routing.routeMonthlyBudgetUsd || {})
    .filter(([id, cap]) => Number(spendByRoute.get(id) || 0) >= cap)
    .map(([id]) => id);
}

export class MemoryRoutingPolicyStore {
  constructor({ policies = {}, spend = {} } = {}) {
    this.policies = new Map(Object.entries(policies));
    this.spend = spend;
  }

  async getRoutingPolicy(workspaceId) {
    return this.policies.get(workspaceId) || null;
  }

  async setRoutingPolicy(workspaceId, policy) {
    this.policies.set(workspaceId, normalizeRouting(policy));
    return this.policies.get(workspaceId);
  }

  async routeSpend(workspaceId) {
    return new Map(Object.entries(this.spend[workspaceId] || {}));
  }
}

export class SupabaseRoutingPolicyStore {
  constructor(db) {
    this.db = db;
  }

  async getRoutingPolicy(workspaceId) {
    const { data, error } = await this.db.from('workspace_routing_policies').select('*').eq('workspace_id', workspaceId).maybeSingle();
    if (error) {
      if (isMissing(error)) return null;
      throw new Error(`Routing policy unavailable: ${error.message}`);
    }
    return data ? normalizeRouting(data) : null;
  }

  async setRoutingPolicy(workspaceId, policy) {
    const clean = normalizeRouting(policy);
    const row = {
      workspace_id: workspaceId,
      ...(clean.strategy ? { strategy: clean.strategy } : {}),
      ...(clean.billingPriority ? { billing_priority: clean.billingPriority } : {}),
      ...(typeof clean.allowPaid === 'boolean' ? { allow_paid: clean.allowPaid } : {}),
      ...(clean.excludedRoutes ? { excluded_routes: clean.excludedRoutes } : {}),
      ...(clean.routeMonthlyBudgetUsd ? { route_monthly_budget_usd: clean.routeMonthlyBudgetUsd } : {}),
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await this.db.from('workspace_routing_policies').upsert(row, { onConflict: 'workspace_id' }).select('*').single();
    if (error) throw new Error(`Routing policy not saved: ${error.message}`);
    return normalizeRouting(data);
  }

  // Spend per route in the workspace's current budget period, from the
  // model_attempts audit (Office and Coding Agent traffic alike).
  async routeSpend(workspaceId) {
    const { data, error } = await this.db.rpc('model_usage_summary', { p_since: null, p_workspace: workspaceId });
    if (error) {
      if (isMissing(error)) return new Map();
      throw new Error(`Route spend unavailable: ${error.message}`);
    }
    return new Map((data || []).map((row) => [`${row.provider}:${row.model}`, Number(row.cost_usd || 0)]));
  }
}

function isMissing(error) {
  return /does not exist|schema cache|PGRST20[0-9]|42P01|42883|Could not find/i.test(`${error?.message || ''} ${error?.code || ''}`);
}
