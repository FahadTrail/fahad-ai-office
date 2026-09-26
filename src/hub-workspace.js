// Workspace V2 API: conversations (multi-turn chat), tasks (Coding Agent
// sessions in human language), "needs attention", owner replies and project
// context. Everything here is a thin, validated layer over the existing
// durable state (jobs, agent_sessions, agent_approvals, …); the engines
// themselves (Chief workflow, Coding Agent controller) are unchanged.

import { SESSION_FIELDS, modelPoolSnapshot, publicSession, publicEvent } from './hub-coding.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

// ------------------------------------------------------------------ task view

export const TASK_STAGES = Object.freeze([
  { key: 'understand', label: 'Understanding' },
  { key: 'plan', label: 'Planning' },
  { key: 'implement', label: 'Editing' },
  { key: 'test', label: 'Testing' },
  { key: 'debug', label: 'Debugging' },
  { key: 'publish', label: 'Pull request' },
  { key: 'ci', label: 'CI checks' },
  { key: 'approval', label: 'Approval' },
  { key: 'deploy', label: 'Deploy' },
  { key: 'verify', label: 'Verify' },
  { key: 'done', label: 'Complete' },
]);

const PHASE_STAGE = { understand: 'understand', plan: 'plan', implement: 'implement', test: 'test', debug: 'debug', review: 'test', publish: 'publish', ci: 'ci', deploy: 'deploy', verify: 'verify', report: 'done', done: 'done' };
const STAGE_INDEX = Object.fromEntries(TASK_STAGES.map((stage, index) => [stage.key, index]));

// Stage states: pending | active | passed | failed | needs_input | skipped.
export function taskTimeline(session, { events = [], approvals = [] } = {}) {
  const phaseKey = PHASE_STAGE[session.phase] || 'understand';
  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending');
  const mergeApproval = pendingApprovals.some((approval) => approval.tool_name === 'github.pr_merge');
  let current = STAGE_INDEX[phaseKey];
  if (mergeApproval) current = STAGE_INDEX.approval;
  const visited = new Set(events.filter((event) => event.type === 'phase').map((event) => PHASE_STAGE[event.payload?.phase]).filter(Boolean));
  visited.add(phaseKey);
  const deployConfigured = (session.config?.deploy?.mode || 'none') !== 'none';
  const hadApproval = approvals.some((approval) => approval.tool_name === 'github.pr_merge');
  const needsOwner = session.status === 'awaiting_approval' || session.status === 'blocked';
  return TASK_STAGES.map((stage, index) => {
    let state;
    if (!deployConfigured && ['approval', 'deploy', 'verify'].includes(stage.key) && !hadApproval) state = 'skipped';
    else if (stage.key === 'debug' && !visited.has('debug') && index !== current) state = 'skipped';
    else if (session.status === 'completed') state = 'passed';
    else if (index < current) state = 'passed';
    else if (index > current) state = 'pending';
    else if (session.status === 'failed') state = 'failed';
    else if (session.status === 'cancelled') state = 'skipped';
    else if (needsOwner) state = 'needs_input';
    else state = 'active';
    return { key: stage.key, label: stage.label, state };
  });
}

const TOOL_WORDS = {
  'repo.list': () => 'Looking through the repository',
  'repo.read': (payload) => `Reading ${payload.path || payload.args?.path || 'a file'}`,
  'repo.search': () => 'Searching the code',
  'repo.write': (payload) => `Writing ${payload.path || payload.args?.path || 'a file'}`,
  'repo.edit': (payload) => `Editing ${payload.path || payload.args?.path || 'a file'}`,
  'shell.run': (payload) => (/\b(test|jest|vitest|mocha|pytest|node --test)\b/.test(String(payload.command || payload.args?.command || '')) ? 'Running the tests' : 'Running a command'),
  'git.status': () => 'Checking the working tree',
  'git.diff': () => 'Reviewing the changes',
  'git.commit': () => 'Saving the changes (commit)',
  'git.push': () => 'Pushing the branch to GitHub',
  'github.pr_create': () => 'Opening the pull request',
  'github.pr_status': () => 'Checking the pull request',
  'github.ci_status': () => 'Waiting for CI checks',
  'github.ci_logs': () => 'Reading the CI failure logs',
  'github.pr_merge': () => 'Merging the pull request',
  'deploy.status': () => 'Watching the deployment',
  'verify.http': () => 'Verifying production',
  'supabase.query_read': () => 'Reading the database',
  'supabase.query_write': () => 'Changing database data',
  'supabase.migration_apply': () => 'Applying a database migration',
};

