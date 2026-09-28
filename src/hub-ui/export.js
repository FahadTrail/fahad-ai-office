// Shared artifact exports — one implementation for every employee's output:
//   CSV       tabular artifacts (tables, budgets, matrices, calendars, …)
//   Markdown  a readable document of any artifact
//   PNG       charts and brand previews (drawn from their SVG / colours)
//   Print     any artifact, laid out for "Save as PDF" or presenting
// Everything runs in the browser on data already on screen; nothing is sent.

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const csvCell = (value) => {
  const text = clean(value);
  // Neutralise spreadsheet formulas (=, +, -, @) so an export cannot execute.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const arr = (value) => (Array.isArray(value) ? value : []);

// Rows for CSV/Markdown: [header, ...rows] or null when not tabular.
export function artifactRows(artifact) {
  const data = artifact?.data || {};
  switch (artifact?.type) {
    case 'table': return [arr(data.columns), ...arr(data.rows)];
    case 'financial_model': return [['Category', 'Item', 'One-time', 'Monthly', 'First year', 'Basis', 'Note', 'Currency'],
      ...arr(data.items).map((item) => [item.category, item.item, item.one_time ?? '', item.monthly ?? '', (Number(item.one_time) || 0) + (Number(item.monthly) || 0) * 12, item.basis, item.note, data.currency || ''])];
    case 'compliance_matrix': return [['Requirement', 'Jurisdiction', 'Applicability', 'Status', 'Classification', 'Uncertainty', 'Source', 'Source date'],
      ...arr(data.items).map((item) => [item.requirement, item.jurisdiction, item.applicability, item.status, item.classification, item.uncertainty, item.source, item.source_date])];
    case 'audit_report': return [['Verdict', 'Issue', 'Severity', 'Area', 'Owner', 'Detail', 'Expected', 'Stated', 'Fix'], ...arr(data.findings).map((finding) => [data.verdict, finding.title, finding.severity, finding.area, finding.owner, finding.detail, finding.expected, finding.actual, finding.fix])];
    case 'content_calendar': return [['When', 'Time', 'Platform', 'Pillar', 'Format', 'Hook', 'Caption / script', 'CTA', 'Status', 'Notes'],
      ...arr(data.entries).map((entry) => [entry.date, entry.time ? `${entry.time}${entry.time_basis === 'DATA' ? '' : ' (assumption)'}` : '', entry.platform, entry.pillar, entry.format, entry.hook, entry.caption, entry.cta, entry.status, entry.notes])];
    case 'checklist': return [['Item', 'Status', 'Owner', 'Note'], ...arr(data.items).map((item) => [item.text, item.status, item.owner, item.note])];
    case 'timeline': return [['Milestone', 'Start', 'End', 'Status', 'Detail'], ...arr(data.items).map((item) => [item.label, item.start, item.end, item.status, item.detail])];
    case 'kanban': return [['Column', 'Card', 'Detail', 'Priority'], ...arr(data.columns).flatMap((column) => arr(column.cards).map((card) => [column.name, card.title, card.detail, card.priority]))];
    case 'evidence': return [['Claim', 'Status', 'Source'], ...arr(data.claims).map((claim) => [claim.claim, claim.status, claim.source])];
    case 'risk_matrix': return [['Risk', 'Likelihood', 'Impact', 'Score', 'Owner', 'Mitigation'], ...arr(data.items).map((item) => [item.risk, item.likelihood, item.impact, item.likelihood * item.impact, item.owner, item.mitigation])];
    case 'chart': return [['Label', ...arr(data.series).map((series) => series.name)], ...arr(data.labels).map((label, index) => [label, ...arr(data.series).map((series) => series.values?.[index] ?? '')])];
    case 'flow': return [['Step', 'Leads to'], ...arr(data.steps).map((step) => [step.label, arr(step.next).join(', ')])];
    case 'moodboard': return [['Kind', 'Name', 'Value', 'Role'], ...arr(data.palette).map((swatch) => ['colour', swatch.name, swatch.hex, swatch.role]), ...arr(data.typography).map((font) => ['font', font.family, font.sample, font.role])];
    default: return null;
  }
}

export function toCsv(artifact) {
  const rows = artifactRows(artifact);
  return rows ? `${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n` : null;
}

export function toMarkdown(artifact) {
  const rows = artifactRows(artifact) || [];
  const lines = [`# ${clean(artifact?.title) || 'Artifact'}`, '', `*${clean(artifact?.agentLabel || '')}${artifact?.objective ? ` · ${clean(artifact.objective)}` : ''}${artifact?.at ? ` · ${new Date(artifact.at).toISOString().slice(0, 10)}` : ''}*`, ''];
  if (rows.length) {
    const cell = (value) => clean(value).replace(/\|/g, '\\|');
    lines.push(`| ${rows[0].map(cell).join(' | ')} |`, `| ${rows[0].map(() => '---').join(' | ')} |`, ...rows.slice(1).map((row) => `| ${row.map(cell).join(' | ')} |`));
  }
  if (artifact?.type === 'moodboard') lines.push('', ...arr(artifact.data?.concepts).map((concept) => `- **${clean(concept.name)}** — ${clean(concept.description)}`));
  if (artifact?.type === 'compliance_matrix') lines.push('', '> LEGAL is AI legal research, not a licensed lawyer.');
  return `${lines.join('\n')}\n`;
}

export const fileName = (artifact, extension) => `${clean(artifact?.title || artifact?.type || 'artifact').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'artifact'}.${extension}`;

export function download(name, content, type) {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// PNG of an on-screen SVG (charts): colours are resolved from the live theme
// so the image matches what Fahad sees.
export async function svgToPng(svg, { scale = 2, background = null } = {}) {
  const clone = svg.cloneNode(true);
  const box = svg.viewBox?.baseVal?.width ? svg.viewBox.baseVal : { width: svg.clientWidth || 600, height: svg.clientHeight || 300 };
  const resolve = (node, source) => {
    const style = getComputedStyle(source);
    for (const property of ['fill', 'stroke', 'stroke-width', 'opacity', 'font-size', 'font-family', 'color']) node.style?.setProperty(property, style.getPropertyValue(property));
    [...node.children].forEach((child, index) => resolve(child, source.children[index]));
  };
  resolve(clone, svg);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', box.width);
  clone.setAttribute('height', box.height);
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
  await image.decode();
  const canvas = Object.assign(document.createElement('canvas'), { width: box.width * scale, height: box.height * scale });
  const context = canvas.getContext('2d');
  if (background) { context.fillStyle = background; context.fillRect(0, 0, canvas.width, canvas.height); }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolveBlob) => canvas.toBlob(resolveBlob, 'image/png'));
}

