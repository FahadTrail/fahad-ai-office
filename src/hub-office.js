// The Office API: who is doing what right now (derived only from real task,
// session and approval rows), each employee's page, the workflow of a
// multi-agent objective, and what the Office's tools can actually do.
// Nothing here invents activity: an employee with no task row is AVAILABLE.

import { OFFICE_AGENTS, officeAgent, parseOutput } from './office/agents.js';
import { ownerAction, approvalCard } from './hub-workspace.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_SESSION = new Set(['completed', 'failed', 'cancelled']);
const RECENT_MS = 15 * 60_000;

export const AGENT_STATES = Object.freeze(['AVAILABLE', 'THINKING', 'WORKING', 'TESTING', 'WAITING', 'REVIEWING', 'BLOCKED', 'NEEDS FAHAD', 'COMPLETED']);

function stageOf(brief) {
  try { return JSON.parse(brief)?.stage || null; } catch { return null; }
}

function workflowOf(brief) {
  try { return JSON.parse(brief) || {}; } catch { return {}; }
}

// Node state of one task inside its workflow.
export function taskState(task, byId) {
  if (task.status === 'running') return 'working';
  if (task.status === 'done' || task.status === 'skipped') return 'done';
  if (task.status === 'failed') return 'failed';
  if (task.status === 'blocked') return 'blocked';
  const waitingOn = (task.depends_on || []).filter((id) => !['done', 'skipped'].includes(byId.get(id)?.status));
  return waitingOn.length ? 'waiting' : 'ready';
}

const CODING_PHASE_STATE = { understand: 'THINKING', plan: 'THINKING', implement: 'WORKING', test: 'TESTING', debug: 'TESTING', review: 'REVIEWING', publish: 'WORKING', ci: 'TESTING', deploy: 'WORKING', verify: 'TESTING', report: 'WORKING' };
const CODING_PHASE_WORDS = { understand: 'Understanding the task', plan: 'Planning', implement: 'Editing code', test: 'Running tests', debug: 'Debugging', review: 'Reviewing', publish: 'Opening the pull request', ci: 'Waiting for CI', deploy: 'Deploying', verify: 'Verifying production', report: 'Writing the report' };

