// Hub endpoints and UI for the Coding Agent, the approvals queue and the
// Model Pool dashboard. Everything reads the durable Supabase state written
// by the coding worker; the browser never receives credentials. If the
// Coding Agent migration has not been applied yet, these endpoints answer
// 503 CODING_AGENT_NOT_INSTALLED and the rest of the Hub keeps working.

import { readFileSync } from 'node:fs';
import { createModelPool } from './model-gateway/agentic/model-pool.js';
import { AgentTurnGateway } from './model-gateway/agentic/turn-gateway.js';
import { billingPriority } from './coding-agent/runtime.js';

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
  if (!path.startsWith('/api/coding') && !path.startsWith('/api/approvals') && !path.startsWith('/api/model-pool')) return false;
  try {
    if (request.method === 'GET' && path === '/api/model-pool') {
      const snapshot = await modelPoolSnapshot({ db, env, now });
      let lastCanary = null;
      try {
        lastCanary = (await rows(db.from('provider_canary_runs').select('id,status,requested_at,completed_at,report,error').order('requested_at', { ascending: false }).limit(1)))[0] || null;
      } catch (error) {
        if (!error.notInstalled) throw error;
      }
      return sendJson(response, 200, { ok: true, ...snapshot, lastCanary }), true;
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
  if (Array.isArray(body.supabaseProjects)) config.supabase = { projects: body.supabaseProjects.filter((ref) => /^[a-z0-9]{20}$/.test(ref)).slice(0, 5) };
  return { workspaceId, objective, repository, baseBranch, budgetUsd, title, config };
}

// Truthful per-route status: provider-reported rate limits only; quota is
// "unknown" when the provider does not expose it; costs are marked estimated.
export async function modelPoolSnapshot({ db, env = process.env, now = () => Date.now() }) {
  const pool = createModelPool({ env });
  let statusRows = [];
  try {
    statusRows = await rows(db.from('provider_status').select('*'));
  } catch (error) {
    if (!error.notInstalled) throw error;
  }
  const state = new Map(statusRows.map((row) => [`${row.provider}:${row.model}`, row]));
  const gateway = new AgentTurnGateway({
    pool,
    stateStore: { snapshot: async () => new Map([...state].map(([key, row]) => [key, { health: row.health, cooldownUntil: row.cooldown_until }])) },
    billingPriority: billingPriority(env),
    now,
  });
  const evaluations = await gateway.evaluate({ requiresPrivateData: true });
  const order = gateway.order(evaluations).map((route) => route.id);
  const routes = evaluations.map(({ route, reasons }) => {
    const row = state.get(route.id) || null;
    const rateLimit = row?.rate_limit || null;
    const limit = rateLimit?.requestsLimit ?? null;
    const remaining = rateLimit?.requestsRemaining ?? null;
    const cooling = row?.cooldown_until && Date.parse(row.cooldown_until) > now();
    let availability;
    if (route.unavailableReasons.length) availability = `NOT CONFIGURED — ${route.unavailableReasons.join(', ')}`;
    else if (cooling) availability = `${String(row.health || 'unavailable').toUpperCase().replace('_', ' ')} — RETRY AFTER ${formatRemaining(Date.parse(row.cooldown_until) - now())}`;
    else if (reasons.includes('PRIVACY_NOT_APPROVED')) availability = 'AVAILABLE FOR PUBLIC DATA ONLY — PRIVACY REVIEW PENDING';
    else if (reasons.includes('BELOW_QUALITY_FLOOR')) availability = 'AVAILABLE — BELOW CODING QUALITY FLOOR';
    else if (limit != null && remaining != null) availability = `AVAILABLE — ${remaining}/${limit} REQUESTS LEFT (PROVIDER-REPORTED)`;
    else availability = 'AVAILABLE — EXACT QUOTA UNKNOWN';
    return {
      id: route.id,
      provider: route.provider,
      model: route.model,
      protocol: route.protocol,
      enabled: !route.unavailableReasons.length,
      eligibleForPrivateCode: reasons.length === 0,
      routingRank: order.indexOf(route.id) >= 0 ? order.indexOf(route.id) + 1 : null,
      billingClass: route.billingClass.toUpperCase(),
      health: row?.health || 'unknown',
      availability,
      reasons,
      rateLimit: rateLimit ? { ...rateLimit, source: 'provider response headers' } : null,
      quotaPercentRemaining: limit && remaining != null ? Math.round((remaining / limit) * 100) : null,
      cooldownUntil: cooling ? row.cooldown_until : null,
      usage: row ? {
        requests: Number(row.requests_total || 0), failures: Number(row.failures_total || 0),
        inputTokens: Number(row.input_tokens_total || 0), outputTokens: Number(row.output_tokens_total || 0),
        estimatedCostUsd: Number(row.cost_usd_total || 0), costBasis: 'ESTIMATED from token counts and published list prices',
      } : null,
      lastSuccessAt: row?.last_success_at || null,
      lastErrorAt: row?.last_error_at || null,
      lastErrorCode: row?.last_error_code || null,
      verifiedAt: row?.verified_at || row?.last_success_at || null,
      toolCalling: route.toolCalling,
      contextWindow: route.contextWindow,
      privacy: route.privacyApproved ? 'approved for private code' : (route.privacyFlag ? `requires ${route.privacyFlag}=true after review` : route.privacyNote || 'not approved'),
      pricing: route.pricing ? { ...route.pricing, basis: 'published list price' } : null,
    };
  });
  return { billingPriority: billingPriority(env), routes, installed: statusRows.length > 0 || true };
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
export const CODING_STYLE = '<style>.coding-view{position:fixed;inset:0 0 0 270px;background:#0a1020;z-index:4;overflow:auto;padding:24px 30px}.coding-view h2{margin:0 0 4px}.coding-grid{display:grid;grid-template-columns:minmax(260px,340px) 1fr;gap:18px;margin-top:16px}.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px}.card h3{margin:0 0 10px;font-size:14px}.session-item{display:block;width:100%;text-align:left;background:transparent;color:var(--ink);padding:9px;border-radius:9px;border:1px solid transparent}.session-item:hover,.session-item.active{background:#1b2943;border-color:var(--line)}.session-item small{display:block;color:var(--muted);margin-top:3px}.kv{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.kv .metric strong{font-size:12px}.pill{display:inline-block;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:700;background:#26375e;color:#cbd6ff}.pill.completed{background:#16432f;color:#8ff0c4}.pill.failed,.pill.cancelled{background:#4a2027;color:#ffb3b3}.pill.awaiting_approval,.pill.blocked{background:#4a3a18;color:#f5d68a}.feed{max-height:380px;overflow:auto;font-size:12px}.feed div{padding:6px 0;border-bottom:1px solid var(--line)}.feed .warning{color:#f5d68a}.feed .error{color:var(--danger);background:none;border:0;padding:6px 0;margin:0}.feed .success{color:var(--good)}.approval{border:1px solid #6b5a2a;background:#2a2412;border-radius:10px;padding:10px;margin-bottom:8px}.approval button{margin-right:6px;margin-top:6px;padding:6px 10px;border-radius:8px}.approve{background:#1f7a52;color:#fff}.reject{background:#7f3542;color:#fff}.report{white-space:pre-wrap;font-size:12px;background:#0d1525;border-radius:10px;padding:10px;max-height:340px;overflow:auto}.pool-table{width:100%;border-collapse:collapse;font-size:12px}.pool-table td,.pool-table th{border-bottom:1px solid var(--line);padding:7px 6px;text-align:left;vertical-align:top}.pool-table th{color:var(--muted);font-weight:600}.muted{color:var(--muted)}.row-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.ghost{background:transparent;border:1px solid var(--line);color:var(--ink);border-radius:9px;padding:7px 11px}.coding-form label{display:block;color:var(--muted);font-size:12px;margin-top:10px}.coding-form .field{margin-top:4px}.check{display:flex;gap:8px;align-items:center;margin-top:10px;color:var(--muted);font-size:12px}.approvals-badge{background:#b7791f;color:#1a1204;border-radius:999px;padding:2px 7px;font-size:11px;font-weight:800;margin-left:4px}@media(max-width:820px){.coding-view{inset:0;padding:16px}.coding-grid{grid-template-columns:1fr}.kv{grid-template-columns:repeat(2,1fr)}}</style>';

export const CODING_MARKUP = '<div id="codingView" class="coding-view hidden"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><div><h2>Coding Agent</h2><div class="muted">Autonomous development: plan → edit → test → debug → PR → CI → deploy → verify. It keeps working across model switches and restarts.</div></div><div class="row-actions" style="margin:0"><button id="poolButton" class="ghost">Model pool</button><button id="codingClose" class="ghost">Back to chat</button></div></div><div id="codingError" class="error hidden"></div><div id="poolPanel" class="card hidden" style="margin-top:14px"></div><div class="coding-grid"><div><div class="card coding-form"><h3>New development task</h3><label>Repository<input id="cRepo" class="field" value="FahadTrail/fahad-ai-office"></label><label>Base branch<input id="cBase" class="field" value="main"></label><label>Development instruction<textarea id="cObjective" class="field" style="min-height:140px" placeholder="Paste the full specification…"></textarea></label><label>Budget (USD)<input id="cBudget" class="field" type="number" min="0.5" max="500" step="0.5" value="5"></label><label>Test command (optional; auto-detected)<input id="cTest" class="field" placeholder="npm test"></label><div class="check"><input id="cDeploy" type="checkbox"><span>Merge &amp; deploy after CI passes (merge needs your approval unless your policy allows it)</span></div><label>Production health URL (optional)<input id="cVerify" class="field" placeholder="https://…/healthz"></label><button id="cStart" class="newchat" style="width:100%;margin-top:12px">Start Coding Agent</button></div><div class="card" style="margin-top:14px"><h3>Sessions</h3><div id="cSessions" class="muted">No sessions yet.</div></div></div><div id="cDetail" class="card"><div class="muted">Select or start a session. You can leave; the agent keeps working and this view updates live.</div></div></div></div>';

export const CODING_SCRIPT = String.raw`
  (function(){
    const codingView=document.getElementById('codingView');let codingSession='',codingPoll=null,poolOpen=false;
    const ws=()=>document.querySelector('.workspace-item.active')?.dataset.id||'';
    const usd=v=>'$'+Number(v||0).toFixed(4);
    const btn=document.createElement('button');btn.id='codingButton';btn.className='newchat';btn.style.background='linear-gradient(135deg,#34d399,#0e9f6e)';btn.innerHTML='⌘ Coding Agent <span id="approvalsBadge" class="approvals-badge hidden">0</span>';document.getElementById('newChat').after(btn);
    const cerr=m=>{const e=document.getElementById('codingError');e.textContent=m;e.classList.toggle('hidden',!m)};
    async function codingApi(p,o){try{return await api(p,o)}catch(e){if(/CODING_AGENT_NOT_INSTALLED/.test(e.message))throw new Error('The Coding Agent is not installed on this server yet (database migration and coding worker pending).');throw e}}
    async function openCoding(){codingView.classList.remove('hidden');document.querySelector('.sidebar')?.classList.remove('open');await loadSessions()}
    function closeCoding(){codingView.classList.add('hidden');clearInterval(codingPoll)}
    async function loadSessions(){if(!ws())return;try{cerr('');const d=await codingApi('./api/coding/sessions?workspaceId='+encodeURIComponent(ws()));document.getElementById('cSessions').innerHTML=(d.sessions||[]).map(s=>'<button class="session-item '+(s.id===codingSession?'active':'')+'" data-session="'+s.id+'"><strong>'+esc(s.title)+'</strong> <span class="pill '+esc(s.status)+'">'+esc(s.status)+'</span><small>'+esc(s.repository)+' · '+esc(s.phase)+' · '+new Date(s.createdAt).toLocaleString()+'</small></button>').join('')||'No sessions yet.';document.querySelectorAll('[data-session]').forEach(b=>b.onclick=()=>openSession(b.dataset.session));await loadApprovalsBadge()}catch(e){cerr(e.message)}}
    async function loadApprovalsBadge(){if(!ws())return;try{const d=await codingApi('./api/approvals?workspaceId='+encodeURIComponent(ws()));const n=(d.approvals||[]).length;const b=document.getElementById('approvalsBadge');b.textContent=String(n);b.classList.toggle('hidden',!n)}catch{}}
    async function startSession(){const objective=document.getElementById('cObjective').value.trim();if(objective.length<12)return cerr('Describe the development task (at least 12 characters).');const body={workspaceId:ws(),repository:document.getElementById('cRepo').value.trim(),baseBranch:document.getElementById('cBase').value.trim()||'main',objective,budgetUsd:Number(document.getElementById('cBudget').value||5),deploy:document.getElementById('cDeploy').checked};const t=document.getElementById('cTest').value.trim();if(t)body.testCommand=t;const v=document.getElementById('cVerify').value.trim();if(v){body.verifyUrl=v}document.getElementById('cStart').disabled=true;try{cerr('');const d=await codingApi('./api/coding/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});document.getElementById('cObjective').value='';await loadSessions();await openSession(d.session.id)}catch(e){cerr(e.message)}finally{document.getElementById('cStart').disabled=false}}
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
    async function togglePool(){const panel=document.getElementById('poolPanel');poolOpen=!poolOpen;panel.classList.toggle('hidden',!poolOpen);if(!poolOpen)return;panel.innerHTML='<div class="muted">Loading…</div>';try{const d=await codingApi('./api/model-pool');const lc=d.lastCanary;const canaryLine='<div class="row-actions" style="margin:0 0 10px"><button id="runCanary" class="ghost">Run live canary</button><span class="muted">'+(lc?('Last canary: '+esc(lc.status)+(lc.report?(' · verified: '+esc((lc.report.routes||[]).filter(r=>r.ok).map(r=>r.id).join(', ')||'none')+' · failover drill: '+(lc.report.failover?.ok?('passed'+(lc.report.failover.crossProvider?' ('+esc(lc.report.failover.primary)+' → '+esc(lc.report.failover.backup)+')':' (same provider)')):'not passed')+(lc.report.totalCostUsd!=null?' · cost '+usd(lc.report.totalCostUsd)+' ESTIMATED':'')):'')+' · '+new Date(lc.requested_at).toLocaleString()):'No live canary has run yet.')+'</span></div>';panel.innerHTML=canaryLine+'<h3>Model pool · routing priority: '+esc((d.billingPriority||[]).join(' → '))+'</h3><div style="overflow:auto"><table class="pool-table"><tr><th>#</th><th>Provider / model</th><th>Class</th><th>Status</th><th>Health</th><th>Usage (estimated cost)</th><th>Last success / error</th><th>Tools · context</th><th>Privacy</th></tr>'+(d.routes||[]).map(r=>'<tr><td>'+(r.routingRank||'–')+'</td><td><strong>'+esc(r.provider)+'</strong><br><span class="muted">'+esc(r.model)+'</span></td><td>'+esc(r.billingClass)+'</td><td>'+esc(r.availability)+(r.quotaPercentRemaining!=null?'<br><span class="muted">'+r.quotaPercentRemaining+'% of request window left</span>':'')+'</td><td>'+esc(r.health)+'</td><td>'+(r.usage?(r.usage.requests+' req · '+(r.usage.inputTokens+r.usage.outputTokens).toLocaleString()+' tok<br>'+usd(r.usage.estimatedCostUsd)+' ESTIMATED'):'<span class="muted">no traffic yet</span>')+'</td><td>'+(r.lastSuccessAt?new Date(r.lastSuccessAt).toLocaleString():'—')+'<br><span class="muted">'+esc(r.lastErrorCode||'')+'</span></td><td>'+(r.toolCalling?'tools':'no tools')+' · '+Math.round(r.contextWindow/1000)+'K</td><td class="muted">'+esc(r.privacy)+'</td></tr>').join('')+'</table></div><p class="muted">Quota and remaining limits are shown only when the provider reports them in response headers; otherwise they are marked unknown. Costs are estimates from token counts and published list prices — check each provider console for billing.</p>';const rc=document.getElementById('runCanary');if(rc)rc.onclick=async()=>{rc.disabled=true;try{await codingApi('./api/model-pool/canary',{method:'POST'});rc.textContent='Queued — runs within a minute';}catch(e){cerr(e.message)}}}catch(e){panel.innerHTML='<div class="error">'+esc(e.message)+'</div>'}}
    btn.onclick=openCoding;document.getElementById('codingClose').onclick=closeCoding;document.getElementById('cStart').onclick=startSession;document.getElementById('poolButton').onclick=togglePool;
    window.addEventListener('hub-workspace-changed',()=>{codingSession='';if(!codingView.classList.contains('hidden'))loadSessions();else loadApprovalsBadge()});
    setInterval(loadApprovalsBadge,30000);
  })();`;
