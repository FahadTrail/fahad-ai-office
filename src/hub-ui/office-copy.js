// The Office's words in Arabic (default) and English. Pure; tested in Node.
// Employee names stay as the roster writes them (CHIEF, CODING…); the
// department names carry their numbers ("04 Coding", "04 البرمجة").
import { ZONES } from './office3d/plan.js?v=__UI_VERSION__';

const EN = {
  title: 'The Office', live: 'Live — every state comes from real work', reconnecting: 'Reconnecting… showing the latest known state',
  ask: 'Ask CHIEF… e.g. «خل Legal يراجع»', askLabel: 'Ask CHIEF', send: 'Send',
  stage: 'The Office, in 3D', views: 'Views', overview: 'Overview', chief: 'CHIEF', departments: 'Departments', handoffs: 'Handoffs', summary: 'Summary',
  project: 'Project', allProjects: 'All projects', mode: 'Lighting', light: 'Light', immersive: 'Immersive', auto: 'Auto',
  search: 'Search', notifications: 'Needs you', liveShort: 'Live', offlineShort: 'Reconnecting',
  working: 'Working', needs: 'Needs you', blocked: 'Blocked', delivered: 'Delivered today',
  loading: 'Entering the Office', loadingEngine: 'Loading the 3D engine…', loadingBuild: 'Building the Office…', loadingMaterials: 'Bringing in the materials…', ready: 'Ready', useSimplified: 'Use the simplified Office',
  model: 'Model', duration: 'Duration', cost: 'Cost', tokens: 'Tokens', unavailable: 'Unavailable', pipeline: 'Pipeline', chain: 'Handoff chain', deliveries: 'Last 5 deliveries',
  noTask: 'No task assigned right now.', noChain: 'No handoffs in this objective yet.', noDeliveries: 'No deliveries in the last 30 days.', currentTask: 'Current task',
  openWorkspace: 'Open full workspace', openObjective: 'Open the objective', message: 'Message', askChief: 'Ask CHIEF', giveCoding: 'Give CODING a task', close: 'Close',
  from: 'From', bundled: (n) => `×${n}`, allClear: 'All clear', today: 'Today', activeObjectives: 'Active objectives', latestDeliveries: 'Latest deliveries', handoffsToday: 'Handoffs today',
  noHandoffs: 'No handoffs in the last 24 hours.', handoffList: 'Handoffs in the last 24 hours', capacity: (names, at) => `Model capacity is busy — ${names} ${at ? `resume automatically around ${at}` : 'resume automatically'}.`,
  offline: (names) => `${names} ${names.includes(',') ? 'are' : 'is'} turned off.`, queue: (n) => `Queue ${n}`,
  handedOver: (from, to) => `${from} → ${to}`, deliveredToast: (who, what) => `${who} delivered ${what}`, needsToast: (who) => `${who} needs you`, blockedToast: (who) => `${who} is blocked`,
  simplifiedNote: 'Simplified Office', reasons: { webgl: 'This browser cannot draw 3D (WebGL unavailable).', small: 'The 3D Office needs a larger screen.', coarse: 'Touch devices use the simplified Office.', weak: 'This device draws 3D in software, so the simplified Office is faster here.', chosen: 'You chose the simplified Office.', stopped: 'The 3D Office stopped; showing the simplified Office.', slow: 'This device is too slow for the 3D Office; showing the simplified Office.', failed: 'The 3D Office could not start here; showing the simplified Office.' },
  objectives: 'Objectives', timeline: 'Timeline', wall: { pipeline: 'Pipeline', today: 'Today', stream: 'Stream', allClear: 'All clear', working: 'Working', needs: 'Needs you', blocked: 'Blocked', delivered: 'Delivered today' },
  states: { AVAILABLE: 'Available', QUEUED: 'Up next', THINKING: 'Thinking', WORKING: 'Working', TESTING: 'Testing', REVIEWING: 'Reviewing', WAITING: 'Waiting', 'NEEDS FAHAD': 'Needs you', BLOCKED: 'Blocked', COMPLETED: 'Delivered', FAILED: 'Failed', RESEARCHING: 'Researching', DESIGNING: 'Designing', 'UP NEXT': 'Up next', OFFLINE: 'Turned off' },
  steps: { working: 'Working', waiting: 'Waiting', ready: 'Ready', capacity: 'Waiting for capacity', done: 'Done', failed: 'Failed', blocked: 'Blocked' },
};

