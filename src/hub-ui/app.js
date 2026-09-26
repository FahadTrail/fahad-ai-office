// Fahad AI Office — Workspace V2 client. No framework: hash routes render
// views from the Hub's JSON API; polling keeps running work live.
import { escapeHtml as esc, renderMarkdown } from './markdown.js';

const $ = (selector, root = document) => root.querySelector(selector);
const view = $('#view');
const state = { workspaceId: null, workspaces: [], conversations: [], timers: [], attention: { action: 0, total: 0 } };

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
  element.textContent = message;
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
function clearTimers() { state.timers.forEach(clearInterval); state.timers = []; }
function setTitle(text) { document.title = text ? `${text} · Fahad AI Office` : 'Fahad AI Office'; $('#topTitle').textContent = text || 'Fahad AI Office'; }
function autosize(textarea) { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`; }
function markdown(text) {
  const html = renderMarkdown(text);
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
async function showLogin() {
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
        if (!response.ok) throw new Error('That email cannot sign in.');
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
    view.innerHTML = `<div class="page"><div class="error-note">${esc(error.message)}</div></div>`;
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
    location.hash = '#/';
  };
  $('#menuButton').onclick = () => toggleSidebar(true);
  $('#sidebarClose').onclick = () => toggleSidebar(false);
  $('#scrim').onclick = () => toggleSidebar(false);
  window.addEventListener('hashchange', route);
  await refreshSidebar();
  setInterval(refreshSidebar, 20_000);
  route();
}
function toggleSidebar(open) {
  $('#sidebar').classList.toggle('open', open);
  $('#scrim').classList.toggle('hidden', !open);
}
async function refreshSidebar() {
  if (!ws()) return;
  try {
    const [{ conversations }, attention, { tasks }] = await Promise.all([
      api(`/api/conversations${q({ workspaceId: ws() })}`),
      api(`/api/attention${q({ workspaceId: ws() })}`),
      api(`/api/tasks${q({ workspaceId: ws(), status: 'running' })}`),
    ]);
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
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.nav === key));
}

// ------------------------------------------------------------------ router
async function route() {
  clearTimers();
  toggleSidebar(false);
  const hash = location.hash || '#/';
  const [, section = '', id = ''] = hash.match(/^#\/([\w-]*)\/?([\w-]*)/) || [];
  const routes = {
    '': () => renderChat(null), chat: () => renderChat(id), chats: renderChats, tasks: () => renderTasks(id || 'running'), task: () => renderTask(id),
    code: renderNewTask, attention: renderAttention, projects: renderProjects, project: () => renderProject(id), models: renderModels, settings: renderSettings,
  };
  markNav({ '': 'chat', chat: 'chats', task: 'tasks', project: 'projects' }[section] ?? section);
  document.querySelectorAll('#recentChats a').forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#/chat/${id}`));
  try {
    await (routes[section] || routes[''])();
  } catch (error) {
    view.innerHTML = `<div class="page"><div class="error-note">${esc(error.message)}</div></div>`;
  }
  view.focus({ preventScroll: true });
}

// ------------------------------------------------------------------ chat
const SUGGESTIONS = [
  'Summarize what changed in the Office this week',
  'Fix a bug: describe it and I will start a development task',
  'Research the best free models for coding right now',
  'Draft a short project update for my team',
];

