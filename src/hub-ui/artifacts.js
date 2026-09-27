// Visual output engine: employees emit structured data (```artifact blocks,
// validated server-side in src/office/artifacts.js); this module draws it.
// Every value is escaped and every colour re-validated here too, so a block
// that reaches the browser unvalidated (e.g. inside a chat message) is safe.
import { escapeHtml as esc } from './markdown.js';

const HEX = /^#[0-9a-f]{6}$/i;
// Only complete http(s) links become anchors; placeholders ("…/id...") stay text.
const isLink = (value) => /^https?:\/\/[^\s`'"<>]{4,1000}$/i.test(String(value || '')) && !/\.\.\.|…/.test(String(value));
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
const table = (columns, rows) => `<div class="art-scroll" tabindex="0" role="region" aria-label="Table"><table class="art-table"><thead><tr>${columns.map((column) => `<th>${esc(column)}</th>`).join('')}</tr></thead>
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

// FINANCE: every total is the sum of the listed lines (traceable), every
// line keeps its basis, and the sensitivity line is plain arithmetic on the
// ESTIMATED and ASSUMPTION lines — labelled as derived, never as a forecast.
function financial(data) {
  const items = arr(data.items);
  const currency = String(data.currency || '');
  const oneTime = items.reduce((sum, item) => sum + (n(item.one_time) || 0), 0);
  const monthly = items.reduce((sum, item) => sum + (n(item.monthly) || 0), 0);
  const annual = oneTime + monthly * 12;
  const basisKind = { KNOWN: 'ok', ESTIMATED: 'warn', ASSUMPTION: 'muted' };
  const firstYear = (item) => (n(item.one_time) || 0) + (n(item.monthly) || 0) * 12;
  const byBasis = ['KNOWN', 'ESTIMATED', 'ASSUMPTION'].map((basis) => [basis, items.filter((item) => (item.basis || 'ESTIMATED') === basis).reduce((sum, item) => sum + firstYear(item), 0)]);
  const categories = [...items.reduce((map, item) => map.set(item.category || 'Other', (map.get(item.category || 'Other') || 0) + firstYear(item)), new Map())].sort((x, y) => y[1] - x[1]);
  const top = Math.max(1, ...categories.map(([, value]) => value));
  const uncertain = items.filter((item) => (item.basis || 'ESTIMATED') !== 'KNOWN').reduce((sum, item) => sum + firstYear(item), 0);
  return `<div class="art-kpis"><div><span>Setup (one-time)</span><strong class="num">${esc(fmt(oneTime, currency))}</strong></div><div><span>Monthly</span><strong class="num">${esc(fmt(monthly, currency))}</strong></div>
      <div><span>Annual running</span><strong class="num">${esc(fmt(monthly * 12, currency))}</strong></div><div><span>First year total</span><strong class="num">${esc(fmt(annual, currency))}</strong></div></div>
    ${annual > 0 ? `<div class="fin-basis" role="img" aria-label="First-year cost by basis">${byBasis.filter(([, value]) => value > 0).map(([basis, value]) => `<span class="fb-${basis.toLowerCase()}" style="flex:${value}" title="${esc(basis)}: ${esc(fmt(value, currency))}"></span>`).join('')}</div>
      <div class="fin-basis-legend">${byBasis.map(([basis, value]) => `<span><i class="fb-${basis.toLowerCase()}"></i>${esc(basis)} <span class="num">${esc(fmt(value, currency))}</span></span>`).join('')}</div>` : ''}
    ${categories.length > 1 ? `<div class="fin-cats">${categories.map(([name, value]) => `<div class="fin-cat"><span dir="auto">${esc(name)}</span><span class="fin-bar"><i style="width:${Math.max(2, (value / top) * 100).toFixed(1)}%"></i></span><span class="num">${esc(fmt(value, currency))}</span></div>`).join('')}</div>` : ''}
    ${table(['Category', 'Item', 'One-time', 'Monthly', 'First year', 'Basis', 'Note'], items.map((item) => [esc(item.category), esc(item.item), esc(fmt(n(item.one_time))), esc(fmt(n(item.monthly))), esc(fmt(firstYear(item))), tag(item.basis || 'ESTIMATED', basisKind[item.basis] || 'warn'), esc(item.note)]))}
    ${uncertain > 0 ? `<div class="fin-sens small">Sensitivity (derived): if the ESTIMATED and ASSUMPTION lines are 20% higher, the first year is <strong class="num">${esc(fmt(annual + uncertain * 0.2, currency))}</strong>; 20% lower, <strong class="num">${esc(fmt(annual - uncertain * 0.2, currency))}</strong>.</div>` : ''}
    <div class="xs faint">Totals are sums of the lines above. KNOWN = sourced · ESTIMATED = reasoned estimate · ASSUMPTION = to confirm.</div>`;
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
  kanban: (data) => `<div class="art-kanban" tabindex="0" role="region" aria-label="Board">${arr(data.columns, 6).map((column) => `<div class="kb-col"><div class="kb-head">${esc(column.name)} <span class="faint">${arr(column.cards, 20).length}</span></div>
    ${arr(column.cards, 20).map((card) => `<div class="kb-card"><div dir="auto">${esc(card.title)}</div>${card.detail ? `<div class="xs muted" dir="auto">${esc(card.detail)}</div>` : ''}</div>`).join('')}</div>`).join('')}</div>`,
  flow: (data) => {
    const steps = arr(data.steps, 30);
    const label = new Map(steps.map((step) => [step.id, step.label]));
    return `<div class="art-flow">${steps.map((step, index) => `<div class="fl-step"><span class="fl-n">${index + 1}</span><div><div dir="auto">${esc(step.label)}</div>
      ${arr(step.next, 6).filter((id) => label.has(id) && id !== steps[index + 1]?.id).map((id) => `<div class="xs faint">→ ${esc(label.get(id))}</div>`).join('')}</div></div>`).join('<div class="fl-arrow" aria-hidden="true">→</div>')}</div>`;
  },
  moodboard: (data) => {
    const palette = arr(data.palette, 10).filter((swatch) => HEX.test(swatch?.hex));
    const fonts = arr(data.typography, 4).map((font) => ({ ...font, family: String(font.family || '').replace(/[^\p{L}\p{N} -]/gu, '').slice(0, 60) })).filter((font) => font.family);
    const role = (pattern, fallback) => palette.find((swatch) => pattern.test(`${swatch.role} ${swatch.name}`))?.hex || fallback;
    const primary = role(/primary|brand|main/i, palette[0]?.hex);
    const background = role(/background|base|surface|paper|milk|sand|light/i, palette.at(-1)?.hex);
    const accent = role(/accent|highlight|pop|cta/i, palette[1]?.hex || primary);
    const heading = fonts.find((font) => /head|display|title|logo/i.test(font.role || ''))?.family || fonts[0]?.family || '';
    const body = fonts.find((font) => /body|text|ui|arabic/i.test(font.role || ''))?.family || fonts.at(-1)?.family || heading;
    const face = (family) => (family ? `font-family:'${esc(family)}', var(--font)` : '');
    const name = String(data.brand || data.title || '').replace(/\s+[—–-]\s+.*$/, '').slice(0, 40) || 'Brand';
    const concept = arr(data.concepts, 6)[0];
    // Brand preview: the moodboard applied to a wordmark, an app screen and a
    // social tile — a real visual built from CREATIVE's palette and type.
    const preview = primary && background ? `<div class="mb-preview" data-fonts="${esc(fonts.map((font) => font.family).join('|'))}">
      <div class="mbp-wordmark" style="background:${background};color:${primary}"><span style="${face(heading)}">${esc(name)}</span><i style="background:${accent}"></i></div>
      <div class="mbp-phone" style="background:${background}"><div class="mbp-bar" style="background:${primary}"></div><div class="mbp-title" style="color:${primary};${face(heading)}">${esc(name)}</div>
        <div class="mbp-card" style="border-color:${primary}"><span style="${face(body)};color:${primary}" dir="auto">${esc(fonts[0]?.sample || concept?.name || 'Ready when you are')}</span></div>
        <div class="mbp-cta" style="background:${accent};color:${background}">${esc(concept ? 'Order now' : 'Continue')}</div></div>
      <div class="mbp-post" style="background:${primary};color:${background}"><span class="mbp-post-kicker" style="color:${accent}">${esc(concept?.name || 'Launch')}</span><span style="${face(heading)}" dir="auto">${esc(fonts.find((font) => /body|arabic/i.test(font.role || ''))?.sample || fonts[0]?.sample || name)}</span></div>
    </div>` : '';
    return `<div class="mb">${preview}
    <div class="mb-palette">${palette.map((swatch) => `<div class="mb-swatch"><div class="mb-chip" style="background:${swatch.hex}"></div><div class="small"><strong>${esc(swatch.name)}</strong></div><div class="xs mono faint">${esc(swatch.hex)}${swatch.role ? ` · ${esc(swatch.role)}` : ''}</div></div>`).join('')}</div>
    ${fonts.length ? `<div class="mb-type">${fonts.map((font) => `<div class="mb-font"><div class="xs faint">${esc(font.role || 'Type')} · ${esc(font.family)}</div><div class="mb-sample" style="${face(font.family)}" dir="auto">${esc(font.sample || 'The quick brown fox — أبجد هوز')}</div></div>`).join('')}</div>` : ''}
    ${arr(data.concepts, 6).length ? `<div class="mb-concepts">${arr(data.concepts, 6).map((item) => `<div class="mb-concept"><strong dir="auto">${esc(item.name)}</strong><div class="small muted" dir="auto">${esc(item.description)}</div></div>`).join('')}</div>` : ''}
    ${arr(data.keywords, 12).length ? `<div class="row">${arr(data.keywords, 12).map((word) => tag(word, 'muted')).join('')}</div>` : ''}</div>`;
  },
  financial_model: financial,
  compliance_matrix: (data) => {
    const items = arr(data.items);
    const count = (key, value) => items.filter((item) => item[key] === value).length;
    const review = count('classification', 'PROFESSIONAL REVIEW REQUIRED');
    const flags = count('classification', 'RISK FLAG');
    return `<div class="legal-summary"><div><strong class="num">${count('status', 'required')}</strong><span>required</span></div><div><strong class="num">${count('status', 'recommended')}</strong><span>recommended</span></div>
      <div class="${flags ? 'ls-flag' : ''}"><strong class="num">${flags}</strong><span>risk flags</span></div><div class="${review ? 'ls-review' : ''}"><strong class="num">${review}</strong><span>need a lawyer's review</span></div>
      <div><strong class="num">${items.filter((item) => item.uncertainty === 'high').length}</strong><span>high uncertainty</span></div></div>
    ${table(['Requirement', 'Jurisdiction', 'Applicability', 'Status', 'Classification', 'Uncertainty', 'Source · date'], items.map((item) => [
      `<strong>${esc(item.requirement)}</strong>`, esc(item.jurisdiction), esc(item.applicability), esc(item.status),
      tag(item.classification, { 'RISK FLAG': 'bad', 'PROFESSIONAL REVIEW REQUIRED': 'warn', DRAFT: 'muted' }[item.classification] || 'ok'), tag(item.uncertainty || 'medium', { high: 'bad', medium: 'warn', low: 'ok' }[item.uncertainty] || 'warn'),
      `${isLink(item.source) ? `<a href="${esc(item.source)}" target="_blank" rel="noopener noreferrer">source</a>` : `<span class="faint">${esc(item.source || 'no source')}</span>`}${item.source_date ? ` <span class="xs faint">${esc(item.source_date)}</span>` : ''}`]))}
    <div class="legal-note xs">LEGAL is AI legal research, not a licensed lawyer. Conclusions are source-backed; items marked PROFESSIONAL REVIEW REQUIRED need a qualified lawyer before launch.</div>`;
  },
  audit_report: (data) => {
    const findings = arr(data.findings);
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    const counts = ['critical', 'high', 'medium', 'low'].map((severity) => [severity, findings.filter((finding) => finding.severity === severity).length]);
    return `<div class="audit-head"><div class="audit-verdict v-${esc(String(data.verdict || 'PASS').replace(/\s+/g, '-').toLowerCase())}">${esc(data.verdict || 'PASS')}</div>
      <div class="audit-counts">${counts.map(([severity, value]) => `<span class="ac-${severity}"><strong class="num">${value}</strong> ${severity}</span>`).join('')}</div></div>
    ${findings.length ? table(['Issue', 'Severity', 'Area', 'Owner', 'Fix', 'Status'], findings.toSorted((x, y) => (order[x.severity] ?? 9) - (order[y.severity] ?? 9)).map((finding) => [
      `<strong dir="auto">${esc(finding.title)}</strong>`, tag(finding.severity, { critical: 'bad', high: 'bad', medium: 'warn', low: 'muted' }[finding.severity]), esc(finding.area),
      finding.owner ? `<span class="owner-cell">${esc(String(finding.owner).toUpperCase())}${finding.owner ? `<button type="button" class="btn btn-ghost btn-sm send-owner" data-send-owner="${esc(String(finding.owner).toLowerCase())}" data-issue="${esc(finding.title)}" data-detail="${esc(finding.detail || '')}" hidden>Send to ${esc(String(finding.owner).toUpperCase())}</button>` : ''}</span>` : '—',
      `<span dir="auto">${esc(finding.detail)}</span>`, tag('open', 'muted')])) : '<div class="small muted">No findings.</div>'}`;
  },
  content_calendar: (data) => {
    const entries = arr(data.entries);
    const groups = [...entries.reduce((map, entry) => map.set(entry.date || 'Unscheduled', [...(map.get(entry.date || 'Unscheduled') || []), entry]), new Map())];
    return `<div class="cal">${groups.map(([date, list]) => `<div class="cal-day"><div class="cal-date" dir="auto">${esc(date)}</div>${list.map((entry) => `<div class="cal-post">
      <div class="row"><span class="tag">${esc(entry.platform || 'Platform')}</span>${entry.format ? `<span class="tag muted">${esc(entry.format)}</span>` : ''}</div>
      <div class="cal-hook" dir="auto">${esc(entry.hook)}</div>${entry.caption ? `<div class="small muted" dir="auto">${esc(entry.caption)}</div>` : ''}</div>`).join('')}</div>`).join('')}</div>
    <div class="xs faint">Drafts only — nothing is published without Fahad’s approval.</div>`;
  },
  evidence: (data) => `<ul class="art-evidence">${arr(data.claims).map((claim) => {
    const status = claim.status === 'VERIFIED' && !isLink(claim.source) ? 'LIKELY' : (['VERIFIED', 'LIKELY'].includes(claim.status) ? claim.status : 'UNKNOWN');
    return `<li>${tag(status, { VERIFIED: 'ok', LIKELY: 'warn', UNKNOWN: 'muted' }[status])}<span class="grow" dir="auto">${esc(claim.claim)}</span>${isLink(claim.source) ? `<a class="xs" href="${esc(claim.source)}" target="_blank" rel="noopener noreferrer">source</a>` : ''}</li>`;
  }).join('')}</ul>`,
  risk_matrix: riskMatrix,
};

export function renderArtifact(artifact) {
  const type = String(artifact?.type || '');
  const data = artifact?.data || artifact || {};
  const draw = RENDER[type];
  if (!draw) return '';
  let body;
  try { body = draw({ title: artifact.title, ...data }); } catch { body = ''; }
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

// A compact, glanceable preview for library cards (same escaping rules).
export function artifactPreview(artifact) {
  const type = String(artifact?.type || '');
  const data = artifact?.data || {};
  const line = (text) => `<div class="pv-line" dir="auto">${esc(text)}</div>`;
  switch (type) {
    case 'moodboard': return `<div class="pv-swatches">${arr(data.palette, 6).filter((swatch) => HEX.test(swatch?.hex)).map((swatch) => `<span style="background:${swatch.hex}"></span>`).join('')}</div>${arr(data.typography, 2).map((font) => line(font.family)).join('')}`;
    case 'financial_model': {
      const items = arr(data.items);
      const monthly = items.reduce((sum, item) => sum + (n(item.monthly) || 0), 0);
      const oneTime = items.reduce((sum, item) => sum + (n(item.one_time) || 0), 0);
      return `<div class="pv-kpis"><span><b class="num">${esc(fmt(oneTime))}</b> setup</span><span><b class="num">${esc(fmt(monthly))}</b> / month</span></div>${line(`${items.length} lines · ${data.currency || ''}`)}`;
    }
    case 'chart': return chart({ ...data, kind: data.kind === 'pie' ? 'bar' : data.kind }).replace('class="art-chart"', 'class="art-chart pv-chart"').replace(/<div class="art-legend">[\s\S]*?<\/div><\/div>$/, '</div>');
    case 'compliance_matrix': { const items = arr(data.items); return `<div class="pv-kpis"><span><b class="num">${items.length}</b> requirements</span><span><b class="num">${items.filter((item) => item.classification === 'PROFESSIONAL REVIEW REQUIRED' || item.classification === 'RISK FLAG').length}</b> flagged</span></div>${items.slice(0, 2).map((item) => line(item.requirement)).join('')}`; }
    case 'audit_report': return `<div class="audit-verdict v-${esc(String(data.verdict || 'PASS').replace(/\s+/g, '-').toLowerCase())} pv-verdict">${esc(data.verdict || 'PASS')}</div>${arr(data.findings).slice(0, 2).map((finding) => line(`${finding.severity}: ${finding.title}`)).join('')}`;
    case 'kanban': return `<div class="pv-cols">${arr(data.columns, 4).map((column) => `<span><b>${esc(column.name)}</b> ${arr(column.cards, 20).length}</span>`).join('')}</div>`;
    case 'table': return `<div class="pv-line faint">${arr(data.columns, 4).map(esc).join(' · ')}</div>${arr(data.rows, 3).map((row) => line(arr(row, 3).join(' · '))).join('')}`;
    case 'timeline': case 'checklist': return arr(data.items, 3).map((item) => line(item.label || item.text)).join('');
    case 'flow': return line(arr(data.steps, 5).map((step) => step.label).join(' → '));
    case 'content_calendar': return arr(data.entries, 3).map((entry) => line(`${entry.platform || ''} · ${entry.hook || ''}`)).join('');
    case 'evidence': return arr(data.claims, 3).map((claim) => line(`${claim.status}: ${claim.claim}`)).join('');
    case 'risk_matrix': return arr(data.items, 3).map((item) => line(`L${item.likelihood}·I${item.impact} ${item.risk}`)).join('');
    default: return '';
  }
}
