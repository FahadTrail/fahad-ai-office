// The Office presentation state: ONE adapter between the Hub's canonical
// Office data (/api/office + /api/artifacts, refreshed by the shared live
// stream) and every Office renderer — the light 2.5D floor and the immersive
// 3D scene. Renderers never query anything themselves.
//
//   officePresentationState = { employees, projects, handoffs, artifacts, needsFahad, summary }
//
// Pure: no DOM, no network — tested in Node.

export const ROSTER = Object.freeze(['chief', 'research', 'creative', 'product', 'finance', 'coding', 'audit', 'social', 'legal']);
const ACTIVE = new Set(['THINKING', 'WORKING', 'TESTING', 'REVIEWING']);
const FRESH_MS = 10 * 60_000;

// What the state chip says. Role wording only restates the real state
// (RESEARCH working = researching); waiting names who it waits for.
export function visualState(agent) {
  const state = agent?.state || 'AVAILABLE';
  if (state === 'WORKING') return agent.key === 'research' ? 'RESEARCHING' : agent.key === 'creative' ? 'DESIGNING' : 'WORKING';
  if (state === 'WAITING') {
    if (/free model capacity/i.test(agent.detail || '')) return 'WAITING';
    const match = String(agent.detail || '').match(/^Waiting for ([A-Z, ]+)$/);
    if (match) { const names = match[1].split(',').map((name) => name.trim()).filter(Boolean); return names.length === 1 ? `WAITING FOR ${names[0]}` : 'WAITING'; }
    return 'WAITING';
  }
  if (state === 'QUEUED') return 'UP NEXT';
  return state;
}

// The artifact each workspace may show: the employee's latest REAL artifact.
// FINANCE figures appear only when code validated them.
function workspaceArtifact(key, artifacts) {
  const own = artifacts.filter((artifact) => artifact.agent === key).toSorted((a, b) => String(b.at).localeCompare(String(a.at)));
  if (key !== 'finance') return own[0] || null;
  // FINANCE: a VERIFIED model, else a schedule chart drawn by the calculator,
  // else the latest model (drawn as "awaiting validated figures"). Charts
  // FINANCE drew by hand never appear.
  return own.find((artifact) => artifact.type === 'financial_model' && artifact.data?.validation?.state === 'VERIFIED')
    || own.find((artifact) => artifact.type === 'chart' && artifact.data?.calculated === true)
    || own.find((artifact) => artifact.type === 'financial_model') || null;
}

export function presentationState({ office = {}, artifacts = [], now = Date.now() } = {}) {
  const agents = Array.isArray(office.agents) ? office.agents : [];
  const byKey = new Map(agents.map((agent) => [agent.key, agent]));
  const workflows = Array.isArray(office.workflows) ? office.workflows : [];
  const employees = ROSTER.filter((key) => byKey.has(key)).map((key) => {
    const agent = byKey.get(key);
    const state = agent.state || 'AVAILABLE';
    const busy = state !== 'AVAILABLE';
    return {
      key, slug: agent.slug, label: agent.label, state, visual: visualState(agent),
      task: busy ? agent.assignment?.task || agent.task || null : null,
      objective: busy ? agent.assignment?.objective || null : null,
      jobId: agent.assignment?.jobId || null, sessionId: agent.assignment?.sessionId || null,
      conversationId: agent.assignment?.conversationId || null,
      detail: agent.detail || '', progress: busy && agent.progress != null ? agent.progress : null,
      resumesAt: agent.assignment?.resumesAt || null, deliverable: agent.deliverable || '', directChat: agent.directChat !== false,
      active: ACTIVE.has(state), needsFahad: state === 'NEEDS FAHAD',
      artifact: workspaceArtifact(key, artifacts),
      ...(key === 'coding' ? { coding: office.coding || null } : {}),
    };
  });
  const projects = workflows.map((flow) => ({
    id: flow.id, title: flow.title, status: flow.status, progress: flow.progress || 0,
    active: !['completed', 'failed', 'cancelled'].includes(flow.status),
    team: Array.isArray(flow.team) && flow.team.length ? flow.team
      : [...new Set(employees.filter((employee) => employee.jobId === flow.id).map((employee) => employee.key))],
    handoffs: (office.handoffs || []).filter((handoff) => handoff.jobId === flow.id).length,
  }));
  const handoffs = (Array.isArray(office.handoffs) ? office.handoffs : [])
    .filter((handoff) => byKey.has(handoff.fromKey) && byKey.has(handoff.toKey) && handoff.fromKey !== handoff.toKey)
    .map((handoff) => ({ ...handoff, fresh: now - Date.parse(handoff.at) < FRESH_MS }));
  const needsFahad = Number(office.needsFahad || 0) + employees.filter((employee) => employee.needsFahad && employee.key !== 'coding').length;
  return {
    employees, projects, handoffs, needsFahad,
    artifacts: Object.fromEntries(employees.filter((employee) => employee.artifact).map((employee) => [employee.key, employee.artifact])),
    summary: {
      working: employees.filter((employee) => employee.active).length,
      waiting: employees.filter((employee) => ['WAITING', 'QUEUED'].includes(employee.state)).length,
      completed: employees.filter((employee) => employee.state === 'COMPLETED').length,
      blocked: employees.filter((employee) => ['BLOCKED', 'FAILED'].includes(employee.state)).length,
      available: employees.filter((employee) => employee.state === 'AVAILABLE').length,
      activeProjects: projects.filter((project) => project.active).length,
      needsFahad,
    },
  };
}

// One sentence a screen reader (and Fahad) can use to understand the Office.
export function describeOffice(state) {
  const s = state.summary;
  const who = (predicate) => state.employees.filter(predicate).map((employee) => employee.label);
  const parts = [];
  const working = who((employee) => employee.active);
  parts.push(working.length ? `${working.join(', ')} ${working.length === 1 ? 'is' : 'are'} working` : 'Nobody is working right now');
  const waiting = who((employee) => ['WAITING', 'QUEUED'].includes(employee.state));
  if (waiting.length) parts.push(`${waiting.join(', ')} waiting`);
  const done = who((employee) => employee.state === 'COMPLETED');
  if (done.length) parts.push(`${done.join(', ')} just delivered`);
  if (s.needsFahad) parts.push(`${s.needsFahad} ${s.needsFahad === 1 ? 'item needs' : 'items need'} you`);
  return `${parts.join('; ')}.`;
}

// AUTO / IMMERSIVE / LIGHT → what to render. The immersive Office is a beta:
// AUTO keeps the light Office until the owner enables immersive for AUTO.
export function officeMode({ preference = 'auto', capability = {}, autoImmersive = false } = {}) {
  const capable = capability.webgl && !capability.weakGpu && !capability.small && !capability.coarse;
  if (preference === 'light') return { render: 'light', reason: 'You chose the light Office.' };
  if (preference === 'immersive') {
    if (!capability.webgl) return { render: 'light', reason: 'This browser cannot draw 3D (WebGL unavailable).' };
    if (capability.small) return { render: 'light', reason: 'The immersive Office needs a larger screen.' };
    return { render: 'immersive', quality: capability.weakGpu || capability.coarse ? 'light' : capability.reducedMotion ? 'balanced' : capability.strong ? 'high' : 'balanced' };
  }
  if (autoImmersive && capable && !capability.reducedMotion) return { render: 'immersive', quality: capability.strong ? 'high' : 'balanced' };
  return { render: 'light', reason: capable ? 'Light Office (the immersive Office is in beta).' : 'Light Office suits this device.' };
}
