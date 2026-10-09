// Authoritative objective summary. A future screen can render this without
// replaying the event log. The CHIEF workflow itself is unchanged.

import { officeAgent } from '../office/agents.js';
import { classifyWork } from './classification.js';
import { briefOf, isTerminalCategory, jobLifecycle, taskExecution } from './lifecycle.js';

const STEP_ORDER = Object.freeze(['plan', 'delegate', 'assign', 'depend', 'deliver', 'review', 'revise', 'synthesize', 'close']);

function agentLabel(agents, agentId) {
  const row = agents.find((agent) => agent.id === agentId);
  const employee = officeAgent(row?.slug);
  return employee ? { slug: employee.slug, key: employee.key, label: employee.label } : null;
}

function stepState(done, current) {
  if (current) return 'current';
  if (done) return 'done';
  return 'waiting';
}

export function orchestrationOf({ job, tasks = [], agents = [] }) {
  const life = jobLifecycle(job, { tasks });
  const briefs = tasks.map((task) => ({ task, brief: briefOf(task), execution: taskExecution(task, { job, tasks }) }));
  const plans = briefs.filter((entry) => entry.brief.stage === 'chief_plan');
  const work = briefs.filter((entry) => ['specialist', 'research', 'launch_dev', 'consult'].includes(entry.brief.stage) && !entry.brief.revision);
  const revisions = briefs.filter((entry) => entry.brief.revision);
  const syntheses = briefs.filter((entry) => entry.brief.stage === 'synthesis' || entry.brief.stage === 'chief_review');
  const revisionRound = revisions.reduce((max, entry) => Math.max(max, Number(entry.brief.round || 1)), 0);
  const closed = isTerminalCategory(life?.category);
  const planDone = plans.some((entry) => entry.execution.historical);
  const planCurrent = plans.some((entry) => entry.execution.current);
  const delegated = work.length > 0;
  const delivering = work.some((entry) => entry.execution.posture === 'executing');
  const delivered = work.length > 0 && work.every((entry) => entry.execution.historical);
  const revising = revisions.some((entry) => entry.execution.current);
  const revised = revisions.length > 0 && revisions.every((entry) => entry.execution.historical);
  const synthesizing = syntheses.some((entry) => entry.execution.current);
  const synthesized = syntheses.some((entry) => entry.execution.historical);
  const steps = [
    { id: 'plan', state: stepState(planDone, planCurrent) },
    { id: 'delegate', state: stepState(delegated, !delegated && planDone && life?.current) },
    { id: 'assign', state: stepState(work.some((entry) => entry.task.agent_id), delivering) },
    { id: 'depend', state: work.some((entry) => entry.execution.reason === 'dependency') ? 'current' : stepState(delivered || delivering, false) },
    { id: 'deliver', state: stepState(delivered, delivering) },
    { id: 'review', state: stepState(synthesized, synthesizing) },
    { id: 'revise', state: revisions.length ? stepState(revised, revising) : 'skipped' },
    { id: 'synthesize', state: stepState(synthesized, synthesizing) },
    { id: 'close', state: closed ? 'done' : 'waiting' },
  ];
  return {
    objectiveId: job?.id || null,
    steps,
    order: STEP_ORDER,
    revisionRound: revisions.length ? revisionRound || 1 : 0,
    participants: [...new Map(work.map((entry) => {
      const employee = agentLabel(agents, entry.task.agent_id);
      return employee ? [employee.slug, employee] : null;
    }).filter(Boolean)).values()],
    currentAssignments: briefs.filter((entry) => entry.execution.current).map((entry) => ({
      taskId: entry.task.id,
      title: entry.task.title,
      employee: agentLabel(agents, entry.task.agent_id),
      posture: entry.execution.posture,
      stage: entry.brief.stage || null,
      revision: Boolean(entry.brief.revision),
    })),
    closed,
  };
}

