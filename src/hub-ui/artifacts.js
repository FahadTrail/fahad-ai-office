// Visual output engine: employees emit structured data (```artifact blocks,
// validated server-side in src/office/artifacts.js); this module draws it.
// Every value is escaped and every colour re-validated here too, so a block
// that reaches the browser unvalidated (e.g. inside a chat message) is safe.
import { escapeHtml as esc } from './markdown.js';

const HEX = /^#[0-9a-f]{6}$/i;
const n = (value) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : null);
const arr = (value, max = 80) => (Array.isArray(value) ? value.slice(0, max) : []);
const fmt = (value, unit = '') => (value === null ? '—' : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ''}`);
const SERIES = ['var(--accent)', 'var(--success)', 'var(--warning)', 'var(--info)', 'var(--danger)', 'var(--text-muted)'];

export const ARTIFACT_LABELS = Object.freeze({
  table: 'Table', chart: 'Chart', timeline: 'Timeline', checklist: 'Checklist', kanban: 'Board', flow: 'Flow', moodboard: 'Moodboard',
  financial_model: 'Financial model', compliance_matrix: 'Compliance matrix', audit_report: 'Audit report', content_calendar: 'Content calendar',
  evidence: 'Evidence', risk_matrix: 'Risk matrix',
});

const tag = (text, kind = '') => `<span class="tag ${esc(kind)}">${esc(text)}</span>`;
const table = (columns, rows) => `<div class="art-scroll"><table class="art-table"><thead><tr>${columns.map((column) => `<th>${esc(column)}</th>`).join('')}</tr></thead>
  <tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td dir="auto">${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

function chart(data) {
  const labels = arr(data.labels, 36).map(String);
  const series = arr(data.series, 6).map((entry) => ({ name: String(entry?.name || 'Series'), values: arr(entry?.values, labels.length).map(n) }));
  if (!labels.length || !series.length) return '';
  const legend = `<div class="art-legend">${series.map((entry, index) => `<span><i style="background:${SERIES[index]}"></i>${esc(entry.name)}</span>`).join('')}</div>`;
  if (data.kind === 'pie') {
    const values = series[0].values.map((value) => Math.max(0, value || 0));
    const total = values.reduce((sum, value) => sum + value, 0) || 1;
    let angle = -Math.PI / 2;
    const slices = values.map((value, index) => {
      const sweep = (value / total) * Math.PI * 2;
      const [x1, y1, x2, y2] = [Math.cos(angle), Math.sin(angle), Math.cos(angle + sweep), Math.sin(angle + sweep)].map((v) => 50 + v * 45);
      const path = sweep >= Math.PI * 2 - 1e-6 ? '<circle cx="50" cy="50" r="45"/>' : `<path d="M50,50 L${x1.toFixed(2)},${y1.toFixed(2)} A45,45 0 ${sweep > Math.PI ? 1 : 0} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z"/>`;
      angle += sweep;
      return `<g fill="${SERIES[index % SERIES.length]}"><title>${esc(labels[index])}: ${esc(fmt(value, data.unit))}</title>${path}</g>`;
    }).join('');
    return `<div class="art-chart art-pie"><svg viewBox="0 0 100 100" role="img" aria-label="Pie chart">${slices}</svg>
      <div class="art-legend">${labels.map((label, index) => `<span><i style="background:${SERIES[index % SERIES.length]}"></i>${esc(label)} · ${esc(fmt(values[index], data.unit))}</span>`).join('')}</div></div>`;
  }
  const all = series.flatMap((entry) => entry.values).filter((value) => value !== null);
  const max = Math.max(0, ...all);
  const min = Math.min(0, ...all);
  const span = max - min || 1;
  const [W, H, L, B] = [600, 240, 48, 24];
  const x = (index) => L + ((W - L - 8) * (index + 0.5)) / labels.length;
  const y = (value) => 8 + (H - B - 8) * (1 - (value - min) / span);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => { const v = min + span * f; return `<g class="grid"><line x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${esc(fmt(v))}</text></g>`; }).join('');
  const band = (W - L - 8) / labels.length;
  const bars = data.kind === 'line'
    ? series.map((entry, s) => `<polyline fill="none" stroke="${SERIES[s]}" stroke-width="2.5" points="${entry.values.map((value, index) => (value === null ? '' : `${x(index)},${y(value)}`)).filter(Boolean).join(' ')}"/>
        ${entry.values.map((value, index) => (value === null ? '' : `<circle cx="${x(index)}" cy="${y(value)}" r="3.5" fill="${SERIES[s]}"><title>${esc(entry.name)} · ${esc(labels[index])}: ${esc(fmt(value, data.unit))}</title></circle>`)).join('')}`).join('')
    : series.map((entry, s) => entry.values.map((value, index) => {
      if (value === null) return '';
      const w = Math.max(2, (band * 0.8) / series.length);
      const left = L + band * index + band * 0.1 + w * s;
      return `<rect x="${left}" y="${Math.min(y(value), y(0))}" width="${w}" height="${Math.abs(y(value) - y(0))}" rx="2" fill="${SERIES[s]}"><title>${esc(entry.name)} · ${esc(labels[index])}: ${esc(fmt(value, data.unit))}</title></rect>`;
    }).join('')).join('');
  const axis = labels.map((label, index) => `<text x="${x(index)}" y="${H - 6}" text-anchor="middle">${esc(label.slice(0, 12))}</text>`).join('');
  return `<div class="art-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(data.kind === 'line' ? 'Line' : 'Bar')} chart${data.unit ? ` in ${esc(data.unit)}` : ''}">${grid}${bars}<g class="axis">${axis}</g></svg>${legend}</div>`;
}

