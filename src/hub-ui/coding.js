// CODING workspace (V5.3): development work as a calm, chat-like thread —
// Fahad's request, what CODING did, the output and the next decision. Models,
// tokens, iterations, routes and the raw event log stay under Advanced.
// Loaded on demand. Every line is derived from the session, its events and
// its approvals (/api/tasks); owner actions use the existing endpoints.
import { roleMark } from './characters.js?v=__UI_VERSION__';
import { escapeHtml as esc, renderMarkdown } from './markdown.js';
import { errorBlock } from './humanize.js';

const CLOSED = new Set(['completed', 'failed', 'cancelled']);
const DRAFT_KEY = 'hub-coding-draft';
const LAUNCH_MARKER = '\nOriginal objective from Fahad:';

const WORDS = {
  en: {
    back: 'CODING', kicker: 'CODING', heading: 'What do you want me to build or fix?', sub: 'CODING plans, builds and tests. Protected actions still need your approval.',
    placeholder: 'Describe the change, the problem or the feature. Include acceptance criteria if you have them.', start: 'Start task', starting: 'Starting…',
    options: 'Options', repository: 'Repository (owner/name)', budget: 'Budget (USD)', routing: 'Model routing', auto: 'AUTO (recommended)', economy: 'Economy — free and cheapest first',
    balanced: 'Balanced', quality: 'Quality — strongest first', testCommand: 'Test command (auto-detected when empty)', deploy: 'Merge & deploy after CI passes (the merge always asks for your approval)',
    noRepo: 'not set', budgetLine: 'AUTO routing · budget', needsYou: 'Needs you', inProgress: 'In progress', recent: 'Recent', allTasks: 'All tasks',
    emptyActive: 'Nothing is running. Describe a task above to start one.', emptyRecent: 'Finished tasks appear here.',
    state: { needs: 'Needs you', working: 'Working', queued: 'Queued', paused: 'Paused', done: 'Done', failed: 'Stopped', cancelled: 'Cancelled' },
    tabs: { overview: 'Overview', activity: 'Activity', files: 'Files', approvals: 'Approvals' },
    you: 'You', chiefForYou: 'CHIEF, for you', showMore: 'Show more', showLess: 'Show less', plan: 'Plan', planDone: (done, all) => `${done} of ${all} done`,
    latestNote: 'Latest from CODING', recentSteps: 'What happened', allActivity: 'All activity', noActivity: 'No activity yet.', result: 'Result', progressSoFar: 'Output so far',
    noResult: 'The summary appears here when the task finishes.', noSummary: 'CODING left no written summary for this task.', noActivityClosed: 'No step-by-step activity was recorded for this task.',
    ciWord: { success: 'passed', failure: 'failed', pending: 'running' }, next: 'Next', nextStep: (text) => `Next: ${text}`, doneNothing: 'Done. Nothing needs you.',
    followUp: 'Start a follow-up task', followUpDraft: (title) => `Follow-up to “${title}”: `, openPr: (n) => `PR #${n}`, prLabel: 'Pull request', ci: 'CI', tests: 'Tests', deployment: 'Deployment',
    passing: 'Passing', failing: 'Failing', notRequested: 'Not requested', pending: 'Pending', none: '—', files: (n) => `Files changed (${n})`, noFiles: 'No files changed yet.',
    approvalsEmpty: 'CODING has not asked for any approval in this task.', asking: 'CODING is asking', why: 'Why:', affects: 'Affects', approve: 'Approve', reject: 'Reject',
    approvedAt: (w) => `Approved ${w}`, rejectedAt: (w) => `Rejected ${w}`, protectedNote: 'Approving allows changes to exactly these files in this task only. Secrets, .env files, keys and Hermes can never be approved.',
    composer: 'Message CODING…', composerHint: 'CODING reads your message at its next step.', send: 'Send', answer: 'Your answer', answerPlaceholder: 'Type your answer…',
    instructions: 'Instructions for CODING (optional)', instructionsPlaceholder: 'e.g. try a smaller change, or skip the docs update', reply: 'Reply &amp; Continue', resumePlain: 'Resume without a message',
    jumpLead: 'Needs you: ', jumpGo: 'Go to the decision', risk: { low: 'LOW', medium: 'MEDIUM', high: 'HIGH', critical: 'CRITICAL' },
    closedNote: 'This task is finished.', more: 'More', openChat: 'Open chat', cancel: 'Cancel task', cancelTitle: 'Cancel this task?', cancelBody: 'The agent stops at its next checkpoint. Work already pushed stays on its branch.',
    advanced: 'Advanced & diagnostics', stages: 'Stages', engine: 'Engine & cost', model: 'Model', cost: 'Cost', of: 'of', elapsed: 'Elapsed', updated: 'Updated',
    calls: 'Model calls', iterations: 'Iterations', inputTokens: 'Input tokens', outputTokens: 'Output tokens', cached: 'cached', switches: 'Model switches', trimmed: 'Context trimmed',
    modelsUsed: 'Models used', branches: 'Branches', original: 'Original instruction', events: (n) => `View details (${n} events)`,
    sent: 'Sent — the same task continues', resumed: 'Resumed', approvedToast: 'Approved — the task continues', rejectedToast: 'Rejected — the agent will adapt',
    rejectReason: 'Reject — tell the agent why (optional)', writeFirst: 'Write your message first', cancelled: 'Cancelled',
  },
  ar: {
    back: 'CODING', kicker: 'CODING', heading: 'شو تبغي نطوّر أو نصلح؟', sub: 'CODING يخطط ويطوّر ويختبر. الإجراءات المحمية تبقى بحاجة لموافقتك.',
    placeholder: 'وصف التغيير أو المشكلة أو الميزة. اكتب معايير القبول إذا عندك.', start: 'ابدأ المهمة', starting: 'جارٍ البدء…',
    options: 'خيارات', repository: 'المستودع (owner/name)', budget: 'الميزانية (دولار)', routing: 'توجيه المودلات', auto: 'تلقائي (موصى به)', economy: 'اقتصادي — المجاني والأرخص أولًا',
    balanced: 'متوازن', quality: 'الجودة — الأقوى أولًا', testCommand: 'أمر الاختبار (يُكتشف تلقائيًا إذا تركته فاضي)', deploy: 'ادمج وانشر بعد نجاح CI (الدمج دايمًا يطلب موافقتك)',
    noRepo: 'غير محدد', budgetLine: 'توجيه تلقائي · ميزانية', needsYou: 'يحتاجك', inProgress: 'قيد التنفيذ', recent: 'الأخيرة', allTasks: 'كل المهام',
    emptyActive: 'ما في شي شغال. اكتب مهمة فوق عشان تبدأ.', emptyRecent: 'المهام المكتملة بتظهر هني.',
    state: { needs: 'يحتاجك', working: 'يشتغل', queued: 'بالانتظار', paused: 'متوقف مؤقتًا', done: 'مكتمل', failed: 'توقف', cancelled: 'ملغي' },
    tabs: { overview: 'نظرة عامة', activity: 'النشاط', files: 'الملفات', approvals: 'الموافقات' },
    you: 'أنت', chiefForYou: 'CHIEF بالنيابة عنك', showMore: 'اعرض أكثر', showLess: 'اعرض أقل', plan: 'الخطة', planDone: (done, all) => `${done} من ${all} خلصت`,
    latestNote: 'آخر كلام من CODING', recentSteps: 'شو صار', allActivity: 'كل النشاط', noActivity: 'ما في نشاط بعد.', result: 'النتيجة', progressSoFar: 'المخرج لين الحين',
    noResult: 'الملخص يظهر هني بعد ما تخلص المهمة.', noSummary: 'CODING ما ترك ملخص مكتوب لهذي المهمة.', noActivityClosed: 'ما انحفظ نشاط خطوة بخطوة لهذي المهمة.',
    ciWord: { success: 'نجحت', failure: 'فشلت', pending: 'شغالة' }, next: 'الخطوة الياية', nextStep: (text) => `الخطوة الياية: ${text}`, doneNothing: 'خلصت. ما في شي ينتظرك.',
    followUp: 'ابدأ مهمة متابعة', followUpDraft: (title) => `متابعة لـ«${title}»: `, openPr: (n) => `PR #${n}`, prLabel: 'طلب الدمج', ci: 'فحوصات CI', tests: 'الاختبارات', deployment: 'النشر',
    passing: 'ناجحة', failing: 'فاشلة', notRequested: 'غير مطلوب', pending: 'بانتظار', none: '—', files: (n) => `الملفات المتغيرة (${n})`, noFiles: 'ما تغيرت ملفات بعد.',
    approvalsEmpty: 'CODING ما طلب أي موافقة في هذي المهمة.', asking: 'CODING يطلب', why: 'السبب:', affects: 'يؤثر على', approve: 'موافقة', reject: 'رفض',
    approvedAt: (w) => `انوافق عليه ${w}`, rejectedAt: (w) => `انرفض ${w}`, protectedNote: 'الموافقة تسمح بتغيير هذي الملفات بالضبط في هذي المهمة فقط. الأسرار وملفات .env والمفاتيح وHermes ما تنوافق عليها أبدًا.',
    composer: 'اكتب رسالتك…', composerHint: 'CODING يقرأ رسالتك في خطوته الياية.', send: 'إرسال', answer: 'جوابك', answerPlaceholder: 'اكتب جوابك…',
    instructions: 'تعليمات لـCODING (اختياري)', instructionsPlaceholder: 'مثلًا: جرّب تغيير أصغر، أو اترك تحديث التوثيق', reply: 'رد وكمّل', resumePlain: 'كمّل بدون رسالة',
    jumpLead: 'يحتاجك: ', jumpGo: 'روح للقرار', risk: { low: 'منخفض', medium: 'متوسط', high: 'عالي', critical: 'حرج' },
    closedNote: 'هذي المهمة خلصت.', more: 'المزيد', openChat: 'افتح المحادثة', cancel: 'ألغِ المهمة', cancelTitle: 'تلغي هذي المهمة؟', cancelBody: 'الوكيل يوقف عند أقرب نقطة حفظ. الشغل اللي انرفع يبقى على فرعه.',
    advanced: 'تفاصيل متقدمة وتشخيص', stages: 'المراحل', engine: 'المحرك والتكلفة', model: 'المحرك', cost: 'التكلفة', of: 'من', elapsed: 'المدة', updated: 'آخر تحديث',
    calls: 'استدعاءات المودل', iterations: 'الجولات', inputTokens: 'توكنات الإدخال', outputTokens: 'توكنات الإخراج', cached: 'مخزّن', switches: 'تبديل المودل', trimmed: 'السياق المختصر',
    modelsUsed: 'المودلات المستخدمة', branches: 'الفروع', original: 'الطلب الأصلي', events: (n) => `التفاصيل (${n} حدث)`,
    sent: 'انرسل — نفس المهمة تكمل', resumed: 'كمّلت المهمة', approvedToast: 'تمت الموافقة — المهمة تكمل', rejectedToast: 'تم الرفض — الوكيل بيعدّل طريقته',
    rejectReason: 'رفض — قول للوكيل السبب (اختياري)', writeFirst: 'اكتب رسالتك أول', cancelled: 'انلغت',
  },
};
export const codingWords = (language) => (language === 'en' ? WORDS.en : WORDS.ar);

