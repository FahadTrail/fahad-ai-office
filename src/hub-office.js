// The Office API: who is doing what right now (derived only from real task,
// session and approval rows), each employee's page, the workflow of a
// multi-agent objective, and what the Office's tools can actually do.
// Nothing here invents activity: an employee with no task row is AVAILABLE.

import { ACTIVE_AGENTS, OFFICE_AGENTS, officeAgent, parseOutput } from './office/agents.js';
import { ARTIFACT_TYPES } from './office/artifacts.js';
import { WAITING_MESSAGE } from './office/capacity.js';
import { ownerAction, approvalCard } from './hub-workspace.js';
import { OfficeStream, handoffView, timelineView } from './hub-office-live.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_SESSION = new Set(['completed', 'failed', 'cancelled']);
const RECENT_MS = 15 * 60_000;

export const AGENT_STATES = Object.freeze(['AVAILABLE', 'QUEUED', 'THINKING', 'WORKING', 'TESTING', 'WAITING', 'REVIEWING', 'NEEDS FAHAD', 'BLOCKED', 'COMPLETED', 'FAILED']);

function stageOf(brief) {
  try { return JSON.parse(brief)?.stage || null; } catch { return null; }
}

function workflowOf(brief) {
  try { return JSON.parse(brief) || {}; } catch { return {}; }
}

// Node state of one task inside its workflow.
export function taskState(task, byId, now = Date.now()) {
  if (task.status === 'running') return 'working';
  if (task.status === 'queued' && task.not_before && Date.parse(task.not_before) > now) return 'capacity';
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
  const rank = { 'NEEDS FAHAD': 0, WORKING: 1, TESTING: 1, THINKING: 1, REVIEWING: 1, WAITING: 2, QUEUED: 2, BLOCKED: 3, FAILED: 3, COMPLETED: 4, AVAILABLE: 5 };
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
    const state = taskState(task, taskById, now);
    if (state === 'capacity' && ['running', 'planning'].includes(job.status)) {
      offer(employee.slug, { state: 'WAITING', detail: WAITING_MESSAGE, assignment: { ...assignment, resumesAt: task.not_before }, since: task.created_at });
    } else if (state === 'working') {
      const stage = brief.stage;
      const visible = stage === 'chief_plan' ? 'THINKING' : ['synthesis', 'chief_review'].includes(stage) ? 'REVIEWING' : 'WORKING';
      const words = stage === 'chief_plan' ? 'Planning the work' : ['synthesis', 'chief_review'].includes(stage) ? 'Reviewing the team’s work' : `Working on ${task.title}`;
      offer(employee.slug, { state: visible, detail: words, assignment, since: task.started_at || task.created_at });
    } else if ((state === 'waiting' || state === 'ready') && ['running', 'planning'].includes(job.status)) {
      const waitingFor = (task.depends_on || []).map((id) => taskById.get(id)).filter((dep) => dep && !['done', 'skipped'].includes(dep.status))
        .map((dep) => officeAgent(agentById.get(dep.agent_id)?.slug)?.label).filter(Boolean);
      offer(employee.slug, waitingFor.length
        ? { state: 'WAITING', detail: `Waiting for ${[...new Set(waitingFor)].join(', ')}`, assignment, since: task.created_at }
        : { state: 'QUEUED', detail: `Next up: ${task.title}`, assignment, since: task.created_at });
    } else if (state === 'failed' || state === 'blocked') {
      if (now - Date.parse(task.completed_at || task.created_at) < 6 * 3600_000) offer(employee.slug, { state: state === 'failed' ? 'FAILED' : 'BLOCKED', detail: state === 'failed' ? `Could not finish ${task.title}` : `Blocked: ${task.title} (an earlier step failed)`, assignment, since: task.completed_at || task.created_at });
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
export function workflowView({ job, tasks = [], agents = [], results = [], handoffs = [], events = [], sessions = [], artifacts = [] }) {
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
      kind: { chief_plan: 'plan', synthesis: 'synthesis', launch_dev: 'development', specialist: 'workstream', research: 'workstream', chief_review: 'synthesis', direct: 'conversation', consult: 'consult' }[brief.stage] || 'task',
      revision: Boolean(brief.revision), state: taskState(task, byId), dependsOn: (task.depends_on || []).filter((id) => byId.has(id)),
      startedAt: task.started_at || null, completedAt: task.completed_at || null,
      ...(task.not_before ? { resumesAt: task.not_before, waitReason: task.wait_info?.reason || null } : {}),
      output: output ? { summary: parsed.summary.slice(0, 600) || output.summary, decisions: parsed.decisions, content: output.content, at: output.created_at } : null,
      codingTask: session ? { id: session.id, status: session.status, phase: session.phase, title: session.title } : null,
    };
  });
  const final = results.find((result) => result.kind === 'final');
  const participants = [...new Map(nodes.filter((node) => node.kind !== 'plan' && node.kind !== 'synthesis').map((node) => [node.agent, { key: node.agent, label: node.agentLabel }])).values()];
  const decisions = nodes.filter((node) => node.output?.decisions).map((node) => ({ from: node.agentLabel, text: node.output.decisions }));
  return {
    job: { id: job.id, title: job.title, objective: job.goal, status: job.status, progress: job.progress || 0, createdAt: job.created_at, completedAt: job.completed_at || null,
      costUsd: job.cost_usd == null || job.cost_usd === '' ? null : Number(job.cost_usd), conversationId: job.conversation_id || null },
    multiAgent: nodes.some((node) => node.kind === 'workstream' || node.kind === 'development') && nodes.some((node) => node.kind === 'synthesis'),
    participants, nodes, decisions,
    handoffs: handoffs.map((handoff) => ({
      from: officeAgent(agentById.get(handoff.from_agent_id)?.slug)?.label || 'Agent', to: officeAgent(agentById.get(handoff.to_agent_id)?.slug)?.label || 'Agent',
      fromTask: handoff.from_task_id, toTask: handoff.to_task_id, at: handoff.created_at,
    })),
    revisions: events.filter((event) => event.payload?.kind === 'revision_requested').flatMap((event) => event.payload.revisions || []),
    consults: events.filter((event) => event.payload?.kind === 'consult_requested').map((event) => ({ from: officeAgent(event.payload.agent)?.label, consults: (event.payload.consults || []).map((entry) => ({ to: officeAgent(entry.employee)?.label, question: entry.question })) })),
    artifacts: artifacts.map(artifactView),
    final: final ? { content: final.content, at: final.created_at } : null,
  };
}