// One plain-English line: what the task is doing right now.
export function taskNow(session, events = []) {
  if (session.status === 'queued') return 'Waiting for a worker to pick this up.';
  if (session.status === 'completed') return 'Finished.';
  if (session.status === 'cancelled') return 'Cancelled.';
  if (session.status === 'failed') return 'Stopped because of an error.';
  if (session.status === 'awaiting_approval') return 'Waiting for your approval.';
  if (session.status === 'blocked') return session.error_code === 'HUMAN_INPUT_REQUIRED' ? 'Waiting for your answer.' : 'Paused — it needs you to continue.';
  const latest = events.find((event) => ['tool_call', 'tool_result', 'model_turn', 'phase', 'test', 'ci', 'deploy', 'verify', 'github', 'git'].includes(event.type));
  if (latest?.type === 'tool_call' || latest?.type === 'tool_result') {
    const words = TOOL_WORDS[latest.payload?.tool];
    if (words) return `${words(latest.payload || {})}.`;
  }
  if (latest?.type === 'model_turn') return 'Thinking about the next step.';
  if (latest?.type === 'ci') return 'Waiting for CI checks.';
  if (latest?.type === 'deploy') return 'Watching the deployment.';
  if (latest?.type === 'verify') return 'Verifying production.';
  if (session.next_action) return `Next: ${String(session.next_action).slice(0, 200)}`;
  return PHASE_NOW[session.phase] || 'Working.';
}

const PHASE_NOW = {
  understand: 'Reading the code to understand the task.', plan: 'Planning the change.', implement: 'Making the change.', test: 'Testing the change.',
  debug: 'Fixing a failing check.', review: 'Reviewing the change.', publish: 'Opening the pull request.', ci: 'Waiting for CI checks.',
  deploy: 'Deploying.', verify: 'Verifying production.', report: 'Writing the summary.',
};

// "Agent needs the owner: <reason> — <question>" → structured question.
export function parseOwnerQuestion(blocker) {
  const text = String(blocker || '').replace(/^Agent needs the owner:\s*/i, '');
  const [reason, ...rest] = text.split(' — ');
  const question = rest.join(' — ').trim();
  return { reason: reason.trim(), question: question || reason.trim() };
}

const BLOCK_EXPLANATIONS = {
  BUDGET_EXHAUSTED: 'The task used its whole budget. Raise the budget or cancel.',
  ITERATION_LIMIT: 'The task reached its step limit without finishing. Resume to let it continue.',
  WALL_CLOCK_LIMIT: 'The task ran for its maximum time. Resume to let it continue.',
  NO_ELIGIBLE_PROVIDER: 'No suitable model is available right now (limits or cooldowns). Resume later.',
  ALL_PROVIDERS_UNAVAILABLE: 'Every suitable model is temporarily unavailable. Resume later.',
  CI_LIMIT: 'CI kept failing after several repair attempts. Review the pull request or resume.',
  CI_TIMEOUT: 'CI did not finish in time. Resume to keep watching.',
  GATE_LIMIT: 'The final checks kept failing. Review the details or resume.',
  NO_PROGRESS: 'The model stopped making progress. Resume to retry with a fresh turn.',
  APPROVAL_REJECTED: 'You rejected the requested action. Resume to let it choose another approach, or cancel.',
};

// The single thing (if any) the owner must act on for this task.
export function ownerAction(session, approvals = []) {
  const pending = approvals.filter((approval) => approval.status === 'pending');
  if (pending.length) {
    return {
      kind: 'approval',
      title: 'Fahad, I need your approval.',
      items: pending.map((approval) => approvalCard(approval)),
    };
  }
  if (session.status === 'blocked' && session.error_code === 'HUMAN_INPUT_REQUIRED') {
    const { reason, question } = parseOwnerQuestion(session.blocker);
    return { kind: 'question', title: 'I need one answer before I can continue.', question, reason };
  }
  if (session.status === 'blocked') {
    return { kind: 'blocked', title: 'This task is paused.', explanation: BLOCK_EXPLANATIONS[session.error_code] || String(session.blocker || 'It stopped and needs you to continue.').slice(0, 600), code: session.error_code || null };
  }
  return null;
}

