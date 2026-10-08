// The screen system (Final Design Spec §12): five levels, each with a
// legibility rule. Ivory by day, ink at night; Archivo, flush left. No pole
// TVs, no matrix rain, no fake code — every glyph comes from real Office data.
//
//   L1 Desk         27" monitors. Real output. Live text only within 4 m (else an LOD block).
//   L2 Department   75" on linen. Up to 4 tasks. Minimum glyph 64 px at 1080p.
//   L3 CHIEF        2 monitors + the table surface: the routing map.
//   L4 Office Wall  7.2 × 2.4 m. Pipeline · Today · Stream. Numerals ≥ 0.18 m.
//   L5 Alerts       UI toasts only — never drawn on an in-world screen.
//
// Pure drawing on a 2D canvas context: tested in Node with a recording stand-in.
import { ZONES, ZONE_KEYS } from './plan.js?v=__UI_VERSION__';

export const LIVE_TEXT_METRES = 4;
export const RESOLUTION = Object.freeze({
  desk: { high: [768, 435], balanced: [512, 290], light: [384, 218] },
  department: { high: [1536, 864], balanced: [1152, 648], light: [768, 432] },
  wall: { high: [2560, 853], balanced: [2048, 683], light: [1280, 427] },
  table: { high: [1024, 427], balanced: [768, 320], light: [512, 213] },
});
// The smallest glyph on a department display: 64 px at 1080p.
export const MIN_GLYPH_SHARE = 64 / 1080;

export function screenPalette(phase) {
  return phase === 'night'
    ? { phase, bg: '#121418', panel: '#1b1e24', rule: 'rgba(236,230,218,0.14)', text: '#ece6da', muted: '#8f897d', block: 'rgba(236,230,218,0.18)', working: '#6f9cf0', done: '#5fb487', attention: '#ef5f57', caution: '#d9a23a' }
    : { phase, bg: '#f3eee4', panel: '#ebe4d7', rule: 'rgba(29,27,24,0.14)', text: '#1d1b18', muted: '#6d665c', block: 'rgba(29,27,24,0.16)', working: '#2f6fde', done: '#2f8f5b', attention: '#d6453d', caution: '#b9821b' };
}

const FONT = 'Archivo, Inter, "IBM Plex Sans Arabic", system-ui, sans-serif';
const clip = (value, max) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
const arabic = (value) => /[؀-ۿ]/.test(String(value || ''));

function write(g, value, x, y, { size, weight = 500, color, max = 80, align = 'left' }) {
  const text = clip(value, max);
  if (!text) return;
  g.font = `${weight} ${Math.round(size)}px ${FONT}`;
  g.fillStyle = color;
  g.textBaseline = 'alphabetic';
  // Flush left; a line written in Arabic sets from the right instead.
  g.direction = arabic(text) ? 'rtl' : 'ltr';
  g.textAlign = arabic(text) && align === 'left' ? 'right' : align;
  g.fillText(text, arabic(text) && align === 'left' ? g.canvas.width - x : x, y);
  g.direction = 'ltr';
}
function rule(g, x, y, width, p) { g.fillStyle = p.rule; g.fillRect(x, y, width, Math.max(1, g.canvas.height / 400)); }
function dot(g, x, y, radius, color) { g.beginPath(); g.arc(x, y, radius, 0, Math.PI * 2); g.fillStyle = color; g.fill(); }
function background(g, w, h, p) { g.fillStyle = p.bg; g.fillRect(0, 0, w, h); }
// Lines of real text shown as an LOD block: bars of the text's own length.
function block(g, x, y, lengths, size, p) {
  g.fillStyle = p.block;
  lengths.forEach((length, index) => { g.fillRect(x, y + index * size * 1.7, Math.max(size, Math.min(g.canvas.width - 2 * x, length * size * 0.52)), size * 0.7); });
}

