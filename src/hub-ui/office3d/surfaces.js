// Screens and wall displays inside the immersive Office, drawn on 2D canvases
// and used as textures. Rule: a surface shows a REAL artifact, REAL Office
// state, or a quiet abstract pattern — never an invented number, headline or
// source. FINANCE figures appear only when code validated them.

const clip = (text, max) => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
const fmt = (value) => (Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—');
const arr = (value, max = 50) => (Array.isArray(value) ? value.slice(0, max) : []);

function rounded(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h);
}

function text(g, value, x, y, { size = 24, weight = 500, color, align = 'left', max = 60, font } = {}) {
  g.font = `${weight} ${size}px ${font || 'Inter, "IBM Plex Sans Arabic", system-ui, sans-serif'}`;
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = 'alphabetic';
  g.fillText(clip(value, max), x, y);
}

// Palette from the Office design tokens (read once by the scene).
export function surfacePalette(tokens, dark) {
  return {
    dark,
    bg: dark ? '#10131a' : '#f7f7f8', panel: dark ? '#171b24' : '#ffffff', line: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)',
    text: tokens.text || (dark ? '#f2f2f4' : '#1d1d1f'), muted: tokens.muted || (dark ? '#9a9aa2' : '#6e6e73'),
    accent: tokens.accent || '#5e98ff', success: tokens.success || '#34c759', warning: tokens.warning || '#ffb020', danger: tokens.danger || '#f36f68',
  };
}

// ---------------------------------------------------------------- abstract

function abstractPattern(g, w, h, p, label, seed = 1) {
  g.fillStyle = p.bg; g.fillRect(0, 0, w, h);
  const rand = (() => { let s = seed * 9301 + 49297; return () => ((s = (s * 9301 + 49297) % 233280) / 233280); })();
  g.globalAlpha = 0.9;
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const x = 28 + col * ((w - 56) / 3);
      const y = 70 + row * ((h - 100) / 3);
      rounded(g, x, y, (w - 56) / 3 - 16, (h - 100) / 3 - 16, 10);
      g.fillStyle = p.panel; g.fill();
      g.fillStyle = p.line;
      for (let line = 0; line < 3; line += 1) { rounded(g, x + 14, y + 16 + line * 14, ((w - 56) / 3 - 44) * (0.45 + rand() * 0.5), 6, 3); g.fill(); }
    }
  }
  g.globalAlpha = 1;
  text(g, label, 28, 44, { size: 22, weight: 600, color: p.muted, max: 40 });
}

