// Additive work API. The current Hub pages keep their routes. A future
// interface reads these contracts instead of reconstructing lifecycle,
// workload and results from events.
//
// Authorization is the Hub owner gate in front of every /api route. Handlers
// scope every read to one project and answer 404 for a row in another project.
// Reads are idempotent. Nothing here writes workflow state or deletes rows.

import { workerTruth } from './hub-continuity.js';
import { attentionItems } from './domain/attention.js';
import { classifyWork } from './domain/classification.js';
import { cleanupPreview } from './domain/cleanup-preview.js';
import { continuitySummary } from './domain/continuity-summary.js';
import { conversationIndex, conversationSummary } from './domain/conversations.js';
import { costSummary } from './domain/costs.js';
import { currentWork } from './domain/current-work.js';
import { OPEN_JOB_STATUSES, OPEN_SESSION_STATUSES, TERMINAL_JOB_STATUSES, TERMINAL_SESSION_STATUSES, jobLifecycle } from './domain/lifecycle.js';
import { objectiveSummary } from './domain/objectives.js';
import { matchesQuery, paginate } from './domain/pagination.js';
import { projectSummary, recommendProject } from './domain/projects.js';
import { resultDetail, resultSummary } from './domain/results.js';
import { WorkStream } from './domain/stream.js';
import { normalizeTier, projectTier } from './domain/tiers.js';
import { LIFECYCLE } from './domain/lifecycle.js';
import { workerBoard } from './domain/workers.js';
import { employeeWorkload, employeeWorkloads } from './domain/workload.js';
import { CONFIRMED_TEST_JOB_IDS } from './domain/work-registry.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_COLUMNS = 'id,project_id,title,goal,status,progress,conversation_id,cost_usd,created_at,completed_at,final_summary';
const TASK_COLUMNS = 'id,job_id,agent_id,title,brief,status,depends_on,sequence,started_at,completed_at,created_at,not_before,wait_info';
const SESSION_COLUMNS = 'id,workspace_id,job_id,task_id,conversation_id,title,objective,status,phase,error_code,blocker,result,created_at,updated_at,completed_at,started_at';
const streams = new Map();

const uuid = (value, name) => {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw Object.assign(new Error(`${name} must be a UUID`), { statusCode: 400 });
  return value;
};

async function rows(query) {
  const { data, error } = await query;
  if (error) throw Object.assign(new Error(`Could not load work data: ${error.message}`), { statusCode: 500 });
  return data || [];
}

async function maybe(query) {
  const { data, error } = await query;
  if (error) throw Object.assign(new Error(`Could not load work data: ${error.message}`), { statusCode: 500 });
  return data || null;
}

async function optional(query) {
  try {
    const { data, error } = await query;
    return error ? null : data || [];
  } catch { return null; }
}

async function requireProject(db, workspaceId) {
  const project = await maybe(db.from('projects').select('id,name,description,status,default_repository,created_at').eq('id', workspaceId).maybeSingle());
  if (!project) throw Object.assign(new Error('PROJECT_NOT_FOUND'), { statusCode: 404 });
  return project;
}

async function loadGraph(db, jobIds) {
  if (!jobIds.length) return { tasks: [], results: [], approvals: [], sessions: [] };
  const [tasks, results, approvals, sessions] = await Promise.all([
    rows(db.from('tasks').select(TASK_COLUMNS).in('job_id', jobIds).limit(800)),
    rows(db.from('results').select('id,job_id,task_id,agent_id,kind,summary,content,created_at').in('job_id', jobIds).order('created_at', { ascending: true }).limit(800)),
    optional(db.from('approvals').select('id,job_id,task_id,title,description,status,created_at').in('job_id', jobIds).eq('status', 'pending').limit(200)),
    optional(db.from('agent_sessions').select(SESSION_COLUMNS).in('job_id', jobIds).limit(200)),
  ]);
  return { tasks, results, approvals: approvals || [], sessions: sessions || [] };
}