// One owner-facing state for a session (the same rules as the Hub's attention).
export function codingState(task) {
  if (task.needs?.kind === 'approval' || task.needs?.kind === 'question') return 'needs';
  if (task.needs?.kind === 'blocked' || task.status === 'blocked') return 'paused';
  if (task.status === 'completed') return 'done';
  if (task.status === 'failed') return 'failed';
  if (task.status === 'cancelled') return 'cancelled';
  if (task.status === 'queued') return 'queued';
  if (task.status === 'awaiting_approval') return 'needs';
  return 'working';
}

const PHASES = {
  understand: ['Reading the code to understand the task', 'يقرأ الكود عشان يفهم المهمة'], plan: ['Planning the change', 'يخطط للتغيير'],
  implement: ['Editing the code', 'يعدّل الكود'], test: ['Testing the change', 'يختبر التغيير'], debug: ['Fixing a failing check', 'يصلح فحص فاشل'],
  review: ['Reviewing the change', 'يراجع التغيير'], publish: ['Opening the pull request', 'يفتح طلب الدمج'], ci: ['Waiting for CI checks', 'ينتظر فحوصات CI'],
  deploy: ['Deploying', 'ينشر'], verify: ['Verifying production', 'يتحقق من الإنتاج'], report: ['Writing the summary', 'يكتب الملخص'], done: ['Finished', 'خلص'],
};

