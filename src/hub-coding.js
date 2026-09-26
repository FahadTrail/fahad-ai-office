// Hub endpoints and UI for the Coding Agent, the approvals queue and the
// Model Pool dashboard. Everything reads the durable Supabase state written
// by the coding worker; the browser never receives credentials. If the
// Coding Agent migration has not been applied yet, these endpoints answer
// 503 CODING_AGENT_NOT_INSTALLED and the rest of the Hub keeps working.

import { readFileSync } from 'node:fs';
import { createModelPool } from './model-gateway/agentic/model-pool.js';
import { AgentTurnGateway } from './model-gateway/agentic/turn-gateway.js';
import { exhaustedRoutes, normalizeRouting, resolveRouting, SupabaseRoutingPolicyStore } from './model-gateway/agentic/routing-policy.js';
import { authorizedRoutes } from './coding-agent/runtime.js';
import { JOB_PROFILES, capabilityGaps } from './model-gateway/agentic/capabilities.js';
import { freeQuotaStatus } from './model-gateway/agentic/free-quota.js';
import { getOpenRouterCatalog } from './model-gateway/agentic/openrouter-catalog.js';
import { providerCatalogSnapshot } from './model-gateway/agentic/provider-catalogs.js';
import { QualificationStore, qualificationValid, qualificationGaps } from './model-gateway/agentic/qualification.js';
import { PROVIDER_FACTS, PROVIDER_FACTS_CHECKED, blockerLabel, blockerReason } from './model-gateway/agentic/provider-facts.js';
import { ACCOUNT_BLOCKERS } from './model-gateway/agentic/provider-state.js';
import { OFFICE_ROLES } from './office-agents/roles.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const SESSION_FIELDS = 'id,workspace_id,job_id,title,objective,repository,base_branch,work_branch,status,phase,plan,state,config,next_action,current_route,previous_route,provider_switches,iteration,budget_usd,spent_usd,tokens_in,tokens_out,result,blocker,error_code,cancel_requested,created_at,updated_at,started_at,completed_at';

export function readDeployedVersion(path = process.env.HUB_DEPLOYED_SHA_FILE || '/app/logs/deployed-sha') {
  try {
    const value = readFileSync(path, 'utf8').trim();
    return /^[0-9a-f]{40}$/.test(value) ? value.slice(0, 12) : null;
  } catch {
    return null;
  }
}

export async function handleCodingApi({ db, request, response, url, sendJson, readJson, actor, env = process.env, now = () => Date.now() }) {
  const path = url.pathname;
  if (!path.startsWith('/api/coding') && !path.startsWith('/api/approvals') && !path.startsWith('/api/model-pool') && path !== '/api/platform') return false;
  try {
    if (request.method === 'GET' && path === '/api/platform') {
      const requested = url.searchParams.get('workspaceId');
      const overview = await platformOverview({ db, env, now, workspaceId: requested ? uuid(requested, 'workspaceId') : null });
      return sendJson(response, 200, { ok: true, ...overview }), true;
    }
    if (request.method === 'GET' && path === '/api/model-pool') {
      const requested = url.searchParams.get('workspaceId');
      const snapshot = await modelPoolSnapshot({ db, env, now, workspaceId: requested ? uuid(requested, 'workspaceId') : null });
      let lastCanary = null;
      try {
        lastCanary = (await rows(db.from('provider_canary_runs').select('id,status,requested_at,completed_at,report,error').order('requested_at', { ascending: false }).limit(1)))[0] || null;
      } catch (error) {
        if (!error.notInstalled) throw error;
      }
      return sendJson(response, 200, { ok: true, ...snapshot, lastCanary }), true;
    }
    if (request.method === 'PUT' && path === '/api/model-pool/routing') {
      const body = await readJson(request);
      const workspaceId = uuid(body.workspaceId, 'workspaceId');
      const routing = normalizeRouting(body);
      if (!Object.keys(routing).length) throw input('No valid routing setting was provided');
      const saved = await new SupabaseRoutingPolicyStore(db).setRoutingPolicy(workspaceId, routing)
        .catch((error) => { throw dbError('Could not save the routing policy', error); });
      return sendJson(response, 200, { ok: true, routing: saved }), true;
    }
    if (request.method === 'POST' && path === '/api/model-pool/canary') {
      const { data, error } = await db.from('provider_canary_runs').insert({ requested_by: actor || 'hub-owner' }).select('id,status,requested_at').single();
      if (error) throw dbError('Could not queue the provider canary', error);
      return sendJson(response, 202, { ok: true, run: data }), true;
    }
    if (request.method === 'GET' && path === '/api/coding/sessions') {
      const workspaceId = uuid(url.searchParams.get('workspaceId'), 'workspaceId');
      const sessions = await rows(db.from('agent_sessions').select(SESSION_FIELDS).eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false }).limit(30));
      return sendJson(response, 200, { ok: true, sessions: sessions.map(publicSession) }), true;
    }
    if (request.method === 'POST' && path === '/api/coding/sessions') {
      const body = await readJson(request);
      const input = validateSessionInput(body);
      const { data, error } = await db.rpc('create_coding_session', {
        p_workspace: input.workspaceId, p_title: input.title, p_objective: input.objective, p_repository: input.repository,
        p_base_branch: input.baseBranch, p_budget_usd: input.budgetUsd, p_config: input.config, p_created_by: actor || null,
      });
      if (error) throw dbError('Could not create the Coding Agent session', error);
      const session = Array.isArray(data) ? data[0] : data;
      return sendJson(response, 201, { ok: true, session: publicSession(session) }), true;
    }
    const sessionMatch = path.match(/^\/api\/coding\/sessions\/([0-9a-f-]{36})(?:\/(cancel|resume|events))?$/i);
    if (sessionMatch) {
      const id = uuid(sessionMatch[1], 'sessionId');
      if (request.method === 'GET' && !sessionMatch[2]) {
        const session = await one(db.from('agent_sessions').select(SESSION_FIELDS).eq('id', id).maybeSingle());
        if (!session) return sendJson(response, 404, { ok: false, error: 'SESSION_NOT_FOUND' }), true;
        const [events, approvals, attempts] = await Promise.all([
          rows(db.from('agent_events').select('id,type,level,message,payload,created_at').eq('session_id', id).order('id', { ascending: false }).limit(150)),
          rows(db.from('agent_approvals').select('id,tool_name,action,risk,summary,arguments_preview,status,requested_at,decided_at,decided_by,note').eq('session_id', id).order('requested_at', { ascending: false })),
          rows(db.from('model_attempts').select('provider,model,status,input_tokens,output_tokens,cost_usd,error_code,started_at').eq('job_id', session.job_id).order('started_at', { ascending: false }).limit(60)),
        ]);
        return sendJson(response, 200, { ok: true, session: publicSession(session), events: events.map(publicEvent), approvals, attempts }), true;
      }
      if (request.method === 'POST' && sessionMatch[2] === 'cancel') {
        const { error } = await db.rpc('request_agent_session_cancel', { p_session: id });
        if (error) throw dbError('Could not cancel the session', error);
        return sendJson(response, 200, { ok: true }), true;
      }
      if (request.method === 'POST' && sessionMatch[2] === 'resume') {
        const { error } = await db.rpc('resume_agent_session', { p_session: id });
        if (error) throw dbError('Could not resume the session', error);
        return sendJson(response, 200, { ok: true }), true;
      }
    }
    if (request.method === 'GET' && path === '/api/approvals') {
      const workspaceId = uuid(url.searchParams.get('workspaceId'), 'workspaceId');
      const approvals = await rows(db.from('agent_approvals').select('id,session_id,tool_name,action,risk,summary,arguments_preview,status,requested_at')
        .eq('workspace_id', workspaceId).eq('status', 'pending').order('requested_at', { ascending: true }));
      return sendJson(response, 200, { ok: true, approvals }), true;
    }
    const approvalMatch = path.match(/^\/api\/approvals\/([0-9a-f-]{36})$/i);
    if (request.method === 'POST' && approvalMatch) {
      const body = await readJson(request);
      if (!['approved', 'rejected'].includes(body.decision)) throw input('decision must be approved or rejected');
      const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : null;
      const { data, error } = await db.rpc('decide_agent_approval', {
        p_approval: uuid(approvalMatch[1], 'approvalId'), p_decision: body.decision, p_decided_by: actor || 'hub-owner', p_note: note,
      });
      if (error) throw dbError('Could not record the decision', error);
      return sendJson(response, 200, { ok: true, approval: Array.isArray(data) ? data[0] : data }), true;
    }
    return sendJson(response, 404, { ok: false, error: 'NOT_FOUND' }), true;
  } catch (error) {
    if (error.notInstalled) return sendJson(response, 503, { ok: false, error: 'CODING_AGENT_NOT_INSTALLED' }), true;
    const status = error.statusCode || 500;
    return sendJson(response, status, { ok: false, error: String(error.message || 'Request failed').slice(0, 300) }), true;
  }
}

function validateSessionInput(body) {
  const workspaceId = uuid(body.workspaceId, 'workspaceId');
  const objective = typeof body.objective === 'string' ? body.objective.trim() : '';
  if (objective.length < 12 || objective.length > 40_000) throw input('The development objective must contain 12 to 40000 characters');
  const repository = typeof body.repository === 'string' ? body.repository.trim() : '';
  if (!REPO_RE.test(repository)) throw input('Repository must be owner/name');
  const baseBranch = typeof body.baseBranch === 'string' && body.baseBranch.trim() ? body.baseBranch.trim() : 'main';
  if (!BRANCH_RE.test(baseBranch)) throw input('Invalid base branch');
  const budgetUsd = Number(body.budgetUsd ?? 5);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 500) throw input('Budget must be between 0 and 500 USD');
  const title = (typeof body.title === 'string' && body.title.trim() ? body.title.trim() : objective.split('\n')[0]).slice(0, 120);
  const config = { publish: 'pull_request' };
  if (typeof body.testCommand === 'string' && body.testCommand.trim()) config.testCommand = body.testCommand.trim().slice(0, 500);
  if (body.deploy === true) {
    config.deploy = { mode: 'merge', workflow: typeof body.deployWorkflow === 'string' && body.deployWorkflow.trim() ? body.deployWorkflow.trim() : 'deploy.yml' };
    if (typeof body.verifyUrl === 'string' && body.verifyUrl.trim()) {
      const url = new URL(body.verifyUrl.trim());
      if (url.protocol !== 'https:') throw input('Verification URL must use HTTPS');
      config.verify = { url: url.href, hosts: [url.hostname], ...(body.verifyShaField ? { expectShaField: String(body.verifyShaField).slice(0, 60) } : {}) };
    }
  }
  if (body.routing && typeof body.routing === 'object') {
    const routing = normalizeRouting(body.routing);
    if (Object.keys(routing).length) config.routing = routing;
  }
  if (Array.isArray(body.supabaseProjects)) config.supabase = { projects: body.supabaseProjects.filter((ref) => /^[a-z0-9]{20}$/.test(ref)).slice(0, 5) };
  return { workspaceId, objective, repository, baseBranch, budgetUsd, title, config };
}

