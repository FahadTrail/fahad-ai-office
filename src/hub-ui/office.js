// The Live Office — loaded on demand (its script, styles and art never load
// on other routes). Every station, state, handoff and timeline entry comes
// from the Hub API, which derives them from real rows; nothing moves unless
// the work behind it is real.
//
// The Office is the 3D "Daylight Atrium" (Final Design Spec, October 2026)
// with its spatial overlay: the Office capsule and project selector, the view
// control (Overview · CHIEF · Departments · Handoffs), the lighting mode
// (Light · Immersive · Auto), ⌘K and notifications, the ruled stat bar,
// floor-anchored labels, the agent panel and L5 toasts. The simplified Office
// remains only for devices that cannot draw 3D, or by choice.
import { roleMark, stationArt } from './characters.js?v=__UI_VERSION__';
import { describeOffice, officeRenderer, presentationState, visualState } from './office-presentation.js?v=__UI_VERSION__';
import { copyFor, departmentName, formatCost, formatDuration, formatTokens, stateLabel } from './office-copy.js?v=__UI_VERSION__';

const FLOOR = [
  ['research', 'product', 'coding'],
  ['creative', 'chief', 'finance'],
  ['social', 'legal', 'audit'],
];
const ACTIVE = new Set(['THINKING', 'WORKING', 'TESTING', 'REVIEWING']);
const RED = new Set(['NEEDS FAHAD', 'BLOCKED', 'FAILED']);
const STATUS_TONE = { info: 'info', working: 'working', done: 'done', waiting: 'waiting', attention: 'attention', failed: 'failed' };
const DEPARTMENTS = ['research', 'creative', 'social', 'coding', 'product', 'finance', 'audit', 'legal'];
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

export { visualState };
const stateWord = (value) => (value.charAt(0) + value.slice(1).toLowerCase()).replace(/\bfahad\b/, 'Fahad');
// The tone a state shows in the overlay: red only for real attention.
export const toneOf = (employee) => (employee?.enabled === false ? 'offline' : RED.has(employee?.state) ? 'attention' : ACTIVE.has(employee?.state) ? 'working' : employee?.state === 'COMPLETED' ? 'done' : 'neutral');