// ------------------------------------------------------------------ L1 desk
// monitor: screensaver | live | waiting | frozen | approval | error | delivered | off
export function drawDeskMonitor(canvas, { employee = {}, signal = {}, palette, near = false, index = 0, artifactTitle = null }) {
  const g = canvas.getContext('2d'); const { width: w, height: h } = canvas;
  const p = palette; const pad = w * 0.06; const s = h / 20;
  if (signal.monitor === 'off') { g.fillStyle = '#060606'; g.fillRect(0, 0, w, h); return 'off'; }
  if (signal.monitor === 'screensaver') {
    // Calm: a soft field of the day or night tone and the Office mark.
    const gradient = g.createLinearGradient(0, 0, w, h);
    gradient.addColorStop(0, p.phase === 'night' ? '#151821' : '#ece6da'); gradient.addColorStop(1, p.phase === 'night' ? '#0d0f14' : '#e2dacb');
    g.fillStyle = gradient; g.fillRect(0, 0, w, h);
    write(g, 'F', w / 2, h / 2 + s, { size: s * 3, weight: 600, color: p.block, align: 'center' });
    return 'screensaver';
  }
  background(g, w, h, p);
  const name = `${ZONES[employee.key]?.number || ''} ${employee.label || ''}`.trim();
  const lines = [];
  if (signal.monitor === 'error') {
    g.fillStyle = p.attention; g.fillRect(pad, pad, s * 2.6, s * 2.6);
    lines.push([employee.detail || 'Could not finish the task', p.text, 600]);
  } else if (signal.monitor === 'approval') {
    g.strokeStyle = p.attention; g.lineWidth = s * 0.35; g.beginPath(); g.arc(pad + s * 1.3, pad + s * 1.3, s * 1.1, 0, Math.PI * 2); g.stroke();
    lines.push([employee.detail || 'Waiting for your approval', p.text, 600]);
  } else if (signal.monitor === 'delivered') {
    lines.push(['Delivered', p.done, 650]);
  } else if (signal.monitor === 'waiting') {
    lines.push([employee.detail || 'Waiting', p.muted, 500]);
  }
  const task = employee.task || null;
  if (task) lines.push([task, p.text, 600]);
  if (employee.objective && employee.objective !== task) lines.push([employee.objective, p.muted, 500]);
  if (signal.monitor === 'live' && employee.detail && employee.detail !== `Working on ${task}`) lines.push([employee.detail, p.muted, 500]);
  if (signal.monitor === 'delivered' && (artifactTitle || employee.deliverable)) lines.push([artifactTitle || employee.deliverable, p.muted, 500]);
  const top = signal.monitor === 'error' || signal.monitor === 'approval' ? pad + s * 4.2 : pad + s * 1.2;
  if (!near) {
    // Beyond 4 m: the same lines as an LOD block, never legible fake text.
    block(g, pad, top, lines.map(([text]) => String(text).length), s * 1.2, p);
    if (signal.monitor === 'frozen') { g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillRect(0, 0, w, h); }
    return 'block';
  }
  write(g, name, pad, pad + s * (signal.monitor === 'error' || signal.monitor === 'approval' ? 1.7 : 0.4) + (signal.monitor === 'error' || signal.monitor === 'approval' ? 0 : s), { size: s * 0.9, weight: 600, color: p.muted, max: 40 });
  lines.forEach(([text, color, weight], line) => write(g, text, pad, top + s * 1.8 + line * s * 2.1, { size: s * 1.25, weight, color, max: Math.floor(w / (s * 0.62)) }));
  if (employee.progress != null && signal.monitor === 'live') {
    const y = h - pad - s * 0.6;
    g.fillStyle = p.rule; g.fillRect(pad, y, w - pad * 2, s * 0.4);
    g.fillStyle = p.working; g.fillRect(pad, y, (w - pad * 2) * Math.max(0.02, Math.min(1, employee.progress / 100)), s * 0.4);
  }
  if (signal.monitor === 'live' && index % 2 === 0) { g.fillStyle = p.working; g.fillRect(pad, top + s * 1.8 + lines.length * s * 2.1 - s * 0.9, s * 0.55, s * 1.1); } // the cursor
  if (signal.monitor === 'frozen') { g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillRect(0, 0, w, h); write(g, 'Paused', pad, h - pad, { size: s * 1.1, weight: 600, color: p.attention }); }
  return 'text';
}