// Truthful per-route status: provider-reported rate limits only; quota is
// "EXACT QUOTA NOT AVAILABLE" unless a provider reports it; costs are marked
// estimated; a route is LIVE only after a real canary or real traffic.
export async function modelPoolSnapshot({ db, env = process.env, now = () => Date.now(), workspaceId = null }) {
  const pool = createModelPool({ env });
  const optional = async (promise, fallback) => {
    try {
      return await promise;
    } catch (error) {
      if (error.notInstalled) return fallback;
      throw error;
    }
  };
  const routingStore = new SupabaseRoutingPolicyStore(db);
  const qualifications = await new QualificationStore(db, { now }).snapshot().catch(() => new Map());
  const [statusRows, todayRows, periodRows, activeRows, workspaceRouting, permissionRows] = await Promise.all([
    optional(rows(db.from('provider_status').select('*')), []),
    optional(rpcRows(db, 'model_usage_summary', { p_since: null, p_workspace: null }), []),
    workspaceId ? optional(rpcRows(db, 'model_usage_summary', { p_since: null, p_workspace: workspaceId }), []) : [],
    optional(rows(db.from('agent_sessions').select('current_route,status').in('status', ['queued', 'running', 'awaiting_approval'])), []),
    workspaceId ? routingStore.getRoutingPolicy(workspaceId).catch(() => null) : null,
    workspaceId ? optional(rows(db.from('workspace_provider_permissions').select('provider,models,secret_ref,enabled').eq('workspace_id', workspaceId)), null) : null,
  ]);
  const authorizedRouteIds = permissionRows ? authorizedRoutes(pool, {
    providers: permissionRows.map((row) => ({ provider: row.provider, models: row.models || [], secretRef: row.secret_ref, enabled: row.enabled })),
  }) : null;
  const routing = resolveRouting({ env, workspace: workspaceRouting });
  const state = new Map(statusRows.map((row) => [`${row.provider}:${row.model}`, row]));
  const today = new Map(todayRows.map((row) => [`${row.provider}:${row.model}`, row]));
  const period = new Map(periodRows.map((row) => [`${row.provider}:${row.model}`, Number(row.cost_usd || 0)]));
  const active = new Map();
  for (const row of activeRows) if (row.current_route) active.set(row.current_route, (active.get(row.current_route) || 0) + 1);
  const minQualityTier = Number(env.CODING_MIN_QUALITY_TIER || 4);
  const gateway = new AgentTurnGateway({
    pool,
    stateStore: { snapshot: async () => new Map([...state].map(([key, row]) => [key, { health: row.health, cooldownUntil: row.cooldown_until }])) },
    billingPriority: routing.billingPriority,
    strategy: routing.strategy,
    minQualityTier,
    now,
  });
  // The ranking shown is the Coding Agent's: private code, the coding job.
  const evaluations = await gateway.evaluate({
    requiresPrivateData: true, allowPaid: routing.allowPaid, authorizedRouteIds, job: 'coding',
    policyExcludedRouteIds: routing.excludedRoutes, budgetExhaustedRouteIds: exhaustedRoutes(routing, period),
  });
  const order = gateway.order(evaluations, { job: 'coding' }).map((route) => route.id);
  const routes = evaluations.map(({ route, reasons }) => {
    const row = state.get(route.id) || null;
    const usageToday = today.get(route.id);
    const rateLimit = row?.rate_limit || null;
    const limit = rateLimit?.requestsLimit ?? null;
    const remaining = rateLimit?.requestsRemaining ?? null;
    const cooling = Boolean(row?.cooldown_until && Date.parse(row.cooldown_until) > now());
    const configured = !route.unavailableReasons.includes('CREDENTIAL_MISSING');
    let availability;
    if (route.unavailableReasons.length) availability = `NOT CONFIGURED — ${route.unavailableReasons.join(', ')}`;
    else if (cooling) availability = `${String(row.health || 'unavailable').toUpperCase().replace('_', ' ')} — RETRY AFTER ${formatRemaining(Date.parse(row.cooldown_until) - now())}`;
    else if (reasons.includes('WORKSPACE_NOT_AUTHORIZED')) availability = 'NOT AUTHORIZED FOR THIS PROJECT';
    else if (reasons.includes('PRIVACY_NOT_APPROVED')) availability = 'AVAILABLE FOR PUBLIC DATA ONLY — PRIVACY REVIEW PENDING';
    else if (reasons.includes('BELOW_QUALITY_FLOOR') || reasons.some((reason) => /^(CAPABILITY_|TOOL_CALLING|CONTEXT_WINDOW)/.test(reason))) availability = 'AVAILABLE — NOT CAPABLE ENOUGH FOR CODING';
    else if (limit != null && remaining != null) availability = `AVAILABLE — ${remaining}/${limit} REQUESTS LEFT (PROVIDER-REPORTED)`;
    else availability = 'AVAILABLE — EXACT QUOTA NOT AVAILABLE';
    const verifiedAt = row?.verified_at || null;
    // Account/credential blockers are named, never shown as a generic outage.
    const blocker = blockerReason(row?.last_error_code);
    const blockerActive = Boolean(blocker) && (!row?.last_success_at || Date.parse(row.last_error_at) > Date.parse(row.last_success_at));
    const genericAuth = !blocker && row?.health === 'auth_error' && (!row?.last_success_at || Date.parse(row.last_error_at) > Date.parse(row.last_success_at));
    let status;
    const unsuitableCode = /^(PROVIDER_UNSUITABLE|PAID_ON_FREE_ROUTE)/.test(row?.last_error_code || '');
    if (route.retired) status = 'RETIRED';
    else if (!configured) status = 'NOT CONFIGURED';
    else if (blockerActive) status = `BLOCKED — ${blockerLabel(route.provider, blocker)}`;
    else if (genericAuth) status = 'BLOCKED — CREDENTIAL OR ACCOUNT REJECTED';
    else if (route.unavailableReasons.some((reason) => reason.startsWith('CATALOG_'))) status = 'UNSUITABLE';
    else if (route.unavailableReasons.length) status = 'NOT READY';
    else if (cooling && ['rate_limited', 'quota_exhausted'].includes(row.health)) status = 'RATE LIMITED';
    else if (cooling && unsuitableCode) status = 'UNSUITABLE';
    else if (cooling) status = 'COOLDOWN';
    else if (row?.health === 'degraded') status = 'DEGRADED';
    else if (verifiedAt || row?.last_success_at) status = 'LIVE';
    else status = 'CONFIGURED — NOT YET VERIFIED';
    const integration = route.unavailableReasons.length === 0 ? 'READY'
      : route.unavailableReasons.map((reason) => ({
        CREDENTIAL_MISSING: 'READY — CREDENTIAL REQUIRED', ENDPOINT_NOT_CONFIGURED: 'READY — ENDPOINT REQUIRED',
        MODEL_NOT_CONFIGURED: 'READY — MODEL ID REQUIRED', PRICING_UNKNOWN: 'READY — PRICING REQUIRED',
      })[reason] || reason).join(' · ');
    const cap = routing.routeMonthlyBudgetUsd[route.id];
    const record = qualifications.get(route.id);
    const qualification = route.billingClass === 'paid' ? { status: 'NOT REQUIRED (paid, budgeted)' }
      : qualificationValid(record, now()) ? { status: record.status.toUpperCase(), passed: record.passed, total: record.total, skills: record.skills, testedAt: record.testedAt, suiteVersion: record.suiteVersion }
        : { status: 'NOT YET QUALIFIED' };
    // Office jobs this route may take with non-private data (capability +
    // qualification evidence); private work additionally needs privacy approval.
    const officeJobs = Object.keys(JOB_PROFILES).filter((job) => !['coding', 'qa_security'].includes(job)
      && capabilityGaps(route.capabilities, job).length === 0 && qualificationGaps(route, job, qualifications, now()).length === 0);
    const credentialStatus = route.retired ? 'NOT APPLICABLE (RETIRED)'
      : !configured ? 'MISSING'
        : blockerActive && ['CREDENTIAL_INVALID', 'PERMISSION_MISSING'].includes(blocker) ? blockerLabel(route.provider, blocker)
          : genericAuth ? 'REJECTED' : 'PRESENT';
    const freeQuota = freeQuotaStatus(route, {
      env, now: now(), rateLimit,
      usedToday: usageToday ? { requests: Number(usageToday.requests || 0) } : { requests: 0 },
    });
    return {
      id: route.id,
      provider: route.provider,
      model: route.model,
      protocol: route.protocol,
      status,
      integration,
      configured,
      enabled: !route.unavailableReasons.length && !routing.excludedRoutes.includes(route.id),
      authorizedForProject: authorizedRouteIds ? authorizedRouteIds.includes(route.id) : null,
      eligibleForPrivateCode: reasons.length === 0,
      routingRank: order.indexOf(route.id) >= 0 ? order.indexOf(route.id) + 1 : null,
      billingClass: route.billingClass.toUpperCase(),
      health: row?.health || 'unknown',
      availability,
      reasons,
      discovered: Boolean(route.discovered),
      group: route.provider === 'openrouter' ? 'OpenRouter (one key, several free models)' : route.provider,
      freeOnly: Boolean(route.freeOnly),
      privateCode: route.privacyApproved ? 'APPROVED' : 'NOT APPROVED — public/non-private data only',
      excludedBecause: reasons.map(explainReason),
      codingSuitability: !route.toolCalling ? 'TEXT ONLY — NOT FOR CODING'
        : route.qualityTier < minQualityTier || capabilityGaps(route.capabilities, 'coding').length ? 'NOT CAPABLE ENOUGH FOR CODING'
          : route.privacyApproved ? 'SUITABLE FOR PRIVATE CODE' : 'PUBLIC CODE ONLY — PRIVACY REVIEW PENDING',
      capabilities: route.capabilities,
      suitableJobs: Object.keys(JOB_PROFILES).filter((job) => capabilityGaps(route.capabilities, job).length === 0),
      freeQuota,
      qualification,
      officeJobs,
      credentialStatus,
      accountBlocker: blockerActive ? { reason: blocker, label: blockerLabel(route.provider, blocker), text: ACCOUNT_BLOCKERS[blocker] } : genericAuth ? { reason: 'AUTH', label: 'CREDENTIAL OR ACCOUNT REJECTED', text: 'Rejected by the provider; the exact reason is recorded on the next call' } : null,
      estimatedRemaining: freeQuota?.requestsRemaining != null ? { requests: freeQuota.requestsRemaining, basis: freeQuota.basis } : { requests: null, basis: 'EXACT QUOTA NOT AVAILABLE' },
      requestTokenLimit: route.requestTokenLimit || null,
      retired: Boolean(route.retired),
      activeTasks: active.get(route.id) || 0,
      quota: limit != null && remaining != null
        ? { exact: true, source: 'provider response headers (rate-limit window)', requestsLimit: limit, requestsRemaining: remaining, resetsAt: rateLimit.requestsReset || null }
        : { exact: false, label: 'EXACT QUOTA NOT AVAILABLE' },
      rateLimit: rateLimit ? { ...rateLimit, source: 'provider response headers' } : null,
      quotaPercentRemaining: limit && remaining != null ? Math.round((remaining / limit) * 100) : null,
      cooldownUntil: cooling ? row.cooldown_until : null,
      resetsAt: cooling ? row.cooldown_until : rateLimit?.requestsReset || null,
      today: usageToday ? {
        requests: Number(usageToday.requests || 0), failures: Number(usageToday.failures || 0),
        inputTokens: Number(usageToday.input_tokens || 0), outputTokens: Number(usageToday.output_tokens || 0),
        estimatedCostUsd: Number(usageToday.cost_usd || 0), source: 'model_attempts audit (Office + Coding Agent, UTC day)',
      } : { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, source: 'model_attempts audit (Office + Coding Agent, UTC day)' },
      budgetCap: cap != null ? { monthlyUsd: cap, spentThisPeriodUsd: period.get(route.id) || 0, basis: 'ESTIMATED' } : null,
      usage: row ? {
        requests: Number(row.requests_total || 0), failures: Number(row.failures_total || 0),
        inputTokens: Number(row.input_tokens_total || 0), outputTokens: Number(row.output_tokens_total || 0),
        estimatedCostUsd: Number(row.cost_usd_total || 0), costBasis: 'ESTIMATED from token counts and published list prices (lifetime, includes canaries)',
      } : null,
      lastSuccessAt: row?.last_success_at || null,
      lastErrorAt: row?.last_error_at || null,
      lastErrorCode: row?.last_error_code || null,
      verifiedAt,
      toolCalling: route.toolCalling,
      contextWindow: route.contextWindow,
      qualityTier: route.qualityTier,
      costTier: route.costTier,
      privacy: route.privacyApproved ? 'approved for private code' : (route.privacyFlag ? `requires ${route.privacyFlag}=true after review` : route.privacyNote || 'not approved'),
      pricing: route.pricing ? { ...route.pricing, basis: 'published list price' } : null,
    };
  });
  const catalog = getOpenRouterCatalog();
  return {
    providers: providerSummary(routes),
    factsChecked: PROVIDER_FACTS_CHECKED,
    providerCatalogs: providerCatalogSnapshot(),
    openRouter: catalog ? {
      fetchedAt: catalog.fetchedAt, source: catalog.source, keyScopedList: catalog.keyScopedList,
      freeModels: catalog.freeModels, accessibleFreeModels: catalog.accessibleFreeModels, admitted: catalog.admitted,
      models: catalog.models.map((entry) => ({ id: entry.id, contextLength: entry.contextLength, tools: entry.tools, admitted: entry.admitted, reasons: entry.reasons })),
      note: 'One OpenRouter key; each admitted free model is its own route. Free-only: a response that reports any cost is refused and the route is quarantined.',
    } : null,
    billingPriority: [...routing.billingPriority],
    routing: { ...routing, source: workspaceRouting ? 'workspace policy' : 'defaults' },
    routes,
    installed: true,
  };
}