function sleeping(g, w, h, p, label) {
  g.fillStyle = p.dark ? '#0b0d12' : '#e9e9ec'; g.fillRect(0, 0, w, h);
  text(g, label, w / 2, h / 2 + 8, { size: Math.round(h / 12), weight: 600, color: p.dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)', align: 'center', max: 30 });
}

// ---------------------------------------------------------------- artifacts

function header(g, w, p, kicker, title) {
  text(g, kicker, 28, 40, { size: 18, weight: 600, color: p.muted, max: 50 });
  text(g, title, 28, 76, { size: 28, weight: 650, color: p.text, max: Math.floor(w / 17) });
}

const DRAW = {
  moodboard(g, w, h, p, data) {
    const swatches = arr(data.palette, 6).filter((swatch) => /^#[0-9a-f]{6}$/i.test(swatch?.hex || ''));
    const size = (w - 56 - (swatches.length - 1) * 14) / Math.max(1, swatches.length);
    swatches.forEach((swatch, index) => {
      rounded(g, 28 + index * (size + 14), 100, size, h - 200, 14); g.fillStyle = swatch.hex; g.fill();
      text(g, swatch.name || swatch.hex, 28 + index * (size + 14), h - 70, { size: 18, weight: 600, color: p.text, max: 14 });
      text(g, swatch.hex, 28 + index * (size + 14), h - 44, { size: 16, color: p.muted, max: 10 });
    });
    const fonts = arr(data.typography, 2).map((font) => font.family).filter(Boolean).join(' · ');
    if (fonts) text(g, fonts, w - 28, 40, { size: 18, color: p.muted, align: 'right', max: 40 });
  },
  chart(g, w, h, p, data) {
    const series = arr(data.series, 2);
    const values = arr(series[0]?.values, 24).map(Number).filter(Number.isFinite);
    if (!values.length) return false;
    const top = Math.max(...values.map(Math.abs), 1);
    const bar = (w - 56) / values.length;
    values.forEach((value, index) => {
      const height = (Math.abs(value) / top) * (h - 190);
      rounded(g, 28 + index * bar + 4, h - 60 - height, Math.max(4, bar - 8), height, 5);
      g.fillStyle = value < 0 ? p.danger : p.accent; g.fill();
    });
    text(g, `${series[0]?.name || ''}${data.unit ? ` · ${data.unit}` : ''}`, 28, h - 24, { size: 16, color: p.muted, max: 50 });
  },
  kanban(g, w, h, p, data) {
    const columns = arr(data.columns, 4);
    const width = (w - 56 - (columns.length - 1) * 14) / Math.max(1, columns.length);
    columns.forEach((column, index) => {
      const x = 28 + index * (width + 14);
      text(g, `${column.name} · ${arr(column.cards).length}`, x, 118, { size: 18, weight: 600, color: p.muted, max: 22 });
      arr(column.cards, 4).forEach((card, row) => {
        rounded(g, x, 134 + row * 64, width, 54, 10); g.fillStyle = p.panel; g.fill();
        text(g, card.title, x + 14, 166 + row * 64, { size: 17, weight: 550, color: p.text, max: Math.floor(width / 9) });
      });
    });
  },
  timeline(g, w, h, p, data) {
    arr(data.items, 5).forEach((item, index) => {
      const y = 120 + index * 58;
      rounded(g, 28 + index * 60, y, w - 56 - index * 90, 40, 20); g.fillStyle = index % 2 ? p.panel : p.accent; g.globalAlpha = index % 2 ? 1 : 0.85; g.fill(); g.globalAlpha = 1;
      text(g, item.label, 44 + index * 60, y + 27, { size: 18, weight: 600, color: index % 2 ? p.text : '#ffffff', max: 48 });
    });
  },
  flow(g, w, h, p, data) {
    const steps = arr(data.steps, 5);
    const width = (w - 56 - (steps.length - 1) * 30) / Math.max(1, steps.length);
    steps.forEach((step, index) => {
      const x = 28 + index * (width + 30);
      rounded(g, x, h / 2 - 50, width, 100, 14); g.fillStyle = p.panel; g.fill();
      text(g, step.label, x + 12, h / 2 + 6, { size: 17, weight: 600, color: p.text, max: Math.floor(width / 9) });
      if (index < steps.length - 1) { g.fillStyle = p.muted; g.fillRect(x + width + 6, h / 2 - 1, 18, 3); }
    });
  },
  financial_model(g, w, h, p, data) {
    const calc = data.calculated;
    if (data.validation?.state !== 'VERIFIED' || !calc) {
      text(g, 'Awaiting validated figures', 28, h / 2, { size: 26, weight: 600, color: p.muted });
      text(g, 'FINANCE figures appear here once code has verified them.', 28, h / 2 + 36, { size: 18, color: p.muted, max: 70 });
      return;
    }
    const tiles = [
      [`Revenue · ${calc.months} mo`, calc.year_revenue], [`Costs · ${calc.months} mo`, calc.year_costs], ['Net', calc.net],
      ['Cash break-even', calc.break_even_month ? `Month ${calc.break_even_month}` : 'Not reached'],
    ].filter(([, value]) => value !== undefined && value !== null);
    const width = (w - 56 - (tiles.length - 1) * 14) / tiles.length;
    tiles.forEach(([label, value], index) => {
      const x = 28 + index * (width + 14);
      rounded(g, x, 110, width, 130, 14); g.fillStyle = p.panel; g.fill();
      text(g, label, x + 16, 146, { size: 17, color: p.muted, max: 20 });
      text(g, typeof value === 'number' ? `${calc.currency || ''} ${fmt(value)}` : value, x + 16, 200, { size: 28, weight: 650, color: p.text, max: 16 });
    });
    text(g, 'VERIFIED · calculated by code', 28, h - 30, { size: 17, weight: 600, color: p.success });
  },
  audit_report(g, w, h, p, data) {
    const verdict = String(data.verdict || 'PASS');
    const tone = verdict === 'PASS' ? p.success : verdict === 'BLOCKED' ? p.danger : p.warning;
    rounded(g, 28, 110, 250, 70, 35); g.fillStyle = tone; g.fill();
    text(g, verdict, 153, 157, { size: 28, weight: 700, color: '#ffffff', align: 'center' });
    const findings = arr(data.findings, 60);
    ['blocked', 'critical', 'high', 'medium', 'low'].forEach((severity, index) => {
      const count = findings.filter((finding) => finding.severity === severity).length;
      text(g, `${count}`, 320 + index * 120, 150, { size: 32, weight: 650, color: count ? p.text : p.muted });
      text(g, severity, 320 + index * 120, 176, { size: 15, color: p.muted });
    });
    findings.slice(0, 3).forEach((finding, index) => text(g, `• ${finding.title}`, 28, 230 + index * 32, { size: 18, color: p.text, max: 70 }));
  },
  content_calendar(g, w, h, p, data) {
    const entries = arr(data.entries, 8);
    const cols = 4;
    const width = (w - 56 - (cols - 1) * 12) / cols;
    entries.forEach((entry, index) => {
      const x = 28 + (index % cols) * (width + 12);
      const y = 100 + Math.floor(index / cols) * 120;
      rounded(g, x, y, width, 108, 12); g.fillStyle = p.panel; g.fill();
      text(g, `${entry.date || ''}`, x + 12, y + 28, { size: 15, weight: 600, color: p.muted, max: 18 });
      text(g, entry.platform || '', x + 12, y + 52, { size: 16, weight: 650, color: p.accent, max: 16 });
      text(g, entry.hook || entry.caption || '', x + 12, y + 80, { size: 15, color: p.text, max: Math.floor(width / 8) });
    });
  },
  compliance_matrix(g, w, h, p, data) {
    const items = arr(data.items, 60);
    const flags = items.filter((item) => item.classification === 'RISK FLAG').length;
    const review = items.filter((item) => item.classification === 'PROFESSIONAL REVIEW REQUIRED').length;
    [['requirements', items.length, p.text], ['risk flags', flags, flags ? p.danger : p.muted], ['need a lawyer', review, review ? p.warning : p.muted]].forEach(([label, value, color], index) => {
      text(g, `${value}`, 28 + index * 200, 150, { size: 40, weight: 650, color });
      text(g, label, 28 + index * 200, 178, { size: 16, color: p.muted });
    });
    items.slice(0, 3).forEach((item, index) => text(g, `• ${item.requirement}`, 28, 230 + index * 30, { size: 17, color: p.text, max: 72 }));
  },
  evidence(g, w, h, p, data) {
    arr(data.claims, 5).forEach((claim, index) => {
      const tone = claim.status === 'VERIFIED' ? p.success : claim.status === 'LIKELY' ? p.warning : p.muted;
      rounded(g, 28, 104 + index * 46, 110, 30, 15); g.fillStyle = tone; g.fill();
      text(g, claim.status, 83, 125 + index * 46, { size: 14, weight: 700, color: '#ffffff', align: 'center' });
      text(g, claim.claim, 152, 126 + index * 46, { size: 17, color: p.text, max: 64 });
    });
  },
  table(g, w, h, p, data) {
    const columns = arr(data.columns, 4);
    const width = (w - 56) / Math.max(1, columns.length);
    columns.forEach((column, index) => text(g, column, 28 + index * width, 120, { size: 16, weight: 650, color: p.muted, max: Math.floor(width / 9) }));
    arr(data.rows, 5).forEach((row, rowIndex) => arr(row, 4).forEach((cell, index) => text(g, cell, 28 + index * width, 156 + rowIndex * 34, { size: 17, color: p.text, max: Math.floor(width / 9) })));
  },
  checklist(g, w, h, p, data) {
    arr(data.items, 6).forEach((item, index) => {
      const done = ['done', 'pass'].includes(item.status);
      rounded(g, 28, 104 + index * 38, 22, 22, 6); g.fillStyle = done ? p.success : item.status === 'fail' || item.status === 'blocked' ? p.danger : p.line; g.fill();
      text(g, item.text, 64, 122 + index * 38, { size: 17, color: p.text, max: 70 });
    });
  },
  risk_matrix(g, w, h, p, data) {
    const size = Math.min((h - 140) / 5, 44);
    for (let impact = 5; impact >= 1; impact -= 1) {
      for (let likelihood = 1; likelihood <= 5; likelihood += 1) {
        const score = impact * likelihood;
        rounded(g, 28 + (likelihood - 1) * (size + 4), 100 + (5 - impact) * (size + 4), size, size, 6);
        g.fillStyle = score >= 15 ? p.danger : score >= 8 ? p.warning : p.panel; g.globalAlpha = 0.5; g.fill(); g.globalAlpha = 1;
      }
    }
    arr(data.items, 30).forEach((item) => {
      g.beginPath(); g.arc(28 + (item.likelihood - 1) * (size + 4) + size / 2, 100 + (5 - item.impact) * (size + 4) + size / 2, 7, 0, Math.PI * 2); g.fillStyle = p.text; g.fill();
    });
  },
};

const KIND_LABEL = {
  'project-wall': 'Office', 'intelligence-wall': 'Research', 'document-wall': 'Legal', 'review-board': 'Audit', 'roadmap-board': 'Product',
  'finance-screen': 'Finance', 'moodboard-wall': 'Creative', 'content-wall': 'Social', 'engineering-panel': 'Engineering',
};

// A wall display for an employee workspace.
export function drawBoard(canvas, { kind, employee, visual, palette: p, seed = 1 }) {
  const g = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  g.clearRect(0, 0, w, h);
  const artifact = employee?.artifact;
  const draw = artifact && DRAW[artifact.type];
  if (draw) {
    g.fillStyle = p.bg; g.fillRect(0, 0, w, h);
    header(g, w, p, `${employee.label} · ${String(artifact.type).replace(/_/g, ' ')}`, artifact.title || '');
    const drawn = draw(g, w, h, p, { ...(artifact.data || {}) });
    if (drawn !== false) {
      if (visual?.board === 'idle' && employee.state === 'AVAILABLE') { g.fillStyle = p.dark ? 'rgba(0,0,0,0.28)' : 'rgba(255,255,255,0.25)'; g.fillRect(0, 0, w, h); }
      return 'artifact';
    }
  }
  if (!employee || employee.state === 'AVAILABLE') { sleeping(g, w, h, p, KIND_LABEL[kind] || ''); return 'idle'; }
  abstractPattern(g, w, h, p, KIND_LABEL[kind] || '', seed);
  return 'abstract';
}

// CHIEF's project wall: real objectives, real progress, real team and the
// Office status — the one place the whole Office is summarised.
export function drawProjectWall(canvas, { state, palette: p, selected = null }) {
  const g = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  g.fillStyle = p.bg; g.fillRect(0, 0, w, h);
  text(g, 'FAHAD AI OFFICE', 32, 50, { size: 22, weight: 700, color: p.muted });
  const s = state.summary;
  [['working', s.working, p.accent], ['waiting', s.waiting, p.warning], ['need you', s.needsFahad, s.needsFahad ? p.warning : p.muted], ['delivered', s.completed, p.success]]
    .forEach(([label, value, color], index) => {
      text(g, `${value}`, w - 520 + index * 128, 56, { size: 34, weight: 650, color });
      text(g, label, w - 520 + index * 128, 80, { size: 15, color: p.muted });
    });
  const projects = state.projects.filter((project) => project.active).concat(state.projects.filter((project) => !project.active)).slice(0, 4);
  if (!projects.length) {
    text(g, 'No objective in progress', 32, h / 2 + 10, { size: 30, weight: 600, color: p.muted });
    text(g, 'Ask CHIEF to start one.', 32, h / 2 + 50, { size: 20, color: p.muted });
    return;
  }
  projects.forEach((project, index) => {
    const y = 120 + index * ((h - 150) / Math.max(4, projects.length));
    const on = !selected || selected === project.id;
    g.globalAlpha = on ? 1 : 0.35;
    text(g, project.title, 32, y + 28, { size: 26, weight: 600, color: p.text, max: 46 });
    rounded(g, 32, y + 44, w * 0.5, 10, 5); g.fillStyle = p.line; g.fill();
    rounded(g, 32, y + 44, Math.max(10, (w * 0.5 * project.progress) / 100), 10, 5); g.fillStyle = project.active ? p.accent : p.success; g.fill();
    text(g, `${project.progress}%`, 32 + w * 0.5 + 16, y + 55, { size: 18, weight: 600, color: p.muted });
    text(g, project.team.map((key) => key.toUpperCase()).join(' · '), w * 0.62, y + 28, { size: 16, weight: 600, color: p.muted, max: 60 });
    g.globalAlpha = 1;
  });
}

// CODING's engineering panel: the real lifecycle stage, PR and CI — no fake code.
export function drawEngineeringPanel(canvas, { employee, panel, palette: p, stages }) {
  const g = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  g.fillStyle = p.bg; g.fillRect(0, 0, w, h);
  text(g, 'ENGINEERING', 32, 48, { size: 20, weight: 700, color: p.muted });
  const session = employee?.coding;
  text(g, session?.title || 'No engineering task running', 32, 90, { size: 26, weight: 600, color: session ? p.text : p.muted, max: 52 });
  const width = (w - 64 - (stages.length - 1) * 10) / stages.length;
  const current = stages.indexOf(panel?.stage);
  stages.forEach((stage, index) => {
    const x = 32 + index * (width + 10);
    const state = current < 0 ? 'off' : index < current ? 'done' : index === current ? 'now' : 'next';
    rounded(g, x, 130, width, 64, 12);
    g.fillStyle = state === 'now' ? p.accent : state === 'done' ? (p.dark ? 'rgba(52,199,89,0.28)' : 'rgba(52,199,89,0.18)') : p.panel; g.fill();
    text(g, stage, x + width / 2, 170, { size: 15, weight: 650, color: state === 'now' ? '#ffffff' : state === 'done' ? p.success : p.muted, align: 'center', max: 12 });
  });
  const facts = [
    panel?.pr ? `PR #${panel.pr.number}` : null,
    panel?.ci ? `CI ${String(panel.ci).toUpperCase()}` : null,
    panel?.deploy ? `Deploy ${String(panel.deploy).toUpperCase()}` : null,
  ].filter(Boolean);
  text(g, facts.length ? facts.join('   ·   ') : session ? String(session.status || '').replace(/_/g, ' ').toUpperCase() : '', 32, h - 36, { size: 20, weight: 600, color: p.text, max: 70 });
  if (panel?.awaiting) {
    rounded(g, w - 340, h - 66, 308, 44, 22); g.fillStyle = p.warning; g.fill();
    text(g, 'Waiting for your approval', w - 186, h - 37, { size: 18, weight: 700, color: '#1d1d1f', align: 'center' });
  }
}

// A desk monitor: brightness follows the real state; content is abstract.
export function drawMonitor(canvas, { visual, palette: p, label }) {
  const g = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  if (visual.screen === 'idle' || visual.screen === 'dim') { sleeping(g, w, h, p, visual.screen === 'dim' ? label : ''); return; }
  g.fillStyle = p.bg; g.fillRect(0, 0, w, h);
  const tone = visual.screen === 'error' ? p.danger : p.accent;
  rounded(g, 16, 16, w - 32, 22, 6); g.fillStyle = p.panel; g.fill();
  for (let line = 0; line < 6; line += 1) { rounded(g, 16, 54 + line * 26, (w - 32) * (0.35 + ((line * 37) % 55) / 100), 12, 6); g.fillStyle = line === 1 ? tone : p.line; g.fill(); }
}
