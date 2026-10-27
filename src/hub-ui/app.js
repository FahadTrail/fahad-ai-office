// Fahad AI Office — Workspace V2 client. No framework: hash routes render
// views from the Hub's JSON API; polling keeps running work live.
import { attentionSummary, chatsSummary, employeesSummary, integrationsSummary, modelsSummary, projectsSummary, tasksSummary } from './summaries.js';
import { capacitySentence, countLabel, defaultProject, healthFacts, knownNumber, latestResults, ownerWorkCounts, progressWidth, projectFacts } from './owner-facts.js';
import { escapeHtml as esc, renderMarkdown } from './markdown.js';
import { loginErrorMessage } from './auth.js';
import { ARTIFACT_LABELS, renderArtifact, splitArtifacts } from './artifacts.js';
import { errorBlock, humanError } from './humanize.js';
import { renderArchive as renderArchiveScreen, renderJobDetail, renderOfficeHome } from './screens.js';

const $ = (selector, root = document) => root.querySelector(selector);
const COPY = {
  ar: {
    askChief: '＋ اسأل CHIEF', workspace: 'مساحة العمل', home: 'الرئيسية', office: 'المكتب', archive: 'الأرشيف', projects: 'المشاريع', team: 'الفريق', work: 'العمل', approvals: 'الموافقات',
    continuity: 'الاستمرارية', platform: 'المنصة', models: 'النماذج والمزوّدين', deliverables: 'المخرجات', settings: 'الإعدادات', more: 'المزيد', artifacts: 'الملفات',
    liveOffice: 'المكتب المباشر', chats: 'المحادثات', integrations: 'الأدوات والصلاحيات', search: 'بحث', currentProject: 'المشروع الحالي', needsYou: 'يحتاجك',
  },
  en: {
    askChief: '＋ Ask CHIEF', workspace: 'Workspace', home: 'Home', office: 'Office', archive: 'Archive', projects: 'Projects', team: 'Team', work: 'Work', approvals: 'Approvals',
    continuity: 'Continuity', platform: 'Platform', models: 'Models & providers', deliverables: 'Deliverables', settings: 'Settings', more: 'More', artifacts: 'Files',
    liveOffice: 'Live Office', chats: 'Chats', integrations: 'Tools & permissions', search: 'Search', currentProject: 'Current project', needsYou: 'Needs you',
  },
};
function savedLanguage() { try { return localStorage.getItem('hub-language') || 'ar'; } catch { return 'ar'; } }
function applyLanguage(language = savedLanguage()) {
  const value = language === 'en' ? 'en' : 'ar';
  document.documentElement.lang = value;
  document.documentElement.dir = value === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach((element) => { element.textContent = COPY[value][element.dataset.i18n] || element.textContent; });
  return value;
}
function applyTheme(theme) {
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme;
}
try { applyTheme(localStorage.getItem('hub-theme')); } catch {}
// The view root. A Settings section renders its panel by pointing `view` at
// the panel until the next navigation resets it (route()).
const viewRoot = $('#view');
let view = viewRoot;
const MEMORY_KINDS = [['fact', 'Fact'], ['decision', 'Decision'], ['preference', 'Preference'], ['constraint', 'Constraint'], ['product_decision', 'Product decision'], ['technical_decision', 'Technical decision'], ['brand_decision', 'Brand decision'], ['legal_requirement', 'Legal requirement'], ['financial_assumption', 'Financial assumption']];
const state = { workspaceId: null, workspaces: [], conversations: [], timers: [], leave: [], attention: { action: 0, total: 0 }, sidebarTimer: null, signedOut: false, language: applyLanguage() };

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
  if (diff < 60) return state.language === 'ar' ? 'الحين' : 'just now';
  if (diff < 3600) return state.language === 'ar' ? `قبل ${Math.floor(diff / 60)} د` : `${Math.floor(diff / 60)} min ago`;
  const locale = state.language === 'ar' ? 'ar-AE' : 'en';
  if (diff < 86400 && date.getDate() === new Date().getDate()) return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