export function nextActionOf({ job, tasks = [], agents = [], sessions = [], approvals = [], now = Date.now() }) {
  const life = jobLifecycle(job, { tasks, approvals, sessions, now });
  if (!life) return null;
  if ((life.category === 'COMPLETED' || life.category === 'CANCELLED') && !life.ownerAttention.length) return null;
  if ((life.category === 'COMPLETED' || life.category === 'CANCELLED') && life.ownerAttention.length) {
    return { code: 'OWNER_REVIEW', owner: 'fahad', text: life.ownerAttention[0].title, basis: 'RECORDED', taskId: life.ownerAttention[0].taskId || null, sessionId: life.ownerAttention[0].sessionId || null };
  }
  if (life.category === 'FAILED') {
    return {
      code: life.ownerAttention.length ? 'OWNER_REVIEW' : 'REVIEW_FAILURE',
      owner: 'fahad',
      text: life.reason || 'This objective failed. No failure reason was recorded.',
      basis: life.reasonBasis || 'UNKNOWN',
      taskId: null,
    };
  }
  if (life.category === 'NEEDS_OWNER') {
    const item = life.ownerAttention[0];
    return { code: item?.kind === 'question' ? 'ANSWER' : 'APPROVE', owner: 'fahad', text: item?.title || 'Fahad needs to act before this continues.', basis: 'RECORDED', taskId: item?.taskId || null, sessionId: item?.sessionId || null };
  }
  if (life.category === 'WAITING') {
    const wait = life.waiting[0];
    if (life.reason === 'capacity' || wait?.reason === 'capacity') {
      return { code: 'WAIT_CAPACITY', owner: null, text: wait?.detail || 'Waiting for model capacity. This is not an approval.', basis: 'RECORDED', resumesAt: wait?.resumesAt || null, taskId: wait?.taskId || null };
    }
    if (wait?.reason === 'dependency') {
      const names = (wait.dependsOn || []).map((id) => tasks.find((task) => task.id === id)).map((task) => agentLabel(agents, task?.agent_id)?.label || task?.title).filter(Boolean);
      return { code: 'WAIT_DEPENDENCY', owner: null, text: names.length ? `Waiting for ${[...new Set(names)].join(', ')}.` : 'Waiting for an earlier task.', basis: 'RECORDED', taskId: wait.taskId };
    }
    return { code: 'WAIT', owner: null, text: 'Waiting. No owner action is required.', basis: life.reasonBasis || 'UNKNOWN', taskId: wait?.taskId || null };
  }
  const running = tasks.find((task) => ['running', 'handoff', 'review'].includes(task.status));
  if (running) {
    const employee = agentLabel(agents, running.agent_id);
    return { code: 'IN_PROGRESS', owner: employee?.key || null, text: `${employee?.label || 'An employee'} is working on ${running.title}.`, basis: 'RECORDED', taskId: running.id };
  }
  const ready = tasks.find((task) => taskExecution(task, { job, tasks, now }).posture === 'assigned' || taskExecution(task, { job, tasks, now }).posture === 'queued');
  if (job.status === 'planning' && !ready) return { code: 'PLAN', owner: 'chief', text: 'CHIEF is planning this objective.', basis: 'RECORDED', taskId: null };
  if (ready) {
    const employee = agentLabel(agents, ready.agent_id);
    return { code: 'SCHEDULED', owner: employee?.key || 'chief', text: `${employee?.label || 'CHIEF'} is scheduled to ${ready.title}.`, basis: 'RECORDED', taskId: ready.id };
  }
  return { code: 'PLAN', owner: 'chief', text: 'CHIEF is planning this objective.', basis: 'RECORDED', taskId: null };
}

export function objectiveSummary({ job, tasks = [], agents = [], results = [], sessions = [], approvals = [], now = Date.now() } = {}) {
  if (!job) return null;
  const life = jobLifecycle(job, { tasks, approvals, sessions, now });
  const classification = classifyWork(job, { open: life.current });
  const orchestration = orchestrationOf({ job, tasks, agents });
  const final = results.find((result) => result.kind === 'final') || null;
  return {
    id: job.id,
    projectId: job.project_id || null,
    conversationId: job.conversation_id || null,
    title: job.title || String(job.goal || '').slice(0, 160),
    goal: job.goal || null,
    status: job.status,
    lifecycle: life.category,
    lane: life.lane,
    current: life.current,
    history: life.history,
    ownerAttention: life.ownerAttention,
    classification,
    nextAction: nextActionOf({ job, tasks, agents, sessions, approvals, now }),
    orchestration,
    counts: {
      executing: orchestration.currentAssignments.filter((row) => row.posture === 'executing').length,
      assigned: orchestration.currentAssignments.filter((row) => row.posture === 'assigned' || row.posture === 'queued').length,
      waiting: tasks.filter((task) => taskExecution(task, { job, tasks, now }).posture === 'waiting').length,
      needsOwner: life.ownerAttention.length,
    },
    finalDeliverableId: final?.id || null,
    openedAt: job.created_at || null,
    closedAt: job.completed_at || null,
    progress: Number.isInteger(job.progress) ? job.progress : null,
    progressBasis: Number.isInteger(job.progress) ? 'RECORDED' : 'NOT_REPORTED',
  };
}