// Capability evidence → one honest state per connector. "Connected" needs a
// real successful use; configuration alone is "Configured — not verified".
export function capabilityView({ toolRuns = [], webRuns = {}, env = {}, databaseOk = true, memoryCount = 0, supabaseCheck = null, telegramCheck = null, telegramDelivered = null, now = Date.now() }) {
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
    { id: 'supabase_tools', label: 'Supabase tools for the Coding Agent', ...supabaseToolsState(last(['supabase']), supabaseCheck, present('CODING_SUPABASE_ACCESS_TOKEN'), state) },
    { id: 'web_search', label: 'Web search', ...state(webRuns.web_search || null, present('GEMINI_API_KEY'), 'web search') },
    { id: 'web_fetch', label: 'Web page reading', ...state(webRuns.web_fetch || null, true, 'page fetch') },
    { id: 'memory', label: 'Project memory', status: databaseOk ? 'Available' : 'Unavailable', verifiedAt: null, detail: `${memoryCount} saved item${memoryCount === 1 ? '' : 's'}` },
    { id: 'telegram', label: 'Telegram → CHIEF', ...telegramState(telegramDelivered, telegramCheck, present('TELEGRAM_BOT_TOKEN'), state) },
    { id: 'tool_broker', label: 'Tool Broker (audited tools)', ...state(toolRuns.filter((run) => run.status === 'succeeded').map((run) => run.last).sort().at(-1) || null, true, 'audited tool call') },
  ];
  return items.map((item) => (item.status === 'Connected' && stale(item.verifiedAt) ? { ...item, status: 'Connected (not used recently)' } : item))
    .map((item) => ({ ...item, employees: connectorUsers(item.id) }));
}

const ARTIFACT_COLUMNS = 'id,project_id,job_id,task_id,conversation_id,agent_slug,type,title,data,created_at';

export function artifactView(row) {
  const employee = officeAgent(row.agent_slug);
  return { id: row.id, type: row.type, title: row.title, data: row.data, jobId: row.job_id, taskId: row.task_id, conversationId: row.conversation_id || null,
    agent: employee?.key || row.agent_slug, agentLabel: employee?.label || row.agent_slug, at: row.created_at };
}

