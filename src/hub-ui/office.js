// The Live Office — loaded on demand (its script, styles and art never load
// on other routes). Every station, state, handoff and timeline entry comes
// from the Hub API, which derives them from real rows; nothing moves unless
// the work behind it is real.
import { roleMark, stationArt } from './characters.js?v=__UI_VERSION__';

const FLOOR = [
  ['research', 'product', 'coding'],
  ['creative', 'chief', 'finance'],
  ['social', 'legal', 'audit'],
];
const ACTIVE = new Set(['THINKING', 'WORKING', 'TESTING', 'REVIEWING']);
const STATUS_TONE = { info: 'info', working: 'working', done: 'done', waiting: 'waiting', attention: 'attention', failed: 'failed' };
const seenHandoffs = new Set();

let stylesheet = null;
export function ensureOfficeStyles() {
  if (stylesheet) return stylesheet;
  stylesheet = new Promise((resolve) => {
    const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: './ui/office.css?v=__UI_VERSION__' });
    link.onload = resolve; link.onerror = resolve;
    document.head.append(link);
  });
  return stylesheet;
}

// What the chip says. Role-specific wording only restates the real state
// (RESEARCH working = researching); waiting names who it waits for.
export function visualState(agent) {
  const state = agent.state || 'AVAILABLE';
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
const stateWord = (value) => value.charAt(0) + value.slice(1).toLowerCase();

export async function renderOffice(ctx) {
  const { api, esc, when, q, ws, view, setTitle, onChange, every, toast } = ctx;
  await ensureOfficeStyles();
  setTitle('Office');
  const filters = { agent: '', status: '', job: '' };
  view.innerHTML = `<div class="office" data-motion="${ctx.reducedMotion() ? 'reduced' : 'full'}">
    <header class="office-head">
      <div><h1>The Office</h1><p class="office-live"><span class="live-dot" id="liveDot" aria-hidden="true"></span><span id="liveText">Live — every state comes from real work</span></p></div>
      <form class="ask-chief" id="askChief"><label class="sr-only" for="askChiefInput">Ask CHIEF</label>
        <input id="askChiefInput" class="input" dir="auto" autocomplete="off" placeholder="Ask CHIEF… e.g. «خل Legal يراجع»"><button class="btn btn-primary" type="submit">Send</button></form>
    </header>
    <div class="office-stats" id="officeStats" aria-live="polite"></div>
    <div class="office-body">
      <section class="scene" id="scene" aria-label="Office floor"><div class="floor" id="floor"><svg class="handoff-layer" id="handoffLayer" aria-hidden="true"></svg><div class="stations" id="stations"></div></div>
        <div class="scene-legend" aria-hidden="true"><span><i class="lg lg-working"></i>Working</span><span><i class="lg lg-waiting"></i>Waiting</span><span><i class="lg lg-needs"></i>Needs you</span><span><i class="lg lg-done"></i>Just delivered</span><span><i class="lg lg-handoff"></i>Handoff</span></div>
      </section>
      <aside class="office-side">
        <div id="officeNeeds"></div>
        <section class="side-card"><h2 class="side-title">Objectives</h2><div id="officeObjectives"></div></section>
        <section class="side-card timeline-card"><div class="side-head"><h2 class="side-title">Timeline</h2>
          <div class="tl-filters"><label class="sr-only" for="tlAgent">Employee</label><select id="tlAgent" class="input input-sm"><option value="">Everyone</option></select>
          <label class="sr-only" for="tlStatus">Status</label><select id="tlStatus" class="input input-sm"><option value="">Any status</option><option value="working">Started</option><option value="done">Delivered</option><option value="waiting">Waiting</option><option value="attention">Needs you</option><option value="failed">Failed</option><option value="info">Handoffs &amp; requests</option></select>
          <label class="sr-only" for="tlJob">Objective</label><select id="tlJob" class="input input-sm"><option value="">All objectives</option></select></div></div>
          <ol class="tl-list" id="timeline" aria-live="polite"></ol></section>
      </aside>
    </div>
  </div>`;

  const askForm = view.querySelector('#askChief');
  askForm.onsubmit = async (event) => {
    event.preventDefault();
    const input = view.querySelector('#askChiefInput');
    const message = input.value.trim();
    if (!message) return;
    try {
      const created = await api('/api/conversations', { method: 'POST', body: { workspaceId: ws(), message } });
      location.hash = `#/chat/${created.conversation.id}`;
    } catch (error) { toast(error.message); }
  };

  let data = null;
  let signature = '';
  const load = async () => {
    const next = await api(`/api/office${q({ workspaceId: ws() })}`);
    const nextSignature = JSON.stringify(next);
    if (nextSignature === signature) return;
    signature = nextSignature;
    data = next;
    drawStats(); drawStations(); drawSide(); drawHandoffs();
  };

  const drawStats = () => {
    const working = data.agents.filter((agent) => ACTIVE.has(agent.state)).length;
    const waiting = data.agents.filter((agent) => ['WAITING', 'QUEUED'].includes(agent.state)).length;
    const available = data.agents.filter((agent) => agent.state === 'AVAILABLE').length;
    const objectives = data.workflows.filter((flow) => !['completed', 'failed', 'cancelled'].includes(flow.status)).length;
    view.querySelector('#officeStats').innerHTML = [
      ['working', working, 'working now'], ['waiting', waiting, 'waiting'], ['needs', data.needsFahad, data.needsFahad === 1 ? 'needs you' : 'need you'],
      ['objectives', objectives, objectives === 1 ? 'objective in progress' : 'objectives in progress'], ['available', available, 'available'],
    ].map(([tone, value, text]) => `<div class="stat stat-${tone}"><strong class="num">${value}</strong><span>${text}</span></div>`).join('');
  };

  const drawStations = () => {
    const byKey = new Map(data.agents.map((agent) => [agent.key, agent]));
    const stations = view.querySelector('#stations');
    stations.innerHTML = FLOOR.flat().map((key) => {
      const agent = byKey.get(key);
      if (!agent) return '';
      const visual = visualState(agent);
      const task = agent.assignment?.task && agent.state !== 'AVAILABLE' ? agent.assignment.task : null;
      const objective = agent.assignment?.objective && agent.state !== 'AVAILABLE' ? agent.assignment.objective : null;
      const resumes = agent.assignment?.resumesAt ? new Date(agent.assignment.resumesAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
      const detail = agent.state === 'AVAILABLE' ? 'Available for work' : resumes ? `Waiting for free model capacity — resumes automatically ~${resumes}` : agent.detail || '';
      return `<button class="station" type="button" data-key="${esc(key)}" data-state="${esc(agent.state || 'AVAILABLE')}" style="--agent:${esc(agent.color || 'var(--accent)')}; grid-area:${esc(key)}"
        aria-label="${esc(`${agent.label}: ${stateWord(visual)}${task ? ` — ${task}` : ''}. Open workspace`)}">
        <span class="station-halo" aria-hidden="true"></span>
        ${stationArt(key, agent.label)}
        <span class="plate">
          <span class="plate-top">${roleMark(key, agent.label)}<span class="plate-name">${esc(agent.label)}</span>${agent.progress != null && agent.state !== 'AVAILABLE' ? `<span class="plate-pct num">${agent.progress}%</span>` : ''}</span>
          <span class="state-chip" data-state="${esc(agent.state || 'AVAILABLE')}">${esc(stateWord(visual))}</span>
          <span class="plate-task" dir="auto">${esc(task || detail)}</span>
          ${objective ? `<span class="plate-meta" dir="auto">${esc(objective)}</span>` : `<span class="plate-meta">${esc(agent.deliverable || '')}</span>`}
          ${agent.recentArtifact ? `<span class="plate-artifact" dir="auto">◧ ${esc(agent.recentArtifact.title || agent.recentArtifact.type)}</span>` : ''}
          ${task && detail && detail !== `Working on ${task}` ? `<span class="plate-detail" dir="auto">${esc(detail)}</span>` : ''}
        </span></button>`;
    }).join('');
    stations.querySelectorAll('.station').forEach((element) => { element.onclick = () => openEmployee(ctx, byKey.get(element.dataset.key).slug); });
  };

  const drawSide = () => {
    view.querySelector('#officeNeeds').innerHTML = data.needsFahad
      ? `<a class="needs-banner" href="#/attention"><span class="needs-dot" aria-hidden="true"></span><span><strong>${data.needsFahad} ${data.needsFahad === 1 ? 'item needs' : 'items need'} you</strong><br><span class="small">Open Needs Fahad</span></span></a>` : '';
    view.querySelector('#officeObjectives').innerHTML = data.workflows.length ? data.workflows.map((flow) => `<a class="objective" href="#/workflow/${esc(flow.id)}">
      <span class="objective-title" dir="auto">${esc(flow.title)}</span>
      <span class="progress" role="progressbar" aria-valuenow="${flow.progress}" aria-valuemin="0" aria-valuemax="100" aria-label="Progress"><span style="width:${Math.max(3, flow.progress)}%"></span></span>
      <span class="objective-meta">${esc(flow.status === 'completed' ? 'Completed' : flow.status === 'failed' ? 'Stopped' : 'In progress')} · <span class="num">${flow.progress}%</span> · ${esc(when(flow.createdAt))}</span></a>`).join('')
      : '<p class="muted small">No multi-employee objective this week. Ask CHIEF above.</p>';
    const agentSelect = view.querySelector('#tlAgent');
    if (agentSelect.options.length === 1) agentSelect.insertAdjacentHTML('beforeend', `<option value="fahad">FAHAD</option>${data.agents.map((agent) => `<option value="${esc(agent.key)}">${esc(agent.label)}</option>`).join('')}`);
    const jobSelect = view.querySelector('#tlJob');
    const known = new Set([...jobSelect.options].map((option) => option.value));
    for (const flow of data.workflows) if (!known.has(flow.id)) jobSelect.insertAdjacentHTML('beforeend', `<option value="${esc(flow.id)}">${esc(flow.title)}</option>`);
    drawTimeline(filters.agent || filters.status || filters.job ? null : data.timeline);
  };

  const drawTimeline = async (preset) => {
    const entries = preset || (await api(`/api/timeline${q({ workspaceId: ws(), ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) })}`)).entries;
    const list = view.querySelector('#timeline');
    if (!list) return;
    let day = '';
    list.innerHTML = entries.length ? entries.map((entry) => {
      const date = new Date(entry.at);
      const label = date.toDateString() === new Date().toDateString() ? 'Today' : date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      const header = label !== day ? `<li class="tl-day">${esc((day = label))}</li>` : '';
      const href = entry.sessionId ? `#/task/${entry.sessionId}` : entry.jobId ? `#/workflow/${entry.jobId}` : '#/office';
      return `${header}<li class="tl-item tl-${STATUS_TONE[entry.status] || 'info'}"><a href="${esc(href)}">
        <time class="tl-time num" datetime="${esc(entry.at)}">${esc(date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</time>
        <span class="tl-dot" aria-hidden="true"></span><span class="tl-text"><span dir="auto">${esc(entry.text)}</span>${entry.objective && entry.kind !== 'objective' ? `<span class="tl-obj" dir="auto">${esc(entry.objective)}</span>` : ''}</span></a></li>`;
    }).join('') : '<li class="muted small tl-empty">Nothing matches these filters in the last 7 days.</li>';
  };
  for (const [id, keyName] of [['#tlAgent', 'agent'], ['#tlStatus', 'status'], ['#tlJob', 'job']]) {
    view.querySelector(id).onchange = (event) => { filters[keyName] = event.target.value; drawTimeline(filters.agent || filters.status || filters.job ? null : data.timeline).catch(() => {}); };
  }

  // Handoffs of the last 24 h are drawn between desks; a handoff younger
  // than 10 minutes carries a light once. Each line opens its details.
  const drawHandoffs = () => {
    const svg = view.querySelector('#handoffLayer');
    const stations = view.querySelector('#stations');
    if (!svg || !stations || window.innerWidth < 900) { if (svg) svg.innerHTML = ''; return; }
    svg.setAttribute('viewBox', `0 0 ${stations.offsetWidth} ${stations.offsetHeight}`);
    // Layout (untransformed) coordinates: the art sits centred at the top of
    // its station with a fixed 280 × 170 aspect, at most 300 px wide.
    const anchor = (key) => {
      const station = stations.querySelector(`.station[data-key="${key}"]`);
      if (!station) return null;
      const width = Math.min(station.clientWidth - 16, 300);
      return [station.offsetLeft + station.offsetWidth / 2, station.offsetTop + 8 + (width * 170 / 280) * 0.55];
    };
    const reduced = ctx.reducedMotion();
    const unique = new Map();
    for (const handoff of data.handoffs) { const pair = `${handoff.fromKey}>${handoff.toKey}`; if (!unique.has(pair)) unique.set(pair, handoff); }
    svg.innerHTML = [...unique.values()].map((handoff, index) => {
      const [from, to] = [anchor(handoff.fromKey), anchor(handoff.toKey)];
      if (!from || !to) return '';
      const [mx, my] = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
      const [dx, dy] = [to[0] - from[0], to[1] - from[1]];
      const length = Math.hypot(dx, dy) || 1;
      const bend = Math.min(60, length * 0.18);
      const path = `M${from[0]},${from[1]} Q${mx - (dy / length) * bend},${my + (dx / length) * bend} ${to[0]},${to[1]}`;
      const fresh = Date.now() - Date.parse(handoff.at) < 10 * 60_000;
      const key = `${handoff.id}@${handoff.at}`;
      const travel = fresh && !seenHandoffs.has(key) && !reduced;
      seenHandoffs.add(key);
      return `<g class="handoff ${fresh ? 'handoff-fresh' : ''}" data-index="${index}" tabindex="0" role="button" aria-label="${esc(`${handoff.from} to ${handoff.to}: ${handoff.task || 'handoff'}`)}">
        <path class="handoff-hit" d="${path}"/><path class="handoff-line" d="${path}"/>
        ${travel ? `<circle class="handoff-packet" r="5"><animateMotion dur="1.8s" fill="freeze" path="${path}" keyTimes="0;1" keySplines=".2 .8 .2 1" calcMode="spline"/></circle>` : ''}</g>`;
    }).join('');
    const list = [...unique.values()];
    svg.querySelectorAll('.handoff').forEach((element) => {
      const open = () => openHandoff(ctx, list[Number(element.dataset.index)]);
      element.onclick = open;
      element.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } };
    });
  };

  // Gentle depth: the floor follows the pointer a few degrees (desktop,
  // fine pointer, motion allowed).
  const scene = view.querySelector('#scene');
  if (!ctx.reducedMotion() && window.matchMedia?.('(pointer: fine)').matches) {
    scene.onpointermove = (event) => {
      const box = scene.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width - 0.5;
      const y = (event.clientY - box.top) / box.height - 0.5;
      scene.style.setProperty('--ry', `${(x * 3).toFixed(2)}deg`);
      scene.style.setProperty('--rx', `${(-y * 2).toFixed(2)}deg`);
    };
    scene.onpointerleave = () => { scene.style.setProperty('--ry', '0deg'); scene.style.setProperty('--rx', '0deg'); };
  }
  const resize = () => drawHandoffs();
  window.addEventListener('resize', resize);
  ctx.onLeave(() => window.removeEventListener('resize', resize));

  await load();
  const setLive = (live) => {
    const dot = view.querySelector('#liveDot');
    if (dot) dot.classList.toggle('off', !live);
    const text = view.querySelector('#liveText');
    if (text) text.textContent = live ? 'Live — every state comes from real work' : 'Reconnecting… showing the latest known state';
  };
  onChange(() => load().catch(() => {}), setLive);
  every(30_000, () => load().catch(() => {}));
}