async function renderChat(id) {
  let conversation = null;
  let messages = [];
  if (id) ({ conversation, messages } = await api(`/api/conversations/${id}`));
  setTitle(conversation?.title || 'New chat');
  view.innerHTML = `<div class="chat">
    ${conversation ? `<div class="chat-head">
      <div class="chat-title" dir="auto" id="chatTitle">${esc(conversation.title)}</div>
      <button class="btn btn-ghost btn-sm" id="renameChat">Rename</button>
      <button class="btn btn-ghost btn-sm" id="archiveChat">${conversation.archived ? 'Unarchive' : 'Archive'}</button>
      <button class="btn btn-ghost btn-sm" id="deleteChat">Delete</button>
    </div>` : ''}
    <div class="chat-scroll" id="chatScroll">${conversation ? '<div class="messages" id="messages"></div>' : welcome()}</div>
    <div class="composer-wrap">
      <form class="composer" id="composer">
        <label class="sr-only" for="prompt">Message</label>
        <textarea id="prompt" rows="1" dir="auto" placeholder="${conversation ? 'Reply…' : 'Ask anything or describe a task…'}"></textarea>
        <button class="btn btn-danger hidden" type="button" id="stopButton">Stop</button>
        <button class="btn btn-primary" type="submit" id="sendButton">Send</button>
      </form>
      <div class="composer-hint">The Chief of Staff decides who does the work. Development requests start a tracked task automatically.</div>
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
        const created = await api('/api/conversations', { method: 'POST', body: { workspaceId: ws(), message: text } });
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
  if (!conversation) { prompt.focus(); return; }

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
    const signature = JSON.stringify(messages.map((message) => [message.jobId, message.assistant.status, message.assistant.stage, message.assistant.text.length, message.assistant.tasks.map((task) => task.status + task.phase)]));
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

function welcome() {
  return `<div class="welcome">
    <div class="brand-mark" style="width:48px;height:48px;margin:auto;font-size:22px">F</div>
    <h1>What can I do for you, Fahad?</h1>
    <p class="muted">Ask a question, get research or writing done, or describe a change to your code. I'll pick the right agents and models.</p>
    <div class="suggestions">${SUGGESTIONS.map((text) => `<button class="suggestion" type="button" data-text="${esc(text)}">${esc(text)}</button>`).join('')}</div>
  </div>`;
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
  return `${user}<div class="msg msg-office"><div class="bubble">${body}${tasks}${meta}</div></div>`;
}
const PHASE_WORDS = { understand: 'Understanding', plan: 'Planning', implement: 'Editing', test: 'Testing', debug: 'Debugging', review: 'Reviewing', publish: 'Opening the pull request', ci: 'Waiting for CI', deploy: 'Deploying', verify: 'Verifying', report: 'Wrapping up', done: 'Done' };
const stageWord = (phase) => PHASE_WORDS[phase] || phase || '';
const taskGroup = (status) => (['awaiting_approval', 'blocked'].includes(status) ? 'attention' : status === 'queued' ? 'running' : status);

async function renderChats() {
  setTitle('Chats');
  view.innerHTML = `<div class="page"><div class="page-head"><div><h1>Chats</h1><p>Every conversation with the Office, newest first.</p></div><a class="btn btn-primary" href="#/">＋ New chat</a></div>
    <div class="row" style="margin-bottom:var(--s-4)"><input id="chatSearch" class="input grow" placeholder="Search chats…" dir="auto"><button id="showArchived" class="btn">Archived</button></div>
    <div id="chatList"></div></div>`;
  let archived = false;
  const load = async () => {
    const { conversations } = await api(`/api/conversations${q({ workspaceId: ws(), archived, q: $('#chatSearch').value.trim() })}`);
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
  view.innerHTML = `<div class="page"><div class="page-head"><div><h1>Tasks</h1><p>Development work the Office is doing or has done.</p></div><a class="btn btn-primary" href="#/code">＋ New task</a></div>
    <div class="tabs" role="tablist">${TASK_TABS.map(([key, label]) => `<a class="tab ${key === tab ? 'active' : ''}" role="tab" href="#/tasks/${key}">${label}</a>`).join('')}</div>
    <div id="taskList"></div></div>`;
  const load = async () => {
    const { tasks } = await api(`/api/tasks${q({ workspaceId: ws(), status: tab })}`);
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
    ${result.summary ? markdown(result.summary) : t.blocker && t.status === 'failed' ? `<div class="error-note">${esc(t.blocker)}</div>` : '<p class="muted small">The summary appears here when the task finishes.</p>'}
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

// ------------------------------------------------------------------ attention
async function renderAttention() {
  setTitle('Needs attention');
  const { items } = await api(`/api/attention${q({ workspaceId: ws() })}`);
  const labels = { approval: 'Approval waiting', question: 'Question for you', blocked: 'Paused', failed: 'Failed', completed: 'Completed' };
  const pillKind = { approval: 'attention', question: 'attention', blocked: 'attention', failed: 'failed', completed: 'completed' };
  view.innerHTML = `<div class="page"><div class="page-head"><div><h1>Needs attention</h1><p>What is waiting for you, and what finished recently (last 3 days).</p></div></div>
    ${items.length ? items.map((item) => `<a class="list-item" href="${item.taskId ? `#/task/${esc(item.taskId)}` : `#/chat/${esc(item.conversationId || '')}`}"><div class="grow"><div class="title" dir="auto">${esc(item.title)}</div><div class="sub" dir="auto">${esc(item.detail || '')}</div><div class="sub faint xs">${when(item.at)}</div></div>${pill(pillKind[item.kind] || 'cancelled', labels[item.kind] || item.kind)}</a>`).join('')
      : '<div class="empty"><h3>All clear</h3><p>Nothing needs you right now.</p></div>'}</div>`;
  every(10_000, async () => { if (location.hash === '#/attention') { clearTimers(); renderAttention().catch(() => {}); } });
}

// ------------------------------------------------------------------ projects
async function renderProjects() {
  setTitle('Projects');
  view.innerHTML = `<div class="page"><div class="page-head"><div><h1>Projects</h1><p>Each project keeps its chats, tasks, repository and memory together.</p></div></div>
    ${state.workspaces.map((workspace) => `<a class="list-item" href="#/project/${esc(workspace.id)}"><div class="grow"><div class="title">${esc(workspace.name)}</div></div>${workspace.id === ws() ? pill('available', 'Current') : ''}</a>`).join('')}</div>`;
}

async function renderProject(id) {
  const { project, memory, stats } = await api(`/api/projects/${id}`);
  setTitle(project.name);
  view.innerHTML = `<div class="page stack"><div class="page-head"><div><h1>${esc(project.name)}</h1><p>${stats.conversations} chats · ${stats.tasks} tasks (${stats.completedTasks} completed)</p></div>${id !== ws() ? '<button class="btn" id="useProject">Switch to this project</button>' : ''}</div>
    <form class="card" id="projectForm"><h2 class="card-title">Context</h2>
      <label class="field-label" for="pDesc">What this project is (the Chief reads this)</label><textarea id="pDesc" class="input" rows="4" dir="auto">${esc(project.description)}</textarea>
      <label class="field-label" for="pRepo">Default repository for tasks</label><input id="pRepo" class="input" value="${esc(project.defaultRepository)}" placeholder="owner/name">
      <div class="row" style="margin-top:var(--s-3)"><button class="btn btn-primary" type="submit">Save</button></div></form>
    <div class="card"><h2 class="card-title">Memory</h2><p class="small muted">Facts, decisions and preferences the Office reuses in new chats and tasks.</p>
      <form class="row" id="memoryForm"><select id="mKind" class="input input-sm" style="width:auto"><option value="fact">Fact</option><option value="decision">Decision</option><option value="preference">Preference</option></select><input id="mText" class="input input-sm grow" dir="auto" placeholder="e.g. Production runs on the Hostinger VPS"><button class="btn btn-sm" type="submit">Add</button></form>
      <div style="margin-top:var(--s-3)">${memory.map((item) => `<div class="list-item"><div class="grow"><div class="sub faint xs">${esc(item.kind)}</div><div dir="auto">${esc(item.content)}</div></div><button class="icon-btn" data-forget="${esc(item.id)}" aria-label="Remove">✕</button></div>`).join('') || '<div class="muted small">Nothing remembered yet.</div>'}</div></div></div>`;
  $('#projectForm').onsubmit = async (event) => {
    event.preventDefault();
    try { await api(`/api/projects/${id}`, { method: 'PATCH', body: { description: $('#pDesc').value, defaultRepository: $('#pRepo').value } }); toast('Saved'); } catch (error) { toast(error.message); }
  };
  $('#memoryForm').onsubmit = async (event) => {
    event.preventDefault();
    try { await api(`/api/projects/${id}/memory`, { method: 'POST', body: { kind: $('#mKind').value, content: $('#mText').value } }); renderProject(id); } catch (error) { toast(error.message); }
  };
  bind(view, {
    '[data-forget]': async (_, element) => { await api(`/api/projects/${id}/memory/${element.dataset.forget}`, { method: 'DELETE' }); renderProject(id); },
    '#useProject': () => { $('#projectSelect').value = id; $('#projectSelect').onchange(); },
  });
}

// ------------------------------------------------------------------ models
async function renderModels() {
  setTitle('Models');
  const data = await api(`/api/models${q({ workspaceId: ws() })}`);
  const kind = { AVAILABLE: 'available', COOLDOWN: 'cooldown', 'ACCOUNT ACTION REQUIRED': 'account', UNAVAILABLE: 'unavailable' };
  const counts = Object.entries(data.counts).map(([status, count]) => `${pill(kind[status], `${count} ${status.toLowerCase()}`)}`).join(' ');
  view.innerHTML = `<div class="page page-wide"><div class="page-head"><div><h1>Models</h1><p>Routing is <strong>AUTO</strong>: the Office picks the best available model for each job, free first where suitable, and fails over automatically. You never have to choose.</p></div></div>
    <div class="row" style="margin-bottom:var(--s-4)">${counts}</div>
    <details class="disclosure" open><summary>Model pool (advanced)</summary><div class="disclosure-body"><div class="table-wrap"><table class="table"><thead><tr><th>Model</th><th>Status</th><th class="hide-sm">Cost</th><th class="hide-sm">Order</th><th class="hide-sm">Health</th><th class="hide-sm">Why</th></tr></thead><tbody>
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
    <div class="card"><h2 class="card-title">System</h2><dl class="kv"><div><dt>Hub</dt><dd>${health?.ok ? 'Healthy' : 'Unknown'}</dd></div><div><dt>Version</dt><dd class="mono small">${esc(String(health?.version || '—').slice(0, 12))}</dd></div></dl>
      <p class="small muted" style="margin-top:var(--s-3)">Technical dashboards (Platform, detailed model pool, legacy Coding Agent form) remain in the <a href="./classic">classic view</a>.</p></div></div>`;
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
