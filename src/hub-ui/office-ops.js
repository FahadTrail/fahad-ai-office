// Live Operations — the Office's command layer for one objective: what CHIEF
// is doing and how it divided the work, who is working right now (on which
// model), who waits and why, every handoff, the readable timeline, every
// deliverable and the final synthesis, and what needs Fahad. Data comes only
// from /api/operations (authoritative rows); refreshes ride the shared live
// stream. Arabic first; model and provider names stay as written (Latin, LTR).
//
// The module is pure where it can be (opsCopy, prettyModel, render*) so it is
// tested in Node; mountOperations() wires it to the page and the 3D Office.

const EN = {
  live: 'Live operations', objective: 'Objective', switcher: 'Objective', current: 'Current', active: 'Active', recent: 'Recently completed', testBadge: 'Test',
  none: 'No objective yet. Ask CHIEF above and the whole company appears here, live.', loading: 'Loading live operations…', error: 'Live operations are unavailable right now.',
  started: 'Started', elapsed: 'Elapsed', took: 'Took', of: (a, b) => `${a} of ${b}`, workstreamsDone: 'workstreams completed', workingNow: 'working now', waiting: 'waiting', blockers: 'blocked', needs: 'need you', handoffs: 'handoffs', deliverables: 'deliverables', spend: 'Spend',
  free: 'Free', paid: 'Paid', allFree: (n) => `${n} model call${n === 1 ? '' : 's'}, all free`, someCalls: (n, f) => `${n} model calls · ${f} free`,
  chiefTitle: 'CHIEF command', chiefNow: 'Now', chiefNext: 'Next', waitingFor: 'Waiting for', planning: 'Planning', synthesis: 'Final synthesis', revisionRounds: 'Revision rounds', delegation: 'Delegation', after: 'after',
  actions: { delivered: 'Delivered the final result', stopped: 'Stopped', planning: 'Planning the work', synthesis: 'Writing the final synthesis', review: 'Reviewing the team’s work', working: 'Working', coordinating: 'Coordinating the team', awaiting_synthesis: 'Getting ready for the synthesis' },
  next: { assign: 'Assign the workstreams', deliver: 'Deliver the final result', synthesize_after: (names) => `Synthesize once ${names} deliver`, start_synthesis: 'Start the final synthesis' },
  phase: { done: 'Done', working: 'In progress', pending: 'Pending', 'not started': 'Not started', waiting: 'Waiting', failed: 'Failed' },
  nowTitle: 'Now working', nobody: 'Nobody is running a model right now.', since: 'for', lastActivity: 'Latest',
  needsTitle: 'Needs Fahad', nothingNeeds: 'Nothing needs you. Internal waits never appear here.', needKinds: { approval: 'Approval', question: 'Question', credential: 'Credential needed', destructive: 'Confirm a destructive action', blocked_external: 'Blocked external action' },
  capacityTitle: 'Waiting for model capacity', autoResume: 'Automatic retry armed', retryAt: 'Next retry', capacityWho: (who) => `${who} is waiting for model capacity.`,
  teamTitle: 'The team on this objective', provider: 'Model', attempts: 'Attempts', switches: 'Switches', latestOutput: 'Latest output', deliverablesShort: 'Deliverables', revision: 'Revision', open: 'Open', routeDetails: 'Routing details', noModel: 'No model call yet',
  pipelineTitle: 'Workstream pipeline', stages: { plan: 'Plan', assigned: 'Assigned', running: 'Running', delivered: 'Delivered', review: 'Review', revision: 'Revision', final: 'Final' },
  handoffTitle: 'Handoff center', noHandoffs: 'No handoffs in this objective yet.', handedOver: 'Handed over', toTask: 'Destination task', result: 'Result', showRoute: 'Show route',
  handoffStatus: { delivered: 'Delivered', 'in progress': 'In progress', failed: 'Failed', blocked: 'Blocked', waiting: 'Waiting', received: 'Received', 'needs Fahad': 'Needs you', unknown: 'Unknown' },
  timelineTitle: 'Timeline', technical: 'Show technical details', noTimeline: 'Nothing has happened yet.',
  deliverablesTitle: 'Deliverables', finalTitle: 'FINAL SYNTHESIS', finalPending: 'CHIEF has not delivered the final synthesis yet.', noDeliverables: 'No deliverables yet.', verified: 'Verified', needsReview: 'Needs review', fromTask: 'Task',
  revisionsTitle: 'Revision rounds', revisionSteps: { draft_delivered: 'Draft delivered', revision_requested: 'Revision requested', revision_in_progress: 'Revision in progress', revision_delivered: 'Revision delivered', accepted: 'Accepted' },
  states: { AVAILABLE: 'Available', ASSIGNED: 'Assigned', WORKING: 'Working', REVIEWING: 'Reviewing', WAITING: 'Waiting', BLOCKED: 'Blocked', 'NEEDS FAHAD': 'Needs you', COMPLETED: 'Completed', FAILED: 'Failed' },
  objectiveStage: { planning: 'CHIEF is planning', workstreams: 'The team is working', revision: 'Revision round', synthesis: 'CHIEF is writing the synthesis', waiting_capacity: 'Waiting for model capacity', needs_fahad: 'Needs you', completed: 'Completed', failed: 'Stopped', cancelled: 'Cancelled' },
  blocks: { upstream_failed: 'An earlier step failed, so this step cannot run.', objective_stopped: 'The objective stopped; this step will not run.', failed: 'Failed after its retries.' },
  dependency: (names) => `Waiting for ${names}`,
  filtered: (name) => `Showing ${name}`, clearFilter: 'Show everyone', chiefRoot: 'CHIEF',
  timeline: {
    objective: () => 'CHIEF received the objective', plan: (e) => `CHIEF planned ${e.count} workstream${e.count === 1 ? '' : 's'}`, review_queued: () => 'CHIEF queued its review', synthesis_queued: () => 'CHIEF queued the final synthesis',
    assigned: (e) => `CHIEF assigned ${e.who}${e.revision ? ' a revision' : ''}`, planning: () => 'CHIEF started planning', synthesis: () => 'CHIEF started the final synthesis', review: () => 'CHIEF started reviewing the team’s work',
    start: (e) => `${e.who} started${e.revision ? ' the revision' : ''}`, planned: () => 'CHIEF finished the plan', final: () => 'CHIEF delivered the final synthesis', reviewed: () => 'CHIEF finished the review',
    delivered: (e) => `${e.who} delivered${e.revision ? ' the revision' : ''}`, launched: (e) => `${e.who} took the engineering work`, failed: (e) => `${e.who} could not finish`, handoff: (e) => `${e.who} → ${e.to} handoff`,
    switch: (e) => `${e.who} switched model`, revision: (e) => `CHIEF requested a revision from ${e.target || 'the team'}`, verified: () => 'FINANCE figures verified by code',
    returned: (e) => `FINANCE figures returned for correction (${e.count})`, waiting: (e) => `${e.who} is waiting for model capacity`, completed: () => 'Objective completed', stopped: () => 'The objective stopped', attention: (e) => `${e.who} needs your approval`,
  },
  types: { report: 'report', table: 'table', flow: 'flow', timeline: 'timeline', kanban: 'board', evidence: 'evidence', financial_model: 'financial model', chart: 'chart', checklist: 'checklist', moodboard: 'moodboard', audit_report: 'audit report', risk_matrix: 'risk matrix', compliance_matrix: 'compliance matrix', calendar: 'calendar' },
  capacityWait: 'Waiting for free model capacity — resumes automatically',
  reasons: { network: 'network error', transient: 'temporary error', 'rate limited': 'rate limit', timeout: 'timeout' },
};