// One state per employee from the live rows. Priority: needs Fahad, active
// work, waiting, blocked, just completed, available.
export function officeState({ agents = [], jobs = [], tasks = [], sessions = [], approvals = [], now = Date.now() }) {
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const rank = { 'NEEDS FAHAD': 0, WORKING: 1, TESTING: 1, THINKING: 1, REVIEWING: 1, WAITING: 2, BLOCKED: 3, COMPLETED: 4, AVAILABLE: 5 };
  const result = new Map(OFFICE_AGENTS.map((entry) => [entry.slug, { state: 'AVAILABLE', detail: 'Available', assignment: null, since: null }]));
  const offer = (slug, candidate) => {
    const current = result.get(slug);
    if (!current || rank[candidate.state] < rank[current.state] || (rank[candidate.state] === rank[current.state] && String(candidate.since || '') > String(current.since || ''))) result.set(slug, candidate);
  };
  for (const task of tasks) {
    const agent = agentById.get(task.agent_id);
    const employee = officeAgent(agent?.slug);
    const job = jobById.get(task.job_id);
    if (!employee || !job || employee.executor === 'coding' && stageOf(task.brief) === null) continue;
    const brief = workflowOf(task.brief);
    if (brief.workflow === 'coding-agent') continue;
    const assignment = { jobId: job.id, objective: job.title || job.goal, task: task.title, conversationId: job.conversation_id || null };
    const state = taskState(task, taskById);
    if (state === 'working') {
      const stage = brief.stage;
      const visible = stage === 'chief_plan' ? 'THINKING' : ['synthesis', 'chief_review'].includes(stage) ? 'REVIEWING' : 'WORKING';
      const words = stage === 'chief_plan' ? 'Planning the work' : ['synthesis', 'chief_review'].includes(stage) ? 'Reviewing the team’s work' : `Working on ${task.title}`;
      offer(employee.slug, { state: visible, detail: words, assignment, since: task.started_at || task.created_at });
    } else if ((state === 'waiting' || state === 'ready') && ['running', 'planning'].includes(job.status)) {
      const waitingFor = (task.depends_on || []).map((id) => taskById.get(id)).filter((dep) => dep && !['done', 'skipped'].includes(dep.status))
        .map((dep) => officeAgent(agentById.get(dep.agent_id)?.slug)?.label).filter(Boolean);
      offer(employee.slug, { state: 'WAITING', detail: waitingFor.length ? `Waiting for ${[...new Set(waitingFor)].join(', ')}` : `Starting: ${task.title}`, assignment, since: task.created_at });
    } else if (state === 'failed' || state === 'blocked') {
      if (now - Date.parse(task.completed_at || task.created_at) < 6 * 3600_000) offer(employee.slug, { state: 'BLOCKED', detail: state === 'failed' ? `Could not finish ${task.title}` : `Blocked: ${task.title} (an earlier step failed)`, assignment, since: task.completed_at || task.created_at });
    } else if (state === 'done' && task.completed_at && now - Date.parse(task.completed_at) < RECENT_MS) {
      offer(employee.slug, { state: 'COMPLETED', detail: `Delivered ${task.title}`, assignment, since: task.completed_at });
    }
  }
  const pending = new Map();
  for (const approval of approvals) if (approval.status === 'pending') pending.set(approval.session_id, [...(pending.get(approval.session_id) || []), approval]);
  for (const session of sessions) {
    const assignment = { sessionId: session.id, objective: session.title, task: session.title, conversationId: session.conversation_id || null };
    const need = ownerAction(session, pending.get(session.id) || []);
    if (need && ['approval', 'question'].includes(need.kind)) offer('coding-agent', { state: 'NEEDS FAHAD', detail: need.kind === 'approval' ? 'Waiting for your approval' : 'Has a question for you', assignment, since: session.updated_at });
    else if (session.status === 'blocked') offer('coding-agent', { state: 'BLOCKED', detail: 'Paused — needs you to continue', assignment, since: session.updated_at });
    else if (session.status === 'running') offer('coding-agent', { state: CODING_PHASE_STATE[session.phase] || 'WORKING', detail: CODING_PHASE_WORDS[session.phase] || 'Working', assignment, since: session.updated_at });
    else if (session.status === 'queued') offer('coding-agent', { state: 'WAITING', detail: 'Queued for a worker', assignment, since: session.created_at });
    else if (session.status === 'completed' && session.completed_at && now - Date.parse(session.completed_at) < RECENT_MS) offer('coding-agent', { state: 'COMPLETED', detail: `Finished ${session.title}`, assignment, since: session.completed_at });
  }
  return result;
}