export function approvalCard(approval) {
  const preview = approval.arguments_preview || {};
  if (approval.tool_name === 'repo.protected_change') {
    return {
      id: approval.id, kind: 'protected_change', risk: approval.risk,
      what: `Change protected file${(preview.paths || []).length === 1 ? '' : 's'}`,
      why: String(preview.reason || approval.summary || '').slice(0, 1200),
      resources: Array.isArray(preview.paths) ? preview.paths.slice(0, 20) : [],
      requestedAt: approval.requested_at,
    };
  }
  const labels = {
    'github.pr_merge': 'Merge the pull request (this deploys to production)',
    'supabase.query_write': 'Change data in the database',
    'supabase.migration_apply': 'Apply a database migration',
  };
  return {
    id: approval.id, kind: 'tool', risk: approval.risk,
    what: labels[approval.tool_name] || approval.summary,
    why: approval.summary,
    resources: [preview.project_ref, preview.name, preview.number ? `PR #${preview.number}` : null].filter(Boolean),
    requestedAt: approval.requested_at,
  };
}

export function taskView(session, { events = [], approvals = [], attempts = [] } = {}) {
  const base = publicSession(session);
  const models = [...new Set(attempts.map((attempt) => `${attempt.provider}:${attempt.model}`))];
  const cached = attempts.reduce((sum, attempt) => sum + Number(attempt.cached_input_tokens || 0), 0);
  const input = attempts.reduce((sum, attempt) => sum + Number(attempt.input_tokens || 0), 0);
  const output = attempts.reduce((sum, attempt) => sum + Number(attempt.output_tokens || 0), 0);
  const started = Date.parse(session.started_at || session.created_at);
  const ended = session.completed_at ? Date.parse(session.completed_at) : Date.now();
  return {
    ...base,
    conversationId: session.conversation_id || null,
    timeline: taskTimeline(session, { events, approvals }),
    now: taskNow(session, events),
    needs: ownerAction(session, approvals),
    currentModel: session.current_route || null,
    elapsedMs: Number.isFinite(started) ? Math.max(0, ended - started) : null,
    metrics: {
      modelCalls: attempts.length,
      iterations: session.iteration || 0,
      inputTokens: input,
      cachedInputTokens: cached,
      outputTokens: output,
      costUsd: Number(session.spent_usd || 0),
      modelSwitches: session.provider_switches || 0,
      modelsUsed: models,
      compactions: events.filter((event) => event.type === 'checkpoint' && /compact/i.test(event.message)).length,
      // Context saved by the controller's budget (context-budget.js), in characters.
      contextTrimmedChars: Number(session.state?.efficiency?.elidedChars || 0),
      unchangedRereads: Number(session.state?.efficiency?.dedupedReads || 0),
    },
  };
}

// ------------------------------------------------------------------ attention

export function attentionFrom({ sessions = [], approvals = [], failedJobs = [] }) {
  const items = [];
  const bySession = new Map();
  for (const approval of approvals) {
    if (!bySession.has(approval.session_id)) bySession.set(approval.session_id, []);
    bySession.get(approval.session_id).push(approval);
  }
  for (const session of sessions) {
    const need = ownerAction(session, bySession.get(session.id) || []);
    if (need) items.push({ kind: need.kind, severity: need.kind === 'approval' ? 'action' : need.kind === 'question' ? 'action' : 'warning', taskId: session.id, title: session.title, detail: need.kind === 'question' ? need.question : need.kind === 'approval' ? need.items.map((item) => item.what).join('; ') : need.explanation, at: session.updated_at });
    else if (session.status === 'failed') items.push({ kind: 'failed', severity: 'error', taskId: session.id, title: session.title, detail: String(session.blocker || session.error_code || 'The task failed.').slice(0, 300), at: session.updated_at });
    else if (session.status === 'completed') items.push({ kind: 'completed', severity: 'info', taskId: session.id, title: session.title, detail: session.result?.summary ? String(session.result.summary).slice(0, 300) : 'Completed.', at: session.completed_at || session.updated_at });
  }
  for (const job of failedJobs) {
    items.push({ kind: 'failed', severity: 'error', conversationId: job.conversation_id, jobId: job.id, title: job.title || 'Chat request', detail: 'The Office could not finish this request.', at: job.completed_at || job.created_at });
  }
  const rank = { action: 0, error: 1, warning: 2, info: 3 };
  return items.toSorted((left, right) => rank[left.severity] - rank[right.severity] || String(right.at).localeCompare(String(left.at)));
}

// ------------------------------------------------------------------ models

// The Model Pool in four owner-facing states. The detailed status stays in
// `detail`; nothing here claims quota a provider does not report.
export function simpleModelStatus(route) {
  const status = String(route.status || '');
  if (status.startsWith('BLOCKED')) return { status: 'ACCOUNT ACTION REQUIRED', reason: route.accountBlocker?.text || route.accountBlocker?.label || status.replace(/^BLOCKED — /, '') };
  if (status === 'RATE LIMITED' || status === 'COOLDOWN') return { status: 'COOLDOWN', reason: route.cooldownUntil ? `Rests until ${route.cooldownUntil}` : 'Resting after a provider limit' };
  if (status === 'LIVE' || status.startsWith('CONFIGURED')) return { status: 'AVAILABLE', reason: status === 'LIVE' ? 'Verified with a real call' : 'Configured; not yet verified by a live call' };
  if (status === 'NOT CONFIGURED') return { status: 'UNAVAILABLE', reason: 'No credential configured' };
  if (status === 'RETIRED') return { status: 'UNAVAILABLE', reason: 'Retired by the provider' };
  return { status: 'UNAVAILABLE', reason: (route.excludedBecause || []).join('; ') || status || 'Not ready' };
}

