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
