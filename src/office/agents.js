// The Office roster: who works here, what each employee is for, and how the
// shared Model Pool routes their work (by job type — never a fixed model).
//
// Identities live in public.agents (slug, name, system prompt, allowed tools);
// this module adds the executable contract the workflow needs. An employee
// is executable when `executor` is set:
//   'office'  — runs as a task in the Office task graph (tasks.depends_on)
//   'coding'  — the Fahad Coding Agent (separate engineering workflow)
//   'chief'   — the Chief of Staff (plans, dispatches, synthesizes)

export const OFFICE_AGENTS = Object.freeze([
  {
    slug: 'chief-of-staff', key: 'chief', label: 'Chief of Staff', executor: 'chief', job: 'orchestration', webTools: false,
    scope: 'Your entry point. Understands the objective, splits it into workstreams, dispatches the right employees, follows up and consolidates the result.',
    deliverable: 'Executive synthesis', directChat: true,
  },
  {
    slug: 'research-strategy', key: 'research', label: 'Research', executor: 'office', job: 'research', webTools: true,
    scope: 'Market research, competitors, facts and evidence with sources.', deliverable: 'Research report', directChat: true,
  },
  {
    slug: 'business-strategy', key: 'strategy', label: 'Business Strategy', executor: 'office', job: 'research', webTools: true,
    scope: 'Business model, target segments, product strategy, MVP scope and go-to-market.', deliverable: 'Business strategy', directChat: true,
  },
  {
    slug: 'business-finance', key: 'finance', label: 'Finance', executor: 'office', job: 'finance', webTools: true,
    scope: 'Costs, pricing, unit economics, budgets and scenarios. Analysis only — never moves money.', deliverable: 'Financial model', directChat: true,
  },
  {
    slug: 'brand-creative', key: 'brand', label: 'Brand & Creative', executor: 'office', job: 'branding', webTools: false,
    scope: 'Naming, positioning, tone of voice, messaging and visual direction.', deliverable: 'Brand strategy & creative brief', directChat: true,
  },
  {
    slug: 'content-media', key: 'content', label: 'Content & Media', executor: 'office', job: 'content', webTools: true,
    scope: 'Launch copy, website text, social posts, emails, content calendars and SEO briefs (drafts only).', deliverable: 'Content drafts', directChat: true,
  },
  {
    slug: 'product-tech', key: 'product', label: 'Product & Tech', executor: 'office', job: 'research', webTools: true,
    scope: 'Technical requirements, architecture options and build plans in writing. Code changes go to the Coding Agent.', deliverable: 'Technical plan', directChat: true,
  },
  {
    slug: 'operations', key: 'operations', label: 'Operations', executor: 'office', job: 'content', webTools: false,
    scope: 'Launch checklists, timelines, processes and follow-ups.', deliverable: 'Operations plan', directChat: true,
  },
  {
    slug: 'qa-security', key: 'review', label: 'QA & Review', executor: 'office', job: 'orchestration', webTools: false,
    scope: 'Reviews other employees’ work for accuracy, gaps, risks and consistency before it reaches you.', deliverable: 'Review notes', directChat: true,
  },
  {
    slug: 'coding-agent', key: 'coding', label: 'Coding Agent', executor: 'coding', job: 'coding', webTools: false,
    scope: 'Engineering execution: plan, edit, test, debug, pull request, CI, approval, deploy and verify.', deliverable: 'Implementation, PR and test results', directChat: false,
  },
].map((agent) => Object.freeze(agent)));

const BY_SLUG = new Map(OFFICE_AGENTS.map((agent) => [agent.slug, agent]));
const BY_KEY = new Map(OFFICE_AGENTS.map((agent) => [agent.key, agent]));
// Words the Chief (or an older plan) may use for an employee.
const ALIASES = { research: 'research', market: 'research', business: 'strategy', strategy: 'strategy', finance: 'finance', financial: 'finance',
  brand: 'brand', branding: 'brand', creative: 'brand', content: 'content', media: 'content', seo: 'content', marketing: 'content',
  product: 'product', tech: 'product', technical: 'product', operations: 'operations', ops: 'operations', review: 'review', qa: 'review',
  coding: 'coding', development: 'coding', developer: 'coding', engineering: 'coding', chief: 'chief' };

export function officeAgent(slugOrKey) {
  const value = String(slugOrKey || '').toLowerCase().trim();
  return BY_SLUG.get(value) || BY_KEY.get(value) || BY_KEY.get(ALIASES[value]) || null;
}

// Employees the Chief can dispatch in a workflow (not itself).
export const DISPATCHABLE = Object.freeze(OFFICE_AGENTS.filter((agent) => agent.executor !== 'chief').map((agent) => agent.key));

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
  const text = String(markdown || '');
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