// The workflow of one objective: Fahad → Chief → workstreams → synthesis.
export function workflowView({ job, tasks = [], agents = [], results = [], handoffs = [], events = [], sessions = [] }) {
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const latestResult = new Map();
  for (const result of results) if (result.kind !== 'final' && result.task_id) latestResult.set(result.task_id, result);
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const launched = new Map(events.filter((event) => event.payload?.kind === 'task_launched').map((event) => [event.task_id, event.payload.session_id]));
  const nodes = tasks.toSorted((a, b) => a.sequence - b.sequence || String(a.created_at).localeCompare(String(b.created_at))).map((task) => {
    const agent = agentById.get(task.agent_id);
    const employee = officeAgent(agent?.slug);
    const brief = workflowOf(task.brief);
    const output = latestResult.get(task.id);
    const parsed = output ? parseOutput(output.content) : null;
    const session = sessionById.get(launched.get(task.id));
    return {
      id: task.id, title: task.title, agent: employee?.key || agent?.slug, agentLabel: employee?.label || agent?.name || 'Agent', agentSlug: agent?.slug || null,
      kind: { chief_plan: 'plan', synthesis: 'synthesis', launch_dev: 'development', specialist: 'workstream', research: 'workstream', chief_review: 'synthesis', direct: 'conversation' }[brief.stage] || 'task',
      revision: Boolean(brief.revision), state: taskState(task, byId), dependsOn: (task.depends_on || []).filter((id) => byId.has(id)),
      startedAt: task.started_at || null, completedAt: task.completed_at || null,
      output: output ? { summary: parsed.summary.slice(0, 600) || output.summary, decisions: parsed.decisions, content: output.content, at: output.created_at } : null,
      codingTask: session ? { id: session.id, status: session.status, phase: session.phase, title: session.title } : null,
    };
  });
  const final = results.find((result) => result.kind === 'final');
  const participants = [...new Map(nodes.filter((node) => node.kind !== 'plan' && node.kind !== 'synthesis').map((node) => [node.agent, { key: node.agent, label: node.agentLabel }])).values()];
  const decisions = nodes.filter((node) => node.output?.decisions).map((node) => ({ from: node.agentLabel, text: node.output.decisions }));
  return {
    job: { id: job.id, title: job.title, objective: job.goal, status: job.status, progress: job.progress || 0, createdAt: job.created_at, completedAt: job.completed_at || null,
      costUsd: Number(job.cost_usd || 0), conversationId: job.conversation_id || null },
    multiAgent: nodes.some((node) => node.kind === 'workstream' || node.kind === 'development') && nodes.some((node) => node.kind === 'synthesis'),
    participants, nodes, decisions,
    handoffs: handoffs.map((handoff) => ({
      from: officeAgent(agentById.get(handoff.from_agent_id)?.slug)?.label || 'Agent', to: officeAgent(agentById.get(handoff.to_agent_id)?.slug)?.label || 'Agent',
      fromTask: handoff.from_task_id, toTask: handoff.to_task_id, at: handoff.created_at,
    })),
    revisions: events.filter((event) => event.payload?.kind === 'revision_requested').flatMap((event) => event.payload.revisions || []),
    final: final ? { content: final.content, at: final.created_at } : null,
  };
}

// Capability evidence → one honest state per connector. "Connected" needs a
// real successful use; configuration alone is "Configured — not verified".
export function capabilityView({ toolRuns = [], webRuns = {}, env = {}, databaseOk = true, memoryCount = 0, now = Date.now() }) {
  const last = (names) => toolRuns.filter((run) => names.some((name) => run.tool_name === name || run.tool_name.startsWith(`${name}.`)) && run.status === 'succeeded')
    .map((run) => run.last).sort().at(-1) || null;
  const present = (name) => String(env[name] || '').trim().length > 0;
  const state = (evidence, configured, label) => {
    if (evidence) return { status: 'Connected', verifiedAt: evidence, detail: `Last verified by a real ${label} on ${String(evidence).slice(0, 10)}` };
    if (configured) return { status: 'Configured — not verified', verifiedAt: null, detail: 'Credential present; no successful use recorded yet' };
    return { status: 'Not configured', verifiedAt: null, detail: 'No credential configured' };
  };
  const stale = (value) => value && now - Date.parse(value) > 30 * 86400_000;
  const items = [
    { id: 'github', label: 'GitHub', ...state(last(['github']), present('CODING_GITHUB_TOKEN'), 'pull request / CI call') },
    { id: 'repository', label: 'Repository read & write', ...state(last(['repo.write', 'repo.edit']), present('CODING_GITHUB_TOKEN'), 'file edit in the Coding Agent sandbox') },
    { id: 'pull_requests', label: 'Pull requests', ...state(last(['github.pr_create']), present('CODING_GITHUB_TOKEN'), 'pull request') },
    { id: 'ci', label: 'CI checks', ...state(last(['github.ci_status']), present('CODING_GITHUB_TOKEN'), 'CI status check') },
    { id: 'deployment', label: 'Deployment', ...state(last(['deploy.status', 'verify.http']), false, 'deployment check') },
    { id: 'database', label: 'Supabase database (Office data)', status: databaseOk ? 'Connected' : 'Unavailable', verifiedAt: databaseOk ? new Date(now).toISOString() : null, detail: databaseOk ? 'Live: this page was read from it' : 'The Hub could not read the database' },
    { id: 'supabase_tools', label: 'Supabase tools for the Coding Agent', ...state(last(['supabase']), present('CODING_SUPABASE_ACCESS_TOKEN'), 'database tool call'),
      ...(present('CODING_SUPABASE_ACCESS_TOKEN') || last(['supabase']) ? {} : { detail: 'Not configured: CODING_SUPABASE_ACCESS_TOKEN is missing, so the Coding Agent has no database tools' }) },
    { id: 'web_search', label: 'Web search', ...state(webRuns.web_search || null, present('GEMINI_API_KEY'), 'web search') },
    { id: 'web_fetch', label: 'Web page reading', ...state(webRuns.web_fetch || null, true, 'page fetch') },
    { id: 'memory', label: 'Project memory', status: databaseOk ? 'Available' : 'Unavailable', verifiedAt: null, detail: `${memoryCount} saved item${memoryCount === 1 ? '' : 's'}` },
    { id: 'tool_broker', label: 'Tool Broker (audited tools)', ...state(toolRuns.filter((run) => run.status === 'succeeded').map((run) => run.last).sort().at(-1) || null, true, 'audited tool call') },
  ];
  return items.map((item) => (item.status === 'Connected' && stale(item.verifiedAt) ? { ...item, status: 'Connected (not used recently)' } : item));
}