// ------------------------------------------------------------------ L2 department
// Up to four real lines: the current task, its objective, the queue, the
// latest delivery; Coding adds its real pipeline; Finance shows figures only
// when code VERIFIED them.
export const CODING_STAGES = Object.freeze(['PLANNING', 'EDITING', 'TESTING', 'DEBUGGING', 'CI', 'DEPLOYING', 'VERIFYING']);
const CODING_PHASES = Object.freeze({ understand: 'PLANNING', plan: 'PLANNING', implement: 'EDITING', test: 'TESTING', debug: 'DEBUGGING', review: 'TESTING', publish: 'CI', ci: 'CI', deploy: 'DEPLOYING', verify: 'VERIFYING', report: 'VERIFYING' });
export function codingStage(coding) {
  if (!coding || !['running', 'queued', 'blocked', 'awaiting_approval'].includes(coding.status)) return null;
  return CODING_PHASES[coding.phase] || 'PLANNING';
}

export function departmentLines(employee = {}) {
  const lines = [];
  if (employee.task) lines.push({ text: employee.task, tone: employee.active ? 'working' : employee.state === 'COMPLETED' ? 'done' : ['BLOCKED', 'FAILED', 'NEEDS FAHAD'].includes(employee.state) ? 'attention' : 'muted' });
  if (employee.objective && employee.objective !== employee.task) lines.push({ text: employee.objective, tone: 'muted' });
  if (Number(employee.queue) > 0) lines.push({ text: `Queue ${employee.queue}`, tone: Number(employee.queue) >= 3 ? 'caution' : 'muted' });
  if (employee.artifact?.title) lines.push({ text: employee.artifact.title, tone: 'muted' });
  return lines.slice(0, 4);
}