function financial(data) {
  const items = arr(data.items);
  const currency = String(data.currency || '');
  const oneTime = items.reduce((sum, item) => sum + (n(item.one_time) || 0), 0);
  const monthly = items.reduce((sum, item) => sum + (n(item.monthly) || 0), 0);
  const basisKind = { KNOWN: 'ok', ESTIMATED: 'warn', ASSUMPTION: 'muted' };
  return `<div class="art-kpis"><div><span>One-time</span><strong>${esc(fmt(oneTime, currency))}</strong></div><div><span>Monthly</span><strong>${esc(fmt(monthly, currency))}</strong></div><div><span>First year</span><strong>${esc(fmt(oneTime + monthly * 12, currency))}</strong></div></div>
    ${table(['Category', 'Item', 'One-time', 'Monthly', 'Basis', 'Note'], items.map((item) => [esc(item.category), esc(item.item), esc(fmt(n(item.one_time))), esc(fmt(n(item.monthly))), tag(item.basis || 'ESTIMATED', basisKind[item.basis] || 'warn'), esc(item.note)]))}
    <div class="xs faint">KNOWN = sourced · ESTIMATED = reasoned estimate · ASSUMPTION = to confirm</div>`;
}

function riskMatrix(data) {
  const items = arr(data.items, 30);
  const cells = [];
  for (let impact = 5; impact >= 1; impact -= 1) {
    for (let likelihood = 1; likelihood <= 5; likelihood += 1) {
      const here = items.filter((item) => Number(item.impact) === impact && Number(item.likelihood) === likelihood);
      const level = impact * likelihood >= 15 ? 'hi' : impact * likelihood >= 8 ? 'mid' : 'lo';
      cells.push(`<div class="rm-cell rm-${level}" title="Impact ${impact} · Likelihood ${likelihood}">${here.map((item) => `<b title="${esc(item.risk)}">${items.indexOf(item) + 1}</b>`).join('')}</div>`);
    }
  }
  return `<div class="rm"><div class="rm-y">Impact →</div><div class="rm-grid">${cells.join('')}</div><div class="rm-x">Likelihood →</div></div>
    <ol class="art-list">${items.map((item) => `<li dir="auto"><strong>${esc(item.risk)}</strong> ${tag(`L${item.likelihood}·I${item.impact}`)}${item.owner ? ` ${tag(String(item.owner).toUpperCase(), 'muted')}` : ''}${item.mitigation ? `<div class="small muted">${esc(item.mitigation)}</div>` : ''}</li>`).join('')}</ol>`;
}

