// The Office roster: who works here, what each employee is for, and how the
// shared Model Pool routes their work (by job type — never a fixed model).
//
// Identities live in public.agents (slug, name, system prompt, allowed tools);
// this module adds the executable contract the workflow needs:
//   executor 'chief'  — CHIEF (plans, dispatches, synthesizes)
//   executor 'office' — runs as a task in the Office task graph
//   executor 'coding' — CODING (the Coding Agent's engineering workflow)
// Retired employees stay resolvable so historical work keeps its identity,
// but they are never dispatched or shown on the Office floor.

export const OFFICE_AGENTS = Object.freeze([
  {
    slug: 'chief-of-staff', key: 'chief', label: 'CHIEF', executor: 'chief', job: 'orchestration', webTools: false, directChat: true,
    scope: 'Your main contact. Understands the objective, decides who is needed, runs the work graph, follows up and brings back one result.',
    deliverable: 'Executive synthesis', artifacts: ['table', 'checklist', 'timeline'],
  },
  {
    slug: 'research-strategy', key: 'research', label: 'RESEARCH', executor: 'office', job: 'research', webTools: true, directChat: true,
    scope: 'Deep research and validation: markets, competitors, companies, products, technology, names and domains, public brand saturation, trends — with evidence.',
    deliverable: 'Research & evidence', artifacts: ['evidence', 'table', 'risk_matrix'],
    contract: [
      'Label every material claim VERIFIED (you saw a source), LIKELY (indirect evidence) or UNKNOWN. Never fabricate search evidence.',
      'Trademark or legal conclusions are for LEGAL: flag them in the Handoff instead of concluding.',
      'Include an "evidence" artifact for your key claims and a "table" artifact for comparisons (competitors, names, options).',
    ],
  },
  {
    slug: 'brand-creative', key: 'creative', label: 'CREATIVE', executor: 'office', job: 'branding', webTools: false, directChat: true,
    scope: 'Brand and creative direction A to Z: naming, logo direction, visual identity, colour, typography, packaging, campaign visuals, mockups and motion direction.',
    deliverable: 'Brand & visual system', artifacts: ['moodboard', 'table'],
    contract: [
      'Your deliverable is visual, not prose: always include a "moodboard" artifact with a real colour palette (hex values and roles),',
      'a font pairing (real, freely licensed font families such as Google Fonts), logo/visual concepts and keywords.',
    ],
  },
  {
    slug: 'product-tech', key: 'product', label: 'PRODUCT', executor: 'office', job: 'research', webTools: true, directChat: true,
    scope: 'Turns ideas into buildable products: users, value proposition, PRD, MVP scope, roadmap, user flows, screens, priorities and acceptance criteria.',
    deliverable: 'PRD & product plan', artifacts: ['kanban', 'timeline', 'flow', 'checklist', 'table'],
    contract: [
      'Make scope explicit (in MVP / later / out). Write acceptance criteria that CODING can implement and AUDIT can check.',
      'Include a "kanban" artifact for the MVP board (columns such as Must / Should / Later), a "timeline" artifact for the roadmap,',
      'a "flow" artifact for the main user journey and a "checklist" artifact of acceptance criteria.',
    ],
  },
  {
    slug: 'business-finance', key: 'finance', label: 'FINANCE', executor: 'office', job: 'finance', webTools: true, directChat: true,
    scope: 'Development, infrastructure, model and launch costs, recurring expenses, pricing, unit economics, cash needs, break-even and scenarios. Analysis only — never moves money.',
    deliverable: 'Financial model', artifacts: ['financial_model', 'chart', 'table'],
    contract: [
      'Mark every figure KNOWN (from a source or Fahad), ESTIMATED (your estimate with reasoning) or ASSUMPTION. Never present an estimate as fact.',
      'Include a "financial_model" artifact (line items with basis) and a "chart" artifact (monthly costs, scenarios or break-even).',
    ],
  },
  {
    slug: 'coding-agent', key: 'coding', label: 'CODING', executor: 'coding', job: 'coding', webTools: false, directChat: false,
    scope: 'Engineering execution: repository, architecture, code, tests, GitHub, pull requests, CI, Supabase, deployment and verification.',
    deliverable: 'Code change, PR, tests and deployment', artifacts: [],
  },
  {
    slug: 'qa-security', key: 'audit', label: 'AUDIT', executor: 'office', job: 'orchestration', webTools: false, directChat: true,
    scope: 'Quality, security and completeness review of every department’s work — product, finance, brand, content, legal handoffs and software.',
    deliverable: 'Readiness review', artifacts: ['audit_report', 'checklist'],
    contract: [
      'Include an "audit_report" artifact with a verdict (PASS / NEEDS WORK / BLOCKED) and findings, each with severity',
      '(low/medium/high/critical), area and the responsible employee key (research, creative, product, finance, coding, social, legal).',
      'Return issues to their owner; do not rewrite their work yourself.',
    ],
  },
  {
    slug: 'content-media', key: 'social', label: 'SOCIAL', executor: 'office', job: 'content', webTools: true, directChat: true,
    scope: 'What to say and where: trends, content strategy, hooks, scripts, captions, campaigns, content calendars, SEO and platform adaptations.',
    deliverable: 'Content & campaign plan', artifacts: ['content_calendar', 'table'],
    contract: [
      'Use fresh research for trends and platform behaviour; say when you could not verify something current.',
      'Include a "content_calendar" artifact (date, platform, format, hook). Brief CREATIVE on visuals in the Handoff. Drafts only; nothing is published.',
    ],
  },
  {
    slug: 'legal-compliance', key: 'legal', label: 'LEGAL', executor: 'office', job: 'research', webTools: true, directChat: true,
    scope: 'Legal and compliance research: UAE rules, privacy, terms and policies, contracts, app-store and provider rules, IP and open-source licensing.',
    deliverable: 'Compliance review', artifacts: ['compliance_matrix', 'checklist'],
    contract: [
      'You are not a licensed lawyer; say so once. For each material point record JURISDICTION, SOURCE, DATE, APPLICABILITY, REQUIREMENT and UNCERTAINTY.',
      'Classify each point as INFORMATION, DRAFT, RISK FLAG or PROFESSIONAL REVIEW REQUIRED. Use current authoritative sources for time-sensitive law.',
      'Include a "compliance_matrix" artifact with those fields for every requirement.',
    ],
  },
  // Retired identities (history only).
  { slug: 'business-strategy', key: 'strategy', label: 'Business Strategy', executor: 'office', job: 'research', webTools: true, retired: true, mergedInto: 'product', scope: 'Merged into PRODUCT.', deliverable: 'Business strategy', artifacts: [] },
  { slug: 'operations', key: 'operations', label: 'Operations', executor: 'office', job: 'content', webTools: false, retired: true, mergedInto: 'product', scope: 'Merged into CHIEF, PRODUCT and AUDIT.', deliverable: 'Operations plan', artifacts: [] },
].map((agent) => Object.freeze({ directChat: false, contract: [], ...agent })));

