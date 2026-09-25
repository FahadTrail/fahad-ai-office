import { createServer } from 'node:http';
import { URL } from 'node:url';
import {
  CHIEF_MODEL,
  DEEPSEEK_MODEL,
  KIMI_MODEL,
  MINIMAX_MODEL,
  MODEL_GATEWAY_ALLOWED_PROVIDERS,
  QWEN_MODEL,
  ZHIPU_MODEL,
} from './config.js';

const DEFAULT_PORT = 2132;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_HISTORY_ROWS = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_RE = /^\d{6}$/;

export function createHubServer({ db, authClient = db?.auth, store, host = process.env.HUB_BIND || '127.0.0.1', port = Number(process.env.HUB_PORT || DEFAULT_PORT), accessToken = process.env.HUB_ACCESS_TOKEN || '', authEnabled = process.env.HUB_AUTH_ENABLED === 'true', ownerEmail = process.env.HUB_OWNER_EMAIL || '' } = {}) {
  if (!db || !store) throw new TypeError('Hub server requires the existing database and store');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('HUB_PORT must be a valid TCP port');
  if (authEnabled && !EMAIL_RE.test(ownerEmail)) throw new TypeError('HUB_OWNER_EMAIL must be configured when HUB_AUTH_ENABLED=true');
  const authRequired = Boolean(accessToken) || !isLoopback(host) || authEnabled;

  return createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
      if (request.method === 'OPTIONS') return send(response, 204, '');
      if (request.method === 'GET' && requestUrl.pathname === '/healthz') {
        return sendJson(response, 200, { ok: true, service: 'fahad-ai-hub', now: new Date().toISOString() });
      }
      if (request.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html')) {
        return send(response, 200, HUB_HTML, 'text/html; charset=utf-8');
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/auth/config') {
        return sendJson(response, 200, { ok: true, enabled: authEnabled, emailHint: authEnabled ? maskEmail(ownerEmail) : null });
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/auth/request-otp') {
        return requestOtp({ authClient, request, response, authEnabled, ownerEmail });
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/auth/verify-otp') {
        return verifyOtp({ authClient, request, response, authEnabled, ownerEmail });
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/auth/logout') {
        response.setHeader('set-cookie', clearSessionCookie());
        return sendJson(response, 200, { ok: true });
      }
      if (!requestUrl.pathname.startsWith('/api/')) return sendJson(response, 404, { ok: false, error: 'NOT_FOUND' });
      if (authRequired && !(await authorized(request, accessToken, { authClient, authEnabled, ownerEmail }))) {
        return sendJson(response, 401, { ok: false, error: authEnabled ? 'HUB_UNAUTHORIZED' : 'HUB_AUTH_NOT_CONFIGURED' });
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/workspaces') {
        const workspaces = await listWorkspaces(db);
        return sendJson(response, 200, { ok: true, workspaces });
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/model-catalog') {
        const workspaceId = requestUrl.searchParams.get('workspaceId');
        if (workspaceId) {
          const id = requireUuid(workspaceId, 'workspaceId');
          if (!await readWorkspace(db, id)) return sendJson(response, 404, { ok: false, error: 'WORKSPACE_NOT_FOUND' });
          return sendJson(response, 200, { ok: true, models: modelCatalog(await readModelPermissions(db, id)) });
        }
        return sendJson(response, 200, { ok: true, models: modelCatalog([]) });
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/usage') {
        const workspaceId = requireUuid(requestUrl.searchParams.get('workspaceId'), 'workspaceId');
        const workspace = await readWorkspace(db, workspaceId);
        if (!workspace) return sendJson(response, 404, { ok: false, error: 'WORKSPACE_NOT_FOUND' });
        return sendJson(response, 200, { ok: true, usage: await usageSnapshot(db, workspaceId) });
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/workspaces') {
        const body = await readJson(request);
        const name = normalizeWorkspaceName(body.name);
        const workspace = await createWorkspace(db, name);
        return sendJson(response, 201, { ok: true, workspace });
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/jobs') {
        const workspaceId = requireUuid(requestUrl.searchParams.get('workspaceId'), 'workspaceId');
        const workspace = await readWorkspace(db, workspaceId);
        if (!workspace) return sendJson(response, 404, { ok: false, error: 'WORKSPACE_NOT_FOUND' });
        const limit = Math.min(MAX_HISTORY_ROWS, Math.max(1, Number(requestUrl.searchParams.get('limit') || 30)));
        const jobs = await listJobs(db, workspaceId, limit);
        return sendJson(response, 200, { ok: true, jobs });
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/jobs') {
        const body = await readJson(request);
        const workspaceId = requireUuid(body.workspaceId, 'workspaceId');
        const goal = normalizeGoal(body.goal);
        const workspace = await readWorkspace(db, workspaceId);
        if (!workspace) return sendJson(response, 404, { ok: false, error: 'WORKSPACE_NOT_FOUND' });
        const policy = await readPolicy(db, workspaceId);
        if (!policy?.enabled) return sendJson(response, 403, { ok: false, error: 'WORKSPACE_DISABLED' });
        const requestedProvider = typeof body.provider === 'string' ? body.provider : 'auto';
        if (requestedProvider !== 'auto') {
          const selected = modelCatalog(await readModelPermissions(db, workspaceId)).find((entry) => entry.provider === requestedProvider);
          if (!selected?.selectable) return sendJson(response, 403, { ok: false, error: 'MODEL_NOT_PERMITTED' });
        }
        const job = await store.createJob({ title: goal.slice(0, 120), goal, projectId: workspaceId, requestedProvider });
        return sendJson(response, 201, { ok: true, job: { id: job.id, title: job.title, goal: job.goal, status: job.status, workspaceId } });
      }
      const jobMatch = requestUrl.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)$/i);
      if (request.method === 'GET' && jobMatch) {
        const jobId = requireUuid(jobMatch[1], 'jobId');
        const snapshot = await readJobSnapshot(db, jobId);
        if (!snapshot) return sendJson(response, 404, { ok: false, error: 'JOB_NOT_FOUND' });
        return sendJson(response, 200, { ok: true, snapshot });
      }
      return sendJson(response, 404, { ok: false, error: 'NOT_FOUND' });
    } catch (error) {
      const status = error.statusCode || (error.code === 'INVALID_INPUT' ? 400 : 500);
      return sendJson(response, status, { ok: false, error: safeError(error) });
    }
  }).listen(port, host);
}

