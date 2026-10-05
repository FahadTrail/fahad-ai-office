// Project Deliverables Center (V5.3): one board of what the Office delivered —
// or is delivering — for a project. It is built only from rows the Hub
// already reads: employee outputs (results + artifacts), CHIEF's consolidated
// results and CODING sessions (pull request, CI, files). Every status is
// derived from those rows. An output that does not exist yet is shown as in
// progress, waiting or blocked, never as an invented preview.
//
// The only new state is the owner's curation (pin, archive, approve, revision
// requested) in deliverable_reviews. Until that migration is applied the
// board reads it as unavailable and every other part keeps working.

import { officeAgent, parseOutput } from './office/agents.js';
import { artifactView } from './hub-office.js';
import { ownerAction, taskNow } from './hub-workspace.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_RE = /^(task|session|artifact):([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

// Owner-facing order: what needs Fahad first, what is ready last.
export const DELIVERABLE_STATUSES = Object.freeze(['needs_fahad', 'blocked', 'needs_review', 'in_progress', 'waiting', 'ready']);

// Task stages that produce an owner deliverable. Planning, consults and the
// hand-off to CODING are steps, not deliverables (CODING is its session).
const OFFICE_STAGES = new Set(['specialist', 'research', 'synthesis', 'chief_review', 'direct']);
const CHIEF_STAGES = new Set(['synthesis', 'chief_review']);
const VISUAL_ORDER = ['moodboard', 'financial_model', 'chart', 'kanban', 'timeline', 'compliance_matrix', 'audit_report', 'content_calendar', 'risk_matrix', 'flow', 'table', 'checklist', 'evidence'];

// Bounded like the existing Office reads: the newest objectives, the library's
// 200-artifact maximum and the outputs of those objectives.
const JOB_WINDOW = 60;
const ARTIFACT_WINDOW = 200;
const SESSION_WINDOW = 60;
const RESULT_WINDOW = 500;
const REPORT_LIMIT = 60_000;

const ARTIFACT_COLUMNS = 'id,project_id,job_id,task_id,conversation_id,agent_slug,type,title,data,created_at';
const SESSION_COLUMNS = 'id,workspace_id,job_id,title,objective,repository,work_branch,status,phase,state,result,blocker,error_code,next_action,conversation_id,created_at,updated_at,started_at,completed_at';
const REVIEW_COLUMNS = 'deliverable_key,pinned,archived,decision,decision_key,decision_note,decided_at,updated_at';

