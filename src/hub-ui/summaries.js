// One human sentence at the top of each screen (V5.1: simple outside,
// powerful inside). Pure functions over data the page already loaded —
// no extra requests, no invented facts. Tested in Node.

const ACTIVE = new Set(['THINKING', 'WORKING', 'TESTING', 'REVIEWING']);
const list = (names) => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

export function employeesSummary(agents = []) {
  const working = agents.filter((agent) => ACTIVE.has(agent.state)).map((agent) => agent.label);
  const waiting = agents.filter((agent) => ['WAITING', 'QUEUED'].includes(agent.state)).length;
  const needs = agents.filter((agent) => agent.state === 'NEEDS FAHAD').map((agent) => agent.label);
  if (!working.length && !waiting && !needs.length) return 'Everyone is available — tell CHIEF what you need.';
  const parts = [];
  parts.push(working.length ? `${list(working)} ${working.length === 1 ? 'is' : 'are'} working` : 'Nobody is working right now');
  if (waiting) parts.push(`${plural(waiting, 'employee is', 'employees are')} waiting`);
  if (needs.length) parts.push(`${list(needs)} ${needs.length === 1 ? 'needs' : 'need'} you`);
  return `${parts.join('; ')}.`;
}

export function attentionSummary(items = []) {
  const urgent = items.filter((item) => item.priority === 'URGENT').length;
  const action = items.filter((item) => item.priority === 'ACTION NEEDED').length;
  if (!urgent && !action) return 'Nothing needs you right now.';
  const parts = [];
  if (urgent) parts.push(`${urgent} urgent`);
  if (action) parts.push(`${action} waiting for a decision or an answer`);
  return `${plural(urgent + action, 'thing needs', 'things need')} you: ${parts.join(', ')}.`;
}

export function tasksSummary(tasks = [], tab = 'running') {
  if (!tasks.length) return tab === 'running' ? 'No development task is running.' : 'Nothing in this group.';
  const latest = tasks[0]?.title ? ` The latest is “${tasks[0].title}”.` : '';
  const words = { running: 'running', attention: 'waiting for you', completed: 'completed', failed: 'failed', cancelled: 'cancelled' };
  return `${plural(tasks.length, 'task', 'tasks')} ${words[tab] || ''}.${latest}`.replace(' .', '.');
}

export function projectsSummary(workspaces = [], currentId = null) {
  const current = workspaces.find((workspace) => workspace.id === currentId);
  return `${plural(workspaces.length, 'project', 'projects')}${current ? `; you are in ${current.name}` : ''}.`;
}

// V5.1 (continued): the remaining major screens.
export function artifactsSummary(artifacts = []) {
  if (!artifacts.length) return 'No deliverables yet — they appear here as the Office finishes work.';
  const latest = artifacts[0];
  return `${plural(artifacts.length, 'deliverable', 'deliverables')}; the latest is “${latest.title}”${latest.agentLabel ? ` from ${latest.agentLabel}` : ''}.`;
}

// Integrations: "connected" means a real successful use was recorded.
export function integrationsSummary(states = []) {
  if (!states.length) return 'No integrations reported yet.';
  const connected = states.filter((state) => state === 'CONNECTED').length;
  const account = states.filter((state) => state === 'ACCOUNT ACTION REQUIRED').length;
  return `${connected} of ${states.length} tools connected${account ? `; ${plural(account, 'needs', 'need')} an account action from you` : ''}.`;
}

export function modelsSummary(counts = {}, waiting = 0) {
  const available = counts.AVAILABLE || 0;
  const cooling = counts.COOLDOWN || 0;
  const parts = [available ? `${plural(available, 'model is', 'models are')} available now` : 'No model is available right now'];
  if (cooling) parts.push(`${cooling} resting until their limits reset`);
  if (waiting) parts.push(`${plural(waiting, 'employee is', 'employees are')} waiting for free capacity and will resume automatically`);
  return `${parts.join('; ')}.`;
}

export function chatsSummary(conversations = [], archived = false) {
  if (!conversations.length) return archived ? 'No archived chats.' : 'No chats yet — start one with CHIEF.';
  return `${plural(conversations.length, archived ? 'archived chat' : 'chat', archived ? 'archived chats' : 'chats')}; the latest is “${conversations[0].title}”.`;
}
