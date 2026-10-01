// V5 immersive DEMO preview shim (classic script, loaded before the Hub UI).
// Serves the Hub's API from a recorded snapshot of fictional demo data,
// refuses every write, fakes the live stream, and adds the small
// "V5 IMMERSIVE PREVIEW · DEMO DATA" review panel. Built into the preview by
// tools/v5-preview-build.mjs; never part of the production Hub.
(() => {
  const WRITE_REFUSED = 'Available in production after V5 approval.';
  const nativeFetch = window.fetch.bind(window);
  const data = nativeFetch(new URL('./demo/data.json', document.baseURI)).then((response) => response.json());
  let moment = 'work';
  const sources = new Set();

  const store = (() => { try { return window.localStorage; } catch { return null; } })();
  const pref = (key) => { try { return store?.getItem(key) || ''; } catch { return ''; } };
  const setPref = (key, value) => { try { if (value) store?.setItem(key, value); else store?.removeItem(key); } catch { /* private mode */ } };
  // First visit: land on the Office in immersive mode (Fahad can switch).
  if (!pref('hub-office-mode')) setPref('hub-office-mode', 'immersive');
  if (!location.hash || location.hash === '#/' || location.hash === '#') history.replaceState(null, '', '#/office');

  // Recorded times move with the clock (whole minutes), so "3 min ago" stays true to the scenario.
  const ISO = /"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d))"/g;
  const shifted = (text, capturedAt) => {
    const shift = Math.floor((Date.now() - capturedAt) / 60_000) * 60_000;
    return shift ? text.replace(ISO, (_, iso) => `"${new Date(Date.parse(iso) + shift).toISOString()}"`) : text;
  };
  const json = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const keyOf = (url) => { const copy = new URL(url); copy.searchParams.sort(); return `${copy.pathname.slice(copy.pathname.indexOf('/api/') >= 0 ? copy.pathname.indexOf('/api/') : copy.pathname.lastIndexOf('/'))}${copy.search}`; };

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, document.baseURI);
    const isApi = url.pathname.includes('/api/') || url.pathname.endsWith('/healthz');
    if (!isApi) return nativeFetch(input, init);
    const method = String(init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    if (method !== 'GET') return json({ ok: false, error: WRITE_REFUSED }, 403);
    const { capturedAt, moments } = await data;
    const responses = moments[moment];
    const key = keyOf(url);
    let body = responses[key];
    if (body === undefined) {
      // Same view, fewer filters (timeline filters, chat search…).
      const bare = new URL(url);
      for (const name of [...bare.searchParams.keys()]) if (name !== 'workspaceId') bare.searchParams.delete(name);
      body = responses[keyOf(bare)];
    }
    if (body === undefined && url.pathname.endsWith('/api/search')) body = { results: [] };
    if (body === undefined) return json({ ok: false, error: 'Not part of the demo preview.' }, 404);
    return json(shifted(JSON.stringify(body), capturedAt));
  };

  // The live stream: "ready" once, "change" when the demo moment changes.
  class DemoSource extends EventTarget {
    constructor() { super(); this.readyState = 1; sources.add(this); setTimeout(() => this.dispatchEvent(new MessageEvent('ready', { data: '{}' })), 50); }
    set onerror(fn) { this._onerror = fn; }
    get onerror() { return this._onerror; }
    close() { this.readyState = 2; sources.delete(this); }
  }
  window.EventSource = DemoSource;

  // Demo links (fictional repositories, the classic Hub) stay inside the preview.
  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[href]');
    if (!link) return;
    const href = link.getAttribute('href');
    if (/github\.com\/FahadTrail\/qahwa-run|^\.\/classic/.test(href)) { event.preventDefault(); note('Demo link — this fictional repository does not exist.'); }
  }, true);

  const MOMENTS = [['work', '1 · Team at work'], ['needs', '2 · CI passed — needs you']];
  let panel;
  const note = (text) => { const element = panel?.querySelector('.v5p-note'); if (element) { element.textContent = text; clearTimeout(note.timer); note.timer = setTimeout(() => { element.textContent = ''; }, 4000); } };
  const setMoment = (next) => {
    moment = next;
    panel.querySelectorAll('[data-moment]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.moment === moment)));
    sources.forEach((source) => source.dispatchEvent(new MessageEvent('change', { data: '{}' })));
  };
  const setTheme = (theme) => {
    setPref('hub-theme', theme);
    document.documentElement.dataset.theme = theme;
    panel.querySelectorAll('[data-theme-set]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.themeSet === theme)));
  };

  function mountPanel() {
    const style = document.createElement('style');
    style.textContent = `
.v5p { position: fixed; left: 14px; bottom: 14px; z-index: 40; width: 228px; font: 12px/1.4 var(--font, system-ui); color: var(--text); background: var(--surface-glass, var(--surface)); -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); border: 1px solid var(--border-strong, var(--border)); border-radius: 14px; box-shadow: var(--shadow-2); padding: 10px 12px; }
.v5p[data-collapsed="true"] .v5p-body { display: none; }
.v5p-head { display: flex; align-items: center; gap: 8px; }
.v5p-title { font-weight: 700; letter-spacing: .04em; font-size: 11px; }
.v5p-demo { font-weight: 700; font-size: 10px; letter-spacing: .06em; color: var(--warning); background: var(--warning-soft); border-radius: 999px; padding: 2px 8px; }
.v5p-toggle { margin-left: auto; background: none; border: 0; color: var(--text-muted); cursor: pointer; font: inherit; padding: 2px 4px; border-radius: 6px; }
.v5p-body { margin-top: 8px; display: grid; gap: 8px; }
.v5p-row { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.v5p-label { color: var(--text-muted); width: 100%; font-size: 11px; }
.v5p button.v5p-chip { font: inherit; font-size: 11px; color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; padding: 3px 9px; cursor: pointer; }
.v5p button.v5p-chip[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-strong, var(--accent)); font-weight: 600; }
.v5p-stat { font-variant-numeric: tabular-nums; }
.v5p-note { color: var(--text-muted); min-height: 1em; }
.v5p-foot { color: var(--text-faint); font-size: 11px; }
@media (max-width: 700px) { .v5p { left: 16px; right: 16px; width: auto; bottom: 12px; } }`;
    document.head.append(style);
    panel = document.createElement('aside');
    panel.className = 'v5p';
    panel.setAttribute('aria-label', 'V5 immersive preview');
    // Collapsed on phones, so the Office stays visible.
    panel.dataset.collapsed = String(matchMedia('(max-width: 700px)').matches);
    panel.innerHTML = `<div class="v5p-head"><span class="v5p-title">V5 IMMERSIVE PREVIEW</span><span class="v5p-demo">DEMO DATA</span>
      <button type="button" class="v5p-toggle" aria-expanded="true" aria-label="Collapse the preview panel">–</button></div>
      <div class="v5p-body">
        <div class="v5p-stat" id="v5pRender" aria-live="polite">Starting…</div>
        <div class="v5p-row"><span class="v5p-label">Demo moment</span>${MOMENTS.map(([key, label]) => `<button type="button" class="v5p-chip" data-moment="${key}" aria-pressed="${key === moment}">${label}</button>`).join('')}</div>
        <div class="v5p-row"><span class="v5p-label">Theme</span><button type="button" class="v5p-chip" data-theme-set="light">Light</button><button type="button" class="v5p-chip" data-theme-set="dark">Dark</button></div>
        <div class="v5p-note" role="status"></div>
        <div class="v5p-foot">Fictional project “Qahwa Run”. Nothing here is real, and sending is off — ${WRITE_REFUSED.toLowerCase()}</div>
      </div>`;
    document.body.append(panel);
    panel.querySelectorAll('[data-moment]').forEach((button) => { button.onclick = () => setMoment(button.dataset.moment); });
    panel.querySelectorAll('[data-theme-set]').forEach((button) => { button.onclick = () => setTheme(button.dataset.themeSet); });
    const current = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    panel.querySelectorAll('[data-theme-set]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.themeSet === current)));
    const toggle = panel.querySelector('.v5p-toggle');
    if (panel.dataset.collapsed === 'true') { toggle.textContent = '+'; toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-label', 'Expand the preview panel'); }
    toggle.onclick = () => {
      const collapsed = panel.dataset.collapsed !== 'true';
      panel.dataset.collapsed = String(collapsed);
      toggle.textContent = collapsed ? '+' : '–';
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.setAttribute('aria-label', collapsed ? 'Expand the preview panel' : 'Collapse the preview panel');
    };
    const render = panel.querySelector('#v5pRender');
    setInterval(() => {
      const office = window.__fahadOffice3d;
      const stats = office?.stats?.();
      const mode = office?.mode?.();
      let text;
      if (!location.hash.startsWith('#/office')) text = 'Open the Office to see the 3D view.';
      else if (stats) text = `Immersive · quality ${stats.quality}${stats.fps ? ` · ${stats.fps} fps` : ''}`;
      else if (mode?.render === 'light') text = /^Light Office/.test(mode.reason || '') ? mode.reason : `Light Office${mode.reason ? ` · ${mode.reason}` : ''}`;
      else if (document.querySelector('#immersive:not([hidden])')) text = 'Immersive · loading…';
      else text = pref('hub-office-mode') === 'light' ? 'Light Office (your choice)' : 'Light Office';
      if (render.textContent !== text) render.textContent = text;
    }, 1000);
  }

  // Composer placeholders say plainly that sending is off in the demo.
  const quiet = () => {
    const live = document.getElementById('liveText');
    if (live && live.textContent.startsWith('Live')) live.textContent = 'Demo data — fictional project, drawn by the real Office';
    fields();
  };
  const fields = () => document.querySelectorAll('textarea, #askChiefInput, input[placeholder^="Talk to"], input[placeholder^="Ask"], input[placeholder^="Message"], input[placeholder^="Reply"]').forEach((field) => {
    if (field.dataset.demo) return;
    field.dataset.demo = '1';
    field.placeholder = `Demo — ${WRITE_REFUSED}`;
  });
  const start = () => { mountPanel(); quiet(); new MutationObserver(quiet).observe(document.body, { childList: true, subtree: true }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