const briefOf = (task) => { try { return JSON.parse(task?.brief || '{}') || {}; } catch { return {}; } };
const time = (value) => { const ms = Date.parse(value || ''); return Number.isFinite(ms) ? ms : 0; };
const newest = (...values) => values.filter(Boolean).reduce((best, value) => (time(value) > time(best) ? value : best), null);
const clamp = (text, max) => {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
};
const plain = (text) => String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/^#+\s*/gm, '').replace(/\*\*|__|`|^\s*[-*•]\s+/gm, '');
const bySequence = (a, b) => (Number(a.sequence || 0) - Number(b.sequence || 0)) || (time(a.created_at) - time(b.created_at));
const httpsLink = (value) => (/^https:\/\/[^\s"'<>]{4,500}$/i.test(String(value || '')) ? String(value) : null);

export const stripArtifactBlocks = (text) => String(text || '').replace(/```artifact[\s\S]*?```/g, '').replace(/\n{3,}/g, '\n\n').trim();

function section(text, name) {
  const match = stripArtifactBlocks(text).match(new RegExp(`^##\\s*${name}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'mi'));
  return match ? match[1].trim() : '';
}

function agentOf(slug) {
  const employee = officeAgent(slug);
  return employee ? { key: employee.key, label: employee.label, slug: employee.slug } : { key: slug || 'office', label: slug || 'Office', slug: slug || null };
}

// The employee's own main deliverable leads (FINANCE → financial model,
// CREATIVE → moodboard …), then the most visual type.
export function primaryType(artifacts, agentSlug) {
  const types = artifacts.map((artifact) => artifact.type);
  const preferred = officeAgent(agentSlug)?.artifacts || [];
  return preferred.find((type) => types.includes(type)) || VISUAL_ORDER.find((type) => types.includes(type)) || types[0] || null;
}

// Review flags come from the Office's validators and reviewers (AUDIT's
// verdict, LEGAL's classification, FINANCE's code check), never from the
// board's own judgement.
export function artifactFlags(artifacts) {
  const flags = [];
  for (const artifact of artifacts) {
    const data = artifact.data || {};
    if (artifact.type === 'audit_report' && ['NEEDS WORK', 'BLOCKED'].includes(data.verdict)) flags.push({ code: 'audit', verdict: data.verdict });
    if (artifact.type === 'compliance_matrix') {
      const count = (Array.isArray(data.items) ? data.items : []).filter((item) => ['RISK FLAG', 'PROFESSIONAL REVIEW REQUIRED'].includes(item?.classification)).length;
      if (count) flags.push({ code: 'compliance', count });
    }
    const state = String(data.validation?.state || '');
    if (artifact.type === 'financial_model' && ['INCONSISTENT', 'INSUFFICIENT DATA'].includes(state)) flags.push({ code: 'finance', state });
  }
  return flags;
}

// Versions: a CHIEF revision round re-runs a workstream (brief.revisesTaskId)
// and the synthesis runs again in the same objective. Each chain is one card
// that shows its newest delivered version; older versions stay readable.
export function versionChains(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const roots = new Map();
  const rootOf = (task, seen = new Set()) => {
    if (roots.has(task.id)) return roots.get(task.id);
    const brief = briefOf(task);
    let root = task.id;
    if (brief.stage === 'synthesis') {
      root = tasks.filter((other) => other.job_id === task.job_id && briefOf(other).stage === 'synthesis').toSorted(bySequence)[0]?.id || task.id;
    } else if (brief.revisesTaskId && byId.has(brief.revisesTaskId) && !seen.has(task.id)) {
      seen.add(task.id);
      root = rootOf(byId.get(brief.revisesTaskId), seen);
    }
    roots.set(task.id, root);
    return root;
  };
  const chains = new Map();
  for (const task of tasks) {
    const root = rootOf(task);
    if (!chains.has(root)) chains.set(root, []);
    chains.get(root).push(task);
  }
  for (const chain of chains.values()) chain.sort(bySequence);
  return { rootOf, chains };
}

// A decision applies to the exact version Fahad decided on; a newer version
// starts clean.
function decisionFor(review, versionKey) {
  return review?.decision && review.decision_key === versionKey ? review.decision : null;
}

function deliveredStatus({ review, versionKey, decisions, flags }) {
  const decided = decisionFor(review, versionKey);
  if (decided === 'approved') return { status: 'ready', reason: { code: 'approved', at: review.decided_at } };
  if (decided === 'revision_requested') return { status: 'needs_review', reason: { code: 'revision_requested', at: review.decided_at } };
  if (decisions) return { status: 'needs_fahad', reason: { code: 'decision', text: clamp(plain(decisions), 280) } };
  if (flags.length) return { status: 'needs_review', reason: flags[0] };
  return { status: 'ready', reason: null };
}

function pendingStatus(task, { job, byId, agentById, now }) {
  if (task.status === 'failed') return { status: 'blocked', reason: { code: 'failed' } };
  if (task.status === 'blocked') return { status: 'blocked', reason: { code: 'upstream_failed' } };
  if (job?.status === 'failed') return { status: 'blocked', reason: { code: 'stopped' } };
  if (['running', 'assigned'].includes(task.status)) return { status: 'in_progress', reason: { code: 'working', since: task.started_at || task.created_at } };
  if (task.not_before && time(task.not_before) > now) return { status: 'waiting', reason: { code: 'capacity', until: task.not_before } };
  const waitingFor = (task.depends_on || []).map((id) => byId.get(id)).filter((dep) => dep && !['done', 'skipped'].includes(dep.status))
    .map((dep) => officeAgent(agentById.get(dep.agent_id)?.slug)?.label).filter(Boolean);
  if (waitingFor.length) return { status: 'waiting', reason: { code: 'dependency', agents: [...new Set(waitingFor)] } };
  return { status: 'waiting', reason: { code: 'queued' } };
}

function codingStatus(session, approvals, review, versionKey) {
  const need = ownerAction(session, approvals);
  if (need?.kind === 'approval') return { status: 'needs_fahad', reason: { code: 'approval', text: clamp(need.items.map((item) => item.what).join('; '), 240), risk: need.items.some((item) => ['high', 'critical'].includes(String(item.risk || '').toLowerCase())) ? 'high' : 'normal' } };
  if (need?.kind === 'question') return { status: 'needs_fahad', reason: { code: 'question', text: clamp(need.question, 280) } };
  if (need?.kind === 'blocked') return { status: 'needs_fahad', reason: { code: 'paused', text: clamp(need.explanation, 280) } };
  if (['running', 'assigned'].includes(session.status)) return { status: 'in_progress', reason: { code: 'working', since: session.started_at || session.created_at, phase: session.phase || null } };
  if (session.status === 'queued') return { status: 'waiting', reason: { code: 'queued' } };
  if (session.status === 'failed') return { status: 'blocked', reason: { code: 'failed', text: clamp(session.blocker || session.error_code || '', 280) || null } };
  const ci = session.state?.ci?.state || session.result?.ci?.state || null;
  return deliveredStatus({ review, versionKey, decisions: '', flags: ci === 'failure' ? [{ code: 'ci_failed' }] : [] });
}

function publicReview(row) {
  if (!row) return null;
  return { pinned: Boolean(row.pinned), archived: Boolean(row.archived), decision: row.decision || null, decisionKey: row.decision_key || null,
    note: row.decision_note || null, decidedAt: row.decided_at || null, updatedAt: row.updated_at || null };
}

// The board. Pure: the same rows always give the same deliverables.
export function deliverablesBoard({ project, jobs = [], tasks = [], agents = [], results = [], artifacts = [], sessions = [], approvals = [], launches = [], reviews = null, now = Date.now() }) {
  const reviewsAvailable = Array.isArray(reviews);
  const reviewByKey = new Map((reviews || []).map((row) => [String(row.deliverable_key).toLowerCase(), row]));
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  // A CODING session runs in its own job; that job is not an objective.
  const codingJobs = new Set(tasks.filter((task) => briefOf(task).workflow === 'coding-agent').map((task) => task.job_id));
  const objectiveOf = (job) => (job && !codingJobs.has(job.id)
    ? { id: job.id, title: clamp(job.title || job.goal, 140) || null, status: job.status || null, priority: job.priority || 'normal', createdAt: job.created_at || null }
    : null);

  // The newest employee output per task. complete_task also files the last
  // task's output again as the job's "final"; prefer the task's own row.
  const resultByTask = new Map();
  for (const result of results.toSorted((a, b) => time(a.created_at) - time(b.created_at))) {
    if (!result.task_id) continue;
    const current = resultByTask.get(result.task_id);
    if (result.kind !== 'final' || !current || current.kind === 'final') resultByTask.set(result.task_id, result);
  }
  const artifactRows = artifacts.toSorted((a, b) => time(a.created_at) - time(b.created_at));
  const artifactsByTask = new Map();
  for (const artifact of artifactRows) if (artifact.task_id) artifactsByTask.set(artifact.task_id, [...(artifactsByTask.get(artifact.task_id) || []), artifact]);

  const eligible = tasks.filter((task) => {
    const job = jobById.get(task.job_id);
    if (!job || job.status === 'cancelled' || task.status === 'skipped') return false;
    const stage = briefOf(task).stage;
    if (!OFFICE_STAGES.has(stage)) return false;
    // A direct chat is a deliverable only when it produced a structured output.
    return stage !== 'direct' || (artifactsByTask.get(task.id) || []).length > 0;
  });
  const { chains } = versionChains(eligible);
  const used = new Set();
  const items = [];

  for (const [root, chain] of chains) {
    const latest = chain.at(-1);
    const display = latest.status === 'done' ? latest : chain.filter((task) => task.status === 'done').at(-1) || latest;
    const stage = briefOf(latest).stage;
    const agentRow = agentById.get(latest.agent_id);
    const agent = agentOf(agentRow?.slug);
    const job = jobById.get(latest.job_id);
    const result = display.status === 'done' ? resultByTask.get(display.id) : null;
    const parsed = result ? parseOutput(result.content) : { summary: '', decisions: '' };
    for (const task of chain) for (const artifact of artifactsByTask.get(task.id) || []) used.add(artifact.id);
    const own = (display.status === 'done' ? artifactsByTask.get(display.id) || [] : []).map(artifactView);
    const primary = primaryType(own, agentRow?.slug);
    own.sort((a, b) => (a.type === primary ? -1 : b.type === primary ? 1 : 0));
    const versionKey = `task:${display.id}`;
    const reviewKey = `task:${root}`;
    const review = reviewByKey.get(reviewKey) || null;
    const { status, reason } = latest.status === 'done'
      ? deliveredStatus({ review, versionKey, decisions: parsed.decisions, flags: artifactFlags(own) })
      : pendingStatus(latest, { job, byId, agentById, now });
    const title = stage === 'specialist' ? latest.title : stage === 'direct' ? own[0]?.title || job?.title || latest.title : job?.title || latest.title;
    items.push({
      key: versionKey, reviewKey, kind: 'office', stage, agent,
      type: primary || (CHIEF_STAGES.has(stage) ? 'synthesis' : 'report'),
      types: own.length ? [...new Set(own.map((artifact) => artifact.type))] : [CHIEF_STAGES.has(stage) ? 'synthesis' : 'report'],
      title: clamp(title, 160) || agent.label,
      summary: clamp(plain(parsed.summary || result?.summary), 320) || null,
      decisions: parsed.decisions ? clamp(plain(parsed.decisions), 400) : null,
      status, reason,
      createdAt: chain[0].created_at || null,
      updatedAt: newest(latest.completed_at, latest.started_at, latest.created_at, result?.created_at),
      deliveredAt: display.status === 'done' ? newest(display.completed_at, result?.created_at) : null,
      objective: objectiveOf(job), priority: job?.priority || 'normal', conversationId: job?.conversation_id || null,
      artifacts: own, coding: null,
      version: {
        number: chain.indexOf(display) + 1, count: chain.length, pending: latest !== display,
        list: chain.map((task, index) => ({ key: `task:${task.id}`, number: index + 1, delivered: task.status === 'done', revision: Boolean(briefOf(task).revision), at: task.completed_at || task.created_at || null })),
      },
      review: publicReview(review),
      links: { workflow: job && !codingJobs.has(job.id) ? `#/workflow/${job.id}` : null, chat: job?.conversation_id ? `#/chat/${job.conversation_id}` : null, task: null },
    });
  }

  // CODING: one card per session (a cancelled session is not a deliverable).
  const pending = new Map();
  for (const approval of approvals) if (approval.status === 'pending') pending.set(approval.session_id, [...(pending.get(approval.session_id) || []), approval]);
  const launchedFrom = new Map(launches.filter((event) => event.payload?.session_id).map((event) => [event.payload.session_id, event.job_id]));
  for (const session of sessions) {
    if (session.status === 'cancelled') continue;
    const key = `session:${session.id}`;
    const review = reviewByKey.get(key) || null;
    const job = jobById.get(launchedFrom.get(session.id)) || (codingJobs.has(session.job_id) ? null : jobById.get(session.job_id)) || null;
    const state = session.state && typeof session.state === 'object' ? session.state : {};
    const result = session.result && typeof session.result === 'object' ? session.result : {};
    const pr = state.pr || result.pr || null;
    const files = Array.isArray(state.filesChanged) ? state.filesChanged : Array.isArray(result.filesChanged) ? result.filesChanged : [];
    const deploy = state.deploy || result.deploy || null;
    const { status, reason } = codingStatus(session, pending.get(session.id) || [], review, key);
    items.push({
      key, reviewKey: key, kind: 'coding', stage: 'coding', agent: agentOf('coding-agent'), type: 'code', types: ['code'],
      title: clamp(session.title, 160) || 'CODING',
      summary: clamp(plain(result.summary), 320) || null, decisions: null, status, reason,
      createdAt: session.created_at || null, updatedAt: newest(session.updated_at, session.completed_at, session.created_at),
      deliveredAt: session.status === 'completed' ? session.completed_at || session.updated_at || null : null,
      objective: objectiveOf(job), priority: job?.priority || 'normal', conversationId: session.conversation_id || job?.conversation_id || null,
      artifacts: [],
      coding: {
        taskId: session.id, repository: session.repository || null, branch: session.work_branch || null, phase: session.phase || null,
        now: taskNow(session), pr: pr?.number ? { number: pr.number, url: httpsLink(pr.url) } : null,
        ci: state.ci?.state || result.ci?.state || null,
        tests: state.lastTest ? (state.lastTest.exitCode === 0 ? 'passing' : 'failing') : null,
        deploy: deploy?.status || deploy?.state || null,
        files: files.slice(0, 12).map((file) => clamp(file, 160)), filesCount: files.length,
      },
      version: { number: 1, count: 1, pending: false, list: [] },
      review: publicReview(review),
      links: { workflow: job && !codingJobs.has(job.id) ? `#/workflow/${job.id}` : null, chat: session.conversation_id ? `#/chat/${session.conversation_id}` : null, task: `#/task/${session.id}` },
    });
  }

  // Structured outputs that are not part of a card above (older objectives,
  // consults): each stands on its own.
  for (const row of artifactRows) {
    if (used.has(row.id)) continue;
    const artifact = artifactView(row);
    const key = `artifact:${row.id}`;
    const review = reviewByKey.get(key) || null;
    const job = jobById.get(row.job_id) || null;
    const { status, reason } = deliveredStatus({ review, versionKey: key, decisions: '', flags: artifactFlags([artifact]) });
    items.push({
      key, reviewKey: key, kind: 'artifact', stage: null, agent: agentOf(row.agent_slug), type: row.type, types: [row.type],
      title: clamp(row.title, 160) || row.type, summary: null, decisions: null, status, reason,
      createdAt: row.created_at || null, updatedAt: row.created_at || null, deliveredAt: row.created_at || null,
      objective: objectiveOf(job), priority: job?.priority || 'normal', conversationId: row.conversation_id || job?.conversation_id || null,
      artifacts: [artifact], coding: null,
      version: { number: 1, count: 1, pending: false, list: [] },
      review: publicReview(review),
      links: { workflow: job && !codingJobs.has(job.id) ? `#/workflow/${job.id}` : null, chat: row.conversation_id ? `#/chat/${row.conversation_id}` : null, task: null },
    });
  }

  items.sort((a, b) => time(b.updatedAt) - time(a.updatedAt));
  const visible = items.filter((item) => !item.review?.archived);
  const counts = Object.fromEntries(DELIVERABLE_STATUSES.map((status) => [status, 0]));
  for (const item of visible) counts[item.status] += 1;

  // CHIEF's voice for the header: the newest consolidated result.
  const chiefTasks = new Set(eligible.filter((task) => CHIEF_STAGES.has(briefOf(task).stage)).map((task) => task.id));
  const chiefResult = [...resultByTask.values()].filter((result) => chiefTasks.has(result.task_id)).toSorted((a, b) => time(b.created_at) - time(a.created_at))[0] || null;
  const chiefText = chiefResult ? section(chiefResult.content, 'Executive summary') || section(chiefResult.content, 'Summary') || parseOutput(chiefResult.content).summary : '';
  const objectives = [...new Map(items.filter((item) => item.objective).map((item) => [item.objective.id, item.objective])).values()]
    .toSorted((a, b) => time(b.createdAt) - time(a.createdAt));

  return {
    project: project ? { id: project.id, name: project.name, description: project.description || '', repository: project.default_repository || null } : null,
    summary: {
      total: visible.length, archived: items.length - visible.length, counts,
      lastUpdate: visible.reduce((best, item) => newest(best, item.updatedAt), null),
      chief: chiefText ? { text: clamp(plain(chiefText), 420), at: chiefResult.created_at, jobId: chiefResult.job_id } : null,
    },
    objectives,
    reviews: { available: reviewsAvailable },
    deliverables: items,
  };
}

// ------------------------------------------------------------------ handler

function uuid(value, name) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw Object.assign(new Error(`${name} must be a UUID`), { statusCode: 400 });
  return value.toLowerCase();
}