function graphContext(job, graph, agents) {
  const sessions = graph.sessions.filter((session) => session.job_id === job.id);
  return {
    tasks: graph.tasks.filter((task) => task.job_id === job.id),
    results: graph.results.filter((result) => result.job_id === job.id),
    approvals: graph.approvals.filter((approval) => approval.job_id === job.id),
    sessions,
    agents,
  };
}

function isWorkApi(pathname) {
  // Exact boundary: `/api/workspaces` and `/api/workflows` must stay with their existing handlers.
  return pathname === '/api/work' || pathname.startsWith('/api/work/');
}

export async function handlePlatformApi({ db, request, response, url, sendJson }) {
  if (!isWorkApi(url.pathname)) return false;
  try {
    if (request.method !== 'GET') return sendJson(response, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }), true;
    const path = url.pathname;
    if (path === '/api/work') {
      return sendJson(response, 200, {
        ok: true,
        contract: 'fahad-work-platform/1',
        tiers: ['executive', 'operational', 'technical'],
        lifecycle: LIFECYCLE,
        history: 'HISTORY',
        endpoints: ['current', 'history', 'objectives', 'employees', 'projects', 'results', 'conversations', 'sessions', 'attention', 'workers', 'diagnostics', 'cleanup-preview', 'stream'],
      }), true;
    }
    if (path === '/api/work/stream') return stream(db, request, response, url), true;
    if (path === '/api/work/workers') return sendJson(response, 200, { ok: true, workers: await workers(db) }), true;
    if (path === '/api/work/cleanup-preview') return sendJson(response, 200, { ok: true, preview: await cleanup(db) }), true;
    if (path === '/api/work/projects') return sendJson(response, 200, await projects(db, url)), true;

    const projectMatch = path.match(/^\/api\/work\/projects\/([0-9a-f-]{36})$/i);
    if (projectMatch) return sendJson(response, 200, { ok: true, project: await projectDetail(db, uuid(projectMatch[1], 'projectId'), url) }), true;

    const workspaceId = uuid(url.searchParams.get('workspaceId'), 'workspaceId');
    const project = await requireProject(db, workspaceId);
    if (path === '/api/work/current') return sendJson(response, 200, { ok: true, workspaceId, ...(await current(db, project)) }), true;
    if (path === '/api/work/history') return sendJson(response, 200, { ok: true, workspaceId, ...(await history(db, project, url)) }), true;
    if (path === '/api/work/attention') return sendJson(response, 200, { ok: true, workspaceId, items: await attention(db, workspaceId) }), true;
    if (path === '/api/work/employees') return sendJson(response, 200, { ok: true, workspaceId, employees: await employees(db, workspaceId, url) }), true;
    if (path === '/api/work/results') return sendJson(response, 200, { ok: true, workspaceId, ...(await resultList(db, workspaceId, url)) }), true;
    if (path === '/api/work/conversations') return sendJson(response, 200, { ok: true, workspaceId, ...(await conversationList(db, workspaceId, url)) }), true;
    if (path === '/api/work/sessions') return sendJson(response, 200, { ok: true, workspaceId, ...(await sessionList(db, workspaceId, url)) }), true;
    if (path === '/api/work/diagnostics') return sendJson(response, 200, { ok: true, workspaceId, ...(await diagnostics(db, workspaceId, url)) }), true;

    const objectiveMatch = path.match(/^\/api\/work\/objectives\/([0-9a-f-]{36})$/i);
    if (objectiveMatch) return sendJson(response, 200, { ok: true, objective: await objective(db, workspaceId, uuid(objectiveMatch[1], 'objectiveId'), url) }), true;
    const employeeMatch = path.match(/^\/api\/work\/employees\/([a-z][a-z0-9-]{1,40})$/i);
    if (employeeMatch) {
      const record = await oneEmployee(db, workspaceId, employeeMatch[1], url);
      if (!record) return sendJson(response, 404, { ok: false, error: 'EMPLOYEE_NOT_FOUND' }), true;
      return sendJson(response, 200, { ok: true, workspaceId, employee: record }), true;
    }
    const resultMatch = path.match(/^\/api\/work\/results\/([0-9a-f-]{36})$/i);
    if (resultMatch) return sendJson(response, 200, { ok: true, result: await oneResult(db, workspaceId, uuid(resultMatch[1], 'resultId'), url) }), true;
    const conversationMatch = path.match(/^\/api\/work\/conversations\/([0-9a-f-]{36})$/i);
    if (conversationMatch) return sendJson(response, 200, { ok: true, conversation: await oneConversation(db, workspaceId, uuid(conversationMatch[1], 'conversationId')) }), true;
    const sessionMatch = path.match(/^\/api\/work\/sessions\/([0-9a-f-]{36})$/i);
    if (sessionMatch) return sendJson(response, 200, { ok: true, session: await oneSession(db, workspaceId, uuid(sessionMatch[1], 'sessionId')) }), true;
    return sendJson(response, 404, { ok: false, error: 'NOT_FOUND' }), true;
  } catch (error) {
    return sendJson(response, error.statusCode || 500, { ok: false, error: String(error.message || 'Request failed').slice(0, 300) }), true;
  }
}