export async function renderOffice(ctx) {
  const { api, esc, when, q, ws, view, setTitle, onChange, every, toast } = ctx;
  await ensureOfficeStyles();
  const language = ctx.language === 'en' ? 'en' : 'ar';
  const t = copyFor(language);
  const rtl = language === 'ar';
  setTitle(t.title);
  const filters = { agent: '', status: '', job: '' };
  view.innerHTML = `<div class="office" data-motion="${ctx.reducedMotion() ? 'reduced' : 'full'}" dir="${rtl ? 'rtl' : 'ltr'}">
    <header class="office-head">
      <div><h1>${esc(t.title)}</h1><p class="office-live"><span class="live-dot" id="liveDot" aria-hidden="true"></span><span id="liveText">${esc(t.live)}</span></p></div>
      <form class="ask-chief" id="askChief"><label class="sr-only" for="askChiefInput">${esc(t.askLabel)}</label>
        <input id="askChiefInput" class="input" dir="auto" autocomplete="off" placeholder="${esc(t.ask)}"><button class="btn btn-primary" type="submit">${esc(t.send)}</button></form>
    </header>
    <p class="page-summary office-summary" id="officeSummary" aria-live="polite"></p>
    <div class="office-stats" id="officeStats" aria-live="polite" hidden></div>
    <section class="stage" id="immersive" hidden aria-label="${esc(t.stage)}" data-phase="day">
      <div class="o3d-stage" id="o3dStage"></div>
      <div class="o3d-labels" id="o3dLabels" role="group" aria-label="${esc(t.departments)}"></div>
      <div class="o3d-loading" id="o3dLoading" role="status"><div class="o3d-mark" aria-hidden="true">F</div><strong>${esc(t.loading)}</strong>
        <span class="small" id="o3dProgress">${esc(t.loadingEngine)}</span><div class="o3d-bar"><span id="o3dBar"></span></div>
        <button type="button" class="ov-btn" id="o3dUseSimplified">${esc(t.useSimplified)}</button></div>
      <div class="ov ov-top" id="ovTop">
        <div class="ov-capsule"><span class="ov-mark" aria-hidden="true">F</span><span class="ov-office">Fahad AI Office</span><span class="ov-sep" aria-hidden="true">/</span>
          <label class="sr-only" for="o3dProject">${esc(t.project)}</label><select class="ov-select" id="o3dProject"><option value="">${esc(t.allProjects)}</option></select></div>
        <nav class="ov-views" aria-label="${esc(t.views)}">
          <button type="button" class="ov-view" data-view="overview" aria-pressed="true">${esc(t.overview)}</button>
          <button type="button" class="ov-view" data-view="chief" aria-pressed="false">${esc(t.chief)}</button>
          <button type="button" class="ov-view" data-view="departments" aria-pressed="false" aria-expanded="false" aria-controls="ovDepartments">${esc(t.departments)}</button>
          <button type="button" class="ov-view" data-view="handoffs" aria-pressed="false" aria-controls="ovSheet"><span>${esc(t.handoffs)}</span> <span class="num" id="ovHandoffCount">0</span></button>
        </nav>
        <div class="ov-tools">
          <div class="ov-mode" role="group" aria-label="${esc(t.mode)}">
            <button type="button" class="ov-mode-btn" data-light="light" aria-pressed="false">${esc(t.light)}</button>
            <button type="button" class="ov-mode-btn" data-light="immersive" aria-pressed="false">${esc(t.immersive)}</button>
            <button type="button" class="ov-mode-btn" data-light="auto" aria-pressed="false">${esc(t.auto)}</button></div>
          <button type="button" class="ov-icon" id="ovSearch" aria-label="${esc(t.search)}" title="${esc(t.search)} (⌘K)"><span aria-hidden="true">⌘K</span></button>
          <a class="ov-icon ov-bell" id="ovBell" href="#/attention" aria-label="${esc(t.notifications)}"><span aria-hidden="true">●</span><span class="num" id="ovBellCount">0</span></a>
          <button type="button" class="ov-icon" id="ovSummaryBtn" aria-pressed="false" aria-controls="ovSheet">${esc(t.summary)}</button>
          <span class="ov-live" id="ovLive"><span class="ov-live-dot" aria-hidden="true"></span>${esc(t.liveShort)}</span>
        </div>
      </div>
      <div class="ov-menu" id="ovDepartments" hidden role="menu" aria-label="${esc(t.departments)}"></div>
      <div class="ov-banner" id="ovBanner" hidden role="status"></div>
      <div class="ov ov-bottom" id="ovBottom">
        <dl class="ov-stats" id="ovStats" aria-live="polite"></dl>
        <div class="ov-toasts" id="ovToasts" aria-live="polite"></div>
      </div>
      <aside class="ov-panel" id="ovPanel" hidden aria-labelledby="ovPanelTitle"></aside>
      <aside class="ov-sheet" id="ovSheet" hidden aria-labelledby="ovSheetTitle"></aside>
      <p class="sr-only" aria-live="polite" id="o3dSummary"></p>
    </section>
    <div class="office-body">
      <section class="scene" id="scene" aria-label="Office floor"><div class="floor" id="floor"><svg class="handoff-layer" id="handoffLayer" role="group" aria-label="Handoffs between employees"></svg><div class="stations" id="stations"></div></div>
        <div class="scene-legend" aria-hidden="true"><span><i class="lg lg-working"></i>Working</span><span><i class="lg lg-waiting"></i>Waiting</span><span><i class="lg lg-needs"></i>Needs you</span><span><i class="lg lg-done"></i>Just delivered</span><span><i class="lg lg-handoff"></i>Handoff</span></div>
        <p class="small muted scene-note" id="sceneNote"></p>
      </section>
      <aside class="office-side">
        <div id="officeNeeds"></div>
        <section class="side-card"><h2 class="side-title">${esc(t.objectives)}</h2><div id="officeObjectives"></div></section>
        <section class="side-card timeline-card"><div class="side-head"><h2 class="side-title">${esc(t.timeline)}</h2>
          <div class="tl-filters"><label class="sr-only" for="tlAgent">Employee</label><select id="tlAgent" class="input input-sm"><option value="">Everyone</option></select>
          <label class="sr-only" for="tlStatus">Status</label><select id="tlStatus" class="input input-sm"><option value="">Any status</option><option value="working">Started</option><option value="done">Delivered</option><option value="waiting">Waiting</option><option value="attention">Needs you</option><option value="failed">Failed</option><option value="info">Handoffs &amp; requests</option></select>
          <label class="sr-only" for="tlJob">Objective</label><select id="tlJob" class="input input-sm"><option value="">All objectives</option></select></div></div>
          <ol class="tl-list" id="timeline" aria-live="polite"></ol></section>
      </aside>
    </div>
  </div>`;
  const $ = (selector) => view.querySelector(selector);

  $('#askChief').onsubmit = async (event) => {
    event.preventDefault();
    const message = $('#askChiefInput').value.trim();
    if (!message) return;
    try {
      const created = await api('/api/conversations', { method: 'POST', body: { workspaceId: ws(), message } });
      location.hash = `#/chat/${created.conversation.id}`;
    } catch (error) { toast(error.message); }
  };

  let data = null;
  let signature = '';
  let artifacts = [];
  let previous = null;
  // Rendering capability (3D or simplified) is separate from the lighting mode.
  let renderer = officeRenderer({ preference: readPref('hub-office-view', 'auto'), capability: capability(ctx) });
  let lightMode = readPref('hub-office-light-mode', 'auto');
  let immersive = null;
  let mounting = null;
  let viewState = { name: 'overview' };
  let selectedProject = '';
  let panelKey = null;
  let sheetKind = null;
  const fromLabels = new Map(); // key → { from, until }
  const presentation = () => presentationState({ office: data, artifacts });

  // Read-only hooks for visual and performance QA (tools/office-shots.mjs).
  window.__fahadOffice3d = {
    stats: () => immersive?.stats() || null, renderer: () => renderer,
    view: (request, options) => { if (request?.name === 'agent') openPanel(request.key, { camera: false }); immersive?.setView(request, options); },
    lightMode: (name) => setLightMode(name), ready: () => immersive?.ready, summary: (open) => toggleSheet(open ? 'summary' : null),
  };

  const load = async () => {
    const [next, library] = await Promise.all([
      api(`/api/office${q({ workspaceId: ws() })}`),
      renderer.render === '3d' ? api(`/api/artifacts${q({ workspaceId: ws(), limit: 60 })}`).catch(() => ({ artifacts })) : Promise.resolve({ artifacts }),
    ]);
    const nextSignature = JSON.stringify([next, library.artifacts?.length, library.artifacts?.[0]?.id]);
    if (nextSignature === signature) return;
    signature = nextSignature;
    data = next;
    artifacts = library.artifacts || [];
    drawSide();
    const state = presentation();
    $('#officeSummary').textContent = describeOffice(state, language);
    if (renderer.render === '3d') drawImmersive(state);
    else { drawStats(); drawStations(); drawHandoffs(); }
    previous = state;
  };

  const applyRenderer = () => {
    const on3d = renderer.render === '3d';
    $('#immersive').hidden = !on3d;
    $('#scene').hidden = on3d;
    $('.office').classList.toggle('is-immersive', on3d);
    $('.office-body').classList.toggle('is-below', on3d);
    $('#officeStats').hidden = on3d;
    $('#sceneNote').textContent = on3d ? '' : `${t.simplifiedNote} — ${t.reasons[renderer.reason] || ''}`;
    if (!on3d && immersive) { immersive.dispose(); immersive = null; }
  };
  $('#o3dUseSimplified').onclick = () => { writePref('hub-office-view', 'simplified'); renderer = officeRenderer({ preference: 'simplified', capability: capability(ctx) }); signature = ''; applyRenderer(); load().catch(() => {}); };

  const fallBack = (reason) => {
    if (immersive) { try { immersive.dispose(); } catch { /* already gone */ } immersive = null; }
    renderer = { render: 'simplified', reason };
    applyRenderer(); signature = '';
    toast(t.reasons[reason] || reason);
    load().catch(() => {});
  };

  // ------------------------------------------------------------ the 3D Office
  const stage = $('#immersive');
  const stageRect = () => stage.getBoundingClientRect();
  const relative = (element) => {
    if (!element || element.hidden || !element.offsetParent) return null;
    const box = element.getBoundingClientRect(); const base = stageRect();
    return box.width && box.height ? { x: box.left - base.left, y: box.top - base.top, w: box.width, h: box.height } : null;
  };
  // Panels the labels must never cover, and the camera keeps clear of.
  const avoidRects = () => [$('#ovTop'), $('#ovBottom .ov-stats'), $('#ovToasts'), $('#ovPanel'), $('#ovSheet'), $('#ovBanner'), $('#ovDepartments')].map(relative).filter(Boolean);
  const insets = () => {
    const box = stageRect(); if (!box.height) return {};
    const top = relative($('#ovTop')); const bottom = relative($('#ovBottom .ov-stats'));
    const panel = relative($('#ovPanel')) || relative($('#ovSheet'));
    const side = panel ? Math.min(0.45, (panel.w + 24) / box.width) : 0;
    return { top: top ? (top.y + top.h + 8) / box.height : 0, bottom: bottom ? (box.height - bottom.y + 8) / box.height : 0, ...(rtl ? { left: side } : { right: side }) };
  };

  const drawImmersive = async (state) => {
    $('#o3dSummary').textContent = describeOffice(state, language);
    drawOverlay(state);
    if (immersive) { immersive.update(state); return; }
    if (mounting) return mounting;
    const progress = (text, share) => { $('#o3dProgress').textContent = text; $('#o3dBar').style.width = `${Math.round(share * 100)}%`; };
    $('#o3dLoading').hidden = false;
    mounting = (async () => {
      try {
        progress(t.loadingEngine, 0.1);
        const module = await import('./office3d/scene.js?v=__UI_VERSION__');
        progress(t.loadingBuild, 0.25);
        await document.fonts?.ready;
        if (renderer.render !== '3d' || !$('#o3dStage')) return;
        immersive = module.mountOffice3D($('#o3dStage'), {
          state: presentation(), quality: readPref('hub-office-quality', '') || renderer.quality || 'balanced', reducedMotion: ctx.reducedMotion(), lightMode, rtl,
          copy: { wall: t.wall }, stateWord: (value) => stateLabel(value, language), insets,
          stream: () => (data?.timeline || []).slice(0, 6).map((entry) => ({ text: entry.text, time: new Date(entry.at).toLocaleTimeString(language === 'ar' ? 'ar-AE' : 'en', { hour: '2-digit', minute: '2-digit' }) })),
          on: {
            progress: (share) => { if (share < 1) progress(share < 0.35 ? t.loadingBuild : t.loadingMaterials, share); else { progress(t.ready, 1); $('#o3dLoading').hidden = true; } },
            select: (key) => openPanel(key),
            handoff: (handoff) => openHandoff(ctx, handoff),
            view: (next) => { viewState = next; markViews(); },
            phase: (phase) => { stage.dataset.phase = phase; },
            frame: (frame) => placeLabels(frame),
            arrival: (handoff) => { fromLabels.set(handoff.toKey, { from: handoff.fromKey, until: performance.now() + 3000 }); },
            error: (error) => { console.warn('3D Office stopped:', error?.message || error); fallBack('stopped'); },
            slow: () => fallBack('slow'),
          },
        });
        stage.dataset.phase = immersive.phase();
        markLight();
        await immersive.ready;
        $('#o3dLoading').hidden = true;
      } catch (error) {
        console.warn('3D Office unavailable:', error?.message || error);
        fallBack('failed');
      } finally { mounting = null; }
    })();
    return mounting;
  };

  // ------------------------------------------------------------ overlay
  const drawOverlay = (state) => {
    // Project selector.
    const select = $('#o3dProject');
    select.innerHTML = `<option value="">${esc(t.allProjects)}</option>${state.projects.map((project) => `<option value="${esc(project.id)}">${esc(project.title)}</option>`).join('')}`;
    select.value = state.projects.some((project) => project.id === selectedProject) ? selectedProject : '';
    // Departments menu.
    $('#ovDepartments').innerHTML = DEPARTMENTS.map((key) => { const employee = state.employees.find((entry) => entry.key === key); const tone = toneOf(employee);
      return `<button type="button" role="menuitem" class="ov-menu-item" data-key="${key}"><span class="ov-dot" data-tone="${tone}" aria-hidden="true"></span><span class="grow">${esc(departmentName(key, language))}</span><span class="ov-menu-state" data-tone="${tone}">${esc(employee ? stateLabel(employee.visual, language) : '')}</span><kbd>${key === 'chief' ? 0 : DEPARTMENTS.indexOf(key) + 1}</kbd></button>`; }).join('');
    $('#ovDepartments').querySelectorAll('[data-key]').forEach((button) => { button.onclick = () => { closeMenu(); go({ name: 'department', key: button.dataset.key }); }; });
    $('#ovHandoffCount').textContent = String(state.handoffs.length);
    $('#ovBellCount').textContent = String(state.needsFahad || 0);
    $('#ovBell').dataset.tone = state.needsFahad ? 'attention' : 'neutral';
    drawStatBar(state);
    drawBanner(state);
    announce(state);
    if (panelKey) refreshPanelHeader(state);
    if (sheetKind) drawSheet(sheetKind, state);
    previous = state;
  };

  // The ruled stat bar: Working · Needs you · Blocked · Delivered today.
  const drawStatBar = (state) => {
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const working = state.employees.filter((employee) => employee.active).length;
    const needs = Number(state.needsFahad || 0);
    const blocked = state.employees.filter((employee) => ['BLOCKED', 'FAILED'].includes(employee.state)).length;
    const delivered = (state.deliveries || []).filter((delivery) => Date.parse(delivery.at) >= midnight.getTime()).length;
    $('#ovStats').innerHTML = [['working', working, 'neutral'], ['needs', needs, needs ? 'attention' : 'neutral'], ['blocked', blocked, blocked ? 'attention' : 'neutral'], ['delivered', delivered, 'neutral']]
      .map(([id, value, tone]) => `<div class="ov-stat" data-tone="${tone}" data-stat="${id}"><dt>${esc(t[id])}</dt><dd class="num">${String(value).padStart(2, '0')}</dd></div>`).join('');
  };

  // Banners: model capacity (amber), employees turned off (grey). Real only.
  const drawBanner = (state) => {
    const waiting = state.employees.filter((employee) => employee.state === 'WAITING' && (employee.resumesAt || /free model capacity/i.test(employee.detail || '')));
    const off = state.employees.filter((employee) => employee.enabled === false);
    const banner = $('#ovBanner');
    if (waiting.length) {
      const at = waiting.map((employee) => employee.resumesAt).filter(Boolean).sort()[0];
      banner.dataset.tone = 'caution';
      banner.textContent = t.capacity(waiting.map((employee) => employee.label).join(language === 'ar' ? '، ' : ', '), at ? new Date(at).toLocaleTimeString(language === 'ar' ? 'ar-AE' : 'en', { hour: '2-digit', minute: '2-digit' }) : null);
      banner.hidden = false;
    } else if (off.length) {
      banner.dataset.tone = 'offline'; banner.textContent = t.offline(off.map((employee) => employee.label).join(language === 'ar' ? '، ' : ', ')); banner.hidden = false;
    } else banner.hidden = true;
  };

  // L5 alerts: UI toasts only, for real changes seen while the Office is open.
  const announced = new Set();
  const announce = (state) => {
    if (!previous) { for (const handoff of state.handoffs) announced.add(`h:${handoff.id}@${handoff.at}`); return; }
    const before = new Map(previous.employees.map((employee) => [employee.key, employee.state]));
    const items = [];
    for (const handoff of state.handoffs) {
      const id = `h:${handoff.id}@${handoff.at}`;
      if (announced.has(id) || !handoff.fresh) continue;
      announced.add(id);
      items.push({ tone: handoff.status === 'blocked' || handoff.status === 'failed' ? 'attention' : 'working', text: `${t.handedOver(departmentName(handoff.fromKey, language), departmentName(handoff.toKey, language))}`, detail: handoff.task || handoff.objective || '' });
    }
    for (const employee of state.employees) {
      const was = before.get(employee.key);
      if (was === employee.state) continue;
      if (employee.state === 'COMPLETED') items.push({ tone: 'done', text: t.deliveredToast(departmentName(employee.key, language), ''), detail: employee.task || employee.deliverable || '' });
      if (employee.state === 'NEEDS FAHAD') items.push({ tone: 'attention', text: t.needsToast(departmentName(employee.key, language)), detail: employee.detail || '' });
      if (employee.state === 'BLOCKED' || employee.state === 'FAILED') items.push({ tone: 'attention', text: t.blockedToast(departmentName(employee.key, language)), detail: employee.detail || '' });
    }
    for (const item of items.slice(0, 3)) {
      const element = document.createElement('div');
      element.className = 'ov-toast'; element.dataset.tone = item.tone;
      element.innerHTML = `<span class="ov-dot" data-tone="${esc(item.tone)}" aria-hidden="true"></span><span class="grow"><strong>${esc(item.text)}</strong>${item.detail ? `<span dir="auto">${esc(item.detail)}</span>` : ''}</span>`;
      $('#ovToasts').prepend(element);
      setTimeout(() => { element.classList.add('leaving'); setTimeout(() => element.remove(), ctx.reducedMotion() ? 0 : 280); }, 6000);
    }
    while ($('#ovToasts').children.length > 3) $('#ovToasts').lastElementChild.remove();
  };

  // ------------------------------------------------------------ views
  const markViews = () => {
    const name = viewState.name === 'agent' || viewState.name === 'department' ? 'departments' : viewState.name === 'idle' ? 'overview' : viewState.name;
    view.querySelectorAll('.ov-view').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.view === name)));
    $('#ovSummaryBtn').setAttribute('aria-pressed', String(sheetKind === 'summary'));
  };
  const go = (request) => { if (request.name !== 'agent' && panelKey) closePanel({ camera: false }); if (request.name !== 'handoffs' && sheetKind === 'handoffs') toggleSheet(null); immersive?.setView(request); viewState = request; markViews(); };
  const closeMenu = () => { $('#ovDepartments').hidden = true; view.querySelector('.ov-view[data-view="departments"]').setAttribute('aria-expanded', 'false'); };
  view.querySelectorAll('.ov-view').forEach((button) => {
    button.onclick = () => {
      const name = button.dataset.view;
      if (name === 'departments') { const menu = $('#ovDepartments'); menu.hidden = !menu.hidden; button.setAttribute('aria-expanded', String(!menu.hidden)); if (!menu.hidden) menu.querySelector('button')?.focus(); return; }
      closeMenu();
      if (name === 'handoffs') { toggleSheet('handoffs'); go({ name: 'handoffs' }); return; }
      go({ name });
    };
  });
  $('#ovDepartments').addEventListener('keydown', (event) => {
    const items = [...$('#ovDepartments').querySelectorAll('button')]; const index = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
    if (event.key === 'Escape') { event.stopPropagation(); closeMenu(); view.querySelector('.ov-view[data-view="departments"]').focus(); }
  });
  $('#o3dProject').onchange = (event) => { selectedProject = event.target.value; immersive?.setProject(selectedProject); placeLabels(); };
  $('#ovSearch').onclick = () => ctx.search?.();
  $('#ovSummaryBtn').onclick = () => toggleSheet(sheetKind === 'summary' ? null : 'summary');

  // Lighting: Light (10:30) · Immersive (21:30) · Auto (real time).
  const markLight = () => view.querySelectorAll('.ov-mode-btn').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.light === lightMode)));
  const setLightMode = (mode) => { lightMode = ['light', 'immersive', 'auto'].includes(mode) ? mode : 'auto'; writePref('hub-office-light-mode', lightMode); markLight(); immersive?.setLightMode(lightMode); };
  view.querySelectorAll('.ov-mode-btn').forEach((button) => { button.onclick = () => setLightMode(button.dataset.light); });
  markLight();

  // ------------------------------------------------------------ labels (floor-anchored)
  let labelLayout = null;
  const labelsLayer = $('#o3dLabels');
  const labelButtons = new Map();
  const labelFor = (key) => {
    if (labelButtons.has(key)) return labelButtons.get(key);
    const element = document.createElement('div');
    element.className = 'o3d-label'; element.dataset.key = key;
    element.innerHTML = '<span class="o3d-ring" aria-hidden="true"></span><span class="o3d-leader" aria-hidden="true"></span><button type="button" class="o3d-card"><span class="o3d-name"></span><span class="o3d-dot" aria-hidden="true"></span><span class="o3d-state"></span><span class="o3d-task" dir="auto"></span><span class="o3d-from"></span></button>';
    const button = element.querySelector('button');
    button.onclick = () => openPanel(key);
    labelsLayer.append(element);
    labelButtons.set(key, element);
    return element;
  };
  const measure = (element, lod) => { element.dataset.lod = lod; const card = element.querySelector('.o3d-card'); return [card.offsetWidth || 120, card.offsetHeight || 28]; };
  const placeLabels = (frame = lastFrame) => {
    if (!frame || !labelsLayer.isConnected) return;
    lastFrame = frame;
    if (!labelLayout) return;
    const state = previous; if (!state) return;
    const now = performance.now();
    const entries = [];
    for (const anchor of frame.anchors || []) {
      const employee = state.employees.find((entry) => entry.key === anchor.key);
      if (!employee) continue;
      const element = labelFor(anchor.key);
      const tone = toneOf(employee);
      const from = fromLabels.get(anchor.key);
      const dimmed = selectedProject && !state.projects.find((project) => project.id === selectedProject)?.team.includes(anchor.key) && anchor.key !== 'chief';
      element.dataset.tone = tone; element.classList.toggle('dimmed', Boolean(dimmed));
      element.querySelector('.o3d-name').textContent = departmentName(anchor.key, language);
      element.querySelector('.o3d-state').textContent = stateLabel(employee.enabled === false ? 'OFFLINE' : employee.visual, language);
      element.querySelector('.o3d-task').textContent = employee.task || '';
      element.querySelector('.o3d-from').textContent = from && from.until > now ? `${t.from} ${departmentName(from.from, language)}` : '';
      element.querySelector('button').setAttribute('aria-label', `${departmentName(anchor.key, language)}: ${stateLabel(employee.visual, language)}${employee.task ? ` — ${employee.task}` : ''}`);
      const priority = anchor.key === frame.focusKey ? 0 : { attention: 1, working: 2, done: 3, neutral: 4, offline: 5 }[tone];
      entries.push({ key: anchor.key, anchor, distance: anchor.distance, priority, sizes: { full: measure(element, 'full'), name: measure(element, 'name') } });
    }
    const box = stageRect();
    const layout = labelLayout(entries, { width: box.width, height: box.height, avoid: avoidRects(), focus: frame.focusRect || null, rtl, lodScale: frame.lodScale || 1 });
    for (const entry of layout) {
      const element = labelFor(entry.key);
      element.dataset.lod = entry.lod;
      element.hidden = entry.lod === 'hidden';
      if (entry.lod === 'hidden') continue;
      element.style.setProperty('--ax', `${Math.round(entry.anchor.x)}px`); element.style.setProperty('--ay', `${Math.round(entry.anchor.y)}px`);
      if (entry.box) {
        element.style.setProperty('--bx', `${Math.round(entry.box.x)}px`); element.style.setProperty('--by', `${Math.round(entry.box.y)}px`);
        element.style.setProperty('--ly', `${Math.round(Math.min(entry.leader.y1, entry.leader.y2))}px`); element.style.setProperty('--lh', `${Math.round(Math.abs(entry.leader.y2 - entry.leader.y1))}px`);
      }
      element.classList.toggle('focused', entry.key === frame.focusKey);
      element.classList.toggle('dot-only', !entry.box);
    }
    // Bundled handoffs (more than six at once) show as ×N at the destination.
    for (const element of labelsLayer.querySelectorAll('.o3d-bundle')) element.remove();
    for (const bundle of immersive?.bundles?.() || []) {
      const anchor = (frame.anchors || []).find((entry) => entry.key === bundle.toKey);
      if (!anchor?.visible) continue;
      const badge = document.createElement('span'); badge.className = 'o3d-bundle'; badge.textContent = t.bundled(bundle.count);
      badge.style.setProperty('--ax', `${Math.round(anchor.x)}px`); badge.style.setProperty('--ay', `${Math.round(anchor.y)}px`);
      labelsLayer.append(badge);
    }
  };
  let lastFrame = null;
  import('./office3d/labels.js?v=__UI_VERSION__').then((module) => { labelLayout = module.layoutLabels; placeLabels(); }).catch(() => {});

  // ------------------------------------------------------------ agent panel (360 px)
  const panel = $('#ovPanel');
  const openPanel = async (key, { camera = true } = {}) => {
    const state = previous; const employee = state?.employees.find((entry) => entry.key === key);
    if (!employee) return;
    if (sheetKind) toggleSheet(null);
    panelKey = key;
    panel.hidden = false;
    panel.innerHTML = panelHeader(employee, state) + '<div class="ov-panel-body" aria-busy="true"><div class="ov-skeleton"></div><div class="ov-skeleton"></div></div>';
    bindPanel();
    if (camera) { immersive?.setView({ name: 'agent', key }); viewState = { name: 'agent', key }; markViews(); }
    try {
      const detail = await api(`/api/agents/${employee.slug}${q({ workspaceId: ws() })}`);
      if (panelKey !== key) return;
      panel.querySelector('.ov-panel-body').outerHTML = panelBody(employee, detail);
      bindPanel(detail);
    } catch (error) {
      if (panelKey === key) panel.querySelector('.ov-panel-body').innerHTML = `<p class="ov-error">${esc(error.message)}</p>`;
    }
  };
  const closePanel = ({ camera = true } = {}) => {
    const key = panelKey;
    panelKey = null; panel.hidden = true; panel.innerHTML = '';
    if (camera && key) go(key === 'chief' ? { name: 'overview' } : { name: 'department', key });
    labelFor(key || 'chief').querySelector('button')?.focus();
  };
  const panelHeader = (employee, state) => {
    const tone = toneOf(employee);
    return `<header class="ov-panel-head"><div><span class="ov-kicker">${esc(departmentName(employee.key, language))}</span>
      <h2 id="ovPanelTitle">${esc(employee.label)}</h2><span class="ov-chip" data-tone="${tone}"><span class="ov-dot" data-tone="${tone}" aria-hidden="true"></span>${esc(stateLabel(employee.enabled === false ? 'OFFLINE' : employee.visual, language))}</span></div>
      <button type="button" class="ov-icon" data-close aria-label="${esc(t.close)}">✕</button></header>`;
  };
  const refreshPanelHeader = (state) => { const employee = state.employees.find((entry) => entry.key === panelKey); const head = panel.querySelector('.ov-panel-head'); if (employee && head) { head.outerHTML = panelHeader(employee, state); bindPanel(); } };
  const panelBody = (employee, detail) => {
    const usage = detail.usage || null;
    const assignment = detail.state?.assignment || null;
    const stepTone = { working: 'working', done: 'done', failed: 'attention', blocked: 'attention' };
    const action = employee.key === 'coding' ? `<a class="ov-btn ov-btn-primary" href="#/code">${esc(t.giveCoding)}</a>`
      : employee.key === 'chief' ? `<a class="ov-btn ov-btn-primary" href="#/chief">${esc(t.askChief)}</a>`
        : detail.agent?.directChat ? `<a class="ov-btn ov-btn-primary" href="#/talk/${esc(employee.slug)}">${esc(t.message)}</a>` : '';
    return `<div class="ov-panel-body">
      <section><h3>${esc(t.currentTask)}</h3>${assignment ? `<p class="ov-task" dir="auto">${esc(assignment.task || assignment.objective || '')}</p>${assignment.objective && assignment.objective !== assignment.task ? `<p class="ov-muted" dir="auto">${esc(assignment.objective)}</p>` : ''}` : `<p class="ov-muted">${esc(t.noTask)}</p>`}</section>
      <dl class="ov-facts">
        <div><dt>${esc(t.model)}</dt><dd dir="ltr">${esc(usage?.model ? `${usage.model}` : t.unavailable)}</dd></div>
        <div><dt>${esc(t.duration)}</dt><dd>${esc(formatDuration(usage?.durationMs, language))}</dd></div>
        <div><dt>${esc(t.cost)}</dt><dd dir="ltr">${esc(usage ? formatCost(usage.costUsd, language) : t.unavailable)}</dd></div>
        <div><dt>${esc(t.tokens)}</dt><dd dir="ltr">${esc(usage ? formatTokens(usage.inputTokens, usage.outputTokens, language) : t.unavailable)}</dd></div></dl>
      ${detail.pipeline?.length ? `<section><h3>${esc(t.pipeline)}</h3><ol class="ov-pipeline" aria-label="${esc(t.pipeline)}">${detail.pipeline.map((step) => `<li data-tone="${stepTone[step.state] || 'neutral'}" class="${step.key === employee.key ? 'is-self' : ''}" title="${esc(step.title)}"><span class="ov-dot" data-tone="${stepTone[step.state] || 'neutral'}" aria-hidden="true"></span><span>${esc(departmentName(step.key, language))}</span><span class="ov-muted">${esc(t.steps[step.state] || step.state)}</span></li>`).join('')}</ol></section>` : ''}
      <section><h3>${esc(t.chain)}</h3>${detail.chain?.length ? `<ol class="ov-chain">${detail.chain.map((handoff, index) => `<li><button type="button" class="ov-link" data-chain="${index}"><span>${esc(t.handedOver(departmentName(handoff.fromKey, language), departmentName(handoff.toKey, language)))}</span><time class="ov-muted">${esc(when(handoff.at))}</time></button></li>`).join('')}</ol>` : `<p class="ov-muted">${esc(t.noChain)}</p>`}</section>
      <section><h3>${esc(t.deliveries)}</h3>${detail.deliveries?.length ? `<ol class="ov-deliveries">${detail.deliveries.map((delivery) => `<li><a href="#/workflow/${esc(delivery.jobId)}" dir="auto">${esc(delivery.title)}</a><time class="ov-muted">${esc(when(delivery.at))}</time></li>`).join('')}</ol>` : `<p class="ov-muted">${esc(t.noDeliveries)}</p>`}</section>
      <div class="ov-actions">${action}<button type="button" class="ov-btn" data-workspace>${esc(t.openWorkspace)}</button>${assignment?.jobId ? `<a class="ov-btn" href="#/workflow/${esc(assignment.jobId)}">${esc(t.openObjective)}</a>` : ''}</div>
    </div>`;
  };
  const bindPanel = (detail) => {
    panel.querySelectorAll('[data-close]').forEach((button) => { button.onclick = () => closePanel(); });
    panel.querySelector('[data-workspace]')?.addEventListener('click', () => { const employee = previous?.employees.find((entry) => entry.key === panelKey); if (employee) openEmployee(ctx, employee.slug); });
    if (detail) panel.querySelectorAll('[data-chain]').forEach((button) => { button.onclick = () => openHandoff(ctx, detail.chain[Number(button.dataset.chain)]); });
  };

  // ------------------------------------------------------------ sheets: handoffs history, executive summary
  const sheet = $('#ovSheet');
  const toggleSheet = (kind) => {
    sheetKind = kind;
    if (!kind) { sheet.hidden = true; sheet.innerHTML = ''; markViews(); return; }
    if (panelKey) closePanel({ camera: false });
    sheet.hidden = false; drawSheet(kind, previous || presentation()); markViews();
    // Re-frame so the sheet never covers the focus.
    if (immersive && ['overview', 'chief'].includes(viewState.name)) immersive.setView(viewState);
  };
  const drawSheet = (kind, state) => {
    if (!state) return;
    if (kind === 'handoffs') {
      sheet.innerHTML = `<header class="ov-panel-head"><h2 id="ovSheetTitle">${esc(t.handoffList)}</h2><button type="button" class="ov-icon" data-close aria-label="${esc(t.close)}">✕</button></header>
        ${state.handoffs.length ? `<ol class="ov-chain">${state.handoffs.slice(0, 30).map((handoff, index) => `<li><button type="button" class="ov-link" data-index="${index}"><span class="ov-dot" data-tone="${handoff.status === 'blocked' || handoff.status === 'failed' ? 'attention' : handoff.fresh ? 'working' : 'neutral'}" aria-hidden="true"></span><span class="grow"><strong>${esc(t.handedOver(departmentName(handoff.fromKey, language), departmentName(handoff.toKey, language)))}</strong><span class="ov-muted" dir="auto">${esc(handoff.task || handoff.objective || '')}</span></span><time class="ov-muted">${esc(when(handoff.at))}</time></button></li>`).join('')}</ol>` : `<p class="ov-muted">${esc(t.noHandoffs)}</p>`}`;
      sheet.querySelectorAll('[data-index]').forEach((button) => { button.onclick = () => openHandoff(ctx, state.handoffs[Number(button.dataset.index)]); });
    } else {
      const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
      const today = (state.deliveries || []).filter((delivery) => Date.parse(delivery.at) >= midnight.getTime());
      const active = state.projects.filter((project) => project.active);
      sheet.innerHTML = `<header class="ov-panel-head"><div><span class="ov-kicker">${esc(t.today)}</span><h2 id="ovSheetTitle">${esc(t.summary)}</h2></div><button type="button" class="ov-icon" data-close aria-label="${esc(t.close)}">✕</button></header>
        <p class="ov-lede" dir="auto">${esc(describeOffice(state, language))}</p>
        <dl class="ov-facts ov-facts-4">${[...$('#ovStats').children].map((stat) => `<div data-tone="${stat.dataset.tone}"><dt>${stat.querySelector('dt').textContent}</dt><dd class="num">${stat.querySelector('dd').textContent}</dd></div>`).join('')}</dl>
        <section><h3>${esc(t.activeObjectives)}</h3>${active.length ? `<ol class="ov-objectives">${active.map((project) => `<li><a href="#/workflow/${esc(project.id)}" dir="auto">${esc(project.title)}</a><span class="ov-progress" role="progressbar" aria-valuenow="${project.progress}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(project.title)}"><span style="width:${Math.max(3, project.progress)}%"></span></span><span class="num ov-muted">${project.progress}%</span></li>`).join('')}</ol>` : `<p class="ov-muted">${esc(t.allClear)}</p>`}</section>
        <section><h3>${esc(t.latestDeliveries)}</h3>${today.length ? `<ol class="ov-deliveries">${today.slice(0, 5).map((delivery) => `<li><span dir="auto"><strong>${esc(departmentName(delivery.key, language))}</strong> · ${esc(delivery.title)}</span><time class="ov-muted">${esc(when(delivery.at))}</time></li>`).join('')}</ol>` : `<p class="ov-muted">${esc(t.noDeliveries)}</p>`}</section>
        <section><h3>${esc(t.handoffsToday)}</h3><p class="num">${state.handoffs.filter((handoff) => Date.parse(handoff.at) >= midnight.getTime()).length}</p></section>`;
    }
    sheet.querySelectorAll('[data-close]').forEach((button) => { button.onclick = () => { toggleSheet(null); if (kind === 'handoffs') go({ name: 'overview' }); }; });
  };

  // Escape closes the innermost layer first; the scene steps the camera back.
  const onKey = (event) => {
    if (document.querySelector('.sheet.open')) return;
    if (event.key === 'Escape' && !$('#ovDepartments').hidden) { closeMenu(); return; }
    if (event.key === 'Escape' && panelKey) { event.stopImmediatePropagation(); closePanel(); return; }
    if (event.key === 'Escape' && sheetKind) { event.stopImmediatePropagation(); toggleSheet(null); go({ name: 'overview' }); }
  };
  window.addEventListener('keydown', onKey, true);
  ctx.onLeave(() => window.removeEventListener('keydown', onKey, true));
  ctx.onLeave(() => { if (immersive) { immersive.dispose(); immersive = null; } delete window.__fahadOffice3d; });
  applyRenderer();

  // ------------------------------------------------------------ the simplified Office (fallback)
  const drawStats = () => {
    const working = data.agents.filter((agent) => ACTIVE.has(agent.state)).length;
    const waiting = data.agents.filter((agent) => ['WAITING', 'QUEUED'].includes(agent.state)).length;
    const available = data.agents.filter((agent) => agent.state === 'AVAILABLE').length;
    const objectives = data.workflows.filter((flow) => !['completed', 'failed', 'cancelled'].includes(flow.status)).length;
    $('#officeStats').innerHTML = [
      ['working', working, 'working now'], ['waiting', waiting, 'waiting'], ['needs', data.needsFahad, data.needsFahad === 1 ? 'needs you' : 'need you'],
      ['objectives', objectives, objectives === 1 ? 'objective in progress' : 'objectives in progress'], ['available', available, 'available'],
    ].map(([tone, value, text]) => `<div class="stat stat-${tone}"><strong class="num">${value}</strong><span>${text}</span></div>`).join('');
  };

  const drawStations = () => {
    const byKey = new Map(data.agents.map((agent) => [agent.key, agent]));
    const stations = $('#stations');
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
    $('#officeNeeds').innerHTML = data.needsFahad
      ? `<a class="needs-banner" href="#/attention"><span class="needs-dot" aria-hidden="true"></span><span><strong>${data.needsFahad} ${data.needsFahad === 1 ? 'item needs' : 'items need'} you</strong><br><span class="small">Open Needs Fahad</span></span></a>` : '';
    $('#officeObjectives').innerHTML = data.workflows.length ? data.workflows.map((flow) => `<a class="objective" href="#/workflow/${esc(flow.id)}">
      <span class="objective-title" dir="auto">${esc(flow.title)}</span>
      <span class="progress" role="progressbar" aria-valuenow="${flow.progress}" aria-valuemin="0" aria-valuemax="100" aria-label="Progress"><span style="width:${Math.max(3, flow.progress)}%"></span></span>
      <span class="objective-meta">${esc(flow.status === 'completed' ? 'Completed' : flow.status === 'failed' ? 'Stopped' : 'In progress')} · <span class="num">${flow.progress}%</span> · ${esc(when(flow.createdAt))}</span></a>`).join('')
      : '<p class="muted small">No multi-employee objective this week. Ask CHIEF above.</p>';
    const agentSelect = $('#tlAgent');
    if (agentSelect.options.length === 1) agentSelect.insertAdjacentHTML('beforeend', `<option value="fahad">FAHAD</option>${data.agents.map((agent) => `<option value="${esc(agent.key)}">${esc(agent.label)}</option>`).join('')}`);
    const jobSelect = $('#tlJob');
    const known = new Set([...jobSelect.options].map((option) => option.value));
    for (const flow of data.workflows) if (!known.has(flow.id)) jobSelect.insertAdjacentHTML('beforeend', `<option value="${esc(flow.id)}">${esc(flow.title)}</option>`);
    drawTimeline(filters.agent || filters.status || filters.job ? null : data.timeline);
  };

  const drawTimeline = async (preset) => {
    const entries = preset || (await api(`/api/timeline${q({ workspaceId: ws(), ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) })}`)).entries;
    const list = $('#timeline');
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
    $(id).onchange = (event) => { filters[keyName] = event.target.value; drawTimeline(filters.agent || filters.status || filters.job ? null : data.timeline).catch(() => {}); };
  }

  // Handoffs of the last 24 h are drawn between desks; a handoff younger
  // than 10 minutes carries a light once. Each line opens its details.
  const drawHandoffs = () => {
    const svg = $('#handoffLayer');
    const stations = $('#stations');
    if (!svg || !stations || window.innerWidth < 900) { if (svg) svg.innerHTML = ''; return; }
    svg.setAttribute('viewBox', `0 0 ${stations.offsetWidth} ${stations.offsetHeight}`);
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

  // Gentle depth on the simplified floor (desktop, fine pointer, motion allowed).
  const scene = $('#scene');
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
  const resize = () => { if (renderer.render !== '3d') drawHandoffs(); else placeLabels(); };
  window.addEventListener('resize', resize);
  ctx.onLeave(() => window.removeEventListener('resize', resize));

  await load();
  const setLive = (liveNow) => {
    $('#liveDot')?.classList.toggle('off', !liveNow);
    const text = $('#liveText');
    if (text) text.textContent = liveNow ? t.live : t.reconnecting;
    const badge = $('#ovLive');
    if (badge) { badge.dataset.live = String(liveNow); badge.lastChild.textContent = liveNow ? t.liveShort : t.offlineShort; }
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
      : agent.executor === 'chief' ? '<a class="btn btn-primary" href="#/chief">Ask CHIEF</a>'
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

// ------------------------------------------------------------------ helpers
const readPref = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
const writePref = (key, value) => { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch { /* private mode */ } };

// What this device can do, measured without loading the 3D engine.
function capability(ctx) {
  let webgl = false;
  let weakGpu = false;
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2');
    webgl = Boolean(gl);
    if (gl) {
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
      weakGpu = /swiftshader|llvmpipe|software|basic render|mesa offscreen/i.test(renderer);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch { webgl = false; }
  const fine = window.matchMedia?.('(pointer: fine)').matches;
  return {
    webgl, weakGpu, small: window.innerWidth < 1024, coarse: !fine, reducedMotion: ctx.reducedMotion(),
    strong: (navigator.deviceMemory || 4) >= 8 && (navigator.hardwareConcurrency || 4) >= 8,
  };
}