async function rows(query) {
  const { data, error } = await query;
  if (error) throw Object.assign(new Error(`Could not load deliverables: ${error.message}`), { statusCode: 500 });
  return data || [];
}

async function optional(query) {
  const { data, error } = await query;
  return error ? [] : data || [];
}

async function one(query) {
  const { data, error } = await query;
  if (error) throw Object.assign(new Error(`Could not load deliverables: ${error.message}`), { statusCode: 500 });
  return data || null;
}

// null = the owner-curation table is not available (migration not applied).
async function readReviews(db, projectId) {
  const { data, error } = await db.from('deliverable_reviews').select(REVIEW_COLUMNS).eq('project_id', projectId).limit(2000);
  return error ? null : data || [];
}

const missingTable = (error) => /PGRST205|42P01|does not exist|schema cache/i.test(`${error?.code || ''} ${error?.message || ''}`);
const reviewsUnavailable = () => Object.assign(new Error('Pin, archive and approval need the V5.3 database update, which is not applied yet. Everything else works.'), { statusCode: 503, code: 'DELIVERABLE_REVIEWS_UNAVAILABLE' });

export async function loadBoard(db, workspaceId, now = Date.now()) {
  const project = await one(db.from('projects').select('id,name,description,default_repository').eq('id', workspaceId).maybeSingle());
  if (!project) return null;
  const [jobs, agents, artifacts, sessions, approvals, reviews] = await Promise.all([
    rows(db.from('jobs').select('id,title,goal,status,progress,priority,conversation_id,created_at,completed_at').eq('project_id', workspaceId).order('created_at', { ascending: false }).limit(JOB_WINDOW)),
    rows(db.from('agents').select('id,slug,name')),
    optional(db.from('artifacts').select(ARTIFACT_COLUMNS).eq('project_id', workspaceId).order('created_at', { ascending: false }).limit(ARTIFACT_WINDOW)),
    rows(db.from('agent_sessions').select(SESSION_COLUMNS).eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(SESSION_WINDOW)),
    rows(db.from('agent_approvals').select('id,session_id,tool_name,action,risk,summary,arguments_preview,status,requested_at').eq('workspace_id', workspaceId).eq('status', 'pending')),
    readReviews(db, workspaceId),
  ]);
  const jobIds = jobs.map((job) => job.id);
  const [tasks, results, launches] = jobIds.length ? await Promise.all([
    rows(db.from('tasks').select('id,job_id,agent_id,title,status,brief,depends_on,sequence,started_at,completed_at,created_at,not_before').in('job_id', jobIds)),
    rows(db.from('results').select('id,job_id,task_id,kind,summary,content,created_at').in('job_id', jobIds).order('created_at', { ascending: false }).limit(RESULT_WINDOW)),
    optional(db.from('events').select('job_id,task_id,payload').in('job_id', jobIds).eq('payload->>kind', 'task_launched').limit(200)),
  ]) : [[], [], []];
  // Older structured outputs keep their objective title.
  const known = new Set(jobIds);
  const olderIds = [...new Set(artifacts.map((artifact) => artifact.job_id).filter((id) => id && !known.has(id)))].slice(0, 100);
  const older = olderIds.length ? await optional(db.from('jobs').select('id,title,goal,status,progress,priority,conversation_id,created_at,completed_at').in('id', olderIds)) : [];
  return deliverablesBoard({ project, jobs: [...jobs, ...older], tasks, agents, results, artifacts, sessions, approvals, launches, reviews, now });
}