function stream(db, request, response, url) {
  const workspaceId = uuid(url.searchParams.get('workspaceId'), 'workspaceId');
  if (!streams.has(db)) streams.set(db, new WorkStream({ db }));
  streams.get(db).subscribe(workspaceId, response, { lastEventId: request.headers?.['last-event-id'] || null });
}

async function current(db, project) {
  const jobs = await rows(db.from('jobs').select(JOB_COLUMNS).eq('project_id', project.id).in('status', [...OPEN_JOB_STATUSES]).order('created_at', { ascending: false }).limit(100));
  const agents = await rows(db.from('agents').select('id,slug,name').limit(40));
  const graph = await loadGraph(db, jobs.map((job) => job.id));
  const sessionApprovals = graph.sessions.length
    ? await optional(db.from('agent_approvals').select('id,session_id,tool_name,summary,status,requested_at').in('session_id', graph.sessions.map((session) => session.id)).eq('status', 'pending').limit(100))
    : [];
  return currentWork({ jobs, tasks: graph.tasks, agents, sessions: graph.sessions, approvals: [...graph.approvals, ...(sessionApprovals || [])], results: graph.results });
}

async function history(db, project, url) {
  const category = url.searchParams.get('category');
  const statuses = category ? [category.toLowerCase()].filter((status) => TERMINAL_JOB_STATUSES.includes(status)) : [...TERMINAL_JOB_STATUSES];
  if (category && !statuses.length) throw Object.assign(new Error('INVALID_CATEGORY'), { statusCode: 400 });
  const jobs = await rows(db.from('jobs').select(JOB_COLUMNS).eq('project_id', project.id).in('status', statuses).order('completed_at', { ascending: false }).limit(200));
  const agents = await rows(db.from('agents').select('id,slug,name').limit(40));
  const query = url.searchParams.get('q') || '';
  const filtered = jobs.filter((job) => matchesQuery([job.title, job.goal], query));
  const page = paginate(filtered, { limit: url.searchParams.get('limit'), cursor: url.searchParams.get('cursor') });
  const graph = await loadGraph(db, page.items.map((job) => job.id));
  return {
    ...page.page,
    objectives: page.items.map((job) => projectTier(objectiveSummary({ job, ...graphContext(job, graph, agents) }), 'executive')),
  };
}

