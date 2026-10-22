// Fahad AI Office — premium redesign: pure presentation rules.
//
// Everything here maps REAL backend values (job status, derived lifecycle,
// workflow task nodes, Office employee states) to what the Office shows.
// Nothing invents a number: a fraction is shown only when the task graph
// has delivery units, a phase only when the graph says so, and unknown stays
// unknown. No DOM access, so these rules are unit-tested in Node.

export const TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);
export const OPEN_STATUSES = Object.freeze(['planning', 'running', 'waiting_approval', 'blocked', 'review']);

// --------------------------------------------------------------- employees
// UI-only identity tints keyed by agent slug (tokens --emp-* in app.css).
// The database accent_color is never read or changed for this.
const EMPLOYEE_TINT = Object.freeze({
  'chief-of-staff': 'chief', 'research-strategy': 'research', 'product-tech': 'product', 'business-finance': 'finance',
  'coding-agent': 'coding', 'qa-security': 'audit', 'content-media': 'social', 'brand-creative': 'creative', 'legal-compliance': 'legal',
});
export function employeeTint(slug) {
  return EMPLOYEE_TINT[slug] || 'neutral';
}
export function employeeColor(slug) {
  return `var(--emp-${employeeTint(slug)})`;
}

// Arabic display names are the Office's own Arabic nicknames for each role
// (src/office/agents.js ALIASES); taglines mirror the roster migration
// (supabase/migrations/20260929090000_office_final_roster.sql). Copy only:
// identities, prompts and roles are unchanged.
const EMPLOYEE_COPY = Object.freeze({
  'chief-of-staff': { ar: 'الرئيس', tagline: 'Understand · Delegate · Deliver' },
  'research-strategy': { ar: 'البحث', tagline: 'Search · Validate · Compare' },
  'product-tech': { ar: 'المنتج', tagline: 'Define · Scope · Prioritize' },
  'business-finance': { ar: 'المالية', tagline: 'Cost · Price · Plan' },
  'coding-agent': { ar: 'البرمجة', tagline: 'Build · Test · Ship' },
  'qa-security': { ar: 'التدقيق', tagline: 'Quality · Security · Completeness' },
  'content-media': { ar: 'المحتوى', tagline: 'Trends · Content · Campaigns' },
  'brand-creative': { ar: 'الإبداع', tagline: 'Identity · Visuals · Direction' },
  'legal-compliance': { ar: 'القانونية', tagline: 'Comply · Review · Protect' },
});
export function employeeCopy(slug) {
  return EMPLOYEE_COPY[slug] || { ar: null, tagline: null };
}

// One honest state per employee from the Office's own derived state
// (src/hub-office.js officeState). Idle is "available", never "working".
const EMPLOYEE_STATE = Object.freeze({
  coordinating: ['ينسّق', 'Coordinating'],
  working: ['يعمل', 'Working'],
  delivered: ['سلّم', 'Delivered'],
  waiting: ['بانتظار', 'Waiting'],
  needs: ['يحتاجك', 'Needs you'],
  blocked: ['متوقف', 'Blocked'],
  available: ['متاح', 'Available'],
});
const ACTIVE = new Set(['THINKING', 'WORKING', 'TESTING', 'REVIEWING']);
export function employeeState(agent = {}, language = 'ar') {
  const raw = String(agent.state || 'AVAILABLE');
  let key = 'available';
  if (ACTIVE.has(raw)) key = agent.slug === 'chief-of-staff' || agent.executor === 'chief' ? 'coordinating' : 'working';
  else if (raw === 'COMPLETED') key = 'delivered';
  else if (raw === 'WAITING' || raw === 'QUEUED') key = 'waiting';
  else if (raw === 'NEEDS FAHAD') key = 'needs';
  else if (raw === 'BLOCKED' || raw === 'FAILED') key = 'blocked';
  return { key, raw, label: EMPLOYEE_STATE[key][language === 'en' ? 1 : 0], busy: key === 'coordinating' || key === 'working' };
}