const AR = {
  live: 'العمليات المباشرة', objective: 'الهدف', switcher: 'الهدف', current: 'الحالي', active: 'الجارية', recent: 'المكتملة مؤخرًا', testBadge: 'اختبار',
  none: 'ما في هدف بعد. اطلب من CHIEF فوق وتشوف الشركة كلها تشتغل هنا مباشرة.', loading: 'نحمّل العمليات المباشرة…', error: 'العمليات المباشرة غير متاحة الحين.',
  started: 'بدأ', elapsed: 'المدة', took: 'استغرق', of: (a, b) => `${a} من ${b}`, workstreamsDone: 'مسارات عمل مكتملة', workingNow: 'يشتغلون الحين', waiting: 'ينتظرون', blockers: 'متوقف', needs: 'ينتظرك', handoffs: 'تسليمات', deliverables: 'مخرجات', spend: 'التكلفة',
  free: 'مجاني', paid: 'مدفوع', allFree: (n) => `${n} استدعاء نموذج، كلها مجانية`, someCalls: (n, f) => `${n} استدعاء نموذج · ${f} مجاني`,
  chiefTitle: 'قيادة CHIEF', chiefNow: 'الحين', chiefNext: 'الخطوة التالية', waitingFor: 'ينتظر', planning: 'التخطيط', synthesis: 'الخلاصة النهائية', revisionRounds: 'جولات التعديل', delegation: 'توزيع العمل', after: 'بعد',
  actions: { delivered: 'سلّم النتيجة النهائية', stopped: 'توقف', planning: 'يخطط للعمل', synthesis: 'يكتب الخلاصة النهائية', review: 'يراجع شغل الفريق', working: 'يشتغل', coordinating: 'ينسّق الفريق', awaiting_synthesis: 'يستعد للخلاصة' },
  next: { assign: 'توزيع مسارات العمل', deliver: 'تسليم النتيجة النهائية', synthesize_after: (names) => `الخلاصة بعد ما يسلّم ${names}`, start_synthesis: 'بدء الخلاصة النهائية' },
  phase: { done: 'تم', working: 'جارٍ', pending: 'لم يبدأ', 'not started': 'لم يبدأ', waiting: 'ينتظر', failed: 'تعثّر' },
  nowTitle: 'يشتغلون الحين', nobody: 'ما أحد يشغّل نموذج الحين.', since: 'منذ', lastActivity: 'آخر نشاط',
  needsTitle: 'ينتظرك يا فهد', nothingNeeds: 'ما في شي ينتظرك. الانتظار الداخلي ما يظهر هنا أبدًا.', needKinds: { approval: 'موافقة', question: 'سؤال', credential: 'يحتاج بيانات اعتماد', destructive: 'تأكيد إجراء حذف', blocked_external: 'إجراء خارجي متوقف' },
  capacityTitle: 'ينتظر سعة النماذج', autoResume: 'إعادة المحاولة التلقائية مفعّلة', retryAt: 'المحاولة القادمة', capacityWho: (who) => `${who} ينتظر سعة النماذج.`,
  teamTitle: 'الفريق على هذا الهدف', provider: 'النموذج', attempts: 'المحاولات', switches: 'التبديلات', latestOutput: 'آخر مخرج', deliverablesShort: 'المخرجات', revision: 'التعديل', open: 'افتح', routeDetails: 'تفاصيل التوجيه', noModel: 'ما في استدعاء نموذج بعد',
  pipelineTitle: 'مسار العمل', stages: { plan: 'الخطة', assigned: 'مُسنَد', running: 'قيد التنفيذ', delivered: 'سُلّم', review: 'المراجعة', revision: 'التعديل', final: 'النهائي' },
  handoffTitle: 'مركز التسليمات', noHandoffs: 'ما في تسليمات في هذا الهدف بعد.', handedOver: 'ما تم تسليمه', toTask: 'المهمة المستلِمة', result: 'النتيجة', showRoute: 'اعرض المسار',
  handoffStatus: { delivered: 'سُلّم', 'in progress': 'جارٍ', failed: 'تعثّر', blocked: 'متوقف', waiting: 'ينتظر', received: 'استُلم', 'needs Fahad': 'ينتظرك', unknown: 'غير معروف' },
  timelineTitle: 'الخط الزمني', technical: 'اعرض التفاصيل التقنية', noTimeline: 'ما صار شي بعد.',
  deliverablesTitle: 'المخرجات', finalTitle: 'الخلاصة النهائية', finalPending: 'CHIEF ما سلّم الخلاصة النهائية بعد.', noDeliverables: 'ما في مخرجات بعد.', verified: 'متحقَّق منه', needsReview: 'يحتاج مراجعة', fromTask: 'المهمة',
  revisionsTitle: 'جولات التعديل', revisionSteps: { draft_delivered: 'سلّم المسودة', revision_requested: 'طُلب تعديل', revision_in_progress: 'التعديل جارٍ', revision_delivered: 'سلّم التعديل', accepted: 'اعتُمد' },
  states: { AVAILABLE: 'متاح', ASSIGNED: 'مُسنَد', WORKING: 'يشتغل', REVIEWING: 'يراجع', WAITING: 'ينتظر', BLOCKED: 'متوقف', 'NEEDS FAHAD': 'ينتظرك', COMPLETED: 'سلّم', FAILED: 'تعثّر' },
  objectiveStage: { planning: 'CHIEF يخطط', workstreams: 'الفريق يشتغل', revision: 'جولة تعديل', synthesis: 'CHIEF يكتب الخلاصة', waiting_capacity: 'ينتظر سعة النماذج', needs_fahad: 'ينتظرك', completed: 'اكتمل', failed: 'توقف', cancelled: 'أُلغي' },
  blocks: { upstream_failed: 'خطوة سابقة تعثّرت، فهذه الخطوة ما تقدر تشتغل.', objective_stopped: 'الهدف توقف؛ هذه الخطوة ما راح تشتغل.', failed: 'تعثّرت بعد إعادة المحاولات.' },
  dependency: (names) => `ينتظر ${names}`,
  filtered: (name) => `نعرض ${name}`, clearFilter: 'اعرض الكل', chiefRoot: 'CHIEF',
  timeline: {
    objective: () => 'CHIEF استلم الهدف', plan: (e) => `CHIEF خطط ${e.count} مسار عمل`, review_queued: () => 'CHIEF جدول مراجعته', synthesis_queued: () => 'CHIEF جدول الخلاصة النهائية',
    assigned: (e) => `CHIEF أسند ${e.revision ? 'تعديلًا إلى ' : ''}${e.who}`, planning: () => 'CHIEF بدأ التخطيط', synthesis: () => 'CHIEF بدأ الخلاصة النهائية', review: () => 'CHIEF بدأ يراجع شغل الفريق',
    start: (e) => `${e.who} بدأ${e.revision ? ' التعديل' : ''}`, planned: () => 'CHIEF أنهى الخطة', final: () => 'CHIEF سلّم الخلاصة النهائية', reviewed: () => 'CHIEF أنهى المراجعة',
    delivered: (e) => `${e.who} سلّم${e.revision ? ' التعديل' : ''}`, launched: (e) => `${e.who} استلم العمل الهندسي`, failed: (e) => `${e.who} ما قدر يكمل`, handoff: (e) => `تسليم من ${e.who} إلى ${e.to}`,
    switch: (e) => `${e.who} بدّل النموذج`, revision: (e) => `CHIEF طلب تعديلًا من ${e.target || 'الفريق'}`, verified: () => 'أرقام FINANCE متحقَّق منها بالكود',
    returned: (e) => `أرقام FINANCE رجعت للتصحيح (${e.count})`, waiting: (e) => `${e.who} ينتظر سعة النماذج`, completed: () => 'اكتمل الهدف', stopped: () => 'توقف الهدف', attention: (e) => `${e.who} يحتاج موافقتك`,
  },
  types: { report: 'تقرير', table: 'جدول', flow: 'مسار', timeline: 'خط زمني', kanban: 'لوحة مهام', evidence: 'أدلة', financial_model: 'نموذج مالي', chart: 'رسم بياني', checklist: 'قائمة تحقق', moodboard: 'لوحة إلهام', audit_report: 'تقرير تدقيق', risk_matrix: 'مصفوفة مخاطر', compliance_matrix: 'مصفوفة امتثال', calendar: 'تقويم' },
  capacityWait: 'ينتظر سعة النماذج المجانية — يكمل تلقائيًا',
  reasons: { network: 'خطأ شبكة', transient: 'خطأ مؤقت', 'rate limited': 'حد الاستخدام', timeout: 'انتهت المهلة' },
};