async function objective(db, workspaceId, jobId, url) {
  const tier = normalizeTier(url.searchParams.get('tier') || 'operational');
  const job = await maybe(db.from('jobs').select(JOB_COLUMNS).eq('id', jobId).maybeSingle());
  if (!job || job.project_id !== workspaceId) throw Object.assign(new Error('OBJECTIVE_NOT_FOUND'), { statusCode: 404 });
  const agents = await rows(db.from('agents').select('id,slug,name').limit(40));
  const graph = await loadGraph(db, [jobId]);
  const summary = objectiveSummary({ job, ...graphContext(job, graph, agents) });
  if (tier !== 'technical') return projectTier(summary, tier);
  const [attempts, events] = await Promise.all([
    optional(db.from('model_attempts').select('id,provider,model,status,route,cost_usd,input_tokens,output_tokens,started_at,ended_at,error_code').eq('job_id', jobId).order('started_at', { ascending: false }).limit(100)),
    optional(db.from('events').select('id,type,level,message,created_at').eq('job_id', jobId).order('created_at', { ascending: false }).limit(100)),
  ]);
  return { ...summary, technical: { attempts, events, cost: costSummary({ attempts, activeJobIds: jobLifecycle(job).current ? [jobId] : [] }) } };
}

async function employees(db, workspaceId, url) {
  const bundle = await employeeBundle(db, workspaceId, { allProjects: url.searchParams.get('scope') === 'owner' });
  return employeeWorkloads(bundle).map((employee) => ({
    ...employee,
    completedWork: { recent: employee.completedWork.recent.slice(0, 5), basis: employee.completedWork.basis, lifetime: 'UNKNOWN' },
  }));
}

async function oneEmployee(db, workspaceId, slug, url) {
  const bundle = await employeeBundle(db, workspaceId, { allProjects: url.searchParams.get('scope') === 'owner' });
  return employeeWorkload(slug, bundle);
}

async function employeeBundle(db, workspaceId, { allProjects = false } = {}) {
  let openQuery = db.from('jobs').select(JOB_COLUMNS).in('status', [...OPEN_JOB_STATUSES]).limit(100);
  let recentQuery = db.from('jobs').select(JOB_COLUMNS).in('status', [...TERMINAL_JOB_STATUSES]).order('completed_at', { ascending: false }).limit(40);
  if (!allProjects) {
    openQuery = openQuery.eq('project_id', workspaceId);
    recentQuery = recentQuery.eq('project_id', workspaceId);
  }
  const [openJobs, recentJobs, agents, openSessions] = await Promise.all([
    rows(openQuery),
    rows(recentQuery),
    rows(db.from('agents').select('id,slug,name').limit(40)),
    optional(db.from('agent_sessions').select(SESSION_COLUMNS).eq('workspace_id', workspaceId).in('status', [...OPEN_SESSION_STATUSES]).limit(50)),
  ]);
  const openGraph = await loadGraph(db, openJobs.map((job) => job.id));
  const recentGraph = await loadGraph(db, recentJobs.map((job) => job.id));
  return {
    agents,
    jobs: [...openJobs, ...recentJobs],
    tasks: openGraph.tasks,
    completedTasks: recentGraph.tasks,
    sessions: [...(openSessions || []), ...openGraph.sessions, ...recentGraph.sessions],
    approvals: [...openGraph.approvals, ...recentGraph.approvals],
  };
}

async function resultList(db, workspaceId, url) {
  const jobs = await rows(db.from('jobs').select('id,project_id,title,goal,status,created_at').eq('project_id', workspaceId).order('created_at', { ascending: false }).limit(80));
  const jobIds = jobs.map((job) => job.id);
  const results = jobIds.length
    ? await rows(db.from('results').select('id,job_id,task_id,agent_id,kind,summary,content,created_at').in('job_id', jobIds).order('created_at', { ascending: false }).limit(200))
    : [];
  const agents = await rows(db.from('agents').select('id,slug,name').limit(40));
  const query = url.searchParams.get('q') || '';
  const includeTests = url.searchParams.get('includeTests') === '1';
  const summaries = results.map((result) => {
    const job = jobs.find((row) => row.id === result.job_id);
    return { summary: resultSummary({ result, job, agents }), job };
  }).filter(({ summary, job }) => matchesQuery([summary.title, summary.executiveSummary], query) && (includeTests || classifyWork(job).class !== 'TEST')).map(({ summary }) => summary);
  const page = paginate(summaries, { limit: url.searchParams.get('limit'), cursor: url.searchParams.get('cursor') });
  return { ...page.page, results: page.items };
}