// The readable story of a session: only events an owner cares about, in
// order, each with a tone. Routes, tokens, tool calls and guards are left to
// Advanced. Pure.
export function codingActivity(events = [], approvals = []) {
  const entries = [];
  const push = (entry, at) => entries.push({ ...entry, at: at || null });
  for (const event of [...events].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || Number(a.id || 0) - Number(b.id || 0))) {
    const message = String(event.message || '');
    const at = event.createdAt;
    switch (event.type) {
      case 'session':
        if (/session started/i.test(message)) push({ code: 'started', tone: 'done' }, at);
        else if (/^Resumed from checkpoint/i.test(message)) push({ code: 'resumed', tone: 'done' }, at);
        break;
      case 'phase': {
        const phase = event.payload?.phase || message.match(/^Phase: (\w+)/)?.[1];
        if (PHASES[phase]) push({ code: 'phase', phase, tone: 'done' }, at);
        break;
      }
      case 'plan': push({ code: 'plan', count: Array.isArray(event.payload?.plan) ? event.payload.plan.length : null, tone: 'done' }, at); break;
      case 'test':
        if (/Finish gate passed/i.test(message)) push({ code: 'checks_passed', tone: 'done' }, at);
        else if (/no repository changes/i.test(message)) push({ code: 'no_changes', tone: 'done' }, at);
        else push({ code: 'tests', pass: /exit 0\b/.test(message) && !/failing/i.test(message), tone: /exit 0\b/.test(message) && !/failing/i.test(message) ? 'done' : 'failed' }, at);
        break;
      case 'git': if (/^Committed/i.test(message)) push({ code: 'commit', tone: 'done' }, at); break;
      case 'github': {
        const pr = message.match(/(Opened|Updated) pull request #(\d+)/i);
        if (pr) push({ code: 'pr', number: Number(pr[2]), updated: /updated/i.test(pr[1]), tone: 'done' }, at);
        else if (/^Pushed/i.test(message)) push({ code: 'pushed', tone: 'done' }, at);
        break;
      }
      case 'ci':
        if (/^CI passed/i.test(message)) push({ code: 'ci_passed', tone: 'done' }, at);
        else if (/^CI failed/i.test(message)) push({ code: 'ci_failed', tone: 'failed' }, at);
        else if (/^Waiting for CI/i.test(message)) push({ code: 'ci_wait', tone: 'working' }, at);
        else if (/No CI checks/i.test(message)) push({ code: 'ci_none', tone: 'done' }, at);
        break;
      case 'deploy': {
        const merged = message.match(/Merged pull request #(\d+)/i);
        if (merged) push({ code: 'merged', number: Number(merged[1]), tone: 'done' }, at);
        else if (/Deployment workflow succeeded/i.test(message)) push({ code: 'deployed', tone: 'done' }, at);
        else if (/^Deployment /i.test(message)) push({ code: 'deploy_failed', tone: 'failed' }, at);
        else if (/^Waiting for the /i.test(message)) push({ code: 'deploy_wait', tone: 'working' }, at);
        break;
      }
      case 'verify': push({ code: /passed/i.test(message) ? 'verified' : 'verify_failed', tone: /passed/i.test(message) ? 'done' : 'failed' }, at); break;
      case 'owner':
        if (/^Fahad replied: /.test(message)) push({ kind: 'owner', text: message.replace(/^Fahad replied: /, '') }, at);
        else if (/answered the agent/i.test(message)) push({ code: 'answer_received', tone: 'done' }, at);
        break;
      case 'approval': push({ code: 'protected_rejected', tone: 'warn' }, at); break;
      case 'report': push({ code: 'completed', tone: 'done' }, at); break;
      default: break;
    }
  }
  for (const approval of approvals) {
    const what = approval.card?.what || approval.summary || approval.action || '';
    push({ code: 'approval_requested', what, tone: 'warn' }, approval.requested_at);
    if (['approved', 'consumed'].includes(approval.status) && approval.decided_at) push({ code: 'approval_approved', what, tone: 'done' }, approval.decided_at);
    if (approval.status === 'rejected' && approval.decided_at) push({ code: 'approval_rejected', what, tone: 'failed' }, approval.decided_at);
  }
  const sorted = entries.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  // Collapse immediate repeats (several identical plan updates, CI polls).
  return sorted.filter((entry, index) => {
    const previous = sorted[index - 1];
    return !previous || entry.kind === 'owner' || previous.kind === 'owner' || `${entry.code}|${entry.phase || ''}|${entry.number || ''}|${entry.pass ?? ''}` !== `${previous.code}|${previous.phase || ''}|${previous.number || ''}|${previous.pass ?? ''}`;
  });
}

export function activityText(entry, language) {
  const ar = language !== 'en';
  const pick = (en, arabic) => (ar ? arabic : en);
  switch (entry.code) {
    case 'started': return pick('Started working', 'بدأ الشغل');
    case 'resumed': return pick('Resumed from its last checkpoint', 'كمّل من آخر نقطة حفظ');
    case 'phase': return PHASES[entry.phase][ar ? 1 : 0];
    case 'plan': return entry.count ? pick(`Made a plan (${entry.count} steps)`, `رتّب خطة (${entry.count} خطوات)`) : pick('Updated the plan', 'حدّث الخطة');
    case 'tests': return entry.pass ? pick('Tests passed', 'الاختبارات نجحت') : pick('Tests failed — fixing', 'الاختبارات فشلت — يصلحها');
    case 'checks_passed': return pick('Final checks passed', 'الفحوصات النهائية نجحت');
    case 'no_changes': return pick('Finished with no code changes needed', 'خلص بدون ما يحتاج تغيير في الكود');
    case 'commit': return pick('Saved the changes (commit)', 'حفظ التغييرات (commit)');
    case 'pushed': return pick('Pushed the branch to GitHub', 'رفع الفرع على GitHub');
    case 'pr': return entry.updated ? pick(`Updated pull request #${entry.number}`, `حدّث طلب الدمج #${entry.number}`) : pick(`Opened pull request #${entry.number}`, `فتح طلب الدمج #${entry.number}`);
    case 'ci_passed': return pick('CI passed', 'فحوصات CI نجحت');
    case 'ci_failed': return pick('CI failed — reading the logs', 'فحوصات CI فشلت — يقرأ السجلات');
    case 'ci_wait': return pick('Waiting for CI', 'ينتظر فحوصات CI');
    case 'ci_none': return pick('No CI checks reported; continued', 'ما في فحوصات CI؛ كمّل');
    case 'merged': return pick(`Merged pull request #${entry.number}`, `دمج طلب الدمج #${entry.number}`);
    case 'deployed': return pick('Deployed', 'انتشر');
    case 'deploy_failed': return pick('Deployment failed — the pipeline rolled back', 'النشر فشل — النظام رجّع النسخة السابقة');
    case 'deploy_wait': return pick('Watching the deployment', 'يتابع النشر');
    case 'verified': return pick('Production verified', 'تحقق من الإنتاج');
    case 'verify_failed': return pick('Production verification failed', 'التحقق من الإنتاج فشل');
    case 'answer_received': return pick('Got your answer; continuing', 'وصله جوابك؛ يكمل');
    case 'protected_rejected': return pick('You declined a protected change', 'رفضت تغيير محمي');
    case 'completed': return pick('Completed the task', 'خلّص المهمة');
    case 'approval_requested': return pick('Asked for your approval: ', 'طلب موافقتك: ');
    case 'approval_approved': return pick('You approved: ', 'وافقت على: ');
    case 'approval_rejected': return pick('You rejected: ', 'رفضت: ');
    default: return '';
  }
}

// The Hub describes live work in fixed English sentences (taskNow). Arabic
// shows the same sentence in Arabic; anything unknown passes through as is.
const NOW_AR = {
  'Waiting for a worker to pick this up.': 'ينتظر عامل يستلم المهمة.', 'Finished.': 'خلصت.', 'Cancelled.': 'انلغت.', 'Stopped because of an error.': 'توقفت بسبب خطأ.',
  'Waiting for your approval.': 'ينتظر موافقتك.', 'Waiting for your answer.': 'ينتظر جوابك.', 'Paused — it needs you to continue.': 'متوقفة — تحتاجك عشان تكمل.',
  'Thinking about the next step.': 'يفكر في الخطوة الياية.', 'Waiting for CI checks.': 'ينتظر فحوصات CI.', 'Watching the deployment.': 'يتابع النشر.', 'Verifying production.': 'يتحقق من الإنتاج.',
  'Looking through the repository.': 'يستعرض المستودع.', 'Searching the code.': 'يبحث في الكود.', 'Running the tests.': 'يشغّل الاختبارات.', 'Running a command.': 'يشغّل أمر.',
  'Checking the working tree.': 'يفحص التغييرات.', 'Reviewing the changes.': 'يراجع التغييرات.', 'Saving the changes (commit).': 'يحفظ التغييرات (commit).', 'Pushing the branch to GitHub.': 'يرفع الفرع على GitHub.',
  'Opening the pull request.': 'يفتح طلب الدمج.', 'Checking the pull request.': 'يفحص طلب الدمج.', 'Reading the CI failure logs.': 'يقرأ سجلات فشل CI.', 'Merging the pull request.': 'يدمج طلب الدمج.',
  'Reading the database.': 'يقرأ قاعدة البيانات.', 'Changing database data.': 'يعدّل بيانات قاعدة البيانات.', 'Applying a database migration.': 'يطبق ترحيل قاعدة البيانات.',
  'Reading the code to understand the task.': 'يقرأ الكود عشان يفهم المهمة.', 'Planning the change.': 'يخطط للتغيير.', 'Making the change.': 'يعدّل الكود.', 'Testing the change.': 'يختبر التغيير.',
  'Fixing a failing check.': 'يصلح فحص فاشل.', 'Reviewing the change.': 'يراجع التغيير.', 'Deploying.': 'ينشر.', 'Writing the summary.': 'يكتب الملخص.', 'Working.': 'يشتغل.',
};
export function localNow(text, language) {
  const value = String(text || '');
  if (language === 'en' || !value) return value;
  if (NOW_AR[value]) return NOW_AR[value];
  const file = value.match(/^(Reading|Writing|Editing) (.+)\.$/);
  if (file) return `${{ Reading: 'يقرأ', Writing: 'يكتب', Editing: 'يعدّل' }[file[1]]} ${file[2]}`;
  const next = value.match(/^Next: (.+)$/s);
  return next ? `الخطوة الياية: ${next[1]}` : value;
}

// The request as written: CHIEF-launched tasks carry Fahad's objective after
// the launcher's marker, so the author is shown truthfully.
export function requestOf(objective = '') {
  const text = String(objective || '');
  const index = text.indexOf(LAUNCH_MARKER);
  return index === -1 ? { author: 'owner', text } : { author: 'chief', text, original: text.slice(index + LAUNCH_MARKER.length).trim() };
}

// Only complete https links become anchors (a PR URL is data, not trusted markup).
const httpsUrl = (value) => (/^https:\/\/[^\s"'<>]{4,500}$/i.test(String(value || '')) ? String(value) : null);
const tokens = (value) => (value == null ? '—' : value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}K` : String(value));
const usd = (value) => (value == null || value === '' || !Number.isFinite(Number(value)) ? '—' : `$${Number(value).toFixed(Number(value) < 0.1 ? 4 : 2)}`);
const modelName = (route) => String(route || '').split(':').slice(1).join(':') || route || '';
function duration(ms, ar) {
  if (ms == null) return '—';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return ar ? `${Math.max(1, Math.round(ms / 1000))} ث` : `${Math.max(1, Math.round(ms / 1000))}s`;
  if (minutes < 60) return ar ? `${minutes} د` : `${minutes} min`;
  return ar ? `${Math.floor(minutes / 60)} س ${minutes % 60} د` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

let stylesheet = null;
function ensureStyles() {
  if (stylesheet) return stylesheet;
  stylesheet = new Promise((resolve) => {
    const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: './ui/coding.css?v=__UI_VERSION__' });
    link.onload = resolve; link.onerror = resolve;
    document.head.append(link);
  });
  return stylesheet;
}

function taskRow(task, ctx, w) {
  const state = codingState({ ...task, needs: task.needs ? { kind: task.needs } : null });
  const line = task.group === 'completed' ? (task.summary || '') : localNow(task.now, ctx.language);
  return `<a class="cw-item" href="#/task/${esc(task.id)}" data-tone="${state}"><span class="cw-dot" aria-hidden="true"></span><span class="cw-item-main"><strong dir="auto">${esc(task.title)}</strong>${line ? `<small dir="auto">${esc(line)}</small>` : ''}</span>
    <span class="cw-item-meta"><span class="cw-state" data-tone="${state}">${esc(w.state[state])}</span><span class="xs faint"><bdi dir="ltr">${esc(task.repository || '')}</bdi>${task.pr?.number ? ` · PR #${esc(task.pr.number)}` : ''} · ${esc(ctx.when(task.updatedAt))}</span></span></a>`;
}

// ------------------------------------------------------------------ home
export async function renderCodingHome(ctx) {
  const { api, q, ws, view, setTitle, toast } = ctx;
  const language = ctx.language === 'en' ? 'en' : 'ar';
  const w = codingWords(language);
  await ensureStyles();
  const navigation = ctx.current;
  const [{ project }, { tasks }] = await Promise.all([api(`/api/projects/${ws()}`), api(`/api/tasks${q({ workspaceId: ws() })}`)]);
  if (navigation && !navigation()) return;
  setTitle(language === 'ar' ? 'مهمة CODING' : 'CODING task');
  let draft = '';
  try { draft = sessionStorage.getItem(DRAFT_KEY) || ''; sessionStorage.removeItem(DRAFT_KEY); } catch {}
  view.innerHTML = `<div class="page cw-home">
    <header class="cw-hero"><span class="owner-kicker">${esc(w.kicker)}</span><h1>${esc(w.heading)}</h1><p>${esc(w.sub)}</p></header>
    <form class="cw-compose" id="taskForm">
      <label class="sr-only" for="instruction">${esc(w.heading)}</label>
      <textarea id="instruction" class="cw-compose-input" dir="auto" rows="4" placeholder="${esc(w.placeholder)}"></textarea>
      <div class="cw-compose-bar">
        <button type="button" class="cw-chip" id="cwOptionsToggle" aria-expanded="false" aria-controls="cwOptions"><span aria-hidden="true">⌥</span> <bdi dir="ltr" id="cwRepoLabel">${esc(project.defaultRepository || w.noRepo)}</bdi></button>
        <span class="cw-chip-muted">${esc(w.budgetLine)} <bdi dir="ltr">$2</bdi></span><span class="grow"></span>
        <button class="btn btn-primary" type="submit" id="startTask">${esc(w.start)}</button>
      </div>
      <div class="cw-options" id="cwOptions" hidden>
        <label class="field-label" for="tRepo">${esc(w.repository)}</label><input id="tRepo" class="input" dir="ltr" value="${esc(project.defaultRepository || '')}" placeholder="owner/name">
        <div class="cw-options-grid"><div><label class="field-label" for="tBudget">${esc(w.budget)}</label><input id="tBudget" class="input" type="number" min="0.5" max="500" step="0.5" value="2"></div>
          <div><label class="field-label" for="tStrategy">${esc(w.routing)}</label><select id="tStrategy" class="input"><option value="">${esc(w.auto)}</option><option value="economy">${esc(w.economy)}</option><option value="balanced">${esc(w.balanced)}</option><option value="quality">${esc(w.quality)}</option></select></div></div>
        <label class="field-label" for="tTest">${esc(w.testCommand)}</label><input id="tTest" class="input" dir="ltr" placeholder="npm test">
        <label class="check cw-check"><input id="tDeploy" type="checkbox"> <span>${esc(w.deploy)}</span></label>
      </div>
      <p id="taskError" class="form-error hidden" role="alert"></p>
    </form>
    <div id="cwLists"></div></div>`;
  const $ = (selector) => view.querySelector(selector);
  const input = $('#instruction');
  // Empty fields follow the page direction (RTL placeholder); typed text finds its own.
  const grow = () => { if (input.value) input.setAttribute('dir', 'auto'); else input.removeAttribute('dir'); input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 360)}px`; };
  input.oninput = grow;
  grow();
  if (draft) { input.value = draft; grow(); }
  input.focus();
  if (draft) input.setSelectionRange(draft.length, draft.length);
  $('#cwOptionsToggle').onclick = () => { const open = $('#cwOptions').hidden; $('#cwOptions').hidden = !open; $('#cwOptionsToggle').setAttribute('aria-expanded', String(open)); };
  $('#tRepo').oninput = (event) => { $('#cwRepoLabel').textContent = event.target.value.trim() || w.noRepo; };
  input.onkeydown = (event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); $('#taskForm').requestSubmit(); } };
  $('#taskForm').onsubmit = async (event) => {
    event.preventDefault();
    const error = $('#taskError');
    error.classList.add('hidden');
    const button = $('#startTask');
    button.disabled = true; button.textContent = w.starting;
    try {
      const body = { workspaceId: ws(), instruction: input.value.trim(), budgetUsd: Number($('#tBudget').value || 2) };
      if ($('#tRepo').value.trim()) body.repository = $('#tRepo').value.trim();
      if ($('#tStrategy').value) body.strategy = $('#tStrategy').value;
      if ($('#tTest').value.trim()) body.testCommand = $('#tTest').value.trim();
      if ($('#tDeploy').checked) body.deploy = true;
      const { task } = await api('/api/tasks', { method: 'POST', body });
      location.hash = `#/task/${task.id}`;
    } catch (failure) {
      error.textContent = failure.message;
      error.classList.remove('hidden');
      button.disabled = false; button.textContent = w.start;
    }
  };
  const drawLists = (list) => {
    const needs = list.filter((task) => task.group === 'attention');
    const running = list.filter((task) => task.group === 'running');
    const recent = list.filter((task) => CLOSED.has(task.group)).slice(0, 8);
    const section = (title, items, empty, extra = '') => `<section class="cw-section"><div class="cw-section-head"><h2>${esc(title)}</h2>${extra}</div>${items.length ? `<div class="cw-list">${items.map((task) => taskRow(task, ctx, w)).join('')}</div>` : `<p class="cw-empty">${esc(empty)}</p>`}</section>`;
    $('#cwLists').innerHTML = `${needs.length ? section(w.needsYou, needs, '') : ''}${section(w.inProgress, running, w.emptyActive)}${section(w.recent, recent, w.emptyRecent, `<a class="small" href="#/tasks/completed">${esc(w.allTasks)}</a>`)}`;
  };
  drawLists(tasks);
  const refresh = async () => { try { const data = await api(`/api/tasks${q({ workspaceId: ws() })}`); if ($('#cwLists')) drawLists(data.tasks); } catch {} };
  ctx.onChange(refresh);
  if (tasks.some((task) => ['running', 'attention'].includes(task.group))) ctx.every(20_000, refresh);
  void toast;
}

