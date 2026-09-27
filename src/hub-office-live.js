// The living side of the Office API: the activity timeline, handoffs with
// their context, and the realtime change stream. Everything is derived from
// real rows (tasks, handoffs, artifacts, results, coding sessions, approvals);
// nothing is invented, and an entry exists only when its row does.

import { officeAgent } from './office/agents.js';
import { WAITING_MESSAGE } from './office/capacity.js';

const stageOf = (brief) => { try { return JSON.parse(brief)?.stage || null; } catch { return null; } };
const label = (agent) => officeAgent(agent?.slug)?.label || agent?.name || 'Agent';
const key = (agent) => officeAgent(agent?.slug)?.key || null;

// Human words for a task transition.
function taskEntries(task, { agent, job, byId }) {
  const who = label(agent);
  const stage = stageOf(task.brief);
  const base = { jobId: job.id, objective: job.title || job.goal, agent: who, agentKey: key(agent), taskId: task.id };
  if (stage === 'chief_plan') {
    return task.completed_at ? [{ ...base, at: task.completed_at, kind: 'plan', status: 'done', text: `${who} planned the work` }] : [];
  }
  if (stage === 'synthesis' || stage === 'chief_review') {
    const out = [];
    if (task.started_at) out.push({ ...base, at: task.started_at, kind: 'review', status: task.status === 'running' ? 'working' : 'done', text: `${who} started consolidating the team’s work` });
    if (task.status === 'done' && task.completed_at) out.push({ ...base, at: task.completed_at, kind: 'delivered', status: 'done', text: `${who} delivered the final result` });
    return out;
  }
  if (stage === 'consult') return [];
  const out = [];
  if (stage === 'launch_dev') {
    if (task.completed_at) out.push({ ...base, at: task.completed_at, kind: 'handoff', status: 'done', text: `${who} took the engineering work: ${task.title}` });
    return out;
  }
  if (task.started_at) out.push({ ...base, at: task.started_at, kind: 'start', status: 'working', text: `${who} started ${task.title}` });
  if (task.status === 'done' && task.completed_at) out.push({ ...base, at: task.completed_at, kind: 'delivered', status: 'done', text: `${who} delivered ${task.title}` });
  if (task.status === 'failed') out.push({ ...base, at: task.completed_at || task.started_at || task.created_at, kind: 'failed', status: 'failed', text: `${who} could not finish ${task.title}` });
  if (task.status === 'queued' && task.not_before && task.wait_count) {
    out.push({ ...base, at: task.wait_info?.deferred_at || task.started_at || task.created_at, kind: 'capacity', status: 'waiting', text: `${who}: ${WAITING_MESSAGE}`, resumesAt: task.not_before });
  }
  void byId;
  return out;
}