async function oneResult(db, workspaceId, resultId, url) {
  const view = url.searchParams.get('view') || 'summary';
  if (!['summary', 'full', 'technical'].includes(view)) throw Object.assign(new Error('INVALID_VIEW'), { statusCode: 400 });
  const result = await maybe(db.from('results').select('id,job_id,task_id,agent_id,kind,summary,content,format,created_at').eq('id', resultId).maybeSingle());
  if (!result) throw Object.assign(new Error('RESULT_NOT_FOUND'), { statusCode: 404 });
  const job = await maybe(db.from('jobs').select(JOB_COLUMNS).eq('id', result.job_id).maybeSingle());
  if (!job || job.project_id !== workspaceId) throw Object.assign(new Error('RESULT_NOT_FOUND'), { statusCode: 404 });
  const [agents, task, artifacts, files, attempts, events] = await Promise.all([
    rows(db.from('agents').select('id,slug,name').limit(40)),
    result.task_id ? maybe(db.from('tasks').select(TASK_COLUMNS).eq('id', result.task_id).maybeSingle()) : null,
    optional(db.from('artifacts').select('id,task_id,type,title,data,agent_slug').eq('job_id', job.id).limit(40)),
    optional(db.from('files').select('id,task_id,name,mime_type').eq('job_id', job.id).limit(40)),
    view === 'technical' ? optional(db.from('model_attempts').select('id,provider,model,status,route,cost_usd,input_tokens,output_tokens,error_code').eq('job_id', job.id).limit(50)) : null,
    view === 'technical' ? optional(db.from('events').select('id,type,message,created_at').eq('job_id', job.id).limit(50)) : null,
  ]);
  const usage = view === 'technical' ? costSummary({ attempts, activeJobIds: [] }) : null;
  return resultDetail({
    result, job, task, agents, artifacts: artifacts || [], files: files || [], attempts, events,
    usage: usage ? { costUsd: usage.totalSpendUsd, basis: usage.totalSpendBasis, tokens: attempts == null ? 'UNKNOWN' : attempts.reduce((sum, attempt) => sum + Number(attempt.input_tokens || 0) + Number(attempt.output_tokens || 0), 0) } : null,
  }, { view });
}

async function projects(db, url) {
  const list = await rows(db.from('projects').select('id,name,description,status,default_repository,created_at').order('name').limit(100));
  const saved = url.searchParams.get('savedId');
  const includeArchived = url.searchParams.get('includeArchived') === '1';
  const visible = includeArchived ? list : list.filter((project) => project.status !== 'archived');
  return {
    ok: true,
    defaultProjectId: recommendProject(list, saved)?.id || null,
    projects: visible.map((project) => ({ id: project.id, name: project.name, status: project.status || 'active', archived: project.status === 'archived', repository: project.default_repository || null })),
  };
}

async function projectDetail(db, projectId, url) {
  const project = await requireProject(db, projectId);
  const tier = normalizeTier(url.searchParams.get('tier') || 'executive');
  const [jobs, conversations, sessions] = await Promise.all([
    rows(db.from('jobs').select(JOB_COLUMNS).eq('project_id', projectId).order('created_at', { ascending: false }).limit(120)),
    optional(db.from('conversations').select('id,project_id,title,archived,updated_at,last_message_at').eq('project_id', projectId).order('last_message_at', { ascending: false }).limit(40)),
    optional(db.from('agent_sessions').select(SESSION_COLUMNS).eq('workspace_id', projectId).order('updated_at', { ascending: false }).limit(40)),
  ]);
  const agents = await rows(db.from('agents').select('id,slug,name').limit(40));
  const graph = await loadGraph(db, jobs.map((job) => job.id));
  const attempts = tier === 'technical'
    ? await optional(db.from('model_attempts').select('job_id,cost_usd,status,route,model,ended_at').eq('workspace_id', projectId).order('started_at', { ascending: false }).limit(200))
    : null;
  const summary = projectSummary({
    project, jobs, tasks: graph.tasks, agents, results: graph.results, sessions: [...graph.sessions, ...(sessions || [])],
    approvals: graph.approvals, conversations: conversations || [], costs: costSummary({ attempts, activeJobIds: jobs.filter((job) => jobLifecycle(job).current).map((job) => job.id) }),
  });
  if (tier === 'executive') {
    return { ...summary, history: summary.history.slice(0, 12), completedObjectives: summary.completedObjectives.slice(0, 12) };
  }
  return summary;
}