// The full output of one office task version (the board carries summaries).
async function loadReport(db, workspaceId, taskId) {
  const task = await one(db.from('tasks').select('id,job_id,agent_id,title,status,completed_at').eq('id', taskId).maybeSingle());
  if (!task) return null;
  const job = await one(db.from('jobs').select('id,project_id').eq('id', task.job_id).maybeSingle());
  if (!job || job.project_id !== workspaceId) return null;
  const [results, artifacts] = await Promise.all([
    rows(db.from('results').select('kind,summary,content,created_at').eq('task_id', taskId).order('created_at', { ascending: true })),
    optional(db.from('artifacts').select(ARTIFACT_COLUMNS).eq('task_id', taskId).order('created_at', { ascending: true })),
  ]);
  const result = results.filter((row) => row.kind !== 'final').at(-1) || results.at(-1) || null;
  const text = result ? stripArtifactBlocks(result.content) : '';
  const parsed = result ? parseOutput(result.content) : { summary: '', decisions: '' };
  return {
    task: { id: task.id, status: task.status, completedAt: task.completed_at || null },
    report: result ? { text: text.slice(0, REPORT_LIMIT), truncated: text.length > REPORT_LIMIT, summary: clamp(plain(parsed.summary || result.summary), 600) || null,
      decisions: parsed.decisions ? clamp(plain(parsed.decisions), 1200) : null, at: result.created_at } : null,
    artifacts: artifacts.map(artifactView),
  };
}