// --------------------------------------------------------------- objectives
// Status for a job: the derived lifecycle (/api/work) wins when present;
// the stored status is the fallback. Unknown statuses stay visible as-is.
const JOB_STATUS = Object.freeze({
  planning: ['يخطط', 'Planning', 'live'],
  running: ['قيد العمل', 'In progress', 'live'],
  review: ['قيد المراجعة', 'In review', 'live'],
  waiting: ['بانتظار', 'Waiting', 'wait'],
  needs: ['بانتظار قرارك', 'Needs your decision', 'alert'],
  completed: ['مكتملة', 'Completed', 'done'],
  failed: ['فشلت', 'Failed', 'error'],
  cancelled: ['ملغاة', 'Cancelled', 'muted'],
});
export function jobStatus({ status, lifecycle } = {}, language = 'ar') {
  let key = null;
  if (lifecycle === 'NEEDS_OWNER') key = 'needs';
  else if (lifecycle === 'WAITING') key = 'waiting';
  else if (lifecycle === 'COMPLETED') key = 'completed';
  else if (lifecycle === 'FAILED') key = 'failed';
  else if (lifecycle === 'CANCELLED') key = 'cancelled';
  else if (status === 'waiting_approval') key = 'needs';
  else if (status === 'blocked') key = 'needs';
  else if (JOB_STATUS[status]) key = status;
  else if (lifecycle === 'ACTIVE') key = 'running';
  if (!key) return { key: 'unknown', label: String(status || (language === 'en' ? 'Unknown' : 'غير معروف')), tone: 'muted', terminal: false };
  const [ar, en, tone] = JOB_STATUS[key];
  return { key, label: language === 'en' ? en : ar, tone, terminal: ['completed', 'failed', 'cancelled'].includes(key) };
}
export function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

// Delivery progress from the real task graph (/api/workflows/:id nodes).
// A unit is one employee assignment (workstream or development). A revision
// that is still open makes its employee's unit "in revision", not delivered.
// Skipped tasks report state "done" upstream and count as delivered.
const UNIT_KINDS = new Set(['workstream', 'development']);
export function deliveryProgress(nodes = [], { final = null, jobStatus: status = null } = {}) {
  const units = nodes.filter((node) => UNIT_KINDS.has(node.kind) && !node.revision);
  const revisions = nodes.filter((node) => UNIT_KINDS.has(node.kind) && node.revision);
  const plan = nodes.filter((node) => node.kind === 'plan');
  const synthesis = nodes.filter((node) => node.kind === 'synthesis');
  const openRevision = (unit) => revisions.some((revision) => revision.agentSlug === unit.agentSlug && revision.state !== 'done' && revision.state !== 'failed');
  const counts = { total: units.length, delivered: 0, working: 0, waiting: 0, capacity: 0, failed: 0, blocked: 0, revising: 0 };
  for (const unit of units) {
    if (openRevision(unit)) counts.revising += 1;
    else if (unit.state === 'done') counts.delivered += 1;
    else if (unit.state === 'working') counts.working += 1;
    else if (unit.state === 'capacity') counts.capacity += 1;
    else if (unit.state === 'failed') counts.failed += 1;
    else if (unit.state === 'blocked') counts.blocked += 1;
    else counts.waiting += 1;
  }
  const synthesisState = synthesis.some((node) => node.state === 'working') ? 'working'
    : synthesis.some((node) => node.state === 'done') ? 'done'
      : synthesis.length ? 'pending' : 'none';
  let phase;
  if (final) phase = 'done';
  else if (TERMINAL_STATUSES.includes(status)) phase = status;
  else if (!units.length) phase = plan.some((node) => node.state === 'done') || status === 'running' ? 'chief' : 'planning';
  else if (synthesisState === 'working') phase = 'synthesizing';
  else if (counts.delivered === counts.total) phase = 'awaiting_synthesis';
  else phase = 'delivering';
  return { ...counts, fraction: units.length > 0, synthesis: synthesisState, phase };
}

const PHASE_WORDS = Object.freeze({
  planning: ['CHIEF يخطط للمهمة ويحدد الفريق', 'CHIEF is planning and choosing the team'],
  chief: ['CHIEF يعمل على المهمة مباشرة', 'CHIEF is handling this directly'],
  delivering: ['الفريق يعمل على المخرجات', 'The team is working on the deliverables'],
  awaiting_synthesis: ['سلّم الفريق، وCHIEF على وشك جمع النتائج', 'The team delivered; CHIEF is about to consolidate'],
  synthesizing: ['CHIEF يجمع النتائج في تقرير نهائي', 'CHIEF is consolidating the final report'],
  done: ['اكتمل التقرير النهائي', 'The final report is ready'],
  completed: ['اكتملت المهمة', 'Completed'],
  failed: ['توقفت المهمة قبل اكتمالها', 'Stopped before it finished'],
  cancelled: ['أُلغيت المهمة', 'Cancelled'],
});
export function phaseWords(phase, language = 'ar') {
  const entry = PHASE_WORDS[phase];
  return entry ? entry[language === 'en' ? 1 : 0] : '';
}

// Bar width only when it is a real fraction of delivered units.
export function fractionWidth(progress) {
  if (!progress?.fraction || !progress.total) return null;
  return Math.round((progress.delivered / progress.total) * 100);
}