export async function listWorkspaces(db) {
  const { data, error } = await db.from('projects').select('id,name').order('name');
  if (error) throw new Error(`Could not load workspaces: ${error.message}`);
  return (data || []).map((workspace) => ({ id: workspace.id, name: workspace.name }));
}

export async function listJobs(db, workspaceId, limit = 30) {
  const { data, error } = await db.from('jobs')
    .select('id,title,status,progress,tokens_used,cost_usd,created_at,completed_at')
    .eq('project_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Could not load conversation history: ${error.message}`);
  return data || [];
}

export function modelCatalog(permissions = null) {
  const configured = new Set(MODEL_GATEWAY_ALLOWED_PROVIDERS);
  const permitted = permissions == null ? null : new Map(permissions.filter((row) => row.enabled).map((row) => [row.provider, row.models]));
  const provider = (name, model, label) => ({
    provider: name,
    model,
    label,
    state: configured.has(name) && (!permitted || permitted.get(name)?.includes(model)) ? 'active' : 'not_connected',
    selectable: Boolean(configured.has(name) && (!permitted || permitted.get(name)?.includes(model))),
    default: name === 'anthropic',
  });
  return [
    provider('anthropic', CHIEF_MODEL, 'Claude / Anthropic'),
    provider('deepseek', DEEPSEEK_MODEL, 'DeepSeek'),
    provider('qwen', QWEN_MODEL, 'Qwen'),
    provider('kimi', KIMI_MODEL, 'Kimi'),
    provider('zhipu', ZHIPU_MODEL, 'GLM / Zhipu'),
    provider('minimax', MINIMAX_MODEL, 'MiniMax'),
  ];
}

async function readModelPermissions(db, workspaceId) {
  return rows(db.from('workspace_provider_permissions').select('provider,models,enabled').eq('workspace_id', workspaceId));
}

export async function usageSnapshot(db, workspaceId, now = new Date()) {
  const [attempts, policy, jobs] = await Promise.all([
    rows(db.from('model_attempts').select('run_id,provider,model,status,input_tokens,output_tokens,reasoning_tokens,cached_input_tokens,cost_usd,started_at').eq('workspace_id', workspaceId).order('started_at', { ascending: false }).limit(5000)),
    readPolicy(db, workspaceId),
    rows(db.from('jobs').select('id').eq('project_id', workspaceId).limit(5000)),
  ]);
  const jobIds = (jobs || []).map((job) => job.id);
  const events = jobIds.length
    ? await rows(db.from('events').select('type,run_id,payload').in('job_id', jobIds).limit(5000))
    : [];
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const totals = { tokens: 0, costUsd: 0, todayUsd: 0, monthUsd: 0, requests: 0, successful: 0, failed: 0 };
  const byProvider = new Map();
  for (const attempt of attempts || []) {
    const input = Number(attempt.input_tokens || 0);
    const output = Number(attempt.output_tokens || 0);
    const reasoning = Number(attempt.reasoning_tokens || 0);
    const cached = Number(attempt.cached_input_tokens || 0);
    const cost = Number(attempt.cost_usd || 0);
    const started = attempt.started_at ? new Date(attempt.started_at) : null;
    const name = String(attempt.provider || 'unknown');
    const current = byProvider.get(name) || { provider: name, tokens: 0, costUsd: 0, requests: 0, successful: 0, failed: 0, models: {} };
    current.tokens += input + output + reasoning;
    current.costUsd += cost;
    current.requests += 1;
    if (attempt.status === 'succeeded') current.successful += 1;
    if (attempt.status === 'failed') current.failed += 1;
    const modelName = attempt.model || 'unknown';
    const modelUsage = current.models[modelName] || { model: modelName, requests: 0, tokens: 0, costUsd: 0 };
    modelUsage.requests += 1;
    modelUsage.tokens += input + output + reasoning;
    modelUsage.costUsd += cost;
    current.models[modelName] = modelUsage;
    byProvider.set(name, current);
    totals.tokens += input + output + reasoning;
    totals.costUsd += cost;
    totals.requests += 1;
    if (attempt.status === 'succeeded') totals.successful += 1;
    if (attempt.status === 'failed') totals.failed += 1;
    if (started && started >= monthStart) totals.monthUsd += cost;
    if (started && started >= dayStart) totals.todayUsd += cost;
    void cached;
  }
  totals.remainingUsd = policy ? Math.max(0, Number(policy.monthly_budget_usd || 0) - Number(policy.spent_usd || 0) - Number(policy.reserved_usd || 0)) : null;
  const switchedRuns = new Set((events || [])
    .filter((event) => event.type === 'provider_switch' || event.payload?.kind === 'provider_switch')
    .map((event) => event.run_id).filter(Boolean));
  const byRun = new Map();
  for (const attempt of [...(attempts || [])].reverse()) {
    if (!attempt.run_id) continue;
    const previous = byRun.get(attempt.run_id) || [];
    if (attempt.status === 'succeeded' && previous.some((entry) => entry.status === 'failed' && entry.provider !== attempt.provider)) {
      switchedRuns.add(attempt.run_id);
    }
    previous.push(attempt);
    byRun.set(attempt.run_id, previous);
  }
  return {
    totals,
    providers: [...byProvider.values()].map((entry) => ({ ...entry, models: Object.values(entry.models) })),
    fallbacks: switchedRuns.size,
    budget: policy ? {
      monthlyBudgetUsd: Number(policy.monthly_budget_usd),
      maxRequestBudgetUsd: Number(policy.max_request_budget_usd),
      spentUsd: Number(policy.spent_usd),
      reservedUsd: Number(policy.reserved_usd),
      remainingUsd: totals.remainingUsd,
      periodEnd: policy.budget_period_end,
    } : null,
  };
}

async function createWorkspace(db, name) {
  const { data, error } = await db.rpc('create_hub_project', { p_name: name });
  if (error) throw new Error(`Could not create workspace: ${error.message}`);
  return Array.isArray(data) ? data[0] : data;
}

export async function readJobSnapshot(db, jobId) {
  const job = await one(db.from('jobs').select('id,title,goal,status,priority,requested_provider,project_id,tokens_used,cost_usd,final_summary,created_at').eq('id', jobId).maybeSingle(), 'job');
  if (!job) return null;
  const [workspace, tasks, events, attempts, toolExecutions, policy, runs] = await Promise.all([
    readWorkspace(db, job.project_id),
    rows(db.from('tasks').select('id,title,status,progress,attempts,max_attempts,agent_id,sequence,started_at,created_at').eq('job_id', jobId).order('sequence')),
    rows(db.from('events').select('id,type,level,message,payload,task_id,run_id,agent_id,created_at').eq('job_id', jobId).order('created_at', { ascending: false }).limit(100)),
    rows(db.from('model_attempts').select('id,task_id,run_id,provider,model,status,attempt_no,provider_attempt,input_tokens,output_tokens,reasoning_tokens,cost_usd,duration_ms,error_code,failure_class,started_at,ended_at').eq('job_id', jobId).order('started_at')),
    rows(db.from('tool_executions').select('id,task_id,run_id,agent_id,broker,tool_name,action,risk,decision,status,attempt_count,retry_count,duration_ms,cost_usd,error_code,started_at,ended_at').eq('job_id', jobId).order('started_at')),
    readPolicy(db, job.project_id),
    rows(db.from('runs').select('id,task_id,agent_id,model,status,attempt_no,started_at,ended_at').eq('job_id', jobId).order('started_at')),
  ]);
  const taskIds = (tasks || []).map((task) => task.id);
  const results = taskIds.length
    ? await rows(db.from('results').select('task_id,summary,content,created_at').in('task_id', taskIds).order('created_at'))
    : [];
  const agentIds = [...new Set((tasks || []).map((task) => task.agent_id).filter(Boolean))];
  const agents = agentIds.length
    ? await rows(db.from('agents').select('id,slug,name').in('id', agentIds))
    : [];
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const resultByTask = new Map((results || []).map((result) => [result.task_id, result]));
  return {
    job: { ...job, workspaceId: job.project_id, project_id: undefined },
    workspace,
    policy: policy ? {
      enabled: policy.enabled,
      monthlyBudgetUsd: Number(policy.monthly_budget_usd),
      maxRequestBudgetUsd: Number(policy.max_request_budget_usd),
      spentUsd: Number(policy.spent_usd),
      reservedUsd: Number(policy.reserved_usd),
      budgetPeriodEnd: policy.budget_period_end,
    } : null,
    tasks: (tasks || []).map((task) => ({ ...task, agent: agentById.get(task.agent_id) || null, result: resultByTask.get(task.id) ? { summary: resultByTask.get(task.id).summary, content: resultByTask.get(task.id).content } : null })),
    runs: runs || [],
    events: (events || []).map(safeEvent),
    attempts: attempts || [],
    toolExecutions: [
      ...(toolExecutions || []),
      ...(events || []).filter((event) => event.type === 'activity' && event.payload?.kind === 'host_tool' && event.payload.status !== 'started')
        .map((event) => ({
          id: event.id, task_id: event.task_id, run_id: event.run_id, agent_id: event.agent_id,
          broker: 'model-host', tool_name: event.payload.tool, action: 'invoke', risk: 'low',
          decision: 'auto', status: event.payload.status, duration_ms: event.payload.duration_ms,
          started_at: event.created_at, ended_at: event.created_at,
        })),
    ],
  };
}

async function readWorkspace(db, id) {
  if (!id) return null;
  const { data, error } = await db.from('projects').select('id,name').eq('id', id).maybeSingle();
  if (error) throw new Error(`Could not load workspace: ${error.message}`);
  return data;
}

async function readPolicy(db, workspaceId) {
  if (!workspaceId) return null;
  const { data, error } = await db.from('workspace_policies').select('enabled,monthly_budget_usd,max_request_budget_usd,spent_usd,reserved_usd,budget_period_end').eq('workspace_id', workspaceId).maybeSingle();
  if (error) throw new Error(`Could not load workspace policy: ${error.message}`);
  return data;
}

async function rows(query) {
  const { data, error } = await query;
  if (error) throw new Error(`Could not load Hub state: ${error.message}`);
  return data || [];
}

async function one(query, label) {
  const { data, error } = await query;
  if (error) throw new Error(`Could not load ${label}: ${error.message}`);
  return data;
}

async function authorized(request, token, { authClient, authEnabled, ownerEmail }) {
  if (token) {
    const value = request.headers.authorization || '';
    return value.startsWith('Bearer ') && value.slice(7) === token;
  }
  if (!authEnabled) return true;
  const sessionToken = readCookie(request, 'hub_session');
  if (!sessionToken) return false;
  try {
    const { data, error } = await authClient.getUser(sessionToken);
    return !error && data?.user?.email?.toLowerCase() === ownerEmail.toLowerCase();
  } catch {
    return false;
  }
}

async function requestOtp({ authClient, request, response, authEnabled, ownerEmail }) {
  if (!authEnabled) return sendJson(response, 404, { ok: false, error: 'AUTH_DISABLED' });
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  if (email !== ownerEmail.toLowerCase()) return sendJson(response, 403, { ok: false, error: 'EMAIL_NOT_ALLOWED' });
  const { error } = await authClient.signInWithOtp({ email, options: { shouldCreateUser: false } });
  if (error) throw new Error(`Could not send verification code: ${error.message}`);
  return sendJson(response, 200, { ok: true, message: 'Verification code sent' });
}

async function verifyOtp({ authClient, request, response, authEnabled, ownerEmail }) {
  if (!authEnabled) return sendJson(response, 404, { ok: false, error: 'AUTH_DISABLED' });
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (email !== ownerEmail.toLowerCase()) return sendJson(response, 403, { ok: false, error: 'EMAIL_NOT_ALLOWED' });
  if (!OTP_RE.test(token)) throw inputError('Verification code must contain 6 digits');
  const { data, error } = await authClient.verifyOtp({ email, token, type: 'email' });
  const userEmail = data?.user?.email?.toLowerCase();
  if (error || !data?.session?.access_token || userEmail !== ownerEmail.toLowerCase()) {
    return sendJson(response, 401, { ok: false, error: 'INVALID_OTP' });
  }
  response.setHeader('set-cookie', sessionCookie(data.session.access_token));
  return sendJson(response, 200, { ok: true, user: { email: userEmail } });
}

function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.length > 254) throw inputError('Enter a valid email address');
  return email;
}