const usd = (value) => `$${Number(value || 0).toFixed(Number(value || 0) < 0.1 ? 4 : 2)}`;
const unavailableText = () => (state.language === 'ar' ? 'غير متاح' : 'Unavailable');
const moneyText = (value) => (knownNumber(value) == null ? unavailableText() : usd(knownNumber(value)));
const countText = (value) => countLabel(value) ?? '—';
const percentText = (value) => (knownNumber(value) == null ? '—' : `${knownNumber(value)}%`);
const tokens = (value) => (knownNumber(value) == null ? '—' : value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}K` : String(value));
const STATUS_WORDS = { queued: 'Queued', running: 'Running', awaiting_approval: 'Needs approval', blocked: 'Needs you', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', planning: 'Thinking', attention: 'Needs attention' };
function statusLabel(status) {
  const arabic = { queued: 'بالانتظار', running: 'قيد التنفيذ', awaiting_approval: 'يحتاج موافقة', blocked: 'يحتاجك', completed: 'مكتمل', failed: 'فشل', cancelled: 'ملغي', planning: 'تفكير', attention: 'يحتاج انتباه' };
  if (state.language === 'ar' && arabic[status]) return arabic[status];
  return STATUS_WORDS[status] || status;
}
const CATEGORY_LABEL = { APPROVAL: ['موافقة', 'APPROVAL'], 'ANSWER REQUIRED': ['جواب مطلوب', 'ANSWER REQUIRED'], 'NEEDS OWNER': ['يحتاجك', 'NEEDS OWNER'], 'FAILED TASK': ['مهمة فشلت', 'FAILED TASK'], COMPLETED: ['مكتمل', 'COMPLETED'], 'LEGAL DECISION': ['قرار قانوني', 'LEGAL DECISION'], 'SECURITY DECISION': ['قرار أمني', 'SECURITY DECISION'], 'PROJECT COMPLETE': ['اكتمل المشروع', 'PROJECT COMPLETE'] };
const categoryLabel = (value) => (CATEGORY_LABEL[value] ? CATEGORY_LABEL[value][state.language === 'ar' ? 0 : 1] : (value || ''));
const OWNER_PHRASE = { 'Waiting for your approval.': 'ينتظر موافقتك.', 'Completed.': 'مكتمل.', 'The team delivered; CHIEF consolidated the result.': 'الفريق سلّم، وCHIEF جمع النتيجة.',
  'The Office could not finish this request. Open it to resume where it stopped; delivered work is kept.': 'المكتب ما قدر يكمّل هالطلب. افتحه واستأنف من حيث وقف، وما تم تسليمه يبقى محفوظ.', 'The task failed.': 'تعثّرت المهمة.' };
const ownerPhrase = (text) => (state.language === 'ar' && OWNER_PHRASE[text] ? OWNER_PHRASE[text] : (text || ''));
function agentStateLabel(name) {
  const arabic = { AVAILABLE: 'متاح', QUEUED: 'التالي', THINKING: 'يفكر', WORKING: 'يشتغل', TESTING: 'يختبر', REVIEWING: 'يراجع', WAITING: 'ينتظر', BLOCKED: 'متوقف', FAILED: 'فشل', 'NEEDS FAHAD': 'يحتاجك', COMPLETED: 'أنجز' };
  if (state.language === 'ar' && arabic[name]) return arabic[name];
  if (name === 'AVAILABLE') return 'Available';
  if (name === 'NEEDS FAHAD') return 'Needs you';
  return name || '';
}
const pill = (status, label) => `<span class="pill ${esc(status)}">${esc(label || statusLabel(status))}</span>`;
function every(ms, fn) { const id = setInterval(fn, ms); state.timers.push(id); return id; }
function clearTimers() { state.timers.forEach(clearInterval); state.timers = []; const leave = state.leave; state.leave = []; leave.forEach((fn) => { try { fn(); } catch {} }); }
function setTitle(text) { document.title = text ? `${text} · مكتب فهد` : 'مكتب فهد · AI Office'; }
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
  const preferred = defaultProject(state.workspaces, saved);
  state.workspaceId = preferred?.id || null;
  const select = $('#projectSelect');
  select.innerHTML = state.workspaces.map((workspace) => `<option value="${esc(workspace.id)}">${esc(workspace.name)}</option>`).join('');
  if (state.workspaceId) select.value = state.workspaceId;
  select.onchange = () => switchProject(select.value);
  // The "all sections" menu: closes on Escape, on an outside click and on navigation.
  const more = $('#navMore');
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && more.open) { more.open = false; more.querySelector('summary').focus(); } });
  document.addEventListener('click', (event) => { if (more.open && !more.contains(event.target)) more.open = false; });
  // Scroll edge: the translucent bar only gains its fade once content is beneath it.
  viewRoot.addEventListener('scroll', () => $('#topnav').classList.toggle('is-scrolled', viewRoot.scrollTop > 4), { passive: true });
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
function switchProject(id) {
  if (!id || !state.workspaces.some((workspace) => workspace.id === id)) return;
  state.workspaceId = id;
  $('#projectSelect').value = id;
  try { localStorage.setItem('hub-workspace-id', id); } catch {}
  refreshSidebar();
  connectLive();
  if (!location.hash || location.hash === '#/' || location.hash === '#/home') route();
  else location.hash = '#/';
}
function closeMenu() { const more = $('#navMore'); if (more) more.open = false; }
// The top bar shows one live number: what needs Fahad (the Approvals page's
// count). One request, one at a time; a call during a load queues one more.
let navLoad = null;
let navAgain = false;
function refreshSidebar() {
  if (!ws()) return Promise.resolve();
  if (navLoad) { navAgain = true; return navLoad; }
  navLoad = api(`/api/attention${q({ workspaceId: ws() })}`).then((attention) => {
    state.attention = attention.counts;
    const count = $('#attentionCount');
    count.textContent = attention.counts.action;
    count.classList.toggle('hidden', !attention.counts.action);
    $('#topAttention').classList.toggle('hidden', !attention.counts.action);
  }).catch(() => {}).finally(() => {
    navLoad = null;
    if (navAgain) { navAgain = false; refreshSidebar(); }
  });
  return navLoad;
}
// Primary destinations: المكتب, الأرشيف and Settings. Every other page
// belongs to one of them for the active indicator, and to its own entry in
// the "all sections" menu.
const PRIMARY_OF = { '': 'home', home: 'home', chief: 'home', chat: 'home', chats: 'home', job: 'home', workflow: 'home', work: 'home', 'new-work': 'home', task: 'home', code: 'home', office: 'home', agent: 'home', talk: 'home', projects: 'home', project: 'home', deliverables: 'home', artifacts: 'home', archive: 'archive' };
function markNav(key, section = key) {
  const primary = PRIMARY_OF[section] ?? 'settings';
  document.querySelectorAll('.pnav, .nav-gear').forEach((item) => {
    const target = item.dataset.nav.replace(/^settings-(tab|gear)$/, 'settings');
    const on = target === primary;
    item.classList.toggle('active', on);
    if (on) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
  });
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.nav === key));
}

// ------------------------------------------------------------------ search
// One palette for conversations, projects, objectives, tasks, artifacts,
// employees and memory. Debounced; a few results per kind from the server.
const SEARCH_KIND = { employee: ['Employee', 'موظف'], project: ['Project', 'مشروع'], conversation: ['Chat', 'محادثة'], objective: ['Objective', 'هدف'], task: ['Task', 'مهمة'], artifact: ['Artifact', 'ملف'], memory: ['Memory', 'ملاحظة'] };
const searchKind = (kind) => (SEARCH_KIND[kind] ? SEARCH_KIND[kind][state.language === 'ar' ? 1 : 0] : kind);
function openSearch() {
  if ($('.palette')) return;
  const previous = document.activeElement;
  const element = document.createElement('div');
  element.className = 'palette';
  const ar = state.language === 'ar';
  element.innerHTML = `<div class="palette-scrim"></div><div class="palette-panel" role="dialog" aria-modal="true" aria-label="${ar ? 'بحث المكتب' : 'Search the Office'}">
    <input class="palette-input" id="paletteInput" dir="auto" placeholder="${ar ? 'ابحث في المحادثات والمشاريع والمهام والملفات والفريق…' : 'Search chats, projects, tasks, artifacts, employees, memory…'}" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="paletteList">
    <ul class="palette-list" id="paletteList" role="listbox"><li class="palette-hint">${ar ? 'اكتب حرفين على الأقل. Enter يفتح، وEsc يغلق.' : 'Type at least two letters. Enter opens, Esc closes.'}</li></ul></div>`;
  document.body.append(element);
  const input = element.querySelector('#paletteInput');
  const list = element.querySelector('#paletteList');
  let results = [];
  let active = 0;
  let timer = null;
  let seq = 0;
  const close = () => { element.remove(); previous?.focus?.(); };
  const paint = () => {
    list.innerHTML = results.length ? results.map((result, index) => `<li role="option" id="opt-${index}" aria-selected="${index === active}" class="palette-item" data-index="${index}"><span class="palette-kind">${esc(searchKind(result.kind))}</span><span class="grow" dir="auto">${esc(result.title)}</span>${result.detail ? `<span class="xs faint" dir="auto">${esc(result.detail)}</span>` : ''}</li>`).join('')
      : `<li class="palette-hint">${input.value.trim().length < 2 ? (state.language === 'ar' ? 'اكتب حرفين على الأقل. Enter يفتح، وEsc يغلق.' : 'Type at least two letters. Enter opens, Esc closes.') : (state.language === 'ar' ? 'ما لقينا شي في هذا المشروع.' : 'Nothing found in this project.')}</li>`;
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
  const navigation = state.navigation = (state.navigation || 0) + 1;
  clearTimers();
  closeMenu();
  view = viewRoot;
  const hash = location.hash || '#/';
  const [, section = '', id = '', sub = ''] = hash.match(/^#\/([\w-]*)\/?([\w-]*)\/?([\w-]*)/) || [];
  // Settings sections own the administrative pages; their old hashes stay
  // valid and open the same section (deep links keep working).
  const routes = {
    '': renderHome, home: renderHome, chief: () => renderChat(null), chat: () => renderChat(id), chats: renderChats, work: renderWork, 'new-work': renderNewWork, job: () => renderJob(id),
    archive: renderArchive,
    tasks: () => renderSettingsSection('coding', id || 'running'), task: () => renderTask(id), code: renderNewTask, attention: () => renderSettingsSection('approvals'),
    projects: renderProjects, project: () => renderProject(id, sub), deliverables: () => renderProject(ws(), 'deliverables'), continuity: renderContinuity, models: () => renderSettingsSection('models'), settings: () => renderSettingsSection(id, sub),
    office: renderOffice, agent: async () => { await renderOffice(); await openEmployee(id); }, workflow: () => renderJob(id), talk: () => renderChat(null, id),
    artifacts: () => renderArtifacts(id), employees: () => renderSettingsSection('team'), integrations: () => renderSettingsSection('tools'),
  };
  markNav(section === 'project' && sub === 'deliverables' ? 'deliverables'
    : { '': 'home', home: 'home', chat: 'chats', task: 'work', tasks: 'work', code: 'work', project: 'projects', agent: 'employees', workflow: 'work', job: 'work', talk: 'employees' }[section] ?? section, section);
  viewRoot.scrollTop = 0;
  try {
    await (routes[section] || routes[''])();
  } catch (error) {
    if (navigation !== state.navigation) return;
    view.innerHTML = `<div class="page">${errorBlock(error.message, esc)}</div>`;
  }
  if (navigation === state.navigation) viewRoot.focus({ preventScroll: true });
}

// ------------------------------------------------------------------ premium screens
// المكتب, تفاصيل المهمة and الأرشيف live in screens.js; they get the same
// helpers every other view uses (owner-gated api, escaping, live stream).
function screenContext() {
  const navigation = state.navigation;
  return {
    api, esc, q, ws, view, when, setTitle, toast, every, markdown, errorBlock, humanError, confirmDialog, refreshSidebar, switchProject,
    language: state.language, workspaces: () => state.workspaces, isCurrent: () => state.navigation === navigation, onLeave: (fn) => state.leave.push(fn),
    onLiveChange: (fn, onLive) => onLiveChange(fn, onLive), openEmployee: (slug) => openEmployee(slug), rerender: route,
  };
}
async function renderHome() { return renderOfficeHome(screenContext()); }
async function renderJob(id) { return renderJobDetail(screenContext(), id); }
async function renderArchive() { return renderArchiveScreen(screenContext()); }

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
      <div class="who-role">${esc(direct ? who.scope : state.language === 'ar' ? 'قول لي الهدف، وأنسق المكتب وأرجع لك بنتيجة واضحة.' : 'Give me the objective — I coordinate the Office and bring back one result.')}</div></div>
      <a class="btn btn-ghost btn-sm" href="#/agent/${esc(slug)}">${state.language === 'ar' ? 'الدور' : 'Profile'}</a></div>
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
        <textarea id="prompt" rows="1" dir="auto" placeholder="${conversation ? 'Reply…' : (state.language === 'ar' ? 'اكتب المطلوب أو وصف المهمة…' : 'Ask anything or describe a task…')}"></textarea>
        <button class="btn btn-danger hidden" type="button" id="stopButton">Stop</button>
        <button class="btn btn-primary" type="submit" id="sendButton">${state.language === 'ar' ? 'إرسال' : 'Send'}</button>
      </form>
      <div class="composer-hint">${direct ? `You are talking directly to ${esc(who.label)}. For work that needs several people, ask the <a href="#/chief">Chief of Staff</a>.` : 'The Chief of Staff decides who does the work, dispatches the team and consolidates the result.'}</div>
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
  if (!conversation) {
    // "Continue with CHIEF" from a deliverable leaves a draft for Fahad to finish.
    let draft = '';
    try { draft = sessionStorage.getItem('hub-chief-draft') || ''; sessionStorage.removeItem('hub-chief-draft'); } catch {}
    if (draft && !direct) { prompt.value = draft; autosize(prompt); prompt.setSelectionRange(draft.length, draft.length); }
    prompt.focus();
    if (!direct) { fillChiefHome(); onLiveChange(fillChiefHome); }
    return;
  }

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
  const ar = state.language === 'ar';
  const greeting = ar ? (hour < 12 ? 'صباح الخير' : 'مساء الخير') : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return `<div class="chief-home">
    <div class="ch-hero"><h1>${greeting}, ${ar ? 'فهد' : 'Fahad'}</h1><p class="muted">${ar ? 'قول لـCHIEF شو تحتاج بالعربي أو الإنجليزي. ينسق الفريق ويرجع لك بنتيجة واحدة واضحة.' : 'Tell CHIEF what you need — in Arabic or English. CHIEF coordinates the team and brings back one result.'}</p>
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
    const ar = state.language === 'ar';
    const open = ar ? 'افتح' : 'Open';
    const needs = attention.items.filter((item) => item.priority !== 'INFO');
    const done = latestResults({ attention: attention.items.filter((item) => item.priority === 'INFO') });
    const working = office.agents.filter((agent) => agent.state && agent.state !== 'AVAILABLE');
    const card = (title, body, href = '', extra = '') => `<section class="ch-card ${extra}"><div class="ch-card-head"><h2>${title}</h2>${href ? `<a class="small" href="${href}">${open}</a>` : ''}</div>${body}</section>`;
    holder.innerHTML = [
      card(ar ? 'يحتاجك' : 'Needs you', needs.length ? needs.slice(0, 4).map((item) => `<a class="ch-row" href="${item.taskId ? `#/task/${esc(item.taskId)}` : `#/chat/${esc(item.conversationId || '')}`}"><span class="ch-kind k-${esc(item.kind)}">${esc(item.category || item.kind)}</span><span class="grow" dir="auto">${esc(item.title)}</span></a>`).join('') : `<p class="muted small">${ar ? 'ما عليك شي. المكتب بيسألك هني وفي تيليغرام إذا احتاج قرارك.' : 'Nothing needs you. The Office will ask here and on Telegram when it does.'}</p>`, '#/attention', needs.length ? 'ch-alert' : ''),
      card(ar ? 'قيد التنفيذ' : 'In progress', center.objectives.active.length ? center.objectives.active.map((job) => `<a class="ch-row" href="#/job/${esc(job.id)}"><span class="grow" dir="auto">${esc(job.title)}</span><span class="ch-pct num" dir="ltr">${percentText(job.progress)}</span></a><span class="progress" aria-hidden="true"><span style="width:${progressWidth(job.progress)}%"></span></span>`).join('') : `<p class="muted small">${ar ? 'ما في هدف شغال.' : 'No objective running.'}</p>`, `#/project/${esc(ws())}`),
      card(ar ? 'الفريق الحين' : 'Team now', working.length ? `<div class="ch-team">${working.map((agent) => `<button type="button" class="ch-member" data-employee="${esc(agent.slug)}"><span class="ch-dot st-dot-${esc(String(agent.state).toLowerCase().replace(/\s+/g, '-'))}"></span><strong>${esc(agent.label)}</strong><span class="xs muted" dir="auto">${esc(agent.detail || '')}</span></button>`).join('')}</div>` : `<p class="muted small">${ar ? 'الكل متاح.' : 'Everyone is available.'}</p>`, '#/employees'),
      card(ar ? 'آخر النتائج' : 'Recently completed', done.length ? done.map((item) => `<a class="ch-row" href="${esc(item.href)}"><span class="ch-kind k-completed">${ar ? 'تم' : 'Done'}</span><span class="grow" dir="auto">${esc(item.title)}</span><span class="xs faint">${when(item.at)}</span></a>`).join('') : `<p class="muted small">${ar ? 'ما في نتيجة خلال آخر 3 أيام.' : 'Nothing finished in the last 3 days.'}</p>`),
      card(ar ? 'القرارات' : 'Decisions', center.decisionsForFahad.length ? center.decisionsForFahad.slice(0, 3).map((decision) => `<div class="ch-decision"><span class="xs faint">${esc(decision.from)}</span><div dir="auto">${esc(decision.text)}</div></div>`).join('')
        : center.memory.decisions.length ? center.memory.decisions.slice(0, 3).map((item) => `<div class="ch-decision"><span class="xs faint">${ar ? 'قرار محفوظ' : 'Decided'}</span><div dir="auto">${esc(item.content)}</div></div>`).join('') : `<p class="muted small">${ar ? 'ما في قرارات تنتظرك.' : 'No decisions waiting.'}</p>`, `#/project/${esc(ws())}`),
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
    <p class="small faint">For an objective that needs several employees, <a href="#/chief">ask the Chief of Staff</a> instead.</p>
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
  const ar = state.language === 'ar';
  setTitle(ar ? 'المحادثات' : 'Chats');
  view.innerHTML = `<div class="page"><div class="page-head"><div><h1>${ar ? 'المحادثات' : 'Chats'}</h1><p class="page-summary" id="chatSummary" aria-live="polite">${ar ? 'كل محادثات المكتب، الأحدث أولًا.' : 'Every conversation with the Office, newest first.'}</p></div><a class="btn btn-primary" href="#/chief">${ar ? '＋ محادثة جديدة' : '＋ New chat'}</a></div>
    <div class="row" style="margin-bottom:var(--s-4)"><input id="chatSearch" class="input grow" placeholder="${ar ? 'ابحث في المحادثات…' : 'Search chats…'}" dir="auto"><button id="showArchived" class="btn">${ar ? 'المؤرشفة' : 'Archived'}</button></div>
    <div id="chatList"></div></div>`;
  let archived = false;
  const load = async () => {
    const { conversations } = await api(`/api/conversations${q({ workspaceId: ws(), archived, q: $('#chatSearch').value.trim() })}`);
    const ar = state.language === 'ar';
    $('#chatSummary').textContent = ar ? (conversations.length ? `${conversations.length} محادثات. الأحدث: ${conversations[0].title}` : (archived ? 'ما في محادثات مؤرشفة.' : 'ما في محادثات بعد.')) : chatsSummary(conversations, archived);
    $('#chatList').innerHTML = conversations.length ? conversations.map((conversation) =>
      `<a class="list-item" href="#/chat/${esc(conversation.id)}"><div class="grow"><div class="title" dir="auto">${esc(conversation.title)}</div><div class="sub">${when(conversation.lastMessageAt)}</div></div></a>`).join('')
      : `<div class="empty"><h3>${archived ? (ar ? 'ما في محادثات مؤرشفة' : 'No archived chats') : (ar ? 'ما في محادثات' : 'No chats found')}</h3><p>${ar ? 'ابدأ محادثة جديدة من الزر فوق.' : 'Start a new chat from the button above.'}</p></div>`;
  };
  let timer;
  $('#chatSearch').oninput = () => { clearTimeout(timer); timer = setTimeout(load, 250); };
  $('#showArchived').onclick = () => { archived = !archived; $('#showArchived').textContent = archived ? (state.language === 'ar' ? 'النشطة' : 'Active') : (state.language === 'ar' ? 'المؤرشفة' : 'Archived'); load(); };
  await load();
}

// ------------------------------------------------------------------ tasks
function ownerStage(status) {
  const words = { planning: ['نرتب الشغل', 'Planning'], running: ['قيد التنفيذ', 'In progress'], waiting_for_capacity: ['ينتظر السعة', 'Waiting for capacity'], waiting: ['ينتظر', 'Waiting'], completed: ['مكتمل', 'Completed'], failed: ['يحتاج معالجة', 'Needs attention'], cancelled: ['ملغي', 'Cancelled'] };
  return (words[status] || ['قيد المتابعة', 'In progress'])[state.language === 'ar' ? 0 : 1];
}

async function renderNewWork() {
  const ar = state.language === 'ar';
  setTitle(ar ? 'مهمة جديدة' : 'New task');
  view.innerHTML = `<div class="page"><div class="page-head"><div><h1>${ar ? 'شو تبغي المكتب ينجز؟' : 'What should the Office accomplish?'}</h1><p>${ar ? 'اكتب النتيجة المطلوبة، وCHIEF ينسق الفريق. الإجراءات المحمية تبقى بحاجة لموافقتك.' : 'Describe the outcome. CHIEF coordinates the team; protected actions still need your approval.'}</p></div></div><form class="card stack" id="newWorkForm"><label class="field-label" for="workGoal">${ar ? 'المطلوب' : 'Desired outcome'}</label><textarea class="input big-input" id="workGoal" dir="auto" required minlength="3" maxlength="12000"></textarea><label class="field-label" for="workProject">${ar ? 'المشروع' : 'Project'}</label><select class="input" id="workProject">${state.workspaces.map((project) => `<option value="${esc(project.id)}" ${project.id === ws() ? 'selected' : ''}>${esc(project.name)}</option>`).join('')}</select><label class="field-label" for="workPriority">${ar ? 'الأولوية' : 'Priority'}</label><select class="input" id="workPriority">${[['low','على مهلك','Low'],['normal','عادية','Normal'],['high','مهمة','High'],['urgent','عاجلة','Urgent']].map(([key, a, e]) => `<option value="${key}" ${key === 'normal' ? 'selected' : ''}>${ar ? a : e}</option>`).join('')}</select><p class="small muted">${ar ? 'المودلات تُختار تلقائيًا، مجانًا أولًا. لا يغيّر اختيار الأولوية حدود الميزانية أو سياسة الموافقات.' : 'Models are routed automatically, free-first. Priority never changes budget limits or approval policy.'}</p><p class="form-error hidden" id="newWorkError" role="alert"></p><button class="btn btn-primary btn-lg" id="submitWork" type="submit">${ar ? 'ابدأ الشغل' : 'Start work'}</button></form></div>`;
  $('#newWorkForm').onsubmit = async (event) => {
    event.preventDefault();
    const button = $('#submitWork'); busy(button, true, ar ? 'جارٍ الإرسال…' : 'Starting…');
    try {
      const { job } = await api('/api/jobs', { method: 'POST', body: { workspaceId: $('#workProject').value, goal: $('#workGoal').value.trim(), priority: $('#workPriority').value } });
      location.hash = `#/job/${job.id}`;
    } catch (error) { $('#newWorkError').textContent = error.message; $('#newWorkError').classList.remove('hidden'); busy(button, false); }
  };
}

async function renderWork() {
  const navigation = state.navigation;
  const ar = state.language === 'ar';
  setTitle(ar ? 'العمل' : 'Work');
  view.innerHTML = `<div class="page page-wide"><div class="page-head"><div><h1>${ar ? 'العمل' : 'Work'}</h1><p class="page-summary">${ar ? 'الأهداف اللي ينسقها CHIEF ومهام CODING، بمراحل واضحة.' : 'CHIEF-led objectives and CODING tasks, in clear owner-friendly stages.'}</p></div><div class="row"><a class="btn" href="#/new-work">${ar ? 'مهمة جديدة' : 'New task'}</a><a class="btn btn-primary" href="#/code">${ar ? 'مهمة CODING' : 'New CODING task'}</a></div></div><div class="owner-loading"><div class="drawer-loading"></div></div></div>`;
  const [{ workflows: streams }, { tasks }, { jobs }] = await Promise.all([
    api(`/api/workflows${q({ workspaceId: ws() })}`),
    api(`/api/tasks${q({ workspaceId: ws() })}`),
    api(`/api/jobs${q({ workspaceId: ws() })}`),
  ]);
  if (navigation !== state.navigation) return;
  const workflows = [...streams.map((item) => ({ ...item, href: `#/workflow/${item.id}` })), ...jobs.filter((item) => !streams.some((stream) => stream.id === item.id)).map((item) => ({ ...item, createdAt: item.created_at, completedAt: item.completed_at, href: `#/job/${item.id}` }))];
  const activeWorkflows = workflows.filter((item) => !['completed', 'failed', 'cancelled'].includes(item.status));
  const activeTasks = tasks.filter((item) => item.group === 'running' || item.group === 'attention');
  const counts = ownerWorkCounts({ jobs, tasks });
  const finished = [...workflows.filter((item) => ['completed', 'failed'].includes(item.status)).map((item) => ({ ...item, kind: 'objective', at: item.completedAt || item.createdAt })),
    ...tasks.filter((item) => ['completed', 'failed', 'cancelled'].includes(item.group)).map((item) => ({ ...item, kind: 'task', at: item.completedAt || item.updatedAt }))]
    .toSorted((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 8);
  const workflowRow = (item) => `<a class="work-card" href="${esc(item.href)}"><div class="work-icon">◆</div><div class="grow"><div class="spread"><strong dir="auto">${esc(item.title)}</strong>${pill(item.status === 'running' || item.status === 'planning' ? 'running' : item.status, ownerStage(item.status))}</div><p dir="auto">${esc(item.objective || '')}</p><div class="row xs muted"><span>CHIEF</span><span dir="ltr">${percentText(item.progress)}</span></div><span class="progress"><span style="width:${progressWidth(item.progress)}%"></span></span></div></a>`;
  const taskRow = (item) => { const linked = item.jobId && activeWorkflows.some((job) => job.id === item.jobId); return `<a class="work-card" href="#/task/${esc(item.id)}"><div class="work-icon coding">⌘</div><div class="grow"><div class="spread"><strong dir="auto">${esc(item.title)}</strong>${pill(item.group === 'attention' ? 'attention' : item.status, item.group === 'attention' ? (ar ? 'يحتاجك' : 'Needs you') : statusLabel(item.status))}</div><p dir="auto">${esc(ownerPhrase(item.now || item.summary || ''))}</p><div class="row xs muted"><span>CODING</span><span dir="ltr">${moneyText(item.costUsd)}</span>${linked ? `<span>${ar ? 'ضمن الهدف' : 'Part of an objective'}</span>` : ''}${item.currentModel ? `<span title="${esc(item.currentModel)}">${ar ? 'تفاصيل التنفيذ متاحة' : 'Execution detail available'}</span>` : ''}</div></div></a>`; };
  const workSummary = ar ? `${counts.objectives} أهداف قيد التنفيذ${counts.coding ? `، و${counts.coding} مهام برمجية منفصلة` : ''}.` : `${counts.objectives} objective(s) in progress${counts.coding ? `, plus ${counts.coding} separate coding task(s)` : ''}.`;
  view.innerHTML = `<div class="page page-wide"><div class="page-head"><div><h1>${ar ? 'العمل' : 'Work'}</h1><p class="page-summary" data-owner-running="${counts.running}">${workSummary}</p></div><div class="row"><a class="btn" href="#/new-work">${ar ? 'مهمة جديدة' : 'New task'}</a><a class="btn btn-primary" href="#/code">${ar ? 'مهمة CODING' : 'New CODING task'}</a></div></div>
    <section class="work-section"><div class="spread"><h2>${ar ? 'الأهداف' : 'Objectives'}</h2><span class="pill running">${activeWorkflows.length}</span></div>${activeWorkflows.length ? activeWorkflows.map(workflowRow).join('') : `<div class="empty"><h3>${ar ? 'ما في هدف شغال' : 'No active objective'}</h3><p>${ar ? 'اكتب المطلوب لـCHIEF وهو يوزع الشغل على الفريق.' : 'Tell CHIEF the outcome and the Office will coordinate the work.'}</p></div>`}</section>
    <section class="work-section"><div class="spread"><h2>${ar ? 'مهام CODING' : 'CODING tasks'}</h2><a class="small" href="#/tasks/running">${ar ? 'كل المهام' : 'All tasks'}</a></div>${activeTasks.length ? activeTasks.map(taskRow).join('') : `<div class="empty"><h3>${ar ? 'CODING متاح' : 'CODING is available'}</h3><p>${ar ? 'ابدأ مهمة تقنية بلغة واضحة، والموافقات الحساسة بتوصلك قبل التنفيذ.' : 'Start in plain language; protected actions still require your approval.'}</p></div>`}</section>
    <section class="work-section"><div class="spread"><h2>${ar ? 'آخر الأعمال' : 'Recent work'}</h2></div>${finished.length ? finished.map((item) => item.kind === 'objective' ? workflowRow(item) : taskRow(item)).join('') : `<div class="empty"><p>${ar ? 'الأعمال المكتملة بتظهر هني.' : 'Completed work will appear here.'}</p></div>`}</section></div>`;
  if (activeWorkflows.length || activeTasks.length) every(8000, () => { if (location.hash === '#/work') route(); });
}

async function renderTasks(tab) {
  const ar = state.language === 'ar';
  const tabs = [['running', ar ? 'الجارية' : 'Running'], ['attention', ar ? 'تحتاجك' : 'Needs attention'], ['completed', ar ? 'المكتملة' : 'Completed'], ['failed', ar ? 'الفاشلة' : 'Failed'], ['cancelled', ar ? 'الملغية' : 'Cancelled']];
  setTitle(ar ? 'المهام' : 'Tasks');
  view.innerHTML = `<div class="page"><div class="page-head"><div><h1>${ar ? 'المهام' : 'Tasks'}</h1><p class="page-summary" id="taskSummary" aria-live="polite">${ar ? 'مهام البرمجة الجارية والمكتملة.' : 'Development work the Office is doing or has done.'}</p></div><a class="btn btn-primary" href="#/code">${ar ? '＋ مهمة جديدة' : '＋ New task'}</a></div>
    <div class="tabs" role="tablist">${tabs.map(([key, label]) => `<a class="tab ${key === tab ? 'active' : ''}" role="tab" href="#/tasks/${key}">${label}</a>`).join('')}</div>
    <div id="taskList"></div></div>`;
  const load = async () => {
    const { tasks } = await api(`/api/tasks${q({ workspaceId: ws(), status: tab })}`);
    const ar = state.language === 'ar';
    $('#taskSummary').textContent = ar ? (tasks.length ? `${tasks.length} مهام. الأحدث: ${tasks[0].title}` : (tab === 'running' ? 'ما في مهمة برمجية جارية.' : 'ما في شي في هذه المجموعة.')) : tasksSummary(tasks, tab);
    $('#taskList').innerHTML = tasks.length ? tasks.map(taskItem).join('') : `<div class="empty"><h3>${state.language === 'ar' ? 'ما في شي هني' : 'Nothing here'}</h3><p>${tab === 'running' ? (state.language === 'ar' ? 'ما في مهمة جارية.' : 'No task is running. Describe one in a chat or start one from the Coding Agent.') : (state.language === 'ar' ? 'ما في مهام في هذه المجموعة.' : 'No tasks in this group.')}</p></div>`;
  };
  await load();
  if (tab === 'running' || tab === 'attention') every(5000, () => load().catch(() => {}));
}
function taskItem(task) {
  const ar = state.language === 'ar';
  const sub = task.group === 'completed' ? (task.summary || (ar ? 'مكتمل' : 'Completed')) : task.group === 'attention' ? (task.needs === 'approval' ? (ar ? 'ينتظر موافقتك' : 'Waiting for your approval') : task.needs === 'question' ? (ar ? 'عنده سؤال لك' : 'Has a question for you') : (ar ? 'متوقف — يحتاجك' : 'Paused — needs you')) : task.now;
  return `<a class="list-item" href="#/task/${esc(task.id)}"><div class="grow"><div class="title" dir="auto">${esc(task.title)}</div><div class="sub" dir="auto">${esc(sub || '')}</div>
    <div class="sub faint xs">${esc(task.repository)} · ${when(task.updatedAt)} · <bdi dir="ltr">${moneyText(task.costUsd)}</bdi>${task.pr?.number ? ` · PR #${esc(task.pr.number)}` : ''}</div></div>${pill(task.group, statusLabel(task.group === 'attention' ? 'attention' : task.status))}</a>`;
}

// The CODING workspace (start a task, follow one as a chat-like thread) is
// its own module, loaded on demand.
const loadCoding = () => import('./coding.js?v=__UI_VERSION__');
function codingContext() { return { ...officeContext(), confirmDialog, ask, refreshSidebar }; }
async function renderNewTask() { return (await loadCoding()).renderCodingHome(codingContext()); }
async function renderTask(id) { return (await loadCoding()).renderCodingTask(codingContext(), id); }

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
  const navigation = state.navigation;
  return {
    current: () => state.navigation === navigation,
      api, esc, when, q, ws, view, setTitle, toast, every, reducedMotion, renderArtifact, rerender: route, language: state.language, search: () => openSearch(),
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
  // A burst of row changes refreshes the top-bar count once.
  source.addEventListener('change', () => { live.listeners.forEach((fn) => fn()); clearTimeout(live.navTimer); live.navTimer = setTimeout(refreshSidebar, 1000); });
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
  const navigation = state.navigation;
  const ar = state.language === 'ar';
  setTitle(ar ? 'الفريق' : 'Team');
  const data = await api(`/api/office${q({ workspaceId: ws() })}`);
  if (navigation !== state.navigation) return;
  const status = (agent) => agent.state === 'AVAILABLE' ? (ar ? 'متاح' : 'Available') : ['THINKING', 'WORKING', 'TESTING', 'REVIEWING'].includes(agent.state) ? (ar ? 'يشتغل' : 'Working') : agent.state === 'WAITING' ? (ar ? 'ينتظر' : 'Waiting') : ['NEEDS FAHAD', 'BLOCKED'].includes(agent.state) ? (ar ? 'متوقف' : 'Blocked') : agent.state;
  view.innerHTML = `<div class="page page-wide"><div class="page-head"><div><h1>${ar ? 'الفريق' : 'Team'}</h1><p class="page-summary">${ar ? 'تسعة موظفين بأدوار ثابتة. المودلات تتغير حسب المهمة والسعة، ولا ترتبط بهوية الموظف.' : 'Nine fixed office roles. Models route dynamically by task and capacity; they are not employee identities.'}</p></div><a class="btn btn-primary" href="#/chief">${ar ? 'كلّف CHIEF' : 'Ask CHIEF'}</a></div>
    <div class="office-grid">${data.agents.map((agent) => `<a class="agent-card ${STATE_CLASS[agent.state] || ''}" href="#/agent/${esc(agent.slug)}" data-employee="${esc(agent.slug)}">
      <div class="row">${avatar(agent)}<div class="grow"><div class="title">${esc(agent.label)}</div><div class="xs faint">${esc(agent.deliverable || '')}</div></div><span class="pill ${agent.state === 'AVAILABLE' ? 'available' : ['NEEDS FAHAD', 'BLOCKED'].includes(agent.state) ? 'attention' : 'running'}">${status(agent)}</span></div>
      <div class="small muted">${esc(agent.scope)}</div>
      <div class="agent-now"><span>${ar ? 'المهمة الحالية' : 'Current assignment'}</span><strong dir="auto">${esc(agent.assignment?.objective || agent.assignment?.title || agent.detail || (ar ? 'متاح لمهمة جديدة' : 'Available for new work'))}</strong>${agent.progress != null ? `<span class="progress"><span style="width:${progressWidth(agent.progress)}%"></span></span>` : ''}</div>
      <div class="agent-output"><span>${ar ? 'آخر نتيجة' : 'Recent output'}</span><strong dir="auto">${esc(agent.recentArtifact?.title || (ar ? 'ما في نتيجة حديثة' : 'No recent output'))}</strong></div>
      <div class="row">${agent.directChat ? `<span class="tag">${ar ? 'محادثة مباشرة' : 'Direct chat'}</span>` : ''}${agent.executor === 'coding' ? `<span class="tag">${ar ? 'مهام برمجية' : 'Engineering tasks'}</span>` : ''}${agent.executor === 'chief' ? `<span class="tag">${ar ? 'ينسق الفريق' : 'Orchestrates'}</span>` : ''}</div></a>`).join('')}</div></div>`;
  view.querySelectorAll('[data-employee]').forEach((card) => { card.onclick = (event) => { event.preventDefault(); openEmployee(card.dataset.employee); }; });
}

// ------------------------------------------------------------------ attention
// Needs Fahad: an executive interruption centre. URGENT first, then what
// needs an action, then information (major completions) — nothing routine.
async function renderAttention() {
  const navigation = state.navigation;
  const ar = state.language === 'ar';
  setTitle(ar ? 'الموافقات' : 'Approvals');
  const preview = (approval) => {
    const value = approval.arguments_preview || {};
    const rows = [];
    if (Array.isArray(value.paths) && value.paths.length) rows.push([ar ? 'الملفات' : 'Files', value.paths.slice(0, 5).join(', ')]);
    if (value.repository) rows.push([ar ? 'المستودع' : 'Repository', value.repository]);
    if (value.branch) rows.push([ar ? 'الفرع' : 'Branch', value.branch]);
    if (value.workflow) rows.push([ar ? 'التشغيل' : 'Workflow', value.workflow]);
    const cost = value.estimatedCostUsd ?? value.costUsd ?? value.budgetUsd;
    if (cost != null) rows.push([ar ? 'التكلفة المقدّرة' : 'Estimated cost', usd(cost)]);
    return rows.map(([label, content]) => `<div><dt>${esc(label)}</dt><dd dir="auto">${esc(content)}</dd></div>`).join('');
  };
  const draw = async () => {
    const [{ items }, { approvals }] = await Promise.all([
      api(`/api/attention${q({ workspaceId: ws() })}`),
      api(`/api/approvals${q({ workspaceId: ws() })}`),
    ]);
    if (navigation !== state.navigation) return;
    const href = (item) => (item.taskId ? `#/task/${esc(item.taskId)}` : item.jobId ? `#/job/${esc(item.jobId)}` : `#/chat/${esc(item.conversationId || '')}`);
    const approvalCards = approvals.map((approval) => `<article class="approval-card risk-${esc(approval.risk || 'medium')}"><div class="approval-top"><span class="approval-risk">${esc(String(approval.risk || 'medium').toUpperCase())}</span><time>${when(approval.requested_at)}</time></div><h2 dir="auto">${esc(approval.summary || approval.action || (ar ? 'إجراء يحتاج موافقتك' : 'Action needs your approval'))}</h2><p>${ar ? 'الإجراء' : 'Action'}: <strong>${esc(approval.action || approval.tool_name)}</strong></p><p class="small muted">${ar ? 'السبب: خطوة محمية تتطلب قرار المالك قبل التنفيذ.' : 'Why: this protected action requires the owner before execution.'}</p><dl class="approval-facts"><div><dt>${ar ? 'المشروع' : 'Project'}</dt><dd>${esc(state.workspaces.find((item) => item.id === ws())?.name || '—')}</dd></div>${preview(approval)}</dl><div class="approval-actions"><a class="btn btn-ghost" href="#/task/${esc(approval.session_id)}">${ar ? 'راجع المهمة' : 'Review task'}</a><button class="btn btn-danger" data-approval-decision="rejected" data-id="${esc(approval.id)}">${ar ? 'رفض' : 'Reject'}</button><button class="btn btn-primary" data-approval-decision="approved" data-id="${esc(approval.id)}">${ar ? 'موافقة' : 'Approve'}</button></div></article>`).join('');
    const other = items.filter((item) => item.priority !== 'INFO' && !approvals.some((approval) => approval.session_id === item.taskId));
    const cat = (item) => categoryLabel(item.category || item.kind);
    const info = items.filter((item) => item.priority === 'INFO');
    view.innerHTML = `<div class="page page-wide approvals-page"><div class="page-head"><div><h1>${ar ? 'الموافقات' : 'Approvals'}</h1><p class="page-summary">${approvals.length ? (ar ? `${approvals.length} إجراء ينتظر قرارك. ما يصير أي إجراء محمي قبل موافقتك.` : `${approvals.length} protected action(s) waiting. Nothing proceeds without your decision.`) : (ar ? 'ما في إجراءات تنتظر موافقتك.' : 'No protected actions are waiting.')}</p></div></div>
      ${approvalCards || `<div class="nf-clear"><strong>${ar ? 'الأمور طيبة.' : 'All clear.'}</strong> ${ar ? 'إذا احتاج المكتب قرارك بيظهر هني.' : 'The Office will place any owner decision here.'}</div>`}
      ${other.length ? `<section class="nf-group"><h2>${ar ? 'أسئلة أو قرارات ثانية' : 'Other questions and decisions'}</h2>${other.map((item) => `<a class="nf-item" href="${href(item)}"><span class="nf-cat">${esc(cat(item))}</span><span class="grow"><span class="nf-title" dir="auto">${esc(item.title)}</span>${item.detail ? `<span class="nf-detail" dir="auto">${esc(ownerPhrase(humanError(item.detail)))}</span>` : ''}</span><time>${when(item.at)}</time></a>`).join('')}</section>` : ''}
      ${info.length ? `<details class="disclosure"><summary>${ar ? 'آخر الأعمال المكتملة' : 'Recent completions'}</summary><div class="disclosure-body">${info.map((item) => `<a class="nf-item" href="${href(item)}"><span class="nf-cat">${ar ? 'تم' : 'Done'}</span><span class="grow" dir="auto">${esc(item.title)}</span><time>${when(item.at)}</time></a>`).join('')}</div></details>` : ''}</div>`;
    bind(view, { '[data-approval-decision]': async (_, button) => {
      const decision = button.dataset.approvalDecision;
      const approval = approvals.find((item) => String(item.id) === String(button.dataset.id));
      if (!approval) return;
      const action = approval.summary || approval.action || approval.tool_name || (ar ? 'الإجراء المحمي' : 'the protected action');
      let note = null;
      if (decision === 'approved') {
        const confirmed = await dialog({
          title: ar ? 'تأكيد الموافقة' : 'Confirm approval',
          body: ar ? `${action} — سيُسمح بهذه الخطوة المحمية فقط ضمن المهمة الحالية، وتبقى كل بوابات المالك الأخرى كما هي.` : `${action} — this allows only this protected step in the current task. Every other owner gate remains in place.`,
          confirm: ar ? 'موافقة ومتابعة' : 'Approve & continue',
        });
        if (!confirmed) return;
      } else {
        note = await ask(ar ? 'سبب الرفض (اختياري)' : 'Reason for rejection (optional)', '', true);
      }
      if (decision === 'rejected' && note === null) return;
      busy(button, true, ar ? 'جارٍ الحفظ…' : 'Saving…');
      try { await api(`/api/approvals/${button.dataset.id}`, { method: 'POST', body: { decision, note: note || undefined } }); toast(decision === 'approved' ? (ar ? 'تمت الموافقة' : 'Approved') : (ar ? 'تم الرفض' : 'Rejected')); await draw(); await refreshSidebar(); }
      catch (error) { toast(error.message); busy(button, false); }
    } });
  };
  await draw();
  onLiveChange(() => { if (navigation === state.navigation) draw().catch(() => {}); });
}

async function renderProjects() {
  const navigation = state.navigation;
  const ar = state.language === 'ar';
  setTitle(ar ? 'المشاريع' : 'Projects');
  view.innerHTML = `<div class="page page-wide"><div class="page-head"><div><h1>${ar ? 'المشاريع' : 'Projects'}</h1><p class="page-summary">${ar ? 'المشروع هو وحدة العمل: الهدف، الفريق، المهام، الملفات، القرارات والتكلفة في مكان واحد.' : 'A project holds its objective, team, work, files, decisions and cost.'}</p></div><button class="btn btn-primary" id="createProject">${ar ? '＋ مشروع جديد' : '＋ New project'}</button></div><div class="project-cards" id="projectCards"><div class="drawer-loading"></div></div></div>`;
  const summaries = await Promise.all(state.workspaces.map(async (workspace) => {
    const [detail, center] = await Promise.all([api(`/api/projects/${workspace.id}`).catch(() => null), api(`/api/command-center${q({ workspaceId: workspace.id })}`).catch(() => null)]);
    return { workspace, detail, center };
  }));
  if (navigation !== state.navigation) return;
  const statusWord = { unavailable: ar ? 'غير متاح' : 'Unavailable', attention: ar ? 'يحتاج متابعة' : 'Needs attention', active: ar ? 'شغال' : 'Active', ready: ar ? 'جاهز' : 'Ready' };
  $('#projectCards').innerHTML = summaries.length ? summaries.map(({ workspace, detail, center }) => { const facts = projectFacts({ center, stats: detail?.stats }); const project = detail?.project || workspace; return `<a class="project-card-v5" href="#/project/${esc(project.id)}"><div class="spread"><span class="project-status ${facts.state === 'active' ? 'is-live' : ''}">${statusWord[facts.state]}</span>${project.id === ws() ? `<span class="pill available">${ar ? 'الحالي' : 'Current'}</span>` : ''}</div><h2 dir="auto">${esc(project.name)}</h2><p dir="auto">${esc(project.description || (ar ? 'ما انضاف وصف المشروع بعد.' : 'No project objective has been added yet.'))}</p><dl><div><dt>${ar ? 'قيد التنفيذ' : 'Active'}</dt><dd>${countText(facts.active)}</dd></div><div><dt>${ar ? 'المهام' : 'Tasks'}</dt><dd>${countText(facts.tasks)}</dd></div><div><dt>${ar ? 'مكتمل' : 'Completed'}</dt><dd>${countText(facts.completed)}</dd></div><div><dt>${ar ? 'التكلفة' : 'Cost'}</dt><dd dir="ltr">${moneyText(facts.cost)}</dd></div></dl><span class="project-open">${ar ? 'افتح مركز المشروع' : 'Open project center'}</span></a>`; }).join('') : `<div class="empty"><h3>${ar ? 'أنشئ أول مشروع' : 'Create your first project'}</h3><p>${ar ? 'كل شغل المكتب يعيش داخل مشروع واضح.' : 'Every piece of Office work belongs to a clear project.'}</p></div>`;
  $('#createProject').onclick = async () => {
    const name = await ask(ar ? 'اسم المشروع الجديد' : 'New project name', '');
    if (!name) return;
    try {
      const { workspace } = await api('/api/workspaces', { method: 'POST', body: { name } });
      state.workspaces.push(workspace); state.workspaceId = workspace.id;
      $('#projectSelect').insertAdjacentHTML('beforeend', `<option value="${esc(workspace.id)}">${esc(workspace.name)}</option>`); $('#projectSelect').value = workspace.id;
      try { localStorage.setItem('hub-workspace-id', workspace.id); } catch {}
      await refreshSidebar(); connectLive(); location.hash = `#/project/${workspace.id}`;
    } catch (error) { toast(error.message); }
  };
}

// Command Center, deliverables and the project map live in their own modules.
async function renderProject(id, sub = '') {
  if (!id) throw new Error(state.language === 'ar' ? 'اختر مشروع أول.' : 'Choose a project first.');
  if (id !== ws() && state.workspaces.some((project) => project.id === id)) {
    state.workspaceId = id;
    $('#projectSelect').value = id;
    try { localStorage.setItem('hub-workspace-id', id); } catch {}
    connectLive(); refreshSidebar();
  }
  const module = await import('./project.js?v=__UI_VERSION__');
  const mode = sub === 'deliverables' ? 'deliverables' : ['map', 'continuity'].includes(sub) ? sub : 'center';
  return module.renderProject({ ...officeContext(), usd, confirmDialog, ask, memoryKinds: MEMORY_KINDS, memoryLabel: (kind) => MEMORY_LABEL[kind] || kind, openEmployee, directSlugs: DIRECT_SLUGS }, id, mode);
}

async function renderContinuity() {
  if (!ws()) throw new Error('Choose a project first.');
  const module = await import('./project.js?v=__UI_VERSION__');
  return module.renderContinuityPage({ ...officeContext(), usd, confirmDialog, ask }, ws(), state.language);
}
const MEMORY_LABEL = Object.fromEntries(MEMORY_KINDS);

// ------------------------------------------------------------------ artifacts
// The artifact library (and its viewer/exports) is its own module.
const DIRECT_SLUGS = Object.freeze({ research: 'research-strategy', creative: 'brand-creative', product: 'product-tech', finance: 'business-finance', audit: 'qa-security', social: 'content-media', legal: 'legal-compliance' });
function libraryContext() { return { ...officeContext(), labels: ARTIFACT_LABELS, workspaces: () => state.workspaces, directSlugs: DIRECT_SLUGS, confirmDialog, language: state.language }; }
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
  const ar = state.language === 'ar';
  setTitle(ar ? 'الربط' : 'Integrations');
  view.innerHTML = `<div class="page page-wide"><div class="page-head"><div><h1>${ar ? 'الربط' : 'Integrations'}</h1><p class="page-summary" id="intSummary" aria-live="polite">${ar ? 'اللي يقدر المكتب يستخدمه فعليًا.' : 'What the Office can actually use.'}</p><p class="small muted">${ar ? '«متصل» يعني فيه استخدام ناجح مسجّل. مجرد وجود الإعداد ما يكفي.' : '<strong>Connected</strong> means a real successful use was recorded — configuration alone never counts.'}</p></div></div>
    <div class="conn-legend">${Object.values(CONNECTION).map((value) => `<span class="conn-badge conn-${CONNECTION_TONE[value]}">${esc(value)}</span>`).join('')}</div><div id="capabilities"><div class="drawer-loading"></div></div></div>`;
  const [{ capabilities }, models] = await Promise.all([api('/api/capabilities'), api(`/api/models${q({ workspaceId: ws() })}`).catch(() => null)]);
  const groups = [[ar ? 'أدوات الشغل' : 'Work tools', ['github', 'repository', 'pull_requests', 'ci', 'deployment', 'supabase_tools', 'tool_broker']], [ar ? 'البحث' : 'Research', ['web_search', 'web_fetch']], [ar ? 'القنوات' : 'Channels', ['telegram']], [ar ? 'بيانات المكتب' : 'Office data', ['database', 'memory']]];
  const card = (item) => { const value = connection(item.status); return `<div class="int-card"><div class="int-top"><strong>${esc(item.label)}</strong><span class="conn-badge conn-${CONNECTION_TONE[value]}">${esc(value)}</span></div><div class="small muted">${esc(item.detail)}</div>${item.employees?.length ? `<div class="row">${item.employees.map((label) => `<span class="tag muted">${esc(label)}</span>`).join('')}</div>` : ''}</div>`; };
  const providers = new Map();
  for (const model of models?.models || []) {
    const current = providers.get(model.provider) || { provider: model.provider, statuses: [], reasons: [] };
    current.statuses.push(model.status); current.reasons.push(model.reason);
    providers.set(model.provider, current);
  }
  const providerState = (entry) => (entry.statuses.includes('AVAILABLE') || entry.statuses.includes('COOLDOWN') ? CONNECTION.CONNECTED : entry.statuses.includes('ACCOUNT ACTION REQUIRED') ? CONNECTION.ACCOUNT
    : entry.reasons.some((reason) => /No credential/i.test(reason)) ? CONNECTION.NOT_CONFIGURED : CONNECTION.UNAVAILABLE);
  const connectionStates = capabilities.filter((item) => groups.some(([, ids]) => ids.includes(item.id))).map((item) => connection(item.status));
  const connected = connectionStates.filter((item) => item === 'CONNECTED').length;
  $('#intSummary').textContent = ar ? (connectionStates.length ? `${connected} من ${connectionStates.length} أدوات فيها استخدام ناجح مسجّل.` : 'ما في أدوات مبلغ عنها بعد.') : integrationsSummary(connectionStates);
  $('#capabilities').innerHTML = groups.map(([title, ids]) => `<section class="int-group"><h2 class="int-title">${esc(title)}</h2><div class="int-grid">${capabilities.filter((item) => ids.includes(item.id)).map(card).join('')}</div></section>`).join('')
    + (providers.size ? `<section class="int-group"><h2 class="int-title">${ar ? 'مزودو المحركات' : 'Model providers'}</h2><div class="int-grid">${[...providers.values()].map((entry) => { const value = providerState(entry); return `<div class="int-card"><div class="int-top"><strong>${esc(entry.provider)}</strong><span class="conn-badge conn-${CONNECTION_TONE[value]}">${esc(value)}</span></div><div class="small muted">${entry.statuses.length} ${ar ? 'محرك' : `model${entry.statuses.length === 1 ? '' : 's'}`} · ${esc(humanError(entry.reasons.find((reason) => reason) || ''))}</div></div>`; }).join('')}</div><p class="xs muted">${ar ? 'تفاصيل كل محرك:' : 'Details per model:'} <a href="#/models">${ar ? 'السعة والتكلفة' : 'Models'}</a>.</p></section>` : '');
}

// ------------------------------------------------------------------ models
async function renderModels() {
  const navigation = state.navigation;
  const ar = state.language === 'ar';
  setTitle(ar ? 'السعة والتكلفة' : 'Capacity & cost');
  const [data, office, capacity, platform] = await Promise.all([api(`/api/models${q({ workspaceId: ws() })}`), api(`/api/office${q({ workspaceId: ws() })}`).catch(() => null), api('/api/capacity').catch(() => null), api(`/api/platform${q({ workspaceId: ws() })}`).catch(() => null)]);
  if (navigation !== state.navigation) return;
  const kind = { AVAILABLE: 'available', COOLDOWN: 'cooldown', 'ACCOUNT ACTION REQUIRED': 'account', UNAVAILABLE: 'unavailable' };
  const waiting = (office?.agents || []).filter((agent) => agent.state === 'WAITING' && (agent.assignment?.resumesAt || /free model capacity|^Waiting:/i.test(agent.detail || '')));
  const available = data?.counts ? (knownNumber(data.counts.AVAILABLE) ?? 0) : null;
  const blocked = data?.counts ? Number(data.counts['ACCOUNT ACTION REQUIRED'] || 0) + Number(data.counts.UNAVAILABLE || 0) : null;
  const budget = platform?.usage?.budget;
  const paid = capacity?.capacity?.paidFallback || {};
  const poolCount = Array.isArray(capacity?.pools) ? String(capacity.pools.length) : '—';
  const capacityLine = capacitySentence(capacity?.summary, state.language) || (ar ? (capacity ? 'تفاصيل السعة غير مكتملة.' : 'بيانات السعة غير متاحة.') : (data?.counts ? (capacity?.headline || modelsSummary(data.counts, waiting.length)) : 'Capacity data unavailable'));
  const poolState = (pool) => pool.state === 'available' ? (ar ? 'مجاني متاح' : 'Free available') : pool.state === 'exhausted' ? (ar ? 'ينتظر التجديد' : 'Waiting for reset') : pool.state === 'not_configured' ? (ar ? 'غير مربوط' : 'Not configured') : (ar ? 'محدود' : 'Limited');
  view.innerHTML = `<div class="page page-wide capacity-page"><div class="page-head"><div><h1>${ar ? 'السعة والتكلفة' : 'Capacity & cost'}</h1><p class="page-summary">${ar ? 'التوجيه تلقائي ومجاني أولًا. المودل محرك تنفيذ، مب هوية الموظف.' : 'Routing is automatic and free-first. A model is an execution engine, never an employee identity.'}</p></div></div>
    <section class="capacity-overview"><div class="capacity-hero ${capacity?.summary?.freeCapacityNow === 'available' ? 'is-good' : 'is-warn'}"><span class="capacity-orb"></span><div><span>${ar ? 'الحالة الحين' : 'Current state'}</span><h2>${capacity?.summary?.freeCapacityNow === 'available' ? (ar ? 'السعة المجانية متاحة' : 'Free capacity available') : !capacity ? (ar ? 'حالة السعة غير متاحة' : 'Capacity unavailable') : (ar ? 'السعة المجانية محدودة' : 'Free capacity limited')}</h2><p dir="auto">${esc(capacityLine)}</p></div></div><div class="capacity-kpis"><div><span>${ar ? 'المكتب — اليوم' : 'Office — today'}</span><strong>${capacity?.capacity?.costUsd?.today == null ? (ar ? 'غير متاح' : 'Unavailable') : usd(capacity.capacity.costUsd.today)}</strong><small>${capacity?.summary?.tokensToday == null ? '—' : tokens(capacity.summary.tokensToday)} ${ar ? 'توكن' : 'tokens'}</small></div><div><span>${ar ? 'المكتب — الشهر' : 'Office — month'}</span><strong>${capacity?.capacity?.costUsd?.month == null ? (ar ? 'غير متاح' : 'Unavailable') : usd(capacity.capacity.costUsd.month)}</strong><small>${budget ? `${usd(budget.remainingUsd)} ${ar ? 'متبقي للمشروع' : 'project budget remaining'}` : (ar ? 'ميزانية غير متاحة' : 'Budget unavailable')}</small></div><div><span>${ar ? 'المحركات المتاحة' : 'Available engines'}</span><strong>${available == null ? '—' : available}</strong><small>${blocked == null ? unavailableText() : blocked ? `${blocked} ${ar ? 'محجوب، والباقي مستمر' : 'blocked; others still route'}` : (ar ? 'ما في محجوب' : 'None blocked')}</small></div><div><span>${ar ? 'المدفوع — المكتب' : 'Office paid fallback'}</span><strong>${paid.route ? (ar ? 'متاح بموافقة السياسة' : 'Policy available') : (ar ? 'غير متاح' : 'Unavailable')}</strong><small>${paid.route ? `<bdi dir="ltr">${moneyText(paid.remainingUsd)}</bdi> ${ar ? 'متبقي' : 'remaining'}` : (ar ? 'المجاني ما زال مستقل' : 'Free pools remain independent')}</small></div></div></section>
    ${waiting.length ? `<div class="capacity-banner" role="status"><strong>${ar ? 'ينتظر السعة' : 'Waiting for capacity'}</strong>${waiting.map((agent) => `<div dir="auto">${esc(agent.label)}: ${esc(String(agent.detail || '').replace(/^Waiting:\s*/, '') || (ar ? 'بيكمل تلقائي أول ما تتوفر سعة مجانية.' : 'Work resumes automatically when free capacity returns.'))}</div>`).join('')}</div>` : ''}
    <section class="owner-card"><div class="owner-card-head"><h2>${ar ? 'مجموعات السعة' : 'Capacity pools'}</h2><span class="small muted">${poolCount}</span></div><div class="pool-grid">${(capacity?.pools || []).map((pool) => `<article><div class="spread"><strong dir="auto">${esc(pool.label || pool.id)}</strong><span class="pill ${pool.state === 'available' ? 'available' : pool.state === 'exhausted' ? 'cooldown' : 'unavailable'}">${poolState(pool)}</span></div><p class="small muted">${pool.nextReset ? `${ar ? 'التجديد' : 'Reset'}: ${when(pool.nextReset)}` : (ar ? 'المزود ما أعلن حدًا دقيقًا' : 'Provider does not report an exact allowance')}</p></article>`).join('') || `<p class="muted">${ar ? 'بيانات المجموعات غير متاحة.' : 'Pool data is unavailable.'}</p>`}</div></section>
    <details class="disclosure"><summary>${ar ? 'تفاصيل المحركات المتقدمة' : 'Advanced engine details'}</summary><div class="disclosure-body"><div class="table-wrap"><table class="table"><thead><tr><th>${ar ? 'المحرك' : 'Engine'}</th><th>${ar ? 'الحالة' : 'Status'}</th><th class="hide-sm">${ar ? 'الفئة' : 'Cost class'}</th><th class="hide-sm">${ar ? 'الترتيب' : 'Order'}</th><th class="hide-sm">${ar ? 'الصحة' : 'Health'}</th><th class="hide-sm">${ar ? 'السبب' : 'Why'}</th><th class="hide-sm">${ar ? 'يخدم' : 'Serves'}</th></tr></thead><tbody>
    ${data.models.map((model) => { const reason = esc(model.reason.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, (iso) => new Date(iso).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' }))); return `<tr><td><div class="mono small" style="overflow-wrap:anywhere">${esc(model.model)}</div><div class="xs faint">${esc(model.provider)} · ${esc(model.billing)}</div><div class="xs muted show-sm">${reason}</div></td><td>${pill(kind[model.status], model.status)}</td><td class="hide-sm">${esc(model.billing)}</td><td class="hide-sm">${model.order || '—'}</td><td class="hide-sm">${esc(model.health)}</td><td class="small muted hide-sm" style="min-width:180px">${reason}</td><td class="xs hide-sm" style="min-width:140px">${esc((model.roles || []).join(', ') || '—')}${model.fallbackRoles?.length ? `<div class="faint">${esc(model.fallbackRoles.map((role) => `${role} (qualified fallback)`).join(', '))}</div>` : ''}</td></tr>`; }).join('')}
    </tbody></table></div><p class="xs muted" style="margin-top:var(--s-2)">${ar ? 'تعطل مزود واحد ما يخفي ولا يوقف الخيارات المتاحة من المزودين الآخرين.' : 'A blocked provider never hides or stops other available options.'}</p></div></details></div>`;
}

// ------------------------------------------------------------------ settings
// ------------------------------------------------------------------ settings
// One section at a time; each section is an existing page rendered into the
// panel, so every control, permission check and live refresh is unchanged.
const SETTINGS_ICON = (path) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
const SETTINGS_SECTIONS = [
  { key: 'team', ar: 'الفريق', en: 'Team', icon: SETTINGS_ICON('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'), render: () => renderEmployees() },
  { key: 'approvals', ar: 'الموافقات', en: 'Approvals', icon: SETTINGS_ICON('<path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/>'), render: () => renderAttention() },
  { key: 'models', ar: 'النماذج والمزوّدين', en: 'Models & providers', icon: SETTINGS_ICON('<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>'), render: () => renderModels() },
  { key: 'coding', ar: 'عمّال البرمجة', en: 'Coding workers', icon: SETTINGS_ICON('<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>'), render: (sub) => renderCodingPanel(sub) },
  { key: 'tools', ar: 'الأدوات والصلاحيات', en: 'Tools & permissions', icon: SETTINGS_ICON('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/>'), render: () => renderIntegrations() },
  { key: 'health', ar: 'الصحة والسجلات', en: 'Health & logs', icon: SETTINGS_ICON('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'), render: () => renderHealthPanel() },
  { key: 'appearance', ar: 'اللغة والمظهر', en: 'Language & appearance', icon: SETTINGS_ICON('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>'), render: () => renderAppearancePanel() },
];
async function renderSettingsSection(key = '', sub = '') {
  const ar = state.language === 'ar';
  const section = SETTINGS_SECTIONS.find((item) => item.key === key) || SETTINGS_SECTIONS[0];
  viewRoot.innerHTML = `<div class="pg settings-page"><div class="settings-layout">
    <nav class="settings-nav" aria-label="${ar ? 'أقسام الإعدادات' : 'Settings sections'}"><p class="eyebrow settings-eyebrow">${ar ? 'الإعدادات' : 'Settings'}</p>
      <ul>${SETTINGS_SECTIONS.map((item) => `<li><a href="#/settings/${item.key}" class="settings-link ${item.key === section.key ? 'active' : ''}" ${item.key === section.key ? 'aria-current="page"' : ''}>${item.icon}<span>${ar ? item.ar : item.en}</span>${item.key === 'approvals' && state.attention?.action ? `<span class="count count-alert">${esc(state.attention.action)}</span>` : ''}</a></li>`).join('')}</ul></nav>
    <section class="settings-panel" id="settingsPanel" aria-label="${esc(ar ? section.ar : section.en)}"></section></div></div>`;
  view = $('#settingsPanel');
  await section.render(sub);
  setTitle(`${ar ? section.ar : section.en} · ${ar ? 'الإعدادات' : 'Settings'}`);
}

// Coding workers: the Coding Agent's sessions (existing tabs and actions)
// plus the execution-worker board. Workers are never Office employees.
async function renderCodingPanel(sub) {
  const navigation = state.navigation;
  const ar = state.language === 'ar';
  await renderTasks(['running', 'attention', 'completed', 'failed', 'cancelled'].includes(sub) ? sub : 'running');
  const data = await api('/api/work/workers').catch(() => null);
  if (navigation !== state.navigation) return;
  const page = view.querySelector('.page');
  if (!page) return;
  const yes = (value) => (value === true ? (ar ? 'نعم' : 'Yes') : value === false ? (ar ? 'لا' : 'No') : (ar ? 'غير معروف' : 'Unknown'));
  const card = document.createElement('section');
  card.className = 'owner-card workers-card';
  card.innerHTML = `<div class="owner-card-head"><h2>${ar ? 'عمّال التنفيذ' : 'Execution workers'}</h2><span class="row"><a href="#/code">${ar ? 'مهمة برمجية جديدة' : 'New coding task'}</a><a href="#/continuity">${ar ? 'الاستمرارية' : 'Continuity'}</a></span></div>
    <p class="small muted">${ar ? 'محركات تنفيذ للمهام البرمجية، وليست موظفين في المكتب. الحالة كما يبلّغ عنها الخادم.' : 'Execution engines for coding work — not Office employees. States are as the server reports them.'}</p>
    ${data?.workers?.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>${ar ? 'العامل' : 'Worker'}</th><th>${ar ? 'الحالة' : 'State'}</th><th>${ar ? 'مفعّل' : 'Enabled'}</th><th>${ar ? 'قابل للتنفيذ' : 'Executable'}</th><th>${ar ? 'ملاحظة' : 'Note'}</th></tr></thead><tbody>${data.workers.map((worker) => `<tr><td dir="ltr">${esc(worker.displayName)}</td><td class="mono">${esc(worker.operational)}</td><td>${yes(worker.enabled)}</td><td>${yes(worker.executable)}</td><td class="small muted" dir="ltr">${esc(worker.summary || '')}</td></tr>`).join('')}</tbody></table></div>` : `<p class="small muted">${ar ? 'بيانات العمّال غير متاحة.' : 'Worker data is unavailable.'}</p>`}`;
  page.append(card);
}

async function renderHealthPanel() {
  const navigation = state.navigation;
  const ar = state.language === 'ar';
  setTitle(ar ? 'الصحة والسجلات' : 'Health & logs');
  const [health, platform, models, continuity, capabilities] = await Promise.all([
    fetch('./healthz').then((response) => response.json()).catch(() => null),
    api(`/api/platform${q({ workspaceId: ws() })}`).catch(() => null),
    api(`/api/models${q({ workspaceId: ws() })}`).catch(() => null),
    api(`/api/continuity${q({ projectId: ws() })}`).catch(() => null),
    api('/api/capabilities').catch(() => null),
  ]);
  if (navigation !== state.navigation) return;
  const providers = new Map();
  for (const model of models?.models || []) {
    const item = providers.get(model.provider) || { provider: model.provider, statuses: [], reasons: [] };
    item.statuses.push(model.status); item.reasons.push(model.reason || ''); providers.set(model.provider, item);
  }
  const providerStatus = (item) => item.statuses.includes('AVAILABLE') || item.statuses.includes('COOLDOWN') ? ['available', ar ? 'مربوط' : 'Connected']
    : item.reasons.some((reason) => /credential|key|not configured/i.test(reason)) ? ['unavailable', ar ? 'المفتاح غير موجود' : 'Key not configured'] : ['account', ar ? 'يحتاج إجراء' : 'Needs action'];
  const capReady = capabilities ? (capabilities.capabilities || []).filter((item) => /^Connected|^Available/.test(item.status || '')).length : null;
  const facts = healthFacts({ health, platform });
  const healthWord = (key) => ({ healthy: ar ? 'سليم' : 'Healthy', unhealthy: ar ? 'فيه خلل' : 'Check failed', unknown: ar ? 'غير مؤكد' : 'Unknown', unavailable: ar ? 'غير متاح' : 'Unavailable' }[key] || (ar ? 'غير متاح' : 'Unavailable'));
  const runtimeOk = facts.state === 'healthy';
  view.innerHTML = `<div class="page page-wide stack settings-v5"><div class="page-head"><div><h1>${ar ? 'الصحة والسجلات' : 'Health & logs'}</h1><p class="page-summary">${ar ? 'حالة المنصة بكلام واضح. الأسرار ما تنعرض أبدًا.' : 'Platform readiness in plain language. Secrets are never displayed.'}</p></div></div>
    <section class="platform-health ${runtimeOk ? 'is-good' : 'is-warn'}"><span class="capacity-orb"></span><div class="grow"><span>${ar ? 'حالة المنصة' : 'Platform health'}</span><h2>${runtimeOk ? (ar ? 'الخدمة وقاعدة البيانات سليمة' : 'Hub and database are healthy') : facts.state === 'unhealthy' ? (ar ? 'فحص الخدمة أو البيانات فشل' : 'A Hub or database check failed') : (ar ? 'بعض الفحوصات غير متاحة' : 'Some checks are unavailable')}</h2><p>${ar ? 'هذه حالة الخدمة والبيانات. حالة حاويات التشغيل تحتاج فحص نشر منفصل؛ جاهزية Continuity تظهر أدناه.' : 'These checks cover the Hub and database. Container health requires separate deployment verification; Continuity readiness is shown below.'}</p></div><a class="btn" href="#/continuity">${ar ? 'الاستمرارية' : 'Continuity'}</a></section>
    <section class="owner-card"><div class="owner-card-head"><h2>${ar ? 'جاهزية التشغيل' : 'Readiness'}</h2><a href="#/settings/tools">${ar ? 'كل أدوات الربط' : 'All integrations'}</a></div><div class="readiness-grid"><div><span>Hub</span><strong data-owner-health="${facts.hub}">${healthWord(facts.hub)}</strong></div><div><span>${ar ? 'قاعدة البيانات' : 'Database'}</span><strong>${healthWord(facts.database)}</strong></div><div><span>${ar ? 'الأدوات الجاهزة' : 'Ready tools'}</span><strong>${countText(capReady)}</strong></div><div><span>${ar ? 'الموافقات المنتظرة' : 'Pending approvals'}</span><strong>${platform?.approvals?.length ?? '—'}</strong></div><div><span>${ar ? 'Continuity Supervisor' : 'Continuity Supervisor'}</span><strong>${continuity ? (continuity.enabled ? (ar ? 'شغال' : 'On') : (ar ? 'متوقف' : 'Off')) : (ar ? 'غير متاح' : 'Unavailable')}</strong></div><div><span>${ar ? 'العامل النشط' : 'Active worker'}</span><strong>${esc(continuity?.workers?.find((worker) => worker.enabled)?.displayName || (ar ? 'ما في عامل Continuity مفعّل' : 'No enabled Continuity worker'))}</strong></div></div></section>
    <section class="owner-card"><div class="owner-card-head"><h2>${ar ? 'السجلات والعمليات' : 'Logs and operations'}</h2></div><div class="link-grid">
      <a class="link-tile" href="#/office"><strong>${ar ? 'العمليات المباشرة' : 'Live Operations'}</strong><small>${ar ? 'شجرة CHIEF، التسليمات، الخط الزمني، انتظار السعة' : 'CHIEF tree, handoffs, timeline, capacity waits'}</small></a>
      <a class="link-tile" href="#/continuity"><strong>${ar ? 'الاستمرارية ونقاط الحفظ' : 'Continuity & checkpoints'}</strong><small>${ar ? 'الجلسات، نقاط الحفظ، التسليم بين العمّال' : 'Sessions, checkpoints, worker handoffs'}</small></a>
      <a class="link-tile" href="#/work"><strong>${ar ? 'كل العمل' : 'All work'}</strong><small>${ar ? 'الأهداف ومهام البرمجة وآخر الأعمال' : 'Objectives, coding tasks and recent work'}</small></a>
      <a class="link-tile" href="#/settings/models"><strong>${ar ? 'السعة والتكلفة' : 'Capacity & cost'}</strong><small>${ar ? 'المزوّدين، الحصص، الميزانية' : 'Providers, quotas, budget'}</small></a></div></section>
    <details class="disclosure"><summary>${ar ? 'حالة المزودين والمفاتيح' : 'Provider and key status'}</summary><div class="disclosure-body"><p class="small muted">${ar ? 'تظهر الحالة فقط؛ لا تظهر قيمة أي مفتاح.' : 'Only presence/readiness is shown. Secret values are never returned.'}</p><div class="provider-grid">${[...providers.values()].map((item) => { const [tone, label] = providerStatus(item); return `<div class="provider-safe"><strong>${esc(item.provider)}</strong><span class="pill ${tone}">${label}</span></div>`; }).join('') || `<p>${ar ? 'لا توجد بيانات مزودين.' : 'No provider data.'}</p>`}</div></div></details>
    <details class="disclosure"><summary>${ar ? 'تفاصيل تقنية متقدمة' : 'Advanced technical details'}</summary><div class="disclosure-body"><dl class="kv"><div><dt>Version</dt><dd class="mono">${esc(String(health?.version || platform?.systemHealth?.version || '—').slice(0, 12))}</dd></div><div><dt>${ar ? 'آخر نشاط للعامل' : 'Last worker activity'}</dt><dd>${platform?.systemHealth?.lastAgentActivityAt ? when(platform.systemHealth.lastAgentActivityAt) : '—'}</dd></div><div><dt>${ar ? 'آخر فحص مزودين' : 'Last provider canary'}</dt><dd>${esc(platform?.systemHealth?.lastCanary?.status || '—')}</dd></div><div><dt>${ar ? 'محركات متاحة' : 'Live engines'}</dt><dd>${platform?.modelPool?.live ?? '—'} / ${platform?.modelPool?.total ?? '—'}</dd></div></dl><p class="small muted">${ar ? 'معلومات تشخيصية فقط، بدون JSON خام أو أسرار.' : 'Diagnostic summary only, with no raw JSON or secrets.'}</p></div></details></div>`;
}

async function renderAppearancePanel() {
  const ar = state.language === 'ar';
  setTitle(ar ? 'اللغة والمظهر' : 'Language & appearance');
  view.innerHTML = `<div class="page page-wide stack settings-v5"><div class="page-head"><div><h1>${ar ? 'اللغة والمظهر' : 'Language & appearance'}</h1><p class="page-summary">${ar ? 'تُحفظ اختياراتك على هذا الجهاز وتبقى بعد إعادة التحميل.' : 'Your choices are saved on this device and survive reloads.'}</p></div></div>
    <div class="settings-grid"><section class="card"><h2 class="card-title">${ar ? 'اللغة' : 'Language'}</h2><div class="segmented" role="radiogroup" aria-label="${ar ? 'اللغة' : 'Language'}" id="languageChips"><button type="button" role="radio" class="chip ${state.language === 'ar' ? 'active' : ''}" aria-checked="${state.language === 'ar'}" data-language="ar">العربية</button><button type="button" role="radio" class="chip ${state.language === 'en' ? 'active' : ''}" aria-checked="${state.language === 'en'}" data-language="en">English</button></div><p class="small muted">${ar ? 'العربية هي الافتراضية، وكل المحتوى المختلط يدعم اتجاهه الطبيعي.' : 'Arabic is the default; mixed Arabic/English content keeps its natural direction.'}</p></section>
      <section class="card"><h2 class="card-title">${ar ? 'المظهر' : 'Appearance'}</h2><div class="segmented" role="radiogroup" aria-label="${ar ? 'المظهر' : 'Appearance'}" id="themeChips">${[['auto', ar ? 'تلقائي' : 'Automatic'], ['light', ar ? 'فاتح' : 'Light'], ['dark', ar ? 'داكن' : 'Dark']].map(([value, label]) => `<button type="button" role="radio" class="chip" data-theme-choice="${value}">${label}</button>`).join('')}</div><p class="small muted">${ar ? 'التلقائي يتبع إعداد جهازك.' : 'Automatic follows your device setting.'}</p></section>
      <section class="card"><h2 class="card-title">${ar ? 'الحساب' : 'Account'}</h2><p class="small muted">${ar ? 'الدخول خاص بالمالك ولا يوجد تسجيل عام.' : 'Owner-only access. Public signup is disabled.'}</p><button class="btn" id="logout">${ar ? 'تسجيل خروج' : 'Sign out'}</button></section>
      <section class="card"><h2 class="card-title">${ar ? 'المكتب المرئي' : 'Office view'}</h2><p class="small muted">${ar ? 'المكتب ثلاثي الأبعاد متاح من «كل الأقسام ← المكتب المباشر». الأجهزة الصغيرة واللمسية تستخدم المكتب المبسّط تلقائيًا. نهار وغامر وتلقائي تغيّر الإضاءة فقط.' : 'The 3D Office is under “All sections → Live Office”. Small and touch devices use the simplified Office automatically. Light, Immersive and Auto change only the lighting.'}</p><label class="check"><input type="checkbox" id="simplifiedOffice"> <span>${ar ? 'استخدم المكتب المبسّط دائمًا' : 'Always use the simplified Office'}</span></label><label class="small muted" for="officeQuality">${ar ? 'الجودة' : 'Quality'}</label><select class="input input-sm" id="officeQuality"><option value="">${ar ? 'تلقائي' : 'Automatic'}</option><option value="high">High</option><option value="balanced">Balanced</option><option value="lean">Lean</option><option value="light">Light</option></select></section></div></div>`;
  let current = 'auto';
  try { current = localStorage.getItem('hub-theme') || 'auto'; } catch {}
  const mark = () => document.querySelectorAll('[data-theme-choice]').forEach((chip) => { const on = chip.dataset.themeChoice === current; chip.classList.toggle('active', on); chip.setAttribute('aria-checked', String(on)); });
  mark();
  bind(view, { '[data-theme-choice]': (_, element) => { current = element.dataset.themeChoice; try { if (current === 'auto') localStorage.removeItem('hub-theme'); else localStorage.setItem('hub-theme', current); } catch {} applyTheme(current); mark(); } });
  bind(view, { '[data-language]': (_, element) => { const language = element.dataset.language === 'en' ? 'en' : 'ar'; try { localStorage.setItem('hub-language', language); } catch {} state.language = applyLanguage(language); route(); } });
  const pref = (key) => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };
  const setPref = (key, value) => { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch {} };
  $('#simplifiedOffice').checked = pref('hub-office-view') === 'simplified';
  $('#simplifiedOffice').onchange = (event) => setPref('hub-office-view', event.target.checked ? 'simplified' : '');
  $('#officeQuality').value = pref('hub-office-quality');
  $('#officeQuality').onchange = (event) => setPref('hub-office-quality', event.target.value);
  $('#logout').onclick = async () => { await fetch('./api/auth/logout', { method: 'POST' }).catch(() => {}); location.reload(); };
}

// ------------------------------------------------------------------ dialogs
function dialog({ title, body = '', input = null, confirm = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const element = document.createElement('dialog');
    element.className = 'app-dialog';
    const okLabel = confirm === 'OK' ? (state.language === 'ar' ? 'تم' : 'OK') : confirm === 'Yes' ? (state.language === 'ar' ? 'نعم' : 'Yes') : confirm;
    element.innerHTML = `<form method="dialog" class="app-dialog-form"><span class="dialog-kicker">${state.language === 'ar' ? 'قرار المالك' : 'Owner decision'}</span><h2 class="dialog-title">${esc(title)}</h2>${body ? `<p class="dialog-body" dir="auto">${esc(body)}</p>` : ''}${input !== null ? `<textarea class="input dialog-input" rows="${input.multiline ? 3 : 1}" dir="auto">${esc(input.value)}</textarea>` : ''}<div class="dialog-actions"><button class="btn btn-ghost" value="cancel">${state.language === 'ar' ? 'إلغاء' : 'Cancel'}</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" value="ok">${esc(okLabel)}</button></div></form>`;
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