// ------------------------------------------------------------------ task
export async function renderCodingTask(ctx, id) {
  const { api, view, setTitle, toast, when } = ctx;
  const language = ctx.language === 'en' ? 'en' : 'ar';
  const ar = language === 'ar';
  const w = codingWords(language);
  await ensureStyles();
  const navigation = ctx.current;
  let data = await api(`/api/tasks/${id}`);
  if (navigation && !navigation()) return;
  let tab = 'overview';
  let expanded = false;
  setTitle(data.task.title);
  view.innerHTML = `<div class="cw">
    <header class="cw-head" id="cwHead"></header>
    <nav class="cw-tabs" role="tablist" aria-label="${esc(data.task.title)}" id="cwTabs"></nav>
    <div id="cwJump"></div>
    <div class="cw-body" id="cwBody" role="tabpanel" tabindex="-1"></div>
    <details class="disclosure cw-advanced" id="cwAdvanced"><summary>${esc(w.advanced)}</summary><div class="disclosure-body" id="cwAdvancedBody"></div></details>
    <div class="cw-composer-slot" id="cwComposer"></div></div>`;
  const $ = (selector) => view.querySelector(selector);

  function drawHead() {
    const t = data.task;
    const state = codingState(t);
    const pr = t.pr || t.result?.pr;
    const prUrl = httpsUrl(pr?.url);
    $('#cwHead').innerHTML = `<a class="cw-back" href="#/code"><span aria-hidden="true">${ar ? '→' : '←'}</span> ${esc(w.back)}</a>
      <div class="cw-head-row"><div class="grow"><h1 dir="auto">${esc(t.title)}</h1>
        <div class="cw-meta"><span class="cw-state" data-tone="${state}">${esc(w.state[state])}</span><span>CODING</span><span aria-hidden="true">·</span><bdi dir="ltr">${esc(t.repository)}</bdi><span aria-hidden="true">·</span><time datetime="${esc(t.updatedAt || '')}">${esc(when(t.updatedAt))}</time></div></div>
        <div class="cw-head-actions">${prUrl ? `<a class="btn btn-sm" href="${esc(prUrl)}" target="_blank" rel="noopener noreferrer">${esc(w.openPr(pr.number))} ↗</a>` : ''}
          <details class="cw-more"><summary class="icon-btn" aria-label="${esc(w.more)}">⋯</summary><div class="cw-menu">${t.conversationId ? `<a href="#/chat/${esc(t.conversationId)}">${esc(w.openChat)}</a>` : ''}${CLOSED.has(t.status) ? '' : `<button type="button" id="cancelTask">${esc(w.cancel)}</button>`}${!t.conversationId && CLOSED.has(t.status) ? `<a href="#/code">${esc(w.followUp)}</a>` : ''}</div></details></div></div>`;
    const approvals = data.approvals || [];
    const counts = { activity: codingActivity(data.events, approvals).length, files: (t.filesChanged || []).length, approvals: approvals.length };
    $('#cwTabs').innerHTML = Object.entries(w.tabs).map(([key, label]) => `<button type="button" role="tab" class="cw-tab" data-tab="${key}" aria-selected="${tab === key}">${esc(label)}${counts[key] ? ` <span class="num">${counts[key]}</span>` : ''}</button>`).join('');
    $('#cwTabs').querySelectorAll('[data-tab]').forEach((button) => { button.onclick = () => { tab = button.dataset.tab; drawHead(); drawBody(); }; });
    // What needs Fahad is at the end of the thread; this keeps it one tap away.
    const pending = (data.approvals || []).filter((approval) => approval.status === 'pending');
    const ask = pending.length ? pending[0].card?.what || pending[0].summary : t.needs?.kind === 'question' ? t.needs.question : t.needs?.kind === 'blocked' ? t.needs.explanation : '';
    $('#cwJump').innerHTML = ask ? `<button type="button" class="cw-jump" data-jump><span class="cw-jump-dot" aria-hidden="true"></span><span class="grow">${esc(w.jumpLead)}<bdi>${esc(ask)}</bdi></span><span class="cw-jump-go">${esc(w.jumpGo)}</span></button>` : '';
    $('#cwJump').querySelector('[data-jump]')?.addEventListener('click', () => {
      tab = 'overview'; drawHead(); drawBody();
      const target = $('#cwNext');
      target?.scrollIntoView({ block: 'center', behavior: ctx.reducedMotion?.() ? 'auto' : 'smooth' });
      (target?.querySelector('button, textarea') || $('#replyText'))?.focus({ preventScroll: true });
    });
    const cancel = $('#cancelTask');
    if (cancel) cancel.onclick = async () => {
      if (!(await ctx.confirmDialog(w.cancelTitle, w.cancelBody))) return;
      await api(`/api/tasks/${id}/cancel`, { method: 'POST' });
      toast(w.cancelled); await reload(true);
    };
  }

  const request = () => {
    const t = data.task;
    const { author, text } = requestOf(t.objective);
    const long = text.length > 520;
    return `<div class="cw-msg cw-msg-owner"><div class="cw-msg-who">${author === 'chief' ? `${roleMark('chief', 'CHIEF')}<span>${esc(w.chiefForYou)}</span>` : `<span class="fahad-mark" aria-hidden="true">F</span><span>${esc(w.you)}</span>`}<time>${esc(when(t.createdAt))}</time></div>
      <div class="cw-bubble${long && !expanded ? ' is-clamped' : ''}" dir="auto">${esc(text)}</div>${long ? `<button type="button" class="btn btn-ghost btn-sm" data-expand>${esc(expanded ? w.showLess : w.showMore)}</button>` : ''}</div>`;
  };

  function stepList(entries) {
    return `<ol class="cw-steps">${entries.map((entry) => entry.kind === 'owner'
      ? `<li class="cw-step cw-step-owner"><span class="cw-step-icon" aria-hidden="true">F</span><span class="grow" dir="auto">${esc(entry.text)}</span><time>${esc(when(entry.at))}</time></li>`
      : `<li class="cw-step" data-tone="${esc(entry.tone)}"><span class="cw-step-icon" aria-hidden="true">${{ done: '✓', failed: '!', working: '•', warn: '?' }[entry.tone] || '•'}</span><span class="grow">${esc(activityText(entry, language))}${entry.what ? `<bdi>${esc(entry.what)}</bdi>` : ''}</span><time>${esc(when(entry.at))}</time></li>`).join('')}</ol>`;
  }

  function nextAction() {
    const t = data.task;
    const pending = (data.approvals || []).filter((approval) => approval.status === 'pending');
    if (pending.length) return `<section class="cw-next cw-next-needs" id="cwNext" aria-live="polite"><h2>${esc(ar ? 'ينتظر موافقتك' : t.needs?.title || 'Waiting for your approval')}</h2>${pending.map((approval) => approvalCard(approval, true)).join('')}</section>`;
    if (t.needs?.kind === 'question') return `<section class="cw-next cw-next-needs" id="cwNext" aria-live="polite"><h2>${esc(ar ? 'سؤال لك' : t.needs.title)}</h2><p class="what" dir="auto">${esc(t.needs.question)}</p>${t.needs.reason && t.needs.reason !== t.needs.question ? `<p class="small muted" dir="auto"><strong>${esc(w.why)}</strong> ${esc(t.needs.reason)}</p>` : ''}</section>`;
    if (t.needs?.kind === 'blocked') return `<section class="cw-next cw-next-needs" id="cwNext" aria-live="polite"><h2>${esc(ar ? 'المهمة متوقفة مؤقتًا' : t.needs.title)}</h2><p dir="auto">${esc(t.needs.explanation)}</p></section>`;
    if (t.status === 'completed') return `<section class="cw-next cw-next-done"><p>${esc(w.doneNothing)}</p></section>`;
    if (t.status === 'failed') return `<section class="cw-next">${errorBlock(t.blocker || '', esc)}</section>`;
    if (t.status === 'cancelled') return '';
    return t.nextAction ? `<section class="cw-next"><span class="cw-label">${esc(w.next)}</span><p dir="auto">${esc(t.nextAction)}</p></section>` : '';
  }

  function approvalCard(approval, actionable) {
    const card = approval.card || {};
    const decided = approval.status !== 'pending';
    return `<div class="owner-item cw-approval"><div class="small muted">${esc(w.asking)}</div>
      <div class="spread"><div class="what" dir="auto">${esc(card.what || approval.summary || '')}</div><span class="risk ${esc(approval.risk || 'medium')}">${esc(w.risk[approval.risk] || String(approval.risk || 'medium').toUpperCase())}</span></div>
      ${card.why && card.why !== card.what ? `<p class="small" dir="auto"><strong>${esc(w.why)}</strong> ${esc(card.why)}</p>` : ''}
      ${(card.resources || []).length ? `<div class="small muted">${esc(w.affects)}</div><div class="resources">${card.resources.map((resource) => `<code dir="ltr">${esc(resource)}</code>`).join('')}</div>` : ''}
      ${card.kind === 'protected_change' ? `<p class="xs muted">${esc(w.protectedNote)}</p>` : ''}
      ${actionable && !decided ? `<div class="row"><button class="btn btn-success" data-decide="approved" data-id="${esc(approval.id)}">${esc(w.approve)}</button><button class="btn btn-danger" data-decide="rejected" data-id="${esc(approval.id)}">${esc(w.reject)}</button></div>`
        : decided ? `<p class="xs muted">${esc(approval.status === 'rejected' ? w.rejectedAt(when(approval.decided_at)) : w.approvedAt(when(approval.decided_at)))}${approval.note ? ` · <span dir="auto">${esc(approval.note)}</span>` : ''}</p>` : ''}</div>`;
  }

  function overview() {
    const t = data.task;
    const entries = codingActivity(data.events, data.approvals || []);
    const owners = entries.filter((entry) => entry.kind === 'owner');
    const steps = entries.filter((entry) => entry.kind !== 'owner');
    const plan = Array.isArray(t.plan) ? t.plan.filter((step) => step?.title) : [];
    const note = CLOSED.has(t.status) ? null : (data.events || []).find((event) => event.type === 'model_turn' && !/^\d+ tool call\(s\)$/.test(String(event.message || '')));
    const result = t.result || {};
    const pr = t.pr || result.pr;
    const ci = t.ci?.state || result.ci?.state;
    const deploy = result.deploy?.status || t.deploy?.status || (t.config?.deploy?.mode === 'merge' ? w.pending : w.notRequested);
    const files = t.filesChanged || [];
    const closed = CLOSED.has(t.status);
    return `${request()}
      ${owners.length ? stepList(owners) : ''}
      <div class="cw-msg cw-msg-agent"><div class="cw-msg-who">${roleMark('coding', 'CODING')}<span>CODING</span><span class="cw-state" data-tone="${codingState(t)}">${esc(w.state[codingState(t)])}</span></div>
        ${plan.length ? `<div class="cw-plan"><div class="cw-label">${esc(w.plan)} · ${esc(w.planDone(plan.filter((step) => step.status === 'done').length, plan.length))}</div><ul>${plan.slice(0, 12).map((step) => `<li data-state="${esc(step.status)}"><span aria-hidden="true">${step.status === 'done' ? '✓' : step.status === 'in_progress' ? '•' : ''}</span><span dir="auto">${esc(step.title)}</span></li>`).join('')}</ul></div>` : ''}
        <div class="cw-label">${esc(w.recentSteps)}</div>
        ${steps.length ? stepList(steps.slice(-6)) : `<p class="muted small">${esc(closed ? w.noActivityClosed : w.noActivity)}</p>`}
        ${steps.length > 6 ? `<button type="button" class="btn btn-ghost btn-sm" data-goto="activity">${esc(w.allActivity)} (${steps.length})</button>` : ''}
        ${!closed && !t.needs ? `<div class="now cw-now"><span class="dots"><i></i><i></i><i></i></span><span dir="auto">${esc(localNow(t.now, language))}</span></div>` : ''}
        ${note ? `<div class="cw-note"><span class="cw-label">${esc(w.latestNote)}</span><p dir="auto">${esc(note.message)}</p></div>` : ''}
      </div>
      <section class="cw-output"><h2>${esc(closed ? w.result : w.progressSoFar)}</h2>
        ${result.summary ? `<div class="md" dir="auto">${renderMarkdown(result.summary)}</div>` : t.status === 'failed' ? '' : `<p class="muted small">${esc(closed ? w.noSummary : w.noResult)}</p>`}
        <div class="cw-chips">${httpsUrl(pr?.url) ? `<a class="cw-chip-link" href="${esc(httpsUrl(pr.url))}" target="_blank" rel="noopener noreferrer">${esc(w.prLabel)} #${esc(pr.number)} ↗</a>` : ''}${ci ? `<span class="cw-fact" data-ok="${ci === 'success'}">${esc(w.ci)}: ${esc(w.ciWord[ci] || ci)}</span>` : ''}${t.lastTest ? `<span class="cw-fact" data-ok="${t.lastTest.exitCode === 0}">${esc(w.tests)}: ${esc(t.lastTest.exitCode === 0 ? w.passing : w.failing)}</span>` : ''}<span class="cw-fact">${esc(w.deployment)}: ${esc(deploy)}</span>${files.length ? `<button type="button" class="cw-fact cw-fact-btn" data-goto="files">${esc(w.files(files.length))}</button>` : ''}</div>
      </section>
      ${nextAction()}`;
  }

  function activity() {
    const entries = codingActivity(data.events, data.approvals || []);
    return `<section class="cw-panel"><h2>${esc(w.allActivity)}</h2>${entries.length ? stepList(entries) : `<p class="muted small">${esc(w.noActivity)}</p>`}</section>`;
  }

  function filesPanel() {
    const t = data.task;
    const result = t.result || {};
    const pr = t.pr || result.pr;
    const files = t.filesChanged || [];
    const facts = [[w.prLabel, httpsUrl(pr?.url) ? `<a href="${esc(httpsUrl(pr.url))}" target="_blank" rel="noopener noreferrer">#${esc(pr.number)} ↗</a>` : w.none],
      [w.ci, esc(w.ciWord[t.ci?.state || result.ci?.state] || t.ci?.state || result.ci?.state || w.none)], [w.tests, esc(t.lastTest ? (t.lastTest.exitCode === 0 ? w.passing : w.failing) : w.none)],
      [w.deployment, esc(result.deploy?.status || t.deploy?.status || (t.config?.deploy?.mode === 'merge' ? w.pending : w.notRequested))]];
    return `<section class="cw-panel"><dl class="kv">${facts.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`).join('')}</dl>
      <h2>${esc(w.files(files.length))}</h2>${files.length ? `<ul class="cw-files" dir="ltr">${files.map((file) => `<li><code>${esc(file)}</code></li>`).join('')}</ul>` : `<p class="muted small">${esc(w.noFiles)}</p>`}</section>`;
  }

  function approvalsPanel() {
    const approvals = data.approvals || [];
    return `<section class="cw-panel">${approvals.length ? approvals.map((approval) => approvalCard(approval, true)).join('') : `<p class="muted small">${esc(w.approvalsEmpty)}</p>`}</section>`;
  }

  function drawBody() {
    $('#cwBody').innerHTML = { overview, activity, files: filesPanel, approvals: approvalsPanel }[tab]();
    view.querySelectorAll('[data-goto]').forEach((button) => { button.onclick = () => { tab = button.dataset.goto; drawHead(); drawBody(); $('#cwBody').focus({ preventScroll: true }); }; });
    view.querySelector('[data-expand]')?.addEventListener('click', () => { expanded = !expanded; drawBody(); });
    view.querySelectorAll('[data-followup]').forEach((button) => { button.onclick = () => { try { sessionStorage.setItem(DRAFT_KEY, w.followUpDraft(data.task.title)); } catch {} location.hash = '#/code'; }; });
    view.querySelectorAll('[data-decide]').forEach((button) => { button.onclick = async () => {
      const decision = button.dataset.decide;
      const note = decision === 'rejected' ? await ctx.ask(w.rejectReason, '', true) : null;
      if (decision === 'rejected' && note === null) return;
      button.disabled = true;
      try {
        await api(`/api/approvals/${button.dataset.id}`, { method: 'POST', body: { decision, note: note || undefined } });
        toast(decision === 'approved' ? w.approvedToast : w.rejectedToast);
        await reload(true);
        ctx.refreshSidebar?.();
      } catch (error) { toast(error.message); button.disabled = false; }
    }; });
  }

  function drawAdvanced() {
    const t = data.task;
    const m = t.metrics || {};
    const stages = `<div class="timeline" role="list" tabindex="0" aria-label="${esc(w.stages)}">${(t.timeline || []).filter((step) => step.state !== 'skipped').map((step, index) => `<div class="step ${esc(step.state)}" role="listitem" title="${esc(step.label)}: ${esc(step.state.replace('_', ' '))}"><span class="dot">${{ passed: '✓', failed: '!', needs_input: '?', skipped: '–' }[step.state] || index + 1}</span><span>${esc(step.label)}</span></div>`).join('')}</div>`;
    $('#cwAdvancedBody').innerHTML = `<h3 class="cw-adv-title">${esc(w.stages)}</h3>${stages}
      <h3 class="cw-adv-title">${esc(w.engine)}</h3><dl class="kv">
        <div><dt>${esc(w.model)}</dt><dd dir="ltr" title="${esc(t.currentModel || '')}">${esc(modelName(t.currentModel) || 'AUTO')}</dd></div>
        <div><dt>${esc(w.cost)}</dt><dd dir="ltr">${esc(usd(m.costUsd))} <span class="faint small">${esc(w.of)} ${esc(usd(t.budgetUsd))}</span></dd></div>
        <div><dt>${esc(w.elapsed)}</dt><dd>${esc(duration(t.elapsedMs, ar))}</dd></div><div><dt>${esc(w.updated)}</dt><dd>${esc(when(t.updatedAt))}</dd></div>
        <div><dt>${esc(w.calls)}</dt><dd>${esc(m.modelCalls ?? '—')}</dd></div><div><dt>${esc(w.iterations)}</dt><dd>${esc(m.iterations ?? '—')}</dd></div>
        <div><dt>${esc(w.inputTokens)}</dt><dd>${esc(tokens(m.inputTokens))} <span class="faint small">${m.inputTokens ? `${Math.round((m.cachedInputTokens / m.inputTokens) * 100)}% ${esc(w.cached)}` : ''}</span></dd></div>
        <div><dt>${esc(w.outputTokens)}</dt><dd>${esc(tokens(m.outputTokens))}</dd></div><div><dt>${esc(w.switches)}</dt><dd>${esc(m.modelSwitches ?? '—')}</dd></div>
        <div><dt>${esc(w.trimmed)}</dt><dd>${esc(tokens(Math.round((m.contextTrimmedChars || 0) / 4)))}</dd></div></dl>
      <p class="small muted">${esc(w.modelsUsed)}: <bdi dir="ltr">${esc((m.modelsUsed || []).join(', ') || '—')}</bdi></p>
      <p class="small muted">${esc(w.branches)}: <bdi dir="ltr">${esc(t.baseBranch || 'main')} → ${esc(t.workBranch || '—')}</bdi></p>
      <details class="disclosure"><summary>${esc(w.original)}</summary><div class="disclosure-body report" dir="auto">${esc(t.objective)}</div></details>
      <details class="disclosure"><summary>${esc(w.events((data.events || []).length))}</summary><div class="disclosure-body"><div class="events">${(data.events || []).map((event) => `<div class="${esc(event.level)}"><span class="faint" dir="ltr">${esc(new Date(event.createdAt).toLocaleTimeString())} ${esc(event.type)}</span> <span dir="auto">${esc(event.message)}</span></div>`).join('')}</div></div></details>`;
  }

  // The composer is built once, so a draft and focus survive live updates.
  let composerState = '';
  function drawComposer() {
    const t = data.task;
    const kind = CLOSED.has(t.status) ? 'closed' : t.needs?.kind === 'question' ? 'question' : t.needs?.kind === 'blocked' ? 'blocked' : 'open';
    if (kind === composerState) return;
    const draft = $('#replyText')?.value || '';
    composerState = kind;
    const slot = $('#cwComposer');
    if (kind === 'closed') {
      slot.innerHTML = `<div class="cw-composer cw-composer-closed"><span class="muted small">${esc(w.closedNote)}</span><button type="button" class="btn btn-sm" data-followup>${esc(w.followUp)}</button></div>`;
      slot.querySelector('[data-followup]').onclick = () => { try { sessionStorage.setItem(DRAFT_KEY, w.followUpDraft(t.title)); } catch {} location.hash = '#/code'; };
      return;
    }
    const label = kind === 'question' ? w.answer : kind === 'blocked' ? w.instructions : w.composer;
    const placeholder = kind === 'question' ? w.answerPlaceholder : kind === 'blocked' ? w.instructionsPlaceholder : w.composer;
    slot.innerHTML = `<form class="cw-composer" id="cwReply"><label class="sr-only" for="replyText">${esc(label)}</label>
      <textarea id="replyText" rows="1" dir="auto" placeholder="${esc(placeholder)}"></textarea>
      ${kind === 'blocked' ? `<button type="button" class="btn btn-ghost btn-sm" id="resumeTask">${esc(w.resumePlain)}</button>` : ''}
      <button type="submit" class="btn btn-primary" id="replySend">${kind === 'open' ? esc(w.send) : w.reply}</button></form>
      <p class="cw-composer-hint">${esc(kind === 'open' ? w.composerHint : label)}</p>`;
    const text = slot.querySelector('#replyText');
    const direction = () => { if (text.value) text.setAttribute('dir', 'auto'); else text.removeAttribute('dir'); };
    text.value = draft;
    direction();
    text.oninput = () => { direction(); text.style.height = 'auto'; text.style.height = `${Math.min(text.scrollHeight, 200)}px`; };
    text.onkeydown = (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); slot.querySelector('#cwReply').requestSubmit(); } };
    slot.querySelector('#cwReply').onsubmit = async (event) => {
      event.preventDefault();
      const message = text.value.trim();
      if (!message) { toast(w.writeFirst); return; }
      const button = slot.querySelector('#replySend');
      button.disabled = true;
      try {
        await api(`/api/tasks/${id}/reply`, { method: 'POST', body: { message } });
        text.value = '';
        toast(w.sent);
        await reload(true);
        ctx.refreshSidebar?.();
      } catch (error) { toast(error.message); } finally { button.disabled = false; }
    };
    slot.querySelector('#resumeTask')?.addEventListener('click', async () => {
      try { await api(`/api/tasks/${id}/resume`, { method: 'POST' }); toast(w.resumed); await reload(true); } catch (error) { toast(error.message); }
    });
  }

  let signature = '';
  async function reload(force = false) {
    const next = force ? await api(`/api/tasks/${id}`) : data;
    const key = JSON.stringify([next.task.status, next.task.phase, next.task.now, next.task.updatedAt, next.task.metrics?.costUsd, (next.approvals || []).map((approval) => approval.status), next.events?.[0]?.id]);
    data = next;
    if (key === signature) return data.task;
    signature = key;
    const open = $('#cwAdvanced')?.open;
    drawHead(); drawBody(); drawAdvanced(); drawComposer();
    if (open) $('#cwAdvanced').open = true;
    return data.task;
  }
  await reload();
  if (!CLOSED.has(data.task.status)) ctx.every(4000, async () => {
    try {
      const next = await api(`/api/tasks/${id}`);
      data = next;
      await reload();
    } catch {}
  });
}
