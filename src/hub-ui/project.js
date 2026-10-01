// Project Command Center — the executive view of one project, and its visual
// project map. Loaded on demand. Every number, state, summary and decision
// comes from /api/command-center (real rows); empty sections say so.
import { roleMark } from './characters.js?v=__UI_VERSION__';

const STATUS_TONE = { 'NEEDS FAHAD': 'needs', 'AT RISK': 'blocked', 'IN PROGRESS': 'working', 'UP TO DATE': 'completed', 'NO ACTIVITY': 'available' };
const NODE_STATE = { done: ['COMPLETED', 'Done'], working: ['WORKING', 'Working'], waiting: ['WAITING', 'Waiting'], ready: ['QUEUED', 'Up next'], failed: ['FAILED', 'Failed'], blocked: ['BLOCKED', 'Blocked'], capacity: ['WAITING', 'Waiting for free capacity'] };
const MEMORY_HELP = {
  fact: 'Something true about the project', decision: 'A decision already taken', preference: 'How Fahad likes things done', constraint: 'A limit the Office must respect',
  product_decision: 'Scope, features, priorities', technical_decision: 'Stack, architecture, hosting', brand_decision: 'Names, colours, tone',
  legal_requirement: 'A rule the project must follow', financial_assumption: 'A number the plans rely on',
};

let styles = null;
function ensureStyles() {
  if (styles) return styles;
  styles = new Promise((resolve) => {
    const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: './ui/project.css?v=__UI_VERSION__' });
    link.onload = resolve; link.onerror = resolve;
    document.head.append(link);
  });
  return styles;
}

export async function renderProject(ctx, id, mode = 'center') {
  const { api, esc, q, view, setTitle } = ctx;
  await ensureStyles();
  const [{ project, memory }, center] = await Promise.all([api(`/api/projects/${id}`), api(`/api/command-center${q({ workspaceId: id })}`)]);
  setTitle(project.name);
  const tone = STATUS_TONE[center.status] || 'available';
  view.innerHTML = `<div class="cc">
    <header class="cc-hero">
      <div class="cc-hero-main">
        <div class="cc-eyebrow"><span class="cc-status cc-${tone}">${esc(center.status)}</span>${center.project.repository ? `<span class="cc-repo mono">${esc(center.project.repository)}</span>` : ''}</div>
        <h1 dir="auto">${esc(project.name)}</h1>
        ${project.description ? `<p class="cc-desc" dir="auto">${esc(project.description)}</p>` : ''}
      </div>
      <div class="cc-ring" style="--p:${center.progress}" role="img" aria-label="Overall progress ${center.progress}%"><svg viewBox="0 0 120 120" aria-hidden="true"><circle class="ring-bg" cx="60" cy="60" r="52"/><circle class="ring-fg" cx="60" cy="60" r="52" pathLength="100" stroke-dasharray="${center.progress} 100"/></svg><div><strong class="num">${center.progress}%</strong><span>overall</span></div></div>
    </header>
    <div class="cc-switch">
      <div class="cc-tabs" role="tablist" aria-label="View">
        <a role="tab" href="#/project/${esc(id)}" aria-selected="${mode === 'center'}">Command Center</a>
        <a role="tab" href="#/project/${esc(id)}/map" aria-selected="${mode === 'map'}">Project map</a>
      </div>
      ${id !== ctx.ws() ? '<button class="btn btn-sm" type="button" id="useProject">Switch to this project</button>' : ''}
    </div>
    <div id="ccBody"></div>
  </div>`;
  const body = view.querySelector('#ccBody');
  if (mode === 'map') await drawMap(ctx, body, center);
  else drawCenter(ctx, body, center, project, memory, id);
  const use = view.querySelector('#useProject');
  if (use) use.onclick = () => { const select = document.querySelector('#projectSelect'); select.value = id; select.onchange(); };
  ctx.onChange(async () => { if (location.hash.startsWith(`#/project/${id}`)) renderProject(ctx, id, mode).catch(() => {}); });
}

