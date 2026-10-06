// Project Deliverables Center (V5.3): every output of one project on one calm,
// visual board — what is ready, what is coming, what needs Fahad. Loaded on
// demand inside the project view. Data comes from /api/deliverables (real
// rows only). Decisions reuse the existing approval, reply, resume and
// conversation endpoints; pin, archive and approve use
// /api/deliverables/review and say so honestly when it is not available yet.
import { roleMark } from './characters.js?v=__UI_VERSION__';
import { ARTIFACT_LABELS, artifactPreview } from './artifacts.js';
import { escapeHtml as esc, renderMarkdown } from './markdown.js';
import { download, fileName, moodboardPng, printArtifact, svgToPng, toCsv, toMarkdown } from './export.js?v=__UI_VERSION__';

export const STATUS_ORDER = Object.freeze(['needs_fahad', 'blocked', 'needs_review', 'in_progress', 'waiting', 'ready']);
// Smart order: what needs Fahad, then what is new and ready, then what is
// moving, then what waits.
const SMART_RANK = { needs_fahad: 0, blocked: 1, needs_review: 1, ready: 2, in_progress: 3, waiting: 4 };
const ROSTER = ['chief', 'research', 'creative', 'product', 'finance', 'coding', 'audit', 'social', 'legal'];
const PREFS_KEY = 'hub-deliverables-view';

const AR_TYPES = {
  table: 'جدول', chart: 'رسم بياني', timeline: 'خطة زمنية', checklist: 'قائمة تحقق', kanban: 'لوحة مهام', flow: 'مسار', moodboard: 'لوحة الهوية',
  financial_model: 'نموذج مالي', compliance_matrix: 'مصفوفة الامتثال', audit_report: 'تقرير المراجعة', content_calendar: 'تقويم المحتوى', evidence: 'أدلة',
  risk_matrix: 'مصفوفة المخاطر', report: 'تقرير', synthesis: 'الملخص التنفيذي', code: 'تغيير برمجي',
};
const EN_TYPES = { ...ARTIFACT_LABELS, report: 'Report', synthesis: 'Executive summary', code: 'Code change' };