function normalizeWorkspaceName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length < 2 || name.length > 80) throw inputError('Workspace name must contain 2 to 80 characters');
  if (/\0/.test(name)) throw inputError('Workspace name contains an invalid character');
  return name;
}

function maskEmail(email) {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

function readCookie(request, name) {
  const header = request.headers.cookie || '';
  const entry = header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}

function sessionCookie(value) {
  return `hub_session=${encodeURIComponent(value)}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax; Secure`;
}

function clearSessionCookie() {
  return 'hub_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure';
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw inputError('Request body is too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw inputError('Request body must be valid JSON'); }
}

function normalizeGoal(value) {
  const goal = typeof value === 'string' ? value.trim() : '';
  if (goal.length < 3 || goal.length > 8000) throw inputError('Goal must contain 3 to 8000 characters');
  if (/\0/.test(goal)) throw inputError('Goal contains an invalid character');
  return goal;
}

function requireUuid(value, name) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw inputError(`${name} must be a UUID`);
  return value;
}

function inputError(message) {
  const error = new Error(message);
  error.code = 'INVALID_INPUT';
  error.statusCode = 400;
  return error;
}

function safeEvent(event) {
  return { id: event.id, type: event.type, level: event.level, message: event.message, payload: safePayload(event.payload), taskId: event.task_id, runId: event.run_id, agentId: event.agent_id, createdAt: event.created_at };
}

function safePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const blocked = /prompt|content|secret|token|credential|authorization|key/i;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !blocked.test(key)).map(([key, entry]) => [key, typeof entry === 'string' ? entry.slice(0, 500) : entry]));
}