// One line per provider: overall status, offer (FREE/PROMO/PAID/RETIRED),
// live and qualified models, credential and the real blocker, plus the
// checked facts. No percentage is shown unless a provider reports one.
export function providerSummary(routes) {
  const byProvider = new Map();
  for (const route of routes) {
    if (!byProvider.has(route.provider)) byProvider.set(route.provider, []);
    byProvider.get(route.provider).push(route);
  }
  return [...byProvider].map(([provider, list]) => {
    const facts = PROVIDER_FACTS[provider] || {};
    const live = list.filter((route) => route.status === 'LIVE');
    const blocked = list.find((route) => route.status.startsWith('BLOCKED'));
    const qualified = list.filter((route) => route.qualification?.status === 'QUALIFIED');
    let status;
    if (list.every((route) => route.retired)) status = 'RETIRED';
    else if (list.every((route) => route.credentialStatus === 'MISSING')) status = 'READY — CREDENTIAL REQUIRED';
    else if (live.length) status = 'LIVE';
    else if (blocked) status = blocked.status;
    else if (list.some((route) => ['RATE LIMITED', 'COOLDOWN', 'DEGRADED'].includes(route.status))) status = 'TEMPORARILY LIMITED';
    else status = 'CONFIGURED — NOT YET VERIFIED';
    const classes = [...new Set(list.map((route) => route.billingClass))];
    return {
      provider, label: facts.label || provider, status, offer: facts.offer || classes.join('/'), billingClasses: classes,
      models: list.length, liveModels: live.length, qualifiedModels: qualified.length,
      credential: facts.credentialEnv ? { env: facts.credentialEnv, status: list.some((route) => route.credentialStatus === 'PRESENT') ? 'PRESENT' : list[0].credentialStatus, page: facts.credentialPage, scope: facts.scope } : null,
      blocker: blocked?.accountBlocker || null,
      freeTier: facts.freeTier || null, privacy: facts.privacy || null, source: facts.source || null,
    };
  });
}

// One read-only overview for the platform dashboard: CODING AGENT, OFFICE
// AGENTS, PROJECTS, MODEL POOL, USAGE & LIMITS, APPROVALS, SYSTEM HEALTH.
// Built from the same durable state as the other views; credentials are only
// ever reported as present/absent.
export async function platformOverview({ db, env = process.env, now = () => Date.now(), workspaceId = null }) {
  const optional = async (promise, fallback) => {
    try {
      return await promise;
    } catch (error) {
      if (error.notInstalled) return fallback;
      throw error;
    }
  };
  const pool = await modelPoolSnapshot({ db, env, now, workspaceId });
  const since = new Date(now() - 72 * 3600_000).toISOString();
  const [sessions, approvals, projects, policy, lastEvent, lastCanary, supabaseGrants, officeEvents] = await Promise.all([
    workspaceId ? optional(rows(db.from('agent_sessions').select('id,title,status,phase,current_route,spent_usd,budget_usd,created_at,updated_at').eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(50)), []) : [],
    workspaceId ? optional(rows(db.from('agent_approvals').select('id,session_id,tool_name,risk,summary,requested_at').eq('workspace_id', workspaceId).eq('status', 'pending').order('requested_at', { ascending: true })), []) : [],
    optional(rows(db.from('projects').select('id,name').order('name', { ascending: true }).limit(50)), []),
    workspaceId ? optional(one(db.from('workspace_policies').select('enabled,monthly_budget_usd,spent_usd,reserved_usd,budget_period_end').eq('workspace_id', workspaceId).maybeSingle()), null) : null,
    optional(one(db.from('agent_events').select('created_at,type').order('id', { ascending: false }).limit(1).maybeSingle()), null),
    optional(one(db.from('provider_canary_runs').select('status,requested_at,completed_at').order('requested_at', { ascending: false }).limit(1).maybeSingle()), null),
    workspaceId ? optional(rows(db.from('workspace_tool_grants').select('tool_name,decision,enabled').eq('workspace_id', workspaceId).like('tool_name', 'supabase.%')), []) : [],
    optional(rows(db.from('events').select('job_id,task_id,type,level,message,payload,created_at')
      .in('payload->>kind', OFFICE_EVENT_KINDS).gte('created_at', since).order('created_at', { ascending: false }).limit(400)), []),
  ]);
  const officeJobIds = [...new Set(officeEvents.map((event) => event.job_id).filter(Boolean))].slice(0, 40);
  const officeJobs = officeJobIds.length ? await optional(rows(db.from('jobs').select('id,title,status,project_id,created_at').in('id', officeJobIds)), []) : [];
  const byStatus = {};
  for (const session of sessions) byStatus[session.status] = (byStatus[session.status] || 0) + 1;
  const routes = pool.routes;
  const count = (predicate) => routes.filter(predicate).length;
  const today = routes.reduce((sum, route) => ({
    requests: sum.requests + route.today.requests,
    tokens: sum.tokens + route.today.inputTokens + route.today.outputTokens,
    costUsd: Number((sum.costUsd + route.today.estimatedCostUsd).toFixed(6)),
  }), { requests: 0, tokens: 0, costUsd: 0 });
  const live = (route) => route.status === 'LIVE';
  return {
    generatedAt: new Date(now()).toISOString(),
    codingAgent: {
      sessions: byStatus,
      recent: sessions.slice(0, 5).map((session) => ({ id: session.id, title: session.title, status: session.status, phase: session.phase, route: session.current_route, spentUsd: Number(session.spent_usd || 0), updatedAt: session.updated_at })),
      supabaseTools: {
        tokenConfigured: Boolean(String(env.CODING_SUPABASE_ACCESS_TOKEN || '').trim()),
        grants: supabaseGrants.map((grant) => ({ tool: grant.tool_name, decision: grant.decision, enabled: grant.enabled })),
        note: 'Reads run automatically through the read-only database role; writes and migrations always wait for your approval.',
        unavailableWithoutToken: String(env.CODING_SUPABASE_ACCESS_TOKEN || '').trim() ? [] : [
          'supabase_query — read-only SQL on allow-listed projects (automatic)',
          'supabase_execute — data changes (owner approval)',
          'supabase_apply_migration — schema migrations (owner approval)',
        ],
        requiredToken: 'Supabase personal access token (sbp_…), scoped to project zkzibipinjeswhdxnfgf with Database: Read-write; stored with sudo bash ops/set-secret.sh CODING_SUPABASE_ACCESS_TOKEN',
      },
    },
    office: officeActivity(officeEvents, officeJobs, { workspaceId }),
    officeAgents: OFFICE_ROLES.map((role) => ({
      id: role.id, label: role.label, status: role.status, job: role.job, purpose: role.purpose,
      liveModels: routes.filter((route) => live(route) && route.suitableJobs.includes(role.job)).map((route) => route.id),
      freeModels: routes.filter((route) => route.billingClass !== 'PAID' && route.configured && route.suitableJobs.includes(role.job)).map((route) => route.id),
    })),
    projects: projects.map((project) => ({ id: project.id, name: project.name, selected: project.id === workspaceId })),
    modelPool: {
      total: routes.length,
      live: count(live),
      rateLimited: count((route) => route.status === 'RATE LIMITED'),
      offline: count((route) => ['COOLDOWN', 'DEGRADED', 'UNSUITABLE'].includes(route.status)),
      notConfigured: count((route) => route.status === 'NOT CONFIGURED' || route.status === 'NOT READY'),
      free: count((route) => route.billingClass !== 'PAID'),
      codingOrder: routes.filter((route) => route.routingRank).toSorted((a, b) => a.routingRank - b.routingRank).map((route) => route.id),
    },
    usage: {
      today,
      budget: policy ? {
        monthlyUsd: Number(policy.monthly_budget_usd || 0), spentUsd: Number(policy.spent_usd || 0), reservedUsd: Number(policy.reserved_usd || 0),
        remainingUsd: Number(Math.max(0, Number(policy.monthly_budget_usd || 0) - Number(policy.spent_usd || 0) - Number(policy.reserved_usd || 0)).toFixed(6)),
        periodEnd: policy.budget_period_end, basis: 'workspace budget ledger (estimated from published prices)',
      } : null,
      cooling: routes.filter((route) => route.cooldownUntil).map((route) => ({ id: route.id, status: route.status, until: route.cooldownUntil })),
      freeQuota: routes.filter((route) => route.freeQuota && route.configured).map((route) => ({ id: route.id, ...route.freeQuota })),
    },
    approvals,
    systemHealth: {
      hub: 'ok',
      version: readDeployedVersion(),
      lastAgentActivityAt: lastEvent?.created_at || null,
      lastCanary: lastCanary ? { status: lastCanary.status, requestedAt: lastCanary.requested_at, completedAt: lastCanary.completed_at } : null,
      database: 'ok',
    },
  };
}