function drawCenter(ctx, body, center, project, memory, id) {
  const { esc, when, usd, renderArtifact } = ctx;
  const verdict = center.latestAudit?.verdict;
  body.innerHTML = `
    ${center.summary ? `<section class="cc-summary" aria-label="CHIEF summary">${roleMark('chief', 'CHIEF')}<div><div class="cc-label">CHIEF · latest summary <time datetime="${esc(center.summary.at)}">${esc(when(center.summary.at))}</time></div>
      <p dir="auto">${esc(center.summary.text)}</p>${center.summary.jobId ? `<a class="small" href="#/workflow/${esc(center.summary.jobId)}">Open the full result</a>` : ''}</div></section>`
      : '<section class="cc-summary cc-empty">' + roleMark('chief', 'CHIEF') + '<div><div class="cc-label">CHIEF</div><p>No objective finished in this project yet. Ask CHIEF to start one.</p></div></section>'}
    <section class="cc-kpis" aria-label="Key figures">
      <a class="kpi" href="#/project/${esc(id)}/map"><span>Objectives in progress</span><strong class="num">${center.objectives.active.length}</strong><em>${center.objectives.completed} completed · ${center.objectives.failed} stopped (30 days)</em></a>
      <a class="kpi ${center.needsFahad ? 'kpi-alert' : ''}" href="#/attention"><span>Needs Fahad</span><strong class="num">${center.needsFahad}</strong><em>${center.needsFahad ? 'Open Needs Fahad' : 'Nothing waiting'}</em></a>
      <div class="kpi"><span>Latest audit</span><strong>${verdict ? `<span class="verdict v-${esc(verdict.replace(/\s+/g, '-').toLowerCase())}">${esc(verdict)}</span>` : '<span class="muted">—</span>'}</strong><em>${center.latestAudit ? esc(when(center.latestAudit.at)) : 'No audit yet'}</em></div>
      <div class="kpi"><span>AI cost · 30 days</span><strong class="num">${esc(usd(center.costUsd))}</strong><em>Free routes first</em></div>
    </section>
    <section aria-label="Team"><h2 class="cc-h2">Team</h2><div class="cc-team">${center.roster.map((member) => `<button type="button" class="member" data-employee="${esc(member.slug)}" data-state="${esc(member.state)}">
      <span class="member-top">${roleMark(member.key, member.label)}<span class="member-name">${esc(member.label)}</span></span>
      <span class="state-chip" data-state="${esc(member.state)}">${esc(stateWord(member))}</span>
      <span class="member-task" dir="auto">${esc(member.task || (member.state === 'AVAILABLE' ? 'Available' : member.detail || ''))}</span>
      ${member.progress != null ? `<span class="progress" role="progressbar" aria-label="${esc(member.label)} objective progress" aria-valuenow="${member.progress}" aria-valuemin="0" aria-valuemax="100"><span style="width:${Math.max(3, member.progress)}%"></span></span>` : ''}
      ${member.latest ? `<span class="member-latest" dir="auto"><span class="xs faint">Latest result</span> ${esc(member.latest.summary)}</span>` : '<span class="member-latest xs faint">No result in this project yet</span>'}
      ${member.artifact ? `<span class="member-artifact" dir="auto">◧ ${esc(member.artifact.title || member.artifact.type)}</span>` : ''}</button>`).join('')}</div></section>
    <div class="cc-cols">
      <div class="cc-col">
        <section class="cc-card"><h2 class="cc-h2">Needs Fahad</h2><div id="ccNeeds" class="muted small">Loading…</div></section>
        <section class="cc-card"><h2 class="cc-h2">Next actions</h2>${center.nextActions.length ? `<ol class="cc-actions">${center.nextActions.map((action) => `<li dir="auto">${esc(action.text)}${action.owner ? ` <span class="tag muted">${esc(action.owner)}</span>` : ''}</li>`).join('')}</ol>` : '<p class="muted small">CHIEF lists next actions at the end of each objective.</p>'}</section>
        <section class="cc-card"><h2 class="cc-h2">Decisions</h2>
          ${center.decisionsForFahad.length ? `<div class="cc-sub">Waiting for your decision</div>${center.decisionsForFahad.map((decision) => `<div class="decision decision-open"><span class="xs faint">${esc(decision.from)}</span><div dir="auto">${esc(decision.text)}</div></div>`).join('')}` : ''}
          ${center.memory.decisions.length ? `<div class="cc-sub">Already decided</div>${center.memory.decisions.map((item) => `<div class="decision"><span class="xs faint">${esc(ctx.memoryLabel(item.kind))}</span><div dir="auto">${esc(item.content)}</div></div>`).join('')}` : ''}
          ${!center.decisionsForFahad.length && !center.memory.decisions.length ? '<p class="muted small">No decisions recorded yet.</p>' : ''}</section>
      </div>
      <div class="cc-col">
        <section class="cc-card"><h2 class="cc-h2">Risks</h2>${center.risks.length ? center.risks.map((risk) => `<div class="risk sev-${esc(risk.severity)}"><span class="risk-sev">${esc(risk.severity)}</span><div><div dir="auto">${esc(risk.text)}</div><div class="xs faint">${esc(risk.from || '')}${risk.owner ? ` → owner ${esc(risk.owner)}` : ''}</div></div></div>`).join('') : '<p class="muted small">No high risks from AUDIT, LEGAL or a risk matrix.</p>'}</section>
        <section class="cc-card"><h2 class="cc-h2">Timeline</h2><ol class="cc-timeline">${center.timeline.map((entry) => `<li class="t-${esc(entry.status)}"><time class="num" datetime="${esc(entry.at)}">${esc(new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</time><span dir="auto">${esc(entry.text)}</span></li>`).join('') || '<li class="muted small">No activity in the last 30 days.</li>'}</ol></section>
        <section class="cc-card"><h2 class="cc-h2">Handoffs</h2>${center.handoffs.length ? center.handoffs.slice(0, 6).map((handoff) => `<a class="cc-handoff" href="#/workflow/${esc(handoff.jobId)}">${roleMark(handoff.fromKey, handoff.from)}<span class="arrow" aria-hidden="true">→</span>${roleMark(handoff.toKey, handoff.to)}<span class="grow"><strong>${esc(handoff.from)} → ${esc(handoff.to)}</strong><span class="block small muted" dir="auto">${esc(handoff.task || '')}</span></span><span class="xs faint">${esc(handoff.status)}</span></a>`).join('') : '<p class="muted small">No handoffs yet.</p>'}</section>
      </div>
    </div>
    <section class="cc-card"><div class="spread"><h2 class="cc-h2">Artifacts</h2><a class="small" href="#/artifacts">Open the library</a></div>${center.artifacts.length ? `<div class="cc-artifacts">${center.artifacts.slice(0, 4).map(renderArtifact).join('')}</div>` : '<p class="muted small">Deliverables (tables, charts, boards, matrices) appear here.</p>'}</section>
    <details class="cc-card cc-settings"><summary><h2 class="cc-h2">Project memory &amp; context</h2><span class="small muted">${memory.length} item${memory.length === 1 ? '' : 's'} the Office reuses</span></summary>
      <form id="projectForm" class="cc-form"><label class="field-label" for="pDesc">What this project is (CHIEF reads this)</label><textarea id="pDesc" class="input" rows="3" dir="auto">${esc(project.description)}</textarea>
        <label class="field-label" for="pRepo">Default repository for engineering tasks</label><input id="pRepo" class="input" value="${esc(project.defaultRepository)}" placeholder="owner/name">
        <div class="row"><button class="btn btn-primary btn-sm" type="submit">Save context</button></div></form>
      <div class="memory">${ctx.memoryKinds.map(([kind, label]) => { const items = memory.filter((item) => item.kind === kind); return `<div class="memory-group"><div class="memory-head"><strong>${esc(label)}</strong><span class="xs faint">${esc(MEMORY_HELP[kind] || '')}</span></div>
        ${items.map((item) => `<div class="memory-item" data-memory="${esc(item.id)}"><span class="grow" dir="auto">${esc(item.content)}</span><span class="xs faint">${item.source === 'owner' ? 'You' : 'Office'}</span>
          <button class="btn btn-ghost btn-sm" type="button" data-edit="${esc(item.id)}">Edit</button><button class="btn btn-ghost btn-sm" type="button" data-forget="${esc(item.id)}">Remove</button></div>`).join('') || '<div class="xs faint memory-none">Nothing saved.</div>'}</div>`; }).join('')}</div>
      <form class="row memory-add" id="memoryForm"><label class="sr-only" for="mKind">Type</label><select id="mKind" class="input input-sm">${ctx.memoryKinds.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select>
        <label class="sr-only" for="mText">Memory</label><input id="mText" class="input input-sm grow" dir="auto" placeholder="e.g. The pilot runs in Business Bay"><button class="btn btn-sm" type="submit">Add</button></form></details>`;

  body.querySelectorAll('[data-employee]').forEach((element) => { element.onclick = () => ctx.openEmployee(element.dataset.employee); });
  ctx.api(`/api/attention${ctx.q({ workspaceId: id })}`).then(({ items }) => {
    const actions = items.filter((item) => item.priority !== 'INFO');
    const holder = body.querySelector('#ccNeeds');
    if (holder) holder.innerHTML = actions.length ? actions.map((item) => `<a class="need need-${esc(item.kind)}" href="${item.taskId ? `#/task/${esc(item.taskId)}` : item.jobId ? `#/workflow/${esc(item.jobId)}` : `#/chat/${esc(item.conversationId || '')}`}"><span class="need-kind">${esc(item.category || item.kind)}${item.priority === 'URGENT' ? ' · URGENT' : ''}</span><span dir="auto">${esc(item.title)}</span><span class="xs faint" dir="auto">${esc(item.detail || '')}</span></a>`).join('') : '<p class="muted small">Nothing needs you in this project.</p>';
  }).catch(() => {});
  body.querySelector('#projectForm').onsubmit = async (event) => {
    event.preventDefault();
    try { await ctx.api(`/api/projects/${id}`, { method: 'PATCH', body: { description: body.querySelector('#pDesc').value, defaultRepository: body.querySelector('#pRepo').value } }); ctx.toast('Saved'); } catch (error) { ctx.toast(error.message); }
  };
  body.querySelector('#memoryForm').onsubmit = async (event) => {
    event.preventDefault();
    try { await ctx.api(`/api/projects/${id}/memory`, { method: 'POST', body: { kind: body.querySelector('#mKind').value, content: body.querySelector('#mText').value } }); renderProject(ctx, id).then(() => document.querySelector('.cc-settings')?.setAttribute('open', '')); } catch (error) { ctx.toast(error.message); }
  };
  body.querySelectorAll('[data-forget]').forEach((button) => { button.onclick = async () => {
    if (!(await ctx.confirmDialog('Remove this memory?', 'The Office stops using it in new chats and tasks.'))) return;
    await ctx.api(`/api/projects/${id}/memory/${button.dataset.forget}`, { method: 'DELETE' });
    renderProject(ctx, id).then(() => document.querySelector('.cc-settings')?.setAttribute('open', ''));
  }; });
  body.querySelectorAll('[data-edit]').forEach((button) => { button.onclick = async () => {
    const current = memory.find((item) => item.id === button.dataset.edit);
    const content = await ctx.ask('Edit memory', current?.content || '');
    if (!content || content === current?.content) return;
    try { await ctx.api(`/api/projects/${id}/memory/${button.dataset.edit}`, { method: 'PATCH', body: { content } }); renderProject(ctx, id).then(() => document.querySelector('.cc-settings')?.setAttribute('open', '')); } catch (error) { ctx.toast(error.message); }
  }; });
}

function stateWord(member) {
  if (member.state === 'WAITING' && /^Waiting for ([A-Z]+)$/.test(member.detail || '')) return `Waiting for ${member.detail.slice(12)}`;
  if (member.state === 'WAITING' && /capacity/i.test(member.detail || '')) return 'Waiting · capacity';
  return member.state === 'QUEUED' ? 'Up next' : member.state.charAt(0) + member.state.slice(1).toLowerCase();
}

// ------------------------------------------------------------------ project map
// Fahad → CHIEF → workstreams (by dependency depth) → CHIEF → Fahad, drawn from
// the real task graph of the project's active (or latest) objective.
async function drawMap(ctx, body, center) {
  const { api, esc, when } = ctx;
  if (!center.activeJobId) { body.innerHTML = '<div class="cc-card"><p class="muted">No objective in this project yet. Ask CHIEF to start one; its team and handoffs will appear here as a map.</p></div>'; return; }
  const flow = await api(`/api/workflows/${center.activeJobId}`);
  const streams = flow.nodes.filter((node) => !['plan', 'synthesis', 'conversation', 'consult'].includes(node.kind));
  const plan = flow.nodes.find((node) => node.kind === 'plan');
  const synthesis = flow.nodes.filter((node) => node.kind === 'synthesis').at(-1);
  const byId = new Map(streams.map((node) => [node.id, node]));
  const depth = new Map();
  const level = (node, seen = new Set()) => {
    if (depth.has(node.id)) return depth.get(node.id);
    if (seen.has(node.id)) return 0;
    seen.add(node.id);
    const deps = node.dependsOn.map((dep) => byId.get(dep)).filter(Boolean);
    const value = deps.length ? 1 + Math.max(...deps.map((dep) => level(dep, seen))) : 0;
    depth.set(node.id, value);
    return value;
  };
  streams.forEach((node) => level(node));
  const columns = [];
  for (const node of streams) (columns[depth.get(node.id)] ||= []).push(node);
  const card = (node, extra = '') => {
    const [state, word] = NODE_STATE[node.state] || ['QUEUED', node.state];
    return `<button type="button" class="map-node ${extra}" data-node="${esc(node.id)}" data-state="${esc(state)}" data-slug="${esc(node.agentSlug || '')}">
      <span class="map-top">${roleMark(node.agent, node.agentLabel)}<strong>${esc(node.agentLabel)}</strong></span>
      <span class="map-task" dir="auto">${esc(node.title)}</span><span class="state-chip" data-state="${esc(state)}">${esc(word)}</span></button>`;
  };
  const endpoint = (label, sub, done) => `<div class="map-node map-end" data-state="${done ? 'COMPLETED' : 'QUEUED'}"><span class="map-top"><span class="fahad-mark" aria-hidden="true">F</span><strong>${label}</strong></span><span class="map-task">${sub}</span></div>`;
  body.innerHTML = `<section class="cc-card map-card"><div class="spread"><div><h2 class="cc-h2">Project map</h2><p class="small muted" dir="auto">${esc(flow.job.title)} · ${esc(flow.job.status === 'completed' ? 'completed' : flow.job.status === 'failed' ? 'stopped' : `${flow.job.progress}% done`)} · started ${esc(when(flow.job.createdAt))}</p></div>
      <a class="btn btn-sm" href="#/workflow/${esc(flow.job.id)}">Open outputs</a></div>
    <div class="map" id="map"><svg class="map-links" id="mapLinks" aria-hidden="true"></svg>
      <div class="map-col">${endpoint('FAHAD', 'Gave the objective', true)}</div>
      <div class="map-col">${plan ? card({ ...plan, agent: 'chief', agentLabel: 'CHIEF', title: 'Plans and dispatches' }, 'map-chief') : ''}</div>
      ${columns.map((column) => `<div class="map-col">${column.map((node) => card(node)).join('')}</div>`).join('')}
      <div class="map-col">${synthesis ? card({ ...synthesis, agent: 'chief', agentLabel: 'CHIEF', title: 'Consolidates one result' }, 'map-chief') : ''}</div>
      <div class="map-col">${endpoint('FAHAD', flow.final ? 'Received the result' : 'Receives the result', Boolean(flow.final))}</div>
    </div>
    <div class="map-legend small muted">Lines are real dependencies: a card starts when the cards before it deliver. Click a card to open that employee.</div></section>`;
  const map = body.querySelector('#map');
  const svg = body.querySelector('#mapLinks');
  const link = () => {
    const box = map.getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
    const point = (element, side) => { const rect = element.getBoundingClientRect(); return [rect.left - box.left + rect.width / 2, side === 'bottom' ? rect.bottom - box.top : rect.top - box.top]; };
    const nodeEl = (id) => map.querySelector(`[data-node="${CSS.escape(id)}"]`);
    const pairs = [];
    const cols = [...map.querySelectorAll('.map-col')];
    const first = cols[0]?.querySelector('.map-node');
    const planEl = plan ? nodeEl(plan.id) : null;
    const synthEl = synthesis ? nodeEl(synthesis.id) : null;
    const lastEnd = cols.at(-1)?.querySelector('.map-node');
    if (first && planEl) pairs.push([first, planEl, true]);
    for (const node of streams) {
      const target = nodeEl(node.id);
      const deps = node.dependsOn.map((dep) => byId.get(dep)).filter(Boolean);
      if (!deps.length && planEl) pairs.push([planEl, target, plan.state === 'done']);
      for (const dep of deps) pairs.push([nodeEl(dep.id), target, dep.state === 'done']);
    }
    const dependedOn = new Set(streams.flatMap((node) => node.dependsOn));
    for (const node of streams) if (!dependedOn.has(node.id) && synthEl) pairs.push([nodeEl(node.id), synthEl, node.state === 'done']);
    if (synthEl && lastEnd) pairs.push([synthEl, lastEnd, Boolean(flow.final)]);
    svg.innerHTML = pairs.filter(([a, b]) => a && b).map(([a, b, done]) => {
      const [x1, y1] = point(a, 'bottom'); const [x2, y2] = point(b, 'top');
      const mid = (y1 + y2) / 2;
      return `<path class="${done ? 'done' : 'pending'}" d="M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}"/>`;
    }).join('');
  };
  if (window.innerWidth > 900) { requestAnimationFrame(link); window.addEventListener('resize', link); ctx.onLeave(() => window.removeEventListener('resize', link)); }
  map.querySelectorAll('[data-slug]').forEach((element) => { if (element.dataset.slug) element.onclick = () => ctx.openEmployee(element.dataset.slug); });
}