export function modelsView(snapshot) {
  const routes = (snapshot?.routes || []).filter((route) => !route.retired);
  const models = routes.map((route) => {
    const simple = simpleModelStatus(route);
    return {
      id: route.id, provider: route.provider, model: route.model, status: simple.status, reason: simple.reason, detail: route.status,
      billing: route.billingClass === 'PAID' ? 'Paid' : route.billingClass === 'PROMO' ? 'Trial credits' : 'Free',
      health: route.health, cooldownUntil: route.cooldownUntil || null, order: route.routingRank || null,
      roles: route.suitableJobs || [], coding: route.codingSuitability || null, privateCode: route.privateCode || null,
    };
  });
  const rank = { AVAILABLE: 0, COOLDOWN: 1, 'ACCOUNT ACTION REQUIRED': 2, UNAVAILABLE: 3 };
  models.sort((left, right) => rank[left.status] - rank[right.status] || (left.order || 999) - (right.order || 999) || left.id.localeCompare(right.id));
  const counts = {};
  for (const model of models) counts[model.status] = (counts[model.status] || 0) + 1;
  return { mode: 'AUTO', counts, models };
}

// ------------------------------------------------------------------ helpers

export function autoTitle(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').replace(/^\s*\[(confidential|private|سري)\]\s*/i, '').trim();
  const sentence = clean.split(/(?<=[.!?؟])\s/)[0] || clean;
  const short = sentence.length > 60 ? `${sentence.slice(0, 57).replace(/\s+\S*$/, '')}…` : sentence;
  return short || 'New chat';
}

function uuid(value, name) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw input(`${name} must be a UUID`);
  return value;
}

function input(message) {
  return Object.assign(new Error(message), { statusCode: 400, code: 'INVALID_INPUT' });
}

function text(value, name, { min = 1, max = 8000 } = {}) {
  const clean = typeof value === 'string' ? value.trim() : '';
  if (clean.length < min || clean.length > max || /\0/.test(clean)) throw input(`${name} must contain ${min} to ${max} characters`);
  return clean;
}

async function rows(query) {
  const { data, error } = await query;
  if (error) throw Object.assign(new Error(`Could not load workspace data: ${error.message}`), { statusCode: 500 });
  return data || [];
}

async function one(query) {
  const { data, error } = await query;
  if (error) throw Object.assign(new Error(`Could not load workspace data: ${error.message}`), { statusCode: 500 });
  return data;
}

// Human words for what the Office is doing on an unfinished chat request.
export function chatStage(job, steps = []) {
  if (job.status === 'planning' || !steps.length) return 'Thinking';
  const active = steps.find((step) => ['running', 'assigned'].includes(step.status)) || steps.find((step) => step.status === 'queued');
  if (!active) return 'Finishing';
  const title = String(active.title || '').toLowerCase();
  if (/review|final/.test(title)) return 'Reviewing the answer';
  if (/research|search|web/.test(title)) return 'Researching';
  if (/plan/.test(title)) return 'Planning';
  return 'Working on it';
}

function messageFromJob(job, { results = [], sessions = [], attempts = [], steps = [] } = {}) {
  const final = results.filter((result) => result.kind === 'final' || result.kind === 'task').at(-1);
  const routes = attempts.filter((attempt) => attempt.status === 'succeeded');
  const lastRoute = routes.at(-1);
  return {
    jobId: job.id,
    user: { text: job.goal, at: job.created_at },
    assistant: {
      status: job.status,
      text: job.status === 'completed' ? (job.final_summary && !final?.content ? job.final_summary : final?.content || job.final_summary || '') : '',
      at: job.completed_at || null,
      model: lastRoute ? { provider: lastRoute.provider, model: lastRoute.model } : null,
      costUsd: Number(job.cost_usd || 0),
      tokens: Number(job.tokens_used || 0),
      progress: job.progress || 0,
      stage: ['completed', 'failed', 'cancelled'].includes(job.status) ? null : chatStage(job, steps),
      tasks: sessions.map((session) => ({ id: session.id, title: session.title, status: session.status, phase: session.phase })),
    },
  };
}

