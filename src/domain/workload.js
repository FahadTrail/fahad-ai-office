// Employee workload. One employee can hold many tasks across many projects.
// Availability is derived from current tasks only. A completed task never
// leaves the employee busy, and a new task never inherits the previous
// objective's status. Progress percentages are not computed.

import { ACTIVE_AGENTS, officeAgent } from '../office/agents.js';
import { classifyWork } from './classification.js';
import { briefOf, sessionLifecycle, taskExecution } from './lifecycle.js';

const AVAILABILITY = Object.freeze({
  executing: 'BUSY',
  needs_owner: 'NEEDS_OWNER',
  waiting: 'WAITING',
  assigned: 'ASSIGNED',
  queued: 'ASSIGNED',
});

const RANK = Object.freeze({ BUSY: 0, NEEDS_OWNER: 1, WAITING: 2, ASSIGNED: 3, AVAILABLE: 4 });

function employeeOf(agent) {
  const known = officeAgent(agent?.slug);
  if (!known || known.retired) return null;
  return { slug: known.slug, key: known.key, label: known.label, executor: known.executor };
}

function jobOf(jobs, id) {
  return jobs.find((job) => job.id === id) || null;
}

export function assignmentView(task, { job, agents, tasks, now }) {
  const agent = agents.find((row) => row.id === task.agent_id);
  const employee = employeeOf(agent);
  const execution = taskExecution(task, { job, tasks, now });
  const classification = job ? classifyWork(job, { open: execution.current }) : classifyWork(null);
  const brief = briefOf(task);
  return {
    taskId: task.id,
    jobId: job?.id || task.job_id || null,
    projectId: job?.project_id || null,
    title: task.title,
    objective: job?.title || (job?.goal ? String(job.goal).slice(0, 160) : null),
    employee,
    posture: execution.posture,
    category: execution.category,
    current: execution.current && classification.class !== 'TEST',
    testActivity: Boolean(execution.current && classification.class === 'TEST'),
    historical: execution.historical || !execution.current,
    reason: execution.reason,
    reasonBasis: execution.reasonBasis,
    wait: execution.wait,
    revision: Boolean(brief.revision),
    revisesTaskId: brief.revisesTaskId || null,
    stage: brief.stage || null,
    classification,
    startedAt: task.started_at || null,
    completedAt: task.completed_at || null,
  };
}

function tally(assignments) {
  const workload = { executing: 0, assigned: 0, queued: 0, waiting: 0, needsOwner: 0, projects: 0 };
  const projects = new Set();
  for (const assignment of assignments) {
    if (assignment.posture === 'executing') workload.executing += 1;
    else if (assignment.posture === 'assigned') workload.assigned += 1;
    else if (assignment.posture === 'queued') workload.queued += 1;
    else if (assignment.posture === 'waiting') workload.waiting += 1;
    else if (assignment.posture === 'needs_owner') workload.needsOwner += 1;
    if (assignment.projectId) projects.add(assignment.projectId);
  }
  workload.projects = projects.size;
  return workload;
}

function availabilityOf(assignments) {
  let availability = 'AVAILABLE';
  for (const assignment of assignments) {
    const next = AVAILABILITY[assignment.posture];
    if (next && RANK[next] < RANK[availability]) availability = next;
  }
  return availability;
}

function employeeRecord(employee, assignments, { completed = [] } = {}) {
  const real = assignments.filter((assignment) => assignment.current);
  const tests = assignments.filter((assignment) => assignment.testActivity);
  const realAvailability = availabilityOf(real);
  const testAvailability = availabilityOf(tests);
  return {
    slug: employee.slug,
    key: employee.key,
    label: employee.label,
    executor: employee.executor,
    availability: realAvailability,
    realAvailability,
    testAvailability: tests.length ? testAvailability : 'AVAILABLE',
    currentTasks: real,
    testTasks: tests,
    workload: tally(real),
    testWorkload: tally(tests),
    completedWork: {
      recent: completed,
      basis: 'SUPPLIED_ROWS',
      lifetime: 'UNKNOWN',
    },
  };
}

// `tasks` are the rows to consider (current graph and, separately, completed).
// Pass `completedTasks` for the history lane. They are never folded into current.
function applySession(view, session, approvals, now) {
  if (!session) return view;
  const life = sessionLifecycle(session, { approvals, now });
  if (!life || life.current) {
    if (life?.working) return { ...view, posture: 'executing', category: 'ACTIVE', current: view.classification?.class !== 'TEST', testActivity: view.classification?.class === 'TEST', historical: false };
    if (life?.category === 'NEEDS_OWNER') return { ...view, posture: 'needs_owner', category: 'NEEDS_OWNER', current: view.classification?.class !== 'TEST', testActivity: view.classification?.class === 'TEST', historical: false, reason: life.reason };
    if (life?.category === 'WAITING') return { ...view, posture: 'waiting', category: 'WAITING', current: view.classification?.class !== 'TEST', testActivity: view.classification?.class === 'TEST', historical: false, reason: life.reason };
    return view;
  }
  return {
    ...view,
    posture: life.category === 'FAILED' ? 'failed' : life.category === 'CANCELLED' ? 'closed' : 'completed',
    category: life.category,
    current: false,
    testActivity: false,
    historical: true,
    reason: life.reason,
    reasonBasis: life.reasonBasis,
  };
}

export function employeeWorkloads({ agents = [], jobs = [], tasks = [], completedTasks = [], sessions = [], approvals = [], now = Date.now() } = {}) {
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const tasksByJob = new Map();
  for (const task of [...tasks, ...completedTasks]) {
    const list = tasksByJob.get(task.job_id) || [];
    list.push(task);
    tasksByJob.set(task.job_id, list);
  }
  const sessionByTask = new Map(sessions.filter((session) => session.task_id).map((session) => [session.task_id, session]));
  const grouped = new Map(ACTIVE_AGENTS.map((agent) => [agent.slug, { employee: { slug: agent.slug, key: agent.key, label: agent.label, executor: agent.executor }, current: [], completed: [] }]));
  const seen = new Set();
  const consider = (task, bucket) => {
    if (seen.has(`${bucket}:${task.id}`)) return;
    seen.add(`${bucket}:${task.id}`);
    const job = jobsById.get(task.job_id) || null;
    const agent = agents.find((row) => row.id === task.agent_id);
    const employee = employeeOf(agent);
    if (!employee || !grouped.has(employee.slug)) return;
    const siblings = tasksByJob.get(task.job_id) || [task];
    const view = applySession(assignmentView(task, { job, agents, tasks: siblings, now }), sessionByTask.get(task.id), approvals, now);
    if (bucket === 'completed' || view.historical) grouped.get(employee.slug).completed.push(view);
    else grouped.get(employee.slug).current.push(view);
  };
  for (const task of tasks) consider(task, 'current');
  for (const task of completedTasks) consider(task, 'completed');
  return ACTIVE_AGENTS.map((agent) => {
    const group = grouped.get(agent.slug);
    const seenTask = new Set();
    const completed = group.completed.filter((assignment) => {
      if (!assignment.historical && !['completed', 'failed', 'closed'].includes(assignment.posture)) return false;
      if (seenTask.has(assignment.taskId)) return false;
      seenTask.add(assignment.taskId);
      return true;
    });
    return employeeRecord(group.employee, group.current, { completed });
  });
}

export function employeeWorkload(slug, input) {
  const employee = officeAgent(slug);
  if (!employee || employee.retired) return null;
  return employeeWorkloads(input).find((row) => row.slug === employee.slug || row.key === employee.key) || null;
}