const COPY = {
  en: {
    tab: 'Deliverables', statusFilter: 'Filter by status', deliverables: (n) => `${n} deliverable${n === 1 ? '' : 's'}`, readyOf: (r, n) => `${r} of ${n} ready`, updated: (w) => `updated ${w}`,
    chief: 'CHIEF · latest summary', noChief: 'When CHIEF finishes an objective, its summary appears here.', askChief: 'Ask CHIEF', newCoding: 'New CODING task', allFiles: 'All files & exports',
    all: 'All', status: { needs_fahad: 'Needs you', blocked: 'Blocked', needs_review: 'Needs review', in_progress: 'In progress', waiting: 'Waiting', ready: 'Ready' },
    search: 'Search deliverables…', allEmployees: 'All employees', allTypes: 'All types', filters: 'Filters', anyTime: 'Any time', d1: 'Last 24 hours', d7: 'Last 7 days', d30: 'Last 30 days',
    anyPriority: 'Any priority', pinned: 'Pinned', high: 'High & urgent', normal: 'Normal', low: 'Low', allObjectives: 'All objectives', noObjective: 'No objective',
    showArchived: 'Show archived', reset: 'Reset filters', sortLabel: 'Sort', groupLabel: 'Group',
    sort: { smart: 'Smart order', newest: 'Newest', oldest: 'Oldest', employee: 'Employee', status: 'Status', type: 'Type', title: 'Title' },
    view: { grid: 'Board', list: 'List', grouped: 'Grouped' }, viewLabel: 'View',
    group: { employee: 'By employee', status: 'By status', objective: 'By objective', type: 'By type' },
    showing: (s, n) => `Showing ${s} of ${n}`, archivedCount: (n) => `${n} archived`,
    objectivesShown: (s, n) => (n == null ? `Objectives shown: ${s}` : `Objectives shown: ${s} of ${n}`), loadOlder: 'Load older deliverables', loadingOlder: 'Loading older deliverables…', olderFailed: 'Older deliverables could not be loaded. Try again.',
    emptyTitle: 'No deliverables yet', emptyText: 'Ask CHIEF for a plan, a budget, a brand direction or a review. Every output the team produces lands here.',
    noMatch: 'Nothing matches these filters.', noRecent: 'No deliverables in the objectives loaded so far.', loading: 'Loading the project’s deliverables…', loadFailed: 'Deliverables could not be loaded.',
    open: 'Open', for: 'For', delivered: (w) => `Delivered ${w}`, updatedAt: (w) => `Updated ${w}`, version: (a, b) => `Version ${a} of ${b}`, versionShort: (a) => `v${a}`,
    updating: (v) => `Updating — version ${v} is in progress`, earlier: 'You are viewing an earlier version.', latestVersion: 'Back to the latest version',
    yourDecision: 'Your decision', approve: 'Approve', approved: 'Approved', undo: 'Undo', requestRevision: 'Request revision', continueChief: 'Continue with CHIEF',
    pin: 'Pin', unpin: 'Unpin', archive: 'Archive', restore: 'Restore', confirmApprove: 'Confirm approval', cancel: 'Cancel', send: (who) => `Send to ${who}`,
    approveTitle: 'Approve this deliverable?', saveDecision: 'Also save the decision to project memory, so CHIEF and the team use it', noteOptional: 'Note (optional)',
    revisionTitle: 'What should change?', revisionHint: (who) => `${who} receives your note and the current summary in a direct conversation.`,
    revisionSent: (who) => `Revision request sent to ${who}`, approvedToast: 'Approved', pinnedToast: 'Pinned', unpinnedToast: 'Unpinned', archivedToast: 'Archived', restoredToast: 'Restored',
    reviewsOff: 'Pin, archive and approval become available after the V5.3 database update is applied. Everything else here works.',
    summary: 'Summary', visuals: 'Visual outputs', report: 'Full report', noReport: 'This deliverable has no written report.', loadingReport: 'Loading the full output…',
    versions: 'Versions', revision: 'revision', details: 'Details', openWorkflow: 'Open the objective', openChat: 'Open the conversation', openTask: 'Open the coding task',
    coding: { prLabel: 'Pull request', pr: (n) => `Pull request #${n}`, ciLabel: 'CI', tests: 'Tests', deploy: 'Deployment', files: (n) => `Files changed (${n})`, passing: 'Passing', failing: 'Failing', none: '—', branch: 'Branch', ci: { success: 'passed', failure: 'failed', pending: 'running' }, risk: { low: 'LOW', medium: 'MEDIUM', high: 'HIGH', critical: 'CRITICAL' } },
    approveMerge: 'Approve', reject: 'Reject', answer: 'Your answer', reply: 'Reply & continue', resume: 'Continue', messageCoding: 'Message CODING (optional)', replySent: 'Sent — CODING continues the same task',
    pendingNote: (who) => `No decision needed yet — ${who} is still working on it.`, waitingNote: 'Nothing to decide yet. It starts automatically.', blockedNote: 'Open the conversation to retry this request.',
    exportCsv: 'CSV', exportDoc: 'Document', exportImage: 'Image', exportPrint: 'Print / PDF', exportFailed: 'Export failed',
    codingDraft: (title, pr) => `Revise “${title}”${pr ? ` (PR #${pr})` : ''}: `, chiefDraft: (title, who) => `Continue from “${title}” by ${who}: `,
    revisionMessage: (title, type, note, summary) => `Revision request from Fahad — “${title}” (${type}).\nWhat to change: ${note}${summary ? `\n\nCurrent version summary: ${summary}` : ''}`,
    memoryDecision: (text, title) => `Fahad approved: ${text} (from “${title}”)`,
    sendFinding: (who) => `Send this finding to ${who}?`, sendFindingBody: 'It opens a direct conversation with that employee asking for the fix.',
  },
  ar: {
    tab: 'المخرجات', statusFilter: 'فلترة حسب الحالة', deliverables: (n) => (n === 1 ? 'مخرج واحد' : n === 2 ? 'مخرجان' : n >= 3 && n <= 10 ? `${n} مخرجات` : `${n} مخرج`), readyOf: (r, n) => `${r} من ${n} جاهزة`, updated: (w) => `آخر تحديث ${w}`,
    chief: 'CHIEF · آخر ملخص', noChief: 'لما يخلص CHIEF هدف، ملخصه يظهر هني.', askChief: 'اسأل CHIEF', newCoding: 'مهمة CODING', allFiles: 'كل الملفات والتصدير',
    all: 'الكل', status: { needs_fahad: 'يحتاجك', blocked: 'متوقف', needs_review: 'يحتاج مراجعة', in_progress: 'قيد التنفيذ', waiting: 'ينتظر', ready: 'جاهز' },
    search: 'ابحث في المخرجات…', allEmployees: 'كل الموظفين', allTypes: 'كل الأنواع', filters: 'فلاتر', anyTime: 'أي وقت', d1: 'آخر 24 ساعة', d7: 'آخر 7 أيام', d30: 'آخر 30 يوم',
    anyPriority: 'أي أولوية', pinned: 'المثبتة', high: 'مهمة وعاجلة', normal: 'عادية', low: 'على مهلك', allObjectives: 'كل الأهداف', noObjective: 'بدون هدف',
    showArchived: 'اعرض المؤرشفة', reset: 'امسح الفلاتر', sortLabel: 'الترتيب', groupLabel: 'التجميع',
    sort: { smart: 'ترتيب ذكي', newest: 'الأحدث', oldest: 'الأقدم', employee: 'الموظف', status: 'الحالة', type: 'النوع', title: 'العنوان' },
    view: { grid: 'لوحة', list: 'قائمة', grouped: 'مجموعات' }, viewLabel: 'العرض',
    group: { employee: 'حسب الموظف', status: 'حسب الحالة', objective: 'حسب الهدف', type: 'حسب النوع' },
    showing: (s, n) => `${s} من ${n}`, archivedCount: (n) => `${n} مؤرشفة`,
    objectivesShown: (s, n) => (n == null ? `الأهداف المعروضة: ${s}` : `الأهداف المعروضة: ${s} من ${n}`), loadOlder: 'حمّل المخرجات الأقدم', loadingOlder: 'نحمّل المخرجات الأقدم…', olderFailed: 'تعذر تحميل المخرجات الأقدم. جرّب مرة ثانية.',
    emptyTitle: 'ما في مخرجات بعد', emptyText: 'اطلب من CHIEF خطة أو ميزانية أو هوية أو مراجعة. كل مخرج يسويه الفريق بيظهر هني.',
    noMatch: 'ما في شي يطابق هذي الفلاتر.', noRecent: 'ما في مخرجات في الأهداف المعروضة حتى الآن.', loading: 'نجمع مخرجات المشروع…', loadFailed: 'تعذر تحميل المخرجات.',
    open: 'افتح', for: 'ضمن', delivered: (w) => `تسلّم ${w}`, updatedAt: (w) => `تحديث ${w}`, version: (a, b) => `النسخة ${a} من ${b}`, versionShort: (a) => `ن${a}`,
    updating: (v) => `تحديث جاري — النسخة ${v} قيد التنفيذ`, earlier: 'هذي نسخة أقدم.', latestVersion: 'ارجع لآخر نسخة',
    yourDecision: 'قرارك', approve: 'اعتماد', approved: 'معتمد', undo: 'تراجع', requestRevision: 'اطلب تعديل', continueChief: 'كمّل مع CHIEF',
    pin: 'تثبيت', unpin: 'إلغاء التثبيت', archive: 'أرشفة', restore: 'استرجاع', confirmApprove: 'أكّد الاعتماد', cancel: 'إلغاء', send: (who) => `أرسل لـ${who}`,
    approveTitle: 'تعتمد هذا المخرج؟', saveDecision: 'احفظ القرار بعد في ذاكرة المشروع عشان CHIEF والفريق يعتمدون عليه', noteOptional: 'ملاحظة (اختياري)',
    revisionTitle: 'شو اللي لازم يتغير؟', revisionHint: (who) => `${who} يستلم ملاحظتك وملخص النسخة الحالية في محادثة مباشرة.`,
    revisionSent: (who) => `انرسل طلب التعديل لـ${who}`, approvedToast: 'تم الاعتماد', pinnedToast: 'تم التثبيت', unpinnedToast: 'انلغى التثبيت', archivedToast: 'تمت الأرشفة', restoredToast: 'تم الاسترجاع',
    reviewsOff: 'التثبيت والأرشفة والاعتماد بتشتغل بعد تطبيق تحديث قاعدة بيانات V5.3. باقي الصفحة شغال.',
    summary: 'الملخص', visuals: 'المخرجات المرئية', report: 'التقرير الكامل', noReport: 'هذا المخرج ما له تقرير مكتوب.', loadingReport: 'نحمل المخرج الكامل…',
    versions: 'النسخ', revision: 'تعديل', details: 'التفاصيل', openWorkflow: 'افتح الهدف', openChat: 'افتح المحادثة', openTask: 'افتح مهمة البرمجة',
    coding: { prLabel: 'طلب الدمج', pr: (n) => `طلب الدمج #${n}`, ciLabel: 'فحوصات CI', tests: 'الاختبارات', deploy: 'النشر', files: (n) => `الملفات المتغيرة (${n})`, passing: 'ناجحة', failing: 'فاشلة', none: '—', branch: 'الفرع', ci: { success: 'نجحت', failure: 'فشلت', pending: 'شغالة' }, risk: { low: 'منخفض', medium: 'متوسط', high: 'عالي', critical: 'حرج' } },
    approveMerge: 'موافقة', reject: 'رفض', answer: 'جوابك', reply: 'رد وكمّل', resume: 'كمّل', messageCoding: 'رسالة لـCODING (اختياري)', replySent: 'انرسل — CODING يكمل نفس المهمة',
    pendingNote: (who) => `ما في قرار مطلوب الحين — ${who} لسه يشتغل عليه.`, waitingNote: 'ما في شي تقرره الحين. يبدأ تلقائي.', blockedNote: 'افتح المحادثة عشان تعيد الطلب.',
    exportCsv: 'CSV', exportDoc: 'مستند', exportImage: 'صورة', exportPrint: 'طباعة / PDF', exportFailed: 'تعذر التصدير',
    codingDraft: (title, pr) => `عدّل «${title}»${pr ? ` (PR #${pr})` : ''}: `, chiefDraft: (title, who) => `كمّل من «${title}» (${who}): `,
    revisionMessage: (title, type, note, summary) => `طلب تعديل من فهد — «${title}» (${type}).\nالمطلوب: ${note}${summary ? `\n\nملخص النسخة الحالية: ${summary}` : ''}`,
    memoryDecision: (text, title) => `فهد اعتمد: ${text} (من «${title}»)`,
    sendFinding: (who) => `ترسل هذي الملاحظة لـ${who}؟`, sendFindingBody: 'تنفتح محادثة مباشرة مع الموظف يطلب فيها الإصلاح.',
  },
};

export const copyFor = (language) => (language === 'en' ? COPY.en : COPY.ar);
export const typeLabel = (type, language) => (language === 'en' ? EN_TYPES[type] : AR_TYPES[type]) || EN_TYPES[type] || String(type || '');

// One owner sentence for why a deliverable has its status. Machine reasons
// come from the server; the words are chosen here, in Fahad's language. The
// sentence is a fixed lead plus the data it quotes (often the other language).
function reasonParts(item, language, when) {
  const ar = language !== 'en';
  const reason = item.reason || {};
  const who = item.agent?.label || '';
  const text = reason.text || '';
  switch (reason.code) {
    case 'decision': return [ar ? 'قرار مطلوب منك: ' : 'Decision for you: ', text];
    case 'approval': return [ar ? 'ينتظر موافقتك: ' : 'Waiting for your approval: ', text];
    case 'question': return [ar ? 'CODING يسألك: ' : 'CODING asks: ', text];
    case 'paused': return [ar ? 'متوقف مؤقتًا: ' : 'Paused: ', text];
    case 'audit': return [ar ? `حكم المراجعة: ${reason.verdict === 'BLOCKED' ? 'متوقف' : 'يحتاج شغل'}` : `AUDIT verdict: ${reason.verdict}`, ''];
    case 'compliance': return [ar ? `${reason.count} بند يحتاج قرارك أو مراجعة محامٍ` : `${reason.count} ${reason.count === 1 ? 'item needs' : 'items need'} your decision or a lawyer’s review`, ''];
    case 'finance': return [reason.state === 'INCONSISTENT' ? (ar ? 'بعض الأرقام ما تطابق الحساب' : 'Some figures disagree with the calculation') : (ar ? 'ما في بيانات كافية للتحقق من الأرقام' : 'Not enough data to verify the figures'), ''];
    case 'ci_failed': return [ar ? 'فحوصات CI فشلت على آخر نسخة' : 'CI failed on the final commit', ''];
    case 'revision_requested': return [ar ? `طلبت تعديل ${when(reason.at)}` : `You asked for a revision ${when(reason.at)}`, ''];
    case 'approved': return [ar ? `اعتمدته ${when(reason.at)}` : `Approved by you ${when(reason.at)}`, ''];
    case 'working': return [ar ? `${who} يشتغل عليه · بدأ ${when(reason.since)}` : `${who} is working on it · started ${when(reason.since)}`, ''];
    case 'capacity': return [ar ? 'ينتظر السعة المجانية — بيكمل تلقائي' : 'Waiting for free model capacity — resumes automatically', ''];
    case 'dependency': return [ar ? 'ينتظر ' : 'Waiting for ', (reason.agents || []).join(ar ? '، ' : ', ')];
    case 'queued': return [ar ? 'التالي في الدور' : 'Up next', ''];
    case 'failed': return [ar ? `ما قدر يكمل${text ? ': ' : ''}` : `Could not finish${text ? ': ' : ''}`, text];
    case 'upstream_failed': return [ar ? 'توقف لأن خطوة قبله فشلت' : 'Stopped because an earlier step failed', ''];
    case 'stopped': return [ar ? 'الهدف توقف قبل هذي الخطوة' : 'The objective stopped before this step', ''];
    default: return ['', item.summary || ''];
  }
}
export function reasonText(item, language, when = (value) => String(value || '')) {
  return reasonParts(item, language, when).join('');
}
// The same sentence as an element. With a lead it follows the page direction
// and the quoted data keeps its own (<bdi>); pure data takes its own direction.
export function reasonElement(item, language, when, tag = 'p', attributes = '') {
  const [lead, text] = reasonParts(item, language, when);
  if (!lead && !text) return '';
  return lead ? `<${tag} ${attributes}>${esc(lead)}${text ? `<bdi>${esc(text)}</bdi>` : ''}</${tag}>` : `<${tag} ${attributes} dir="auto">${esc(text)}</${tag}>`;
}
// A short state for a card whose output does not exist yet.
function pendingWord(item, language) {
  const ar = language !== 'en';
  if (item.status === 'in_progress') return ar ? 'قيد التنفيذ' : 'In progress';
  if (item.reason?.code === 'capacity') return ar ? 'ينتظر السعة المجانية' : 'Waiting for free capacity';
  if (item.status === 'waiting') return item.reason?.code === 'queued' ? (ar ? 'التالي' : 'Up next') : (ar ? 'ينتظر زملاءه' : 'Waiting for teammates');
  return ar ? 'ما اكتمل' : 'Not finished';
}

// ------------------------------------------------------------------ filters
// Pure, so the board's behaviour is testable without a browser.
export function filterDeliverables(items, filters = {}, language = 'ar', now = Date.now()) {
  const words = String(filters.search || '').toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (!filters.showArchived && item.review?.archived) return false;
    if (filters.status && item.status !== filters.status) return false;
    if (filters.agent && item.agent?.key !== filters.agent) return false;
    if (filters.type && !(item.types || [item.type]).includes(filters.type)) return false;
    if (filters.since && now - Date.parse(item.updatedAt || item.createdAt || 0) > Number(filters.since) * 86_400_000) return false;
    if (filters.priority === 'pinned' && !item.review?.pinned) return false;
    if (filters.priority === 'high' && !['high', 'urgent'].includes(item.priority)) return false;
    if (['normal', 'low'].includes(filters.priority) && item.priority !== filters.priority) return false;
    if (filters.objective === 'none' && item.objective) return false;
    if (filters.objective && filters.objective !== 'none' && item.objective?.id !== filters.objective) return false;
    if (words.length) {
      const haystack = [item.title, item.summary, item.decisions, item.agent?.label, typeLabel(item.type, language), typeLabel(item.type, 'en'), item.objective?.title, reasonText(item, language)]
        .join(' ').toLowerCase();
      if (!words.every((word) => haystack.includes(word))) return false;
    }
    return true;
  });
}