export const ACTIVE_AGENTS = Object.freeze(OFFICE_AGENTS.filter((agent) => !agent.retired));

const BY_SLUG = new Map(OFFICE_AGENTS.map((agent) => [agent.slug, agent]));
const BY_KEY = new Map(OFFICE_AGENTS.map((agent) => [agent.key, agent]));
// Words (English and the Gulf Arabic Fahad uses) for each employee. Old keys
// from earlier plans map to their successor.
const ALIASES = {
  chief: 'chief', 'الشيف': 'chief', 'التشيف': 'chief', 'الرئيس': 'chief',
  research: 'research', researcher: 'research', market: 'research', 'الريسيرش': 'research', 'البحث': 'research', 'الأبحاث': 'research',
  creative: 'creative', brand: 'creative', branding: 'creative', design: 'creative', 'الكرييتف': 'creative', 'الكريتيف': 'creative', 'الإبداع': 'creative', 'التصميم': 'creative',
  product: 'product', strategy: 'product', business: 'product', pm: 'product', tech: 'product', technical: 'product', operations: 'product', ops: 'product',
  'البرودكت': 'product', 'المنتج': 'product',
  finance: 'finance', financial: 'finance', 'الفاينانس': 'finance', 'المالية': 'finance',
  coding: 'coding', code: 'coding', development: 'coding', developer: 'coding', engineering: 'coding', 'الكودينج': 'coding', 'الكودنج': 'coding', 'البرمجة': 'coding',
  audit: 'audit', review: 'audit', qa: 'audit', quality: 'audit', security: 'audit', 'الأوديت': 'audit', 'التدقيق': 'audit', 'المراجعة': 'audit',
  social: 'social', content: 'social', media: 'social', seo: 'social', marketing: 'social', 'السوشال': 'social', 'السوشيال': 'social', 'المحتوى': 'social',
  legal: 'legal', compliance: 'legal', law: 'legal', 'الليغال': 'legal', 'الليجال': 'legal', 'القانوني': 'legal', 'القانونية': 'legal',
};