const AR = {
  title: 'المكتب', live: 'مباشر — كل حالة من شغل حقيقي', reconnecting: 'نعيد الاتصال… نعرض آخر حالة معروفة',
  ask: 'اطلب من CHIEF… مثلاً «خل Legal يراجع»', askLabel: 'اطلب من CHIEF', send: 'أرسل',
  stage: 'المكتب ثلاثي الأبعاد', views: 'العروض', overview: 'نظرة عامة', chief: 'CHIEF', departments: 'الأقسام', handoffs: 'التسليمات', summary: 'الملخص',
  project: 'المشروع', allProjects: 'كل المشاريع', mode: 'الإضاءة', light: 'نهار', immersive: 'غامر', auto: 'تلقائي',
  search: 'بحث', notifications: 'ينتظرك', liveShort: 'مباشر', offlineShort: 'نعيد الاتصال',
  working: 'يشتغلون', needs: 'ينتظرك', blocked: 'متوقف', delivered: 'سُلّم اليوم',
  loading: 'ندخل المكتب', loadingEngine: 'نحمّل محرك العرض…', loadingBuild: 'نبني المكتب…', loadingMaterials: 'نجهّز الخامات…', ready: 'جاهز', useSimplified: 'استخدم المكتب المبسّط',
  model: 'النموذج', duration: 'المدة', cost: 'التكلفة', tokens: 'الرموز', unavailable: 'غير متاح', pipeline: 'مسار العمل', chain: 'سلسلة التسليم', deliveries: 'آخر ٥ تسليمات',
  noTask: 'ما في مهمة الحين.', noChain: 'ما في تسليمات في هذا الهدف بعد.', noDeliveries: 'ما في تسليمات في آخر ٣٠ يوم.', currentTask: 'المهمة الحالية',
  openWorkspace: 'افتح مساحة العمل كاملة', openObjective: 'افتح الهدف', message: 'راسله', askChief: 'اطلب من CHIEF', giveCoding: 'أعط CODING مهمة', close: 'إغلاق',
  from: 'من', bundled: (n) => `×${n}`, allClear: 'كل شي طيب', today: 'اليوم', activeObjectives: 'الأهداف الجارية', latestDeliveries: 'آخر التسليمات', handoffsToday: 'تسليمات اليوم',
  noHandoffs: 'ما في تسليمات في آخر ٢٤ ساعة.', handoffList: 'التسليمات في آخر ٢٤ ساعة', capacity: (names, at) => `سعة النماذج مشغولة — ${names} يكمل تلقائيًا${at ? ` حوالي ${at}` : ''}.`,
  offline: (names) => `${names} موقوف.`, queue: (n) => `بالدور ${n}`,
  handedOver: (from, to) => `${from} ← ${to}`, deliveredToast: (who, what) => `${who} سلّم ${what}`, needsToast: (who) => `${who} ينتظرك`, blockedToast: (who) => `${who} متوقف`,
  simplifiedNote: 'المكتب المبسّط', reasons: { webgl: 'هذا المتصفح ما يدعم العرض ثلاثي الأبعاد.', small: 'المكتب ثلاثي الأبعاد يحتاج شاشة أكبر.', coarse: 'الأجهزة اللمسية تستخدم المكتب المبسّط.', weak: 'هذا الجهاز يرسم ثلاثي الأبعاد برمجيًا، فالمبسّط أسرع هنا.', chosen: 'اخترت المكتب المبسّط.', stopped: 'توقف العرض ثلاثي الأبعاد؛ نعرض المكتب المبسّط.', slow: 'الجهاز بطيء على العرض ثلاثي الأبعاد؛ نعرض المكتب المبسّط.', failed: 'ما قدرنا نشغّل العرض ثلاثي الأبعاد هنا؛ نعرض المكتب المبسّط.' },
  objectives: 'الأهداف', timeline: 'الخط الزمني', wall: { pipeline: 'المسار', today: 'اليوم', stream: 'آخر الأحداث', allClear: 'كل شي طيب', working: 'يشتغلون', needs: 'ينتظرك', blocked: 'متوقف', delivered: 'سُلّم اليوم' },
  states: { AVAILABLE: 'متاح', QUEUED: 'التالي', THINKING: 'يفكر', WORKING: 'يشتغل', TESTING: 'يختبر', REVIEWING: 'يراجع', WAITING: 'ينتظر', 'NEEDS FAHAD': 'ينتظرك', BLOCKED: 'متوقف', COMPLETED: 'سلّم', FAILED: 'تعثّر', RESEARCHING: 'يبحث', DESIGNING: 'يصمم', 'UP NEXT': 'التالي', OFFLINE: 'موقوف' },
  steps: { working: 'يشتغل', waiting: 'ينتظر', ready: 'جاهز', capacity: 'ينتظر السعة', done: 'تم', failed: 'تعثّر', blocked: 'متوقف' },
};

export const COPY = Object.freeze({ en: EN, ar: AR });
export function copyFor(language) { return language === 'en' ? EN : AR; }

// "04 Coding" / "04 البرمجة"
export function departmentName(key, language) {
  const zone = ZONES[key];
  if (!zone) return String(key || '').toUpperCase();
  return `${zone.number} ${language === 'en' ? zone.name : zone.nameAr}`;
}

// The state word for a visual state; "WAITING FOR CREATIVE" keeps the name.
export function stateLabel(visual, language) {
  const copy = copyFor(language);
  const value = String(visual || 'AVAILABLE');
  const waitingFor = value.match(/^WAITING FOR (.+)$/);
  if (waitingFor) return language === 'en' ? `Waiting for ${waitingFor[1]}` : `ينتظر ${waitingFor[1]}`;
  return copy.states[value] || value.charAt(0) + value.slice(1).toLowerCase();
}

// Money, tokens and durations, honestly: null reads "Unavailable".
export function formatCost(value, language) {
  if (value == null || !Number.isFinite(Number(value))) return copyFor(language).unavailable;
  const number = Number(value);
  return `$${number < 0.01 && number > 0 ? number.toFixed(4) : number.toFixed(2)}`;
}
export function formatTokens(input, output, language) {
  if (input == null && output == null) return copyFor(language).unavailable;
  const short = (value) => (value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}k` : String(value));
  return `${short(Number(input || 0))} ↓ · ${short(Number(output || 0))} ↑`;
}
export function formatDuration(ms, language) {
  if (ms == null || !Number.isFinite(Number(ms))) return copyFor(language).unavailable;
  const seconds = Math.round(Number(ms) / 1000);
  const [h, m, s] = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
  if (language === 'en') return h ? `${h} h ${m} min` : m ? `${m} min ${s} s` : `${s} s`;
  return h ? `${h} س ${m} د` : m ? `${m} د ${s} ث` : `${s} ث`;
}