function safeError(error) {
  return String(error?.message || 'Hub request failed').replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/\b(?:sk[-_]|ghp_|github_pat_)[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]').slice(0, 300);
}

function send(response, status, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(body);
}

function sendJson(response, status, body) { send(response, status, JSON.stringify(body), 'application/json; charset=utf-8'); }
function isLoopback(host) { return host === '127.0.0.1' || host === '::1' || host === 'localhost'; }

const BASE_HUB_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>Fahad AI Office</title>
<style>
:root{--ink:#e8edf7;--muted:#8c98ad;--panel:#121a29;--panel2:#172235;--line:#26334a;--accent:#7c9cff;--accent2:#4f6fe8;--good:#6ee7b7;--danger:#ff9a9a}*{box-sizing:border-box}body{margin:0;background:#0a1020;color:var(--ink);font:14px Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}button,input,textarea,select{font:inherit}button{cursor:pointer;border:0}.shell{min-height:100vh;display:grid;grid-template-columns:270px 1fr;background:radial-gradient(900px 500px at 75% -10%,#21356955,transparent 65%),#0a1020}.sidebar{border-right:1px solid var(--line);padding:18px 14px;display:flex;flex-direction:column;gap:16px;background:#0d1525cc}.brand{display:flex;align-items:center;gap:10px;padding:4px 8px}.brandmark{width:30px;height:30px;border-radius:10px;background:linear-gradient(135deg,#9fb4ff,#536ee8);display:grid;place-items:center;font-weight:800;color:#091126}.brand strong{display:block;font-size:15px}.brand small{color:var(--muted);font-size:11px}.newchat,.send{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border-radius:11px;padding:11px 14px;font-weight:700}.side-title{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.12em;padding:0 8px}.workspace-list,.history{display:flex;flex-direction:column;gap:5px;overflow:auto}.workspace-item,.history-item{padding:9px 10px;border-radius:9px;color:#bdc7d8;text-align:left;background:transparent;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.workspace-item:hover,.workspace-item.active,.history-item:hover,.history-item.active{background:#1b2943;color:#fff}.history-item small{display:block;color:var(--muted);margin-top:3px}.side-bottom{margin-top:auto;display:flex;justify-content:space-between;align-items:center;color:var(--muted);font-size:12px;padding:8px}.link{color:var(--muted);background:none;padding:0}.main{min-width:0;display:flex;flex-direction:column;height:100vh}.topbar{height:64px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 30px}.topbar .context{display:flex;align-items:center;gap:9px}.dot{width:8px;height:8px;border-radius:50%;background:var(--good);box-shadow:0 0 0 4px #6ee7b71c}.status{font-size:12px;color:var(--muted)}.content{width:min(980px,100%);margin:0 auto;padding:34px 30px 36px;display:flex;flex-direction:column;gap:20px;flex:1;overflow:auto}.welcome{margin:auto 0 0;text-align:center}.welcome h1{font-size:32px;letter-spacing:-.03em;margin:0 0 8px}.welcome p{color:var(--muted);margin:0}.composer{background:var(--panel);border:1px solid var(--line);border-radius:17px;padding:14px;box-shadow:0 16px 50px #0003}.composer textarea{width:100%;min-height:78px;resize:vertical;border:0;outline:0;background:transparent;color:var(--ink);line-height:1.55}.composer-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--muted);font-size:12px}.send{padding:9px 15px}.send:disabled{opacity:.55;cursor:wait}.conversation{display:flex;flex-direction:column;gap:14px}.bubble{max-width:85%;padding:13px 15px;border-radius:15px;line-height:1.55;white-space:pre-wrap}.bubble.user{align-self:flex-end;background:#26375e}.bubble.office{align-self:flex-start;background:var(--panel2);border:1px solid var(--line)}.progress{border:1px solid var(--line);background:var(--panel);border-radius:14px;padding:14px}.progress-head{display:flex;justify-content:space-between;gap:12px;align-items:center}.badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;background:#26375e;color:#cbd6ff;padding:5px 9px;font-size:11px;font-weight:700}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:12px}.metric{background:#0d1525;border-radius:10px;padding:9px;color:var(--muted);font-size:11px}.metric strong{display:block;color:var(--ink);font-size:13px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.taskline{padding:9px 0;border-bottom:1px solid var(--line)}.taskline:last-child{border:0}.taskline small{display:block;color:var(--muted);margin-top:3px}.details{margin-top:10px}.details summary{color:var(--muted);cursor:pointer;font-size:12px}.event{padding:7px 0;border-bottom:1px solid var(--line);font-size:12px}.event small{display:block;color:var(--muted);margin-top:2px}.error{color:var(--danger);background:#4a2027;border:1px solid #7f3542;padding:10px;border-radius:10px;margin-top:10px}.modal{position:fixed;inset:0;background:#050914aa;display:grid;place-items:center;padding:20px;z-index:10}.modal-card{width:min(430px,100%);background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:26px;box-shadow:0 24px 80px #0008}.modal-card h2{margin:0 0 8px}.modal-card p{color:var(--muted);line-height:1.5}.field{width:100%;border:1px solid var(--line);background:#0c1424;color:var(--ink);border-radius:10px;padding:11px 12px;outline:0;margin-top:12px}.field:focus{border-color:var(--accent)}.modal-card button{width:100%;margin-top:12px}.hidden{display:none!important}@media(max-width:820px){.shell{grid-template-columns:1fr}.sidebar{display:none}.topbar{padding:0 18px}.content{padding:22px 16px}.metrics{grid-template-columns:repeat(2,1fr)}.welcome h1{font-size:27px}}
</style></head><body>
<div id="login" class="modal hidden"><div class="modal-card"><div class="brand"><div class="brandmark">F</div><div><strong>Fahad AI Office</strong><small>Private workspace</small></div></div><h2 id="loginTitle">Welcome back</h2><p id="loginHint">Sign in with your email. We will send a one-time verification code.</p><input id="email" class="field" type="email" autocomplete="email" placeholder="you@example.com"><input id="otp" class="field hidden" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit code"><button id="authButton" class="newchat">Send verification code</button><div id="authError" class="error hidden"></div></div></div>
<div id="projectPrompt" class="modal hidden"><div class="modal-card"><h2>Create project</h2><p>A private workspace with the existing approved models, tools, and a conservative budget.</p><input id="projectName" class="field" aria-label="Project name" maxlength="80" placeholder="Project name"><div id="projectPromptError" class="error hidden"></div><button id="projectCreate" class="newchat">Create project</button><button id="projectCancel" class="link">Cancel</button></div></div>
<div id="app" class="shell hidden"><aside class="sidebar"><div class="brand"><div class="brandmark">F</div><div><strong>Fahad AI Office</strong><small>Chief-led workspace</small></div></div><button id="newChat" class="newchat">＋ New chat</button><div class="side-title">Projects</div><div id="workspaces" class="workspace-list"></div><button id="newWorkspace" class="link">＋ Create project</button><div class="side-title">Chat history</div><input id="search" class="field" style="margin:0" placeholder="Search conversations"><div id="history" class="history"></div><div class="side-bottom"><span id="userLabel">Private owner</span><button id="logout" class="link">Sign out</button></div></aside><main class="main"><header class="topbar"><div class="context"><span class="dot"></span><span id="workspaceLabel">Choose a project</span></div><span id="health" class="status">Connecting…</span></header><section class="content"><div id="welcome" class="welcome"><h1>What should we work on?</h1><p>Give the Chief a goal. Your agents, tools and model routing stay behind the scenes.</p></div><div id="conversation" class="conversation"></div><div id="progress" class="progress hidden"><div class="progress-head"><strong>Live execution</strong><span id="jobStatus" class="badge">Preparing</span></div><div id="route" class="status" style="margin-top:8px">Chief is preparing your task…</div><div class="metrics"><div class="metric">Agent<strong id="agent">—</strong></div><div class="metric">Model<strong id="model">—</strong></div><div class="metric">Cost<strong id="cost">$0.0000</strong></div><div class="metric">Tools<strong id="tools">0</strong></div></div><details class="details"><summary>Show handoffs, checkpoints and routing</summary><div id="tasks"></div><div id="events"></div></details></div><div id="formError" class="error hidden"></div><div class="composer"><textarea id="goal" placeholder="Tell the Chief what you want to accomplish…"></textarea><div class="composer-footer"><span>Auto by default · approval for high-risk actions</span><button id="submit" class="send">Send to Chief&nbsp; ↑</button></div></div></section></main></div>
<script>
const $=id=>document.getElementById(id);let authEnabled=false,email='',workspaceId='',jobId='',poll=null,historyRows=[];
async function api(path,options={}){const r=await fetch(path,{credentials:'same-origin',...options});let d={};try{d=await r.json()}catch{}if(!r.ok)throw new Error(d.error||'Request failed');return d}
async function boot(){try{const config=await api('./api/auth/config');authEnabled=Boolean(config.enabled);if(authEnabled){try{await api('./api/workspaces');enterApp()}catch{$('login').classList.remove('hidden');$('email').focus()}}else{enterApp()}}catch(e){showAuthError(e.message)}}
function authErrorMessage(error){const message=String(error?.message||'');if(/email rate limit|rate limit exceeded/i.test(message)){return 'Email delivery is temporarily rate-limited. Please wait before requesting another code.'}if(/signups not allowed/i.test(message)){return 'Email sign-in is temporarily unavailable for this workspace.'}return message||'Could not complete sign-in.'}
async function sendOtp(){email=$('email').value.trim();if(!email){return showAuthError('Enter your email address.')}setAuthBusy(true);try{await api('./api/auth/request-otp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});$('otp').classList.remove('hidden');$('otp').focus();$('loginTitle').textContent='Check your email';$('loginHint').textContent='Enter the six-digit code we sent to '+email;$('authButton').textContent='Enter workspace';hideAuthError()}catch(e){showAuthError(authErrorMessage(e))}finally{setAuthBusy(false)}}
async function verifyOtp(){const token=$('otp').value.trim();if(!/^\d{6}$/.test(token)){return showAuthError('Enter the six-digit verification code.')}setAuthBusy(true);try{await api('./api/auth/verify-otp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,token})});$('login').classList.add('hidden');enterApp()}catch(e){showAuthError(authErrorMessage(e))}finally{setAuthBusy(false)}}
function setAuthBusy(v){$('authButton').disabled=v;$('authButton').textContent=v?'Working…':($('otp').classList.contains('hidden')?'Send verification code':'Enter workspace')}
function enterApp(){$('app').classList.remove('hidden');loadWorkspaces()}
async function loadWorkspaces(){try{const d=await api('./api/workspaces');$('workspaces').innerHTML=(d.workspaces||[]).map(w=>'<button class="workspace-item '+(w.id===workspaceId?'active':'')+'" data-id="'+w.id+'">'+esc(w.name)+'</button>').join('')||'<div class="status">No projects yet.</div>';document.querySelectorAll('.workspace-item').forEach(b=>b.onclick=()=>selectWorkspace(b.dataset.id));if(!workspaceId&&d.workspaces?.[0])selectWorkspace(d.workspaces[0].id);$('health').textContent='Ready'}catch(e){if(authEnabled){$('app').classList.add('hidden');$('login').classList.remove('hidden')}showError(e.message)}}
async function selectWorkspace(id){workspaceId=id;const b=document.querySelector('[data-id="'+id+'"]');$('workspaceLabel').textContent=b?.textContent||'Project';document.querySelectorAll('.workspace-item').forEach(x=>x.classList.toggle('active',x.dataset.id===id));await loadHistory();newChat()}
async function loadHistory(){try{const d=await api('./api/jobs?workspaceId='+encodeURIComponent(workspaceId));historyRows=d.jobs||[];renderHistory()}catch(e){showError(e.message)}}
function renderHistory(){const q=$('search').value.trim().toLowerCase();$('history').innerHTML=historyRows.filter(j=>!q||j.title.toLowerCase().includes(q)).map(j=>'<button class="history-item '+(j.id===jobId?'active':'')+'" data-job="'+j.id+'">'+esc(j.title)+'<small>'+esc(j.status)+' · '+new Date(j.created_at).toLocaleDateString()+'</small></button>').join('')||'<div class="status">No conversations yet.</div>';document.querySelectorAll('[data-job]').forEach(b=>b.onclick=()=>openJob(b.dataset.job))}
function newChat(){jobId='';clearInterval(poll);$('welcome').classList.remove('hidden');$('conversation').innerHTML='';$('progress').classList.add('hidden');$('goal').value='';renderHistory()}
function createWorkspace(){$('projectName').value='';$('projectPromptError').classList.add('hidden');$('projectPrompt').classList.remove('hidden');$('projectName').focus()}
function closeProjectPrompt(){$('projectPrompt').classList.add('hidden')}
async function saveWorkspace(){const name=$('projectName').value.trim();if(name.length<2){$('projectPromptError').textContent='Enter at least two characters.';$('projectPromptError').classList.remove('hidden');return}$('projectCreate').disabled=true;try{const d=await api('./api/workspaces',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name})});closeProjectPrompt();await loadWorkspaces();await selectWorkspace(d.workspace.id)}catch(e){$('projectPromptError').textContent=e.message;$('projectPromptError').classList.remove('hidden')}finally{$('projectCreate').disabled=false}}
async function submit(){if(!workspaceId)return showError('Choose or create a project first.');const goal=$('goal').value.trim();if(goal.length<3)return showError('Tell the Chief what you want to accomplish.');$('submit').disabled=true;hideError();$('welcome').classList.add('hidden');addBubble(goal,'user');try{const d=await api('./api/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workspaceId,goal})});jobId=d.job.id;$('goal').value='';$('progress').classList.remove('hidden');await refresh();clearInterval(poll);poll=setInterval(refresh,4000);await loadHistory()}catch(e){showError(e.message)}finally{$('submit').disabled=false}}
async function openJob(id){jobId=id;$('welcome').classList.add('hidden');$('progress').classList.remove('hidden');try{await refresh();clearInterval(poll);poll=setInterval(refresh,4000)}catch(e){showError(e.message)}}
async function refresh(){if(!jobId)return;try{const d=await api('./api/jobs/'+jobId);render(d.snapshot);if(['completed','failed','cancelled'].includes(d.snapshot.job.status)){clearInterval(poll);await loadHistory()}}catch(e){clearInterval(poll);showError(e.message)}}
function render(s){const attempts=s.attempts||[],latest=attempts[attempts.length-1],running=(s.tasks||[]).find(t=>t.status==='running'),done=(s.tasks||[]).filter(t=>t.status==='done'&&t.result).at(-1);$('jobStatus').textContent=(s.job.status||'working').toUpperCase();$('route').textContent=running?((running.agent?.name||'Agent')+' is working'):(s.job.status==='completed'?'Final result ready':'Chief is coordinating your task…');$('agent').textContent=running?.agent?.name||latest?.stage||'Chief';$('model').textContent=latest?(latest.provider+' / '+latest.model):'—';$('cost').textContent='$'+Number(s.job.cost_usd||0).toFixed(4);$('tools').textContent=String((s.toolExecutions||[]).length);$('tasks').innerHTML=(s.tasks||[]).map(t=>'<div class="taskline"><strong>'+esc(t.title)+'</strong> <span class="badge">'+esc(t.status)+'</span><small>'+esc(t.agent?.name||'Agent')+' · '+(t.progress||0)+'%</small></div>').join('');$('events').innerHTML=(s.events||[]).slice(0,24).map(e=>'<div class="event"><strong>'+esc(e.message)+'</strong><small>'+new Date(e.createdAt).toLocaleString()+'</small></div>').join('');const final=s.job.status==='completed'?(done?.result?.content||s.job.final_summary):'';if(final){addBubble(final,'office');$('progress').classList.add('hidden')}}
function addBubble(text,kind){const key=kind+':'+text;if([...$('conversation').children].some(x=>x.dataset.key===key))return;const d=document.createElement('div');d.className='bubble '+kind;d.dataset.key=key;d.textContent=text;$('conversation').appendChild(d);d.scrollIntoView({block:'end',behavior:'smooth'})}
async function logout(){await api('./api/auth/logout',{method:'POST'}).catch(()=>{});location.reload()}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function showError(v){$('formError').textContent=v;$('formError').classList.remove('hidden')}function hideError(){$('formError').classList.add('hidden')}function showAuthError(v){$('authError').textContent=v;$('authError').classList.remove('hidden')}function hideAuthError(){$('authError').classList.add('hidden')}
$('authButton').onclick=()=> $('otp').classList.contains('hidden')?sendOtp():verifyOtp();$('email').onkeydown=e=>{if(e.key==='Enter')sendOtp()};$('otp').onkeydown=e=>{if(e.key==='Enter')verifyOtp()};$('submit').onclick=submit;$('newChat').onclick=newChat;$('newWorkspace').onclick=createWorkspace;$('projectCreate').onclick=saveWorkspace;$('projectCancel').onclick=closeProjectPrompt;$('projectName').onkeydown=e=>{if(e.key==='Enter')saveWorkspace();if(e.key==='Escape')closeProjectPrompt()};$('search').oninput=renderHistory;$('logout').onclick=logout;boot();
</script></body></html>`;

export const HUB_HTML = BASE_HUB_HTML
  .replace("if(!workspaceId&&d.workspaces?.[0])selectWorkspace(d.workspaces[0].id);", "const saved=localStorage.getItem('hub-workspace-id');const preferred=d.workspaces?.find(w=>w.id===saved);if(!workspaceId&&preferred)selectWorkspace(preferred.id);else if(!workspaceId&&d.workspaces?.[0])selectWorkspace(d.workspaces[0].id);")
  .replace("async function selectWorkspace(id){workspaceId=id;", "async function selectWorkspace(id){workspaceId=id;localStorage.setItem('hub-workspace-id',id);")
  .replace("document.querySelectorAll('.workspace-item').forEach(x=>x.classList.toggle('active',x.dataset.id===id));await loadHistory();", "document.querySelectorAll('.workspace-item').forEach(x=>x.classList.toggle('active',x.dataset.id===id));window.dispatchEvent(new Event('hub-workspace-changed'));await loadHistory();")
  .replace("body:JSON.stringify({workspaceId,goal})", "body:JSON.stringify({workspaceId,goal,provider:document.getElementById('modelSelect')?.value||'auto'})")
  .replace("async function openJob(id){jobId=id;", "async function openJob(id){jobId=id;$('conversation').innerHTML='';")
  .replace("function render(s){const attempts", "function render(s){if(s.job?.goal)addBubble(s.job.goal,'user');const attempts")
  .replace('</head>', '<style>.top-controls{display:flex;align-items:center;gap:10px}.model-select,.project-select{border:1px solid var(--line);border-radius:999px;background:var(--panel);color:var(--ink);padding:7px 12px;max-width:200px}.menu-button{display:none;background:transparent;color:var(--ink);font-size:20px}.usage-button{border:1px solid var(--line);background:transparent;color:var(--muted);border-radius:999px;padding:7px 11px}.usage-panel{position:fixed;right:24px;top:74px;width:min(420px,calc(100vw - 32px));max-height:calc(100vh - 100px);overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px;z-index:5;box-shadow:0 18px 60px #0008}.usage-panel h3{margin:0 0 10px}.provider-row{display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid var(--line)}.provider-row small{display:block;color:var(--muted);margin-top:3px}.provider-state{font-size:11px;color:var(--good)}.provider-state.off{color:var(--muted)}.usage-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin:10px 0}.usage-grid .metric{background:#0d1525}.fallback-note{color:#f5c97a;font-size:12px;margin-top:8px}@media(max-width:820px){.sidebar{display:flex;position:fixed;inset:0 auto 0 0;width:min(300px,85vw);z-index:8;background:#0d1525;transform:translateX(-105%);transition:transform .2s}.sidebar.open{transform:translateX(0)}.menu-button{display:inline-flex}.project-select{max-width:150px}.model-select{max-width:150px}.topbar{gap:8px;flex-wrap:wrap;height:auto;min-height:64px;padding:8px 14px}.top-controls{gap:5px;margin-left:auto}.top-controls .status{display:none}}@media(max-width:480px){.project-select,.model-select{max-width:125px}}</style></head>')
  .replace('<div class="context"><span class="dot"></span><span id="workspaceLabel">Choose a project</span></div><span id="health" class="status">Connecting…</span>', '<div class="context"><span class="dot"></span><span id="workspaceLabel">Choose a project</span></div><div class="top-controls"><select id="modelSelect" class="model-select" aria-label="Model routing"><option value="auto">AUTO</option></select><button id="usageButton" class="usage-button">AI usage</button><span id="health" class="status">Connecting…</span></div>')
  .replace('<div class="context"><span class="dot"></span>', '<div class="context"><button id="sidebarToggle" class="menu-button" aria-label="Open sidebar">☰</button><span class="dot"></span>')
  .replace('<span id="workspaceLabel">Choose a project</span>', '<select id="projectSelect" class="project-select" aria-label="Project"><option value="">Choose a project</option></select><span id="workspaceLabel" class="hidden">Choose a project</span>')
  .replace('<div id="login" class="modal hidden">', '<div id="usagePanel" class="usage-panel hidden"></div><div id="login" class="modal hidden">')
  .replace('</body>', () => `<script>
  const modelSelect=document.getElementById('modelSelect');
  const usageButton=document.getElementById('usageButton');
  const usagePanel=document.getElementById('usagePanel');
  const projectSelect=document.getElementById('projectSelect');
  const sidebar=document.querySelector('.sidebar');
  const syncProjects=()=>{const items=[...document.querySelectorAll('#workspaces .workspace-item')];projectSelect.replaceChildren(new Option('Choose a project',''),...items.map(item=>new Option(item.textContent,item.dataset.id)));projectSelect.value=items.find(item=>item.classList.contains('active'))?.dataset.id||''};
  new MutationObserver(syncProjects).observe(document.getElementById('workspaces'),{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
  projectSelect.onchange=()=>{document.querySelector('#workspaces .workspace-item[data-id="'+projectSelect.value+'"]')?.click();sidebar.classList.remove('open')};
  document.getElementById('sidebarToggle').onclick=()=>sidebar.classList.toggle('open');
  document.addEventListener('click',event=>{if(event.target.closest('.workspace-item,.history-item,#newChat,#newWorkspace'))sidebar.classList.remove('open')});
  syncProjects();
  const workspaceIdFromUi=()=>document.querySelector('.workspace-item.active')?.dataset.id||'';
  const money=value=>{const n=Number(value||0);return '$'+n.toFixed(n>0&&n<0.01?6:2)};
  async function loadModelCatalog(){const workspaceId=workspaceIdFromUi();const previous=modelSelect.value;try{const data=await api('./api/model-catalog'+(workspaceId?'?workspaceId='+encodeURIComponent(workspaceId):''));modelSelect.innerHTML='<option value="auto">AUTO · policy routed</option>'+(data.models||[]).map(m=>'<option value="'+esc(m.provider)+'" '+(m.selectable?'':'disabled')+'>'+esc(m.label)+' · '+(m.state==='active'?(m.provider==='deepseek'?'Chief only; web research uses Claude':'Available'):'Not available here')+'</option>').join('');modelSelect.value=[...modelSelect.options].some(o=>o.value===previous&&!o.disabled)?previous:'auto';}catch{modelSelect.innerHTML='<option value="auto">AUTO · policy routed</option>'}}
  async function loadUsagePanel(){const workspaceId=workspaceIdFromUi();if(!workspaceId){usagePanel.innerHTML='<h3>AI usage</h3><p class="status">Choose a project to view usage.</p>';return}try{const [data,catalog]=await Promise.all([api('./api/usage?workspaceId='+encodeURIComponent(workspaceId)),api('./api/model-catalog?workspaceId='+encodeURIComponent(workspaceId))]);const u=data.usage||{};const t=u.totals||{};const rows=(u.providers||[]).map(p=>'<div class="provider-row"><div><strong>'+esc(p.provider)+'</strong><small>'+p.tokens.toLocaleString()+' tokens · '+p.requests+' requests</small><small>'+(p.models||[]).map(m=>esc(m.model)+': '+m.tokens.toLocaleString()+' tokens · '+money(m.costUsd)).join('<br>')+'</small></div><div><span>'+money(p.costUsd)+'</span><small class="provider-state">'+p.successful+' succeeded · '+p.failed+' failed</small></div></div>').join('');const states=(catalog.models||[]).map(m=>'<div class="provider-row"><span>'+esc(m.label)+'</span><span class="provider-state '+(m.state==='active'?'':'off')+'">'+(m.state==='active'?'Available':'Inactive')+'</span></div>').join('');usagePanel.innerHTML='<h3>AI usage</h3><div class="usage-grid"><div class="metric">Today<strong>'+money(t.todayUsd)+'</strong></div><div class="metric">This month<strong>'+money(t.monthUsd)+'</strong></div><div class="metric">Tokens<strong>'+Number(t.tokens||0).toLocaleString()+'</strong></div><div class="metric">Requests<strong>'+t.requests+'</strong></div><div class="metric">Fallbacks<strong>'+u.fallbacks+'</strong></div></div><p class="status">Workspace budget: '+(u.budget?money(u.budget.spentUsd)+' / '+money(u.budget.monthlyBudgetUsd)+' · '+money(u.budget.remainingUsd)+' remaining':'not configured')+'</p><p class="status">Provider account balances are separate and are not shown here.</p>'+(rows||'<p class="status">No model attempts yet.</p>')+'<h3>Model availability</h3>'+states+(u.fallbacks?'<p class="fallback-note">Automatic fallback events are recorded in the execution details.</p>':'');}catch(e){usagePanel.innerHTML='<h3>AI usage</h3><p class="error">'+esc(e.message)+'</p>'}}
  usageButton.onclick=async()=>{usagePanel.classList.toggle('hidden');if(!usagePanel.classList.contains('hidden'))await loadUsagePanel()};
  document.addEventListener('click',event=>{if(event.target.closest('.workspace-item')&&!usagePanel.classList.contains('hidden'))loadUsagePanel()});
  document.addEventListener('click',event=>{if(!event.target.closest('.usage-panel')&&!event.target.closest('#usageButton'))usagePanel.classList.add('hidden')});
  window.addEventListener('hub-workspace-changed',loadModelCatalog);
  loadModelCatalog();
  </script></body>`);