// Timeline of the Office, newest first. Filters: agent key, status, job id.
export function timelineView({ agents = [], jobs = [], tasks = [], handoffs = [], artifacts = [], sessions = [], approvals = [], filters = {}, limit = 60 }) {
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const agentBySlug = new Map(agents.map((agent) => [agent.slug, agent]));
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const entries = [];
  for (const job of jobs) {
    entries.push({ at: job.created_at, kind: 'objective', status: 'info', agent: 'FAHAD', agentKey: 'fahad', jobId: job.id, objective: job.title || job.goal, text: `Fahad asked: ${job.title || String(job.goal || '').slice(0, 120)}` });
    if (job.status === 'failed' && job.completed_at) entries.push({ at: job.completed_at, kind: 'failed', status: 'failed', agent: 'CHIEF', agentKey: 'chief', jobId: job.id, objective: job.title || job.goal, text: 'The objective stopped before finishing' });
  }
  for (const task of tasks) {
    const job = jobById.get(task.job_id);
    if (!job) continue;
    entries.push(...taskEntries(task, { agent: agentById.get(task.agent_id), job, byId }));
  }
  for (const handoff of handoffs) {
    const job = jobById.get(handoff.job_id);
    const [from, to] = [agentById.get(handoff.from_agent_id), agentById.get(handoff.to_agent_id)];
    const toTask = byId.get(handoff.to_task_id);
    if (!job || !from || !to || from.id === to.id) continue;
    entries.push({ at: handoff.created_at, kind: 'handoff', status: 'info', agent: label(from), agentKey: key(from), to: label(to), toKey: key(to), jobId: job.id, objective: job.title || job.goal,
      text: `${label(from)} handed ${toTask?.title ? `“${toTask.title}”` : 'work'} to ${label(to)}` });
  }
  for (const artifact of artifacts) {
    const agent = agentBySlug.get(artifact.agent_slug);
    entries.push({ at: artifact.created_at, kind: 'artifact', status: 'done', agent: label(agent || { slug: artifact.agent_slug }), agentKey: key(agent || { slug: artifact.agent_slug }),
      jobId: artifact.job_id, objective: jobById.get(artifact.job_id)?.title || null, artifactId: artifact.id, text: `${label(agent || { slug: artifact.agent_slug })} produced ${artifact.title || artifact.type}` });
  }
  for (const session of sessions) {
    const base = { agent: 'CODING', agentKey: 'coding', sessionId: session.id, jobId: session.job_id || null, objective: session.title };
    entries.push({ ...base, at: session.created_at, kind: 'start', status: 'working', text: `CODING started ${session.title}` });
    const pr = session.result?.pr;
    if (pr?.url) entries.push({ ...base, at: session.result?.ci?.checkedAt || session.updated_at, kind: 'pr', status: 'done', text: `CODING opened pull request #${pr.number || ''}`.trim(), link: pr.url });
    if (session.result?.ci?.state) entries.push({ ...base, at: session.result.ci.checkedAt || session.updated_at, kind: 'ci', status: session.result.ci.state === 'success' ? 'done' : 'failed', text: `CI ${session.result.ci.state === 'success' ? 'passed' : 'failed'} for ${session.title}` });
    if (session.status === 'completed' && session.completed_at) entries.push({ ...base, at: session.completed_at, kind: 'delivered', status: 'done', text: `CODING finished ${session.title}` });
    if (session.status === 'failed') entries.push({ ...base, at: session.completed_at || session.updated_at, kind: 'failed', status: 'failed', text: `CODING could not finish ${session.title}` });
    if (session.status === 'blocked' && session.error_code === 'HUMAN_INPUT_REQUIRED') entries.push({ ...base, at: session.updated_at, kind: 'attention', status: 'attention', text: `CODING has a question for you: ${session.title}` });
  }
  for (const approval of approvals) {
    if (approval.status !== 'pending') continue;
    entries.push({ at: approval.requested_at, kind: 'attention', status: 'attention', agent: 'CODING', agentKey: 'coding', sessionId: approval.session_id, text: `Needs your approval: ${String(approval.summary || approval.tool_name).slice(0, 160)}` });
  }
  const wanted = (entry) => (!filters.agent || entry.agentKey === filters.agent || entry.toKey === filters.agent)
    && (!filters.status || entry.status === filters.status) && (!filters.job || entry.jobId === filters.job);
  return entries.filter((entry) => entry.at && wanted(entry))
    .toSorted((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit);
}

// A handoff with what it carried: from, to, objective, the task handed over
// and its current state, and the latest artifact the sender produced for it.
export function handoffView(handoff, { agentById, jobById, taskById, artifactsByTask, now = Date.now() }) {
  const [from, to] = [agentById.get(handoff.from_agent_id), agentById.get(handoff.to_agent_id)];
  const job = jobById.get(handoff.job_id);
  const toTask = taskById.get(handoff.to_task_id);
  const fromTask = taskById.get(handoff.from_task_id);
  const artifact = (artifactsByTask.get(handoff.from_task_id) || []).at(-1) || null;
  const status = !toTask ? 'unknown' : toTask.status === 'done' ? 'delivered' : toTask.status === 'running' ? 'in progress'
    : toTask.status === 'failed' ? 'failed' : toTask.not_before && Date.parse(toTask.not_before) > now ? 'waiting for capacity' : 'queued';
  return {
    id: handoff.id || `${handoff.from_task_id}>${handoff.to_task_id}`,
    from: label(from), fromKey: key(from), to: label(to), toKey: key(to),
    jobId: handoff.job_id, objective: job?.title || job?.goal || null,
    fromTask: fromTask?.title || null, task: toTask?.title || null, status,
    artifact: artifact ? { id: artifact.id, title: artifact.title, type: artifact.type } : null,
    at: handoff.created_at,
  };
}

// ------------------------------------------------------------------ realtime
// One cheap server-side watermark per workspace, shared by every open page:
// when it changes, connected pages are told to refresh (no per-page polling).
const WATCH_MS = 2500;
const HEARTBEAT_MS = 25_000;

export class OfficeStream {
  constructor({ db, now = () => Date.now(), watchMs = WATCH_MS }) {
    Object.assign(this, { db, now, watchMs });
    this.rooms = new Map();
  }

  async watermark(workspaceId) {
    const [events, sessions, approvals, artifacts] = await Promise.all([
      this.db.from('events').select('id').order('id', { ascending: false }).limit(1),
      this.db.from('agent_sessions').select('updated_at').eq('workspace_id', workspaceId).order('updated_at', { ascending: false }).limit(1),
      this.db.from('agent_approvals').select('id,status').eq('workspace_id', workspaceId).eq('status', 'pending'),
      this.db.from('artifacts').select('id').eq('project_id', workspaceId).order('created_at', { ascending: false }).limit(1),
    ]);
    return [events.data?.[0]?.id, sessions.data?.[0]?.updated_at, (approvals.data || []).map((row) => row.id).join(','), artifacts.data?.[0]?.id].join('|');
  }

  subscribe(workspaceId, response) {
    let room = this.rooms.get(workspaceId);
    if (!room) {
      room = { clients: new Set(), mark: null, timer: null };
      this.rooms.set(workspaceId, room);
      const tick = async () => {
        try {
          const mark = await this.watermark(workspaceId);
          if (room.mark !== null && mark !== room.mark) for (const client of room.clients) client.write(`event: change\ndata: ${JSON.stringify({ at: new Date(this.now()).toISOString() })}\n\n`);
          room.mark = mark;
        } catch {}
      };
      tick();
      room.timer = setInterval(tick, this.watchMs);
      room.timer.unref?.();
    }
    room.clients.add(response);
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' });
    response.write(`retry: 5000\nevent: ready\ndata: {}\n\n`);
    const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), HEARTBEAT_MS);
    heartbeat.unref?.();
    const close = () => {
      clearInterval(heartbeat);
      room.clients.delete(response);
      if (!room.clients.size) { clearInterval(room.timer); this.rooms.delete(workspaceId); }
    };
    response.on('close', close);
    return close;
  }

  stop() {
    for (const room of this.rooms.values()) { clearInterval(room.timer); for (const client of room.clients) client.end(); }
    this.rooms.clear();
  }
}