// ------------------------------------------------------------------ handoff
export function openHandoff(ctx, handoff) {
  const { esc, when } = ctx;
  const body = `<dl class="handoff-detail">
    <div><dt>From</dt><dd>${roleMark(handoff.fromKey, handoff.from)} ${esc(handoff.from)}</dd></div>
    <div><dt>To</dt><dd>${roleMark(handoff.toKey, handoff.to)} ${esc(handoff.to)}</dd></div>
    <div><dt>Objective</dt><dd dir="auto">${esc(handoff.objective || '—')}</dd></div>
    <div><dt>Handed over</dt><dd dir="auto">${esc(handoff.task || '—')}</dd></div>
    <div><dt>Artifact</dt><dd dir="auto">${handoff.artifact ? `<a href="#/artifacts/${esc(handoff.artifact.type)}">◧ ${esc(handoff.artifact.title || handoff.artifact.type)}</a>` : 'None attached'}</dd></div>
    <div><dt>Status</dt><dd><span class="state-chip" data-state="${esc(handoff.status === 'delivered' ? 'COMPLETED' : handoff.status === 'in progress' ? 'WORKING' : handoff.status === 'failed' ? 'FAILED' : 'WAITING')}">${esc(handoff.status)}</span></dd></div>
    <div><dt>Time</dt><dd><time datetime="${esc(handoff.at)}">${esc(when(handoff.at))}</time></dd></div></dl>
    ${handoff.jobId ? `<a class="btn btn-primary btn-block" href="#/workflow/${esc(handoff.jobId)}">Open the workflow</a>` : ''}`;
  sheet(ctx, { title: `${handoff.from} → ${handoff.to}`, body, size: 'sm' });
}

