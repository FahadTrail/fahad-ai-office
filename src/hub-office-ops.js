// Live Operations: one objective, as it really runs. Everything here is derived
// from authoritative rows — the job, its task graph, handoffs, results,
// artifacts, the event log, the model_attempts audit, approvals and Coding
// Agent sessions. Nothing is invented: no percentage the backend cannot back,
// no state without a row, no handoff without a record.
//
//   operationsView(rows) → { objective, chief, agents, nowWorking, pipeline,
//                            handoffs, timeline, deliverables, final,
//                            revisions, needsFahad, capacity, routing }
//
// Pure: no I/O. handleOperationsApi() reads the rows and calls it.

import { OFFICE_AGENTS, officeAgent, parseOutput } from './office/agents.js';

export const OPS_STATES = Object.freeze(['AVAILABLE', 'ASSIGNED', 'WORKING', 'REVIEWING', 'WAITING', 'BLOCKED', 'NEEDS FAHAD', 'COMPLETED', 'FAILED']);
const ACTIVE_JOB = new Set(['planning', 'running', 'review', 'waiting_approval']);
const DONE_TASK = new Set(['done', 'skipped']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Historical test / demo / certification objectives never become the default
// operational view (they stay findable by id). Active work is always shown.
const TEST_OBJECTIVE = /\b(test(?:ing)?|smoke|canary|probe|drill|benchmark|certification|demo|acceptance|burn[- ]?in|load test|qa check|v2 check|safe to delete)\b|\[(?:drill|test)[^\]]*\]/i;
export const isTestObjective = (job) => TEST_OBJECTIVE.test(`${job?.title || ''} ${String(job?.goal || '').slice(0, 300)}`);