// A project at a glance: what is moving, who is on it, what was produced,
// what needs Fahad, open risks, spend and what the Office knows.
export function commandCenter({ project, live, states, artifacts = [], memory = [], knowledge = [], costs = [], finals = [], outputs = [], handoffs = [], now = Date.now() }) {
  const active = live.jobs.filter((job) => ['planning', 'running'].includes(job.status));
  const audits = artifacts.filter((artifact) => artifact.type === 'audit_report');
  const risks = [
    ...audits.flatMap((artifact) => (artifact.data?.findings || []).filter((finding) => ['high', 'critical'].includes(finding.severity))
      .map((finding) => ({ from: 'AUDIT', severity: finding.severity, text: finding.title, owner: officeAgent(finding.owner)?.label || null }))),
    ...artifacts.filter((artifact) => artifact.type === 'risk_matrix').flatMap((artifact) => (artifact.data?.items || [])
      .filter((item) => item.likelihood * item.impact >= 12)
      .map((item) => ({ from: officeAgent(artifact.agent_slug)?.label || null, severity: item.likelihood * item.impact >= 20 ? 'critical' : 'high', text: item.risk, owner: officeAgent(item.owner)?.label || null }))),
    ...artifacts.filter((artifact) => artifact.type === 'compliance_matrix').flatMap((artifact) => (artifact.data?.items || [])
      .filter((item) => ['RISK FLAG', 'PROFESSIONAL REVIEW REQUIRED'].includes(item.classification))
      .map((item) => ({ from: 'LEGAL', severity: item.classification === 'RISK FLAG' ? 'high' : 'review', text: item.requirement, owner: 'LEGAL' }))),
  ].slice(0, 12);
  const byKind = {};
  for (const item of memory) byKind[item.kind] = (byKind[item.kind] || 0) + 1;
  // Executive layer: status, CHIEF's latest summary, progress, the whole team,
  // next actions and decisions — each from a real row, or absent.
  const section = (text, name) => (String(text || '').replace(/```artifact[\s\S]*?```/g, '').match(new RegExp(`^##\\s*${name}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'mi'))?.[1] || '').trim();
  const bullets = (text) => text.split('\n').map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').replace(/\*\*/g, '').trim()).filter((line) => line && !/^#/.test(line)).slice(0, 8);
  // CHIEF's voice only: finals of objectives CHIEF planned (not direct chats).
  const chiefJobs = new Set(live.tasks.filter((task) => stageOf(task.brief) === 'chief_plan').map((task) => task.job_id));
  const latestFinal = finals.filter((final) => chiefJobs.has(final.job_id)).toSorted((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
  const summaryText = latestFinal ? (section(latestFinal.content, 'Executive summary') || section(latestFinal.content, 'Summary') || parseOutput(latestFinal.content).summary) : '';
  const criticalRisk = risks.some((risk) => risk.severity === 'critical');
  const needs = live.approvals.length + live.sessions.filter((session) => session.status === 'blocked' && session.error_code === 'HUMAN_INPUT_REQUIRED').length;
  const status = needs ? 'NEEDS FAHAD' : criticalRisk ? 'AT RISK' : active.length ? 'IN PROGRESS' : live.jobs.length ? 'UP TO DATE' : 'NO ACTIVITY';
  const latestOutput = new Map();
  for (const output of outputs.toSorted((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) latestOutput.set(output.agent_slug, output);
  const latestArtifact = new Map();
  for (const artifact of artifacts) if (!latestArtifact.has(artifact.agent_slug)) latestArtifact.set(artifact.agent_slug, artifact);
  const jobProgress = new Map(live.jobs.map((job) => [job.id, job.progress || 0]));
  const chiefChecklist = artifacts.filter((artifact) => artifact.agent_slug === 'chief-of-staff' && artifact.type === 'checklist')[0];
  const nextActions = latestFinal && section(latestFinal.content, 'Next actions') ? bullets(section(latestFinal.content, 'Next actions')).map((text) => ({ text, from: 'CHIEF' }))
    : (chiefChecklist?.data?.items || []).filter((item) => item.status === 'todo').slice(0, 8).map((item) => ({ text: item.text, from: 'CHIEF', owner: item.owner || null }));
  const decisionsForFahad = outputs.map((output) => ({ from: officeAgent(output.agent_slug)?.label || 'Agent', text: parseOutput(output.content).decisions, at: output.created_at, jobId: output.job_id }))
    .filter((entry) => entry.text).slice(0, 6);
  return {
    status,
    summary: summaryText ? { text: summaryText.slice(0, 700), at: latestFinal.created_at, jobId: latestFinal.job_id } : null,
    progress: active.length ? Math.round(active.reduce((sum, job) => sum + (job.progress || 0), 0) / active.length) : live.jobs.length ? 100 : 0,
    roster: ACTIVE_AGENTS.filter((entry) => entry.executor !== 'chief').map((entry) => {
      const state = states.get(entry.slug) || { state: 'AVAILABLE', detail: 'Available' };
      const output = latestOutput.get(entry.slug);
      const artifact = latestArtifact.get(entry.slug);
      return { key: entry.key, slug: entry.slug, label: entry.label, state: state.state, detail: state.detail, task: state.state === 'AVAILABLE' ? null : state.assignment?.task || null,
        progress: state.assignment?.jobId ? jobProgress.get(state.assignment.jobId) ?? null : null,
        latest: output ? { summary: parseOutput(output.content).summary.slice(0, 220), at: output.created_at } : null,
        artifact: artifact ? { id: artifact.id, title: artifact.title, type: artifact.type } : null };
    }),
    nextActions, decisionsForFahad,
    handoffs,
    project: { id: project.id, name: project.name, description: project.description || '', repository: project.default_repository || null },
    objectives: { active: active.slice(0, 8).map((job) => ({ id: job.id, title: job.title || job.goal, status: job.status, progress: job.progress || 0 })),
      completed: live.jobs.filter((job) => job.status === 'completed').length, failed: live.jobs.filter((job) => job.status === 'failed').length },
    team: ACTIVE_AGENTS.map((entry) => ({ key: entry.key, label: entry.label, ...(states.get(entry.slug) || { state: 'AVAILABLE' }) }))
      .filter((member) => member.state !== 'AVAILABLE'),
    coding: live.sessions.map((session) => ({ id: session.id, title: session.title, status: session.status, phase: session.phase })),
    needsFahad: live.approvals.length + live.sessions.filter((session) => session.status === 'blocked' && session.error_code === 'HUMAN_INPUT_REQUIRED').length,
    artifacts: artifacts.slice(0, 12).map(artifactView),
    latestAudit: audits[0] ? { verdict: audits[0].data?.verdict || null, title: audits[0].title, at: audits[0].created_at } : null,
    risks,
    costUsd: costs == null ? null : Number(costs.reduce((sum, row) => sum + Number(row.cost_usd || 0), 0).toFixed(6)),
    memory: { total: memory.length, byKind, decisions: memory.filter((item) => /decision/.test(item.kind)).slice(0, 6).map((item) => ({ kind: item.kind, content: item.content })) },
    knowledge: { total: knowledge.length, fresh: knowledge.filter((item) => !item.expires_at || Date.parse(item.expires_at) > now).length,
      recent: knowledge.slice(0, 6).map((item) => ({ agent: officeAgent(item.agent_slug)?.label || item.agent_slug, title: item.title, url: item.source_url, date: item.source_date })) },
  };
}

// The Coding worker's read-only self-check counts as real use: it runs the
// agent's own Supabase client against the allowlisted project.
function supabaseToolsState(toolUse, check, configuredHere, state) {
  if (toolUse) return state(toolUse, true, 'database tool call');
  if (check?.ok) return { status: 'Connected', verifiedAt: check.checked_at, detail: `Verified read-only on ${check.project} (${check.db_role || 'read-only role'}); outside projects and writes refused; token not exposed` };
  if (check && check.token_present) return { status: 'Configured — not verified', verifiedAt: null, detail: `Token present; self-check failed: ${check.error_code || 'unknown'}` };
  if ((check && !check.token_present) || (!check && !configuredHere)) return { status: 'Not configured', verifiedAt: null, detail: 'Not configured: CODING_SUPABASE_ACCESS_TOKEN is missing, so the Coding Agent has no database tools' };
  return state(null, configuredHere, 'database tool call');
}

// Telegram: a result delivered to Fahad's chat is real use; the channel's
// start-up check (getMe + pairing) proves the credentials.
function telegramState(delivered, check, configuredHere, state) {
  if (delivered) return state(delivered, true, 'CHIEF result delivered to Telegram');
  if (check?.ok && check.owner_paired) return { status: 'Configured — not verified', verifiedAt: null, detail: `Bot @${check.bot_username || '?'} verified and paired; waiting for the first message` };
  if (check?.ok) return { status: 'Configured — not verified', verifiedAt: null, detail: `Bot @${check.bot_username || '?'} verified; send it /start, then set TELEGRAM_OWNER_CHAT_ID` };
  if (check) return { status: 'Unavailable', verifiedAt: null, detail: `Telegram start-up check failed: ${check.error_code || 'unknown'}` };
  if (!configuredHere) return { status: 'Not configured', verifiedAt: null, detail: 'Not configured: needs a BotFather token (TELEGRAM_BOT_TOKEN) and your chat id (TELEGRAM_OWNER_CHAT_ID)' };
  return state(null, true, 'Telegram message');
}

// Which connectors an employee works with (ids match /api/capabilities).
export function EMPLOYEE_CONNECTORS(employee) {
  const ids = ['database', 'memory'];
  if (employee.webTools) ids.push('web_search', 'web_fetch');
  if (employee.executor === 'coding') ids.push('github', 'repository', 'pull_requests', 'ci', 'deployment', 'supabase_tools', 'tool_broker');
  if (employee.executor === 'chief') ids.push('telegram');
  return ids;
}

// Which employees use a connector (the per-employee connector registry).
export function connectorUsers(id) {
  const web = ACTIVE_AGENTS.filter((agent) => agent.webTools).map((agent) => agent.label);
  const coding = ACTIVE_AGENTS.filter((agent) => agent.executor === 'coding').map((agent) => agent.label);
  const everyone = ACTIVE_AGENTS.map((agent) => agent.label);
  return ({ web_search: web, web_fetch: web, database: everyone, memory: everyone, telegram: ['CHIEF'] })[id] || coding;
}

// ------------------------------------------------------------------ handler

// Tables added by a later migration: a missing table reads as empty so the
// Hub keeps working while a deployment and its migration roll out.
async function optionalRows(query) {
  const { data, error } = await query;
  if (error) return [];
  return data || [];
}

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
    rows(db.from('agent_sessions').select('id,job_id,title,status,phase,error_code,blocker,result,conversation_id,created_at,updated_at,completed_at').eq('workspace_id', workspaceId).order('updated_at', { ascending: false }).limit(20)),
    rows(db.from('agent_approvals').select('id,session_id,tool_name,action,risk,summary,arguments_preview,status,requested_at').eq('workspace_id', workspaceId).eq('status', 'pending')),
  ]);
  const jobIds = jobs.map((job) => job.id);
  const tasks = jobIds.length ? await rows(db.from('tasks').select('id,job_id,agent_id,title,status,brief,depends_on,sequence,started_at,completed_at,created_at,not_before,wait_count,wait_info').in('job_id', jobIds)) : [];
  return { agents, jobs, tasks, sessions: sessions.filter((session) => !TERMINAL_SESSION.has(session.status) || (session.completed_at && Date.now() - Date.parse(session.completed_at) < RECENT_MS)), approvals };
}

// Handoffs and artifacts of the same window, for the timeline and handoffs.
async function liveExtras(db, workspaceId, live, sinceMs) {
  const since = new Date(Date.now() - sinceMs).toISOString();
  const jobIds = live.jobs.map((job) => job.id);
  const [handoffs, artifacts] = await Promise.all([
    jobIds.length ? rows(db.from('handoffs').select('id,from_agent_id,to_agent_id,from_task_id,to_task_id,job_id,created_at').in('job_id', jobIds).order('created_at', { ascending: false }).limit(80)) : [],
    optionalRows(db.from('artifacts').select('id,job_id,task_id,agent_slug,type,title,created_at').eq('project_id', workspaceId).gte('created_at', since).order('created_at', { ascending: false }).limit(80)),
  ]);
  return { handoffs, artifacts };
}

const streams = new WeakMap();

export async function handleOfficeApi({ db, request, response, url, sendJson, env = process.env }) {
  const path = url.pathname;
  if (!/^\/api\/(office|agents|workflows|capabilities|artifacts|command-center|timeline|stream)(\/|$)/.test(path)) return false;
  try {
    const method = request.method;
    if (method !== 'GET') return sendJson(response, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }), true;

    if (path === '/api/stream') {
      const workspaceId = uuid(url.searchParams.get('workspaceId'), 'workspaceId');
      if (!streams.has(db)) streams.set(db, new OfficeStream({ db }));
      streams.get(db).subscribe(workspaceId, response);
      return true;
    }

    if (path === '/api/timeline') {
      const workspaceId = uuid(url.searchParams.get('workspaceId'), 'workspaceId');
      const live = await workspaceActivity(db, workspaceId, 7 * 86400_000);
      const extra = await liveExtras(db, workspaceId, live, 7 * 86400_000);
      const agent = url.searchParams.get('agent');
      const status = url.searchParams.get('status');
      const job = url.searchParams.get('job');
      const filters = {
        ...(agent ? { agent: agent === 'fahad' ? 'fahad' : officeAgent(agent)?.key || '__none__' } : {}),
        ...(status && ['info', 'working', 'done', 'waiting', 'attention', 'failed'].includes(status) ? { status } : {}),
        ...(job ? { job: uuid(job, 'job') } : {}),
      };
      return sendJson(response, 200, { ok: true, entries: timelineView({ ...live, ...extra, filters, limit: 120 }) }), true;
    }

    if (path === '/api/office') {
      const workspaceId = uuid(url.searchParams.get('workspaceId'), 'workspaceId');
      const live = await workspaceActivity(db, workspaceId, 7 * 86400_000);
      const states = officeState(live);
      const extra = await liveExtras(db, workspaceId, live, 7 * 86400_000);
      const colors = new Map(live.agents.map((agent) => [agent.slug, agent.accent_color]));
      const agentById = new Map(live.agents.map((agent) => [agent.id, agent]));
      const jobById = new Map(live.jobs.map((job) => [job.id, job]));
      const taskById = new Map(live.tasks.map((task) => [task.id, task]));
      const artifactsByTask = new Map();
      for (const artifact of extra.artifacts.toSorted((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) artifactsByTask.set(artifact.task_id, [...(artifactsByTask.get(artifact.task_id) || []), artifact]);
      const latestArtifact = new Map();
      for (const artifact of extra.artifacts) if (!latestArtifact.has(artifact.agent_slug) || latestArtifact.get(artifact.agent_slug).created_at < artifact.created_at) latestArtifact.set(artifact.agent_slug, artifact);
      const workflowJobs = new Set(live.tasks.filter((task) => stageOf(task.brief) === 'synthesis').map((task) => task.job_id));
      const since = Date.now() - 24 * 3600_000;
      return sendJson(response, 200, {
        ok: true,
        agents: ACTIVE_AGENTS.map((entry) => {
          const state = states.get(entry.slug);
          const artifact = latestArtifact.get(entry.slug);
          const job = state?.assignment?.jobId ? jobById.get(state.assignment.jobId) : null;
          return { slug: entry.slug, key: entry.key, label: entry.label, scope: entry.scope, deliverable: entry.deliverable,
            executor: entry.executor, directChat: entry.directChat, color: colors.get(entry.slug) || null, ...state,
            progress: job ? job.progress || 0 : null,
            recentArtifact: artifact ? { id: artifact.id, type: artifact.type, title: artifact.title, at: artifact.created_at } : null };
        }),
        // team: the employees with a task in the objective (Office Project Mode).
        workflows: live.jobs.filter((job) => workflowJobs.has(job.id)).slice(0, 8).map((job) => ({ id: job.id, title: job.title, status: job.status, progress: job.progress || 0, createdAt: job.created_at,
          team: [...new Set(live.tasks.filter((task) => task.job_id === job.id).map((task) => officeAgent(agentById.get(task.agent_id)?.slug)?.key).filter(Boolean))] })),
        // The Coding Agent's latest session, for the Office's engineering panel.
        coding: (() => {
          const session = live.sessions[0];
          if (!session) return null;
          const result = session.result && typeof session.result === 'object' ? session.result : {};
          return { id: session.id, title: session.title, status: session.status, phase: session.phase, updatedAt: session.updated_at,
            pr: result.pr?.number ? { number: result.pr.number, url: result.pr.url || null } : null, ci: result.ci?.state || null, deploy: result.deploy?.state || result.deploy?.status || null };
        })(),
        handoffs: extra.handoffs.filter((handoff) => Date.parse(handoff.created_at) >= since)
          .map((handoff) => handoffView(handoff, { agentById, jobById, taskById, artifactsByTask })).filter((handoff) => handoff.fromKey && handoff.toKey && handoff.fromKey !== handoff.toKey),
        timeline: timelineView({ ...live, ...extra, limit: 30 }),
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
      const handoffs = live.jobs.length ? await rows(db.from('handoffs').select('id,from_agent_id,to_agent_id,from_task_id,to_task_id,job_id,created_at').in('job_id', live.jobs.map((job) => job.id)).order('created_at', { ascending: false }).limit(80)) : [];
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
        codingSessions: employee.executor === 'coding' ? live.sessions.map((session) => ({ id: session.id, title: session.title, status: session.status, phase: session.phase,
          prUrl: session.result?.pr?.url || null, ci: session.result?.ci?.state || null, updatedAt: session.updated_at })) : [],
        progress: state?.assignment?.jobId ? (live.jobs.find((job) => job.id === state.assignment.jobId)?.progress || 0) : null,
        handoffs: handoffs.filter((handoff) => [handoff.from_agent_id, handoff.to_agent_id].includes(record?.id))
          .map((handoff) => handoffView(handoff, { agentById: new Map(live.agents.map((agent) => [agent.id, agent])), jobById, taskById: new Map(live.tasks.map((task) => [task.id, task])), artifactsByTask: new Map() }))
          .filter((handoff) => handoff.fromKey !== handoff.toKey).slice(0, 12),
        attention: [
          ...(state?.state === 'NEEDS FAHAD' ? [{ kind: 'action', text: state.detail, sessionId: state.assignment?.sessionId || null, jobId: state.assignment?.jobId || null }] : []),
          ...own.filter((task) => task.status === 'failed').slice(0, 3).map((task) => ({ kind: 'failed', text: `Could not finish ${task.title}`, jobId: task.job_id })),
        ],
        integrations: EMPLOYEE_CONNECTORS(employee),
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
      const [tasks, agents, results, handoffs, events, artifacts] = await Promise.all([
        rows(db.from('tasks').select('id,job_id,agent_id,title,status,brief,depends_on,sequence,started_at,completed_at,created_at,not_before,wait_info').eq('job_id', jobId)),
        rows(db.from('agents').select('id,slug,name')),
        rows(db.from('results').select('task_id,kind,summary,content,created_at').eq('job_id', jobId).order('created_at', { ascending: true })),
        rows(db.from('handoffs').select('from_agent_id,to_agent_id,from_task_id,to_task_id,created_at').eq('job_id', jobId).order('created_at', { ascending: true })),
        rows(db.from('events').select('task_id,type,payload,created_at').eq('job_id', jobId).eq('type', 'activity').order('created_at', { ascending: true }).limit(300)),
        optionalRows(db.from('artifacts').select(ARTIFACT_COLUMNS).eq('job_id', jobId).order('created_at', { ascending: true }).limit(60)),
      ]);
      const sessionIds = events.filter((event) => event.payload?.kind === 'task_launched').map((event) => event.payload.session_id).filter(Boolean);
      const sessions = sessionIds.length ? await rows(db.from('agent_sessions').select('id,title,status,phase').in('id', sessionIds)) : [];
      return sendJson(response, 200, { ok: true, ...workflowView({ job, tasks, agents, results, handoffs, events, sessions, artifacts }) }), true;
    }

    if (path === '/api/artifacts') {
      const workspaceId = uuid(url.searchParams.get('workspaceId'), 'workspaceId');
      let query = db.from('artifacts').select(ARTIFACT_COLUMNS).eq('project_id', workspaceId);
      const type = url.searchParams.get('type');
      if (type) {
        if (!ARTIFACT_TYPES[type]) throw Object.assign(new Error('Unknown artifact type'), { statusCode: 400 });
        query = query.eq('type', type);
      }
      const agent = url.searchParams.get('agent');
      if (agent) {
        const employee = officeAgent(agent);
        if (!employee) throw Object.assign(new Error('Unknown employee'), { statusCode: 400 });
        query = query.eq('agent_slug', employee.slug);
      }
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 60));
      const artifacts = await optionalRows(query.order('created_at', { ascending: false }).limit(limit));
      const jobIds = [...new Set(artifacts.map((artifact) => artifact.job_id).filter(Boolean))];
      const jobs = jobIds.length ? await optionalRows(db.from('jobs').select('id,title,goal').in('id', jobIds)) : [];
      const objective = new Map(jobs.map((job) => [job.id, job.title || String(job.goal || '').slice(0, 120)]));
      return sendJson(response, 200, { ok: true, types: Object.keys(ARTIFACT_TYPES), artifacts: artifacts.map((artifact) => ({ ...artifactView(artifact), objective: objective.get(artifact.job_id) || null })) }), true;
    }

    if (path === '/api/command-center') {
      const workspaceId = uuid(url.searchParams.get('workspaceId'), 'workspaceId');
      const live = await workspaceActivity(db, workspaceId, 30 * 86400_000);
      const jobIds = live.jobs.map((job) => job.id);
      const [project, artifacts, memory, knowledge, costs] = await Promise.all([
        rows(db.from('projects').select('id,name,description,default_repository,created_at').eq('id', workspaceId)).then((list) => list[0] || null),
        optionalRows(db.from('artifacts').select(ARTIFACT_COLUMNS).eq('project_id', workspaceId).order('created_at', { ascending: false }).limit(40)),
        optionalRows(db.from('project_memory').select('kind,content,created_at').eq('project_id', workspaceId).order('created_at', { ascending: false }).limit(60)),
        optionalRows(db.from('knowledge_items').select('agent_slug,title,source_url,source_date,expires_at').eq('project_id', workspaceId).order('created_at', { ascending: false }).limit(40)),
        jobIds.length ? db.from('jobs').select('cost_usd').in('id', jobIds).then(({ data, error }) => (error ? null : data || [])) : [],
      ]);
      if (!project) return sendJson(response, 404, { ok: false, error: 'PROJECT_NOT_FOUND' }), true;
      const agentSlugById = new Map(live.agents.map((agent) => [agent.id, agent.slug]));
      const taskAgent = new Map(live.tasks.map((task) => [task.id, agentSlugById.get(task.agent_id)]));
      const [results, extra] = await Promise.all([
        jobIds.length ? rows(db.from('results').select('job_id,task_id,kind,content,created_at').in('job_id', jobIds).order('created_at', { ascending: false }).limit(120)) : [],
        liveExtras(db, workspaceId, live, 30 * 86400_000),
      ]);
      const finals = results.filter((result) => result.kind === 'final');
      const outputs = results.filter((result) => result.kind !== 'final' && result.task_id).map((result) => ({ ...result, agent_slug: taskAgent.get(result.task_id) })).filter((result) => result.agent_slug && result.agent_slug !== 'chief-of-staff');
      const agentById = new Map(live.agents.map((agent) => [agent.id, agent]));
      const jobById = new Map(live.jobs.map((job) => [job.id, job]));
      const taskById = new Map(live.tasks.map((task) => [task.id, task]));
      const handoffs = extra.handoffs.slice(0, 12).map((handoff) => handoffView(handoff, { agentById, jobById, taskById, artifactsByTask: new Map() })).filter((handoff) => handoff.fromKey !== handoff.toKey);
      const center = commandCenter({ project, live, states: officeState(live), artifacts, memory, knowledge, costs, finals, outputs, handoffs });
      return sendJson(response, 200, { ok: true, ...center, timeline: timelineView({ ...live, ...extra, limit: 14 }),
        activeJobId: live.jobs.find((job) => ['planning', 'running'].includes(job.status))?.id || live.jobs[0]?.id || null }), true;
    }

    if (path === '/api/capabilities') {
      const since = new Date(Date.now() - 90 * 86400_000).toISOString();
      let databaseOk = true;
      const [toolRuns, routeEvents, memory, supabaseChecks, telegramChecks, telegramDeliveries] = await Promise.all([
        rows(db.from('tool_executions').select('tool_name,status,started_at').gte('started_at', since).order('started_at', { ascending: false }).limit(1000)).catch(() => { databaseOk = false; return []; }),
        rows(db.from('events').select('payload,created_at').eq('payload->>kind', 'model_route').gte('created_at', since).order('created_at', { ascending: false }).limit(500)).catch(() => []),
        rows(db.from('project_memory').select('id')).catch(() => []),
        rows(db.from('events').select('payload,created_at').eq('payload->>kind', 'supabase_tools_check').order('created_at', { ascending: false }).limit(1)).catch(() => []),
        rows(db.from('events').select('payload,created_at').eq('payload->>kind', 'telegram_channel').order('created_at', { ascending: false }).limit(1)).catch(() => []),
        rows(db.from('events').select('created_at').eq('payload->>kind', 'channel_delivered').eq('payload->>channel', 'telegram').order('created_at', { ascending: false }).limit(1)).catch(() => []),
      ]);
      const latest = new Map();
      for (const run of toolRuns) {
        const key = `${run.tool_name}|${run.status}`;
        if (!latest.has(key) || latest.get(key).last < run.started_at) latest.set(key, { tool_name: run.tool_name, status: run.status, last: run.started_at });
      }
      const webRuns = {};
      for (const event of routeEvents) for (const tool of event.payload?.tools_used || []) if (!webRuns[tool] || webRuns[tool] < event.created_at) webRuns[tool] = event.created_at;
      return sendJson(response, 200, { ok: true, capabilities: capabilityView({ toolRuns: [...latest.values()], webRuns, env, databaseOk, memoryCount: memory.length, supabaseCheck: supabaseChecks[0]?.payload || null, telegramCheck: telegramChecks[0]?.payload || null, telegramDelivered: telegramDeliveries[0]?.created_at || null }) }), true;
    }
    return sendJson(response, 404, { ok: false, error: 'NOT_FOUND' }), true;
  } catch (error) {
    return sendJson(response, error.statusCode || 500, { ok: false, error: String(error.message || 'Request failed').slice(0, 300) }), true;
  }
}

export { approvalCard };