const RENDER = {
  table: (data) => table(arr(data.columns, 12), arr(data.rows).map((row) => arr(row, 12).map(esc))),
  chart,
  timeline: (data) => `<ol class="art-timeline">${arr(data.items).map((item) => `<li><div class="tl-dot"></div><div><strong dir="auto">${esc(item.label)}</strong>
    <span class="xs faint">${esc([item.start, item.end].filter(Boolean).join(' → '))}</span>${item.status ? ` ${tag(item.status, 'muted')}` : ''}${item.detail ? `<div class="small muted" dir="auto">${esc(item.detail)}</div>` : ''}</div></li>`).join('')}</ol>`,
  checklist: (data) => `<ul class="art-check">${arr(data.items).map((item) => `<li class="ck-${esc(item.status || 'todo')}"><span class="ck-box">${{ done: '✓', pass: '✓', fail: '✕', blocked: '!' }[item.status] || ''}</span>
    <span class="grow" dir="auto">${esc(item.text)}${item.note ? `<span class="small muted"> — ${esc(item.note)}</span>` : ''}</span>${item.owner ? tag(String(item.owner).toUpperCase(), 'muted') : ''}</li>`).join('')}</ul>`,
  kanban: (data) => `<div class="art-kanban">${arr(data.columns, 6).map((column) => `<div class="kb-col"><div class="kb-head">${esc(column.name)} <span class="faint">${arr(column.cards, 20).length}</span></div>
    ${arr(column.cards, 20).map((card) => `<div class="kb-card"><div dir="auto">${esc(card.title)}</div>${card.detail ? `<div class="xs muted" dir="auto">${esc(card.detail)}</div>` : ''}</div>`).join('')}</div>`).join('')}</div>`,
  flow: (data) => {
    const steps = arr(data.steps, 30);
    const label = new Map(steps.map((step) => [step.id, step.label]));
    return `<div class="art-flow">${steps.map((step, index) => `<div class="fl-step"><span class="fl-n">${index + 1}</span><div><div dir="auto">${esc(step.label)}</div>
      ${arr(step.next, 6).filter((id) => label.has(id) && id !== steps[index + 1]?.id).map((id) => `<div class="xs faint">→ ${esc(label.get(id))}</div>`).join('')}</div></div>`).join('<div class="fl-arrow" aria-hidden="true">→</div>')}</div>`;
  },
  moodboard: (data) => `<div class="mb">
    <div class="mb-palette">${arr(data.palette, 10).filter((swatch) => HEX.test(swatch?.hex)).map((swatch) => `<div class="mb-swatch"><div class="mb-chip" style="background:${swatch.hex}"></div><div class="small"><strong>${esc(swatch.name)}</strong></div><div class="xs mono faint">${esc(swatch.hex)}${swatch.role ? ` · ${esc(swatch.role)}` : ''}</div></div>`).join('')}</div>
    ${arr(data.typography, 4).length ? `<div class="mb-type">${arr(data.typography, 4).map((font) => `<div class="mb-font"><div class="xs faint">${esc(font.role || 'Type')} · ${esc(font.family)}</div><div class="mb-sample" style="font-family:'${esc(String(font.family).replace(/[^\p{L}\p{N} -]/gu, ''))}', var(--font)" dir="auto">${esc(font.sample || 'The quick brown fox — أبجد هوز')}</div></div>`).join('')}</div>` : ''}
    ${arr(data.concepts, 6).length ? `<div class="mb-concepts">${arr(data.concepts, 6).map((concept) => `<div class="mb-concept"><strong dir="auto">${esc(concept.name)}</strong><div class="small muted" dir="auto">${esc(concept.description)}</div></div>`).join('')}</div>` : ''}
    ${arr(data.keywords, 12).length ? `<div class="row">${arr(data.keywords, 12).map((word) => tag(word, 'muted')).join('')}</div>` : ''}</div>`,
  financial_model: financial,
  compliance_matrix: (data) => table(['Requirement', 'Jurisdiction', 'Status', 'Classification', 'Uncertainty', 'Source'], arr(data.items).map((item) => [
    `${esc(item.requirement)}${item.applicability ? `<div class="xs muted">${esc(item.applicability)}</div>` : ''}`, esc(item.jurisdiction), esc(item.status),
    tag(item.classification, { 'RISK FLAG': 'bad', 'PROFESSIONAL REVIEW REQUIRED': 'warn', DRAFT: 'muted' }[item.classification] || 'ok'), esc(item.uncertainty),
    /^https?:\/\//.test(String(item.source || '')) ? `<a href="${esc(item.source)}" target="_blank" rel="noopener noreferrer">source</a>${item.source_date ? ` <span class="xs faint">${esc(item.source_date)}</span>` : ''}` : esc(item.source)]))
    + '<div class="xs faint">LEGAL provides research, not legal advice. Items marked PROFESSIONAL REVIEW REQUIRED need a qualified lawyer.</div>',
  audit_report: (data) => `<div class="audit-verdict v-${esc(String(data.verdict || '').replace(/\s+/g, '-').toLowerCase())}">${esc(data.verdict || 'PASS')}</div>
    <div class="audit-issues">${arr(data.findings).map((finding) => `<div class="issue sev-${esc(finding.severity)}"><div class="row">${tag(finding.severity, { critical: 'bad', high: 'bad', medium: 'warn', low: 'muted' }[finding.severity])}${finding.area ? tag(finding.area, 'muted') : ''}${finding.owner ? `<span class="xs faint">→ ${esc(String(finding.owner).toUpperCase())}</span>` : ''}</div>
      <strong dir="auto">${esc(finding.title)}</strong>${finding.detail ? `<div class="small muted" dir="auto">${esc(finding.detail)}</div>` : ''}</div>`).join('') || '<div class="small muted">No findings.</div>'}</div>`,
  content_calendar: (data) => table(['When', 'Platform', 'Format', 'Hook', 'Caption'], arr(data.entries).map((entry) => [esc(entry.date), esc(entry.platform), esc(entry.format), `<strong>${esc(entry.hook)}</strong>`, esc(entry.caption)])),
  evidence: (data) => `<ul class="art-evidence">${arr(data.claims).map((claim) => {
    const status = claim.status === 'VERIFIED' && !/^https?:\/\//.test(String(claim.source || '')) ? 'LIKELY' : (['VERIFIED', 'LIKELY'].includes(claim.status) ? claim.status : 'UNKNOWN');
    return `<li>${tag(status, { VERIFIED: 'ok', LIKELY: 'warn', UNKNOWN: 'muted' }[status])}<span class="grow" dir="auto">${esc(claim.claim)}</span>${/^https?:\/\//.test(String(claim.source || '')) ? `<a class="xs" href="${esc(claim.source)}" target="_blank" rel="noopener noreferrer">source</a>` : ''}</li>`;
  }).join('')}</ul>`,
  risk_matrix: riskMatrix,
};

export function renderArtifact(artifact) {
  const type = String(artifact?.type || '');
  const data = artifact?.data || artifact || {};
  const draw = RENDER[type];
  if (!draw) return '';
  let body;
  try { body = draw(data); } catch { body = ''; }
  if (!body) return '';
  const who = artifact.agentLabel ? `<span class="xs faint">${esc(artifact.agentLabel)}</span>` : '';
  return `<figure class="artifact art-${esc(type)}"><figcaption><span class="art-type">${esc(ARTIFACT_LABELS[type] || type)}</span><strong dir="auto">${esc(artifact.title || '')}</strong>${who}</figcaption>${body}</figure>`;
}

// Splits Markdown into text and artifact blocks, so a chat message or an
// employee output shows its visuals in place.
export function splitArtifacts(markdown) {
  const parts = [];
  let last = 0;
  const source = String(markdown || '');
  for (const match of source.matchAll(/```artifact\s*\n([\s\S]*?)```/g)) {
    if (match.index > last) parts.push({ text: source.slice(last, match.index) });
    let parsed = null;
    try { parsed = JSON.parse(match[1]); } catch {}
    if (parsed && RENDER[String(parsed.type || '')]) parts.push({ artifact: { type: parsed.type, title: parsed.title, data: parsed } });
    last = match.index + match[0].length;
  }
  if (last < source.length) parts.push({ text: source.slice(last) });
  return parts;
}