const briefOf = (task) => { try { return JSON.parse(task?.brief || '{}') || {}; } catch { return {}; } };
const stageOf = (task) => briefOf(task).stage || null;
const STAGE_KIND = { chief_plan: 'plan', synthesis: 'synthesis', chief_review: 'synthesis', specialist: 'workstream', research: 'workstream', launch_dev: 'development', consult: 'consult', direct: 'conversation' };
const ms = (value) => { const parsed = Date.parse(value || ''); return Number.isFinite(parsed) ? parsed : null; };
const routeLabel = (provider, model) => (provider && model ? `${provider} · ${model}` : model || provider || null);
const shortModel = (model) => String(model || '').replace(/^.*\//, '').replace(/:free$/, '');
const billingOf = (attempt) => {
  const declared = Array.isArray(attempt?.route) ? attempt.route[0]?.billingClass : attempt?.route?.billingClass;
  if (declared) return /free/i.test(declared) ? 'free' : 'paid';
  if (Number(attempt?.cost_usd || 0) > 0) return 'paid';
  return /:free$/.test(attempt?.model || '') ? 'free' : null;
};
const parseRoute = (id) => { const [provider, ...rest] = String(id || '').split(':'); return { provider: provider || null, model: rest.join(':') || null }; };

// One task's operational state (the primary states of the Live Operations view).
export function taskOpsState(task, { byId, now = Date.now(), jobActive = true, needsFahad = false } = {}) {
  if (needsFahad) return 'NEEDS FAHAD';
  if (task.status === 'running') return ['synthesis', 'chief_review'].includes(stageOf(task)) ? 'REVIEWING' : 'WORKING';
  if (DONE_TASK.has(task.status)) return 'COMPLETED';
  if (task.status === 'failed') return 'FAILED';
  if (task.status === 'blocked') return 'BLOCKED';
  if (task.status === 'waiting_approval') return 'NEEDS FAHAD';
  if (!jobActive) return 'BLOCKED'; // queued in a stopped objective: it will not run
  if (task.not_before && ms(task.not_before) > now) return 'WAITING';
  const open = (task.depends_on || []).filter((id) => byId.has(id) && !DONE_TASK.has(byId.get(id).status));
  return open.length ? 'WAITING' : 'ASSIGNED';
}

// Lifecycle column: Plan → Assigned → Running → Delivered → Review → Revision → Final.
function pipelineStage(task, state) {
  const stage = stageOf(task);
  const revision = Boolean(briefOf(task).revision);
  if (stage === 'chief_plan') return 'plan';
  if (stage === 'synthesis' || stage === 'chief_review') return state === 'COMPLETED' ? 'final' : 'review';
  if (revision) return state === 'COMPLETED' ? 'delivered' : 'revision';
  if (state === 'COMPLETED') return 'delivered';
  if (state === 'WORKING' || state === 'REVIEWING') return 'running';
  return 'assigned';
}

export function operationsView({ job, tasks = [], agents = [], results = [], handoffs = [], events = [], attempts = [], artifacts = [], approvals = [], officeApprovals = [], sessions = [], now = Date.now() }) {
  if (!job) return null;
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const employeeOf = (task) => officeAgent(agentById.get(task?.agent_id)?.slug);
  const keyOf = (task) => employeeOf(task)?.key || null;
  const labelOf = (task) => employeeOf(task)?.label || agentById.get(task?.agent_id)?.name || 'Agent';
  const jobActive = ACTIVE_JOB.has(job.status);
  const ordered = tasks.toSorted((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0) || String(a.created_at).localeCompare(String(b.created_at)));

  // Coding Agent sessions this objective launched, and what they need from Fahad.
  const sessionByTask = new Map();
  for (const event of events) if (event.payload?.kind === 'task_launched' && event.payload.session_id) sessionByTask.set(event.task_id, sessions.find((session) => session.id === event.payload.session_id) || null);
  const sessionIds = new Set(sessions.map((session) => session.id));
  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending' && sessionIds.has(approval.session_id));
  const pendingOffice = officeApprovals.filter((approval) => approval.status === 'pending');
  const needsByTask = new Map();
  for (const [taskId, session] of sessionByTask) {
    if (!session) continue;
    const approval = pendingApprovals.find((entry) => entry.session_id === session.id);
    if (approval) needsByTask.set(taskId, { kind: 'approval', text: String(approval.summary || approval.tool_name || 'Approval requested').slice(0, 200), sessionId: session.id, risk: approval.risk || null });
    else if (session.status === 'blocked' && session.error_code === 'HUMAN_INPUT_REQUIRED') needsByTask.set(taskId, { kind: 'question', text: String(session.blocker?.question || session.blocker?.message || session.title).slice(0, 200), sessionId: session.id });
  }
  for (const approval of pendingOffice) if (approval.task_id) needsByTask.set(approval.task_id, { kind: /delete|destroy|drop|remove/i.test(approval.action_type || '') ? 'destructive' : /credential|secret|key|token/i.test(approval.action_type || '') ? 'credential' : 'approval', text: approval.title || approval.description || 'Approval requested', approvalId: approval.id });

  // Model activity per task, from the model_attempts audit.
  const attemptsByTask = new Map();
  for (const attempt of attempts.toSorted((a, b) => String(a.started_at).localeCompare(String(b.started_at)))) if (attempt.task_id) attemptsByTask.set(attempt.task_id, [...(attemptsByTask.get(attempt.task_id) || []), attempt]);
  const switchesByTask = new Map();
  for (const event of events.filter((entry) => entry.payload?.kind === 'provider_switch')) {
    const from = parseRoute(event.payload.fromProvider); const to = parseRoute(event.payload.toProvider);
    switchesByTask.set(event.task_id, [...(switchesByTask.get(event.task_id) || []), { at: event.created_at, from: shortModel(from.model) || from.provider, to: shortModel(to.model) || to.provider, fromRoute: event.payload.fromProvider || null, toRoute: event.payload.toProvider || null, reason: event.payload.reason?.code || null }]);
  }
  const routingOf = (task) => {
    const list = attemptsByTask.get(task.id) || [];
    const latest = list.at(-1) || null;
    const failures = list.filter((attempt) => ['failed', 'blocked'].includes(attempt.status));
    return {
      provider: latest?.provider || null, model: latest?.model || null, modelShort: shortModel(latest?.model) || null, billing: billingOf(latest),
      attempts: list.length, failures: failures.length, retries: Math.max(0, list.length - 1),
      live: latest?.status === 'started' && !latest?.ended_at,
      switches: switchesByTask.get(task.id) || [],
      path: list.map((attempt) => ({ model: shortModel(attempt.model), provider: attempt.provider, status: attempt.status, error: attempt.error_code || null, billing: billingOf(attempt), at: attempt.started_at })),
      costUsd: Number(list.reduce((sum, attempt) => sum + Number(attempt.cost_usd || 0), 0).toFixed(6)),
      capacityWait: task.not_before && ms(task.not_before) > now ? { until: task.not_before, detail: task.wait_info?.detail || null, reason: task.wait_info?.reason || null, autoResume: true, waits: Number(task.wait_count || 0) } : null,
    };
  };

  // Outputs and deliverables.
  const latestResult = new Map();
  for (const result of results.toSorted((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) if (result.kind !== 'final' && result.task_id) latestResult.set(result.task_id, result);
  const artifactsByTask = new Map();
  for (const artifact of artifacts) artifactsByTask.set(artifact.task_id, [...(artifactsByTask.get(artifact.task_id) || []), artifact]);
  const verification = (artifact) => {
    if (artifact.type === 'financial_model') { const state = artifact.data?.validation?.state; return state === 'VERIFIED' ? 'VERIFIED' : state ? 'NEEDS REVIEW' : null; }
    if (artifact.type === 'chart' && artifact.data?.calculated === true) return 'VERIFIED';
    if (artifact.type === 'audit_report') return artifact.data?.verdict ? String(artifact.data.verdict).toUpperCase().slice(0, 24) : null;
    return null;
  };

  // When work really started: the first agent_started event (tasks.started_at
  // is rewritten by every retry or validation round).
  const firstStart = new Map();
  for (const event of events) if (event.type === 'agent_started' && event.task_id && (!firstStart.has(event.task_id) || event.created_at < firstStart.get(event.task_id))) firstStart.set(event.task_id, event.created_at);
  const startOf = (task) => { const first = firstStart.get(task.id); return first && (!task.started_at || ms(first) < ms(task.started_at)) ? first : task.started_at || null; };

  // Per-task records.
  const records = ordered.map((task) => {
    const state = taskOpsState(task, { byId, now, jobActive, needsFahad: needsByTask.has(task.id) });
    const brief = briefOf(task);
    const waitingFor = (task.depends_on || []).map((id) => byId.get(id)).filter((dep) => dep && !DONE_TASK.has(dep.status)).map((dep) => ({ taskId: dep.id, key: keyOf(dep), label: labelOf(dep), title: dep.title }));
    const output = latestResult.get(task.id);
    const parsed = output ? parseOutput(output.content) : null;
    const routing = routingOf(task);
    const waitReason = state !== 'WAITING' ? null
      : routing.capacityWait ? { kind: 'capacity', text: routing.capacityWait.detail || 'Waiting for free model capacity', until: routing.capacityWait.until, autoResume: true }
        : waitingFor.length ? { kind: 'dependency', text: `Waiting for ${[...new Set(waitingFor.map((dep) => dep.label))].join(', ')}`, on: waitingFor } : null;
    const blockCode = state === 'BLOCKED' ? (task.status === 'blocked' ? 'upstream_failed' : 'objective_stopped') : state === 'FAILED' ? 'failed' : null;
    const blockReason = { upstream_failed: 'An earlier step failed, so this step cannot run.', objective_stopped: `The objective is ${job.status}; this step will not run.`, failed: 'The step failed after its retries.' }[blockCode] || null;
    return {
      id: task.id, title: task.title, agentKey: keyOf(task), agentLabel: labelOf(task), kind: STAGE_KIND[stageOf(task)] || 'task',
      revision: Boolean(brief.revision), state, stage: pipelineStage(task, state),
      dependsOn: (task.depends_on || []).filter((id) => byId.has(id)), waitingFor, waitReason, blockReason, blockCode, needsFahad: needsByTask.get(task.id) || null,
      createdAt: task.created_at, startedAt: startOf(task), completedAt: task.completed_at || null,
      elapsedMs: startOf(task) ? Math.max(0, (ms(task.completed_at) || now) - ms(startOf(task))) : null,
      attempts: Number(task.attempts || 0), routing,
      output: parsed ? { summary: parsed.summary.slice(0, 400) || String(output.summary || '').slice(0, 400), at: output.created_at } : null,
      artifacts: (artifactsByTask.get(task.id) || []).map((artifact) => ({ id: artifact.id, type: artifact.type, title: artifact.title, at: artifact.created_at, verification: verification(artifact) })),
      codingTask: sessionByTask.get(task.id) ? { id: sessionByTask.get(task.id).id, status: sessionByTask.get(task.id).status, phase: sessionByTask.get(task.id).phase } : null,
    };
  });
  // A synthesis round superseded by a later one was CHIEF's review (it asked
  // for revisions); only the last round is the final synthesis.
  const synthesisRounds = records.filter((record) => record.kind === 'synthesis');
  for (const record of synthesisRounds.slice(0, -1)) { record.kind = 'review'; record.stage = 'review'; }
  const recordById = new Map(records.map((record) => [record.id, record]));
  const workstreams = records.filter((record) => ['workstream', 'development'].includes(record.kind));
  const planRecord = records.find((record) => record.kind === 'plan') || null;
  const synthesisRecords = records.filter((record) => record.kind === 'synthesis');
  const finalSynthesis = synthesisRecords.at(-1) || null;

  // Revision rounds, from the revision_requested events and the revision tasks.
  const revisionEvents = events.filter((event) => event.payload?.kind === 'revision_requested');
  const revisions = records.filter((record) => record.revision).map((record) => {
    const original = workstreams.find((entry) => !entry.revision && entry.agentKey === record.agentKey && ms(entry.createdAt) <= ms(record.createdAt));
    const requested = revisionEvents.find((event) => ms(event.created_at) <= ms(record.createdAt) + 5000) || null;
    const accepted = finalSynthesis && finalSynthesis.state === 'COMPLETED' && ms(finalSynthesis.startedAt) >= ms(record.completedAt || '') ? finalSynthesis.completedAt : null;
    return {
      agentKey: record.agentKey, agentLabel: record.agentLabel, taskId: record.id, title: record.title,
      steps: [
        ...(original?.completedAt ? [{ step: 'draft_delivered', at: original.completedAt, by: record.agentKey }] : []),
        ...(requested ? [{ step: 'revision_requested', at: requested.created_at, by: 'chief', instruction: String(requested.payload?.revisions?.find((entry) => entry)?.instruction || '').split('\n')[0].slice(0, 200) }] : []),
        ...(record.startedAt ? [{ step: 'revision_in_progress', at: record.startedAt, by: record.agentKey }] : []),
        ...(record.completedAt ? [{ step: 'revision_delivered', at: record.completedAt, by: record.agentKey }] : []),
        ...(accepted ? [{ step: 'accepted', at: accepted, by: 'chief' }] : []),
      ],
      state: record.state,
    };
  });

  // Handoffs (first-class): what moved, between which tasks, and what came of it.
  const handoffList = handoffs.toSorted((a, b) => String(a.created_at).localeCompare(String(b.created_at))).map((handoff) => {
    const from = officeAgent(agentById.get(handoff.from_agent_id)?.slug); const to = officeAgent(agentById.get(handoff.to_agent_id)?.slug);
    const fromRecord = recordById.get(handoff.from_task_id); const toRecord = recordById.get(handoff.to_task_id);
    const status = !toRecord ? 'unknown' : { COMPLETED: 'delivered', WORKING: 'in progress', REVIEWING: 'in progress', FAILED: 'failed', BLOCKED: 'blocked', WAITING: 'waiting', ASSIGNED: 'received', 'NEEDS FAHAD': 'needs Fahad' }[toRecord.state] || 'received';
    return {
      id: handoff.id || `${handoff.from_task_id}>${handoff.to_task_id}`, from: from?.label || 'Agent', fromKey: from?.key || null, to: to?.label || 'Agent', toKey: to?.key || null,
      what: fromRecord?.output?.summary?.slice(0, 220) || String(handoff.summary || '').slice(0, 220) || fromRecord?.title || null,
      fromTask: fromRecord ? { id: fromRecord.id, title: fromRecord.title } : null, toTask: toRecord ? { id: toRecord.id, title: toRecord.title } : null,
      artifact: fromRecord?.artifacts.at(-1) || null, at: handoff.created_at, status,
      result: toRecord?.state === 'COMPLETED' ? (toRecord.output?.summary?.slice(0, 160) || 'Delivered') : null,
      fresh: now - (ms(handoff.created_at) || 0) < 10 * 60_000,
    };
  }).filter((handoff) => handoff.fromKey && handoff.toKey && handoff.fromKey !== handoff.toKey);

  // Agent cards: every employee involved in this objective, on its current task.
  const involved = [...new Set(records.map((record) => record.agentKey).filter(Boolean))];
  const rank = { 'NEEDS FAHAD': 0, WORKING: 1, REVIEWING: 1, WAITING: 2, ASSIGNED: 3, BLOCKED: 4, FAILED: 4, COMPLETED: 5 };
  const agentsView = involved.map((key) => {
    const own = records.filter((record) => record.agentKey === key);
    const current = own.toSorted((a, b) => rank[a.state] - rank[b.state] || String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    const lastEvent = events.filter((event) => own.some((record) => record.id === event.task_id)).map((event) => event.created_at).sort().at(-1) || null;
    const roster = OFFICE_AGENTS.find((entry) => entry.key === key);
    return {
      key, label: current.agentLabel, department: roster?.deliverable || null, state: current.state, task: current.title, taskId: current.id, stage: current.stage,
      startedAt: current.startedAt, elapsedMs: current.elapsedMs, lastActivityAt: lastEvent,
      provider: current.routing.provider, model: current.routing.model, modelShort: current.routing.modelShort, billing: current.routing.billing,
      attempts: current.routing.attempts, switches: current.routing.switches.length,
      handoffs: handoffList.filter((handoff) => handoff.fromKey === key || handoff.toKey === key).length,
      latestOutput: own.map((record) => record.output).filter(Boolean).at(-1) || null,
      deliverables: own.flatMap((record) => record.artifacts).length,
      revision: revisions.find((entry) => entry.agentKey === key) ? (current.revision ? (current.state === 'COMPLETED' ? 'revision delivered' : 'revision in progress') : 'revision requested') : null,
      waitReason: current.waitReason, blockReason: current.blockReason, blockCode: current.blockCode, needsFahad: current.needsFahad,
      tasks: own.length,
    };
  });

  // Now Working: only genuine running work.
  const nowWorking = records.filter((record) => ['WORKING', 'REVIEWING'].includes(record.state)).map((record) => ({
    key: record.agentKey, label: record.agentLabel, task: record.title, taskId: record.id, state: record.state, startedAt: record.startedAt, elapsedMs: record.elapsedMs,
    provider: record.routing.provider, model: record.routing.model, modelShort: record.routing.modelShort, billing: record.routing.billing, live: record.routing.live,
    lastActivity: (() => { const event = events.filter((entry) => entry.task_id === record.id).toSorted((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]; return event ? { at: event.created_at, text: humanEvent(event, { labelOf: () => record.agentLabel }) || String(event.message || '').slice(0, 140) } : null; })(),
  }));

  // CHIEF command.
  const count = (predicate) => workstreams.filter(predicate).length;
  const chiefTask = records.filter((record) => record.agentKey === 'chief' && ['WORKING', 'REVIEWING'].includes(record.state))[0] || null;
  const openStreams = workstreams.filter((record) => record.state !== 'COMPLETED');
  const planning = !planRecord ? (jobActive && !workstreams.length ? 'working' : 'done') : planRecord.state === 'COMPLETED' ? 'done' : ['WORKING', 'REVIEWING'].includes(planRecord.state) ? 'working' : 'pending';
  const synthesis = !finalSynthesis ? 'not started' : finalSynthesis.state === 'COMPLETED' ? 'done' : ['WORKING', 'REVIEWING'].includes(finalSynthesis.state) ? 'working' : finalSynthesis.state === 'FAILED' ? 'failed' : 'waiting';
  const waitingOn = finalSynthesis && finalSynthesis.state === 'WAITING' ? finalSynthesis.waitingFor.map((dep) => dep.label) : [];
  const actionCode = job.status === 'completed' ? 'delivered' : job.status === 'failed' || job.status === 'cancelled' ? 'stopped'
    : planning === 'working' ? 'planning' : chiefTask ? (chiefTask.kind === 'synthesis' ? 'synthesis' : chiefTask.kind === 'review' ? 'review' : 'working')
      : openStreams.length ? 'coordinating' : 'awaiting_synthesis';
  const action = { delivered: 'Delivered the final result', stopped: 'Stopped', planning: 'Planning the work', synthesis: 'Writing the final synthesis', review: 'Reviewing the team’s work',
    working: `Working on ${chiefTask?.title || ''}`, coordinating: 'Coordinating the team', awaiting_synthesis: 'Waiting to start the synthesis' }[actionCode];
  const openLabels = [...new Set(openStreams.map((record) => record.agentLabel))];
  const nextCode = ['completed', 'failed', 'cancelled'].includes(job.status) ? null : planning !== 'done' ? 'assign' : synthesis === 'working' ? 'deliver' : openStreams.length ? 'synthesize_after' : 'start_synthesis';
  const next = { assign: 'Assign the workstreams', deliver: 'Deliver the final result', synthesize_after: `Synthesize once ${openLabels.join(', ')} deliver`, start_synthesis: 'Start the final synthesis' }[nextCode] || null;
  const chief = {
    state: chiefTask ? chiefTask.state : job.status === 'completed' ? 'COMPLETED' : ['failed', 'cancelled'].includes(job.status) ? 'FAILED' : jobActive ? 'WAITING' : 'AVAILABLE',
    action, actionCode, next, nextCode, nextAfter: nextCode === 'synthesize_after' ? openLabels : [], waitingFor: waitingOn.length ? waitingOn : openStreams.length && synthesis !== 'working' && jobActive ? [...new Set(openStreams.map((record) => record.agentLabel))] : [],
    planning, synthesis, revisionRounds: revisionEvents.length,
    counts: { workstreams: workstreams.length, assigned: count((record) => record.state === 'ASSIGNED'), working: count((record) => ['WORKING', 'REVIEWING'].includes(record.state)), waiting: count((record) => record.state === 'WAITING'), blocked: count((record) => ['BLOCKED', 'FAILED'].includes(record.state)), completed: count((record) => record.state === 'COMPLETED'), needsFahad: count((record) => record.state === 'NEEDS FAHAD') },
    tree: workstreams.map((record) => ({ taskId: record.id, key: record.agentKey, label: record.agentLabel, title: record.title, state: record.state, revision: record.revision, after: record.dependsOn.map((id) => recordById.get(id)).filter((dep) => dep && dep.kind !== 'plan').map((dep) => dep.agentLabel) })),
  };

  // Deliverables, linked to their task, plus the final synthesis.
  const finalResult = results.filter((result) => result.kind === 'final').at(-1) || null;
  const deliverables = [
    ...records.flatMap((record) => record.artifacts.map((artifact) => ({ ...artifact, agentKey: record.agentKey, agentLabel: record.agentLabel, taskId: record.id, taskTitle: record.title, revision: record.revision }))),
    ...records.filter((record) => record.output && !['plan', 'synthesis', 'review'].includes(record.kind)).map((record) => ({ id: `result:${record.id}`, type: 'report', title: record.title, at: record.output.at, verification: null, preview: record.output.summary.slice(0, 220), agentKey: record.agentKey, agentLabel: record.agentLabel, taskId: record.id, taskTitle: record.title, revision: record.revision })),
  ].toSorted((a, b) => String(a.at).localeCompare(String(b.at)));
  const final = finalResult ? { at: finalResult.created_at, summary: parseOutput(finalResult.content).summary.slice(0, 700), taskId: finalSynthesis?.id || null } : null;

  // Needs Fahad: genuine owner decisions only — never an internal wait.
  const needsFahad = [
    ...records.filter((record) => record.needsFahad).map((record) => ({ ...record.needsFahad, agentKey: record.agentKey, agentLabel: record.agentLabel, taskId: record.id, task: record.title })),
    ...pendingOffice.filter((approval) => !approval.task_id).map((approval) => ({ kind: 'approval', text: approval.title || 'Approval requested', approvalId: approval.id })),
  ];

  // Capacity waits, explained.
  const capacity = records.filter((record) => record.routing.capacityWait && record.state === 'WAITING').map((record) => ({
    key: record.agentKey, label: record.agentLabel, task: record.title, taskId: record.id, until: record.routing.capacityWait.until, detail: record.routing.capacityWait.detail,
    reason: record.routing.capacityWait.reason, autoResume: true, waits: record.routing.capacityWait.waits,
  }));

  // Stage of the whole objective.
  const stage = job.status === 'completed' ? 'completed' : job.status === 'failed' ? 'failed' : job.status === 'cancelled' ? 'cancelled'
    : needsFahad.length ? 'needs_fahad' : planning !== 'done' ? 'planning' : synthesis === 'working' ? 'synthesis' : revisions.some((entry) => entry.state !== 'COMPLETED') ? 'revision'
      : capacity.length && !nowWorking.length ? 'waiting_capacity' : 'workstreams';
  const spend = Number(attempts.reduce((sum, attempt) => sum + Number(attempt.cost_usd || 0), 0).toFixed(6));
  const objective = {
    id: job.id, title: job.title || String(job.goal || '').slice(0, 120), goal: job.goal, status: job.status, active: jobActive, stage,
    test: isTestObjective(job), freeOnly: Boolean(job.free_only), conversationId: job.conversation_id || null,
    createdAt: job.created_at, completedAt: job.completed_at || null, elapsedMs: Math.max(0, (ms(job.completed_at) || now) - ms(job.created_at)),
    workstreams: { total: workstreams.length, completed: chief.counts.completed, working: chief.counts.working, waiting: chief.counts.waiting, blocked: chief.counts.blocked },
    blockers: records.filter((record) => ['BLOCKED', 'FAILED'].includes(record.state)).map((record) => ({ key: record.agentKey, label: record.agentLabel, task: record.title, reason: record.blockReason })),
    approvals: needsFahad.length, handoffs: handoffList.length, deliverables: deliverables.length,
    modelActivity: nowWorking.map((entry) => ({ key: entry.key, label: entry.label, provider: entry.provider, model: entry.modelShort, billing: entry.billing })),
    spendUsd: spend, attempts: attempts.length, freeAttempts: attempts.filter((attempt) => billingOf(attempt) === 'free').length,
  };

  return {
    objective, chief, agents: agentsView, nowWorking,
    pipeline: records.filter((record) => record.kind !== 'consult' && record.kind !== 'conversation').map((record) => ({ taskId: record.id, key: record.agentKey, label: record.agentLabel, title: record.title, kind: record.kind, stage: record.stage, state: record.state, revision: record.revision, waitReason: record.waitReason, after: record.dependsOn.map((id) => recordById.get(id)?.agentLabel).filter(Boolean), startedAt: record.startedAt, completedAt: record.completedAt })),
    handoffs: handoffList.toReversed(),
    timeline: timelineOf({ events, recordById }),
    deliverables, final, revisions, needsFahad, capacity,
    routing: records.filter((record) => record.routing.attempts || record.routing.capacityWait).map((record) => ({ taskId: record.id, key: record.agentKey, label: record.agentLabel, task: record.title, ...record.routing })),
  };
}

// One readable sentence for an event, or null for internal noise.
function humanEvent(event, { labelOf }) {
  const kind = event.payload?.kind;
  const message = String(event.message || '');
  if (event.type === 'provider_switch' || kind === 'provider_switch') {
    const from = parseRoute(event.payload?.fromProvider); const to = parseRoute(event.payload?.toProvider);
    return `${labelOf()} switched model: ${shortModel(from.model) || from.provider} → ${shortModel(to.model) || to.provider}${event.payload?.reason?.code ? ` (${String(event.payload.reason.code).replace(/^PROVIDER_/, '').toLowerCase().replace(/_/g, ' ')})` : ''}`;
  }
  return message ? message.replace(/\.$/, '') : null;
}

// The readable timeline (oldest first). Each entry carries structured fields
// (kind, who, title, model, from, to, reason) so the Hub words it in Arabic or
// English; `text` is the English sentence. Low-value internals are kept but
// marked technical, so the default view stays quiet and the detail expands.
const TECHNICAL = new Set(['model_checkpoint', 'model_stage_started', 'fact_gate', 'audit_numeric_checks', 'model_route', 'output_ready', 'consult_requested', 'routing_hint', 'fact_gate_enforced']);
const reasonWord = (code) => (code ? String(code).replace(/^PROVIDER_/, '').toLowerCase().replace(/_/g, ' ') : null);
function timelineOf({ events, recordById }) {
  const entries = [];
  const modelAt = (taskId, at) => { const path = recordById.get(taskId)?.routing.path || []; const step = path.find((entry) => ms(entry.at) >= ms(at) - 2000) || path[0]; return step ? step.model : null; };
  const push = (entry) => entries.push(entry);
  for (const event of events.toSorted((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || Number(a.id || 0) - Number(b.id || 0))) {
    const kind = event.payload?.kind || null;
    const record = recordById.get(event.task_id);
    const who = record?.agentKey || 'chief';
    const label = record?.agentLabel || 'CHIEF';
    const title = record?.title || '';
    const base = { at: event.created_at, taskId: event.task_id || null, agentKey: who, who: label };
    const role = record?.kind;
    if (event.type === 'job_created') push({ ...base, agentKey: 'chief', who: 'CHIEF', kind: 'objective', text: 'CHIEF received the objective' });
    else if (event.type === 'plan_created' || kind === 'workflow_planned') { const count = (event.payload?.workstreams || []).length; push({ ...base, agentKey: 'chief', who: 'CHIEF', kind: 'plan', count, text: `CHIEF planned ${count} workstream${count === 1 ? '' : 's'}` }); }
    else if (event.type === 'agent_assigned') {
      if (role === 'plan') continue;
      if (role === 'synthesis' || role === 'review') push({ ...base, agentKey: 'chief', kind: role === 'review' ? 'review_queued' : 'synthesis_queued', text: role === 'review' ? 'CHIEF queued its review of the team’s work' : 'CHIEF queued the final synthesis' });
      else push({ ...base, kind: 'assigned', title, revision: Boolean(record?.revision), text: `CHIEF assigned ${label}${record?.revision ? ' a revision' : ''} — ${title}` });
    } else if (event.type === 'agent_started') {
      const model = modelAt(event.task_id, event.created_at);
      const startKind = role === 'plan' ? 'planning' : role === 'synthesis' ? 'synthesis' : role === 'review' ? 'review' : 'start';
      const text = { planning: 'CHIEF started planning', synthesis: 'CHIEF started the final synthesis', review: 'CHIEF started reviewing the team’s work', start: `${label} started${record?.revision ? ' the revision' : ''}` }[startKind];
      push({ ...base, kind: startKind, model, revision: Boolean(record?.revision), title, text: `${text}${model ? ` · ${model}` : ''}` });
    } else if (event.type === 'task_completed') {
      const doneKind = role === 'plan' ? 'planned' : role === 'synthesis' ? 'final' : role === 'review' ? 'reviewed' : role === 'development' ? 'launched' : 'delivered';
      push({ ...base, kind: doneKind, title, revision: Boolean(record?.revision), text: { planned: 'CHIEF finished the plan', final: 'CHIEF delivered the final synthesis', reviewed: 'CHIEF finished the review', launched: `${label} took the engineering work — ${title}`, delivered: `${label} delivered${record?.revision ? ' the revision' : ''} — ${title}` }[doneKind] });
    } else if (event.type === 'task_failed' || event.type === 'agent_failed') push({ ...base, kind: 'failed', title, text: `${label} could not finish ${title}` });
    else if (event.type === 'handoff') {
      const to = recordById.get(event.payload?.to_task); const from = recordById.get(event.payload?.from_task);
      if (to && from && to.agentKey !== from.agentKey) push({ ...base, agentKey: from.agentKey, who: from.agentLabel, kind: 'handoff', fromKey: from.agentKey, toKey: to.agentKey, to: to.agentLabel, text: `${from.agentLabel} → ${to.agentLabel} handoff` });
    } else if (kind === 'provider_switch') {
      const from = parseRoute(event.payload?.fromProvider); const to = parseRoute(event.payload?.toProvider);
      const fromModel = shortModel(from.model) || from.provider; const toModel = shortModel(to.model) || to.provider; const reason = reasonWord(event.payload?.reason?.code);
      push({ ...base, kind: 'switch', from: fromModel, to: toModel, reason, text: `${label} switched model: ${fromModel} → ${toModel}${reason ? ` (${reason})` : ''}` });
    } else if (kind === 'revision_requested') {
      const revisionTask = [...recordById.values()].find((entry) => entry.revision && ms(entry.createdAt) >= ms(event.created_at) - 5000);
      push({ ...base, agentKey: 'chief', who: 'CHIEF', kind: 'revision', targetKey: revisionTask?.agentKey || null, target: revisionTask?.agentLabel || null, text: `CHIEF requested a revision from ${revisionTask?.agentLabel || 'the team'}` });
    } else if (kind === 'finance_validation') {
      const state = event.payload?.state; const issues = (event.payload?.issues || []).length;
      push({ ...base, kind: state === 'VERIFIED' ? 'verified' : 'returned', technical: state !== 'VERIFIED', count: issues, text: state === 'VERIFIED' ? 'FINANCE figures verified by code' : `FINANCE figures returned for correction (${issues} issue${issues === 1 ? '' : 's'})` });
    } else if (kind === 'capacity_wait_detail' || kind === 'capacity_wait') push({ ...base, kind: 'waiting', detail: String(event.message || '').replace(/^Waiting:\s*/, '').slice(0, 300), text: `${label} is waiting for model capacity` });
    else if (event.type === 'job_completed') push({ ...base, agentKey: 'chief', who: 'CHIEF', kind: 'completed', text: 'Objective completed' });
    else if (event.type === 'job_failed') push({ ...base, agentKey: 'chief', who: 'CHIEF', kind: 'stopped', text: 'The objective stopped before finishing' });
    else if (event.type === 'approval_requested') push({ ...base, kind: 'attention', text: `${label} needs Fahad’s approval` });
    else if (TECHNICAL.has(kind) || ['result_produced', 'status_changed', 'activity', 'task_created'].includes(event.type)) {
      const text = humanEvent(event, { labelOf: () => label });
      if (text) push({ ...base, kind: 'detail', technical: true, text: text.slice(0, 200) });
    }
  }
  return entries;
}

// ------------------------------------------------------------------ objective selection

// Current objective: the newest active one (real work first); else the most
// recent completed real objective. Old test objectives never become current.
export function objectiveIndex(jobs = [], { now = Date.now(), recentMs = 7 * 86400_000 } = {}) {
  const sorted = jobs.toSorted((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const brief = (job) => ({ id: job.id, title: job.title || String(job.goal || '').slice(0, 120), status: job.status, createdAt: job.created_at, completedAt: job.completed_at || null, test: isTestObjective(job), progress: null });
  const active = sorted.filter((job) => ACTIVE_JOB.has(job.status));
  const recent = sorted.filter((job) => !ACTIVE_JOB.has(job.status) && !isTestObjective(job) && now - (ms(job.completed_at || job.created_at) || 0) < recentMs);
  const current = active.find((job) => !isTestObjective(job)) || active[0] || recent[0] || null;
  return { currentId: current?.id || null, active: active.map(brief), recent: recent.slice(0, 12).map(brief) };
}

// ------------------------------------------------------------------ handler

async function rows(query) {
  const { data, error } = await query;
  if (error) throw Object.assign(new Error(`Could not load operations data: ${error.message}`), { statusCode: 500 });
  return data || [];
}
async function optional(query) {
  try { const { data, error } = await query; return error ? [] : data || []; } catch { return []; }
}
const uuid = (value, name) => { if (typeof value !== 'string' || !UUID_RE.test(value)) throw Object.assign(new Error(`${name} must be a UUID`), { statusCode: 400 }); return value; };

// GET /api/operations?workspaceId=…[&jobId=…]
export async function handleOperationsApi({ db, request, response, url, sendJson }) {
  if (url.pathname !== '/api/operations') return false;
  try {
    if (request.method !== 'GET') return sendJson(response, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }), true;
    const workspaceId = uuid(url.searchParams.get('workspaceId'), 'workspaceId');
    const since = new Date(Date.now() - 7 * 86400_000).toISOString();
    // Objectives CHIEF orchestrates (direct chats with one employee stay in their chat).
    const columns = 'id,title,goal,status,progress,free_only,conversation_id,created_at,completed_at';
    const [recent, open] = await Promise.all([
      rows(db.from('jobs').select(columns).eq('project_id', workspaceId).gte('created_at', since).order('created_at', { ascending: false }).limit(60)),
      rows(db.from('jobs').select(columns).eq('project_id', workspaceId).in('status', [...ACTIVE_JOB]).order('created_at', { ascending: false }).limit(20)),
    ]);
    const recentJobs = [...new Map([...open, ...recent].map((job) => [job.id, job])).values()];
    const index = objectiveIndex(recentJobs);
    const requested = url.searchParams.get('jobId');
    const jobId = requested ? uuid(requested, 'jobId') : index.currentId;
    if (!jobId) return sendJson(response, 200, { ok: true, objectives: index, view: null }), true;
    const [job] = await rows(db.from('jobs').select('id,title,goal,status,progress,free_only,cost_usd,conversation_id,project_id,created_at,completed_at').eq('id', jobId));
    if (!job || job.project_id !== workspaceId) return sendJson(response, 404, { ok: false, error: 'OBJECTIVE_NOT_FOUND' }), true;
    const [tasks, agents, results, handoffs, events, attempts, artifacts, officeApprovals] = await Promise.all([
      rows(db.from('tasks').select('id,job_id,agent_id,title,status,brief,depends_on,sequence,attempts,max_attempts,started_at,completed_at,created_at,not_before,wait_count,wait_info').eq('job_id', jobId)),
      rows(db.from('agents').select('id,slug,name')),
      rows(db.from('results').select('task_id,kind,summary,content,created_at').eq('job_id', jobId).order('created_at', { ascending: true })),
      rows(db.from('handoffs').select('id,from_agent_id,to_agent_id,from_task_id,to_task_id,summary,created_at').eq('job_id', jobId).order('created_at', { ascending: true })),
      rows(db.from('events').select('id,task_id,type,level,message,payload,created_at').eq('job_id', jobId).order('created_at', { ascending: true }).limit(600)),
      optional(db.from('model_attempts').select('task_id,provider,model,status,error_code,route,cost_usd,started_at,ended_at').eq('job_id', jobId).order('started_at', { ascending: true }).limit(400)),
      optional(db.from('artifacts').select('id,task_id,agent_slug,type,title,data,created_at').eq('job_id', jobId).order('created_at', { ascending: true }).limit(80)),
      optional(db.from('approvals').select('id,task_id,action_type,title,description,risk,status,created_at').eq('job_id', jobId).eq('status', 'pending')),
    ]);
    const sessionIds = events.filter((event) => event.payload?.kind === 'task_launched').map((event) => event.payload.session_id).filter(Boolean);
    const [sessions, approvals] = sessionIds.length ? await Promise.all([
      optional(db.from('agent_sessions').select('id,title,status,phase,error_code,blocker').in('id', sessionIds)),
      optional(db.from('agent_approvals').select('id,session_id,tool_name,summary,risk,status').in('session_id', sessionIds).eq('status', 'pending')),
    ]) : [[], []];
    const view = operationsView({ job, tasks, agents, results, handoffs, events, attempts, artifacts, approvals, officeApprovals, sessions });
    return sendJson(response, 200, { ok: true, objectives: index, view }), true;
  } catch (error) {
    return sendJson(response, error.statusCode || 500, { ok: false, error: String(error.message || 'Request failed').slice(0, 300) }), true;
  }
}
