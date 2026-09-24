import { createServer } from 'node:http';
import { URL } from 'node:url';

const DEFAULT_PORT = 2132;
const MAX_BODY_BYTES = 64 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createHubServer({ db, store, host = process.env.HUB_BIND || '127.0.0.1', port = Number(process.env.HUB_PORT || DEFAULT_PORT), accessToken = process.env.HUB_ACCESS_TOKEN || '' } = {}) {
  if (!db || !store) throw new TypeError('Hub server requires the existing database and store');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('HUB_PORT must be a valid TCP port');
  const authRequired = Boolean(accessToken) || !isLoopback(host);

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
      if (!requestUrl.pathname.startsWith('/api/')) return sendJson(response, 404, { ok: false, error: 'NOT_FOUND' });
      if (authRequired && !authorized(request, accessToken)) {
        return sendJson(response, accessToken ? 401 : 503, { ok: false, error: accessToken ? 'HUB_UNAUTHORIZED' : 'HUB_AUTH_NOT_CONFIGURED' });
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/workspaces') {
        const workspaces = await listWorkspaces(db);
        return sendJson(response, 200, { ok: true, workspaces });
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/jobs') {
        const body = await readJson(request);
        const workspaceId = requireUuid(body.workspaceId, 'workspaceId');
        const goal = normalizeGoal(body.goal);
        const workspace = await readWorkspace(db, workspaceId);
        if (!workspace) return sendJson(response, 404, { ok: false, error: 'WORKSPACE_NOT_FOUND' });
        const policy = await readPolicy(db, workspaceId);
        if (!policy?.enabled) return sendJson(response, 403, { ok: false, error: 'WORKSPACE_DISABLED' });
        const job = await store.createJob({ title: goal.slice(0, 120), goal, projectId: workspaceId });
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

export async function readJobSnapshot(db, jobId) {
  const job = await one(db.from('jobs').select('id,title,goal,status,priority,project_id,tokens_used,cost_usd,created_at').eq('id', jobId).maybeSingle(), 'job');
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
    toolExecutions: toolExecutions || [],
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

function authorized(request, token) {
  const value = request.headers.authorization || '';
  return value.startsWith('Bearer ') && value.slice(7) === token;
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

export const HUB_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fahad AI Hub</title>
<style>body{margin:0;background:#f5f7fb;color:#162033;font:15px system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:1100px;margin:0 auto;padding:28px 18px}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}h1{font-size:25px;margin:0}.muted{color:#6b7280}.card{background:#fff;border:1px solid #dfe5ef;border-radius:14px;padding:18px;box-shadow:0 5px 18px #20304a0b;margin-bottom:16px}label{display:block;font-weight:600;margin:10px 0 6px}select,textarea,button{font:inherit}select,textarea{width:100%;box-sizing:border-box;border:1px solid #cdd6e3;border-radius:9px;padding:10px;background:#fff}textarea{min-height:110px;resize:vertical}button{border:0;border-radius:9px;padding:10px 16px;background:#1f5eff;color:#fff;font-weight:650;cursor:pointer;margin-top:12px}button:disabled{opacity:.55;cursor:wait}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}.metric{background:#f7f9fc;border-radius:10px;padding:11px}.metric strong{display:block;font-size:19px;margin-top:3px}.pill{display:inline-block;border-radius:999px;padding:4px 9px;background:#eaf0ff;color:#2451b5;font-size:12px;font-weight:650}.error{color:#b42318;background:#fff1f0;border-radius:9px;padding:10px;margin-top:10px}.task{border-left:3px solid #c8d4ec;padding:8px 12px;margin:8px 0}.event{padding:7px 0;border-bottom:1px solid #eef1f5;font-size:13px}.event:last-child{border-bottom:0}.result{white-space:pre-wrap;line-height:1.5}.hidden{display:none}@media(max-width:600px){main{padding:18px 12px}header{align-items:flex-start;gap:10px;flex-direction:column}}</style></head>
<body><main><header><div><h1>Fahad AI Hub</h1><div class="muted">One place for goals, progress, routing and results</div></div><span id="health" class="pill">Connecting…</span></header>
<section class="card"><h2>Start a task</h2><label for="workspace">Project / workspace</label><select id="workspace"></select><label for="goal">What should the Chief handle?</label><textarea id="goal" placeholder="Describe the goal, constraints and desired result…"></textarea><button id="submit">Send to Chief</button><div id="formError" class="error hidden"></div></section>
<section id="dashboard" class="card hidden"><div style="display:flex;justify-content:space-between;gap:12px;align-items:center"><h2 style="margin:0">Task progress</h2><span id="jobStatus" class="pill"></span></div><p id="jobGoal" class="muted"></p><div class="grid"><div class="metric">Agent<strong id="agent">—</strong></div><div class="metric">Provider / model<strong id="model">—</strong></div><div class="metric">Budget used<strong id="cost">—</strong></div><div class="metric">Fallbacks<strong id="fallbacks">0</strong></div><div class="metric">Tools<strong id="tools">0</strong></div></div><h3>Agents and handoffs</h3><div id="tasks"></div><h3>Latest result</h3><div id="result" class="result muted">Waiting for the Chief…</div><h3>Activity</h3><div id="events"></div></section></main>
<script>
const $=id=>document.getElementById(id);let jobId=null,poll=null;
async function api(path,options={}){const r=await fetch(path,options);const d=await r.json();if(!r.ok)throw new Error(d.error||'Request failed');return d}
async function loadWorkspaces(){try{const d=await api('./api/workspaces');$('workspace').innerHTML=d.workspaces.map(w=>'<option value="'+w.id+'">'+esc(w.name)+'</option>').join('');$('health').textContent='Ready'}catch(e){$('health').textContent='Unavailable';showError(e.message)}}
async function submit(){const b=$('submit');b.disabled=true;hideError();try{const d=await api('./api/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workspaceId:$('workspace').value,goal:$('goal').value})});jobId=d.job.id;$('dashboard').classList.remove('hidden');$('jobGoal').textContent=d.job.goal;await refresh();clearInterval(poll);poll=setInterval(refresh,4000)}catch(e){showError(e.message)}finally{b.disabled=false}}
async function refresh(){if(!jobId)return;try{const d=await api('./api/jobs/'+jobId);render(d.snapshot)}catch(e){showError(e.message);clearInterval(poll)}}
function render(s){$('jobStatus').textContent=s.job.status.toUpperCase();const attempts=s.attempts||[];const latest=attempts[attempts.length-1];$('agent').textContent=(s.tasks.find(t=>t.status==='running')||s.tasks[s.tasks.length-1])?.agent?.name||'—';$('model').textContent=latest?(latest.provider+' / '+latest.model):'—';$('cost').textContent='$'+Number(s.job.cost_usd||0).toFixed(6)+' / $'+Number(s.policy?.monthlyBudgetUsd||0).toFixed(2);$('fallbacks').textContent=String((s.events||[]).filter(e=>e.type==='provider_switch'||e.payload?.event==='provider_switch').length);$('tools').textContent=String((s.toolExecutions||[]).length);$('tasks').innerHTML=(s.tasks||[]).map(t=>'<div class="task"><strong>'+esc(t.title)+'</strong> <span class="pill">'+esc(t.status)+'</span><div class="muted">'+esc(t.agent?.name||'Agent')+' · '+(t.progress||0)+'%</div></div>').join('');const done=s.tasks.find(t=>t.status==='done'&&t.result);$('result').textContent=done?.result?.content||'Waiting for the Chief…';$('result').className=done?.result?.content?'result':'result muted';$('events').innerHTML=(s.events||[]).slice(0,30).map(e=>'<div class="event"><strong>'+esc(e.message)+'</strong><div class="muted">'+new Date(e.createdAt).toLocaleString()+'</div></div>').join('')||'<div class="muted">No activity yet.</div>'}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function showError(v){$('formError').textContent=v;$('formError').classList.remove('hidden')}function hideError(){$('formError').classList.add('hidden')}$('submit').onclick=submit;loadWorkspaces();fetch('./healthz').catch(()=>{});
</script></body></html>`;