// ---------------------------------------------------------------- Office
export const OFFICE_EVENT_KINDS = ['model_stage_started', 'model_route', 'model_escalation', 'provider_switch', 'model_checkpoint', 'free_route_incident'];
const STAGE_ROLE = { chief_plan: 'Chief', chief_review: 'Chief review' };
const JOB_ROLE = { research: 'Research', content: 'Content', branding: 'Branding', seo: 'SEO', finance: 'Finance' };
const START_STAGE = { CHIEF_PLANNING: 'chief_plan', RESEARCH_WORKING: 'research', CHIEF_REVIEW_STARTED: 'chief_review' };

function roleName(stage, job) {
  return STAGE_ROLE[stage] || JOB_ROLE[job] || 'Specialist';
}

// What Office agents are actually doing, from the durable event log: the
// current stage of each role, and for completed jobs the real model path
// (with failovers and escalations) plus actual cost and the ESTIMATED cost
// of the previous paid route. No credentials or prompts are involved.
export function officeActivity(events, jobs = [], { workspaceId = null } = {}) {
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const inScope = events.filter((event) => !workspaceId || !jobById.get(event.job_id) || jobById.get(event.job_id).project_id === workspaceId);
  // Same-instant events keep their causal order: start, checkpoint, switch/escalation, result.
  const order = { model_stage_started: 0, model_checkpoint: 1, provider_switch: 2, model_escalation: 2, model_route: 3 };
  const chronological = inScope.toSorted((left, right) => String(left.created_at).localeCompare(String(right.created_at))
    || (order[left.payload?.kind] ?? 9) - (order[right.payload?.kind] ?? 9));
  const byJob = new Map();
  for (const event of chronological) {
    const payload = event.payload || {};
    const entry = byJob.get(event.job_id) || { jobId: event.job_id, title: jobById.get(event.job_id)?.title || 'Office job', status: jobById.get(event.job_id)?.status || null, stages: [], startedAt: event.created_at, lastActivityAt: event.created_at };
    entry.lastActivityAt = event.created_at;
    if (payload.kind === 'model_stage_started') {
      const stage = START_STAGE[payload.stage] || payload.stage;
      entry.stages.push({ taskId: event.task_id, stage, role: roleName(stage, payload.job), job: payload.job, dataClass: payload.data_class, status: 'WORKING', startedAt: event.created_at, lastActivityAt: event.created_at, events: [] });
    } else {
      const stageEntry = [...entry.stages].reverse().find((candidate) => candidate.taskId === event.task_id);
      if (stageEntry) {
        stageEntry.lastActivityAt = event.created_at;
        if (payload.kind === 'model_route') {
          Object.assign(stageEntry, {
            status: 'COMPLETED', routeId: payload.route_id, provider: payload.provider, model: payload.model, billingClass: String(payload.billing_class || '').toUpperCase(),
            tools: payload.tools_used || [], tokens: Number(payload.tokens_in || 0) + Number(payload.tokens_out || 0), costUsd: Number(payload.cost_usd || 0),
            path: (payload.path || []).map((step) => ({ routeId: step.routeId, billingClass: String(step.billingClass || '').toUpperCase(), turns: step.turns })),
            switches: payload.switches || [], escalations: payload.escalations || [], savings: payload.savings || null,
          });
        } else if (payload.kind === 'provider_switch') {
          stageEntry.events.push({ kind: 'switch', from: payload.fromProvider, to: payload.toProvider, code: payload.reason?.code || null, injected: Boolean(payload.injected || payload.reason?.injected) });
        } else if (payload.kind === 'model_escalation') {
          stageEntry.events.push({ kind: 'escalation', from: payload.from_route, code: payload.reason, injected: /^DRILL_/.test(payload.reason || '') });
        } else if (payload.kind === 'model_checkpoint') {
          stageEntry.events.push({ kind: 'checkpoint', sequence: payload.sequence });
        } else if (payload.kind === 'free_route_incident') {
          stageEntry.events.push({ kind: 'incident', route: payload.route, code: payload.incident, costUsd: Number(payload.cost_usd || 0) });
        }
      }
    }
    byJob.set(event.job_id, entry);
  }
  const recentJobs = [...byJob.values()].toSorted((left, right) => String(right.lastActivityAt).localeCompare(String(left.lastActivityAt)));
  const roles = {};
  for (const job of recentJobs) {
    for (const stage of [...job.stages].reverse()) {
      if (roles[stage.role]) continue;
      roles[stage.role] = { role: stage.role, status: stage.status, currentTask: job.title, jobId: job.jobId, job: stage.job, routeId: stage.routeId || null,
        provider: stage.provider || null, model: stage.model || null, billingClass: stage.billingClass || null, tools: stage.tools || [], tokens: stage.tokens || 0,
        costUsd: stage.costUsd || 0, startedAt: stage.startedAt, lastActivityAt: stage.lastActivityAt };
    }
  }
  const completedStages = recentJobs.flatMap((job) => job.stages.filter((stage) => stage.status === 'COMPLETED'));
  const actualUsd = completedStages.reduce((sum, stage) => sum + stage.costUsd, 0);
  const equivalentUsd = completedStages.reduce((sum, stage) => sum + Number(stage.savings?.paidEquivalentUsd || 0), 0);
  return {
    window: 'last 72 hours',
    roles: Object.values(roles),
    jobs: recentJobs.slice(0, 12),
    freeStages: completedStages.filter((stage) => stage.billingClass === 'FREE').length,
    promoStages: completedStages.filter((stage) => ['PROMO', 'INCLUDED'].includes(stage.billingClass)).length,
    // Free-route guard incidents: a free route that was billed or served
    // another model (recorded, charged, blocked 24 h, failed over).
    incidents: inScope.filter((event) => event.payload?.kind === 'free_route_incident').map((event) => ({
      at: event.created_at, jobId: event.job_id, route: event.payload.route, kind: event.payload.incident, costUsd: Number(event.payload.cost_usd || 0),
    })),
    paidStages: completedStages.filter((stage) => stage.billingClass === 'PAID').length,
    cost: {
      actualUsd: Number(actualUsd.toFixed(6)),
      paidEquivalentUsd: Number(equivalentUsd.toFixed(6)),
      estimatedSavingUsd: Number(Math.max(0, equivalentUsd - actualUsd).toFixed(6)),
      basis: 'ESTIMATE — the same tokens priced at the previous Office route (claude-sonnet-5 published list price)',
    },
  };
}