const stamp = (item) => Date.parse(item.updatedAt || item.createdAt || 0) || 0;
const rosterIndex = (key) => { const index = ROSTER.indexOf(key); return index === -1 ? ROSTER.length : index; };

export function sortDeliverables(items, sort = 'smart', language = 'ar') {
  const list = [...items];
  const pinned = (item) => (item.review?.pinned ? 0 : 1);
  const compare = {
    smart: (a, b) => pinned(a) - pinned(b) || SMART_RANK[a.status] - SMART_RANK[b.status] || stamp(b) - stamp(a),
    newest: (a, b) => stamp(b) - stamp(a),
    oldest: (a, b) => stamp(a) - stamp(b),
    employee: (a, b) => rosterIndex(a.agent?.key) - rosterIndex(b.agent?.key) || stamp(b) - stamp(a),
    status: (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || stamp(b) - stamp(a),
    type: (a, b) => typeLabel(a.type, language).localeCompare(typeLabel(b.type, language), language) || stamp(b) - stamp(a),
    title: (a, b) => String(a.title).localeCompare(String(b.title), language),
  }[sort] || ((a, b) => stamp(b) - stamp(a));
  return list.sort(compare);
}

// Groups in a stable, meaningful order (roster, status order, newest objective).
export function groupDeliverables(items, by = 'employee', language = 'ar') {
  const t = copyFor(language);
  const groups = new Map();
  const add = (key, label, order, item) => {
    if (!groups.has(key)) groups.set(key, { key, label, order, items: [] });
    groups.get(key).items.push(item);
  };
  for (const item of items) {
    if (by === 'status') add(item.status, t.status[item.status], STATUS_ORDER.indexOf(item.status), item);
    else if (by === 'objective') add(item.objective?.id || 'none', item.objective?.title || t.noObjective, item.objective ? -Date.parse(item.objective.createdAt || 0) || 0 : Number.MAX_SAFE_INTEGER, item);
    else if (by === 'type') add(item.type, typeLabel(item.type, language), 0, item);
    else add(item.agent?.key || 'office', item.agent?.label || 'Office', rosterIndex(item.agent?.key), item);
  }
  return [...groups.values()].sort((a, b) => a.order - b.order || String(a.label).localeCompare(String(b.label), language));
}

export function countByStatus(items) {
  const counts = Object.fromEntries(STATUS_ORDER.map((status) => [status, 0]));
  for (const item of items) if (!item.review?.archived) counts[item.status] += 1;
  return counts;
}

// Pages are loaded newest first. A deliverable appears once: the newest
// page's copy wins (it is the freshest read).
export function mergePages(...pages) {
  const byKey = new Map();
  for (const page of pages) for (const item of page || []) if (!byKey.has(item.key)) byKey.set(item.key, item);
  return [...byKey.values()];
}
export function mergeObjectives(...lists) {
  const byId = new Map();
  for (const list of lists) for (const objective of list || []) if (objective?.id && !byId.has(objective.id)) byId.set(objective.id, objective);
  return [...byId.values()].sort((a, b) => (Date.parse(b.createdAt || 0) || 0) - (Date.parse(a.createdAt || 0) || 0));
}
// The header facts, counted over everything loaded (never a guessed total).
export function summarizeDeliverables(items) {
  const visible = items.filter((item) => !item.review?.archived);
  const lastUpdate = visible.reduce((best, item) => ((Date.parse(item.updatedAt || 0) || 0) > (Date.parse(best || 0) || 0) ? item.updatedAt : best), null);
  return { total: visible.length, archived: items.length - visible.length, counts: countByStatus(items), lastUpdate };
}

// ------------------------------------------------------------------ previews
const arr = (value, max = 60) => (Array.isArray(value) ? value.slice(0, max) : []);
const num = (value) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : null);