// Resolves a slug, key or nickname. Retired slugs resolve to themselves (for
// history); retired keys and nicknames resolve to the successor.
export function officeAgent(slugOrKey) {
  const value = String(slugOrKey || '').toLowerCase().trim();
  if (BY_SLUG.has(value)) return BY_SLUG.get(value);
  const key = ALIASES[value] || value;
  const agent = BY_KEY.get(key);
  return agent?.retired ? BY_KEY.get(agent.mergedInto) : agent || null;
}

// Employees Fahad names in a message ("حولها للفاینانس", "let LEGAL review"):
// Arabic words may carry the prefixes و/ف/ب/ل/لل/ك attached to ال.
export function mentionedEmployees(message) {
  const found = new Set();
  for (const token of String(message || '').split(/[^\p{L}\p{N}_-]+/u)) {
    // English names count only in capitals, as the roster writes them
    // ("ask LEGAL"), so ordinary words like "research" are not dispatches.
    if (!token || (/^[a-z]/i.test(token) && token !== token.toUpperCase())) continue;
    const raw = token.toLowerCase();
    const candidates = [raw, raw.replace(/^[وف]/, ''), raw.replace(/^[وف]?(?:لل|بال|كال|فال|وال)/, 'ال')];
    for (const word of candidates) {
      const key = ALIASES[word];
      if (!key) continue;
      const agent = BY_KEY.get(key);
      if (agent && !agent.retired) { found.add(agent.key); break; }
    }
  }
  return [...found];
}

// Employees the Chief can dispatch in a workflow (not itself, never retired).
export const DISPATCHABLE = Object.freeze(ACTIVE_AGENTS.filter((agent) => agent.executor !== 'chief').map((agent) => agent.key));

export const NICKNAMES = Object.freeze(Object.fromEntries(ACTIVE_AGENTS.map((agent) => [agent.key,
  Object.entries(ALIASES).filter(([word, key]) => key === agent.key && /[؀-ۿ]/.test(word)).map(([word]) => word)])));

// The contract every specialist output follows, so the Chief (and the next
// employee) can consume it programmatically.
export const OUTPUT_CONTRACT = [
  'Return Markdown with exactly these sections:',
  '## Summary — two or three sentences a busy founder can act on.',
  '## Work — the deliverable itself, complete and specific.',
  '## Handoff — what the Chief or the next employee must know or do next.',
  '## Decisions for Fahad — only decisions that genuinely need the owner (or "None").',
  'Add ## Sources with links when you used the web. Never invent facts, figures or sources; label estimates as estimates.',
];

// Parses the sections of a specialist output (tolerant of missing ones).
export function parseOutput(markdown) {
  const text = String(markdown || '').replace(/```artifact[\s\S]*?```/g, '');
  const section = (name) => {
    const match = text.match(new RegExp(`^##\\s*${name}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'mi'));
    return match ? match[1].trim() : '';
  };
  const decisions = section('Decisions for Fahad');
  const plain = (value) => String(value || '').replace(/\*\*|__|`/g, '').trim();
  return {
    summary: plain(section('Summary') || text.split('\n').find((line) => line.trim() && !line.startsWith('#'))?.trim() || ''),
    handoff: section('Handoff'),
    decisions: /^(none|n\/a|-|no decisions?)\.?$/i.test(decisions) ? '' : decisions,
  };
}