const REASON_TEXT = {
  CREDENTIAL_MISSING: 'API key not configured', PRICING_UNKNOWN: 'paid model without a known price',
  PROVIDER_RETIRED: 'provider retired', NOT_YET_QUALIFIED: 'free model not yet qualified (critical job)',
  NOT_QUALIFIED_FOR_CRITICAL_JOB: 'qualification not passed for critical work', REQUEST_ABOVE_FREE_TIER_LIMIT: 'request larger than the free tier allows',
  MODEL_NOT_CONFIGURED: 'model id not set', ENDPOINT_NOT_CONFIGURED: 'endpoint not set',
  WORKSPACE_NOT_AUTHORIZED: 'not authorized for this project', PRIVACY_NOT_APPROVED: 'not approved for private code',
  BELOW_QUALITY_FLOOR: 'below the coding quality floor', CONTEXT_TOO_LARGE: 'context window too small for this task',
  FAILED_THIS_TURN: 'failed this turn', EXCLUDED_BY_ROUTING_POLICY: 'excluded by routing policy',
  ROUTE_BUDGET_EXHAUSTED: 'route budget cap reached', PAID_ROUTE_NOT_ALLOWED: 'paid models not allowed',
  BUDGET_INSUFFICIENT: 'workspace budget insufficient', TOOL_CALLING_REQUIRED: 'no tool calling',
  STRUCTURED_OUTPUT_REQUIRED: 'no structured output', CONTEXT_WINDOW_TOO_SMALL: 'context window too small for coding',
};
export function explainReason(reason) {
  if (REASON_TEXT[reason]) return REASON_TEXT[reason];
  if (reason.startsWith('COOLDOWN_')) return `cooling down (${reason.slice(9).toLowerCase().replace(/_/g, ' ')})`;
  if (reason.startsWith('CAPABILITY_')) return `capability too low for coding (${reason.slice(11).toLowerCase().replace(/_/g, ' ')})`;
  if (reason.startsWith('CATALOG_')) return `provider catalog: ${reason.slice(8).toLowerCase().replace(/_/g, ' ')}`;
  if (reason.startsWith('QUALIFICATION_FAILED_')) return `failed qualification (${reason.slice(21).toLowerCase()})`;
  return reason.toLowerCase().replace(/_/g, ' ');
}

async function rpcRows(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw dbError(`Could not load ${name}`, error);
  return data || [];
}