// ------------------------------------------------------------------ handler

async function rows(query) {
  const { data, error } = await query;
  if (error) throw Object.assign(new Error(`Could not load Office data: ${error.message}`), { statusCode: 500 });
  return data || [];
}

function uuid(value, name) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw Object.assign(new Error(`${name} must be a UUID`), { statusCode: 400 });
  return value;
}

async function workspaceActivity(db, workspaceId, sinceMs) {
  const since = new Date(Date.now() - sinceMs).toISOString();
  const [agents, jobs, sessions, approvals] = await Promise.all([
    rows(db.from('agents').select('id,slug,name,accent_color,is_active')),
    rows(db.from('jobs').select('id,title,goal,status,progress,conversation_id,created_at,completed_at').eq('project_id', workspaceId).gte('created_at', since).order('created_at', { ascending: false }).limit(60)),
    rows(db.from('agent_sessions').select('id,title,status,phase,error_code,blocker,conversation_id,created_at,updated_at,completed_at').eq('workspace_id', workspaceId).order('updated_at', { ascending: false }).limit(20)),
    rows(db.from('agent_approvals').select('id,session_id,tool_name,action,risk,summary,arguments_preview,status,requested_at').eq('workspace_id', workspaceId).eq('status', 'pending')),
  ]);
  const jobIds = jobs.map((job) => job.id);
  const tasks = jobIds.length ? await rows(db.from('tasks').select('id,job_id,agent_id,title,status,brief,depends_on,sequence,started_at,completed_at,created_at').in('job_id', jobIds)) : [];
  return { agents, jobs, tasks, sessions: sessions.filter((session) => !TERMINAL_SESSION.has(session.status) || (session.completed_at && Date.now() - Date.parse(session.completed_at) < RECENT_MS)), approvals };
}