function miniKanban(data) {
  return `<div class="pv-kb">${arr(data.columns, 4).map((column) => { const cards = arr(column.cards, 40); return `<div class="pv-kb-col"><b dir="auto">${esc(column.name)}</b>${cards.slice(0, 3).map((card) => `<i dir="auto">${esc(card.title)}</i>`).join('')}${cards.length > 3 ? `<em class="num">+${cards.length - 3}</em>` : ''}</div>`; }).join('')}</div>`;
}
function miniTable(data) {
  const columns = arr(data.columns, 3);
  if (!columns.length) return '';
  return `<div class="pv-table" style="--cols:${columns.length}"><div class="pv-tr pv-th">${columns.map((column) => `<span dir="auto">${esc(column)}</span>`).join('')}</div>${arr(data.rows, 3).map((row) => `<div class="pv-tr">${columns.map((_, index) => `<span dir="auto">${esc(arr(row, 3)[index] ?? '')}</span>`).join('')}</div>`).join('')}</div>`;
}
function miniTimeline(data) {
  const items = arr(data.items, 4);
  return `<div class="pv-tl">${items.map((item, index) => `<div class="pv-tl-row"><span class="pv-tl-bar" style="--start:${Math.round((index / Math.max(items.length, 1)) * 60)}%"></span><span dir="auto">${esc(item.label)}</span></div>`).join('')}</div>`;
}
function miniChecklist(data) {
  return `<div class="pv-check">${arr(data.items, 4).map((item) => `<div class="pv-ck ck-${esc(item.status || 'todo')}"><span aria-hidden="true">${['done', 'pass'].includes(item.status) ? '✓' : item.status === 'fail' ? '✕' : ''}</span><span dir="auto">${esc(item.text)}</span></div>`).join('')}</div>`;
}
function miniRisk(data) {
  const items = arr(data.items, 30);
  const cells = [];
  for (let impact = 5; impact >= 1; impact -= 1) for (let likelihood = 1; likelihood <= 5; likelihood += 1) {
    const here = items.filter((item) => Number(item.impact) === impact && Number(item.likelihood) === likelihood).length;
    cells.push(`<span class="pv-rm-${impact * likelihood >= 15 ? 'hi' : impact * likelihood >= 8 ? 'mid' : 'lo'}${here ? ' has' : ''}"></span>`);
  }
  return `<div class="pv-rm">${cells.join('')}</div>`;
}
const PREVIEW_WORDS = {
  en: { setup: 'Setup', monthly: 'Per month', requirements: 'Requirements', flagged: 'Need review', verdict: { PASS: 'PASS', 'NEEDS WORK': 'NEEDS WORK', BLOCKED: 'BLOCKED' }, severity: {}, validation: { VERIFIED: 'VERIFIED', INCONSISTENT: 'INCONSISTENT', 'INSUFFICIENT DATA': 'INSUFFICIENT DATA' } },
  ar: { setup: 'التأسيس', monthly: 'شهريًا', requirements: 'متطلبات', flagged: 'تحتاج مراجعة', verdict: { PASS: 'جاهز', 'NEEDS WORK': 'يحتاج شغل', BLOCKED: 'متوقف' },
    severity: { blocked: 'متوقف', critical: 'حرج', high: 'عالي', medium: 'متوسط', low: 'منخفض' }, validation: { VERIFIED: 'متحقق منها', INCONSISTENT: 'غير متطابقة', 'INSUFFICIENT DATA': 'بيانات ناقصة' } },
};
function miniFinance(data, words) {
  const items = arr(data.items, 200);
  const oneTime = items.reduce((sum, item) => sum + (num(item.one_time) || 0), 0);
  const monthly = items.reduce((sum, item) => sum + (num(item.monthly) || 0), 0);
  const currency = String(data.currency || '').slice(0, 6);
  const format = (value) => `${value.toLocaleString('en', { maximumFractionDigits: 0 })}${currency ? ` ${esc(currency)}` : ''}`;
  const state = String(data.validation?.state || '');
  return `<div class="pv-fin"><div><small>${esc(words.setup)}</small><b class="num" dir="ltr">${format(oneTime)}</b></div><div><small>${esc(words.monthly)}</small><b class="num" dir="ltr">${format(monthly)}</b></div>${state ? `<span class="pv-fin-state fs-${esc(state.toLowerCase().replace(/\s+/g, '-'))}">${esc(words.validation[state] || state)}</span>` : ''}</div>`;
}
function miniCompliance(data, words) {
  const items = arr(data.items, 200);
  const flagged = items.filter((item) => ['RISK FLAG', 'PROFESSIONAL REVIEW REQUIRED'].includes(item?.classification));
  return `<div class="pv-legal"><div><b class="num">${items.length}</b><small>${esc(words.requirements)}</small></div><div class="${flagged.length ? 'is-flag' : ''}"><b class="num">${flagged.length}</b><small>${esc(words.flagged)}</small></div></div>${(flagged.length ? flagged : items).slice(0, 2).map((item) => `<div class="pv-line" dir="auto">${esc(item.requirement)}</div>`).join('')}`;
}
function miniAudit(data, words) {
  const verdict = String(data.verdict || 'PASS');
  const order = { blocked: 0, critical: 1, high: 2, medium: 3, low: 4 };
  const findings = arr(data.findings, 50).toSorted((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
  return `<div class="audit-verdict v-${esc(verdict.replace(/\s+/g, '-').toLowerCase())} pv-verdict">${esc(words.verdict[verdict] || verdict)}</div>${findings.slice(0, 2).map((finding) => `<div class="pv-line" dir="auto"><span class="pv-sev sev-${esc(finding.severity)}">${esc(words.severity[finding.severity] || finding.severity)}</span> <bdi>${esc(finding.title)}</bdi></div>`).join('')}`;
}

function artifactThumb(artifact, language = 'ar') {
  const data = artifact.data || {};
  const words = PREVIEW_WORDS[language === 'en' ? 'en' : 'ar'];
  switch (artifact.type) {
    case 'kanban': return miniKanban(data);
    case 'table': return miniTable(data);
    case 'timeline': return miniTimeline(data);
    case 'checklist': return miniChecklist(data);
    case 'risk_matrix': return miniRisk(data);
    case 'financial_model': return miniFinance(data, words);
    case 'compliance_matrix': return miniCompliance(data, words);
    case 'audit_report': return miniAudit(data, words);
    default: return artifactPreview(artifact);
  }
}

// The visual of a card. Delivered work shows its real output; work that does
// not exist yet shows an honest state, never a mock-up.
export function deliverablePreview(item, language = 'ar', when = (value) => String(value || '')) {
  const t = copyFor(language);
  const artifact = item.artifacts?.[0];
  const ribbon = item.version?.pending ? `<span class="pv-ribbon">${esc(t.updating(item.version.count))}</span>` : '';
  if (item.kind === 'coding') {
    const coding = item.coding || {};
    const chips = [coding.pr ? `PR #${esc(coding.pr.number)}` : '', coding.ci ? `CI ${esc(t.coding.ci[coding.ci] || coding.ci)}` : '', coding.tests ? `${t.coding.tests}: ${esc(coding.tests === 'passing' ? t.coding.passing : t.coding.failing)}` : ''].filter(Boolean);
    const files = (coding.files || []).slice(0, 4);
    return `<div class="pv-code">${chips.length ? `<div class="pv-code-chips">${chips.map((chip) => `<span dir="ltr">${chip}</span>`).join('')}</div>` : ''}${files.length ? `<div class="pv-code-files" dir="ltr">${files.map((file) => `<code>${esc(file)}</code>`).join('')}${coding.filesCount > files.length ? `<em class="num">+${coding.filesCount - files.length}</em>` : ''}</div>` : `<div class="pv-pending pv-working">${['in_progress', 'waiting'].includes(item.status) ? '<span class="pv-shimmer" aria-hidden="true"></span>' : ''}<span>${esc(pendingWord(item, language))}</span></div>`}</div>`;
  }
  if (artifact) return `${ribbon}<div class="pv-art pv-${esc(artifact.type)}">${artifactThumb(artifact, language)}</div>${item.artifacts.length > 1 ? `<span class="pv-more num" dir="ltr">+${item.artifacts.length - 1}</span>` : ''}`;
  // Not delivered yet: a quiet placeholder with the state; the card body
  // carries the exact reason.
  if (item.status === 'in_progress') return `<div class="pv-pending pv-working"><span class="pv-shimmer" aria-hidden="true"></span><span>${esc(pendingWord(item, language))}</span></div>`;
  if (item.status === 'waiting') return `<div class="pv-pending pv-wait"><span class="pv-wait-icon${item.reason?.code === 'capacity' ? ' is-capacity' : ''}" aria-hidden="true"></span><span>${esc(pendingWord(item, language))}</span></div>`;
  if (item.status === 'blocked' && !item.summary) return `<div class="pv-pending pv-blocked"><span aria-hidden="true">!</span><span>${esc(pendingWord(item, language))}</span></div>`;
  const kicker = item.type === 'synthesis' ? typeLabel('synthesis', language) : '';
  return `${ribbon}<div class="pv-doc">${kicker ? `<span class="pv-doc-kicker">${esc(kicker)}</span>` : ''}<span class="pv-doc-text" dir="auto">${esc(item.summary || item.title)}</span><span class="pv-doc-lines" aria-hidden="true"><i></i><i></i><i></i></span></div>`;
}

// ------------------------------------------------------------------ board
let stylesheet = null;
function ensureStyles() {
  if (stylesheet) return stylesheet;
  stylesheet = new Promise((resolve) => {
    const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: './ui/deliverables.css?v=__UI_VERSION__' });
    link.onload = resolve; link.onerror = resolve;
    document.head.append(link);
  });
  return stylesheet;
}
function readPrefs() { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { return {}; } }
function savePrefs(value) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(value)); } catch {} }

