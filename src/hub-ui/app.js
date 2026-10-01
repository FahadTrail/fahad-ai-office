// Fahad AI Office — Workspace V2 client. No framework: hash routes render
// views from the Hub's JSON API; polling keeps running work live.
import { attentionSummary, chatsSummary, employeesSummary, integrationsSummary, modelsSummary, projectsSummary, tasksSummary } from './summaries.js';
import { escapeHtml as esc, renderMarkdown } from './markdown.js';
import { loginErrorMessage } from './auth.js';
import { ARTIFACT_LABELS, renderArtifact, splitArtifacts } from './artifacts.js';
import { errorBlock, humanError } from './humanize.js';

const $ = (selector, root = document) => root.querySelector(selector);
function applyTheme(theme) {
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme;
}
try { applyTheme(localStorage.getItem('hub-theme')); } catch {}
const view = $('#view');
const MEMORY_KINDS = [['fact', 'Fact'], ['decision', 'Decision'], ['preference', 'Preference'], ['constraint', 'Constraint'], ['product_decision', 'Product decision'], ['technical_decision', 'Technical decision'], ['brand_decision', 'Brand decision'], ['legal_requirement', 'Legal requirement'], ['financial_assumption', 'Financial assumption']];
const state = { workspaceId: null, workspaces: [], conversations: [], timers: [], leave: [], attention: { action: 0, total: 0 }, sidebarTimer: null, signedOut: false };

// ------------------------------------------------------------------ api
class ApiError extends Error {}
async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path.replace(/^\//, './'), {
    method, credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await response.json(); } catch {}
  if (response.status === 401) { showLogin(); throw new ApiError('Please sign in again.'); }
  if (!response.ok || data.ok === false) throw new ApiError(data.error || `Request failed (${response.status})`);
  return data;
}
const ws = () => state.workspaceId;
const q = (params) => `?${new URLSearchParams(params)}`;

// ------------------------------------------------------------------ helpers
function toast(message) {
  const element = $('#toast');
  element.textContent = humanError(message);
  element.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add('hidden'), 3200);
}
function when(value) {
  if (!value) return '';
  const date = new Date(value);
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400 && date.getDate() === new Date().getDate()) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function duration(ms) {
  if (ms == null) return '—';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
const usd = (value) => `$${Number(value || 0).toFixed(Number(value || 0) < 0.1 ? 4 : 2)}`;
const tokens = (value) => (value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}K` : String(value || 0));
const modelName = (route) => String(route || '').split(':').slice(1).join(':') || route || '';
const STATUS_WORDS = { queued: 'Queued', running: 'Running', awaiting_approval: 'Needs approval', blocked: 'Needs you', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', planning: 'Thinking', attention: 'Needs attention' };
const pill = (status, label) => `<span class="pill ${esc(status)}">${esc(label || STATUS_WORDS[status] || status)}</span>`;
function every(ms, fn) { const id = setInterval(fn, ms); state.timers.push(id); return id; }
function clearTimers() { state.timers.forEach(clearInterval); state.timers = []; const leave = state.leave; state.leave = []; leave.forEach((fn) => { try { fn(); } catch {} }); }
function setTitle(text) { document.title = text ? `${text} · Fahad AI Office` : 'Fahad AI Office'; $('#topTitle').textContent = text || 'Fahad AI Office'; }
function autosize(textarea) { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`; }
function markdown(text) {
  const html = splitArtifacts(text).map((part) => (part.artifact ? renderArtifact(part.artifact) : renderMarkdown(part.text))).join('');
  const holder = document.createElement('div');
  holder.className = 'md';
  holder.dir = 'auto';
  holder.innerHTML = html;
  for (const pre of holder.querySelectorAll('pre')) {
    const button = document.createElement('button');
    button.className = 'btn btn-ghost btn-sm copy';
    button.textContent = 'Copy';
    button.onclick = () => navigator.clipboard?.writeText(pre.innerText.replace(/Copy$/, '')).then(() => toast('Copied'));
    pre.append(button);
  }
  return holder.outerHTML;
}
function bind(root, handlers) {
  for (const [selector, fn] of Object.entries(handlers)) root.querySelectorAll(selector).forEach((element) => { element.onclick = (event) => fn(event, element); });
}
function busy(button, on, label) {
  if (!button) return;
  if (on) { button.dataset.label = button.textContent; button.textContent = label || 'Working…'; button.disabled = true; }
  else { button.textContent = button.dataset.label || button.textContent; button.disabled = false; }
}

// ------------------------------------------------------------------ auth
// Shown once per signed-out state. Background polling keeps receiving 401s
// after a session expires; each must NOT re-run this setup, or the form
// would fall back to the "send code" step while the code field is visible
// and a submitted code would request a new one instead of verifying it.
async function showLogin() {
  clearTimers();
  clearInterval(state.sidebarTimer);
  if (state.signedOut) return;
  state.signedOut = true;
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  const form = $('#loginForm');
  let step = 'email';
  const error = (message) => { $('#loginError').textContent = message || ''; $('#loginError').classList.toggle('hidden', !message); };
  try {
    const config = await (await fetch('./api/auth/config')).json();
    if (config.emailHint) $('#loginHint').textContent = `Sign in with a one-time code sent to ${config.emailHint}.`;
  } catch {}
  form.onsubmit = async (event) => {
    event.preventDefault();
    error('');
    const email = $('#loginEmail').value.trim();
    const button = $('#loginSubmit');
    busy(button, true, step === 'email' ? 'Sending…' : 'Checking…');
    try {
      if (step === 'email') {
        const response = await fetch('./api/auth/request-otp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
        if (!response.ok) throw new Error(loginErrorMessage(response.status, await response.json().catch(() => ({}))));
        step = 'code';
        $('#otpRow').classList.remove('hidden');
        $('#loginCode').focus();
        button.dataset.label = 'Sign in';
      } else {
        const response = await fetch('./api/auth/verify-otp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, token: $('#loginCode').value.trim() }) });
        if (!response.ok) throw new Error('The code is not valid. Try again.');
        location.reload();
      }
    } catch (failure) {
      error(failure.message);
    } finally {
      busy(button, false);
    }
  };
}

// ------------------------------------------------------------------ shell
async function boot() {
  try {
    const { workspaces } = await api('/api/workspaces');
    state.workspaces = workspaces;
  } catch (error) {
    if (error instanceof ApiError && /sign in/.test(error.message)) return;
    view.innerHTML = `<div class="page">${errorBlock(error.message, esc)}</div>`;
  }
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  let saved = null;
  try { saved = localStorage.getItem('hub-workspace-id'); } catch {}
  const preferred = state.workspaces.find((workspace) => workspace.id === saved) || state.workspaces.find((workspace) => workspace.name === 'Fahad AI Office') || state.workspaces[0];
  state.workspaceId = preferred?.id || null;
  const select = $('#projectSelect');
  select.innerHTML = state.workspaces.map((workspace) => `<option value="${esc(workspace.id)}">${esc(workspace.name)}</option>`).join('');
  if (state.workspaceId) select.value = state.workspaceId;
  select.onchange = () => {
    state.workspaceId = select.value;
    try { localStorage.setItem('hub-workspace-id', select.value); } catch {}
    refreshSidebar();
    connectLive();
    location.hash = '#/';
  };
  $('#menuButton').onclick = () => toggleSidebar(true);
  $('#sidebarClose').onclick = () => toggleSidebar(false, { restoreFocus: true });
  $('#scrim').onclick = () => toggleSidebar(false, { restoreFocus: true });
  window.matchMedia('(max-width: 900px)').addEventListener('change', () => toggleSidebar(false));
  document.addEventListener('keydown', (event) => {
    if (!$('#sidebar').classList.contains('open') || !window.matchMedia('(max-width: 900px)').matches) return;
    if (event.key === 'Escape') { event.preventDefault(); toggleSidebar(false, { restoreFocus: true }); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...$('#sidebar').querySelectorAll('a, button, select, input, summary')]
      .filter((element) => !element.disabled && element.getClientRects().length);
    if (!focusable.length) return;
    if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0].focus(); }
  });
  window.addEventListener('hashchange', route);
  $('#searchOpen').onclick = openSearch;
  document.addEventListener('keydown', (event) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
    if ((event.key === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !typing)) { event.preventDefault(); openSearch(); }
  });
  await refreshSidebar();
  connectLive();
  state.sidebarTimer = setInterval(refreshSidebar, 60_000);
  route();
}
function toggleSidebar(open, { restoreFocus = false } = {}) {
  const mobile = window.matchMedia('(max-width: 900px)').matches;
  const shown = mobile && open;
  const sidebar = $('#sidebar');
  sidebar.classList.toggle('open', shown);
  sidebar.inert = mobile && !shown;
  if (mobile && !shown) sidebar.setAttribute('aria-hidden', 'true');
  else sidebar.removeAttribute('aria-hidden');
  $('#scrim').classList.toggle('hidden', !shown);
  $('#menuButton').setAttribute('aria-expanded', String(shown));
  $('#menuButton').setAttribute('aria-label', shown ? 'Close menu' : 'Open menu');
  if (shown) $('#sidebarClose').focus();
  else if (restoreFocus) $('#menuButton').focus();
}
async function refreshSidebar() {
  if (!ws()) return;
  try {
    const [{ conversations }, attention, { tasks }, office] = await Promise.all([
      api(`/api/conversations${q({ workspaceId: ws() })}`),
      api(`/api/attention${q({ workspaceId: ws() })}`),
      api(`/api/tasks${q({ workspaceId: ws(), status: 'running' })}`),
      api(`/api/office${q({ workspaceId: ws() })}`).catch(() => null),
    ]);
    const working = office ? office.agents.filter((agent) => ['THINKING', 'WORKING', 'TESTING', 'REVIEWING'].includes(agent.state)).length : 0;
    $('#workingCount').textContent = working;
    $('#workingCount').classList.toggle('hidden', !working);
    state.conversations = conversations;
    state.attention = attention.counts;
    const current = location.hash.match(/^#\/chat\/([\w-]+)/)?.[1];
    $('#recentChats').innerHTML = conversations.slice(0, 8).map((conversation) =>
      `<a href="#/chat/${esc(conversation.id)}" class="${conversation.id === current ? 'active' : ''}" title="${esc(conversation.title)}" dir="auto">${esc(conversation.title)}</a>`).join('');
    const count = $('#attentionCount');
    count.textContent = attention.counts.action;
    count.classList.toggle('hidden', !attention.counts.action);
    $('#topAttention').classList.toggle('hidden', !attention.counts.action);
    const running = $('#runningCount');
    running.textContent = tasks.length;
    running.classList.toggle('hidden', !tasks.length);
  } catch {}
}
function markNav(key) {
  document.querySelectorAll('.nav-item, .nav-sub').forEach((item) => item.classList.toggle('active', item.dataset.nav === key));
  // Deeper pages live under "More": open it when one of them is shown.
  const more = document.getElementById('navMore');
  if (more && more.querySelector(`[data-nav="${key}"]`)) more.open = true;
}

// ------------------------------------------------------------------ search
// One palette for conversations, projects, objectives, tasks, artifacts,
// employees and memory. Debounced; a few results per kind from the server.
const SEARCH_KIND = { employee: 'Employee', project: 'Project', conversation: 'Chat', objective: 'Objective', task: 'Task', artifact: 'Artifact', memory: 'Memory' };
function openSearch() {
  if ($('.palette')) return;
  const previous = document.activeElement;
  const element = document.createElement('div');
  element.className = 'palette';
  element.innerHTML = `<div class="palette-scrim"></div><div class="palette-panel" role="dialog" aria-modal="true" aria-label="Search the Office">
    <input class="palette-input" id="paletteInput" dir="auto" placeholder="Search chats, projects, tasks, artifacts, employees, memory…" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="paletteList">
    <ul class="palette-list" id="paletteList" role="listbox"><li class="palette-hint">Type at least two letters. Enter opens, Esc closes.</li></ul></div>`;
  document.body.append(element);
  const input = element.querySelector('#paletteInput');
  const list = element.querySelector('#paletteList');
  let results = [];
  let active = 0;
  let timer = null;
  let seq = 0;
  const close = () => { element.remove(); previous?.focus?.(); };
  const paint = () => {
    list.innerHTML = results.length ? results.map((result, index) => `<li role="option" id="opt-${index}" aria-selected="${index === active}" class="palette-item" data-index="${index}"><span class="palette-kind">${esc(SEARCH_KIND[result.kind] || result.kind)}</span><span class="grow" dir="auto">${esc(result.title)}</span>${result.detail ? `<span class="xs faint" dir="auto">${esc(result.detail)}</span>` : ''}</li>`).join('')
      : `<li class="palette-hint">${input.value.trim().length < 2 ? 'Type at least two letters. Enter opens, Esc closes.' : 'Nothing found in this project.'}</li>`;
    input.setAttribute('aria-activedescendant', results.length ? `opt-${active}` : '');
    list.querySelectorAll('.palette-item').forEach((item) => { item.onclick = () => go(Number(item.dataset.index)); });
  };
  const go = (index) => { const result = results[index]; if (!result) return; close(); location.hash = result.href; };
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const mine = ++seq;
      const term = input.value.trim();
      if (term.length < 2) { results = []; paint(); return; }
      try { const data = await api(`/api/search${q({ workspaceId: ws(), q: term })}`); if (mine === seq) { results = data.results; active = 0; paint(); } } catch (error) { toast(error.message); }
    }, 200);
  };
  input.onkeydown = (event) => {
    if (event.key === 'Escape') close();
    if (event.key === 'ArrowDown') { event.preventDefault(); active = Math.min(results.length - 1, active + 1); paint(); }
    if (event.key === 'ArrowUp') { event.preventDefault(); active = Math.max(0, active - 1); paint(); }
    if (event.key === 'Enter') { event.preventDefault(); go(active); }
  };
  element.querySelector('.palette-scrim').onclick = close;
  input.focus();
}