function formatRemaining(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = String(Math.floor(total / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function publicSession(session) {
  if (!session) return null;
  const state = session.state || {};
  return {
    id: session.id,
    workspaceId: session.workspace_id,
    jobId: session.job_id,
    title: session.title,
    objective: session.objective,
    repository: session.repository,
    baseBranch: session.base_branch,
    workBranch: session.work_branch,
    status: session.status,
    phase: session.phase,
    plan: session.plan || [],
    nextAction: session.next_action,
    currentRoute: session.current_route,
    previousRoute: session.previous_route,
    providerSwitches: session.provider_switches,
    iteration: session.iteration,
    budgetUsd: Number(session.budget_usd || 0),
    spentUsd: Number(session.spent_usd || 0),
    tokens: Number(session.tokens_in || 0) + Number(session.tokens_out || 0),
    filesChanged: state.filesChanged || [],
    notes: state.notes || [],
    switches: state.switches || [],
    lastTest: state.lastTest ? { command: state.lastTest.command, exitCode: state.lastTest.exitCode, at: state.lastTest.at } : null,
    pr: state.pr || null,
    ci: state.ci || null,
    deploy: state.deploy || null,
    verify: state.verify || null,
    config: { deploy: session.config?.deploy || { mode: 'none' }, testCommand: session.config?.testCommand || null },
    result: session.result ? { summary: session.result.summary, report: session.result.report } : null,
    blocker: session.blocker,
    errorCode: session.error_code,
    cancelRequested: session.cancel_requested,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    completedAt: session.completed_at,
  };
}

function publicEvent(event) {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const safe = Object.fromEntries(Object.entries(payload).filter(([key]) => !/secret|token|credential|authorization|key|prompt/i.test(key)));
  return { id: event.id, type: event.type, level: event.level, message: event.message, payload: safe, createdAt: event.created_at };
}

function uuid(value, name) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw input(`${name} must be a UUID`);
  return value;
}

function input(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function dbError(message, error) {
  if (isMissingRelation(error)) return Object.assign(new Error('Coding Agent is not installed'), { notInstalled: true });
  const failure = new Error(`${message}: ${String(error.message || '').slice(0, 200)}`);
  failure.statusCode = /WORKSPACE_DISABLED|NOT_PENDING|42501/.test(error.message || '') ? 409 : 500;
  return failure;
}

function isMissingRelation(error) {
  return /does not exist|schema cache|PGRST20[0-9]|42P01|42883|Could not find the function/i.test(`${error?.message || ''} ${error?.code || ''}`);
}

async function rows(query) {
  const { data, error } = await query;
  if (error) throw dbError('Could not load Coding Agent state', error);
  return data || [];
}

async function one(query) {
  const { data, error } = await query;
  if (error) throw dbError('Could not load Coding Agent state', error);
  return data;
}

// ------------------------------------------------------------------ UI
// Injected into the existing Hub page script (the Hub keeps two scripts).
export const CODING_STYLE = '<style>.platform-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px;margin-top:16px}.platform-grid h3{margin:0 0 8px;font-size:12px;letter-spacing:.12em;color:var(--muted)}.platform-grid .wide{grid-column:1/-1}.platform-grid li{margin:4px 0}.platform-grid ul{padding-left:18px;margin:6px 0}.coding-view{position:fixed;inset:0 0 0 270px;background:#0a1020;z-index:4;overflow:auto;padding:24px 30px}.coding-view h2{margin:0 0 4px}.coding-grid{display:grid;grid-template-columns:minmax(260px,340px) 1fr;gap:18px;margin-top:16px}.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px}.card h3{margin:0 0 10px;font-size:14px}.session-item{display:block;width:100%;text-align:left;background:transparent;color:var(--ink);padding:9px;border-radius:9px;border:1px solid transparent}.session-item:hover,.session-item.active{background:#1b2943;border-color:var(--line)}.session-item small{display:block;color:var(--muted);margin-top:3px}.kv{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.kv .metric strong{font-size:12px}.pill{display:inline-block;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:700;background:#26375e;color:#cbd6ff}.pill.completed{background:#16432f;color:#8ff0c4}.pill.failed,.pill.cancelled{background:#4a2027;color:#ffb3b3}.pill.awaiting_approval,.pill.blocked{background:#4a3a18;color:#f5d68a}.feed{max-height:380px;overflow:auto;font-size:12px}.feed div{padding:6px 0;border-bottom:1px solid var(--line)}.feed .warning{color:#f5d68a}.feed .error{color:var(--danger);background:none;border:0;padding:6px 0;margin:0}.feed .success{color:var(--good)}.approval{border:1px solid #6b5a2a;background:#2a2412;border-radius:10px;padding:10px;margin-bottom:8px}.approval button{margin-right:6px;margin-top:6px;padding:6px 10px;border-radius:8px}.approve{background:#1f7a52;color:#fff}.reject{background:#7f3542;color:#fff}.report{white-space:pre-wrap;font-size:12px;background:#0d1525;border-radius:10px;padding:10px;max-height:340px;overflow:auto}.pool-table{width:100%;border-collapse:collapse;font-size:12px}.pool-table td,.pool-table th{border-bottom:1px solid var(--line);padding:7px 6px;text-align:left;vertical-align:top}.pool-table th{color:var(--muted);font-weight:600}.muted{color:var(--muted)}.row-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.ghost{background:transparent;border:1px solid var(--line);color:var(--ink);border-radius:9px;padding:7px 11px}.coding-form label{display:block;color:var(--muted);font-size:12px;margin-top:10px}.coding-form .field{margin-top:4px}.check{display:flex;gap:8px;align-items:center;margin-top:10px;color:var(--muted);font-size:12px}.approvals-badge{background:#b7791f;color:#1a1204;border-radius:999px;padding:2px 7px;font-size:11px;font-weight:800;margin-left:4px}@media(max-width:820px){.coding-view{inset:0;padding:16px}.coding-grid{grid-template-columns:1fr}.kv{grid-template-columns:repeat(2,1fr)}}</style>';

export const CODING_MARKUP = '<div id="platformView" class="coding-view hidden"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><div><h2>Fahad AI Platform</h2><div class="muted">One place for every agent, model, limit and approval. Free and included capacity is used first; paid models only when needed and within budget.</div></div><div class="row-actions" style="margin:0"><button id="platformRefresh" class="ghost">Refresh</button><button id="platformClose" class="ghost">Back to chat</button></div></div><div id="platformError" class="error hidden"></div><div id="platformBody" class="platform-grid"></div></div><div id="codingView" class="coding-view hidden"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><div><h2>Coding Agent</h2><div class="muted">Autonomous development: plan → edit → test → debug → PR → CI → deploy → verify. It keeps working across model switches and restarts.</div></div><div class="row-actions" style="margin:0"><button id="poolButton" class="ghost">Model pool</button><button id="codingClose" class="ghost">Back to chat</button></div></div><div id="codingError" class="error hidden"></div><div id="poolPanel" class="card hidden" style="margin-top:14px"></div><div class="coding-grid"><div><div class="card coding-form"><h3>New development task</h3><label>Repository<input id="cRepo" class="field" value="FahadTrail/fahad-ai-office"></label><label>Base branch<input id="cBase" class="field" value="main"></label><label>Development instruction<textarea id="cObjective" class="field" style="min-height:140px" placeholder="Paste the full specification…"></textarea></label><label>Budget (USD)<input id="cBudget" class="field" type="number" min="0.5" max="500" step="0.5" value="5"></label><label>Model routing<select id="cRouting" class="field"><option value="">Project default</option><option value="economy">Economy — free first, cheapest capable model</option><option value="balanced">Balanced — best model, then cheaper</option><option value="quality">Quality — strongest model first</option><option value="nopaid">Free / included only — never paid</option></select></label><label>Reasoning effort<select id="cEffort" class="field"><option value="">Model default</option><option value="low">Low — cheapest, simple tasks</option><option value="medium">Medium</option><option value="high">High — hard tasks</option></select></label><label>Supabase projects (optional; read automatically, writes need approval)<input id="cSupabase" class="field" placeholder="project ref, e.g. zkzibipinjeswhdxnfgf"></label><label>Test command (optional; auto-detected)<input id="cTest" class="field" placeholder="npm test"></label><div class="check"><input id="cDeploy" type="checkbox"><span>Merge &amp; deploy after CI passes (merge needs your approval unless your policy allows it)</span></div><label>Production health URL (optional)<input id="cVerify" class="field" placeholder="https://…/healthz"></label><button id="cStart" class="newchat" style="width:100%;margin-top:12px">Start Coding Agent</button></div><div class="card" style="margin-top:14px"><h3>Sessions</h3><div id="cSessions" class="muted">No sessions yet.</div></div></div><div id="cDetail" class="card"><div class="muted">Select or start a session. You can leave; the agent keeps working and this view updates live.</div></div></div></div>';

export const CODING_SCRIPT = String.raw`
  (function(){
    const codingView=document.getElementById('codingView');let codingSession='',codingPoll=null,poolOpen=false;
    const ws=()=>document.querySelector('.workspace-item.active')?.dataset.id||'';
    const usd=v=>'$'+Number(v||0).toFixed(4);
    const btn=document.createElement('button');btn.id='codingButton';btn.className='newchat';btn.style.background='linear-gradient(135deg,#34d399,#0e9f6e)';btn.innerHTML='⌘ Coding Agent <span id="approvalsBadge" class="approvals-badge hidden">0</span>';document.getElementById('newChat').after(btn);
    const cerr=m=>{const e=document.getElementById('codingError');e.textContent=m;e.classList.toggle('hidden',!m)};
    async function codingApi(p,o){try{return await api(p,o)}catch(e){if(/CODING_AGENT_NOT_INSTALLED/.test(e.message))throw new Error('The Coding Agent is not installed on this server yet (database migration and coding worker pending).');throw e}}
    async function openCoding(){document.getElementById('platformView')?.classList.add('hidden');codingView.classList.remove('hidden');document.querySelector('.sidebar')?.classList.remove('open');await loadSessions()}
    function closeCoding(){codingView.classList.add('hidden');clearInterval(codingPoll)}
    async function loadSessions(){if(!ws())return;try{cerr('');const d=await codingApi('./api/coding/sessions?workspaceId='+encodeURIComponent(ws()));document.getElementById('cSessions').innerHTML=(d.sessions||[]).map(s=>'<button class="session-item '+(s.id===codingSession?'active':'')+'" data-session="'+s.id+'"><strong>'+esc(s.title)+'</strong> <span class="pill '+esc(s.status)+'">'+esc(s.status)+'</span><small>'+esc(s.repository)+' · '+esc(s.phase)+' · '+new Date(s.createdAt).toLocaleString()+'</small></button>').join('')||'No sessions yet.';document.querySelectorAll('[data-session]').forEach(b=>b.onclick=()=>openSession(b.dataset.session));await loadApprovalsBadge()}catch(e){cerr(e.message)}}
    async function loadApprovalsBadge(){if(!ws())return;try{const d=await codingApi('./api/approvals?workspaceId='+encodeURIComponent(ws()));const n=(d.approvals||[]).length;const b=document.getElementById('approvalsBadge');b.textContent=String(n);b.classList.toggle('hidden',!n)}catch{}}
    async function startSession(){const objective=document.getElementById('cObjective').value.trim();if(objective.length<12)return cerr('Describe the development task (at least 12 characters).');const body={workspaceId:ws(),repository:document.getElementById('cRepo').value.trim(),baseBranch:document.getElementById('cBase').value.trim()||'main',objective,budgetUsd:Number(document.getElementById('cBudget').value||5),deploy:document.getElementById('cDeploy').checked};const rt=document.getElementById('cRouting').value;const ef=document.getElementById('cEffort').value;body.routing={};if(rt==='nopaid')body.routing.allowPaid=false;else if(rt)body.routing.strategy=rt;if(ef)body.routing.effort=ef;const t=document.getElementById('cTest').value.trim();if(t)body.testCommand=t;const sp=document.getElementById('cSupabase').value.split(/[\s,]+/).filter(Boolean);if(sp.length)body.supabaseProjects=sp;const v=document.getElementById('cVerify').value.trim();if(v){body.verifyUrl=v}document.getElementById('cStart').disabled=true;try{cerr('');const d=await codingApi('./api/coding/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});document.getElementById('cObjective').value='';await loadSessions();await openSession(d.session.id)}catch(e){cerr(e.message)}finally{document.getElementById('cStart').disabled=false}}
    async function openSession(id){codingSession=id;clearInterval(codingPoll);await renderSession();codingPoll=setInterval(renderSession,4000);document.querySelectorAll('[data-session]').forEach(b=>b.classList.toggle('active',b.dataset.session===id))}
    async function decide(id,decision){try{await codingApi('./api/approvals/'+id,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision})});await renderSession();await loadApprovalsBadge()}catch(e){cerr(e.message)}}
    async function sessionAction(action){try{await codingApi('./api/coding/sessions/'+codingSession+'/'+action,{method:'POST'});await renderSession()}catch(e){cerr(e.message)}}
    async function renderSession(){if(!codingSession)return;try{const d=await codingApi('./api/coding/sessions/'+codingSession);const s=d.session;const pending=(d.approvals||[]).filter(a=>a.status==='pending');
      const plan=(s.plan||[]).map(p=>'<div>'+(p.status==='done'?'✓':p.status==='in_progress'?'▶':'○')+' '+esc(p.title)+'</div>').join('')||'<div class="muted">No plan yet.</div>';
      const lifecycle=[['PR',s.pr?'<a href="'+esc(s.pr.url)+'" target="_blank" rel="noopener">#'+esc(s.pr.number)+'</a>':'—'],['CI',s.ci?esc(s.ci.state):'—'],['Deploy',s.deploy?esc(s.deploy.status):(s.config.deploy.mode==='merge'?'pending':'not requested')],['Verify',s.verify?(s.verify.ok?'passed':'failed'):'—']];
      document.getElementById('cDetail').innerHTML='<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><div><h3 style="margin:0">'+esc(s.title)+'</h3><div class="muted">'+esc(s.repository)+' · '+esc(s.workBranch||s.baseBranch)+'</div></div><span class="pill '+esc(s.status)+'">'+esc(s.status.replace('_',' '))+'</span></div>'
        +(s.blocker?'<div class="error">'+esc(s.blocker)+'</div>':'')
        +pending.map(a=>'<div class="approval"><strong>Approval needed ('+esc(a.risk)+')</strong><div>'+esc(a.summary)+'</div><button class="approve" data-approve="'+a.id+'">Approve</button><button class="reject" data-reject="'+a.id+'">Reject</button></div>').join('')
        +'<div class="kv" style="margin-top:12px"><div class="metric">Phase<strong>'+esc(s.phase)+'</strong></div><div class="metric">Model<strong>'+esc(s.currentRoute||'—')+'</strong></div><div class="metric">Switches<strong>'+s.providerSwitches+'</strong></div><div class="metric">Iteration<strong>'+s.iteration+'</strong></div><div class="metric">Cost<strong>'+usd(s.spentUsd)+' / $'+s.budgetUsd+'</strong></div><div class="metric">Tokens<strong>'+Number(s.tokens).toLocaleString()+'</strong></div><div class="metric">Tests<strong>'+(s.lastTest?('exit '+s.lastTest.exitCode):'—')+'</strong></div><div class="metric">Files<strong>'+(s.filesChanged||[]).length+'</strong></div></div>'
        +'<div class="kv" style="margin-top:8px">'+lifecycle.map(([k,v])=>'<div class="metric">'+k+'<strong>'+v+'</strong></div>').join('')+'</div>'
        +'<div class="row-actions">'+(['queued','running','awaiting_approval','blocked'].includes(s.status)?'<button class="ghost" data-act="cancel">Cancel</button>':'')+(s.status==='blocked'?'<button class="ghost" data-act="resume">Resume</button>':'')+'</div>'
        +'<details open style="margin-top:12px"><summary class="muted">Plan · next: '+esc(s.nextAction||'—')+'</summary>'+plan+'</details>'
        +'<details style="margin-top:8px"><summary class="muted">Files changed ('+(s.filesChanged||[]).length+')</summary>'+(s.filesChanged||[]).map(f=>'<div><code>'+esc(f)+'</code></div>').join('')+'</details>'
        +(s.switches.length?'<details style="margin-top:8px"><summary class="muted">Model switches</summary>'+s.switches.map(x=>'<div>'+esc(x.from||'—')+' → '+esc(x.to)+' ('+esc(x.reason)+')</div>').join('')+'</details>':'')
        +(s.result?.report?'<h3 style="margin-top:14px">Final report</h3><div class="report">'+esc(s.result.report)+'</div>':'')
        +'<h3 style="margin-top:14px">Live activity</h3><div class="feed">'+(d.events||[]).map(e=>'<div class="'+esc(e.level)+'">'+esc(new Date(e.createdAt).toLocaleTimeString())+' · <strong>'+esc(e.type)+'</strong> '+esc(e.message)+'</div>').join('')+'</div>';
      document.querySelectorAll('[data-approve]').forEach(b=>b.onclick=()=>decide(b.dataset.approve,'approved'));document.querySelectorAll('[data-reject]').forEach(b=>b.onclick=()=>decide(b.dataset.reject,'rejected'));document.querySelectorAll('[data-act]').forEach(b=>b.onclick=()=>sessionAction(b.dataset.act));
      if(['completed','failed','cancelled'].includes(s.status))clearInterval(codingPoll)}catch(e){cerr(e.message);clearInterval(codingPoll)}}
    async function togglePool(){const panel=document.getElementById('poolPanel');poolOpen=!poolOpen;panel.classList.toggle('hidden',!poolOpen);if(!poolOpen)return;await renderPool()}
    async function renderPool(){const panel=document.getElementById('poolPanel');panel.innerHTML='<div class="muted">Loading…</div>';try{const d=await codingApi('./api/model-pool'+(ws()?'?workspaceId='+encodeURIComponent(ws()):''));const lc=d.lastCanary;const r=d.routing||{};
      const canaryLine='<div class="row-actions" style="margin:0 0 10px"><button id="runCanary" class="ghost">Run live canary</button><span class="muted">'+(lc?('Last canary: '+esc(lc.status)+(lc.report?(' · verified: '+esc((lc.report.routes||[]).filter(x=>x.ok).map(x=>x.id).join(', ')||'none')+' · failover drill: '+(lc.report.failover?.ok?('passed'+(lc.report.failover.crossProvider?' ('+esc(lc.report.failover.primary)+' → '+esc(lc.report.failover.backup)+')':' (same provider)')):'not passed')+(lc.report.totalCostUsd!=null?' · cost '+usd(lc.report.totalCostUsd)+' ESTIMATED':'')):'')+' · '+new Date(lc.requested_at).toLocaleString()):'No live canary has run yet.')+'</span></div>';
      const routingForm='<div class="row-actions" style="margin:0 0 10px;flex-wrap:wrap"><span class="muted">Project routing:</span><select id="rStrategy" class="field" style="width:auto">'+['economy','balanced','quality'].map(v=>'<option value="'+v+'"'+(r.strategy===v?' selected':'')+'>'+v+'</option>').join('')+'</select><label class="check" style="margin:0"><input id="rPaid" type="checkbox"'+(r.allowPaid!==false?' checked':'')+'><span>allow paid models</span></label><button id="rSave" class="ghost">Save</button><span class="muted">Priority: '+esc((d.billingPriority||[]).join(' → '))+' · source: '+esc(r.source||'defaults')+'</span></div>';
      const cls=s=>/^LIVE/.test(s)?'completed':/RATE|COOLDOWN|DEGRADED|UNSUITABLE/.test(s)?'blocked':/NOT/.test(s)?'cancelled':'queued';
      const provCls=s=>/^LIVE/.test(s)?'completed':/BLOCKED|LIMITED/.test(s)?'blocked':/RETIRED/.test(s)?'cancelled':'queued';
      const providers='<h3 style="margin:6px 0">Providers</h3><div style="overflow:auto"><table class="pool-table"><tr><th>Provider</th><th>Status</th><th>Offer</th><th>Models</th><th>Credential</th><th>Blocker</th><th>Free tier (checked '+esc(d.factsChecked||'')+')</th></tr>'+(d.providers||[]).map(p=>'<tr><td><strong>'+esc(p.label)+'</strong></td><td><span class="pill '+provCls(p.status)+'">'+esc(p.status)+'</span></td><td>'+esc(p.offer)+'</td><td>'+p.models+' model(s) · '+p.liveModels+' live · '+p.qualifiedModels+' qualified</td><td>'+(p.credential?esc(p.credential.env)+'<br><span class="muted">'+esc(p.credential.status)+'</span>':'—')+'</td><td>'+(p.blocker?'<strong>'+esc(p.blocker.label)+'</strong><br><span class="muted">'+esc(p.blocker.text)+'</span>':'—')+'</td><td class="muted">'+esc(p.freeTier||'')+(p.source?' <a href="'+esc(p.source)+'" target="_blank" rel="noopener">source</a>':'')+'</td></tr>').join('')+'</table></div><h3 style="margin:12px 0 6px">Models</h3>';
      panel.innerHTML=canaryLine+routingForm+providers+'<div style="overflow:auto"><table class="pool-table"><tr><th>#</th><th>Provider / model</th><th>Status</th><th>Class</th><th>Qualification / Office jobs</th><th>Coding</th><th>Today</th><th>Lifetime (est.)</th><th>Quota / limits</th><th>Last success / error</th><th>Active</th><th>Private code</th><th>Why excluded (coding)</th></tr>'+(d.routes||[]).map(x=>'<tr><td>'+(x.routingRank||'–')+'</td><td><strong>'+esc(x.provider)+'</strong>'+(x.discovered?' <span class="muted">(free catalog)</span>':'')+(x.freeOnly?' <span class="muted">free-only</span>':'')+'<br><span class="muted">'+esc(x.model||'model not set')+'</span></td><td><span class="pill '+cls(x.status)+'">'+esc(x.status)+'</span><br><span class="muted">'+esc(x.integration)+'</span>'+(x.authorizedForProject===false?'<br><span class="muted">not authorized for this project</span>':'')+(x.cooldownUntil?'<br><span class="muted">cooldown until '+new Date(x.cooldownUntil).toLocaleTimeString()+'</span>':'')+(x.accountBlocker?'<br><strong>'+esc(x.accountBlocker.label)+'</strong>':'')+'<br><span class="muted">credential: '+esc(x.credentialStatus||'')+'</span></td><td>'+esc(x.billingClass)+(x.requestTokenLimit?'<br><span class="muted">≤'+Math.round(x.requestTokenLimit/1000)+'K tok/request</span>':'')+'</td><td>'+esc((x.qualification||{}).status||'')+((x.qualification||{}).passed!=null?' ('+x.qualification.passed+'/'+x.qualification.total+')':'')+((x.qualification||{}).testedAt?'<br><span class="muted">'+new Date(x.qualification.testedAt).toLocaleDateString()+'</span>':'')+((x.officeJobs||[]).length?'<br><span class="muted">'+esc(x.officeJobs.join(', '))+'</span>':'')+'</td><td>'+(x.toolCalling?'tools':'text only')+' · '+Math.round(x.contextWindow/1000)+'K<br><span class="muted">'+esc(x.codingSuitability)+'</span>'+((x.suitableJobs||[]).length?'<br><span class="muted">jobs: '+esc(x.suitableJobs.join(', '))+'</span>':'')+'</td><td>'+x.today.requests+' req'+(x.today.failures?' ('+x.today.failures+' failed)':'')+'<br><span class="muted">'+(x.today.inputTokens+x.today.outputTokens).toLocaleString()+' tok · '+usd(x.today.estimatedCostUsd)+'</span></td><td>'+(x.usage?(x.usage.requests+' req · '+usd(x.usage.estimatedCostUsd)):'<span class="muted">no traffic yet</span>')+(x.budgetCap?'<br><span class="muted">cap '+usd(x.budgetCap.spentThisPeriodUsd)+' / $'+x.budgetCap.monthlyUsd+'</span>':'')+'</td><td>'+(x.quota.exact?(x.quota.requestsRemaining+'/'+x.quota.requestsLimit+' req in window'+(x.quota.resetsAt?'<br><span class="muted">resets '+new Date(x.quota.resetsAt).toLocaleTimeString()+'</span>':'')):'<span class="muted">'+esc(x.quota.label)+'</span>')+(x.freeQuota?'<br><span class="muted">free: '+(x.freeQuota.requestsRemaining!=null?('≈'+x.freeQuota.requestsRemaining+' req left ('+esc(x.freeQuota.basis)+')'):esc(x.freeQuota.basis))+(x.freeQuota.published.requestsPerDay?' · published '+x.freeQuota.published.requestsPerDay+'/day':'')+(x.freeQuota.nextResetAt?' · resets '+new Date(x.freeQuota.nextResetAt).toLocaleString():' · '+esc(x.freeQuota.resetKind)+' window')+(x.freeQuota.estimatedExhaustionAt?' · est. exhausted '+new Date(x.freeQuota.estimatedExhaustionAt).toLocaleTimeString():'')+'</span>':'')+'</td><td>'+(x.lastSuccessAt?new Date(x.lastSuccessAt).toLocaleString():'—')+'<br><span class="muted">'+esc(x.lastErrorCode||'')+'</span></td><td>'+x.activeTasks+'</td><td>'+(x.privateCode==='APPROVED'?'approved':'<span class="muted">public data only</span>')+'</td><td class="muted">'+esc((x.excludedBecause||[]).join('; ')||'—')+'</td></tr>').join('')+'</table></div>'+(d.openRouter?'<details style="margin-top:10px"><summary class="muted">OpenRouter free models — '+d.openRouter.freeModels+' free on OpenRouter'+(d.openRouter.accessibleFreeModels!=null?', '+d.openRouter.accessibleFreeModels+' accessible to this key':'')+', '+d.openRouter.admitted.length+' admitted · discovered '+new Date(d.openRouter.fetchedAt).toLocaleString()+'</summary><div class="muted">'+esc(d.openRouter.note)+' Source: '+esc(d.openRouter.source)+'.</div><table class="pool-table"><tr><th>Model</th><th>Context</th><th>Tools</th><th>Admitted</th><th>Why not</th></tr>'+d.openRouter.models.map(o=>'<tr><td>'+esc(o.id)+'</td><td>'+Math.round(o.contextLength/1000)+'K</td><td>'+(o.tools?'yes':'no')+'</td><td>'+(o.admitted?'yes':'no')+'</td><td class="muted">'+esc((o.reasons||[]).join(', ').toLowerCase().replace(/_/g,' '))+'</td></tr>').join('')+'</table></details>':'')+'<p class="muted">LIVE = a real call succeeded (canary or traffic). Quota is shown only when a provider reports it; otherwise EXACT QUOTA NOT AVAILABLE. Costs are estimates from token counts and published list prices — the provider console is authoritative. Routing order: '+esc((d.billingPriority||[]).join(' → '))+', then '+esc(r.strategy||'economy')+'.</p>';
      const rc=document.getElementById('runCanary');if(rc)rc.onclick=async()=>{rc.disabled=true;try{await codingApi('./api/model-pool/canary',{method:'POST'});rc.textContent='Queued — runs within a minute';}catch(e){cerr(e.message)}};
      const rs=document.getElementById('rSave');if(rs)rs.onclick=async()=>{if(!ws())return cerr('Select a project first.');rs.disabled=true;try{await codingApi('./api/model-pool/routing',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({workspaceId:ws(),strategy:document.getElementById('rStrategy').value,allowPaid:document.getElementById('rPaid').checked})});await renderPool()}catch(e){cerr(e.message);rs.disabled=false}}}catch(e){panel.innerHTML='<div class="error">'+esc(e.message)+'</div>'}}
    const pbtn=document.createElement('button');pbtn.id='platformButton';pbtn.className='newchat';pbtn.style.background='linear-gradient(135deg,#a78bfa,#6d28d9)';pbtn.textContent='◎ Platform';btn.after(pbtn);
    const platformView=document.getElementById('platformView');
    const perr=m=>{const e=document.getElementById('platformError');e.textContent=m;e.classList.toggle('hidden',!m)};
    const card=(title,body,wide)=>'<div class="card'+(wide?' wide':'')+'"><h3>'+title+'</h3>'+body+'</div>';
    async function renderPlatform(){const body=document.getElementById('platformBody');body.innerHTML='<div class="muted">Loading…</div>';try{perr('');const d=await codingApi('./api/platform'+(ws()?'?workspaceId='+encodeURIComponent(ws()):''));const c=d.codingAgent,m=d.modelPool,u=d.usage,h=d.systemHealth;
      const coding='<div class="kv">'+Object.entries(c.sessions).map(([k,v])=>'<div class="metric">'+esc(k.replace('_',' '))+'<strong>'+v+'</strong></div>').join('')+'</div>'+(c.recent.length?'<ul>'+c.recent.map(r=>'<li>'+esc(r.title)+' — <span class="pill '+esc(r.status)+'">'+esc(r.status)+'</span> <span class="muted">'+esc(r.route||'')+' · '+usd(r.spentUsd)+'</span></li>').join('')+'</ul>':'<div class="muted">No sessions in this project yet.</div>')+'<div class="muted">Supabase tools: '+(c.supabaseTools.tokenConfigured?'token configured':'READY — CREDENTIAL REQUIRED')+' · '+esc(c.supabaseTools.grants.map(g=>g.tool.replace('supabase.','')+'='+g.decision).join(', ')||'no grants')+'</div><button class="ghost" id="pOpenCoding" style="margin-top:8px">Open Coding Agent</button>';
      const o=d.office||{roles:[],jobs:[],cost:{}};const money=v=>'$'+Number(v||0).toFixed(4);const cls2=b=>b==='FREE'?'completed':b==='PAID'?'blocked':'queued';
      const rolesTable=o.roles.length?'<div style="overflow:auto"><table class="pool-table"><tr><th>Role</th><th>Status</th><th>Current task</th><th>Job type</th><th>Model</th><th>Provider</th><th>Free/Paid</th><th>Tools</th><th>Tokens</th><th>Cost</th><th>Started</th><th>Last activity</th></tr>'+o.roles.map(r=>'<tr><td><strong>'+esc(r.role)+'</strong></td><td><span class="pill '+(r.status==='COMPLETED'?'completed':'running')+'">'+esc(r.status)+'</span></td><td>'+esc(r.currentTask)+'</td><td>'+esc(r.job||'—')+'</td><td>'+esc(r.model||'routing…')+'</td><td>'+esc(r.provider||'—')+'</td><td>'+(r.billingClass?'<span class="pill '+cls2(r.billingClass)+'">'+esc(r.billingClass)+'</span>':'—')+'</td><td>'+esc((r.tools||[]).join(', ')||'—')+'</td><td>'+Number(r.tokens||0).toLocaleString()+'</td><td>'+money(r.costUsd)+'</td><td>'+new Date(r.startedAt).toLocaleString()+'</td><td>'+new Date(r.lastActivityAt).toLocaleTimeString()+'</td></tr>').join('')+'</table></div>':'<div class="muted">No Office work in the last 72 hours.</div>';
      const stageLine=st=>{const main=(st.path&&st.path.length?st.path:[{routeId:st.routeId||'routing…',billingClass:st.billingClass||''}]);const trail=[];(st.path||[]).forEach((p,i)=>{if(i>0){const ev=(st.events||[]).filter(e=>e.kind!=='checkpoint')[i-1];trail.push(ev?(ev.kind==='switch'?'→ '+esc(ev.code||'failure')+(ev.injected?' (SIMULATED)':' (genuine)')+' → checkpoint → ':'→ escalated ('+esc(ev.code)+(ev.injected?', SIMULATED':'')+') → checkpoint → '):'→ ')}trail.push('<strong>'+esc(p.routeId)+'</strong> '+esc(p.billingClass))});return '<div style="margin:3px 0"><strong>'+esc(st.role)+'</strong> <span class="muted">('+esc(st.job||'')+')</span>: '+(trail.length?trail.join(' '):esc(main[0].routeId))+' '+(st.status==='COMPLETED'?'✓':'<span class="muted">working…</span>')+'</div>'};
      const jobsList=o.jobs.length?o.jobs.map(j=>'<details style="margin-top:6px"><summary><strong>'+esc(j.title)+'</strong> <span class="muted">'+esc(j.status||'')+' · '+new Date(j.lastActivityAt).toLocaleString()+'</span></summary>'+j.stages.map(stageLine).join('<div class="muted" style="margin-left:12px">↓</div>')+'</details>').join(''):'';
      const office='<div class="kv"><div class="metric">Free stages<strong>'+(o.freeStages||0)+'</strong></div><div class="metric">Paid stages<strong>'+(o.paidStages||0)+'</strong></div><div class="metric">Actual cost<strong>'+money(o.cost.actualUsd)+'</strong></div><div class="metric">Paid-route equivalent (est.)<strong>'+money(o.cost.paidEquivalentUsd)+'</strong></div><div class="metric">Estimated saving<strong>'+money(o.cost.estimatedSavingUsd)+'</strong></div><div class="metric">Free-route incidents<strong>'+((o.incidents||[]).length)+'</strong></div></div><div class="muted" style="margin:6px 0">'+esc(o.cost.basis||'')+'</div>'+((o.incidents||[]).length?'<div class="error" style="margin:6px 0">'+o.incidents.map(i=>esc(i.route)+' — '+esc(i.kind==='paid_on_free_route'?'billed '+money(i.costUsd)+' on a free route':'served a different model')+' · blocked 24 h, step moved on ('+new Date(i.at).toLocaleString()+')').join('<br>')+'</div>':'')+rolesTable+jobsList+'<details style="margin-top:8px"><summary class="muted">Role registry</summary><ul>'+d.officeAgents.map(a=>'<li><strong>'+esc(a.label)+'</strong> — '+esc(a.status)+'<br><span class="muted">'+esc(a.purpose)+' · job '+esc(a.job)+' · free candidates: '+esc(a.freeModels.join(', ')||'none')+'</span></li>').join('')+'</ul></details>';
      const projects=d.projects.length?'<ul>'+d.projects.map(p=>'<li>'+(p.selected?'<strong>':'')+esc(p.name)+(p.selected?'</strong> (selected)':'')+'</li>').join('')+'</ul>':'<div class="muted">No projects.</div>';
      const pool='<div class="kv"><div class="metric">Live<strong>'+m.live+'/'+m.total+'</strong></div><div class="metric">Rate limited<strong>'+m.rateLimited+'</strong></div><div class="metric">Offline<strong>'+m.offline+'</strong></div><div class="metric">Not configured<strong>'+m.notConfigured+'</strong></div><div class="metric">Free / included<strong>'+m.free+'</strong></div></div><div class="muted" style="margin-top:8px">Coding order now: '+esc(m.codingOrder.join(' → ')||'no eligible model')+'</div><button class="ghost" id="pOpenPool" style="margin-top:8px">Open model pool</button>';
      const b=u.budget;const usage='<div class="kv"><div class="metric">Requests today<strong>'+u.today.requests+'</strong></div><div class="metric">Tokens today<strong>'+Number(u.today.tokens).toLocaleString()+'</strong></div><div class="metric">Cost today (est.)<strong>'+usd(u.today.costUsd)+'</strong></div>'+(b?'<div class="metric">Budget left<strong>'+usd(b.remainingUsd)+' / $'+b.monthlyUsd+'</strong></div>':'')+'</div>'+(u.cooling.length?'<div style="margin-top:8px">Cooling down: '+u.cooling.map(x=>esc(x.id)+' until '+new Date(x.until).toLocaleString()).join('; ')+'</div>':'')+(u.freeQuota.length?'<ul>'+u.freeQuota.map(q=>'<li>'+esc(q.id)+': '+(q.requestsRemaining!=null?'≈'+q.requestsRemaining+' requests left':'EXACT QUOTA NOT AVAILABLE')+' <span class="muted">('+esc(q.basis)+(q.nextResetAt?' · resets '+new Date(q.nextResetAt).toLocaleString():'')+')</span></li>').join('')+'</ul>':'<div class="muted" style="margin-top:8px">No free-tier provider is configured yet.</div>');
      const approvals=d.approvals.length?d.approvals.map(a=>'<div class="approval"><strong>'+esc(a.tool_name)+' ('+esc(a.risk)+')</strong><div>'+esc(a.summary)+'</div><button class="approve" data-papprove="'+a.id+'">Approve</button><button class="reject" data-preject="'+a.id+'">Reject</button></div>').join(''):'<div class="muted">Nothing waiting for you.</div>';
      const health='<ul><li>Hub: '+esc(h.hub)+' · version '+esc(h.version||'unknown')+'</li><li>Database: '+esc(h.database)+'</li><li>Last agent activity: '+(h.lastAgentActivityAt?new Date(h.lastAgentActivityAt).toLocaleString():'none yet')+'</li><li>Last provider canary: '+(h.lastCanary?esc(h.lastCanary.status)+' · '+new Date(h.lastCanary.requestedAt).toLocaleString():'never')+'</li></ul>';
      body.innerHTML=card('CODING AGENT',coding)+card('APPROVALS',approvals)+card('MODEL POOL',pool)+card('USAGE &amp; LIMITS',usage)+card('OFFICE AGENTS',office,true)+card('PROJECTS',projects)+card('SYSTEM HEALTH',health);
      document.getElementById('pOpenCoding').onclick=()=>{closePlatform();openCoding()};document.getElementById('pOpenPool').onclick=async()=>{closePlatform();await openCoding();if(!poolOpen)await togglePool()};
      document.querySelectorAll('[data-papprove]').forEach(x=>x.onclick=()=>pdecide(x.dataset.papprove,'approved'));document.querySelectorAll('[data-preject]').forEach(x=>x.onclick=()=>pdecide(x.dataset.preject,'rejected'))}catch(e){body.innerHTML='';perr(e.message)}}
    async function pdecide(id,decision){try{await codingApi('./api/approvals/'+id,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision})});await renderPlatform();await loadApprovalsBadge()}catch(e){perr(e.message)}}
    function openPlatform(){closeCoding();platformView.classList.remove('hidden');document.querySelector('.sidebar')?.classList.remove('open');renderPlatform()}
    function closePlatform(){platformView.classList.add('hidden')}
    pbtn.onclick=openPlatform;document.getElementById('platformClose').onclick=closePlatform;document.getElementById('platformRefresh').onclick=renderPlatform;
    btn.onclick=openCoding;document.getElementById('codingClose').onclick=closeCoding;document.getElementById('cStart').onclick=startSession;document.getElementById('poolButton').onclick=togglePool;
    window.addEventListener('hub-workspace-changed',()=>{codingSession='';if(!codingView.classList.contains('hidden'))loadSessions();else loadApprovalsBadge()});
    setInterval(loadApprovalsBadge,30000);
  })();`;