// PNG of a moodboard: swatches, names and hex values drawn directly.
export async function moodboardPng(artifact, { background = '#ffffff', ink = '#1d1d1f' } = {}) {
  const palette = arr(artifact?.data?.palette).filter((swatch) => /^#[0-9a-f]{6}$/i.test(swatch?.hex || ''));
  const canvas = Object.assign(document.createElement('canvas'), { width: 1600, height: 900 });
  const context = canvas.getContext('2d');
  context.fillStyle = background; context.fillRect(0, 0, 1600, 900);
  context.fillStyle = ink; context.font = '600 44px Inter, system-ui, sans-serif';
  context.fillText(clean(artifact?.title || 'Moodboard'), 80, 110);
  const width = Math.min(260, (1440 - (palette.length - 1) * 24) / Math.max(1, palette.length));
  palette.forEach((swatch, index) => {
    const x = 80 + index * (width + 24);
    context.fillStyle = swatch.hex; context.beginPath(); context.roundRect(x, 180, width, 420, 28); context.fill();
    context.fillStyle = ink; context.font = '600 26px Inter, system-ui, sans-serif'; context.fillText(clean(swatch.name).slice(0, 18), x, 650);
    context.font = '400 22px ui-monospace, monospace'; context.fillText(`${swatch.hex}${swatch.role ? ` · ${clean(swatch.role)}` : ''}`.slice(0, 26), x, 690);
  });
  context.font = '400 26px Inter, system-ui, sans-serif';
  context.fillText(arr(artifact?.data?.typography).map((font) => `${clean(font.role)}: ${clean(font.family)}`).join('   ·   ').slice(0, 110), 80, 790);
  return new Promise((resolveBlob) => canvas.toBlob(resolveBlob, 'image/png'));
}

// Print one artifact on its own page (Save as PDF / present).
export function printArtifact(html, title) {
  const holder = document.createElement('div');
  holder.className = 'print-only';
  holder.innerHTML = `<h1 class="print-title">${title.replace(/[<>&]/g, '')}</h1>${html}`;
  document.body.append(holder);
  document.body.classList.add('printing');
  const done = () => { holder.remove(); document.body.classList.remove('printing'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(done, 60_000);
}