// ------------------------------------------------------------------ employee workspace
export async function openEmployee(ctx, slug) {
  const { api, esc, q, ws, when } = ctx;
  await ensureOfficeStyles();
  const panel = sheet(ctx, { title: 'Loading…', body: '<div class="drawer-loading" aria-busy="true"></div>', size: 'lg' });
  try {
    const [data, artifacts, capabilities] = await Promise.all([
      api(`/api/agents/${slug}${q({ workspaceId: ws() })}`),
      api(`/api/artifacts${q({ workspaceId: ws(), agent: slug })}`).then((result) => result.artifacts).catch(() => []),
      ctx.capabilities().catch(() => []),
    ]);
    const agent = data.agent;
    const state = data.state || { state: 'AVAILABLE' };
    const visual = visualState({ ...state, key: agent.key });
    const statusOf = new Map(capabilities.map((item) => [item.id, item]));
    const tabs = [['now', 'Now'], ['artifacts', `Artifacts (${artifacts.length})`], ['handoffs', `Handoffs (${data.handoffs?.length || 0})`], ['history', 'History'], ...(agent.directChat ? [['chats', 'Conversations']] : []), ['tools', 'Tools']];
    const chat = agent.executor === 'coding'
      ? '<a class="btn btn-primary" href="#/code">Give CODING a task</a>'
      : agent.executor === 'chief' ? '<a class="btn btn-primary" href="#/">Ask CHIEF</a>'
        : `<form class="drawer-chat" id="drawerChat"><label class="sr-only" for="drawerChatInput">Message ${esc(agent.label)}</label><input id="drawerChatInput" class="input" dir="auto" placeholder="Talk to ${esc(agent.label)} directly…"><button class="btn btn-primary" type="submit">Send</button></form>`;
    panel.set(`${agent.label}`, `
      <div class="drawer-head" style="--agent:${esc(agent.color || 'var(--accent)')}">
        <div class="drawer-art" data-state="${esc(state.state)}">${stationArt(agent.key, agent.label)}</div>
        <div class="drawer-id"><div class="drawer-role">${esc(agent.tagline || agent.deliverable || '')}</div>
          <div class="row"><span class="state-chip" data-state="${esc(state.state)}">${esc(stateWord(visual))}</span>${agent.nameAr ? `<span class="small muted" dir="rtl" lang="ar">${esc(agent.nameAr)}</span>` : ''}</div>
          <p class="small muted">${esc(agent.scope)}</p>${chat}</div>
      </div>
      <div class="tabs" role="tablist">${tabs.map(([id, text], index) => `<button role="tab" type="button" class="tab" id="tab-${id}" aria-controls="pane-${id}" aria-selected="${index === 0}" data-tab="${id}">${esc(text)}</button>`).join('')}</div>
      <section class="pane" id="pane-now" role="tabpanel" aria-labelledby="tab-now">
        ${state.assignment ? `<div class="now-card"><div class="xs faint">CURRENT ${state.assignment.sessionId ? 'TASK' : 'PROJECT'}</div>
          <a class="now-title" dir="auto" href="${state.assignment.jobId ? `#/workflow/${esc(state.assignment.jobId)}` : `#/task/${esc(state.assignment.sessionId)}`}">${esc(state.assignment.objective)}</a>
          <div class="small" dir="auto">${esc(state.assignment.task || '')}</div>${state.detail && state.detail !== `Working on ${state.assignment.task}` ? `<div class="small muted" dir="auto">${esc(state.detail)}</div>` : ''}
          ${data.progress != null ? `<span class="progress" role="progressbar" aria-valuenow="${data.progress}" aria-valuemin="0" aria-valuemax="100" aria-label="Objective progress"><span style="width:${Math.max(3, data.progress)}%"></span></span><div class="xs faint num">${data.progress}% of the objective</div>` : ''}
          ${state.assignment.resumesAt ? `<div class="small capacity-note">Resumes automatically around ${esc(new Date(state.assignment.resumesAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</div>` : ''}</div>`
          : '<div class="now-card"><div class="now-title">Available</div><p class="small muted">No task assigned right now.</p></div>'}
        ${data.attention?.length ? `<h3 class="pane-title">Needs attention</h3>${data.attention.map((item) => `<a class="attention-row attention-${esc(item.kind)}" href="${item.sessionId ? `#/task/${esc(item.sessionId)}` : item.jobId ? `#/workflow/${esc(item.jobId)}` : '#/attention'}">${esc(item.text)}</a>`).join('')}` : ''}
        ${data.codingSessions?.length ? `<h3 class="pane-title">Engineering tasks</h3>${data.codingSessions.map((session) => `<a class="list-row" href="#/task/${esc(session.id)}"><span class="grow" dir="auto">${esc(session.title)}</span><span class="xs faint">${esc(session.status)}${session.ci ? ` · CI ${esc(session.ci)}` : ''}</span></a>`).join('')}` : ''}
      </section>
      <section class="pane" id="pane-artifacts" role="tabpanel" aria-labelledby="tab-artifacts" hidden>${artifacts.length ? `<div class="drawer-artifacts">${artifacts.slice(0, 8).map((artifact) => ctx.renderArtifact(artifact)).join('')}</div><a class="btn btn-ghost btn-sm" href="#/artifacts">Open the artifact library</a>` : '<p class="muted small">No artifacts yet. Visual deliverables appear here.</p>'}</section>
      <section class="pane" id="pane-handoffs" role="tabpanel" aria-labelledby="tab-handoffs" hidden>${data.handoffs?.length ? data.handoffs.map((handoff, index) => `<button type="button" class="list-row handoff-row" data-handoff="${index}"><span class="grow"><strong>${esc(handoff.from)}</strong> → <strong>${esc(handoff.to)}</strong><span class="small muted" dir="auto"> ${esc(handoff.task || '')}</span></span><span class="xs faint">${esc(when(handoff.at))}</span></button>`).join('') : '<p class="muted small">No handoffs in the last 30 days.</p>'}</section>
      <section class="pane" id="pane-history" role="tabpanel" aria-labelledby="tab-history" hidden>${data.recent.length ? data.recent.map((item) => `<a class="list-row" href="#/workflow/${esc(item.jobId)}"><span class="grow"><span dir="auto">${esc(item.title)}</span><span class="small muted" dir="auto"> — ${esc(item.objective)}</span>${item.summary ? `<span class="block small" dir="auto">${esc(item.summary)}</span>` : ''}</span><span class="xs faint">${esc(item.status)} · ${esc(when(item.at))}</span></a>`).join('') : '<p class="muted small">No work in the last 30 days.</p>'}</section>
      ${agent.directChat ? `<section class="pane" id="pane-chats" role="tabpanel" aria-labelledby="tab-chats" hidden>${data.conversations.length ? data.conversations.map((conversation) => `<a class="list-row" href="#/chat/${esc(conversation.id)}"><span class="grow" dir="auto">${esc(conversation.title)}</span><span class="xs faint">${esc(when(conversation.lastMessageAt))}</span></a>`).join('') : '<p class="muted small">No direct conversations yet.</p>'}</section>` : ''}
      <section class="pane" id="pane-tools" role="tabpanel" aria-labelledby="tab-tools" hidden>
        <div class="tool-grid">${(data.integrations || []).map((id) => { const item = statusOf.get(id); return `<div class="tool"><span class="tool-name">${esc(item?.label || id)}</span><span class="conn conn-${esc(connectionTone(item?.status))}">${esc(item?.status || 'Unknown')}</span></div>`; }).join('')}</div>
        <p class="xs faint">Model: AUTO — each step is routed to the best available model for ${esc(agent.job)} work, free first.</p></section>`);
    const root = panel.element;
    root.querySelectorAll('[data-tab]').forEach((tab) => {
      tab.onclick = () => selectTab(root, tab.dataset.tab);
      tab.onkeydown = (event) => {
        const all = [...root.querySelectorAll('[data-tab]')];
        const index = all.indexOf(tab);
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); const next = all[(index + (event.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length]; selectTab(root, next.dataset.tab); next.focus(); }
      };
    });
    root.querySelectorAll('[data-handoff]').forEach((row) => { row.onclick = () => openHandoff(ctx, data.handoffs[Number(row.dataset.handoff)]); });
    const form = root.querySelector('#drawerChat');
    if (form) form.onsubmit = async (event) => {
      event.preventDefault();
      const message = root.querySelector('#drawerChatInput').value.trim();
      if (!message) return;
      try {
        const created = await api('/api/conversations', { method: 'POST', body: { workspaceId: ws(), message, agentSlug: slug } });
        panel.close();
        location.hash = `#/chat/${created.conversation.id}`;
      } catch (error) { ctx.toast(error.message); }
    };
  } catch (error) {
    panel.set('Could not open', `<p class="error-note">${esc(error.message)}</p>`);
  }
}
function selectTab(root, id) {
  root.querySelectorAll('[data-tab]').forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.tab === id)));
  root.querySelectorAll('.pane').forEach((pane) => { pane.hidden = pane.id !== `pane-${id}`; });
}
export function connectionTone(status = '') {
  if (/^Connected/.test(status) || status === 'Available') return 'ok';
  if (/Configured/.test(status)) return 'configured';
  if (/account/i.test(status)) return 'account';
  if (/Not configured/.test(status)) return 'off';
  return 'unavailable';
}