export function drawDepartment(canvas, { employee = {}, signal = {}, palette, stateWord = (value) => value }) {
  const g = canvas.getContext('2d'); const { width: w, height: h } = canvas; const p = palette;
  background(g, w, h, p);
  const min = h * MIN_GLYPH_SHARE; const pad = w * 0.05;
  const zone = ZONES[employee.key] || {};
  write(g, `${zone.number || ''}  ${zone.name || employee.label || ''}`, pad, pad + min * 1.1, { size: min * 1.25, weight: 600, color: p.text, max: 30 });
  const toneColor = { working: p.working, done: p.done, attention: p.attention, caution: p.caution, neutral: p.muted, offline: p.muted }[signal.tone] || p.muted;
  dot(g, w - pad - min * 0.4, pad + min * 0.65, min * 0.32, toneColor);
  write(g, stateWord(employee.visual || employee.state || 'AVAILABLE'), w - pad - min * 1.1, pad + min * 1.1, { size: min, weight: 500, color: signal.tone === 'neutral' ? p.muted : toneColor, align: 'right', max: 24 });
  rule(g, pad, pad + min * 1.8, w - pad * 2, p);
  let y = pad + min * 3.4;
  if (employee.key === 'coding' && employee.coding) {
    const stage = codingStage(employee.coding);
    const width = (w - pad * 2) / CODING_STAGES.length;
    CODING_STAGES.forEach((name, index) => {
      const lit = stage && CODING_STAGES.indexOf(stage) >= index;
      g.fillStyle = lit ? (CODING_STAGES.indexOf(stage) === index ? p.working : p.done) : p.rule;
      g.fillRect(pad + index * width + 4, y - min * 0.9, width - 8, min * 0.24);
    });
    write(g, stage ? stage.charAt(0) + stage.slice(1).toLowerCase() : 'No session running', pad, y + min * 0.4, { size: min, weight: 600, color: stage ? p.text : p.muted, max: 30 });
    const pr = employee.coding.pr?.number ? `PR #${employee.coding.pr.number}` : null; const ci = employee.coding.ci ? `CI ${employee.coding.ci}` : null;
    if (pr || ci) write(g, [pr, ci].filter(Boolean).join(' · '), w - pad, y + min * 0.4, { size: min, weight: 500, color: p.muted, align: 'right', max: 30 });
    y += min * 2.2;
  }
  if (employee.key === 'finance' && employee.artifact?.type === 'financial_model') {
    const data = employee.artifact.data || {}; const calc = data.calculated;
    if (data.validation?.state === 'VERIFIED' && calc) {
      const figure = (value) => (Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—');
      write(g, `Net ${figure(calc.net)} ${calc.currency || ''}`.trim(), pad, y, { size: min * 1.2, weight: 600, color: p.text });
      write(g, 'Verified · calculated by code', pad, y + min * 1.5, { size: min, weight: 500, color: p.done });
    } else write(g, 'Awaiting validated figures', pad, y, { size: min, weight: 500, color: p.muted });
    y += min * 3;
  }
  const lines = departmentLines(employee);
  if (!lines.length) write(g, employee.state === 'AVAILABLE' || !employee.state ? 'Available' : stateWord(employee.visual || employee.state), pad, y, { size: min, weight: 500, color: p.muted });
  for (const line of lines) {
    if (y > h - pad) break;
    write(g, line.text, pad, y, { size: min, weight: line.tone === 'muted' ? 500 : 600, color: { working: p.text, done: p.done, attention: p.attention, caution: p.caution, muted: p.muted }[line.tone], max: Math.floor((w - pad * 2) / (min * 0.55)) });
    y += min * 1.55;
  }
  return lines.length;
}

// ------------------------------------------------------------------ L3 CHIEF
// The routing map: the eight departments around CHIEF, lit when working, red
// only for attention; fresh handoffs as arcs.
export function drawRoutingMap(canvas, { state = {}, palette }) {
  const g = canvas.getContext('2d'); const { width: w, height: h } = canvas; const p = palette;
  background(g, w, h, p);
  const cx = w / 2; const cy = h / 2; const radius = Math.min(w * 0.42, h * 0.38);
  const at = (key) => { if (key === 'chief') return [cx, cy]; const [x, z] = ZONES[key].centre; const angle = Math.atan2(x, -z); return [cx + Math.sin(angle) * radius * 1.4, cy - Math.cos(angle) * radius]; };
  g.strokeStyle = p.rule; g.lineWidth = Math.max(1, h / 300); g.beginPath(); g.ellipse(cx, cy, radius * 1.4, radius, 0, 0, Math.PI * 2); g.stroke();
  for (const handoff of (state.handoffs || []).filter((entry) => entry.fresh)) {
    const [a, b] = [at(handoff.fromKey), at(handoff.toKey)];
    if (!a || !b) continue;
    g.strokeStyle = p.working; g.lineWidth = Math.max(2, h / 120); g.beginPath(); g.moveTo(...a); g.quadraticCurveTo(cx, cy, ...b); g.stroke();
  }
  for (const key of ZONE_KEYS) {
    const employee = (state.employees || []).find((entry) => entry.key === key);
    const [x, y] = at(key);
    const tone = !employee ? p.rule : ['BLOCKED', 'FAILED', 'NEEDS FAHAD'].includes(employee.state) ? p.attention : employee.active ? p.working : employee.state === 'COMPLETED' ? p.done : p.muted;
    dot(g, x, y, h / 26, tone);
    write(g, ZONES[key].number, x + h / 18, y + h / 60, { size: h / 14, weight: 600, color: p.text });
  }
  return true;
}

export function drawChiefMonitor(canvas, { state = {}, palette, index = 0, near = false }) {
  if (index === 1) {
    const g = canvas.getContext('2d'); const { width: w, height: h } = canvas; const p = palette; const s = h / 18; const pad = w * 0.06;
    background(g, w, h, p);
    const projects = (state.projects || []).filter((project) => project.active).slice(0, 4);
    if (!near) { block(g, pad, pad + s, projects.map((project) => String(project.title).length), s * 1.2, p); return 'block'; }
    write(g, 'Objectives', pad, pad + s, { size: s * 0.95, weight: 600, color: p.muted });
    if (!projects.length) write(g, 'All clear', pad, pad + s * 3.4, { size: s * 1.3, weight: 600, color: p.text });
    projects.forEach((project, line) => write(g, `${project.title} · ${project.progress}%`, pad, pad + s * 3.4 + line * s * 2.2, { size: s * 1.2, weight: 600, color: p.text, max: 40 }));
    return 'text';
  }
  return drawRoutingMap(canvas, { state, palette });
}

// ------------------------------------------------------------------ L4 Office Wall
// Pipeline · Today · Stream. "All clear" when nothing runs.
export function drawOfficeWall(canvas, { state = {}, stats = [], stream = [], palette, labels = {} }) {
  const g = canvas.getContext('2d'); const { width: w, height: h } = canvas; const p = palette;
  background(g, w, h, p);
  const pad = w * 0.025; const unit = h / 24; // numerals ≥ 0.18 m on a 2.4 m wall → ≥ 1.8 units
  const columns = [pad, w * 0.36, w * 0.68];
  const heading = (text, x) => { write(g, text, x, pad + unit * 1.6, { size: unit * 1.3, weight: 600, color: p.muted }); rule(g, x, pad + unit * 2.4, w * 0.3 - pad, p); };
  heading(labels.pipeline || 'Pipeline', columns[0]); heading(labels.today || 'Today', columns[1]); heading(labels.stream || 'Stream', columns[2]);
  // Pipeline: real active objectives with progress.
  const projects = (state.projects || []).filter((project) => project.active).slice(0, 4);
  if (!projects.length) write(g, labels.allClear || 'All clear', columns[0], pad + unit * 7, { size: unit * 2.4, weight: 600, color: p.text });
  projects.forEach((project, index) => {
    const y = pad + unit * (5 + index * 4.4);
    write(g, project.title, columns[0], y, { size: unit * 1.45, weight: 600, color: p.text, max: 34 });
    g.fillStyle = p.rule; g.fillRect(columns[0], y + unit * 0.9, w * 0.3 - pad, unit * 0.32);
    g.fillStyle = p.working; g.fillRect(columns[0], y + unit * 0.9, (w * 0.3 - pad) * Math.max(0.02, Math.min(1, project.progress / 100)), unit * 0.32);
    write(g, `${project.progress}%`, columns[0], y + unit * 2.5, { size: unit * 1.1, weight: 500, color: p.muted });
  });
  // Today: the ruled stat bar's numbers (red only above zero for attention).
  const names = { working: labels.working || 'Working', needs: labels.needs || 'Needs you', blocked: labels.blocked || 'Blocked', delivered: labels.delivered || 'Delivered today' };
  stats.forEach((entry, index) => {
    const x = columns[1] + (index % 2) * w * 0.15; const y = pad + unit * (9 + Math.floor(index / 2) * 8);
    write(g, String(entry.value).padStart(2, '0'), x, y, { size: unit * 4.8, weight: 600, color: entry.tone === 'attention' ? p.attention : p.text });
    write(g, names[entry.id], x, y + unit * 2, { size: unit * 1.15, weight: 500, color: p.muted });
  });
  // Stream: the latest real timeline entries.
  stream.slice(0, 6).forEach((entry, index) => {
    const y = pad + unit * (5 + index * 3.1);
    write(g, entry.text, columns[2], y, { size: unit * 1.2, weight: 500, color: p.text, max: 46 });
    if (entry.time) write(g, entry.time, columns[2], y + unit * 1.35, { size: unit * 0.95, weight: 500, color: p.muted });
  });
  return { projects: projects.length, stream: Math.min(6, stream.length) };
}
