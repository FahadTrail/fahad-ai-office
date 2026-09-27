// Structured artifacts: employees emit data, the Hub renders it with shared
// components. Agents never produce HTML. Each artifact is a fenced block
//
//   ```artifact
//   {"type":"table","title":"…",…}
//   ```
//
// validated here against a small schema per type; anything invalid is
// dropped (the prose output still stands).

const MAX_ITEMS = 60;
const MAX_TEXT = 600;

const text = (value, max = MAX_TEXT) => String(value ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max);
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const list = (value, max = MAX_ITEMS) => (Array.isArray(value) ? value.slice(0, max) : []);
const oneOf = (value, allowed, fallback) => {
  const upper = String(value ?? '').trim();
  const match = allowed.find((option) => option.toLowerCase() === upper.toLowerCase());
  return match ?? fallback;
};
// A real, complete link: placeholders ("…/id...", "https://x.com/...") and
// links wrapped in Markdown/code punctuation are rejected, never saved.
export function realUrl(value) {
  const raw = String(value ?? '').trim();
  if (/\.\.\.|…/.test(raw)) return '';
  const candidate = raw.replace(/^[<`'"(]+|[>`'")\],;:.]+$/g, '');
  if (!/^https?:\/\/[^\s`'"<>]{4,1000}$/i.test(candidate)) return '';
  try {
    return /\.[a-z]{2,}$/i.test(new URL(candidate).hostname) ? candidate : '';
  } catch { return ''; }
}
const hex = (value) => (/^#[0-9a-f]{6}$/i.test(String(value || '').trim()) ? String(value).trim().toUpperCase() : null);

// type → { hint (for prompts), clean (validator returning data or null) }
export const ARTIFACT_TYPES = Object.freeze({
  table: {
    hint: '{"type":"table","title":"…","columns":["A","B"],"rows":[["a1","b1"]]}',
    clean: (raw) => {
      const columns = list(raw.columns, 12).map((column) => text(column, 80));
      const rows = list(raw.rows, 80).map((row) => list(row, columns.length || 12).map((cell) => text(cell, 300)));
      return columns.length && rows.length ? { columns, rows } : null;
    },
  },
  chart: {
    hint: '{"type":"chart","title":"…","kind":"bar|line|pie","unit":"AED","labels":["Jan","Feb"],"series":[{"name":"Costs","values":[1200,900]}]}',
    clean: (raw) => {
      const labels = list(raw.labels, 36).map((label) => text(label, 40));
      const series = list(raw.series, 6).map((entry) => ({ name: text(entry?.name, 60) || 'Series', values: list(entry?.values, labels.length).map(num) }))
        .filter((entry) => entry.values.some((value) => value !== null));
      return labels.length && series.length ? { kind: oneOf(raw.kind, ['bar', 'line', 'pie'], 'bar'), unit: text(raw.unit, 20), labels, series } : null;
    },
  },
  timeline: {
    hint: '{"type":"timeline","title":"…","items":[{"label":"MVP","start":"Month 1","end":"Month 3","status":"planned","detail":"…"}]}',
    clean: (raw) => {
      const items = list(raw.items).map((item) => ({ label: text(item?.label, 120), start: text(item?.start, 40), end: text(item?.end, 40),
        status: text(item?.status, 30), detail: text(item?.detail, 300) })).filter((item) => item.label);
      return items.length ? { items } : null;
    },
  },
  checklist: {
    hint: '{"type":"checklist","title":"…","items":[{"text":"…","status":"todo|done|pass|fail|blocked","owner":"product"}]}',
    clean: (raw) => {
      const items = list(raw.items).map((item) => ({ text: text(item?.text, 300), status: oneOf(item?.status, ['todo', 'done', 'pass', 'fail', 'blocked'], 'todo'),
        owner: text(item?.owner, 40), note: text(item?.note, 300) })).filter((item) => item.text);
      return items.length ? { items } : null;
    },
  },
  kanban: {
    hint: '{"type":"kanban","title":"MVP board","columns":[{"name":"Must","cards":[{"title":"…","detail":"…"}]}]}',
    clean: (raw) => {
      const columns = list(raw.columns, 6).map((column) => ({ name: text(column?.name, 40) || 'Column',
        cards: list(column?.cards, 20).map((card) => ({ title: text(card?.title, 120), detail: text(card?.detail, 240), priority: text(card?.priority, 20) })).filter((card) => card.title) }));
      return columns.some((column) => column.cards.length) ? { columns } : null;
    },
  },
  flow: {
    hint: '{"type":"flow","title":"User journey","steps":[{"id":"s1","label":"Sign up","next":["s2"]},{"id":"s2","label":"…","next":[]}]}',
    clean: (raw) => {
      const steps = list(raw.steps, 30).map((step, index) => ({ id: text(step?.id, 40) || `s${index + 1}`, label: text(step?.label, 120), next: list(step?.next, 6).map((id) => text(id, 40)) }))
        .filter((step) => step.label);
      return steps.length ? { steps } : null;
    },
  },
  moodboard: {
    hint: '{"type":"moodboard","title":"…","palette":[{"name":"Harbor blue","hex":"#1E3A5F","role":"primary"}],"typography":[{"role":"headings","family":"Fraunces","sample":"…"}],"concepts":[{"name":"…","description":"…"}],"keywords":["calm","crafted"]}',
    clean: (raw) => {
      const palette = list(raw.palette, 10).map((swatch) => ({ name: text(swatch?.name, 40), hex: hex(swatch?.hex), role: text(swatch?.role, 40) })).filter((swatch) => swatch.hex);
      const typography = list(raw.typography, 4).map((font) => ({ role: text(font?.role, 40), family: text(font?.family, 60).replace(/[^\p{L}\p{N} '-]/gu, ''), sample: text(font?.sample, 120) })).filter((font) => font.family);
      const concepts = list(raw.concepts, 6).map((concept) => ({ name: text(concept?.name, 80), description: text(concept?.description, 400) })).filter((concept) => concept.name);
      const keywords = list(raw.keywords, 12).map((word) => text(word, 30)).filter(Boolean);
      return palette.length || concepts.length ? { palette, typography, concepts, keywords } : null;
    },
  },
  financial_model: {
    hint: '{"type":"financial_model","title":"Launch budget","currency":"AED","items":[{"category":"Build","item":"MVP development","one_time":30000,"monthly":0,"basis":"ESTIMATED","note":"…"}]}',
    clean: (raw) => {
      const items = list(raw.items).map((item) => ({ category: text(item?.category, 60), item: text(item?.item, 120), one_time: num(item?.one_time), monthly: num(item?.monthly),
        basis: oneOf(item?.basis, ['KNOWN', 'ESTIMATED', 'ASSUMPTION'], 'ESTIMATED'), note: text(item?.note, 240) })).filter((item) => item.item);
      return items.length ? { currency: text(raw.currency, 8) || 'USD', items } : null;
    },
  },
  compliance_matrix: {
    hint: '{"type":"compliance_matrix","title":"…","items":[{"requirement":"…","jurisdiction":"UAE","source":"https://…","source_date":"2026-01-01","applicability":"…","status":"required|recommended|not_applicable|unknown","classification":"INFORMATION|DRAFT|RISK FLAG|PROFESSIONAL REVIEW REQUIRED","uncertainty":"low|medium|high"}]}',
    clean: (raw) => {
      const items = list(raw.items).map((item) => ({
        requirement: text(item?.requirement, 300), jurisdiction: text(item?.jurisdiction, 60), source: realUrl(item?.source) || text(item?.source, 400).replace(/https?:\/\/\S+/gi, '').trim(), source_date: text(item?.source_date, 20),
        applicability: text(item?.applicability, 300), status: oneOf(item?.status, ['required', 'recommended', 'not_applicable', 'unknown'], 'unknown'),
        classification: oneOf(item?.classification, ['INFORMATION', 'DRAFT', 'RISK FLAG', 'PROFESSIONAL REVIEW REQUIRED'], 'INFORMATION'),
        uncertainty: oneOf(item?.uncertainty, ['low', 'medium', 'high'], 'medium'),
      })).filter((item) => item.requirement);
      return items.length ? { items } : null;
    },
  },
  audit_report: {
    hint: '{"type":"audit_report","title":"…","verdict":"PASS|NEEDS WORK|BLOCKED","findings":[{"title":"…","severity":"low|medium|high|critical","area":"security","owner":"product","detail":"…"}]}',
    clean: (raw) => {
      const findings = list(raw.findings).map((finding) => ({ title: text(finding?.title, 160), severity: oneOf(finding?.severity, ['low', 'medium', 'high', 'critical'], 'medium'),
        area: text(finding?.area, 40), owner: text(finding?.owner, 30), detail: text(finding?.detail, 400) })).filter((finding) => finding.title);
      return { verdict: oneOf(raw.verdict, ['PASS', 'NEEDS WORK', 'BLOCKED'], findings.length ? 'NEEDS WORK' : 'PASS'), findings };
    },
  },
  content_calendar: {
    hint: '{"type":"content_calendar","title":"…","entries":[{"date":"Week 1 Mon","platform":"Instagram","format":"Reel","hook":"…","caption":"…"}]}',
    clean: (raw) => {
      const entries = list(raw.entries).map((entry) => ({ date: text(entry?.date, 40), platform: text(entry?.platform, 30), format: text(entry?.format, 30),
        hook: text(entry?.hook, 200), caption: text(entry?.caption, 400) })).filter((entry) => entry.hook || entry.caption);
      return entries.length ? { entries } : null;
    },
  },
  evidence: {
    hint: '{"type":"evidence","title":"…","claims":[{"claim":"…","status":"VERIFIED|LIKELY|UNKNOWN","source":"https://…"}]}',
    clean: (raw) => {
      const claims = list(raw.claims).map((claim) => ({ claim: text(claim?.claim, 300), status: oneOf(claim?.status, ['VERIFIED', 'LIKELY', 'UNKNOWN'], 'UNKNOWN'),
        source: realUrl(claim?.source).slice(0, 400) }))
        .map((claim) => (claim.status === 'VERIFIED' && !claim.source ? { ...claim, status: 'LIKELY' } : claim))
        .filter((claim) => claim.claim);
      return claims.length ? { claims } : null;
    },
  },
  risk_matrix: {
    hint: '{"type":"risk_matrix","title":"…","items":[{"risk":"…","likelihood":1-5,"impact":1-5,"owner":"legal","mitigation":"…"}]}',
    clean: (raw) => {
      const clamp = (value) => Math.min(5, Math.max(1, Math.round(num(value) || 3)));
      const items = list(raw.items, 30).map((item) => ({ risk: text(item?.risk, 200), likelihood: clamp(item?.likelihood), impact: clamp(item?.impact),
        owner: text(item?.owner, 30), mitigation: text(item?.mitigation, 300) })).filter((item) => item.risk);
      return items.length ? { items } : null;
    },
  },
});

const BLOCK = /```artifact\s*\n([\s\S]*?)```/g;

// Every artifact block in an output → validated artifacts (max 6).
export function parseArtifacts(markdown) {
  const artifacts = [];
  const errors = [];
  for (const match of String(markdown || '').matchAll(BLOCK)) {
    if (artifacts.length >= 6) break;
    let raw;
    try { raw = JSON.parse(match[1]); } catch { errors.push('invalid JSON'); continue; }
    const spec = ARTIFACT_TYPES[String(raw?.type || '').toLowerCase()];
    if (!spec) { errors.push(`unknown type ${raw?.type}`); continue; }
    const data = spec.clean(raw);
    if (!data) { errors.push(`empty ${raw.type}`); continue; }
    artifacts.push({ type: String(raw.type).toLowerCase(), title: text(raw.title, 200) || String(raw.type), data });
  }
  return { artifacts, errors };
}

export function stripArtifacts(markdown) {
  return String(markdown || '').replace(BLOCK, '').replace(/\n{3,}/g, '\n\n').trim();
}

// Prompt lines telling an employee which artifacts to emit and their shape.
export function artifactInstructions(types = []) {
  const known = types.filter((type) => ARTIFACT_TYPES[type]);
  if (!known.length) return [];
  return [
    'VISUAL OUTPUTS: put structured data in fenced blocks that start with ```artifact and contain ONE JSON object each (no HTML).',
    'The Office renders them as tables, charts and boards. Use only these shapes:',
    ...known.map((type) => `  ${ARTIFACT_TYPES[type].hint}`),
  ];
}

// Sources in a "## Sources" section → knowledge items (links only).
export function parseSources(markdown) {
  const section = String(markdown || '').match(/^##\s*Sources[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/mi)?.[1] || '';
  const found = new Map();
  for (const match of section.matchAll(/\[([^\]]{2,200})\]\(([^)\s]{4,1000})\)|(https?:\/\/[^\s)>\]]{4,1000})/g)) {
    const url = realUrl(match[2] || match[3]);
    if (url && !found.has(url)) found.set(url, { title: text(match[1] || url, 300), url });
  }
  return [...found.values()].slice(0, 20);
}