// ------------------------------------------------------------------ sheet (drawer / dialog)
export function sheet(ctx, { title, body, size = 'lg' }) {
  const previous = document.activeElement;
  const element = document.createElement('div');
  element.className = `sheet sheet-${size}`;
  element.innerHTML = `<div class="sheet-scrim" data-close></div><div class="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="sheetTitle" tabindex="-1">
    <div class="sheet-head"><h2 id="sheetTitle" class="sheet-title"></h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div><div class="sheet-body"></div></div>`;
  document.body.append(element);
  const panel = element.querySelector('.sheet-panel');
  const set = (text, html) => { element.querySelector('#sheetTitle').textContent = text; element.querySelector('.sheet-body').innerHTML = html; };
  set(title, body);
  const close = () => { element.classList.add('closing'); setTimeout(() => element.remove(), ctx.reducedMotion() ? 0 : 180); document.removeEventListener('keydown', onKey); previous?.focus?.(); };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
    if (event.key === 'Tab') {
      const focusable = [...panel.querySelectorAll('a[href], button:not([disabled]), input, select, textarea, [tabindex="0"]')].filter((node) => !node.closest('[hidden]'));
      if (!focusable.length) return;
      const [first, last] = [focusable[0], focusable.at(-1)];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', onKey);
  element.querySelectorAll('[data-close]').forEach((node) => { node.onclick = close; });
  element.addEventListener('click', (event) => { if (event.target.closest('a[href^="#/"]')) close(); });
  requestAnimationFrame(() => { element.classList.add('open'); panel.focus(); });
  ctx.onLeave(() => element.isConnected && element.remove());
  return { element, set, close };
}