// Group a job's nodes by employee for the deliverables tabs (plan and
// synthesis belong to CHIEF's own sections, not a team tab).
export function employeeTabs(nodes = []) {
  const tabs = new Map();
  for (const node of nodes) {
    if (node.kind === 'plan' || node.kind === 'synthesis') continue;
    const slug = node.agentSlug || node.agent || 'unknown';
    if (!tabs.has(slug)) tabs.set(slug, { slug, label: node.agentLabel || slug, nodes: [] });
    tabs.get(slug).nodes.push(node);
  }
  return [...tabs.values()].map((tab) => {
    const latest = tab.nodes.at(-1);
    const delivered = tab.nodes.every((node) => node.state === 'done');
    const failed = tab.nodes.some((node) => node.state === 'failed' || node.state === 'blocked') && !delivered;
    const working = tab.nodes.some((node) => node.state === 'working');
    return { ...tab, delivered, failed, working, state: delivered ? 'done' : failed ? 'failed' : working ? 'working' : latest?.state || 'waiting' };
  });
}

const NODE_STATE = Object.freeze({
  done: ['سلّم', 'Delivered'], working: ['يعمل', 'Working'], waiting: ['بانتظار مخرجات سابقة', 'Waiting for earlier work'],
  ready: ['جاهز للبدء', 'Ready to start'], capacity: ['بانتظار سعة نموذج مجانية — يكمل تلقائيًا', 'Waiting for free model capacity — resumes automatically'],
  failed: ['تعثّر', 'Failed'], blocked: ['متوقف', 'Blocked'],
});
export function nodeStateLabel(state, language = 'ar') {
  const entry = NODE_STATE[state];
  return entry ? entry[language === 'en' ? 1 : 0] : String(state || '');
}

// --------------------------------------------------------------- greeting
export function greeting(hour, language = 'ar') {
  const h = Number.isFinite(hour) ? hour : 12;
  if (language === 'en') return h >= 5 && h < 12 ? 'Good morning, Fahad' : h >= 12 && h < 18 ? 'Good afternoon, Fahad' : 'Good evening, Fahad';
  return h >= 5 && h < 12 ? 'صباح الخير، فهد' : 'مساء الخير، فهد';
}

// --------------------------------------------------------------- archive
// Client-side filters over rows the history API already returned. The
// server applies status and text search; date and employee narrow further.
export function archiveFilter(items = [], { from = '', to = '', employee = '', includeTests = false } = {}) {
  const start = from ? Date.parse(`${from}T00:00:00`) : null;
  const end = to ? Date.parse(`${to}T23:59:59.999`) : null;
  return items.filter((item) => {
    if (!includeTests && item.classification?.class === 'TEST') return false;
    const at = Date.parse(item.closedAt || item.openedAt || '');
    if (start != null && !(at >= start)) return false;
    if (end != null && !(at <= end)) return false;
    if (employee && !(item.participants || []).some((person) => person.slug === employee)) return false;
    return true;
  });
}

// The nine active roster entries (src/office/agents.js), in roster order.
export const ROSTER = Object.freeze([
  ['chief-of-staff', 'CHIEF'], ['research-strategy', 'RESEARCH'], ['brand-creative', 'CREATIVE'], ['product-tech', 'PRODUCT'], ['business-finance', 'FINANCE'],
  ['coding-agent', 'CODING'], ['qa-security', 'AUDIT'], ['content-media', 'SOCIAL'], ['legal-compliance', 'LEGAL'],
].map(([slug, label]) => Object.freeze({ slug, label })));

// Arabic count phrases ("طلب واحد", "طلبان", "3 طلبات", "11 طلبًا").
export function arabicCount(n, [one, two, few, many]) {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return `${n} ${few}`;
  return `${n} ${many}`;
}

// Numeric date for mono presentation: "2026-10-22 14:05" (local time).
export function numericDate(value, { time = true } = {}) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return time ? `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}` : day;
}

// Output type badges: an employee's structured artifacts, else a report.
const OUTPUT_TYPE = Object.freeze({
  table: 'TABLE', checklist: 'CHECKLIST', kanban: 'BOARD', moodboard: 'MOODBOARD', diagram: 'DIAGRAM', code: 'CODE', file: 'FILE', prd: 'PRD',
  financial_model: 'FINANCIAL MODEL', compliance_matrix: 'COMPLIANCE', audit_report: 'AUDIT', content_calendar: 'CALENDAR', evidence: 'EVIDENCE',
  risk_matrix: 'RISKS', timeline: 'TIMELINE', chart: 'CHART', report: 'REPORT',
});
export function outputTypes(artifacts = []) {
  const types = [...new Set(artifacts.map((artifact) => OUTPUT_TYPE[artifact.type] || String(artifact.type || 'OTHER').replace(/_/g, ' ').toUpperCase()))];
  return types.length ? types : ['REPORT'];
}