export async function renderDeliverables(ctx, body, { id }) {
  const language = ctx.language === 'en' ? 'en' : 'ar';
  const t = copyFor(language);
  const { when } = ctx;
  await ensureStyles();
  body.innerHTML = `<div class="dl-loading" role="status"><div class="drawer-loading"></div><p class="muted">${esc(t.loading)}</p></div>`;
  // The newest page (refreshed live) and the older pages Fahad loaded.
  let head = await ctx.api(`/api/deliverables${ctx.q({ workspaceId: id })}`);
  if (ctx.current && !ctx.current()) return;
  const paging = { older: [], olderObjectives: [], olderJobs: 0, olderLoaded: false, loading: false, failed: false,
    cursor: head.page?.cursor || null, hasMore: Boolean(head.page?.hasMore), windowStart: head.page?.cursor || null,
    headJobs: head.page?.jobs ?? 0, total: head.totals?.objectives ?? null };
  const prefs = readPrefs();
  const filters = { search: '', status: '', agent: '', type: '', since: '', priority: '', objective: '', showArchived: false };
  const view = { mode: ['grid', 'list', 'grouped'].includes(prefs.mode) ? prefs.mode : 'grid', sort: t.sort[prefs.sort] ? prefs.sort : 'smart', group: t.group[prefs.group] ? prefs.group : 'employee' };

  body.innerHTML = `<div class="dl" data-deliverables>
    <section class="dl-summary" id="dlSummary" aria-label="${esc(t.tab)}"></section>
    <div class="dl-stats" id="dlStats" role="group" aria-label="${esc(t.statusFilter)}"></div>
    <div class="dl-toolbar" role="search">
      <label class="sr-only" for="dlSearch">${esc(t.search)}</label><input id="dlSearch" class="input dl-search" type="search" dir="auto" placeholder="${esc(t.search)}" autocomplete="off">
      <label class="sr-only" for="dlAgent">${esc(t.allEmployees)}</label><select id="dlAgent" class="input input-sm"></select>
      <label class="sr-only" for="dlType">${esc(t.allTypes)}</label><select id="dlType" class="input input-sm"></select>
      <details class="dl-filters" id="dlMore"><summary class="btn btn-sm">${esc(t.filters)}<span class="dl-filter-count num" id="dlFilterCount" hidden></span></summary><div class="dl-filters-panel">
        <label class="field-label" for="dlSince">${esc(t.anyTime)}</label><select id="dlSince" class="input input-sm"><option value="">${esc(t.anyTime)}</option><option value="1">${esc(t.d1)}</option><option value="7">${esc(t.d7)}</option><option value="30">${esc(t.d30)}</option></select>
        <label class="field-label" for="dlPriority">${esc(t.anyPriority)}</label><select id="dlPriority" class="input input-sm"><option value="">${esc(t.anyPriority)}</option><option value="pinned">${esc(t.pinned)}</option><option value="high">${esc(t.high)}</option><option value="normal">${esc(t.normal)}</option><option value="low">${esc(t.low)}</option></select>
        <label class="field-label" for="dlObjective">${esc(t.allObjectives)}</label><select id="dlObjective" class="input input-sm"></select>
        <label class="check dl-check"><input type="checkbox" id="dlArchived"> <span>${esc(t.showArchived)}</span></label>
        <button type="button" class="btn btn-ghost btn-sm" id="dlReset">${esc(t.reset)}</button></div></details>
      <span class="dl-toolbar-gap"></span>
      <label class="sr-only" for="dlSort">${esc(t.sortLabel)}</label><select id="dlSort" class="input input-sm">${Object.entries(t.sort).map(([key, label]) => `<option value="${key}">${esc(label)}</option>`).join('')}</select>
      <label class="sr-only" for="dlGroup">${esc(t.groupLabel)}</label><select id="dlGroup" class="input input-sm" hidden>${Object.entries(t.group).map(([key, label]) => `<option value="${key}">${esc(label)}</option>`).join('')}</select>
      <div class="dl-views" role="group" aria-label="${esc(t.viewLabel)}">${['grid', 'list', 'grouped'].map((mode) => `<button type="button" class="dl-view" data-view="${mode}" aria-pressed="false" title="${esc(t.view[mode])}"><span aria-hidden="true">${{ grid: '▦', list: '☰', grouped: '⊞' }[mode]}</span><span class="dl-view-label">${esc(t.view[mode])}</span></button>`).join('')}</div>
    </div>
    <p class="dl-count small muted" id="dlCount" aria-live="polite" tabindex="-1"></p>
    <div id="dlBoard"></div>
    <div class="dl-older" id="dlOlder"></div></div>`;
  const $ = (selector) => body.querySelector(selector);
  $('#dlSort').value = view.sort;
  $('#dlGroup').value = view.group;

  const items = () => mergePages(head.deliverables, paging.older);
  const findItem = (key) => items().find((item) => item.key === key || item.version?.list?.some((entry) => entry.key === key));

  function drawSummary() {
    const s = summarizeDeliverables(items());
    const counts = s.counts || {};
    const chief = head.summary?.chief;
    const shown = paging.hasMore || paging.olderLoaded ? `<span>·</span><span>${esc(t.objectivesShown(paging.headJobs + paging.olderJobs, paging.total))}</span>` : '';
    $('#dlSummary').innerHTML = `<div class="dl-summary-main">
        ${chief ? `<div class="dl-chief">${roleMark('chief', 'CHIEF')}<div><span class="dl-label">${esc(t.chief)} · <time datetime="${esc(chief.at)}">${esc(when(chief.at))}</time></span><p dir="auto">${esc(chief.text)}</p>${chief.jobId ? `<a class="small" href="#/workflow/${esc(chief.jobId)}">${esc(t.openWorkflow)}</a>` : ''}</div></div>`
          : `<div class="dl-chief dl-chief-empty">${roleMark('chief', 'CHIEF')}<div><span class="dl-label">CHIEF</span><p>${esc(t.noChief)}</p></div></div>`}
        <p class="dl-facts"><strong class="num">${esc(t.deliverables(s.total || 0))}</strong><span>·</span><span>${esc(t.readyOf(counts.ready || 0, s.total || 0))}</span>${s.lastUpdate ? `<span>·</span><span>${esc(t.updated(when(s.lastUpdate)))}</span>` : ''}${s.archived ? `<span>·</span><span>${esc(t.archivedCount(s.archived))}</span>` : ''}${shown}</p>
      </div>
      <div class="dl-actions"><a class="btn btn-primary" href="#/chief">${esc(t.askChief)}</a><a class="btn" href="#/code">${esc(t.newCoding)}</a><a class="btn btn-ghost" href="#/artifacts">${esc(t.allFiles)}</a></div>`;
    const visible = ['ready', 'in_progress', 'needs_fahad', 'waiting', 'needs_review', 'blocked'].filter((status) => ['ready', 'in_progress', 'needs_fahad', 'waiting'].includes(status) || counts[status]);
    $('#dlStats').innerHTML = `<button type="button" class="dl-stat" data-stat="" aria-pressed="${!filters.status}"><span>${esc(t.all)}</span><b class="num">${s.total || 0}</b></button>${visible.map((status) => `<button type="button" class="dl-stat" data-stat="${status}" data-status="${status}" aria-pressed="${filters.status === status}"><span>${esc(t.status[status])}</span><b class="num">${counts[status] || 0}</b></button>`).join('')}`;
    $('#dlStats').querySelectorAll('[data-stat]').forEach((button) => { button.onclick = () => { filters.status = button.dataset.stat === filters.status ? '' : button.dataset.stat; drawSummary(); drawBoard(); }; });
  }

  function drawFilters() {
    const agents = [...new Map(items().map((item) => [item.agent.key, item.agent.label])).entries()].sort((a, b) => rosterIndex(a[0]) - rosterIndex(b[0]));
    $('#dlAgent').innerHTML = `<option value="">${esc(t.allEmployees)}</option>${agents.map(([key, label]) => `<option value="${esc(key)}">${esc(label)}</option>`).join('')}`;
    $('#dlAgent').value = agents.some(([key]) => key === filters.agent) ? filters.agent : (filters.agent = '');
    const types = [...new Set(items().flatMap((item) => item.types || [item.type]))].sort((a, b) => typeLabel(a, language).localeCompare(typeLabel(b, language), language));
    $('#dlType').innerHTML = `<option value="">${esc(t.allTypes)}</option>${types.map((type) => `<option value="${esc(type)}">${esc(typeLabel(type, language))}</option>`).join('')}`;
    $('#dlType').value = types.includes(filters.type) ? filters.type : (filters.type = '');
    const objectives = mergeObjectives(head.objectives, paging.olderObjectives);
    $('#dlObjective').innerHTML = `<option value="">${esc(t.allObjectives)}</option>${objectives.map((objective) => `<option value="${esc(objective.id)}">${esc(objective.title || '—')}</option>`).join('')}${items().some((item) => !item.objective) ? `<option value="none">${esc(t.noObjective)}</option>` : ''}`;
    $('#dlObjective').value = filters.objective && (filters.objective === 'none' || objectives.some((objective) => objective.id === filters.objective)) ? filters.objective : (filters.objective = '');
    $('#dlArchived').disabled = !head.reviews?.available;
  }

  const cardHtml = (item) => {
    const status = t.status[item.status];
    const reason = reasonText(item, language, when) === item.title ? '' : reasonElement(item, language, when, 'p', 'class="dl-reason"');
    return `<article class="dl-card${item.review?.pinned ? ' is-pinned' : ''}${item.review?.archived ? ' is-archived' : ''}" data-status="${esc(item.status)}" data-kind="${esc(item.kind)}">
      <div class="dl-preview" aria-hidden="true">${deliverablePreview(item, language, when)}</div>
      <div class="dl-body">
        <div class="dl-top">${roleMark(item.agent.key, item.agent.label)}<span class="dl-who"><b>${esc(item.agent.label)}</b><small>${esc(typeLabel(item.type, language))}${item.version?.count > 1 ? ` · ${esc(t.versionShort(item.version.number))}` : ''}</small></span>${item.review?.pinned ? `<span class="dl-pin" title="${esc(t.pinned)}" aria-label="${esc(t.pinned)}">★</span>` : ''}<span class="dl-status" data-status="${esc(item.status)}">${esc(status)}</span></div>
        <h3 class="dl-title"><button type="button" class="dl-open" data-open="${esc(item.key)}" dir="auto">${esc(item.title)}</button></h3>
        ${reason}
        <div class="dl-foot">${item.objective ? `<span class="dl-objective" dir="auto" title="${esc(item.objective.title)}">${esc(item.objective.title)}</span>` : '<span class="dl-objective"></span>'}<time datetime="${esc(item.updatedAt || '')}">${esc(when(item.updatedAt))}</time></div>
      </div></article>`;
  };
  const rowHtml = (item) => `<article class="dl-row${item.review?.pinned ? ' is-pinned' : ''}" data-status="${esc(item.status)}">
      ${roleMark(item.agent.key, item.agent.label)}
      <div class="dl-row-main"><h3 class="dl-title"><button type="button" class="dl-open" data-open="${esc(item.key)}" dir="auto">${esc(item.title)}</button></h3>
        <p class="dl-row-sub" dir="auto">${esc(item.agent.label)} · ${esc(typeLabel(item.type, language))}${item.objective ? ` · ${esc(item.objective.title)}` : ''}</p></div>
      ${item.review?.pinned ? `<span class="dl-pin" aria-label="${esc(t.pinned)}">★</span>` : ''}<span class="dl-status" data-status="${esc(item.status)}">${esc(t.status[item.status])}</span><time datetime="${esc(item.updatedAt || '')}">${esc(when(item.updatedAt))}</time></article>`;

  function drawBoard() {
    const list = sortDeliverables(filterDeliverables(items(), filters, language), view.sort, language);
    const total = items().filter((item) => filters.showArchived || !item.review?.archived).length;
    $('#dlCount').textContent = items().length ? t.showing(list.length, total) : '';
    const active = ['since', 'priority', 'objective'].filter((key) => filters[key]).length + (filters.showArchived ? 1 : 0);
    $('#dlFilterCount').hidden = !active;
    $('#dlFilterCount').textContent = String(active);
    $('#dlGroup').hidden = view.mode !== 'grouped';
    body.querySelectorAll('[data-view]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.view === view.mode)));
    const board = $('#dlBoard');
    if (!items().length && paging.hasMore) {
      board.innerHTML = `<div class="dl-empty dl-empty-sm"><p>${esc(t.noRecent)}</p></div>`;
      return;
    }
    if (!items().length) {
      board.innerHTML = `<div class="dl-empty"><span class="dl-empty-art" aria-hidden="true"><i></i><i></i><i></i></span><h3>${esc(t.emptyTitle)}</h3><p>${esc(t.emptyText)}</p><a class="btn btn-primary" href="#/chief">${esc(t.askChief)}</a></div>`;
      return;
    }
    if (!list.length) {
      board.innerHTML = `<div class="dl-empty dl-empty-sm"><p>${esc(t.noMatch)}</p><button type="button" class="btn btn-sm" data-reset>${esc(t.reset)}</button></div>`;
      board.querySelector('[data-reset]').onclick = resetFilters;
      return;
    }
    // A heading for the board keeps the outline h1 → h2 → card h3.
    const heading = `<h2 class="sr-only">${esc(t.tab)}</h2>`;
    if (view.mode === 'list') board.innerHTML = `${heading}<div class="dl-list">${list.map(rowHtml).join('')}</div>`;
    else if (view.mode === 'grouped') board.innerHTML = groupDeliverables(list, view.group, language).map((group) => `<section class="dl-group" aria-label="${esc(group.label)}"><h2 class="dl-group-head"><span dir="auto">${esc(group.label)}</span><span class="count num">${group.items.length}</span></h2><div class="dl-grid">${group.items.map(cardHtml).join('')}</div></section>`).join('');
    else board.innerHTML = `${heading}<div class="dl-grid">${list.map(cardHtml).join('')}</div>`;
    board.querySelectorAll('[data-open]').forEach((button) => { button.onclick = () => openDeliverable(button.dataset.open); });
  }

  function resetFilters() {
    Object.assign(filters, { search: '', status: '', agent: '', type: '', since: '', priority: '', objective: '', showArchived: false });
    $('#dlSearch').value = ''; $('#dlSince').value = ''; $('#dlPriority').value = ''; $('#dlArchived').checked = false;
    drawFilters(); drawSummary(); drawBoard();
  }

  let searchTimer = null;
  $('#dlSearch').oninput = (event) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { filters.search = event.target.value; drawBoard(); }, 120); };
  $('#dlAgent').onchange = (event) => { filters.agent = event.target.value; drawBoard(); };
  $('#dlType').onchange = (event) => { filters.type = event.target.value; drawBoard(); };
  $('#dlSince').onchange = (event) => { filters.since = event.target.value; drawBoard(); };
  $('#dlPriority').onchange = (event) => { filters.priority = event.target.value; drawBoard(); };
  $('#dlObjective').onchange = (event) => { filters.objective = event.target.value; drawBoard(); };
  $('#dlArchived').onchange = (event) => { filters.showArchived = event.target.checked; drawBoard(); };
  $('#dlReset').onclick = resetFilters;
  $('#dlSort').onchange = (event) => { view.sort = event.target.value; savePrefs(view); drawBoard(); };
  $('#dlGroup').onchange = (event) => { view.group = event.target.value; savePrefs(view); drawBoard(); };
  body.querySelectorAll('[data-view]').forEach((button) => { button.onclick = () => { view.mode = button.dataset.view; savePrefs(view); drawBoard(); }; });

  function drawOlder() {
    const holder = $('#dlOlder');
    if (!paging.hasMore) { holder.innerHTML = ''; return; }
    holder.innerHTML = `<button type="button" class="btn" id="dlLoadOlder"${paging.loading ? ' disabled aria-busy="true"' : ''}>${esc(paging.loading ? t.loadingOlder : t.loadOlder)}</button>${paging.failed ? `<p class="small" role="alert">${esc(t.olderFailed)}</p>` : ''}`;
    holder.querySelector('#dlLoadOlder').onclick = loadOlder;
  }
  const redraw = () => { drawSummary(); drawFilters(); drawBoard(); drawOlder(); };
  const restart = (next) => {
    head = next;
    Object.assign(paging, { older: [], olderObjectives: [], olderJobs: 0, olderLoaded: false, cursor: next.page?.cursor || null, hasMore: Boolean(next.page?.hasMore),
      windowStart: next.page?.cursor || null, headJobs: next.page?.jobs ?? 0, total: next.totals?.objectives ?? paging.total });
  };
  // A refresh re-reads the newest window only: from the oldest objective of
  // the first page up, so loaded older pages stay exactly as they were.
  const refresh = async () => {
    try {
      const windowed = paging.olderLoaded && paging.windowStart;
      const next = await ctx.api(`/api/deliverables${ctx.q(windowed ? { workspaceId: id, since: paging.windowStart } : { workspaceId: id })}`);
      if (!body.isConnected) return;
      if (next.page?.truncated) restart(await ctx.api(`/api/deliverables${ctx.q({ workspaceId: id })}`));
      else if (!windowed) restart(next);
      else {
        head = next;
        paging.headJobs = next.page?.jobs ?? paging.headJobs;
        if (next.totals?.objectives != null) paging.total = next.totals.objectives;
      }
      if (!body.isConnected) return;
      redraw();
    } catch {}
  };
  async function loadOlder() {
    if (paging.loading || !paging.hasMore || !paging.cursor) return;
    // The button is redrawn; keep keyboard focus on it (or on the count once
    // every page is loaded) instead of dropping it to the page.
    const hadFocus = document.activeElement?.id === 'dlLoadOlder';
    paging.loading = true; paging.failed = false; drawOlder();
    try {
      const next = await ctx.api(`/api/deliverables${ctx.q({ workspaceId: id, before: paging.cursor })}`);
      if (!body.isConnected) return;
      Object.assign(paging, { older: mergePages(paging.older, next.deliverables), olderObjectives: mergeObjectives(paging.olderObjectives, next.objectives),
        olderJobs: paging.olderJobs + (next.page?.jobs || 0), olderLoaded: true, cursor: next.page?.cursor || paging.cursor, hasMore: Boolean(next.page?.hasMore) });
    } catch { paging.failed = true; }
    paging.loading = false;
    if (!body.isConnected) return;
    redraw();
    if (hadFocus) (paging.hasMore ? $('#dlLoadOlder') : $('#dlCount'))?.focus();
  }
  // Live changes arrive often while the team works; the board reloads at
  // most every 10 seconds (the last change always lands).
  let lastLive = 0;
  let pendingLive = null;
  const liveRefresh = () => {
    const wait = 10_000 - (Date.now() - lastLive);
    if (wait <= 0) { lastLive = Date.now(); refresh(); return; }
    clearTimeout(pendingLive);
    pendingLive = setTimeout(() => { lastLive = Date.now(); refresh(); }, wait);
  };
  ctx.onLeave(() => clearTimeout(pendingLive));
  redraw();
  ctx.onChange(liveRefresh);
  // A slow safety net only while work is still moving; the live stream is primary.
  if (items().some((item) => ['in_progress', 'waiting'].includes(item.status))) ctx.every(45_000, refresh);

  // ---------------------------------------------------------------- drawer
  async function openDeliverable(key, versionKey = null) {
    const item = findItem(key);
    if (!item) return;
    const office = await import('./office.js?v=__UI_VERSION__');
    await office.ensureOfficeStyles();
    const panel = office.sheet(ctx, { title: item.title, size: 'xl', body: `<div class="dl-detail"><div class="drawer-loading"></div></div>` });
    await fillDrawer(panel, item, versionKey);
  }

  async function fillDrawer(panel, item, versionKey = null) {
    const root = panel.element.querySelector('.sheet-body');
    const shownKey = versionKey || item.key;
    const isLatest = shownKey === item.key;
    const shownVersion = item.version?.list?.find((entry) => entry.key === shownKey);
    root.innerHTML = `<div class="dl-detail">${detailHead(item, shownVersion)}<div id="dlDecide"></div><div id="dlContent" class="dl-content"><p class="muted small">${esc(t.loadingReport)}</p></div></div>`;
    root.querySelector('#dlDecide').innerHTML = isLatest ? '' : `<div class="dl-earlier"><span>${esc(t.earlier)}</span><button type="button" class="btn btn-sm" data-latest>${esc(t.latestVersion)}</button></div>`;
    root.querySelector('[data-latest]')?.addEventListener('click', () => fillDrawer(panel, item));
    let extra = null;
    try {
      if (item.kind === 'office') extra = await ctx.api(`/api/deliverables/report${ctx.q({ workspaceId: id, taskId: shownKey.split(':')[1] })}`);
      if (item.kind === 'coding') extra = await ctx.api(`/api/tasks/${item.coding.taskId}`);
    } catch (error) { extra = { error: error.message }; }
    if (!panel.element.isConnected) return;
    root.querySelector('#dlContent').innerHTML = contentHtml(item, extra, isLatest);
    wireExports(root.querySelector('#dlContent'), item, extra);
    wireSendOwner(root.querySelector('#dlContent'), panel);
    root.querySelectorAll('[data-version]').forEach((button) => { button.onclick = () => fillDrawer(panel, item, button.dataset.version); });
    if (isLatest) drawDecisions(panel, item, extra);
  }

  function detailHead(item, shownVersion) {
    const number = shownVersion?.number || item.version?.number || 1;
    return `<header class="dl-d-head">${roleMark(item.agent.key, item.agent.label)}<div class="grow"><b>${esc(item.agent.label)}</b><span class="muted"> · ${esc(typeLabel(item.type, language))}${item.version?.count > 1 ? ` · ${esc(t.version(number, item.version.count))}` : ''}</span></div><span class="dl-status" data-status="${esc(item.status)}">${esc(t.status[item.status])}</span></header>
      <p class="dl-d-meta small muted">${item.objective ? `${esc(t.for)}: ${item.links?.workflow ? `<a href="${esc(item.links.workflow)}" dir="auto">${esc(item.objective.title)}</a>` : `<span dir="auto">${esc(item.objective.title)}</span>`} · ` : ''}${item.deliveredAt ? esc(t.delivered(when(item.deliveredAt))) : esc(t.updatedAt(when(item.updatedAt)))}</p>
      ${item.version?.pending ? `<p class="dl-d-pending small">${esc(t.updating(item.version.count))}</p>` : ''}
      ${(['needs_fahad', 'needs_review', 'blocked', 'in_progress', 'waiting'].includes(item.status) || item.reason?.code === 'approved') && !(item.kind === 'coding' && ['approval', 'question', 'paused'].includes(item.reason?.code)) ? reasonElement(item, language, when, 'div', `class="dl-d-reason" data-status="${esc(item.status)}"`) : ''}`;
  }

  function contentHtml(item, extra, isLatest) {
    const parts = [];
    if (extra?.error) parts.push(`<p class="error-note">${esc(t.loadFailed)}</p>`);
    if (item.kind === 'coding') {
      const coding = item.coding || {};
      const task = extra?.task;
      const result = task?.result?.summary;
      if (result) parts.push(`<section class="dl-d-section"><h3>${esc(t.summary)}</h3><div class="md" dir="auto">${renderMarkdown(result)}</div></section>`);
      const facts = [
        [t.coding.prLabel, coding.pr?.url ? `<a href="${esc(coding.pr.url)}" target="_blank" rel="noopener noreferrer">#${esc(coding.pr.number)} ↗</a>` : esc(t.coding.none)],
        [t.coding.ciLabel, esc(t.coding.ci[coding.ci] || coding.ci || t.coding.none)], [t.coding.tests, esc(coding.tests ? (coding.tests === 'passing' ? t.coding.passing : t.coding.failing) : t.coding.none)],
        [t.coding.deploy, esc(coding.deploy || t.coding.none)], [t.coding.branch, coding.branch ? `<code dir="ltr">${esc(coding.branch)}</code>` : esc(t.coding.none)],
      ];
      parts.push(`<dl class="dl-facts-grid">${facts.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`).join('')}</dl>`);
      const files = task?.filesChanged || coding.files || [];
      if (files.length) parts.push(`<section class="dl-d-section"><h3>${esc(t.coding.files(files.length))}</h3><div class="files" dir="ltr">${files.slice(0, 60).map((file) => `<code>${esc(file)}</code>`).join('')}</div></section>`);
      parts.push(`<p><a class="btn btn-sm" href="#/task/${esc(coding.taskId)}">${esc(t.openTask)}</a></p>`);
    } else {
      const report = extra?.report;
      const artifacts = item.kind === 'artifact' ? item.artifacts : (extra?.artifacts || item.artifacts || []);
      const summary = report?.summary || item.summary;
      if (summary && item.kind !== 'artifact') parts.push(`<section class="dl-d-section dl-d-summary"><h3>${esc(t.summary)}</h3><p dir="auto">${esc(summary)}</p></section>`);
      if (artifacts.length) parts.push(`<section class="dl-d-section"><h3>${esc(t.visuals)}</h3>${artifacts.map((artifact, index) => `<div class="dl-artifact" data-artifact="${index}">${ctx.renderArtifact(artifact)}<div class="viewer-actions" role="group" aria-label="Export">${toCsv(artifact) ? `<button type="button" class="btn btn-sm" data-export="csv" data-index="${index}">${esc(t.exportCsv)}</button>` : ''}<button type="button" class="btn btn-sm" data-export="md" data-index="${index}">${esc(t.exportDoc)}</button>${['chart', 'moodboard'].includes(artifact.type) ? `<button type="button" class="btn btn-sm" data-export="png" data-index="${index}">${esc(t.exportImage)}</button>` : ''}<button type="button" class="btn btn-sm" data-export="print" data-index="${index}">${esc(t.exportPrint)}</button></div></div>`).join('')}</section>`);
      if (item.kind === 'office') parts.push(report?.text ? `<section class="dl-d-section"><h3>${esc(t.report)}</h3><div class="md dl-report" dir="auto">${renderMarkdown(report.text)}</div></section>` : item.status === 'in_progress' || item.status === 'waiting' ? '' : `<p class="muted small">${esc(t.noReport)}</p>`);
    }
    if (isLatest && item.version?.count > 1) parts.push(`<section class="dl-d-section"><h3>${esc(t.versions)}</h3><ol class="dl-versions">${item.version.list.map((entry) => `<li><button type="button" class="dl-version" data-version="${esc(entry.key)}" ${entry.delivered ? '' : 'disabled'}><b>${esc(t.version(entry.number, item.version.count))}</b>${entry.revision ? ` <span class="tag muted">${esc(t.revision)}</span>` : ''}<span class="xs faint">${esc(entry.delivered ? when(entry.at) : t.status.in_progress)}</span></button></li>`).join('')}</ol></section>`);
    const links = [item.links?.workflow ? `<a href="${esc(item.links.workflow)}">${esc(t.openWorkflow)}</a>` : '', item.links?.chat ? `<a href="${esc(item.links.chat)}">${esc(t.openChat)}</a>` : ''].filter(Boolean);
    if (links.length) parts.push(`<p class="dl-links small">${links.join('<span aria-hidden="true">·</span>')}</p>`);
    return parts.join('');
  }

  function wireExports(root, item, extra) {
    const artifacts = item.kind === 'artifact' ? item.artifacts : (extra?.artifacts || item.artifacts || []);
    root.querySelectorAll('[data-export]').forEach((button) => { button.onclick = async () => {
      const artifact = artifacts[Number(button.dataset.index)];
      const holder = root.querySelector(`[data-artifact="${button.dataset.index}"]`);
      try {
        if (button.dataset.export === 'csv') download(fileName(artifact, 'csv'), `﻿${toCsv(artifact)}`, 'text/csv;charset=utf-8');
        if (button.dataset.export === 'md') download(fileName(artifact, 'md'), toMarkdown(artifact), 'text/markdown;charset=utf-8');
        if (button.dataset.export === 'print') printArtifact(holder.querySelector('.artifact').outerHTML, artifact.title || '');
        if (button.dataset.export === 'png') {
          const styles = getComputedStyle(document.documentElement);
          const background = styles.getPropertyValue('--surface').trim();
          const blob = artifact.type === 'chart' ? await svgToPng(holder.querySelector('.art-chart svg'), { background }) : await moodboardPng(artifact, { background, ink: styles.getPropertyValue('--text').trim() });
          download(fileName(artifact, 'png'), blob, 'image/png');
        }
      } catch (error) { ctx.toast(`${t.exportFailed}: ${error.message}`); }
    }; });
  }

  // AUDIT → owner: a finding goes back to the employee who owns the fix.
  function wireSendOwner(root, panel) {
    root.querySelectorAll('[data-send-owner]').forEach((button) => {
      const owner = button.dataset.sendOwner;
      if (!ctx.directSlugs?.[owner]) return;
      button.hidden = false;
      button.onclick = async () => {
        if (!(await ctx.confirmDialog(t.sendFinding(owner.toUpperCase()), t.sendFindingBody))) return;
        try {
          const message = `AUDIT finding for you: ${button.dataset.issue}${button.dataset.detail ? ` — ${button.dataset.detail}` : ''}. Please propose the fix.`;
          const created = await ctx.api('/api/conversations', { method: 'POST', body: { workspaceId: id, message, agentSlug: ctx.directSlugs[owner] } });
          panel.close();
          location.hash = `#/chat/${created.conversation.id}`;
        } catch (error) { ctx.toast(error.message); }
      };
    });
  }

  // ---------------------------------------------------------------- decisions
  async function review(item, change) {
    const result = await ctx.api('/api/deliverables/review', { method: 'POST', body: { workspaceId: id, key: item.key, ...change } });
    item.review = result.review;
    return result.review;
  }

  function drawDecisions(panel, item, extra) {
    const holder = panel.element.querySelector('#dlDecide');
    const reviewsOn = Boolean(head.reviews?.available);
    const delivered = ['ready', 'needs_fahad', 'needs_review'].includes(item.status) && item.kind !== 'coding' ? true : item.kind === 'coding' && item.deliveredAt && ['ready', 'needs_review'].includes(item.status);
    const decided = item.review?.decision && item.review.decisionKey === item.key ? item.review.decision : null;
    const pinned = Boolean(item.review?.pinned);
    const archived = Boolean(item.review?.archived);
    const directSlug = Object.values(ctx.directSlugs || {}).includes(item.agent.slug) ? item.agent.slug : null;
    const who = directSlug ? item.agent.label : 'CHIEF';
    const blocks = [];

    // CODING: the real owner actions of the session come first.
    if (item.kind === 'coding' && extra?.task) {
      const task = extra.task;
      const pendingApprovals = (extra.approvals || []).filter((approval) => approval.status === 'pending');
      if (pendingApprovals.length) blocks.push(pendingApprovals.map((approval) => `<div class="dl-ask"><p dir="auto"><strong>${esc(approval.card?.what || approval.summary || '')}</strong></p>${approval.card?.why && approval.card.why !== approval.card.what ? `<p class="small muted" dir="auto">${esc(approval.card.why)}</p>` : ''}<span class="risk ${esc(approval.risk || 'medium')}">${esc(t.coding.risk[approval.risk] || String(approval.risk || 'medium').toUpperCase())}</span><div class="row"><button type="button" class="btn btn-primary" data-approval="approved" data-id="${esc(approval.id)}">${esc(t.approveMerge)}</button><button type="button" class="btn btn-danger" data-approval="rejected" data-id="${esc(approval.id)}">${esc(t.reject)}</button></div></div>`).join(''));
      else if (task.needs?.kind === 'question') blocks.push(`<div class="dl-ask"><p dir="auto"><strong>${esc(task.needs.question)}</strong></p><label class="field-label" for="dlReply">${esc(t.answer)}</label><textarea id="dlReply" class="input" rows="3" dir="auto"></textarea><div class="row"><button type="button" class="btn btn-primary" data-reply>${esc(t.reply)}</button></div></div>`);
      else if (task.needs?.kind === 'blocked') blocks.push(`<div class="dl-ask"><p dir="auto">${esc(task.needs.explanation)}</p><label class="field-label" for="dlReply">${esc(t.messageCoding)}</label><textarea id="dlReply" class="input" rows="2" dir="auto"></textarea><div class="row"><button type="button" class="btn btn-primary" data-resume>${esc(t.resume)}</button><button type="button" class="btn" data-reply>${esc(t.reply)}</button></div></div>`);
    }
    if (!delivered && item.kind !== 'coding') blocks.push(`<p class="small muted">${esc(item.status === 'in_progress' ? t.pendingNote(item.agent.label) : item.status === 'waiting' ? t.waitingNote : t.blockedNote)}</p>`);

    const buttons = [];
    if (delivered) {
      if (decided === 'approved') buttons.push(`<span class="dl-decided">✓ ${esc(t.approved)}</span><button type="button" class="btn btn-ghost btn-sm" data-undo ${reviewsOn ? '' : 'disabled'}>${esc(t.undo)}</button>`);
      else buttons.push(`<button type="button" class="btn btn-success" data-approve ${reviewsOn ? '' : 'disabled'}>${esc(t.approve)}</button>`);
      buttons.push(`<button type="button" class="btn" data-revision>${esc(t.requestRevision)}</button>`);
      if (item.kind !== 'coding') buttons.push(`<button type="button" class="btn btn-ghost" data-continue>${esc(t.continueChief)}</button>`);
    }
    if (item.kind === 'office' && item.status === 'blocked' && item.links?.chat) buttons.push(`<a class="btn" href="${esc(item.links.chat)}">${esc(t.openChat)}</a>`);
    buttons.push(`<button type="button" class="btn btn-ghost" data-pin aria-pressed="${pinned}" ${reviewsOn ? '' : 'disabled'}>${pinned ? '★ ' : '☆ '}${esc(pinned ? t.unpin : t.pin)}</button>`);
    buttons.push(`<button type="button" class="btn btn-ghost" data-archive ${reviewsOn ? '' : 'disabled'}>${esc(archived ? t.restore : t.archive)}</button>`);
    holder.innerHTML = `<section class="dl-decide" aria-label="${esc(t.yourDecision)}"><h3 class="dl-decide-title">${esc(t.yourDecision)}</h3>${blocks.join('')}<div class="dl-decide-row">${buttons.join('')}</div><div id="dlInline"></div>${reviewsOn ? '' : `<p class="xs muted dl-off">${esc(t.reviewsOff)}</p>`}</section>`;
    const inline = holder.querySelector('#dlInline');
    const after = (message) => { ctx.toast(message); redraw(); drawDecisions(panel, item, extra); };
    const guard = async (button, work) => { button.disabled = true; try { await work(); } catch (error) { ctx.toast(error.message); button.disabled = false; } };

    holder.querySelectorAll('[data-approval]').forEach((button) => { button.onclick = () => guard(button, async () => {
      const decision = button.dataset.approval;
      const note = decision === 'rejected' ? await ctx.ask(language === 'en' ? 'Reason for rejection (optional)' : 'سبب الرفض (اختياري)', '', true) : null;
      if (decision === 'rejected' && note === null) { button.disabled = false; return; }
      await ctx.api(`/api/approvals/${button.dataset.id}`, { method: 'POST', body: { decision, note: note || undefined } });
      ctx.toast(decision === 'approved' ? t.approvedToast : (language === 'en' ? 'Rejected' : 'تم الرفض'));
      await refresh();
      const next = findItem(item.key);
      if (next) await fillDrawer(panel, next);
    }); });
    holder.querySelector('[data-reply]')?.addEventListener('click', (event) => guard(event.currentTarget, async () => {
      const message = holder.querySelector('#dlReply')?.value.trim();
      if (!message) throw new Error(language === 'en' ? 'Write your message first.' : 'اكتب رسالتك أول.');
      await ctx.api(`/api/tasks/${item.coding.taskId}/reply`, { method: 'POST', body: { message } });
      ctx.toast(t.replySent); await refresh(); const next = findItem(item.key); if (next) await fillDrawer(panel, next);
    }));
    holder.querySelector('[data-resume]')?.addEventListener('click', (event) => guard(event.currentTarget, async () => {
      const message = holder.querySelector('#dlReply')?.value.trim();
      if (message) await ctx.api(`/api/tasks/${item.coding.taskId}/reply`, { method: 'POST', body: { message } });
      else await ctx.api(`/api/tasks/${item.coding.taskId}/resume`, { method: 'POST' });
      ctx.toast(t.replySent); await refresh(); const next = findItem(item.key); if (next) await fillDrawer(panel, next);
    }));
    holder.querySelector('[data-pin]')?.addEventListener('click', (event) => guard(event.currentTarget, async () => { await review(item, { pinned: !pinned }); after(pinned ? t.unpinnedToast : t.pinnedToast); }));
    holder.querySelector('[data-archive]')?.addEventListener('click', (event) => guard(event.currentTarget, async () => { await review(item, { archived: !archived }); after(archived ? t.restoredToast : t.archivedToast); }));
    holder.querySelector('[data-undo]')?.addEventListener('click', (event) => guard(event.currentTarget, async () => { await review(item, { decision: null }); await refresh(); const next = findItem(item.key); if (next) drawDecisions(panel, next, extra); }));
    holder.querySelector('[data-approve]')?.addEventListener('click', () => {
      inline.innerHTML = `<form class="dl-inline" id="dlApprove"><h4>${esc(t.approveTitle)}</h4>${item.decisions ? `<p class="small" dir="auto">${esc(item.decisions)}</p><label class="check"><input type="checkbox" id="dlMemory" checked> <span>${esc(t.saveDecision)}</span></label>` : ''}<label class="field-label" for="dlNote">${esc(t.noteOptional)}</label><textarea id="dlNote" class="input" rows="2" dir="auto"></textarea><div class="row"><button type="submit" class="btn btn-success">${esc(t.confirmApprove)}</button><button type="button" class="btn btn-ghost" data-cancel>${esc(t.cancel)}</button></div></form>`;
      inline.querySelector('[data-cancel]').onclick = () => { inline.innerHTML = ''; };
      inline.querySelector('#dlNote').focus();
      inline.querySelector('#dlApprove').onsubmit = (event) => { event.preventDefault(); guard(event.submitter, async () => {
        const note = inline.querySelector('#dlNote').value.trim();
        await review(item, { decision: 'approved', note });
        if (item.decisions && inline.querySelector('#dlMemory')?.checked) await ctx.api(`/api/projects/${id}/memory`, { method: 'POST', body: { kind: 'decision', content: t.memoryDecision(item.decisions, item.title).slice(0, 2000) } });
        await refresh();
        const next = findItem(item.key) || item;
        ctx.toast(t.approvedToast);
        await fillDrawer(panel, next);
      }); };
    });
    holder.querySelector('[data-revision]')?.addEventListener('click', () => {
      if (item.kind === 'coding') {
        try { sessionStorage.setItem('hub-coding-draft', t.codingDraft(item.title, item.coding?.pr?.number)); } catch {}
        panel.close(); location.hash = '#/code'; return;
      }
      inline.innerHTML = `<form class="dl-inline" id="dlRevise"><h4>${esc(t.revisionTitle)}</h4><textarea id="dlRevision" class="input" rows="3" dir="auto" required minlength="3"></textarea><p class="xs muted">${esc(t.revisionHint(who))}</p><div class="row"><button type="submit" class="btn btn-primary">${esc(t.send(who))}</button><button type="button" class="btn btn-ghost" data-cancel>${esc(t.cancel)}</button></div></form>`;
      inline.querySelector('[data-cancel]').onclick = () => { inline.innerHTML = ''; };
      inline.querySelector('#dlRevision').focus();
      inline.querySelector('#dlRevise').onsubmit = (event) => { event.preventDefault(); guard(event.submitter, async () => {
        const note = inline.querySelector('#dlRevision').value.trim();
        if (note.length < 3) throw new Error(t.revisionTitle);
        const message = t.revisionMessage(item.title, typeLabel(item.type, language), note, item.summary).slice(0, 7800);
        const created = await ctx.api('/api/conversations', { method: 'POST', body: { workspaceId: id, message, ...(directSlug ? { agentSlug: directSlug } : {}) } });
        if (reviewsOn) await review(item, { decision: 'revision_requested', note }).catch(() => null);
        await refresh();
        ctx.toast(t.revisionSent(who));
        inline.innerHTML = `<p class="small">${esc(t.revisionSent(who))} · <a href="#/chat/${esc(created.conversation.id)}">${esc(t.openChat)}</a></p>`;
      }); };
    });
    holder.querySelector('[data-continue]')?.addEventListener('click', () => {
      try { sessionStorage.setItem('hub-chief-draft', t.chiefDraft(item.title, item.agent.label)); } catch {}
      panel.close(); location.hash = '#/chief';
    });
  }
}