async function conversationList(db, workspaceId, url) {
  const includeArchived = url.searchParams.get('includeArchived') === '1';
  let query = db.from('conversations').select('id,project_id,title,archived,updated_at,last_message_at').eq('project_id', workspaceId).order('last_message_at', { ascending: false }).limit(100);
  if (!includeArchived) query = query.eq('archived', false);
  const conversations = await rows(query);
  const ids = conversations.map((conversation) => conversation.id);
  const jobs = ids.length ? await rows(db.from('jobs').select(JOB_COLUMNS).in('conversation_id', ids).limit(300)) : [];
  const index = conversationIndex(conversations, { jobs, query: url.searchParams.get('q') || '' });
  const page = paginate(index, { limit: url.searchParams.get('limit'), cursor: url.searchParams.get('cursor') });
  return { ...page.page, conversations: page.items };
}

async function oneConversation(db, workspaceId, conversationId) {
  const conversation = await maybe(db.from('conversations').select('id,project_id,title,archived,updated_at,last_message_at').eq('id', conversationId).maybeSingle());
  if (!conversation || conversation.project_id !== workspaceId) throw Object.assign(new Error('CONVERSATION_NOT_FOUND'), { statusCode: 404 });
  const [jobs, sessions] = await Promise.all([
    rows(db.from('jobs').select(JOB_COLUMNS).eq('conversation_id', conversationId).order('created_at', { ascending: true }).limit(100)),
    optional(db.from('agent_sessions').select(SESSION_COLUMNS).eq('conversation_id', conversationId).limit(50)),
  ]);
  const graph = await loadGraph(db, jobs.map((job) => job.id));
  return conversationSummary({ conversation, jobs, sessions: sessions || graph.sessions, results: graph.results, approvals: graph.approvals });
}

async function sessionList(db, workspaceId, url) {
  const scope = url.searchParams.get('scope') || 'current';
  if (!['current', 'history'].includes(scope)) throw Object.assign(new Error('INVALID_SCOPE'), { statusCode: 400 });
  const statuses = scope === 'current' ? [...OPEN_SESSION_STATUSES] : [...TERMINAL_SESSION_STATUSES];
  const sessions = await rows(db.from('agent_sessions').select(SESSION_COLUMNS).eq('workspace_id', workspaceId).in('status', statuses).order('updated_at', { ascending: false }).limit(100));
  const query = url.searchParams.get('q') || '';
  const filtered = sessions.filter((session) => matchesQuery([session.title, session.objective], query));
  const page = paginate(filtered, { limit: url.searchParams.get('limit'), cursor: url.searchParams.get('cursor') });
  return {
    ...page.page,
    scope,
    sessions: page.items.map((session) => ({
      id: session.id, title: session.title, status: session.status, phase: session.phase || null,
      jobId: session.job_id || null, conversationId: session.conversation_id || null,
      current: scope === 'current', working: session.status === 'running', updatedAt: session.updated_at,
    })),
  };
}