// ------------------------------------------------------------------ handler

export async function handleWorkspaceApi({ db, request, response, url, sendJson, readJson, actor, store }) {
  const path = url.pathname;
  if (!/^\/api\/(conversations|tasks|attention|projects|models)(\/|$)/.test(path)) return false;
  try {
    const method = request.method;

    // ---- conversations
    if (method === 'GET' && path === '/api/conversations') {
      const workspaceId = uuid(url.searchParams.get('workspaceId'), 'workspaceId');
      const archived = url.searchParams.get('archived') === 'true';
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 200);
      let query = db.from('conversations').select('id,title,archived,created_at,updated_at,last_message_at')
        .eq('project_id', workspaceId).eq('archived', archived).order('last_message_at', { ascending: false }).limit(200);
      let list = await rows(query);
      if (q) {
        const needle = q.toLowerCase();
        const matchingJobs = await rows(db.from('jobs').select('conversation_id').eq('project_id', workspaceId)
          .ilike('goal', `%${q.replace(/[%_]/g, '')}%`).limit(200));
        const ids = new Set(matchingJobs.map((row) => row.conversation_id).filter(Boolean));
        list = list.filter((conversation) => conversation.title.toLowerCase().includes(needle) || ids.has(conversation.id));
      }
      return sendJson(response, 200, { ok: true, conversations: list.map(publicConversation) }), true;
    }
    if (method === 'POST' && path === '/api/conversations') {
      const body = await readJson(request);
      const workspaceId = uuid(body.workspaceId, 'workspaceId');
      const message = text(body.message, 'Message', { min: 1, max: 8000 });
      const { data: conversation, error } = await db.from('conversations')
        .insert({ project_id: workspaceId, title: autoTitle(message) }).select('id,title,archived,created_at,updated_at,last_message_at').single();
      if (error) throw Object.assign(new Error(`Could not start the conversation: ${error.message}`), { statusCode: 500 });
      const job = await store.createJob({ title: autoTitle(message), goal: message, projectId: workspaceId, requestedProvider: 'auto', conversationId: conversation.id });
      return sendJson(response, 201, { ok: true, conversation: publicConversation(conversation), jobId: job.id }), true;
    }
    const conversationMatch = path.match(/^\/api\/conversations\/([0-9a-f-]{36})(?:\/(messages|stop))?$/i);
    if (conversationMatch) {
      const id = uuid(conversationMatch[1], 'conversationId');
      const conversation = await one(db.from('conversations').select('id,project_id,title,archived,created_at,updated_at,last_message_at').eq('id', id).maybeSingle());
      if (!conversation) return sendJson(response, 404, { ok: false, error: 'CONVERSATION_NOT_FOUND' }), true;
      if (method === 'GET' && !conversationMatch[2]) {
        const jobs = await rows(db.from('jobs').select('id,title,goal,status,progress,final_summary,cost_usd,tokens_used,created_at,completed_at')
          .eq('conversation_id', id).order('created_at', { ascending: true }).limit(200));
        const jobIds = jobs.map((job) => job.id);
        const openIds = jobs.filter((job) => !['completed', 'failed', 'cancelled'].includes(job.status)).map((job) => job.id);
        const stepRows = openIds.length ? await rows(db.from('tasks').select('job_id,title,status,sequence').in('job_id', openIds).order('sequence')) : [];
        const [results, sessions, attempts] = jobIds.length ? await Promise.all([
          rows(db.from('results').select('job_id,kind,content,created_at').in('job_id', jobIds).order('created_at')),
          rows(db.from('agent_sessions').select('id,title,status,phase,conversation_id,job_id,created_at').eq('conversation_id', id)),
          rows(db.from('model_attempts').select('job_id,provider,model,status,started_at').in('job_id', jobIds).order('started_at')),
        ]) : [[], [], []];
        const launchedBy = new Map();
        // Tasks launched from a message are attached to that message by time.
        for (const session of sessions) {
          const owner = [...jobs].reverse().find((job) => job.created_at <= session.created_at);
          if (owner) launchedBy.set(owner.id, [...(launchedBy.get(owner.id) || []), session]);
        }
        const messages = jobs.map((job) => messageFromJob(job, {
          results: results.filter((result) => result.job_id === job.id),
          sessions: launchedBy.get(job.id) || [],
          attempts: attempts.filter((attempt) => attempt.job_id === job.id),
          steps: stepRows.filter((step) => step.job_id === job.id),
        }));
        return sendJson(response, 200, { ok: true, conversation: publicConversation(conversation), messages }), true;
      }
      if (method === 'POST' && conversationMatch[2] === 'messages') {
        const body = await readJson(request);
        const message = text(body.message, 'Message', { min: 1, max: 8000 });
        const job = await store.createJob({ title: autoTitle(message), goal: message, projectId: conversation.project_id, requestedProvider: 'auto', conversationId: id });
        await db.from('conversations').update({ last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', id);
        return sendJson(response, 201, { ok: true, jobId: job.id }), true;
      }
      if (method === 'POST' && conversationMatch[2] === 'stop') {
        // Stops the conversation's unfinished request: queued steps are
        // skipped and the request is marked cancelled. A model call already
        // in flight finishes on its own; its result is kept but not awaited.
        const open = await rows(db.from('jobs').select('id').eq('conversation_id', id).in('status', ['planning', 'running']));
        for (const job of open) {
          await db.from('tasks').update({ status: 'skipped' }).eq('job_id', job.id).in('status', ['queued', 'assigned']);
          await db.from('jobs').update({ status: 'cancelled', completed_at: new Date().toISOString() }).eq('id', job.id).in('status', ['planning', 'running']);
        }
        return sendJson(response, 200, { ok: true, stopped: open.length }), true;
      }
      if (method === 'PATCH' && !conversationMatch[2]) {
        const body = await readJson(request);
        const patch = { updated_at: new Date().toISOString() };
        if (body.title !== undefined) Object.assign(patch, { title: text(body.title, 'Title', { min: 1, max: 200 }), title_source: 'owner' });
        if (body.archived !== undefined) patch.archived = Boolean(body.archived);
        const { data, error } = await db.from('conversations').update(patch).eq('id', id).select('id,title,archived,created_at,updated_at,last_message_at').single();
        if (error) throw Object.assign(new Error(`Could not update the conversation: ${error.message}`), { statusCode: 500 });
        return sendJson(response, 200, { ok: true, conversation: publicConversation(data) }), true;
      }
      if (method === 'DELETE' && !conversationMatch[2]) {
        // Deleting a conversation removes the thread; the underlying jobs,
        // results and audit rows are kept (conversation_id is set to null).
        const { error } = await db.from('conversations').delete().eq('id', id);
        if (error) throw Object.assign(new Error(`Could not delete the conversation: ${error.message}`), { statusCode: 500 });
        return sendJson(response, 200, { ok: true }), true;
      }
    }

    // ---- tasks (Coding Agent sessions)
    if (method === 'GET' && path === '/api/tasks') {
      const workspaceId = uuid(url.searchParams.get('workspaceId'), 'workspaceId');
      const status = url.searchParams.get('status');
      const sessions = await rows(db.from('agent_sessions').select(`${SESSION_FIELDS},conversation_id`).eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false }).limit(100));
      const approvals = await rows(db.from('agent_approvals').select('id,session_id,tool_name,action,risk,summary,arguments_preview,status,requested_at')
        .eq('workspace_id', workspaceId).eq('status', 'pending'));
      const items = sessions.map((session) => {
        const own = approvals.filter((approval) => approval.session_id === session.id);
        const needs = ownerAction(session, own);
        const group = needs ? 'attention' : TERMINAL.has(session.status) ? session.status : 'running';
        return { id: session.id, title: session.title, repository: session.repository, status: session.status, group, phase: session.phase,
          now: taskNow(session), needs: needs ? needs.kind : null, costUsd: Number(session.spent_usd || 0), currentModel: session.current_route,
          pr: session.state?.pr || null, conversationId: session.conversation_id || null,
          summary: session.result?.summary ? String(session.result.summary).slice(0, 280) : null,
          createdAt: session.created_at, updatedAt: session.updated_at, completedAt: session.completed_at };
      });
      const filtered = status ? items.filter((item) => item.group === status) : items;
      return sendJson(response, 200, { ok: true, tasks: filtered }), true;
    }
    if (method === 'POST' && path === '/api/tasks') {
      const body = await readJson(request);
      const workspaceId = uuid(body.workspaceId, 'workspaceId');
      const instruction = text(body.instruction, 'Instruction', { min: 12, max: 40_000 });
      const project = await one(db.from('projects').select('id,default_repository').eq('id', workspaceId).maybeSingle());
      const repository = typeof body.repository === 'string' && body.repository.trim() ? body.repository.trim() : project?.default_repository;
      if (!repository || !REPO_RE.test(repository)) throw input('Choose a repository (owner/name) for this task');
      const budgetUsd = body.budgetUsd === undefined ? 2 : Number(body.budgetUsd);
      if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 500) throw input('Budget must be between 0 and 500 USD');
      const config = { publish: 'pull_request' };
      if (typeof body.testCommand === 'string' && body.testCommand.trim()) config.testCommand = body.testCommand.trim().slice(0, 500);
      if (body.deploy === true) config.deploy = { mode: 'merge', workflow: 'deploy.yml' };
      if (['economy', 'balanced', 'quality'].includes(body.strategy)) config.routing = { strategy: body.strategy };
      if (Array.isArray(body.supabaseProjects)) config.supabase = { projects: body.supabaseProjects.filter((ref) => /^[a-z0-9]{20}$/.test(ref)).slice(0, 5) };
      const conversationId = body.conversationId ? uuid(body.conversationId, 'conversationId') : null;
      const title = autoTitle(instruction).slice(0, 120);
      const { data, error } = await db.rpc('create_coding_session', {
        p_workspace: workspaceId, p_title: title, p_objective: instruction, p_repository: repository,
        p_base_branch: 'main', p_budget_usd: budgetUsd, p_config: config, p_created_by: actor || null,
      });
      if (error) throw Object.assign(new Error(`Could not start the task: ${error.message}`), { statusCode: 500 });
      const session = Array.isArray(data) ? data[0] : data;
      if (conversationId) await db.from('agent_sessions').update({ conversation_id: conversationId }).eq('id', session.id);
      return sendJson(response, 201, { ok: true, task: { id: session.id, title: session.title, status: session.status } }), true;
    }
    const taskMatch = path.match(/^\/api\/tasks\/([0-9a-f-]{36})(?:\/(reply|resume|cancel))?$/i);
    if (taskMatch) {
      const id = uuid(taskMatch[1], 'taskId');
      if (method === 'GET' && !taskMatch[2]) {
        const session = await one(db.from('agent_sessions').select(`${SESSION_FIELDS},conversation_id`).eq('id', id).maybeSingle());
        if (!session) return sendJson(response, 404, { ok: false, error: 'TASK_NOT_FOUND' }), true;
        const [events, approvals, attempts] = await Promise.all([
          rows(db.from('agent_events').select('id,type,level,message,payload,created_at').eq('session_id', id).order('id', { ascending: false }).limit(200)),
          rows(db.from('agent_approvals').select('id,tool_name,action,risk,summary,arguments_preview,status,requested_at,decided_at,decided_by,note').eq('session_id', id).order('requested_at', { ascending: false })),
          rows(db.from('model_attempts').select('provider,model,status,input_tokens,cached_input_tokens,output_tokens,cost_usd,error_code,started_at').eq('job_id', session.job_id).order('started_at', { ascending: false }).limit(500)),
        ]);
        return sendJson(response, 200, { ok: true, task: taskView(session, { events, approvals, attempts }), events: events.map(publicEvent), approvals: approvals.map((approval) => ({ ...approval, card: approvalCard(approval) })) }), true;
      }
      if (method === 'POST' && taskMatch[2] === 'reply') {
        const body = await readJson(request);
        const message = text(body.message, 'Reply', { min: 1, max: 8000 });
        const { error } = await db.rpc('reply_agent_session', { p_session: id, p_message: message, p_created_by: actor || 'hub-owner' });
        if (error) throw Object.assign(new Error(/CLOSED/.test(error.message) ? 'This task is already finished.' : `Could not send the reply: ${error.message}`), { statusCode: /CLOSED/.test(error.message) ? 409 : 500 });
        return sendJson(response, 200, { ok: true }), true;
      }
      if (method === 'POST' && taskMatch[2] === 'resume') {
        const { error } = await db.rpc('resume_agent_session', { p_session: id });
        if (error) throw Object.assign(new Error(`Could not resume: ${error.message}`), { statusCode: 500 });
        return sendJson(response, 200, { ok: true }), true;
      }
      if (method === 'POST' && taskMatch[2] === 'cancel') {
        const { error } = await db.rpc('request_agent_session_cancel', { p_session: id });
        if (error) throw Object.assign(new Error(`Could not cancel: ${error.message}`), { statusCode: 500 });
        return sendJson(response, 200, { ok: true }), true;
      }
    }

    // ---- models (simplified pool; AUTO routing)
    if (method === 'GET' && path === '/api/models') {
      const requested = url.searchParams.get('workspaceId');
      const snapshot = await modelPoolSnapshot({ db, workspaceId: requested ? uuid(requested, 'workspaceId') : null });
      return sendJson(response, 200, { ok: true, ...modelsView(snapshot) }), true;
    }

    // ---- needs attention
    if (method === 'GET' && path === '/api/attention') {
      const workspaceId = uuid(url.searchParams.get('workspaceId'), 'workspaceId');
      const since = new Date(Date.now() - 3 * 24 * 3600_000).toISOString();
      const [sessions, approvals, failedJobs] = await Promise.all([
        rows(db.from('agent_sessions').select('id,title,status,error_code,blocker,result,updated_at,completed_at').eq('workspace_id', workspaceId)
          .or(`status.in.(awaiting_approval,blocked),updated_at.gte.${since}`).order('updated_at', { ascending: false }).limit(60)),
        rows(db.from('agent_approvals').select('id,session_id,tool_name,action,risk,summary,arguments_preview,status,requested_at').eq('workspace_id', workspaceId).eq('status', 'pending')),
        rows(db.from('jobs').select('id,title,conversation_id,status,created_at,completed_at').eq('project_id', workspaceId).eq('status', 'failed')
          .not('conversation_id', 'is', null).gte('created_at', since).limit(20)),
      ]);
      const items = attentionFrom({ sessions, approvals, failedJobs });
      return sendJson(response, 200, { ok: true, items, counts: { action: items.filter((item) => item.severity === 'action').length, total: items.length } }), true;
    }

    // ---- projects (context + memory)
    const projectMatch = path.match(/^\/api\/projects\/([0-9a-f-]{36})(?:\/(memory)(?:\/([0-9a-f-]{36}))?)?$/i);
    if (projectMatch) {
      const id = uuid(projectMatch[1], 'projectId');
      if (method === 'GET' && !projectMatch[2]) {
        const [project, memory, conversations, tasks] = await Promise.all([
          one(db.from('projects').select('id,name,description,default_repository,created_at').eq('id', id).maybeSingle()),
          rows(db.from('project_memory').select('id,kind,content,source,created_at').eq('project_id', id).order('created_at', { ascending: false }).limit(100)),
          rows(db.from('conversations').select('id', { count: 'exact', head: false }).eq('project_id', id).eq('archived', false).limit(1000)),
          rows(db.from('agent_sessions').select('id,status').eq('workspace_id', id).limit(1000)),
        ]);
        if (!project) return sendJson(response, 404, { ok: false, error: 'PROJECT_NOT_FOUND' }), true;
        return sendJson(response, 200, { ok: true, project: { id: project.id, name: project.name, description: project.description || '', defaultRepository: project.default_repository || '', createdAt: project.created_at },
          memory, stats: { conversations: conversations.length, tasks: tasks.length, completedTasks: tasks.filter((task) => task.status === 'completed').length } }), true;
      }
      if (method === 'PATCH' && !projectMatch[2]) {
        const body = await readJson(request);
        const patch = {};
        if (body.description !== undefined) patch.description = String(body.description || '').trim().slice(0, 4000) || null;
        if (body.defaultRepository !== undefined) {
          const repo = String(body.defaultRepository || '').trim();
          if (repo && !REPO_RE.test(repo)) throw input('Repository must be owner/name');
          patch.default_repository = repo || null;
        }
        const { error } = await db.from('projects').update(patch).eq('id', id);
        if (error) throw Object.assign(new Error(`Could not update the project: ${error.message}`), { statusCode: 500 });
        return sendJson(response, 200, { ok: true }), true;
      }
      if (method === 'POST' && projectMatch[2] === 'memory' && !projectMatch[3]) {
        const body = await readJson(request);
        const content = text(body.content, 'Memory', { min: 3, max: 2000 });
        const kind = ['fact', 'decision', 'preference'].includes(body.kind) ? body.kind : 'fact';
        const { data, error } = await db.from('project_memory').insert({ project_id: id, kind, content, source: 'owner' }).select('id,kind,content,source,created_at').single();
        if (error) throw Object.assign(new Error(`Could not save: ${error.message}`), { statusCode: 500 });
        return sendJson(response, 201, { ok: true, memory: data }), true;
      }
      if (method === 'DELETE' && projectMatch[2] === 'memory' && projectMatch[3]) {
        const { error } = await db.from('project_memory').delete().eq('id', uuid(projectMatch[3], 'memoryId')).eq('project_id', id);
        if (error) throw Object.assign(new Error(`Could not delete: ${error.message}`), { statusCode: 500 });
        return sendJson(response, 200, { ok: true }), true;
      }
    }
    return sendJson(response, 404, { ok: false, error: 'NOT_FOUND' }), true;
  } catch (error) {
    const status = error.statusCode || 500;
    return sendJson(response, status, { ok: false, error: String(error.message || 'Request failed').slice(0, 300) }), true;
  }
}

function publicConversation(row) {
  return { id: row.id, title: row.title, archived: row.archived, createdAt: row.created_at, updatedAt: row.updated_at, lastMessageAt: row.last_message_at };
}