// ------------------------------------------------------------------ router
async function route() {
  clearTimers();
  toggleSidebar(false);
  const hash = location.hash || '#/';
  const [, section = '', id = '', sub = ''] = hash.match(/^#\/([\w-]*)\/?([\w-]*)\/?([\w-]*)/) || [];
  const routes = {
    '': () => renderChat(null), chat: () => renderChat(id), chats: renderChats, tasks: () => renderTasks(id || 'running'), task: () => renderTask(id),
    code: renderNewTask, attention: renderAttention, projects: renderProjects, project: () => renderProject(id, sub), models: renderModels, settings: renderSettings,
    office: renderOffice, agent: async () => { await renderOffice(); await openEmployee(id); }, workflow: () => renderWorkflow(id), talk: () => renderChat(null, id),
    artifacts: () => renderArtifacts(id), employees: renderEmployees, integrations: renderIntegrations,
  };
  markNav({ '': 'chat', chat: 'chats', task: 'tasks', code: 'tasks', project: 'projects', agent: 'employees', workflow: 'office', talk: 'employees' }[section] ?? section);
  document.querySelectorAll('#recentChats a').forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#/chat/${id}`));
  try {
    await (routes[section] || routes[''])();
  } catch (error) {
    view.innerHTML = `<div class="page">${errorBlock(error.message, esc)}</div>`;
  }
  view.focus({ preventScroll: true });
}

// ------------------------------------------------------------------ chat
const SUGGESTIONS = [
  'خل Legal يراجع شروط الاستخدام قبل الإطلاق',
  'حولها للفاينانس: كم تكلفة التشغيل الشهرية؟',
  'Plan the launch: research, MVP, budget, brand and content',
  'خل Coding يصلح الخطأ في صفحة الدخول',
];

async function renderChat(id, agentSlug = null) {
  let conversation = null;
  let messages = [];
  if (id) ({ conversation, messages } = await api(`/api/conversations/${id}`));
  const slug = conversation?.agent?.slug || agentSlug || 'chief-of-staff';
  const who = await agentInfo(slug);
  const direct = slug !== 'chief-of-staff';
  setTitle(conversation?.title || (direct ? `Talk to ${who.label}` : 'New chat'));
  view.innerHTML = `<div class="chat">
    <div class="chat-who">${avatar(who)}<div class="grow"><div class="who-name">${esc(who.label)}${direct ? ' <span class="pill st-available">Direct</span>' : ''}</div>
      <div class="who-role">${esc(direct ? who.scope : 'Give me the objective — I coordinate the Office and bring back one result.')}</div></div>
      <a class="btn btn-ghost btn-sm" href="#/agent/${esc(slug)}">Profile</a></div>
    ${conversation ? `<div class="chat-head">
      <h1 class="chat-title" dir="auto" id="chatTitle">${esc(conversation.title)}</h1>
      <button class="btn btn-ghost btn-sm" id="renameChat">Rename</button>
      <button class="btn btn-ghost btn-sm" id="archiveChat">${conversation.archived ? 'Unarchive' : 'Archive'}</button>
      <button class="btn btn-ghost btn-sm" id="deleteChat">Delete</button>
    </div>` : ''}
    <div class="chat-scroll" id="chatScroll">${conversation ? '<div class="messages" id="messages"></div>' : (direct ? welcomeAgent(who) : welcome())}</div>
    <div class="composer-wrap">
      <form class="composer" id="composer">
        <label class="sr-only" for="prompt">Message</label>
        <textarea id="prompt" rows="1" dir="auto" placeholder="${conversation ? 'Reply…' : 'Ask anything or describe a task…'}"></textarea>
        <button class="btn btn-danger hidden" type="button" id="stopButton">Stop</button>
        <button class="btn btn-primary" type="submit" id="sendButton">Send</button>
      </form>
      <div class="composer-hint">${direct ? `You are talking directly to ${esc(who.label)}. For work that needs several people, ask the <a href="#/">Chief of Staff</a>.` : 'The Chief of Staff decides who does the work, dispatches the team and consolidates the result.'}</div>
    </div>
  </div>`;
  const prompt = $('#prompt');
  prompt.oninput = () => autosize(prompt);
  prompt.onkeydown = (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#composer').requestSubmit(); } };
  bind(view, { '.suggestion': (_, element) => { prompt.value = element.dataset.text; autosize(prompt); prompt.focus(); } });
  $('#composer').onsubmit = async (event) => {
    event.preventDefault();
    const text = prompt.value.trim();
    if (!text) return;
    const button = $('#sendButton');
    busy(button, true, 'Sending…');
    try {
      if (!conversation) {
        const created = await api('/api/conversations', { method: 'POST', body: { workspaceId: ws(), message: text, ...(direct ? { agentSlug: slug } : {}) } });
        prompt.value = '';
        await refreshSidebar();
        location.hash = `#/chat/${created.conversation.id}`;
        return;
      }
      await api(`/api/conversations/${conversation.id}/messages`, { method: 'POST', body: { message: text } });
      prompt.value = '';
      autosize(prompt);
      await load();
    } catch (error) {
      toast(error.message);
    } finally {
      busy(button, false);
    }
  };
  if (!conversation) { prompt.focus(); if (!direct) { fillChiefHome(); onLiveChange(fillChiefHome); } return; }

  bind(view, {
    '#renameChat': async () => {
      const title = await ask('Rename chat', conversation.title);
      if (!title) return;
      await api(`/api/conversations/${conversation.id}`, { method: 'PATCH', body: { title } });
      conversation.title = title;
      $('#chatTitle').textContent = title;
      setTitle(title);
      refreshSidebar();
    },
    '#archiveChat': async () => {
      await api(`/api/conversations/${conversation.id}`, { method: 'PATCH', body: { archived: !conversation.archived } });
      toast(conversation.archived ? 'Chat restored' : 'Chat archived');
      await refreshSidebar();
      location.hash = '#/chats';
    },
    '#deleteChat': async () => {
      if (!(await confirmDialog('Delete this chat?', 'The conversation disappears from your list. Work already done (tasks, results, audit) is kept.'))) return;
      await api(`/api/conversations/${conversation.id}`, { method: 'DELETE' });
      await refreshSidebar();
      location.hash = '#/';
    },
    '#stopButton': async () => {
      await api(`/api/conversations/${conversation.id}/stop`, { method: 'POST' });
      toast('Stopped');
      await load();
    },
  });

  let lastSignature = '';
  async function load() {
    const data = await api(`/api/conversations/${conversation.id}`);
    messages = data.messages;
    const signature = JSON.stringify(messages.map((message) => [message.jobId, message.assistant.status, message.assistant.stage, message.assistant.text.length, message.assistant.tasks.map((task) => task.status + task.phase), message.assistant.workflow]));
    const pending = messages.some((message) => !['completed', 'failed', 'cancelled'].includes(message.assistant.status));
    $('#stopButton').classList.toggle('hidden', !pending);
    if (signature === lastSignature) return pending;
    lastSignature = signature;
    const scroller = $('#chatScroll');
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    $('#messages').innerHTML = messages.map(messageHtml).join('');
    bind($('#messages'), {
      '[data-retry]': async (_, element) => {
        await api(`/api/conversations/${conversation.id}/messages`, { method: 'POST', body: { message: element.dataset.retry } });
        load();
      },
      '[data-copy]': (_, element) => navigator.clipboard?.writeText(messages.find((message) => message.jobId === element.dataset.copy)?.assistant.text || '').then(() => toast('Copied')),
    });
    if (atBottom || !load.done) scroller.scrollTop = scroller.scrollHeight;
    load.done = true;
    return pending;
  }
  await load();
  every(2500, async () => { try { await load(); } catch {} });
}

// CHIEF home: ask, then everything that matters at a glance — what needs
// Fahad, what is moving, who is working, what just finished, what to decide.
function welcome() {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return `<div class="chief-home">
    <div class="ch-hero"><h1>${greeting}, Fahad</h1><p class="muted">Tell CHIEF what you need — in Arabic or English. CHIEF picks the right employees and brings back one result.</p>
      <div class="suggestions">${SUGGESTIONS.map((text) => `<button class="suggestion" type="button" data-text="${esc(text)}" dir="auto">${esc(text)}</button>`).join('')}</div></div>
    <div class="ch-grid" id="chiefHome" aria-live="polite"><div class="drawer-loading"></div></div>
  </div>`;
}
async function fillChiefHome() {
  const holder = $('#chiefHome');
  if (!holder || !ws()) return;
  try {
    const [center, attention, office] = await Promise.all([
      api(`/api/command-center${q({ workspaceId: ws() })}`),
      api(`/api/attention${q({ workspaceId: ws() })}`),
      api(`/api/office${q({ workspaceId: ws() })}`),
    ]);
    const needs = attention.items.filter((item) => item.priority !== 'INFO');
    const done = attention.items.filter((item) => item.priority === 'INFO').slice(0, 4);
    const working = office.agents.filter((agent) => agent.state && agent.state !== 'AVAILABLE');
    const card = (title, body, href = '', extra = '') => `<section class="ch-card ${extra}"><div class="ch-card-head"><h2>${title}</h2>${href ? `<a class="small" href="${href}">Open</a>` : ''}</div>${body}</section>`;
    holder.innerHTML = [
      card('Needs you', needs.length ? needs.slice(0, 4).map((item) => `<a class="ch-row" href="${item.taskId ? `#/task/${esc(item.taskId)}` : `#/chat/${esc(item.conversationId || '')}`}"><span class="ch-kind k-${esc(item.kind)}">${esc(item.category || item.kind)}</span><span class="grow" dir="auto">${esc(item.title)}</span></a>`).join('') : '<p class="muted small">Nothing needs you. The Office will ask here and on Telegram when it does.</p>', '#/attention', needs.length ? 'ch-alert' : ''),
      card('In progress', center.objectives.active.length ? center.objectives.active.map((job) => `<a class="ch-row" href="#/workflow/${esc(job.id)}"><span class="grow" dir="auto">${esc(job.title)}</span><span class="ch-pct num">${job.progress}%</span></a><span class="progress" aria-hidden="true"><span style="width:${Math.max(3, job.progress)}%"></span></span>`).join('') : '<p class="muted small">No objective running.</p>', `#/project/${esc(ws())}`),
      card('Team now', working.length ? `<div class="ch-team">${working.map((agent) => `<button type="button" class="ch-member" data-employee="${esc(agent.slug)}"><span class="ch-dot st-dot-${esc(String(agent.state).toLowerCase().replace(/\s+/g, '-'))}"></span><strong>${esc(agent.label)}</strong><span class="xs muted" dir="auto">${esc(agent.detail || '')}</span></button>`).join('')}</div>` : '<p class="muted small">Everyone is available.</p>', '#/office'),
      card('Recently completed', done.length ? done.map((item) => `<a class="ch-row" href="${item.taskId ? `#/task/${esc(item.taskId)}` : item.jobId ? `#/workflow/${esc(item.jobId)}` : `#/chat/${esc(item.conversationId || '')}`}"><span class="ch-kind k-completed">Done</span><span class="grow" dir="auto">${esc(item.title)}</span><span class="xs faint">${when(item.at)}</span></a>`).join('') : '<p class="muted small">Nothing finished in the last 3 days.</p>'),
      card('Decisions', center.decisionsForFahad.length ? center.decisionsForFahad.slice(0, 3).map((decision) => `<div class="ch-decision"><span class="xs faint">${esc(decision.from)}</span><div dir="auto">${esc(decision.text)}</div></div>`).join('')
        : center.memory.decisions.length ? center.memory.decisions.slice(0, 3).map((item) => `<div class="ch-decision"><span class="xs faint">Decided</span><div dir="auto">${esc(item.content)}</div></div>`).join('') : '<p class="muted small">No decisions waiting.</p>', `#/project/${esc(ws())}`),
    ].join('');
    holder.querySelectorAll('[data-employee]').forEach((button) => { button.onclick = () => openEmployee(button.dataset.employee); });
  } catch (error) {
    holder.innerHTML = `<p class="muted small">${esc(humanError(error.message))}</p>`;
  }
}

function welcomeAgent(who) {
  return `<div class="welcome">${avatar(who, 'avatar-lg')}
    <h1>Talk to ${esc(who.label)}</h1>
    <p class="muted">${esc(who.scope)}</p>
    <p class="small faint">For an objective that needs several employees, <a href="#/">ask the Chief of Staff</a> instead.</p>
  </div>`;
}

const FLOW_ICON = { done: '✓', working: '●', waiting: '○', ready: '○', failed: '✕', blocked: '✕', capacity: '⏸' };
function flowCard(flow, jobId) {
  if (!flow) return '';
  return `<a class="flow-card" href="#/workflow/${esc(jobId)}"><div class="small faint">Chief of Staff dispatched the team</div>
    ${flow.streams.map((stream) => `<div class="flow-row st-${esc(stream.state)}"><span class="flow-icon">${FLOW_ICON[stream.state] || '○'}</span><strong>${esc(stream.agent)}</strong><span class="muted grow">${esc(stream.title)}</span><span class="xs faint">${esc(stream.state === 'capacity' ? 'waiting for free capacity' : stream.state)}</span></div>`).join('')}
    <div class="flow-row st-${esc(flow.synthesis)}"><span class="flow-icon">${FLOW_ICON[flow.synthesis] || '○'}</span><strong>Chief of Staff</strong><span class="muted grow">Consolidated result</span><span class="xs faint">${esc(flow.synthesis)}</span></div>
    <div class="xs" style="margin-top:var(--s-2)">Open the workflow →</div></a>`;
}

function messageHtml(message) {
  const a = message.assistant;
  const user = `<div class="msg msg-user"><div class="bubble-col" style="max-width:82%"><div class="bubble" dir="auto">${esc(message.user.text)}</div><div class="msg-meta">${when(message.user.at)}</div></div></div>`;
  let body;
  if (a.status === 'completed') body = markdown(a.text || 'Done.');
  else if (a.status === 'failed') body = `<div class="error-note">I couldn't finish this request. <button class="btn btn-sm" data-retry="${esc(message.user.text)}">Retry</button></div>`;
  else if (a.status === 'cancelled') body = `<div class="muted small">Stopped. <button class="btn btn-sm" data-retry="${esc(message.user.text)}">Run again</button></div>`;
  else body = `<div class="thinking"><span class="dots"><i></i><i></i><i></i></span>${esc(a.stage || 'Thinking')}…</div>`;
  const tasks = a.tasks.map((task) => `<a class="task-chip" href="#/task/${esc(task.id)}"><div class="grow"><div class="title" dir="auto">${esc(task.title)}</div><div class="sub small muted">Development task · ${esc(stageWord(task.phase))}</div></div>${pill(taskGroup(task.status), STATUS_WORDS[task.status])}</a>`).join('');
  const meta = a.status === 'completed' ? `<div class="msg-meta">${when(a.at)}${a.model ? ` · <span title="${esc(a.model.provider)}">${esc(a.model.model)}</span>` : ''}${a.costUsd ? ` · ${usd(a.costUsd)}` : ''}<button class="btn btn-ghost btn-sm" data-copy="${esc(message.jobId)}">Copy</button></div>` : '';
  return `${user}<div class="msg msg-office"><div class="bubble">${body}${flowCard(a.workflow, message.jobId)}${tasks}${meta}</div></div>`;
}
const PHASE_WORDS = { understand: 'Understanding', plan: 'Planning', implement: 'Editing', test: 'Testing', debug: 'Debugging', review: 'Reviewing', publish: 'Opening the pull request', ci: 'Waiting for CI', deploy: 'Deploying', verify: 'Verifying', report: 'Wrapping up', done: 'Done' };
const stageWord = (phase) => PHASE_WORDS[phase] || phase || '';
const taskGroup = (status) => (['awaiting_approval', 'blocked'].includes(status) ? 'attention' : status === 'queued' ? 'running' : status);

async function renderChats() {
  setTitle('Chats');
  view.innerHTML = `<div class="page"><div class="page-head"><div><h1>Chats</h1><p class="page-summary" id="chatSummary" aria-live="polite">Every conversation with the Office, newest first.</p></div><a class="btn btn-primary" href="#/">＋ New chat</a></div>
    <div class="row" style="margin-bottom:var(--s-4)"><input id="chatSearch" class="input grow" placeholder="Search chats…" dir="auto"><button id="showArchived" class="btn">Archived</button></div>
    <div id="chatList"></div></div>`;
  let archived = false;
  const load = async () => {
    const { conversations } = await api(`/api/conversations${q({ workspaceId: ws(), archived, q: $('#chatSearch').value.trim() })}`);
    $('#chatSummary').textContent = chatsSummary(conversations, archived);
    $('#chatList').innerHTML = conversations.length ? conversations.map((conversation) =>
      `<a class="list-item" href="#/chat/${esc(conversation.id)}"><div class="grow"><div class="title" dir="auto">${esc(conversation.title)}</div><div class="sub">${when(conversation.lastMessageAt)}</div></div></a>`).join('')
      : `<div class="empty"><h3>${archived ? 'No archived chats' : 'No chats found'}</h3><p>Start a new chat from the button above.</p></div>`;
  };
  let timer;
  $('#chatSearch').oninput = () => { clearTimeout(timer); timer = setTimeout(load, 250); };
  $('#showArchived').onclick = () => { archived = !archived; $('#showArchived').textContent = archived ? 'Active' : 'Archived'; load(); };
  await load();
}

// ------------------------------------------------------------------ tasks
const TASK_TABS = [['running', 'Running'], ['attention', 'Needs attention'], ['completed', 'Completed'], ['failed', 'Failed'], ['cancelled', 'Cancelled']];

async function renderTasks(tab) {
  setTitle('Tasks');
  view.innerHTML = `<div class="page"><div class="page-head"><div><h1>Tasks</h1><p class="page-summary" id="taskSummary" aria-live="polite">Development work the Office is doing or has done.</p></div><a class="btn btn-primary" href="#/code">＋ New task</a></div>
    <div class="tabs" role="tablist">${TASK_TABS.map(([key, label]) => `<a class="tab ${key === tab ? 'active' : ''}" role="tab" href="#/tasks/${key}">${label}</a>`).join('')}</div>
    <div id="taskList"></div></div>`;
  const load = async () => {
    const { tasks } = await api(`/api/tasks${q({ workspaceId: ws(), status: tab })}`);
    $('#taskSummary').textContent = tasksSummary(tasks, tab);
    $('#taskList').innerHTML = tasks.length ? tasks.map(taskItem).join('') : `<div class="empty"><h3>Nothing here</h3><p>${tab === 'running' ? 'No task is running. Describe one in a chat or start one from the Coding Agent.' : 'No tasks in this group.'}</p></div>`;
  };
  await load();
  if (tab === 'running' || tab === 'attention') every(5000, () => load().catch(() => {}));
}
function taskItem(task) {
  const sub = task.group === 'completed' ? (task.summary || 'Completed') : task.group === 'attention' ? (task.needs === 'approval' ? 'Waiting for your approval' : task.needs === 'question' ? 'Has a question for you' : 'Paused — needs you') : task.now;
  return `<a class="list-item" href="#/task/${esc(task.id)}"><div class="grow"><div class="title" dir="auto">${esc(task.title)}</div><div class="sub" dir="auto">${esc(sub || '')}</div>
    <div class="sub faint xs">${esc(task.repository)} · ${when(task.updatedAt)} · ${usd(task.costUsd)}${task.pr?.number ? ` · PR #${esc(task.pr.number)}` : ''}</div></div>${pill(task.group, STATUS_WORDS[task.group === 'attention' ? 'attention' : task.status])}</a>`;
}

async function renderNewTask() {
  setTitle('Coding Agent');
  const [{ project }, { tasks }] = await Promise.all([api(`/api/projects/${ws()}`), api(`/api/tasks${q({ workspaceId: ws() })}`)]);
  view.innerHTML = `<div class="page"><div class="page-head"><div><h1>Coding Agent</h1><p>Plans, edits, tests, opens a pull request and follows CI — and asks you only when it must.</p></div></div>
    <form class="card" id="taskForm">
      <label class="field-label" for="instruction" style="margin-top:0;font-size:var(--fs-md);color:var(--text)">What do you want me to build or fix?</label>
      <textarea id="instruction" class="input big-input" dir="auto" placeholder="Describe the change, the problem or the feature. Include acceptance criteria if you have them."></textarea>
      <div class="small muted" style="margin-top:var(--s-2)">Repository: <strong>${esc(project.defaultRepository || 'not set')}</strong> · Budget $2 · Routing AUTO</div>
      <details class="disclosure" style="margin-top:var(--s-3)"><summary>Advanced options</summary><div class="disclosure-body">
        <label class="field-label" for="tRepo">Repository (owner/name)</label><input id="tRepo" class="input" value="${esc(project.defaultRepository || '')}" placeholder="owner/name">
        <label class="field-label" for="tBudget">Budget (USD)</label><input id="tBudget" class="input" type="number" min="0.5" max="500" step="0.5" value="2">
        <label class="field-label" for="tStrategy">Model routing</label><select id="tStrategy" class="input"><option value="">AUTO (recommended)</option><option value="economy">Economy — free and cheapest first</option><option value="balanced">Balanced</option><option value="quality">Quality — strongest first</option></select>
        <label class="field-label" for="tTest">Test command (auto-detected when empty)</label><input id="tTest" class="input" placeholder="npm test">
        <label class="row small muted" style="margin-top:var(--s-3)"><input id="tDeploy" type="checkbox"> Merge &amp; deploy after CI passes (the merge always asks for your approval)</label>
      </div></details>
      <p id="taskError" class="form-error hidden"></p>
      <div class="row" style="margin-top:var(--s-4)"><button class="btn btn-primary btn-lg" type="submit" id="startTask">Start task</button></div>
    </form>
    <h2 class="section-title">Recent tasks</h2><div>${tasks.slice(0, 8).map(taskItem).join('') || '<div class="muted small">No tasks yet.</div>'}</div></div>`;
  $('#taskForm').onsubmit = async (event) => {
    event.preventDefault();
    const error = $('#taskError');
    error.classList.add('hidden');
    const button = $('#startTask');
    busy(button, true, 'Starting…');
    try {
      const body = { workspaceId: ws(), instruction: $('#instruction').value.trim(), budgetUsd: Number($('#tBudget').value || 2) };
      if ($('#tRepo').value.trim()) body.repository = $('#tRepo').value.trim();
      if ($('#tStrategy').value) body.strategy = $('#tStrategy').value;
      if ($('#tTest').value.trim()) body.testCommand = $('#tTest').value.trim();
      if ($('#tDeploy').checked) body.deploy = true;
      const { task } = await api('/api/tasks', { method: 'POST', body });
      location.hash = `#/task/${task.id}`;
    } catch (failure) {
      error.textContent = failure.message;
      error.classList.remove('hidden');
    } finally {
      busy(button, false);
    }
  };
}

async function renderTask(id) {
  let drafting = '';
  let lastSignature = '';
  const load = async () => {
    const data = await api(`/api/tasks/${id}`);
    const signature = JSON.stringify([data.task.status, data.task.phase, data.task.now, data.task.spentUsd, data.task.iteration, data.approvals.map((approval) => approval.status), data.events[0]?.id]);
    if (signature === lastSignature) return data.task;
    lastSignature = signature;
    const reply = $('#replyText');
    if (reply) drafting = reply.value;
    view.innerHTML = taskPage(data);
    if ($('#replyText')) $('#replyText').value = drafting;
    wireTask(data);
    return data.task;
  };
  const task = await load();
  setTitle(task.title);
  if (!['completed', 'failed', 'cancelled'].includes(task.status)) every(4000, () => load().catch(() => {}));

  function wireTask(data) {
    bind(view, {
      '[data-decide]': async (_, element) => {
        const decision = element.dataset.decide;
        const note = decision === 'rejected' ? await ask('Reject — tell the agent why (optional)', '', true) : null;
        if (decision === 'rejected' && note === null) return;
        busy(element, true);
        try {
          await api(`/api/approvals/${element.dataset.id}`, { method: 'POST', body: { decision, note: note || undefined } });
          toast(decision === 'approved' ? 'Approved — the task continues' : 'Rejected — the agent will adapt');
          lastSignature = '';
          await load();
          refreshSidebar();
        } catch (error) { toast(error.message); busy(element, false); }
      },
      '#replySend': async (_, element) => {
        const message = $('#replyText').value.trim();
        if (!message) return toast('Write your answer first');
        busy(element, true, 'Sending…');
        try {
          await api(`/api/tasks/${id}/reply`, { method: 'POST', body: { message } });
          drafting = '';
          toast('Sent — the same task continues');
          lastSignature = '';
          await load();
          refreshSidebar();
        } catch (error) { toast(error.message); busy(element, false); }
      },
      '#resumeTask': async () => { await api(`/api/tasks/${id}/resume`, { method: 'POST' }); toast('Resumed'); lastSignature = ''; await load(); },
      '#cancelTask': async () => {
        if (!(await confirmDialog('Cancel this task?', 'The agent stops at its next checkpoint. Work already pushed stays on its branch.'))) return;
        await api(`/api/tasks/${id}/cancel`, { method: 'POST' });
        lastSignature = '';
        await load();
      },
    });
  }
}

function taskPage({ task, events, approvals }) {
  const t = task;
  const closed = ['completed', 'failed', 'cancelled'].includes(t.status);
  const group = taskGroup(t.status);
  const head = `<div class="task-head">
    <div class="row">${pill(group, STATUS_WORDS[group === 'attention' ? 'attention' : t.status])}<span class="small muted">${esc(t.repository)}</span>${t.conversationId ? `<a class="small" href="#/chat/${esc(t.conversationId)}">Open chat</a>` : ''}</div>
    <h1 dir="auto">${esc(t.title)}</h1>
    <dl class="kv"><div><dt>Model</dt><dd title="${esc(t.currentModel || '')}">${esc(modelName(t.currentModel) || 'AUTO')}</dd></div><div><dt>Cost</dt><dd>${usd(t.metrics.costUsd)} <span class="faint small">of ${usd(t.budgetUsd)}</span></dd></div><div><dt>Elapsed</dt><dd>${duration(t.elapsedMs)}</dd></div><div><dt>Updated</dt><dd>${when(t.updatedAt)}</dd></div></dl>
  </div>`;
  const now = closed ? '' : `<div class="now" dir="auto">${t.needs ? '' : '<span class="dots"><i></i><i></i><i></i></span>'}<span>${esc(t.needs ? 'Waiting for you.' : t.now)}</span></div>`;
  const timeline = `<div class="card"><div class="timeline" role="list">${t.timeline.filter((step) => step.state !== 'skipped').map((step, index) => `<div class="step ${step.state}" role="listitem" title="${esc(step.label)}: ${esc(step.state.replace('_', ' '))}"><span class="dot">${{ passed: '✓', failed: '!', needs_input: '?', skipped: '–' }[step.state] || index + 1}</span><span>${esc(step.label)}</span></div>`).join('')}</div></div>`;
  const owner = ownerCard(t, approvals);
  const result = t.result || {};
  const pr = t.pr || result.pr;
  const outcome = `<div class="card"><h2 class="card-title">${closed ? 'Result' : 'Progress so far'}</h2>
    ${result.summary ? markdown(result.summary) : t.blocker && t.status === 'failed' ? errorBlock(t.blocker, esc) : '<p class="muted small">The summary appears here when the task finishes.</p>'}
    <dl class="kv" style="margin-top:var(--s-3)">
      <div><dt>Pull request</dt><dd>${pr?.url ? `<a href="${esc(pr.url)}" target="_blank" rel="noopener">#${esc(pr.number)}</a>` : '—'}</dd></div>
      <div><dt>CI</dt><dd>${esc(t.ci?.state || result.ci?.state || '—')}</dd></div>
      <div><dt>Tests</dt><dd>${t.lastTest ? (t.lastTest.exitCode === 0 ? 'Passing' : 'Failing') : '—'}</dd></div>
      <div><dt>Deployment</dt><dd>${esc(result.deploy?.status || t.deploy?.status || (t.config?.deploy?.mode === 'merge' ? 'Pending' : 'Not requested'))}</dd></div>
    </dl>
    ${(t.filesChanged || []).length ? `<div class="small muted" style="margin-top:var(--s-3)">Files changed</div><div class="files">${t.filesChanged.map((file) => `<code>${esc(file)}</code>`).join('')}</div>` : ''}
  </div>`;
  const metrics = t.metrics;
  const details = `<details class="disclosure"><summary>Original instruction</summary><div class="disclosure-body report" dir="auto">${esc(t.objective)}</div></details>
    <details class="disclosure"><summary>Cost, models and efficiency</summary><div class="disclosure-body"><dl class="kv">
      <div><dt>Model calls</dt><dd>${metrics.modelCalls}</dd></div><div><dt>Iterations</dt><dd>${metrics.iterations}</dd></div>
      <div><dt>Input tokens</dt><dd>${tokens(metrics.inputTokens)} <span class="faint small">${metrics.inputTokens ? `${Math.round((metrics.cachedInputTokens / metrics.inputTokens) * 100)}% cached` : ''}</span></dd></div>
      <div><dt>Output tokens</dt><dd>${tokens(metrics.outputTokens)}</dd></div><div><dt>Model switches</dt><dd>${metrics.modelSwitches}</dd></div>
      <div><dt>Context trimmed</dt><dd>${tokens(Math.round((metrics.contextTrimmedChars || 0) / 4))} tokens</dd></div>
    </dl><div class="small muted" style="margin-top:var(--s-2)">Models used: ${esc(metrics.modelsUsed.join(', ') || '—')}</div></div></details>
    <details class="disclosure"><summary>View details (${events.length} events)</summary><div class="disclosure-body"><div class="events">${events.map((event) => `<div class="${esc(event.level)}"><span class="faint">${esc(new Date(event.createdAt || event.created_at).toLocaleTimeString())} ${esc(event.type)}</span> ${esc(event.message)}</div>`).join('')}</div></div></details>`;
  const actions = closed ? '' : `<div class="row" style="margin-top:var(--s-4)">${t.status === 'blocked' && !t.needs?.kind?.includes('question') ? '<button class="btn" id="resumeTask">Resume</button>' : ''}<button class="btn btn-danger" id="cancelTask">Cancel task</button></div>`;
  return `<div class="page stack">${head}${owner}${now}${timeline}${outcome}${details}${actions}</div>`;
}

function ownerCard(task, approvals) {
  const need = task.needs;
  if (!need) return '';
  if (need.kind === 'approval') {
    return `<section class="owner-card" aria-live="polite"><h2>${esc(need.title)}</h2>${need.items.map((item) => `<div class="owner-item">
      <div class="small muted">${esc(item.who || 'An agent')} is asking</div>
      <div class="spread"><div class="what" dir="auto">${esc(item.what)}</div><span class="risk ${esc(item.risk)}">${esc(item.risk)} risk</span></div>
      ${item.why ? `<p class="small" dir="auto"><strong>Why:</strong> ${esc(item.why)}</p>` : ''}
      ${item.resources.length ? `<div class="small muted">Affects</div><div class="resources">${item.resources.map((resource) => `<code>${esc(resource)}</code>`).join('')}</div>` : ''}
      ${item.kind === 'protected_change' ? '<p class="xs muted">Approving allows changes to exactly these files in this task only. Secrets, .env files, keys and Hermes can never be approved.</p>' : ''}
      <div class="row"><button class="btn btn-success" data-decide="approved" data-id="${esc(item.id)}">Approve</button><button class="btn btn-danger" data-decide="rejected" data-id="${esc(item.id)}">Reject</button></div>
    </div>`).join('')}</section>`;
  }
  const question = need.kind === 'question';
  return `<section class="owner-card" aria-live="polite"><h2>${esc(need.title)}</h2>
    ${question ? `<p class="what" dir="auto">${esc(need.question)}</p>${need.reason && need.reason !== need.question ? `<p class="small muted" dir="auto"><strong>Why:</strong> ${esc(need.reason)}</p>` : ''}` : `<p dir="auto">${esc(need.explanation)}</p>`}
    <label class="field-label" for="replyText">${question ? 'Your answer' : 'Instructions for the agent (optional)'}</label>
    <textarea id="replyText" class="input" rows="3" dir="auto" placeholder="${question ? 'Type your answer…' : 'e.g. try a smaller change, or skip the docs update'}"></textarea>
    <div class="row" style="margin-top:var(--s-3)"><button class="btn btn-primary" id="replySend">Reply &amp; Continue</button>${question ? '' : '<button class="btn" id="resumeTask">Resume without a message</button>'}</div>
  </section>`;
}

// ------------------------------------------------------------------ office
const agentCache = new Map();
async function agentInfo(slug) {
  if (!agentCache.has(slug)) {
    try { agentCache.set(slug, (await api(`/api/agents/${slug}${q({ workspaceId: ws() })}`)).agent); } catch { return { slug, label: slug, scope: '' }; }
  }
  return agentCache.get(slug);
}
function avatar(agent, extra = '') {
  const initial = String(agent.label || '?').replace(/[^A-Za-z؀-ۿ]/g, '').slice(0, 1).toUpperCase() || '•';
  return `<span class="avatar ${extra}" style="--agent:${esc(agent.color || 'var(--accent)')}" aria-hidden="true">${esc(initial)}</span>`;
}
const STATE_CLASS = { AVAILABLE: 'st-available', QUEUED: 'st-waiting', THINKING: 'st-working', WORKING: 'st-working', TESTING: 'st-working', REVIEWING: 'st-working', WAITING: 'st-waiting', BLOCKED: 'st-blocked', FAILED: 'st-blocked', 'NEEDS FAHAD': 'st-needs', COMPLETED: 'st-completed' };
const statePill = (value) => `<span class="pill ${STATE_CLASS[value] || 'st-available'}">${esc(value)}</span>`;
const ACTIVE_STATES = new Set(['THINKING', 'WORKING', 'TESTING', 'REVIEWING']);
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// The Live Office lives in its own module, loaded on demand (with its art
// and styles), so the Workspace routes stay light.
const loadOffice = () => import('./office.js?v=__UI_VERSION__');
async function renderOffice() { return (await loadOffice()).renderOffice(officeContext()); }
async function openEmployee(slug) { return (await loadOffice()).openEmployee(officeContext(), slug); }
let capabilitiesCache = null;
function officeContext() {
  return {
    api, esc, when, q, ws, view, setTitle, toast, every, reducedMotion, renderArtifact,
    onChange: (fn, onLive) => onLiveChange(fn, onLive),
    onLeave: (fn) => state.leave.push(fn),
    capabilities: async () => {
      if (!capabilitiesCache || Date.now() - capabilitiesCache.at > 60_000) capabilitiesCache = { at: Date.now(), list: api('/api/capabilities').then((data) => data.capabilities) };
      return capabilitiesCache.list;
    },
  };
}

// ------------------------------------------------------------------ realtime
// One EventSource per workspace. The Hub pushes "change" when real rows
// change; views re-read then. Polling stays only as a slow safety net.
const live = { source: null, workspace: null, listeners: new Set(), connected: false, liveListeners: new Set() };
function connectLive() {
  if (!ws() || live.workspace === ws() && live.source) return;
  live.source?.close();
  live.workspace = ws();
  if (typeof EventSource === 'undefined') return;
  const source = new EventSource(`./api/stream${q({ workspaceId: ws() })}`);
  live.source = source;
  const setLive = (value) => { live.connected = value; live.liveListeners.forEach((fn) => fn(value)); };
  source.addEventListener('ready', () => setLive(true));
  source.addEventListener('change', () => { live.listeners.forEach((fn) => fn()); refreshSidebar(); });
  source.onerror = () => setLive(false);
}
function onLiveChange(fn, onLive) {
  let timer = null;
  const debounced = () => { clearTimeout(timer); timer = setTimeout(fn, 250); };
  live.listeners.add(debounced);
  if (onLive) { live.liveListeners.add(onLive); onLive(live.connected); }
  state.leave.push(() => { live.listeners.delete(debounced); if (onLive) live.liveListeners.delete(onLive); clearTimeout(timer); });
}

async function renderEmployees() {
  setTitle('Employees');
  const data = await api(`/api/office${q({ workspaceId: ws() })}`);
  view.innerHTML = `<div class="page page-wide"><div class="page-head"><div><h1>Employees</h1><p class="page-summary">${esc(employeesSummary(data.agents))}</p></div></div>
    <div class="office-grid">${data.agents.map((agent) => `<a class="agent-card ${STATE_CLASS[agent.state] || ''}" href="#/agent/${esc(agent.slug)}" data-employee="${esc(agent.slug)}">
      <div class="row">${avatar(agent)}<div class="grow"><div class="title">${esc(agent.label)}</div><div class="xs faint">${esc(agent.deliverable || '')}</div></div>${statePill(agent.state)}</div>
      <div class="small muted">${esc(agent.scope)}</div>
      <div class="row">${agent.directChat ? '<span class="tag">Direct chat</span>' : ''}${agent.executor === 'coding' ? '<span class="tag">Engineering tasks</span>' : ''}${agent.executor === 'chief' ? '<span class="tag">Orchestrates</span>' : ''}</div></a>`).join('')}</div></div>`;
  view.querySelectorAll('[data-employee]').forEach((card) => { card.onclick = (event) => { event.preventDefault(); openEmployee(card.dataset.employee); }; });
}

const NODE_WORD = { done: 'Done', working: 'Working', waiting: 'Waiting', ready: 'Starting', failed: 'Failed', blocked: 'Blocked', capacity: 'Waiting for free model capacity — will resume automatically' };
async function renderWorkflow(jobId) {
  let signature = '';
  const load = async () => {
    const data = await api(`/api/workflows/${jobId}`);
    const next = JSON.stringify(data);
    if (next === signature) return data.job.status;
    signature = next;
    setTitle(data.job.title);
    const byId = new Map(data.nodes.map((node) => [node.id, node]));
    const streams = data.nodes.filter((node) => node.kind !== 'plan' && node.kind !== 'synthesis');
    const plan = data.nodes.find((node) => node.kind === 'plan');
    const syntheses = data.nodes.filter((node) => node.kind === 'synthesis');
    const needs = (node) => node.dependsOn.map((id) => byId.get(id)).filter((dep) => dep && dep.kind !== 'plan' && dep.kind !== 'synthesis').map((dep) => dep.agentLabel);
    const nodeRow = (node) => `<div class="flow-node st-${esc(node.state)}"><span class="flow-icon">${FLOW_ICON[node.state] || '○'}</span>
      <div class="grow"><div><strong>${esc(node.agentLabel)}</strong> — ${esc(node.title)}${node.revision ? ' <span class="pill st-waiting">revision</span>' : ''}</div>
      <div class="xs faint">${esc(NODE_WORD[node.state] || node.state)}${needs(node).length ? ` · after ${esc([...new Set(needs(node))].join(', '))}` : ''}${node.completedAt ? ` · ${when(node.completedAt)}` : ''}${node.state === 'capacity' && node.resumesAt ? ` · retry ${esc(new Date(node.resumesAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}` : ''}</div>
      ${node.codingTask ? `<a class="xs" href="#/task/${esc(node.codingTask.id)}">Coding Agent task: ${esc(STATUS_WORDS[node.codingTask.status] || node.codingTask.status)} · ${esc(stageWord(node.codingTask.phase))}</a>` : ''}
      ${node.output?.summary ? `<div class="small" dir="auto">${esc(node.output.summary)}</div>` : ''}</div></div>`;
    view.innerHTML = `<div class="page stack">
      <div class="page-head"><div><div class="row">${pill(data.job.status === 'completed' ? 'completed' : data.job.status === 'failed' ? 'failed' : 'running', data.job.status === 'completed' ? 'Completed' : data.job.status === 'failed' ? 'Failed' : 'In progress')}<span class="small muted">${data.job.progress}% · ${usd(data.job.costUsd)}</span>${data.job.conversationId ? `<a class="small" href="#/chat/${esc(data.job.conversationId)}">Open chat</a>` : ''}</div>
        <h1 dir="auto">${esc(data.job.title)}</h1><p dir="auto">${esc(data.job.objective)}</p></div></div>
      <div class="card"><h2 class="card-title">Workflow</h2>
        <div class="flow-node st-done"><span class="flow-icon">✓</span><div class="grow"><strong>Fahad</strong> — gave the objective</div></div>
        ${plan ? nodeRow({ ...plan, agentLabel: 'CHIEF', title: 'Split the objective into workstreams' }) : ''}
        <div class="flow-branch">${streams.map(nodeRow).join('') || '<div class="muted small">No workstreams (CHIEF answered alone).</div>'}</div>
        ${syntheses.map((node) => nodeRow({ ...node, title: node.title === 'Chief final synthesis' ? 'Final synthesis after revisions' : 'Consolidate the team’s work' })).join('')}
        <div class="flow-node st-${data.final ? 'done' : 'waiting'}"><span class="flow-icon">${data.final ? '✓' : '○'}</span><div class="grow"><strong>Fahad</strong> — ${data.final ? 'received the result' : 'will receive the result'}</div></div>
        ${data.participants.length ? `<div class="xs faint" style="margin-top:var(--s-2)">Team: ${esc(data.participants.map((entry) => entry.label).join(', '))}</div>` : ''}</div>
      ${data.decisions.length ? `<div class="owner-card"><h2>Decisions for Fahad</h2>${data.decisions.map((decision) => `<div class="owner-item"><div class="small muted">${esc(decision.from)}</div>${markdown(decision.text)}</div>`).join('')}</div>` : ''}
      ${data.final ? `<div class="card"><h2 class="card-title">Final result — CHIEF</h2>${markdown(data.final.content)}</div>` : ''}
      ${data.artifacts?.some((artifact) => artifact.agent !== 'chief') ? `<div class="card"><h2 class="card-title">Team artifacts</h2>${data.artifacts.filter((artifact) => artifact.agent !== 'chief').map(renderArtifact).join('')}</div>` : ''}
      ${data.consults?.length ? `<details class="disclosure"><summary>Internal consults (${data.consults.length})</summary><div class="disclosure-body">${data.consults.map((entry) => entry.consults.map((consult) => `<div class="small"><strong>${esc(entry.from)}</strong> asked <strong>${esc(consult.to)}</strong>: <span dir="auto">${esc(consult.question)}</span></div>`).join('')).join('')}</div></details>` : ''}
      <div class="card"><h2 class="card-title">Outputs</h2>${data.nodes.filter((node) => node.output).map((node) => `<details class="disclosure"><summary>${esc(node.agentLabel)} — ${esc(node.title)}</summary><div class="disclosure-body">${markdown(node.output.content)}</div></details>`).join('') || '<div class="muted small">Outputs appear here as each employee delivers.</div>'}</div>
      ${data.handoffs.length ? `<details class="disclosure"><summary>Handoffs (${data.handoffs.length})</summary><div class="disclosure-body">${data.handoffs.map((handoff) => `<div class="small">${esc(handoff.from)} → ${esc(handoff.to)} <span class="faint">${when(handoff.at)}</span></div>`).join('')}</div></details>` : ''}
      ${data.revisions.length ? `<details class="disclosure"><summary>Revisions requested by CHIEF (${data.revisions.length})</summary><div class="disclosure-body">${data.revisions.map((revision) => `<div class="small">${esc(revision.workstream)}: ${esc(revision.instruction)}</div>`).join('')}</div></details>` : ''}
    </div>`;
    return data.job.status;
  };
  const status = await load();
  if (!['completed', 'failed', 'cancelled'].includes(status)) every(3000, () => load().catch(() => {}));
}

// ------------------------------------------------------------------ attention
// Needs Fahad: an executive interruption centre. URGENT first, then what
// needs an action, then information (major completions) — nothing routine.
async function renderAttention() {
  setTitle('Needs Fahad');
  const draw = async () => {
    const { items } = await api(`/api/attention${q({ workspaceId: ws() })}`);
    const href = (item) => (item.taskId ? `#/task/${esc(item.taskId)}` : item.jobId ? `#/workflow/${esc(item.jobId)}` : `#/chat/${esc(item.conversationId || '')}`);
    const group = (priority, title, hint) => {
      const list = items.filter((item) => item.priority === priority);
      if (!list.length) return '';
      return `<section class="nf-group nf-${esc(priority.toLowerCase().replace(/\s+/g, '-'))}"><h2><span class="nf-level">${esc(priority)}</span><span class="small muted">${esc(hint)}</span></h2>
        ${list.map((item) => `<a class="nf-item" href="${href(item)}"><span class="nf-cat">${esc(item.category || item.kind)}</span><span class="grow"><span class="nf-title" dir="auto">${esc(item.title)}</span>${item.detail ? `<span class="nf-detail" dir="auto">${esc(humanError(item.detail))}</span>` : ''}</span><time class="xs faint" datetime="${esc(item.at)}">${when(item.at)}</time></a>`).join('')}</section>`;
    };
    view.innerHTML = `<div class="page"><div class="page-head"><div><h1>Needs Fahad</h1><p class="page-summary">${esc(attentionSummary(items))}</p></div></div>
      ${items.some((item) => item.priority !== 'INFO') ? '' : '<div class="nf-clear"><strong>All clear.</strong> The Office asks here and on Telegram when it needs you.</div>'}
      ${group('URGENT', 'Urgent', 'high-risk approvals and critical security findings')}${group('ACTION NEEDED', 'Action needed', 'a decision or an answer unblocks the work')}${group('INFO', 'For your information', 'major work that finished in the last 3 days')}</div>`;
  };
  await draw();
  onLiveChange(() => { if (location.hash === '#/attention') draw().catch(() => {}); });
}

async function renderProjects() {
  setTitle('Projects');
  view.innerHTML = `<div class="page"><div class="page-head"><div><h1>Projects</h1><p class="page-summary">${esc(projectsSummary(state.workspaces, ws()))}</p></div></div>
    ${state.workspaces.map((workspace) => `<a class="list-item" href="#/project/${esc(workspace.id)}"><div class="grow"><div class="title">${esc(workspace.name)}</div></div>${workspace.id === ws() ? pill('available', 'Current') : ''}</a>`).join('')}</div>`;
}

// Command Center (and the project map) live in their own module.
async function renderProject(id, sub = '') {
  const module = await import('./project.js?v=__UI_VERSION__');
  const mode = ['map', 'continuity'].includes(sub) ? sub : 'center';
  return module.renderProject({ ...officeContext(), usd, confirmDialog, ask, memoryKinds: MEMORY_KINDS, memoryLabel: (kind) => MEMORY_LABEL[kind] || kind, openEmployee }, id, mode);
}
const MEMORY_LABEL = Object.fromEntries(MEMORY_KINDS);

// ------------------------------------------------------------------ artifacts
// The artifact library (and its viewer/exports) is its own module.
const DIRECT_SLUGS = Object.freeze({ research: 'research-strategy', creative: 'brand-creative', product: 'product-tech', finance: 'business-finance', audit: 'qa-security', social: 'content-media', legal: 'legal-compliance' });
function libraryContext() { return { ...officeContext(), labels: ARTIFACT_LABELS, workspaces: () => state.workspaces, directSlugs: DIRECT_SLUGS, confirmDialog }; }
async function renderArtifacts(type = '') {
  return (await import('./library.js?v=__UI_VERSION__')).renderLibrary(libraryContext(), ARTIFACT_LABELS[type] ? type : '');
}

// ------------------------------------------------------------------ integrations
// Reality only: CONNECTED means a real successful use was recorded.
const CONNECTION = Object.freeze({ CONNECTED: 'CONNECTED', CONFIGURED: 'CONFIGURED', NOT_CONFIGURED: 'NOT CONFIGURED', ACCOUNT: 'ACCOUNT ACTION REQUIRED', UNAVAILABLE: 'UNAVAILABLE' });
function connection(status = '') {
  if (/^Connected|^Available/.test(status)) return CONNECTION.CONNECTED;
  if (/^Configured/.test(status)) return CONNECTION.CONFIGURED;
  if (/account/i.test(status)) return CONNECTION.ACCOUNT;
  if (/^Not configured/.test(status)) return CONNECTION.NOT_CONFIGURED;
  return CONNECTION.UNAVAILABLE;
}
const CONNECTION_TONE = { CONNECTED: 'ok', CONFIGURED: 'configured', 'NOT CONFIGURED': 'off', 'ACCOUNT ACTION REQUIRED': 'account', UNAVAILABLE: 'unavailable' };
async function renderIntegrations() {
  setTitle('Integrations');
  view.innerHTML = `<div class="page page-wide"><div class="page-head"><div><h1>Integrations</h1><p class="page-summary" id="intSummary" aria-live="polite">What the Office can actually use.</p><p class="small muted"><strong>Connected</strong> means a real successful use was recorded — configuration alone never counts.</p></div></div>
    <div class="conn-legend">${Object.values(CONNECTION).map((value) => `<span class="conn-badge conn-${CONNECTION_TONE[value]}">${esc(value)}</span>`).join('')}</div><div id="capabilities"><div class="drawer-loading"></div></div></div>`;
  const [{ capabilities }, models] = await Promise.all([api('/api/capabilities'), api(`/api/models${q({ workspaceId: ws() })}`).catch(() => null)]);
  const groups = [['Work tools', ['github', 'repository', 'pull_requests', 'ci', 'deployment', 'supabase_tools', 'tool_broker']], ['Research', ['web_search', 'web_fetch']], ['Channels', ['telegram']], ['Office data', ['database', 'memory']]];
  const card = (item) => { const value = connection(item.status); return `<div class="int-card"><div class="int-top"><strong>${esc(item.label)}</strong><span class="conn-badge conn-${CONNECTION_TONE[value]}">${esc(value)}</span></div><div class="small muted">${esc(item.detail)}</div>${item.employees?.length ? `<div class="row">${item.employees.map((label) => `<span class="tag muted">${esc(label)}</span>`).join('')}</div>` : ''}</div>`; };
  const providers = new Map();
  for (const model of models?.models || []) {
    const current = providers.get(model.provider) || { provider: model.provider, statuses: [], reasons: [] };
    current.statuses.push(model.status); current.reasons.push(model.reason);
    providers.set(model.provider, current);
  }
  const providerState = (entry) => (entry.statuses.includes('AVAILABLE') || entry.statuses.includes('COOLDOWN') ? CONNECTION.CONNECTED : entry.statuses.includes('ACCOUNT ACTION REQUIRED') ? CONNECTION.ACCOUNT
    : entry.reasons.some((reason) => /No credential/i.test(reason)) ? CONNECTION.NOT_CONFIGURED : CONNECTION.UNAVAILABLE);
  $('#intSummary').textContent = integrationsSummary(capabilities.filter((item) => groups.some(([, ids]) => ids.includes(item.id))).map((item) => connection(item.status)));
  $('#capabilities').innerHTML = groups.map(([title, ids]) => `<section class="int-group"><h2 class="int-title">${esc(title)}</h2><div class="int-grid">${capabilities.filter((item) => ids.includes(item.id)).map(card).join('')}</div></section>`).join('')
    + (providers.size ? `<section class="int-group"><h2 class="int-title">Model providers</h2><div class="int-grid">${[...providers.values()].map((entry) => { const value = providerState(entry); return `<div class="int-card"><div class="int-top"><strong>${esc(entry.provider)}</strong><span class="conn-badge conn-${CONNECTION_TONE[value]}">${esc(value)}</span></div><div class="small muted">${entry.statuses.length} model${entry.statuses.length === 1 ? '' : 's'} · ${esc(humanError(entry.reasons.find((reason) => reason) || ''))}</div></div>`; }).join('')}</div><p class="xs muted">Details per model: <a href="#/models">Models</a>.</p></section>` : '');
}

// ------------------------------------------------------------------ models
async function renderModels() {
  setTitle('Models');
  const [data, office] = await Promise.all([api(`/api/models${q({ workspaceId: ws() })}`), api(`/api/office${q({ workspaceId: ws() })}`).catch(() => null)]);
  const kind = { AVAILABLE: 'available', COOLDOWN: 'cooldown', 'ACCOUNT ACTION REQUIRED': 'account', UNAVAILABLE: 'unavailable' };
  const waiting = (office?.agents || []).filter((agent) => agent.state === 'WAITING' && /free model capacity/i.test(agent.detail || ''));
  const counts = Object.entries(data.counts).map(([status, count]) => `${pill(kind[status], `${count} ${status.toLowerCase()}`)}`).join(' ');
  view.innerHTML = `<div class="page page-wide"><div class="page-head"><div><h1>Models</h1><p class="page-summary">${esc(modelsSummary(data.counts, waiting.length))}</p><p class="small muted">Routing is <strong>AUTO</strong>: the Office picks the best available model for each job, free first where suitable, and fails over automatically. You never have to choose.</p></div></div>
    <div class="row" style="margin-bottom:var(--s-4)">${counts}</div>
    ${waiting.length ? `<div class="capacity-banner" role="status"><strong>WAITING_FOR_CAPACITY</strong> · ${waiting.map((agent) => `${esc(agent.label)}${agent.assignment?.resumesAt ? ` (~${esc(new Date(agent.assignment.resumesAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))})` : ''}`).join(', ')} — Waiting for free model capacity — will resume automatically.</div>` : ''}
    <details class="disclosure"><summary>Model pool (advanced)</summary><div class="disclosure-body"><div class="table-wrap"><table class="table"><thead><tr><th>Model</th><th>Status</th><th class="hide-sm">Cost</th><th class="hide-sm">Order</th><th class="hide-sm">Health</th><th class="hide-sm">Why</th></tr></thead><tbody>
    ${data.models.map((model) => { const reason = esc(model.reason.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, (iso) => new Date(iso).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' }))); return `<tr><td><div class="mono small" style="overflow-wrap:anywhere">${esc(model.model)}</div><div class="xs faint">${esc(model.provider)} · ${esc(model.billing)}</div><div class="xs muted show-sm">${reason}</div></td><td>${pill(kind[model.status], model.status)}</td><td class="hide-sm">${esc(model.billing)}</td><td class="hide-sm">${model.order || '—'}</td><td class="hide-sm">${esc(model.health)}</td><td class="small muted hide-sm" style="min-width:180px">${reason}</td></tr>`; }).join('')}
    </tbody></table></div><p class="xs muted" style="margin-top:var(--s-2)">An unavailable or account-blocked model never blocks the others. The full technical dashboard is under <a href="./classic">Classic view → Platform</a>.</p></div></details></div>`;
}

// ------------------------------------------------------------------ settings
async function renderSettings() {
  setTitle('Settings');
  let health = null;
  try { health = await (await fetch('./healthz')).json(); } catch {}
  view.innerHTML = `<div class="page stack"><div class="page-head"><div><h1>Settings</h1></div></div>
    <div class="card"><h2 class="card-title">Account</h2><p class="small muted">Signed in as the owner. Sessions last 7 days.</p><button class="btn" id="logout">Sign out</button></div>
    <div class="card"><h2 class="card-title">Appearance</h2><div class="chips" id="themeChips">${[['auto', 'System'], ['dark', 'Dark'], ['light', 'Light']].map(([value, label]) => `<button class="chip" data-theme-choice="${value}">${label}</button>`).join('')}</div></div>
    <div class="card"><h2 class="card-title">Office view</h2>
      <p class="small muted">The immersive 3D Office is in beta. Auto keeps the light Office unless you allow immersive below; small screens always use the light Office.</p>
      <label class="check"><input type="checkbox" id="autoImmersive"> <span>Use the immersive Office for Auto on capable desktops</span></label>
      <label class="small muted" for="officeQuality" style="display:block;margin-top:var(--s-3)">Immersive quality (advanced)</label>
      <select class="input input-sm" id="officeQuality" style="max-width:220px"><option value="">Automatic</option><option value="high">High</option><option value="balanced">Balanced</option><option value="light">Light</option></select></div>
    <div class="card"><h2 class="card-title">Tools &amp; connectors</h2><p class="small muted">See <a href="#/integrations">Integrations</a> for every connector and the employees that use it.</p></div>
    <div class="card"><h2 class="card-title">System</h2><dl class="kv"><div><dt>Hub</dt><dd>${health?.ok ? 'Healthy' : 'Unknown'}</dd></div><div><dt>Version</dt><dd class="mono small">${esc(String(health?.version || '—').slice(0, 12))}</dd></div></dl>
      <p class="small muted" style="margin-top:var(--s-3)">Technical dashboards (Platform, detailed model pool, legacy Coding Agent form) remain in the <a href="./classic">classic view</a>.</p></div></div>`;
  let current = 'auto';
  try { current = localStorage.getItem('hub-theme') || 'auto'; } catch {}
  const mark = () => document.querySelectorAll('[data-theme-choice]').forEach((chip) => chip.classList.toggle('active', chip.dataset.themeChoice === current));
  mark();
  bind(view, { '[data-theme-choice]': (_, element) => { current = element.dataset.themeChoice; try { localStorage.setItem('hub-theme', current); } catch {} applyTheme(current); mark(); } });
  const pref = (key) => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };
  const setPref = (key, value) => { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch {} };
  $('#autoImmersive').checked = pref('hub-office-auto-immersive') === 'on';
  $('#autoImmersive').onchange = (event) => setPref('hub-office-auto-immersive', event.target.checked ? 'on' : '');
  $('#officeQuality').value = pref('hub-office-quality');
  $('#officeQuality').onchange = (event) => setPref('hub-office-quality', event.target.value);
  $('#logout').onclick = async () => { await fetch('./api/auth/logout', { method: 'POST' }).catch(() => {}); location.reload(); };
}

// ------------------------------------------------------------------ dialogs
function dialog({ title, body = '', input = null, confirm = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const element = document.createElement('dialog');
    element.className = 'card';
    element.style.cssText = 'max-width:440px;width:calc(100vw - 32px);color:var(--text);border:1px solid var(--border-strong)';
    element.innerHTML = `<form method="dialog"><h2 class="card-title">${esc(title)}</h2>${body ? `<p class="small muted">${esc(body)}</p>` : ''}${input !== null ? `<textarea class="input" rows="${input.multiline ? 3 : 1}" dir="auto">${esc(input.value)}</textarea>` : ''}<div class="row" style="justify-content:flex-end;margin-top:var(--s-4)"><button class="btn btn-ghost" value="cancel">Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" value="ok">${esc(confirm)}</button></div></form>`;
    document.body.append(element);
    element.addEventListener('close', () => {
      const ok = element.returnValue === 'ok';
      const value = element.querySelector('textarea')?.value.trim();
      element.remove();
      resolve(input !== null ? (ok ? value ?? '' : null) : ok);
    });
    element.showModal();
    element.querySelector('textarea')?.focus();
  });
}
const ask = (title, value = '', multiline = false) => dialog({ title, input: { value, multiline } });
const confirmDialog = (title, body) => dialog({ title, body, confirm: 'Yes', danger: true });

boot();