export function opsCopy(language) { return language === 'en' ? EN : AR; }

// Readable model names — never translated: "nemotron-3-ultra-550b-a55b" → "Nemotron Ultra".
const BRAND = { gpt: 'GPT', oss: 'OSS', glm: 'GLM', deepseek: 'DeepSeek', qwen: 'Qwen', gemini: 'Gemini', gemma: 'Gemma', claude: 'Claude', llama: 'Llama', kimi: 'Kimi', minimax: 'MiniMax', mistral: 'Mistral' };
export function prettyModel(model) {
  if (!model) return '';
  const base = String(model).replace(/^.*\//, '').replace(/:free$/i, '').replace(/-latest$/i, '');
  const tokens = base.split(/[-_]/).filter(Boolean);
  const named = tokens.some((token) => /^(ultra|super|nano|mini|flash|pro|lite|max|plus|turbo)$/i.test(token));
  const kept = tokens.filter((token, index) => !(named && (/^a?\d+(\.\d+)?b$/i.test(token) || (index > 0 && /^\d+$/.test(token) && /nemotron/i.test(tokens[0])))));
  return kept.map((token) => BRAND[token.toLowerCase()] || (/^\d+(\.\d+)?b$/i.test(token) ? token.toUpperCase() : /^[a-z]/.test(token) ? token.charAt(0).toUpperCase() + token.slice(1) : token)).join(' ');
}

const TONE = { WORKING: 'working', REVIEWING: 'working', COMPLETED: 'done', WAITING: 'caution', ASSIGNED: 'neutral', AVAILABLE: 'neutral', BLOCKED: 'attention', FAILED: 'attention', 'NEEDS FAHAD': 'attention' };
export const opsTone = (state) => TONE[state] || 'neutral';

// Durations without a library: "4 min 12 s" / "٤ د ١٢ ث" (digits per locale).
export function opsDuration(milliseconds, language) {
  if (milliseconds == null || !Number.isFinite(Number(milliseconds))) return '—';
  const seconds = Math.max(0, Math.round(Number(milliseconds) / 1000));
  const [h, m, s] = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
  const digits = (value) => (language === 'en' ? String(value) : Number(value).toLocaleString('ar-AE'));
  if (language === 'en') return h ? `${h} h ${m} min` : m ? `${m} min ${s} s` : `${s} s`;
  return h ? `${digits(h)} س ${digits(m)} د` : m ? `${digits(m)} د ${digits(s)} ث` : `${digits(s)} ث`;
}
export function opsTime(iso, language) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(language === 'en' ? 'en-GB' : 'ar-AE', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Dubai' });
}

// The words for a timeline entry, in the page language.
export function timelineText(entry, language) {
  const copy = opsCopy(language);
  const make = copy.timeline[entry.kind];
  return make ? make(entry) : entry.text || '';
}

// ------------------------------------------------------------------ rendering (pure)

export function renderOperations({ data, language = 'ar', esc, filterKey = null, technical = false, now = Date.now(), only = null }) {
  const t = opsCopy(language);
  const view = data?.view;
  const objectives = data?.objectives || { active: [], recent: [] };
  const model = (name) => (name ? `<bdi dir="ltr" class="ops-model" title="${esc(name)}">${esc(prettyModel(name))}</bdi>` : '');
  const chip = (state) => `<span class="ops-chip" data-tone="${opsTone(state)}"><span class="ov-dot" data-tone="${opsTone(state) === 'caution' ? 'caution' : opsTone(state)}" aria-hidden="true"></span>${esc(t.states[state] || state)}</span>`;
  const time = (iso) => (iso ? `<time datetime="${esc(iso)}">${esc(opsTime(iso, language))}</time>` : '');
  const billing = (value) => (value ? `<span class="ops-bill" data-billing="${esc(value)}">${esc(value === 'free' ? t.free : t.paid)}</span>` : '');
  const switcher = `<label class="ops-switch"><span class="sr-only">${esc(t.switcher)}</span><select class="input input-sm" data-ops-objective>
    ${objectives.active.length ? `<optgroup label="${esc(t.active)}">${objectives.active.map((job) => `<option value="${esc(job.id)}"${view?.objective.id === job.id ? ' selected' : ''}>${esc(job.title)}${job.test ? ` (${esc(t.testBadge)})` : ''}</option>`).join('')}</optgroup>` : ''}
    ${objectives.recent.length ? `<optgroup label="${esc(t.recent)}">${objectives.recent.map((job) => `<option value="${esc(job.id)}"${view?.objective.id === job.id ? ' selected' : ''}>${esc(job.title)}</option>`).join('')}</optgroup>` : ''}
    ${view && ![...objectives.active, ...objectives.recent].some((job) => job.id === view.objective.id) ? `<option value="${esc(view.objective.id)}" selected>${esc(view.objective.title)}</option>` : ''}
  </select></label>`;
  if (!view) return `<header class="ops-head"><div><span class="ops-kicker">${esc(t.live)}</span><p class="ops-empty">${esc(t.none)}</p></div>${objectives.active.length || objectives.recent.length ? switcher : ''}</header>`;

  const o = view.objective;
  const waitWords = (reason) => (!reason ? null : reason.kind === 'dependency' ? t.dependency([...new Set(reason.on.map((dep) => dep.label))].join(language === 'ar' ? '، ' : ', ')) : reason.kind === 'capacity' ? t.capacityWait : reason.text);
  const keep = (key) => !filterKey || key === filterKey || key === 'chief';
  const agents = view.agents.filter((agent) => keep(agent.key));
  const finalStateWord = o.status === 'completed' ? 'COMPLETED' : ['failed', 'cancelled'].includes(o.status) ? 'FAILED' : o.stage === 'needs_fahad' ? 'NEEDS FAHAD' : o.stage === 'waiting_capacity' ? 'WAITING' : 'WORKING';
  const freeCalls = o.attempts && o.freeAttempts === o.attempts;
  const elapsed = o.active ? `<span data-since="${esc(o.createdAt)}">${esc(opsDuration(now - Date.parse(o.createdAt), language))}</span>` : esc(opsDuration(o.elapsedMs, language));

  const head = `<header class="ops-head">
    <div class="ops-id"><span class="ops-kicker">${esc(t.live)}${o.test ? ` · <span class="ops-test">${esc(t.testBadge)}</span>` : ''}</span>
      <h2 id="opsTitle" dir="auto">${esc(o.title)}</h2>
      <p class="ops-meta">${chip(finalStateWord)}<span>${esc(t.objectiveStage[o.stage] || o.stage)}</span><span aria-hidden="true">·</span><span>${esc(t.started)} ${time(o.createdAt)}</span><span aria-hidden="true">·</span><span>${esc(o.active ? t.elapsed : t.took)} ${elapsed}</span></p></div>
    ${switcher}</header>`;
  const kpi = (value, label, tone = 'neutral', strong = false) => `<div data-tone="${tone}"${strong ? ' class="is-key"' : ''}><dt>${esc(label)}</dt><dd class="num">${value}</dd></div>`;
  const kpis = `<dl class="ops-kpis">
    ${kpi(esc(t.of(o.workstreams.completed, o.workstreams.total)), t.workstreamsDone, 'neutral', true)}
    ${kpi(o.workstreams.working, t.workingNow, o.workstreams.working ? 'working' : 'neutral')}
    ${kpi(o.workstreams.waiting, t.waiting, o.workstreams.waiting ? 'caution' : 'neutral')}
    ${kpi(o.workstreams.blocked, t.blockers, o.workstreams.blocked ? 'attention' : 'neutral')}
    ${kpi(view.needsFahad.length, t.needs, view.needsFahad.length ? 'attention' : 'neutral')}
    ${kpi(o.handoffs, t.handoffs)}${kpi(o.deliverables, t.deliverables)}
    <div><dt>${esc(t.spend)}</dt><dd class="num" dir="ltr">$${Number(o.spendUsd || 0).toFixed(o.spendUsd && o.spendUsd < 0.01 ? 4 : 2)}</dd><dd class="ops-sub">${esc(o.attempts ? (freeCalls ? t.allFree(o.attempts) : t.someCalls(o.attempts, o.freeAttempts)) : '')}</dd></div>
  </dl>`;

  // CHIEF command + delegation tree.
  const c = view.chief;
  const nextText = c.nextCode === 'synthesize_after' ? t.next.synthesize_after(c.nextAfter.join(language === 'ar' ? '، ' : ', ')) : c.nextCode ? t.next[c.nextCode] : '—';
  const chiefCard = `<section class="ops-card ops-chief" data-ops="chief" aria-labelledby="opsChiefTitle">
    <div class="ops-card-head"><h3 id="opsChiefTitle">${esc(t.chiefTitle)}</h3><button type="button" class="ov-btn" data-focus-chief>${esc(t.open)}</button></div>
    <dl class="ops-facts">
      <div><dt>${esc(t.chiefNow)}</dt><dd>${chip(c.state)} ${esc(c.actionCode === 'working' ? `${t.actions.working}` : t.actions[c.actionCode] || c.action)}</dd></div>
      <div><dt>${esc(t.chiefNext)}</dt><dd dir="auto">${esc(nextText)}</dd></div>
      ${c.waitingFor.length ? `<div><dt>${esc(t.waitingFor)}</dt><dd>${c.waitingFor.map((name) => `<bdi>${esc(name)}</bdi>`).join(language === 'ar' ? '، ' : ', ')}</dd></div>` : ''}
      <div><dt>${esc(t.planning)} · ${esc(t.synthesis)}</dt><dd>${esc(t.phase[c.planning] || c.planning)} · ${esc(t.phase[c.synthesis] || c.synthesis)}</dd></div>
      ${c.revisionRounds ? `<div><dt>${esc(t.revisionRounds)}</dt><dd class="num">${c.revisionRounds}</dd></div>` : ''}
    </dl>
    <h4 class="ops-sub-title">${esc(t.delegation)}</h4>
    <ul class="ops-tree" role="tree" aria-label="${esc(t.delegation)}">
      <li role="treeitem" aria-expanded="true" class="ops-tree-root"><button type="button" class="ops-tree-node" data-focus-chief><strong>${esc(t.chiefRoot)}</strong>${chip(c.state)}</button>
        <ul role="group">${c.tree.map((node) => `<li role="treeitem"><button type="button" class="ops-tree-node${filterKey && node.key !== filterKey ? ' is-dim' : ''}" data-focus-agent="${esc(node.key)}">
          <span class="ops-tree-who"><bdi>${esc(node.label)}</bdi>${node.revision ? `<span class="ops-rev">${esc(t.revision)}</span>` : ''}</span><span class="ops-tree-task" dir="auto">${esc(node.title)}</span>
          ${chip(node.state)}${node.after.length ? `<span class="ops-muted">${esc(t.after)} ${node.after.map((name) => `<bdi>${esc(name)}</bdi>`).join(language === 'ar' ? '، ' : ', ')}</span>` : ''}</button></li>`).join('')}</ul></li></ul>
  </section>`;

  if (only === 'chief') return chiefCard;

  // Now working: only genuine running work.
  const nowCard = `<section class="ops-card ops-now" data-ops="now" aria-labelledby="opsNowTitle" aria-live="polite">
    <div class="ops-card-head"><h3 id="opsNowTitle">${esc(t.nowTitle)} <span class="num ops-count">${view.nowWorking.length}</span></h3></div>
    ${view.nowWorking.length ? `<ul class="ops-list">${view.nowWorking.filter((entry) => keep(entry.key)).map((entry) => `<li><button type="button" class="ops-row" data-focus-agent="${esc(entry.key)}">
      <span class="ops-row-main"><strong><bdi>${esc(entry.label)}</bdi></strong> ${chip(entry.state)}<span class="ops-row-task" dir="auto">${esc(entry.task)}</span></span>
      <span class="ops-row-side"><span>${esc(t.since)} <span data-since="${esc(entry.startedAt || '')}">${esc(opsDuration(entry.elapsedMs, language))}</span></span>${entry.model ? `<span>${model(entry.model)} ${billing(entry.billing)}</span>` : `<span class="ops-muted">${esc(t.noModel)}</span>`}</span>
      ${entry.lastActivity ? `<span class="ops-row-last ops-muted">${esc(t.lastActivity)} ${time(entry.lastActivity.at)}</span>` : ''}</button></li>`).join('')}</ul>` : `<p class="ops-empty">${esc(t.nobody)}</p>`}
  </section>`;

  // Needs Fahad + capacity waits (clearly separate: one asks Fahad, one does not).
  const needsCard = `<section class="ops-card ops-needs" data-ops="needs" aria-labelledby="opsNeedsTitle">
    <div class="ops-card-head"><h3 id="opsNeedsTitle">${esc(t.needsTitle)} <span class="num ops-count" data-tone="${view.needsFahad.length ? 'attention' : 'neutral'}">${view.needsFahad.length}</span></h3></div>
    ${view.needsFahad.length ? `<ul class="ops-list">${view.needsFahad.map((item) => `<li><a class="ops-row ops-need" href="${item.sessionId ? `#/task/${esc(item.sessionId)}` : '#/attention'}">
      <span class="ops-row-main"><strong>${esc(t.needKinds[item.kind] || item.kind)}</strong>${item.agentLabel ? ` · <bdi>${esc(item.agentLabel)}</bdi>` : ''}<span class="ops-row-task" dir="auto">${esc(item.text)}</span></span></a></li>`).join('')}</ul>` : `<p class="ops-empty">${esc(t.nothingNeeds)}</p>`}
    ${view.capacity.length ? `<div class="ops-capacity" role="status"><h4 class="ops-sub-title">${esc(t.capacityTitle)}</h4>${view.capacity.map((wait) => `<div class="ops-wait"><p><strong>${esc(t.capacityWho(wait.label))}</strong></p>
      ${wait.detail ? `<p class="ops-muted" dir="ltr">${esc(wait.detail)}</p>` : ''}<p class="ops-muted"><span class="ops-armed">${esc(t.autoResume)}</span> · ${esc(t.retryAt)} ${time(wait.until)}</p></div>`).join('')}</div>` : ''}
  </section>`;

  // Agent live work cards.
  const agentCard = (agent) => {
    const wait = waitWords(agent.waitReason);
    const routing = view.routing.find((entry) => entry.taskId === agent.taskId);
    return `<article class="ops-agent" data-tone="${opsTone(agent.state)}" data-key="${esc(agent.key)}">
      <header><button type="button" class="ops-agent-name" data-focus-agent="${esc(agent.key)}"><bdi>${esc(agent.label)}</bdi></button>${chip(agent.state)}</header>
      <p class="ops-agent-task" dir="auto">${esc(agent.task)}</p>
      ${agent.department ? `<p class="ops-muted">${esc(agent.department)}</p>` : ''}
      ${wait ? `<p class="ops-reason" data-tone="caution">${esc(wait)}</p>` : ''}
      ${agent.blockCode ? `<p class="ops-reason" data-tone="attention">${esc(t.blocks[agent.blockCode] || agent.blockReason || '')}</p>` : ''}
      ${agent.needsFahad ? `<p class="ops-reason" data-tone="attention">${esc(t.needKinds[agent.needsFahad.kind] || '')}: ${esc(agent.needsFahad.text)}</p>` : ''}
      <dl class="ops-agent-facts">
        <div><dt>${esc(t.started)}</dt><dd>${agent.startedAt ? time(agent.startedAt) : '—'}</dd></div>
        <div><dt>${esc(t.elapsed)}</dt><dd>${['WORKING', 'REVIEWING'].includes(agent.state) && agent.startedAt ? `<span data-since="${esc(agent.startedAt)}">${esc(opsDuration(agent.elapsedMs, language))}</span>` : esc(opsDuration(agent.elapsedMs, language))}</dd></div>
        <div><dt>${esc(t.provider)}</dt><dd>${agent.model ? `${model(agent.model)} ${billing(agent.billing)}` : '—'}</dd></div>
        <div><dt>${esc(t.attempts)} · ${esc(t.handoffs)}</dt><dd class="num">${agent.attempts} · ${agent.handoffs}</dd></div>
        <div><dt>${esc(t.deliverablesShort)}</dt><dd class="num">${agent.deliverables}</dd></div>
        <div><dt>${esc(t.lastActivity)}</dt><dd>${agent.lastActivityAt ? time(agent.lastActivityAt) : '—'}</dd></div>
      </dl>
      ${agent.revision ? `<p class="ops-rev-line">${esc(t.revision)}: ${esc({ 'revision requested': t.revisionSteps.revision_requested, 'revision in progress': t.revisionSteps.revision_in_progress, 'revision delivered': t.revisionSteps.revision_delivered }[agent.revision] || agent.revision)}</p>` : ''}
      ${agent.latestOutput ? `<p class="ops-output" dir="auto"><span class="ops-muted">${esc(t.latestOutput)}:</span> ${esc(agent.latestOutput.summary.slice(0, 180))}</p>` : ''}
      ${routing && (routing.switches.length || routing.attempts > 1) ? `<details class="ops-routing"><summary>${esc(t.routeDetails)}${routing.switches.length ? ` · ${routing.switches.length} ${esc(t.switches)}` : ''}</summary>
        <ol class="ops-path" dir="ltr">${routing.path.map((step) => `<li data-status="${esc(step.status)}">${esc(prettyModel(step.model) || step.provider)}${step.error ? ` <span class="ops-muted">→ ${esc(t.reasons[String(step.error).replace(/^PROVIDER_/, '').toLowerCase().replace(/_/g, ' ')] || step.error)}</span>` : ''}</li>`).join('')}</ol></details>` : ''}
    </article>`;
  };
  const team = `<section class="ops-card ops-team" data-ops="team" aria-labelledby="opsTeamTitle">
    <div class="ops-card-head"><h3 id="opsTeamTitle">${esc(t.teamTitle)}</h3>${filterKey ? `<button type="button" class="ov-btn" data-clear-filter>${esc(t.clearFilter)}</button>` : ''}</div>
    <div class="ops-agents">${agents.map(agentCard).join('')}</div></section>`;

  // Pipeline: Plan → Assigned → Running → Delivered → Review → Revision → Final.
  const STAGES = ['plan', 'assigned', 'running', 'delivered', 'review', 'revision', 'final'];
  const pipeline = `<section class="ops-card ops-pipeline-card" data-ops="pipeline" aria-labelledby="opsPipeTitle">
    <div class="ops-card-head"><h3 id="opsPipeTitle">${esc(t.pipelineTitle)}</h3></div>
    <ol class="ops-stages" aria-hidden="true">${STAGES.map((stage) => `<li>${esc(t.stages[stage])}</li>`).join('')}</ol>
    <ol class="ops-lanes">${view.pipeline.filter((lane) => keep(lane.key)).map((lane) => {
      const at = STAGES.indexOf(lane.stage);
      const wait = waitWords(lane.waitReason);
      return `<li class="ops-lane" data-tone="${opsTone(lane.state)}"><button type="button" class="ops-lane-who" data-focus-agent="${esc(lane.key)}"><bdi>${esc(lane.label)}</bdi>${lane.revision ? `<span class="ops-rev">${esc(t.revision)}</span>` : ''}</button>
        <span class="ops-lane-title" dir="auto">${esc(lane.title)}</span>
        <span class="ops-track" role="img" aria-label="${esc(`${t.stages[lane.stage]} — ${t.states[lane.state] || lane.state}`)}">${STAGES.map((stage, index) => `<i data-on="${index < at ? 'past' : index === at ? 'now' : 'next'}"></i>`).join('')}</span>
        <span class="ops-lane-state">${chip(lane.state)}${wait ? `<span class="ops-muted">${esc(wait)}</span>` : ''}</span></li>`;
    }).join('')}</ol>
    ${view.revisions.length ? `<h4 class="ops-sub-title">${esc(t.revisionsTitle)}</h4>${view.revisions.map((round) => `<ol class="ops-revision">${round.steps.map((step) => `<li><span class="ops-rev-who"><bdi>${esc(step.by === 'chief' ? 'CHIEF' : round.agentLabel)}</bdi></span><span>${esc(t.revisionSteps[step.step] || step.step)}</span>${time(step.at)}</li>`).join('')}</ol>`).join('')}` : ''}
  </section>`;

  // Handoff center.
  const handoffs = view.handoffs.filter((handoff) => keep(handoff.fromKey) || keep(handoff.toKey));
  const handoffCard = `<section class="ops-card ops-handoffs" data-ops="handoffs" aria-labelledby="opsHandoffTitle">
    <div class="ops-card-head"><h3 id="opsHandoffTitle">${esc(t.handoffTitle)} <span class="num ops-count">${handoffs.length}</span></h3></div>
    ${handoffs.length ? `<ul class="ops-list">${handoffs.map((handoff) => `<li><button type="button" class="ops-row ops-handoff${handoff.fresh ? ' is-fresh' : ''}" data-handoff="${esc(handoff.id)}">
      <span class="ops-row-main"><strong><bdi>${esc(handoff.from)}</bdi> ${language === 'ar' ? '←' : '→'} <bdi>${esc(handoff.to)}</bdi></strong><span class="ops-chip" data-tone="${handoff.status === 'delivered' ? 'done' : ['failed', 'blocked'].includes(handoff.status) ? 'attention' : handoff.status === 'in progress' ? 'working' : 'neutral'}">${esc(t.handoffStatus[handoff.status] || handoff.status)}</span>
        ${handoff.toTask ? `<span class="ops-row-task" dir="auto">${esc(t.toTask)}: ${esc(handoff.toTask.title)}</span>` : ''}
        ${handoff.what ? `<span class="ops-row-what ops-muted" dir="auto">${esc(t.handedOver)}: ${esc(handoff.what.slice(0, 140))}</span>` : ''}</span>
      <span class="ops-row-side">${time(handoff.at)}<span class="ops-link-word">${esc(t.showRoute)}</span></span></button></li>`).join('')}</ul>` : `<p class="ops-empty">${esc(t.noHandoffs)}</p>`}
  </section>`;

  // Timeline (technical detail expands).
  const entries = view.timeline.filter((entry) => (technical || !entry.technical) && (keep(entry.agentKey) || keep(entry.toKey))).toReversed();
  const timelineCard = `<section class="ops-card ops-timeline" data-ops="timeline" aria-labelledby="opsTimelineTitle">
    <div class="ops-card-head"><h3 id="opsTimelineTitle">${esc(t.timelineTitle)}</h3><label class="ops-toggle"><input type="checkbox" data-technical${technical ? ' checked' : ''}> ${esc(t.technical)}</label></div>
    ${entries.length ? `<ol class="ops-events" aria-live="polite">${entries.slice(0, technical ? 160 : 80).map((entry) => `<li data-kind="${esc(entry.kind)}"${entry.technical ? ' class="is-technical"' : ''}>${time(entry.at)}<span class="ops-event" dir="auto">${esc(timelineText(entry, language))}${entry.model ? ` · ${model(entry.model)}` : ''}${entry.kind === 'switch' ? ` <bdi dir="ltr" class="ops-model">${esc(prettyModel(entry.from))} → ${esc(prettyModel(entry.to))}</bdi>${entry.reason ? ` <span class="ops-muted">(${esc(t.reasons[entry.reason] || entry.reason)})</span>` : ''}` : ''}${['assigned', 'delivered', 'launched'].includes(entry.kind) && entry.title ? ` <span class="ops-muted">— ${esc(entry.title)}</span>` : ''}${entry.detail ? `<span class="ops-muted ops-detail" dir="ltr">${esc(entry.detail)}</span>` : ''}</span></li>`).join('')}</ol>` : `<p class="ops-empty">${esc(t.noTimeline)}</p>`}
  </section>`;

  // Deliverables, with the FINAL SYNTHESIS separate.
  const deliverables = view.deliverables.filter((item) => keep(item.agentKey));
  const deliverableCard = `<section class="ops-card ops-deliverables" data-ops="deliverables" aria-labelledby="opsDelivTitle">
    <div class="ops-card-head"><h3 id="opsDelivTitle">${esc(t.deliverablesTitle)} <span class="num ops-count">${deliverables.length}</span></h3></div>
    <div class="ops-final" data-ready="${view.final ? 'true' : 'false'}"><h4>${esc(t.finalTitle)}</h4>${view.final ? `<p dir="auto">${esc(view.final.summary)}</p><p class="ops-muted">CHIEF · ${time(view.final.at)}</p>${o.conversationId ? `<a class="ov-btn" href="#/chat/${esc(o.conversationId)}">${esc(t.open)}</a>` : `<a class="ov-btn" href="#/workflow/${esc(o.id)}">${esc(t.open)}</a>`}` : `<p class="ops-muted">${esc(t.finalPending)}</p>`}</div>
    ${deliverables.length ? `<ul class="ops-deliv">${deliverables.toReversed().map((item) => `<li><button type="button" class="ops-row" data-deliverable="${esc(item.id)}" data-focus-agent="${esc(item.agentKey)}">
      <span class="ops-row-main"><strong><bdi>${esc(item.agentLabel)}</bdi></strong> <span class="ops-type">${esc(t.types[item.type] || item.type)}</span>${item.revision ? `<span class="ops-rev">${esc(t.revision)}</span>` : ''}${item.verification ? `<span class="ops-chip" data-tone="${item.verification === 'VERIFIED' ? 'done' : 'caution'}">${esc(item.verification === 'VERIFIED' ? t.verified : item.verification === 'NEEDS REVIEW' ? t.needsReview : item.verification)}</span>` : ''}
        <span class="ops-row-task" dir="auto">${esc(item.title || '')}</span>${item.preview ? `<span class="ops-muted" dir="auto">${esc(item.preview.slice(0, 160))}</span>` : ''}<span class="ops-muted">${esc(t.fromTask)}: <span dir="auto">${esc(item.taskTitle || '')}</span></span></span>
      <span class="ops-row-side">${time(item.at)}</span></button></li>`).join('')}</ul>` : `<p class="ops-empty">${esc(t.noDeliverables)}</p>`}
  </section>`;

  return `${head}${kpis}${filterKey ? `<p class="ops-filter">${esc(t.filtered(view.agents.find((agent) => agent.key === filterKey)?.label || filterKey.toUpperCase()))} <button type="button" class="ov-btn" data-clear-filter>${esc(t.clearFilter)}</button></p>` : ''}
    <div class="ops-board">${nowCard}${needsCard}${chiefCard}${timelineCard}${deliverableCard}${team}${pipeline}${handoffCard}</div>`;
}

// Compact objective strip for the 3D overview (executive glance).
export function renderObjectiveStrip({ data, language = 'ar', esc }) {
  const view = data?.view;
  if (!view) return '';
  const t = opsCopy(language);
  const o = view.objective;
  const done = view.agents.filter((agent) => agent.state === 'COMPLETED').length;
  const waiting = view.agents.filter((agent) => agent.state === 'WAITING').length;
  return `<button type="button" class="ov-objective" data-open-ops aria-label="${esc(`${t.live}: ${o.title}`)}">
    <span class="ov-dot" data-tone="${o.active ? (o.stage === 'needs_fahad' ? 'attention' : o.stage === 'waiting_capacity' ? 'caution' : 'working') : o.status === 'completed' ? 'done' : 'attention'}" aria-hidden="true"></span>
    <span class="ov-objective-title" dir="auto">${esc(o.title)}</span>
    <span class="ov-objective-meta">${esc(t.objectiveStage[o.stage] || o.stage)} · ${esc(t.of(o.workstreams.completed, o.workstreams.total))} · ${view.nowWorking.length} ${esc(t.workingNow)}${waiting ? ` · ${waiting} ${esc(t.waiting)}` : ''}${done ? '' : ''}${view.needsFahad.length ? ` · <strong>${view.needsFahad.length} ${esc(t.needs)}</strong>` : ''} · ${esc(t.synthesis)}: ${esc(t.phase[view.chief.synthesis] || view.chief.synthesis)}</span></button>`;
}

// ------------------------------------------------------------------ mount (DOM)

const readPref = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
const writePref = (key, value) => { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch { /* private mode */ } };

// hooks: { focusAgent(key), focusChief(), showHandoff(handoff), focusDeliverable(item), onData(data) }
export function mountOperations(container, ctx, { language, hooks = {} }) {
  const { api, esc, q, ws } = ctx;
  let data = null;
  let signature = '';
  let pinned = null; // an objective Fahad chose; otherwise follow the current one
  let filterKey = null;
  let technical = readPref('hub-ops-technical', '') === 'on';
  let loading = null;

  const draw = () => {
    container.innerHTML = renderOperations({ data, language, esc, filterKey, technical });
    bind();
  };
  const bind = () => {
    container.querySelector('[data-ops-objective]')?.addEventListener('change', (event) => { pinned = event.target.value || null; refresh(true).catch(() => {}); });
    container.querySelector('[data-technical]')?.addEventListener('change', (event) => { technical = event.target.checked; writePref('hub-ops-technical', technical ? 'on' : ''); draw(); });
    container.querySelectorAll('[data-clear-filter]').forEach((button) => { button.onclick = () => setFilter(null); });
    container.querySelectorAll('[data-focus-chief]').forEach((button) => { button.onclick = () => hooks.focusChief?.(); });
    container.querySelectorAll('[data-focus-agent]').forEach((button) => {
      if (button.dataset.deliverable) return;
      button.onclick = () => hooks.focusAgent?.(button.dataset.focusAgent);
    });
    container.querySelectorAll('[data-deliverable]').forEach((button) => {
      button.onclick = () => hooks.focusDeliverable?.(data.view.deliverables.find((item) => item.id === button.dataset.deliverable));
    });
    container.querySelectorAll('[data-handoff]').forEach((button) => {
      button.onclick = () => hooks.showHandoff?.(data.view.handoffs.find((handoff) => handoff.id === button.dataset.handoff));
    });
  };
  const refresh = async (force = false) => {
    if (loading) return loading;
    loading = (async () => {
      try {
        const next = await api(`/api/operations${q({ workspaceId: ws(), ...(pinned ? { jobId: pinned } : {}) })}`);
        // Elapsed times move every second on their own (local ticker); they never force a redraw.
        const nextSignature = JSON.stringify(next, (key, value) => (key === 'elapsedMs' ? undefined : value));
        if (!force && nextSignature === signature) return data;
        signature = nextSignature; data = next;
        if (!container.contains(document.activeElement) || force) draw();
        else { const focused = document.activeElement; const key = focused?.dataset?.focusAgent || focused?.dataset?.handoff || null; draw(); if (key) container.querySelector(`[data-focus-agent="${CSS.escape(key)}"], [data-handoff="${CSS.escape(key)}"]`)?.focus(); }
        hooks.onData?.(data);
        return data;
      } catch (error) {
        if (!data) container.innerHTML = `<p class="ops-empty">${esc(opsCopy(language).error)}</p>`;
        throw error;
      } finally { loading = null; }
    })();
    return loading;
  };
  const setFilter = (key) => { const next = key && key !== 'chief' ? key : null; if (next === filterKey) return; filterKey = next; if (data) draw(); };
  // Live elapsed counters: local clock only, no network.
  const ticker = setInterval(() => {
    if (!container.isConnected) { clearInterval(ticker); return; }
    for (const element of container.querySelectorAll('[data-since]')) { const since = Date.parse(element.dataset.since); if (Number.isFinite(since)) element.textContent = opsDuration(Date.now() - since, language); }
  }, 1000);
  ctx.onLeave?.(() => clearInterval(ticker));
  container.innerHTML = `<p class="ops-empty" aria-busy="true">${esc(opsCopy(language).loading)}</p>`;
  return { refresh, setFilter, data: () => data, filter: () => filterKey };
}
