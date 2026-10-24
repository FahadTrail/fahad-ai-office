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
// A stored "blocked" alone is not owner attention: the backend classifies it
// as WAITING unless a real approval or question exists (domain/lifecycle.js),
// so only NEEDS_OWNER or waiting_approval reads "Needs your decision".
const JOB_STATUS = Object.freeze({
  planning: ['يخطط', 'Planning', 'live'],
  running: ['قيد العمل', 'In progress', 'live'],
  review: ['قيد المراجعة', 'In review', 'live'],
  waiting: ['بانتظار', 'Waiting', 'wait'],
  blocked: ['متوقف', 'Blocked', 'wait'],
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
  else if (status === 'blocked') key = 'blocked';
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
// A unit is one assignment (a workstream or development task), so an
// employee with two assignments counts twice and X/Y reads "assignments",
// never "employees". A revision replaces the state of the assignment it
// revises: the workflow makes every revision depend on its original task
// (workflow.js requestRevisions), so the link is the revision's dependsOn.
// Open revision → in revision; failed revision → failed; done → delivered.
// Skipped tasks report state "done" upstream and count as delivered.
const UNIT_KINDS = new Set(['workstream', 'development']);
const FAILED_STATES = new Set(['failed', 'blocked']);
export function deliveryProgress(nodes = [], { final = null, jobStatus: status = null } = {}) {
  const units = nodes.filter((node) => UNIT_KINDS.has(node.kind) && !node.revision);
  const revisions = nodes.filter((node) => UNIT_KINDS.has(node.kind) && node.revision);
  const plan = nodes.filter((node) => node.kind === 'plan');
  const synthesis = nodes.filter((node) => node.kind === 'synthesis');
  const byId = new Map(units.filter((unit) => unit.id).map((unit) => [unit.id, unit]));
  const revisionOf = new Map();
  let untracked = 0;
  for (const revision of revisions) {
    let target = byId.get((revision.dependsOn || []).find((id) => byId.has(id)));
    // Rows without the dependency link: attach only when the employee has
    // exactly one assignment, otherwise the revision cannot be placed.
    if (!target) {
      const same = units.filter((unit) => unit.agentSlug && unit.agentSlug === revision.agentSlug);
      target = same.length === 1 ? same[0] : null;
    }
    if (target) revisionOf.set(target, revision); // nodes arrive in sequence order: the latest revision wins
    else untracked += 1;
  }
  const counts = { total: units.length, delivered: 0, working: 0, waiting: 0, capacity: 0, failed: 0, blocked: 0, revising: 0, untrackedRevisions: untracked };
  for (const unit of units) {
    const revision = revisionOf.get(unit);
    if (revision && FAILED_STATES.has(revision.state)) counts.failed += 1;
    else if (revision && revision.state !== 'done') counts.revising += 1;
    else if (revision || unit.state === 'done') counts.delivered += 1;
    else if (unit.state === 'working') counts.working += 1;
    else if (unit.state === 'capacity') counts.capacity += 1;
    else if (unit.state === 'failed') counts.failed += 1;
    else if (unit.state === 'blocked') counts.blocked += 1;
    else counts.waiting += 1;
  }
  const synthesisState = synthesis.some((node) => node.state === 'working') ? 'working'
    : synthesis.length && synthesis.every((node) => node.state === 'done') ? 'done'
      : synthesis.length ? 'pending' : 'none';
  let phase;
  if (final) phase = 'done';
  else if (TERMINAL_STATUSES.includes(status)) phase = status;
  else if (!units.length) phase = plan.some((node) => node.state === 'done') || status === 'running' ? 'chief' : 'planning';
  else if (synthesisState === 'working') phase = 'synthesizing';
  else if (counts.revising) phase = 'revising';
  else if (counts.delivered === counts.total) phase = 'awaiting_synthesis';
  else phase = 'delivering';
  return { ...counts, fraction: units.length > 0, synthesis: synthesisState, phase };
}

// "3/8" always means delivered assignments out of assigned assignments.
export function fractionLabel(progress, language = 'ar') {
  if (!progress?.fraction) return '';
  return language === 'en' ? `${progress.delivered} of ${progress.total} assignments delivered` : `سُلّم ${progress.delivered} من ${progress.total} تكليفات`;
}

const PHASE_WORDS = Object.freeze({
  planning: ['CHIEF يخطط للمهمة ويحدد الفريق', 'CHIEF is planning and choosing the team'],
  chief: ['CHIEF يعمل على المهمة مباشرة', 'CHIEF is handling this directly'],
  delivering: ['الفريق يعمل على المخرجات', 'The team is working on the deliverables'],
  revising: ['الفريق يعدّل بطلب من CHIEF', 'The team is revising at CHIEF’s request'],
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

// A bounded, presentation-only view of the REAL workflow graph. Edges are
// emitted only for explicit dependsOn ids returned by /api/workflows/:id; the
// UI never guesses a connection. The cap keeps a pathological workflow from
// creating an unbounded DOM/SVG surface. Execution details still lists every
// node when the visual map is capped.
export function workflowMap(nodes = [], { maxNodes = 24 } = {}) {
  const source = nodes.filter((node) => node?.id).map((node) => ({
    id: String(node.id), title: String(node.title || ''), kind: String(node.kind || 'task'), state: String(node.state || 'waiting'),
    agentSlug: node.agentSlug || null, agentLabel: String(node.agentLabel || node.agent || ''), revision: Boolean(node.revision),
    dependsOn: Array.isArray(node.dependsOn) ? node.dependsOn.map(String) : [],
  }));
  const ids = new Set(source.map((node) => node.id));
  for (const node of source) node.dependsOn = node.dependsOn.filter((id) => ids.has(id) && id !== node.id);
  const byId = new Map(source.map((node) => [node.id, node]));
  const levels = new Map();
  const levelOf = (node, visiting = new Set()) => {
    if (levels.has(node.id)) return levels.get(node.id);
    if (visiting.has(node.id)) return 0;
    const next = new Set(visiting); next.add(node.id);
    const dependencies = node.dependsOn.map((id) => byId.get(id)).filter(Boolean);
    const level = dependencies.length ? 1 + Math.max(...dependencies.map((dependency) => levelOf(dependency, next))) : 0;
    levels.set(node.id, level);
    return level;
  };
  for (const node of source) levelOf(node);
  const visible = source.slice(0, Math.max(1, maxNodes));
  const visibleIds = new Set(visible.map((node) => node.id));
  const rows = new Map();
  const laidOut = visible.map((node) => {
    const level = levels.get(node.id) || 0;
    const row = rows.get(level) || 0;
    rows.set(level, row + 1);
    return { ...node, level, row };
  });
  const edges = laidOut.flatMap((node) => node.dependsOn.filter((id) => visibleIds.has(id)).map((from) => ({ from, to: node.id, active: node.state === 'working' })));
  return {
    nodes: laidOut, edges, hidden: Math.max(0, source.length - laidOut.length),
    columns: laidOut.length ? Math.max(...laidOut.map((node) => node.level)) + 1 : 0,
    rows: rows.size ? Math.max(...rows.values()) : 0,
  };
}

// Concise charts use assignment nodes only, matching the delivery fraction.
// No percentages are returned for an empty graph and unknown states remain in
// the visible "waiting" bucket instead of being silently discarded.
export function workflowMetrics(nodes = [], handoffs = []) {
  const assignments = nodes.filter((node) => UNIT_KINDS.has(node.kind));
  const statuses = { done: 0, working: 0, waiting: 0, capacity: 0, failed: 0 };
  const employees = new Map();
  for (const node of assignments) {
    const key = node.state === 'done' ? 'done' : node.state === 'working' ? 'working' : node.state === 'capacity' ? 'capacity' : FAILED_STATES.has(node.state) ? 'failed' : 'waiting';
    statuses[key] += 1;
    const slug = node.agentSlug || node.agent || 'unknown';
    const entry = employees.get(slug) || { slug, label: node.agentLabel || node.agent || slug, total: 0, done: 0 };
    entry.total += 1;
    if (key === 'done') entry.done += 1;
    employees.set(slug, entry);
  }
  return {
    total: assignments.length, statuses,
    employees: [...employees.values()],
    handoffs: Array.isArray(handoffs) ? handoffs.length : 0,
  };
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

// --------------------------------------------------------------- refresh
// One refresh at a time: a trigger during a running load queues exactly one
// follow-up instead of a parallel request. Nothing loads while the tab is
// hidden; the first visible moment catches up once. The safety poll is slow
// while the live stream is connected and faster only when it is not.
export function createRefresher(run, { hidden = () => false, now = () => Date.now(), connectedEvery = 120_000, disconnectedEvery = 30_000 } = {}) {
  let inflight = null;
  let again = false;
  let connected = false;
  let stale = false;
  let last = 0;
  let stopped = false;
  const trigger = () => {
    if (stopped) return Promise.resolve();
    if (hidden()) { stale = true; return Promise.resolve(); }
    if (inflight) { again = true; return inflight; }
    inflight = Promise.resolve().then(run).catch(() => {}).finally(() => {
      last = now();
      inflight = null;
      if (again) { again = false; trigger(); }
    });
    return inflight;
  };
  return {
    trigger,
    tick: () => (now() - last >= (connected ? connectedEvery : disconnectedEvery) ? trigger() : Promise.resolve()),
    setConnected: (value) => { connected = Boolean(value); },
    visible: () => { if (!stale) return Promise.resolve(); stale = false; return trigger(); },
    stop: () => { stopped = true; },
  };
}

// What a workflow graph can change for an Office card. The task graph is
// refetched only for an objective whose summary moved (status, lifecycle,
// counts, steps, current assignments, revision round or final result).
export function objectiveSignature(objective = {}) {
  const orchestration = objective.orchestration || {};
  return JSON.stringify([
    objective.status, objective.lifecycle, objective.counts || null, objective.finalDeliverableId || null, orchestration.revisionRound || 0,
    (orchestration.steps || []).map((step) => step.state),
    (orchestration.currentAssignments || []).map((row) => [row.taskId, row.posture]),
  ]);
}

// Coding session cards outside an objective: only a real approval or
// question is "needs you". A plain blocked session may be a capacity wait.
const CODING_PHASE = Object.freeze({
  understand: ['يفهم المهمة', 'Understanding'], plan: ['يخطط', 'Planning'], implement: ['يعدّل الكود', 'Editing code'], test: ['يشغّل الاختبارات', 'Running tests'],
  debug: ['يصلح الأخطاء', 'Debugging'], review: ['يراجع', 'Reviewing'], publish: ['يفتح طلب الدمج', 'Opening the pull request'], ci: ['ينتظر CI', 'Waiting for CI'],
  deploy: ['ينشر', 'Deploying'], verify: ['يتحقق', 'Verifying'], report: ['يكتب التقرير', 'Writing the report'],
});
export function codingSessionState(session = {}, attentionItems = [], language = 'ar') {
  const owner = attentionItems.find((item) => item.taskId === session.id && (item.kind === 'approval' || item.kind === 'question'));
  const needs = Boolean(owner) || session.status === 'awaiting_approval';
  const row = needs ? { lifecycle: 'NEEDS_OWNER' } : session.status === 'blocked' ? { status: 'blocked' } : session.status === 'queued' ? { lifecycle: 'WAITING' } : { status: 'running' };
  const phase = CODING_PHASE[session.phase];
  return { needs, status: row, phase: phase ? phase[language === 'en' ? 1 : 0] : null };
}