export async function handleOfficeApi({ db, request, response, url, sendJson, env = process.env }) {
  const path = url.pathname;
  if (!/^\/api\/(office|agents|workflows|capabilities)(\/|$)/.test(path)) return false;
  try {
    const method = request.method;
    if (method !== 'GET') return sendJson(response, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }), true;

    if (path === '/api/office') {
      const workspaceId = uuid(url.searchParams.get('workspaceId'), 'workspaceId');
      const live = await workspaceActivity(db, workspaceId, 7 * 86400_000);
      const states = officeState(live);
      const colors = new Map(live.agents.map((agent) => [agent.slug, agent.accent_color]));
      const since = new Date(Date.now() - 2 * 3600_000).toISOString();
      const jobIds = live.jobs.map((job) => job.id);
      const handoffs = jobIds.length ? await rows(db.from('handoffs').select('from_agent_id,to_agent_id,from_task_id,to_task_id,job_id,created_at').in('job_id', jobIds).gte('created_at', since).order('created_at', { ascending: false }).limit(20)) : [];
      const agentById = new Map(live.agents.map((agent) => [agent.id, agent]));
      const workflowJobs = new Set(live.tasks.filter((task) => stageOf(task.brief) === 'synthesis').map((task) => task.job_id));
      return sendJson(response, 200, {
        ok: true,
        agents: OFFICE_AGENTS.map((entry) => ({ slug: entry.slug, key: entry.key, label: entry.label, scope: entry.scope, deliverable: entry.deliverable,
          executor: entry.executor, directChat: entry.directChat, color: colors.get(entry.slug) || null, ...states.get(entry.slug) })),
        workflows: live.jobs.filter((job) => workflowJobs.has(job.id)).slice(0, 8).map((job) => ({ id: job.id, title: job.title, status: job.status, progress: job.progress || 0, createdAt: job.created_at })),
        handoffs: handoffs.map((handoff) => ({ from: officeAgent(agentById.get(handoff.from_agent_id)?.slug)?.label, to: officeAgent(agentById.get(handoff.to_agent_id)?.slug)?.label, jobId: handoff.job_id, at: handoff.created_at })),
        needsFahad: live.approvals.length + live.sessions.filter((session) => session.status === 'blocked' && session.error_code === 'HUMAN_INPUT_REQUIRED').length,
      }), true;
    }

    const agentMatch = path.match(/^\/api\/agents\/([a-z][a-z0-9-]{1,40})$/);
    if (agentMatch) {
      const employee = officeAgent(agentMatch[1]);
      if (!employee) return sendJson(response, 404, { ok: false, error: 'AGENT_NOT_FOUND' }), true;
      const workspaceId = uuid(url.searchParams.get('workspaceId'), 'workspaceId');
      const live = await workspaceActivity(db, workspaceId, 30 * 86400_000);
      const record = live.agents.find((agent) => agent.slug === employee.slug);
      const identity = record ? (await rows(db.from('agents').select('name,name_ar,role,tagline,allowed_tools,accent_color').eq('slug', employee.slug)))[0] : null;
      const state = officeState(live).get(employee.slug);
      const own = live.tasks.filter((task) => task.agent_id === record?.id && workflowOf(task.brief).workflow !== 'coding-agent')
        .toSorted((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 12);
      const results = own.length ? await rows(db.from('results').select('task_id,summary,content,created_at,kind').in('task_id', own.map((task) => task.id))) : [];
      const jobById = new Map(live.jobs.map((job) => [job.id, job]));
      const conversations = employee.directChat && employee.executor === 'office'
        ? await rows(db.from('conversations').select('id,title,last_message_at').eq('project_id', workspaceId).eq('agent_slug', employee.slug).eq('archived', false).order('last_message_at', { ascending: false }).limit(10))
        : [];
      return sendJson(response, 200, {
        ok: true,
        agent: { slug: employee.slug, key: employee.key, label: employee.label, scope: employee.scope, deliverable: employee.deliverable, executor: employee.executor,
          directChat: employee.directChat && employee.executor === 'office', job: employee.job, webTools: employee.webTools,
          tagline: identity?.tagline || null, nameAr: identity?.name_ar || null, color: identity?.accent_color || null, tools: identity?.allowed_tools || [] },
        state,
        recent: own.map((task) => {
          const output = results.filter((result) => result.task_id === task.id && result.kind !== 'final').at(-1);
          const job = jobById.get(task.job_id);
          return { taskId: task.id, jobId: task.job_id, objective: job?.title || job?.goal || '', title: task.title, status: taskState(task, new Map(live.tasks.map((entry) => [entry.id, entry]))),
            at: task.completed_at || task.started_at || task.created_at, summary: output ? (parseOutput(output.content).summary || output.summary || '').slice(0, 400) : null };
        }),
        conversations: conversations.map((conversation) => ({ id: conversation.id, title: conversation.title, lastMessageAt: conversation.last_message_at })),
        codingSessions: employee.executor === 'coding' ? live.sessions.map((session) => ({ id: session.id, title: session.title, status: session.status, phase: session.phase })) : [],
      }), true;
    }

    if (path === '/api/workflows') {
      const workspaceId = uuid(url.searchParams.get('workspaceId'), 'workspaceId');
      const live = await workspaceActivity(db, workspaceId, 30 * 86400_000);
      const synthesisJobs = new Set(live.tasks.filter((task) => stageOf(task.brief) === 'synthesis').map((task) => task.job_id));
      const counts = new Map();
      for (const task of live.tasks) if (['specialist', 'launch_dev'].includes(stageOf(task.brief))) counts.set(task.job_id, (counts.get(task.job_id) || 0) + 1);
      return sendJson(response, 200, { ok: true, workflows: live.jobs.filter((job) => synthesisJobs.has(job.id)).map((job) => ({
        id: job.id, title: job.title, objective: job.goal, status: job.status, progress: job.progress || 0, workstreams: counts.get(job.id) || 0, createdAt: job.created_at, completedAt: job.completed_at,
      })) }), true;
    }

    const workflowMatch = path.match(/^\/api\/workflows\/([0-9a-f-]{36})$/i);
    if (workflowMatch) {
      const jobId = uuid(workflowMatch[1], 'jobId');
      const [job] = await rows(db.from('jobs').select('id,title,goal,status,progress,cost_usd,conversation_id,project_id,created_at,completed_at').eq('id', jobId));
      if (!job) return sendJson(response, 404, { ok: false, error: 'WORKFLOW_NOT_FOUND' }), true;
      const [tasks, agents, results, handoffs, events] = await Promise.all([
        rows(db.from('tasks').select('id,job_id,agent_id,title,status,brief,depends_on,sequence,started_at,completed_at,created_at').eq('job_id', jobId)),
        rows(db.from('agents').select('id,slug,name')),
        rows(db.from('results').select('task_id,kind,summary,content,created_at').eq('job_id', jobId).order('created_at', { ascending: true })),
        rows(db.from('handoffs').select('from_agent_id,to_agent_id,from_task_id,to_task_id,created_at').eq('job_id', jobId).order('created_at', { ascending: true })),
        rows(db.from('events').select('task_id,type,payload,created_at').eq('job_id', jobId).eq('type', 'activity').order('created_at', { ascending: true }).limit(300)),
      ]);
      const sessionIds = events.filter((event) => event.payload?.kind === 'task_launched').map((event) => event.payload.session_id).filter(Boolean);
      const sessions = sessionIds.length ? await rows(db.from('agent_sessions').select('id,title,status,phase').in('id', sessionIds)) : [];
      return sendJson(response, 200, { ok: true, ...workflowView({ job, tasks, agents, results, handoffs, events, sessions }) }), true;
    }

    if (path === '/api/capabilities') {
      const since = new Date(Date.now() - 90 * 86400_000).toISOString();
      let databaseOk = true;
      const [toolRuns, routeEvents, memory] = await Promise.all([
        rows(db.from('tool_executions').select('tool_name,status,started_at').gte('started_at', since).order('started_at', { ascending: false }).limit(1000)).catch(() => { databaseOk = false; return []; }),
        rows(db.from('events').select('payload,created_at').eq('payload->>kind', 'model_route').gte('created_at', since).order('created_at', { ascending: false }).limit(500)).catch(() => []),
        rows(db.from('project_memory').select('id')).catch(() => []),
      ]);
      const latest = new Map();
      for (const run of toolRuns) {
        const key = `${run.tool_name}|${run.status}`;
        if (!latest.has(key) || latest.get(key).last < run.started_at) latest.set(key, { tool_name: run.tool_name, status: run.status, last: run.started_at });
      }
      const webRuns = {};
      for (const event of routeEvents) for (const tool of event.payload?.tools_used || []) if (!webRuns[tool] || webRuns[tool] < event.created_at) webRuns[tool] = event.created_at;
      return sendJson(response, 200, { ok: true, capabilities: capabilityView({ toolRuns: [...latest.values()], webRuns, env, databaseOk, memoryCount: memory.length }) }), true;
    }
    return sendJson(response, 404, { ok: false, error: 'NOT_FOUND' }), true;
  } catch (error) {
    return sendJson(response, error.statusCode || 500, { ok: false, error: String(error.message || 'Request failed').slice(0, 300) }), true;
  }
}

export { approvalCard };