async function oneSession(db, workspaceId, sessionId) {
  const session = await maybe(db.from('agent_sessions').select(SESSION_COLUMNS).eq('id', sessionId).maybeSingle());
  if (!session || session.workspace_id !== workspaceId) throw Object.assign(new Error('SESSION_NOT_FOUND'), { statusCode: 404 });
  const approvals = await optional(db.from('agent_approvals').select('id,session_id,tool_name,summary,status,requested_at').eq('session_id', sessionId).limit(20));
  return {
    id: session.id,
    title: session.title,
    objective: session.objective,
    status: session.status,
    phase: session.phase || null,
    jobId: session.job_id,
    taskId: session.task_id,
    conversationId: session.conversation_id || null,
    working: session.status === 'running',
    current: OPEN_SESSION_STATUSES.includes(session.status),
    approvals: (approvals || []).filter((approval) => approval.status === 'pending'),
    result: session.result || null,
    updatedAt: session.updated_at,
    completedAt: session.completed_at || null,
  };
}

async function attention(db, workspaceId) {
  const [jobs, sessions, approvals, officeApprovals] = await Promise.all([
    rows(db.from('jobs').select(JOB_COLUMNS).eq('project_id', workspaceId).in('status', [...OPEN_JOB_STATUSES, 'failed']).order('created_at', { ascending: false }).limit(80)),
    optional(db.from('agent_sessions').select(SESSION_COLUMNS).eq('workspace_id', workspaceId).in('status', ['awaiting_approval', 'blocked', 'running', 'queued']).limit(50)),
    optional(db.from('agent_approvals').select('id,session_id,summary,status,requested_at').eq('workspace_id', workspaceId).eq('status', 'pending').limit(50)),
    optional(db.from('approvals').select('id,job_id,task_id,title,status,created_at').eq('status', 'pending').limit(50)),
  ]);
  const jobIds = jobs.map((job) => job.id);
  const tasks = jobIds.length ? await rows(db.from('tasks').select(TASK_COLUMNS).in('job_id', jobIds).limit(400)) : [];
  const scopedOffice = (officeApprovals || []).filter((approval) => jobIds.includes(approval.job_id));
  return attentionItems({ jobs, tasks, sessions: sessions || [], approvals: [...scopedOffice, ...(approvals || [])] });
}

async function workers(db) {
  const rowsWorkers = await optional(db.from('coding_workers').select('key,display_name,kind,enabled,health,health_basis,last_seen_at,last_error').limit(20));
  const activityRows = await optional(db.from('agent_sessions').select('status').in('status', ['running', 'blocked', 'awaiting_approval']).limit(100));
  const activity = {
    office: {
      running: (activityRows || []).filter((row) => row.status === 'running').length,
      blocked: (activityRows || []).filter((row) => row.status !== 'running').length,
    },
  };
  const loaded = Array.isArray(rowsWorkers);
  const board = workerBoard(loaded ? rowsWorkers : [], { activity, measured: loaded });
  return board.map((worker) => {
    const row = (rowsWorkers || []).find((item) => item.key === worker.key);
    if (!row) return worker;
    const truth = workerTruth({
      key: worker.key, kind: row.kind, enabled: row.enabled, executionMode: worker.manualOnly ? 'MANUAL_ONLY' : worker.executable ? 'EXECUTABLE' : 'DISABLED',
      authState: worker.authenticated === true ? 'AUTHENTICATED' : 'NOT_CONFIGURED', availability: worker.operational === 'BUSY' || worker.operational === 'IDLE' ? 'OPERATIONAL' : 'NOT_CONFIGURED',
      metrics: {},
    }, { supervisorOn: false, activity: activity[worker.key] || null });
    return { ...worker, diagnostics: { class: truth.class, status: truth.status } };
  });
}