// The chain a key belongs to, after proving the row is in this project.
async function reviewTarget(db, workspaceId, key) {
  const match = String(key || '').toLowerCase().match(KEY_RE);
  if (!match) throw Object.assign(new Error('Unknown deliverable'), { statusCode: 400 });
  const [, kind, id] = match;
  if (kind === 'session') {
    const session = await one(db.from('agent_sessions').select('id,workspace_id,status').eq('id', id).maybeSingle());
    return session && session.workspace_id === workspaceId ? { versionKey: `session:${id}`, reviewKey: `session:${id}`, delivered: session.status === 'completed' } : null;
  }
  if (kind === 'artifact') {
    const artifact = await one(db.from('artifacts').select('id,project_id').eq('id', id).maybeSingle());
    return artifact && artifact.project_id === workspaceId ? { versionKey: `artifact:${id}`, reviewKey: `artifact:${id}`, delivered: true } : null;
  }
  const task = await one(db.from('tasks').select('id,job_id,status').eq('id', id).maybeSingle());
  if (!task) return null;
  const job = await one(db.from('jobs').select('id,project_id').eq('id', task.job_id).maybeSingle());
  if (!job || job.project_id !== workspaceId) return null;
  // Same chain rules as the board: skipped steps and non-deliverable stages
  // never take part in a version chain.
  const siblings = (await rows(db.from('tasks').select('id,job_id,brief,status,sequence,created_at').eq('job_id', task.job_id)))
    .filter((row) => row.status !== 'skipped' && OFFICE_STAGES.has(briefOf(row).stage));
  const own = siblings.find((row) => row.id === id);
  if (!own) return null;
  const { rootOf } = versionChains(siblings);
  return { versionKey: `task:${id}`, reviewKey: `task:${rootOf(own)}`, delivered: task.status === 'done' };
}

async function saveReview(db, projectId, reviewKey, patch) {
  const existing = await db.from('deliverable_reviews').select(REVIEW_COLUMNS).eq('project_id', projectId).eq('deliverable_key', reviewKey).maybeSingle();
  if (existing.error) throw missingTable(existing.error) ? reviewsUnavailable() : Object.assign(new Error(`Could not save: ${existing.error.message}`), { statusCode: 500 });
  const write = existing.data
    ? await db.from('deliverable_reviews').update(patch).eq('project_id', projectId).eq('deliverable_key', reviewKey).select(REVIEW_COLUMNS)
    : await db.from('deliverable_reviews').insert({ project_id: projectId, deliverable_key: reviewKey, ...patch }).select(REVIEW_COLUMNS);
  if (write.error) throw missingTable(write.error) ? reviewsUnavailable() : Object.assign(new Error(`Could not save: ${write.error.message}`), { statusCode: 500 });
  return (Array.isArray(write.data) ? write.data[0] : write.data) || { deliverable_key: reviewKey, ...patch };
}

export async function handleDeliverablesApi({ db, request, response, url, sendJson, readJson, actor = null, now = () => Date.now() }) {
  const path = url.pathname;
  if (!/^\/api\/deliverables(\/|$)/.test(path)) return false;
  try {
    if (request.method === 'GET' && path === '/api/deliverables') {
      const board = await loadBoard(db, uuid(url.searchParams.get('workspaceId'), 'workspaceId'), now());
      if (!board) return sendJson(response, 404, { ok: false, error: 'PROJECT_NOT_FOUND' }), true;
      return sendJson(response, 200, { ok: true, ...board }), true;
    }
    if (request.method === 'GET' && path === '/api/deliverables/report') {
      const report = await loadReport(db, uuid(url.searchParams.get('workspaceId'), 'workspaceId'), uuid(url.searchParams.get('taskId'), 'taskId'));
      if (!report) return sendJson(response, 404, { ok: false, error: 'DELIVERABLE_NOT_FOUND' }), true;
      return sendJson(response, 200, { ok: true, ...report }), true;
    }
    if (request.method === 'POST' && path === '/api/deliverables/review') {
      const body = await readJson(request);
      const workspaceId = uuid(body.workspaceId, 'workspaceId');
      const target = await reviewTarget(db, workspaceId, body.key);
      if (!target) return sendJson(response, 404, { ok: false, error: 'DELIVERABLE_NOT_FOUND' }), true;
      const stamp = new Date(now()).toISOString();
      const patch = {};
      if (body.pinned !== undefined) patch.pinned = Boolean(body.pinned);
      if (body.archived !== undefined) patch.archived = Boolean(body.archived);
      if (body.decision !== undefined) {
        if (body.decision === null) Object.assign(patch, { decision: null, decision_key: null, decision_note: null, decided_by: null, decided_at: null });
        else if (['approved', 'revision_requested'].includes(body.decision)) {
          // A decision is about delivered work; an output still in progress
          // (or a CODING approval, which has its own flow) cannot be decided here.
          if (!target.delivered) throw Object.assign(new Error('This deliverable is not delivered yet.'), { statusCode: 409 });
          const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : '';
          Object.assign(patch, { decision: body.decision, decision_key: target.versionKey, decision_note: note || null, decided_by: String(actor || 'hub-owner').slice(0, 320), decided_at: stamp });
        } else throw Object.assign(new Error('Decision must be approved or revision_requested'), { statusCode: 400 });
      }
      if (!Object.keys(patch).length) throw Object.assign(new Error('Nothing to change'), { statusCode: 400 });
      const saved = await saveReview(db, workspaceId, target.reviewKey, { ...patch, updated_at: stamp });
      return sendJson(response, 200, { ok: true, reviewKey: target.reviewKey, review: publicReview(saved) }), true;
    }
    return sendJson(response, 404, { ok: false, error: 'NOT_FOUND' }), true;
  } catch (error) {
    return sendJson(response, error.statusCode || 500, { ok: false, error: String(error.message || 'Request failed').slice(0, 300), ...(error.code ? { code: error.code } : {}) }), true;
  }
}