async function diagnostics(db, workspaceId, url) {
  const section = url.searchParams.get('section') || 'summary';
  const [attempts, continuitySessions, leases, checkpoints, handoffs] = await Promise.all([
    optional(db.from('model_attempts').select('job_id,provider,model,status,route,cost_usd,input_tokens,output_tokens,error_code,started_at,ended_at').eq('workspace_id', workspaceId).order('started_at', { ascending: false }).limit(100)),
    optional(db.from('coding_worker_sessions').select('id,worker_key,status,objective,started_at,ended_at').eq('project_id', workspaceId).limit(50)),
    optional(db.from('coding_leases').select('id,worker_key,status,repository,branch').limit(20)),
    optional(db.from('coding_checkpoints').select('id,session_id,sequence,status,created_at').limit(20)),
    optional(db.from('coding_handoffs').select('id,from_worker,to_worker,status,reason,created_at').limit(20)),
  ]);
  const openJobs = await rows(db.from('jobs').select('id,status').eq('project_id', workspaceId).in('status', [...OPEN_JOB_STATUSES]).limit(50));
  const summary = {
    costs: costSummary({ attempts, activeJobIds: openJobs.map((job) => job.id) }),
    continuity: continuitySummary({ supervisorEnabled: false, sessions: continuitySessions, leases, checkpoints, handoffs }),
    workers: await workers(db),
  };
  if (section === 'summary') return { section, summary };
  if (section === 'costs') return { section, costs: summary.costs, attempts };
  if (section === 'continuity') return { section, continuity: summary.continuity, sessions: continuitySessions, leases, checkpoints, handoffs };
  if (section === 'workers') return { section, workers: summary.workers };
  throw Object.assign(new Error('INVALID_SECTION'), { statusCode: 400 });
}

async function cleanup(db) {
  const ids = [...CONFIRMED_TEST_JOB_IDS];
  const selectedJobs = await optional(db.from('jobs').select('id,title,goal,conversation_id,project_id,status').in('id', ids));
  let jobs = selectedJobs;
  if (selectedJobs) {
    const conversationIds = [...new Set(selectedJobs.map((job) => job.conversation_id).filter(Boolean))];
    if (conversationIds.length) {
      const related = await optional(db.from('jobs').select('id,title,goal,conversation_id,project_id,status').in('conversation_id', conversationIds));
      jobs = related == null ? null : [...new Map([...selectedJobs, ...related].map((job) => [job.id, job])).values()];
    }
  }
  const [tasks, runs, events, results, handoffs, artifacts, modelAttempts, toolExecutions, agentSessions, knowledgeItems, conversations] = await Promise.all([
    optional(db.from('tasks').select('id,job_id').in('job_id', ids)),
    optional(db.from('runs').select('id,job_id').in('job_id', ids)),
    optional(db.from('events').select('id,job_id').in('job_id', ids)),
    optional(db.from('results').select('id,job_id').in('job_id', ids)),
    optional(db.from('handoffs').select('id,job_id').in('job_id', ids)),
    optional(db.from('artifacts').select('id,job_id').in('job_id', ids)),
    optional(db.from('model_attempts').select('id,job_id').in('job_id', ids)),
    optional(db.from('tool_executions').select('id,job_id').in('job_id', ids)),
    optional(db.from('agent_sessions').select('id,job_id,conversation_id').in('job_id', ids)),
    optional(db.from('knowledge_items').select('id,job_id').in('job_id', ids)),
    optional(db.from('conversations').select('id,project_id').limit(50)),
  ]);
  const sessionIds = (agentSessions || []).map((session) => session.id);
  const [agentEvents, agentCheckpoints] = agentSessions == null ? [null, null] : await Promise.all([
    sessionIds.length ? optional(db.from('agent_events').select('id,session_id').in('session_id', sessionIds)) : [],
    sessionIds.length ? optional(db.from('agent_checkpoints').select('id,session_id').in('session_id', sessionIds)) : [],
  ]);
  const preview = cleanupPreview({
    selectedIds: ids, jobs, tasks, runs, events, results, handoffs, artifacts, modelAttempts, toolExecutions,
    agentSessions, agentEvents, agentCheckpoints, knowledgeItems, conversations, continuityTasks: null,
  });
  return { ...preview, executed: false, sql: `${preview.sql}\n-- executed: false\n` };
}

export { streams as platformStreams };
