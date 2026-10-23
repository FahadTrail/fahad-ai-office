// Fahad AI Office — the premium redesign's primary screens: المكتب (Office),
// تفاصيل المهمة (Job Detail) and الأرشيف (Archive).
//
// Presentation only. Every value comes from an existing owner-gated API:
//   /api/work/current, /api/work/history, /api/work/objectives/:id  (work platform contract)
//   /api/workflows/:id   task graph, employee outputs, final synthesis, handoffs
//   /api/conversations   CHIEF submission and Reply & Continue (multi-turn)
//   /api/attention, /api/office, /api/work/sessions   owner attention, employee state, open coding sessions
// Nothing here writes workflow state except the existing conversation
// endpoints the old Hub already used. Unknown stays unknown.

import {
  ROSTER, arabicCount, codingSessionState, createRefresher, deliveryProgress, fractionLabel, objectiveSignature, employeeColor, employeeCopy, employeeState, employeeTabs, fractionWidth, greeting,
  isTerminal, jobStatus, nodeStateLabel, numericDate, outputTypes, phaseWords, archiveFilter, workflowMap, workflowMetrics,
} from './office-model.js';

const ICON = {
  send: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>',
  back: '<svg class="ico flip-rtl" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  check: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  alert: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>',
  copy: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
  download: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>',
  clock: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
};

const words = (ctx) => (ar, en) => (ctx.language === 'en' ? en : ar);
const lang = (ctx) => (ctx.language === 'en' ? 'en' : 'ar');

function dot(slug, extra = '') {
  return `<span class="emp-dot ${extra}" style="--emp:${employeeColor(slug)}" aria-hidden="true"></span>`;
}
function avatars(ctx, people = [], max = 5) {
  const list = people.slice(0, max);
  const more = people.length - list.length;
  const names = people.map((person) => person.label).join('، ');
  return `<span class="avatars" title="${ctx.esc(names)}">${list.map((person) => `<span class="avatar-sm" style="--emp:${employeeColor(person.slug)}" aria-hidden="true">${ctx.esc(String(person.label || '?').slice(0, 1))}</span>`).join('')}${more > 0 ? `<span class="avatar-sm avatar-more" aria-hidden="true">+${more}</span>` : ''}<span class="sr-only">${ctx.esc(names)}</span></span>`;
}
function statusPill(ctx, row) {
  const status = jobStatus(row, lang(ctx));
  return `<span class="status-pill tone-${status.tone}">${ctx.esc(status.label)}</span>`;
}
function skeleton(lines = 3) {
  return `<div class="skeleton" aria-hidden="true">${Array.from({ length: lines }, () => '<span></span>').join('')}</div>`;
}
function isoDate(ctx, value) {
  const text = numericDate(value);
  return text ? `<time class="num" dir="ltr" datetime="${ctx.esc(value)}">${ctx.esc(text)}</time>` : '';
}

const MAP_CARD_W = 196;
const MAP_CARD_H = 76;
const MAP_STEP_X = 260;
const MAP_STEP_Y = 98;
const MAP_PAD = 20;

function stageRail(ctx, steps = []) {
  const t = words(ctx);
  const ar = lang(ctx) === 'ar';
  if (!steps.length) return `<div class="stage-empty small muted">${t('لم تُسجّل مراحل CHIEF بعد.', 'CHIEF stages have not been recorded yet.')}</div>`;
  return `<ol class="stage-rail" tabindex="0" aria-label="${t('مراحل تنفيذ المهمة', 'Job stages')}">${steps.map((step, index) => {
    const state = STEP_STATE[step.state] || [step.state, step.state];
    const label = STEP_WORDS[step.id] || [step.id, step.id];
    return `<li class="stage-stop is-${ctx.esc(step.state)}" ${step.state === 'current' ? 'aria-current="step"' : ''}><span class="stage-index num" aria-hidden="true">${index + 1}</span><span><strong>${ctx.esc(label[ar ? 0 : 1])}</strong><small>${ctx.esc(state[ar ? 0 : 1])}</small></span></li>`;
  }).join('')}</ol>`;
}

function workflowVisual(ctx, workflow, objective) {
  const t = words(ctx);
  const graph = workflowMap(workflow.nodes, { maxNodes: 24 });
  const metrics = workflowMetrics(workflow.nodes, workflow.handoffs);
  const width = Math.max(420, graph.columns * MAP_STEP_X + MAP_PAD * 2 - (MAP_STEP_X - MAP_CARD_W));
  const height = Math.max(116, graph.rows * MAP_STEP_Y + MAP_PAD * 2 - (MAP_STEP_Y - MAP_CARD_H));
  const position = new Map(graph.nodes.map((node) => [node.id, { x: MAP_PAD + node.level * MAP_STEP_X, y: MAP_PAD + node.row * MAP_STEP_Y }]));
  const edges = graph.edges.map((edge) => {
    const from = position.get(edge.from); const to = position.get(edge.to);
    if (!from || !to) return '';
    const x1 = from.x + MAP_CARD_W; const y1 = from.y + MAP_CARD_H / 2; const x2 = to.x; const y2 = to.y + MAP_CARD_H / 2;
    const bend = x1 + Math.max(22, (x2 - x1) / 2);
    return `<path class="map-edge${edge.active ? ' is-live' : ''}" d="M${x1} ${y1} C${bend} ${y1} ${bend} ${y2} ${x2} ${y2}"/>`;
  }).join('');
  const nodes = graph.nodes.map((node) => {
    const pos = position.get(node.id);
    const employee = node.agentSlug ? ` data-map-employee="${ctx.esc(node.agentSlug)}"` : '';
    const element = node.agentSlug ? 'button' : 'div';
    const label = `${node.agentLabel || t('مهمة', 'Task')} — ${node.title} — ${nodeStateLabel(node.state, lang(ctx))}`;
    return `<${element} ${node.agentSlug ? 'type="button"' : ''} class="map-node st-${ctx.esc(node.state)}${node.state === 'working' ? ' is-live' : ''}" style="--map-x:${pos.x}px;--map-y:${pos.y}px;--emp:${employeeColor(node.agentSlug)}"${employee} aria-label="${ctx.esc(label)}">
      <span class="map-node-top"><span class="emp-dot" aria-hidden="true"></span><span class="map-agent" dir="ltr">${ctx.esc(node.agentLabel || t('النظام', 'System'))}</span>${node.revision ? `<span class="tag">${t('تعديل', 'Revision')}</span>` : ''}</span>
      <strong dir="auto">${ctx.esc(node.title || t('خطوة بدون عنوان', 'Untitled step'))}</strong><small>${ctx.esc(nodeStateLabel(node.state, lang(ctx)))}</small>
    </${element}>`;
  }).join('');
  const map = graph.nodes.length ? `<div class="workflow-map-scroll" tabindex="0" aria-label="${t('خريطة قابلة للتمرير من CHIEF إلى التسليم النهائي', 'Scrollable map from CHIEF to final delivery')}"><div class="workflow-map" style="--map-w:${width}px;--map-h:${height}px" role="group"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true" focusable="false">${edges}</svg>${nodes}</div></div>${graph.hidden ? `<p class="map-limit small muted">${t(`تظهر أول ${graph.nodes.length} خطوة من ${graph.nodes.length + graph.hidden} لحماية الأداء. كل الخطوات موجودة في تفاصيل التنفيذ.`, `Showing the first ${graph.nodes.length} of ${graph.nodes.length + graph.hidden} steps for performance. Every step remains in Execution details.`)}</p>` : ''}`
    : `<div class="chart-empty"><strong>${t('لا توجد خريطة بعد', 'No map yet')}</strong><span>${t('ستظهر العلاقات فور تسجيل مهام واعتماديات حقيقية.', 'Relationships appear once real tasks and dependencies are recorded.')}</span></div>`;
  const total = metrics.total;
  const statusOrder = [['done', t('سُلّمت', 'Delivered')], ['working', t('تعمل الآن', 'Working now')], ['waiting', t('بانتظار', 'Waiting')], ['capacity', t('سعة', 'Capacity')], ['failed', t('متعثّرة', 'Failed')]];
  const statusChart = total ? `<div class="status-chart" role="img" aria-label="${t(`${total} خطوة تسليم مسجلة`, `${total} recorded delivery steps`)}"><div class="status-stack">${statusOrder.filter(([key]) => metrics.statuses[key]).map(([key, label]) => `<span class="seg seg-${key}" style="width:${(metrics.statuses[key] / total) * 100}%" title="${ctx.esc(`${label}: ${metrics.statuses[key]}`)}"></span>`).join('')}</div><div class="chart-legend">${statusOrder.filter(([key]) => metrics.statuses[key]).map(([key, label]) => `<span><i class="seg-${key}"></i>${label} <b class="num">${metrics.statuses[key]}</b></span>`).join('')}</div></div>`
    : `<div class="chart-empty"><strong>${t('لا توجد تكليفات بعد', 'No assignments yet')}</strong><span>${t('CHIEF ما زال في مرحلة التخطيط.', 'CHIEF is still planning.')}</span></div>`;
  const maxWork = Math.max(1, ...metrics.employees.map((employee) => employee.total));
  const workload = metrics.employees.length ? `<div class="workload-chart">${metrics.employees.map((employee) => `<button type="button" class="workload-row" data-map-employee="${ctx.esc(employee.slug)}"><span class="workload-name" dir="ltr">${ctx.esc(employee.label)}</span><span class="workload-bar"><i style="width:${Math.round((employee.total / maxWork) * 100)}%;--emp:${employeeColor(employee.slug)}"></i></span><span class="num">${employee.done}/${employee.total}</span></button>`).join('')}</div>`
    : `<div class="chart-empty"><strong>${t('لا يوجد توزيع فريق بعد', 'No team distribution yet')}</strong><span>${t('لن نعرض نسبًا قبل وصول تكليفات حقيقية.', 'No ratios are shown until real assignments exist.')}</span></div>`;
  const cost = workflow.job.costUsd == null ? t('غير متاح', 'Unavailable') : `$${Number(workflow.job.costUsd).toFixed(Number(workflow.job.costUsd) < 0.1 ? 4 : 2)}`;
  const stages = objective?.orchestration?.steps || [];
  return `<section class="journey material" aria-labelledby="journeyTitle"><div class="journey-head"><div><span class="eyebrow">${t('مباشر من سجل المهمة', 'Live from the job record')}</span><h2 id="journeyTitle">${t('رحلة التنفيذ', 'Execution journey')}</h2></div><span class="event-cue" role="status"><span class="live-dot${isTerminal(workflow.job.status) ? ' is-off' : ''}" aria-hidden="true"></span>${isTerminal(workflow.job.status) ? t('انتهت المهمة', 'Job ended') : t('يتحدّث مع أحداث المكتب', 'Updating with Office events')}</span></div>
    ${stageRail(ctx, stages)}
    <div class="map-head"><div><h3>${t('خريطة التفويض والاعتماديات', 'Delegation & dependency map')}</h3><p>${t('كل خط أدناه اعتماد مسجّل فعليًا، وليس مسارًا تخمينيًا.', 'Every line below is a recorded dependency, never an inferred route.')}</p></div><span class="metric-chip"><b class="num">${metrics.handoffs}</b>${t('تسليمات', 'handoffs')}</span></div>${map}
    <div class="insight-grid"><section class="insight-card"><div class="insight-head"><h3>${t('حالة خطوات التسليم', 'Delivery-step status')}</h3><span class="metric-chip"><b class="num">${total}</b>${t('خطوة', 'steps')}</span></div>${statusChart}</section>
      <section class="insight-card"><div class="insight-head"><h3>${t('توزيع التكليفات', 'Assignment distribution')}</h3><span class="metric-chip"><b class="num" dir="ltr">${ctx.esc(cost)}</b>${t('تكلفة مسجلة', 'recorded cost')}</span></div>${workload}</section></div></section>`;
}

// ===================================================================== Office
export async function renderOfficeHome(ctx) {
  const t = words(ctx);
  const ar = lang(ctx) === 'ar';
  ctx.setTitle(t('المكتب', 'Office'));
  const workspace = ctx.workspaces().find((item) => item.id === ctx.ws());
  ctx.view.innerHTML = `<div class="pg office-home">
    <section class="hero" aria-labelledby="greeting">
      <h1 id="greeting" class="display">${ctx.esc(greeting(new Date().getHours(), lang(ctx)))}</h1>
      <p class="hero-sub">${t('فريقك جاهز. ماذا تريد أن ننجز اليوم؟', 'Your team is ready. What should we get done today?')}</p>
      <form class="command material" id="command" novalidate>
        <label class="sr-only" for="goal">${t('الهدف المطلوب من CHIEF', 'Goal for CHIEF')}</label>
        <textarea id="goal" class="command-input" rows="1" dir="auto" maxlength="8000" placeholder="${t('اكتب الهدف الذي تريد إنجازه…', 'Describe the goal — CHIEF coordinates the team…')}"></textarea>
        <div class="command-bar">
          <details class="command-options">
            <summary>${t('المشروع', 'Project')}: <strong dir="auto">${ctx.esc(workspace?.name || t('غير محدد', 'None'))}</strong></summary>
            <div class="command-options-body">
              <label class="field-label" for="commandProject">${t('المشروع الحالي', 'Current project')}</label>
              <select id="commandProject" class="input input-sm">${ctx.workspaces().map((item) => `<option value="${ctx.esc(item.id)}" ${item.id === ctx.ws() ? 'selected' : ''}>${ctx.esc(item.name)}</option>`).join('')}</select>
              <p class="small muted">${t('CHIEF يستخدم سياق المشروع وذاكرته. الإجراءات المحمية تبقى بحاجة لموافقتك.', 'CHIEF uses the project context and memory. Protected actions still need your approval.')}</p>
              <div class="row"><a class="btn btn-sm" href="#/chief">${t('محادثة كاملة مع CHIEF', 'Full CHIEF chat')}</a><a class="btn btn-sm" href="#/code">${t('مهمة برمجية', 'Coding task')}</a><a class="btn btn-sm" href="#/settings/team">${t('تحدّث مع موظف مباشرة', 'Talk to an employee')}</a></div>
            </div>
          </details>
          <button class="btn btn-primary btn-send" type="submit" id="sendGoal">${ICON.send}<span>${t('أرسل', 'Send')}</span></button>
        </div>
        <p class="form-error hidden" id="commandError" role="alert"></p>
      </form>
      <div id="attentionSlot" aria-live="polite"></div>
    </section>
    <section class="group" aria-labelledby="activeTitle">
      <div class="group-head"><h2 id="activeTitle">${t('قيد العمل', 'Active work')}</h2><span class="live-state" id="liveState" aria-live="polite"></span></div>
      <div id="activeSlot">${skeleton(2)}</div>
    </section>
    <section class="group" aria-labelledby="teamTitle">
      <div class="group-head"><h2 id="teamTitle">${t('الفريق', 'The team')}</h2><a class="group-link" href="#/settings/team">${t('كل الفريق', 'Team settings')}</a></div>
      <div id="teamSlot">${skeleton(2)}</div>
    </section>
  </div>`;

  const goal = ctx.view.querySelector('#goal');
  const grow = () => { goal.style.height = 'auto'; goal.style.height = `${Math.min(goal.scrollHeight, 260)}px`; };
  goal.addEventListener('input', grow);
  goal.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); ctx.view.querySelector('#command').requestSubmit(); }
  });
  ctx.view.querySelector('#commandProject').onchange = (event) => ctx.switchProject(event.target.value);
  const error = (message) => {
    const element = ctx.view.querySelector('#commandError');
    element.textContent = message || '';
    element.classList.toggle('hidden', !message);
  };
  ctx.view.querySelector('#command').onsubmit = async (event) => {
    event.preventDefault();
    const message = goal.value.trim();
    if (!message) { error(t('اكتب الهدف أولًا.', 'Write the goal first.')); goal.focus(); return; }
    if (!ctx.ws()) { error(t('اختر مشروعًا أولًا.', 'Choose a project first.')); return; }
    error('');
    const button = ctx.view.querySelector('#sendGoal');
    button.disabled = true;
    button.classList.add('is-busy');
    try {
      // The same authenticated flow as the CHIEF chat: a conversation and its job.
      const created = await ctx.api('/api/conversations', { method: 'POST', body: { workspaceId: ctx.ws(), message } });
      goal.value = '';
      ctx.refreshSidebar();
      location.hash = created.jobId ? `#/job/${created.jobId}` : `#/chat/${created.conversation.id}`;
    } catch (failure) {
      error(ctx.humanError(failure.message));
      button.disabled = false;
      button.classList.remove('is-busy');
    }
  };
  try { const draft = sessionStorage.getItem('hub-office-draft'); if (draft) { goal.value = draft; sessionStorage.removeItem('hub-office-draft'); grow(); } } catch {}

  // Workflow graphs are cached per objective and refetched only when that
  // objective's summary changed, at most four at a time.
  const graphs = new Map();
  const fetchGraphs = async (objectives) => {
    const stale = objectives.filter((objective) => graphs.get(objective.id)?.signature !== objectiveSignature(objective));
    for (let index = 0; index < stale.length; index += 4) {
      await Promise.all(stale.slice(index, index + 4).map(async (objective) => {
        try { graphs.set(objective.id, { signature: objectiveSignature(objective), graph: await ctx.api(`/api/workflows/${objective.id}`) }); }
        catch { graphs.delete(objective.id); }
      }));
    }
    for (const id of graphs.keys()) if (!objectives.some((objective) => objective.id === id)) graphs.delete(id);
  };
  const load = async () => {
    const [current, attention, office, sessions] = await Promise.allSettled([
      ctx.api(`/api/work/current${ctx.q({ workspaceId: ctx.ws() })}`),
      ctx.api(`/api/attention${ctx.q({ workspaceId: ctx.ws() })}`),
      ctx.api(`/api/office${ctx.q({ workspaceId: ctx.ws() })}`),
      ctx.api(`/api/work/sessions${ctx.q({ workspaceId: ctx.ws(), scope: 'current' })}`),
    ]);
    const objectives = current.status === 'fulfilled' ? [...current.value.needsOwner, ...current.value.active, ...current.value.waiting, ...current.value.activeTests].slice(0, 12) : [];
    await fetchGraphs(objectives);
    if (!ctx.isCurrent()) return;
    paintAttention(attention);
    paintActive(current, objectives, attention, sessions);
    paintTeam(office);
  };

  const paintAttention = (result) => {
    const slot = ctx.view.querySelector('#attentionSlot');
    if (!slot) return;
    if (result.status !== 'fulfilled') { slot.innerHTML = ''; return; }
    const count = Number(result.value.counts?.action || 0);
    if (!count) { slot.innerHTML = ''; return; }
    // The same count as the Approvals page: approvals, questions, paused or
    // failed work and legal or security decisions, so not "approvals" alone.
    const phrase = ar ? arabicCount(count, ['أمر واحد يحتاج قرارك', 'أمران يحتاجان قرارك', 'أمور تحتاج قرارك', 'أمرًا يحتاج قرارك']) : `${count} item${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} your decision`;
    slot.innerHTML = `<a class="attention-notice" href="#/settings/approvals">${ICON.alert}<span class="grow"><strong>${t('بانتظارك', 'Waiting for you')}</strong><span> — ${ctx.esc(phrase)}</span></span><span class="notice-go" aria-hidden="true">${ICON.back}</span></a>`;
  };

  const progressBlock = (progress) => {
    const width = fractionWidth(progress);
    if (width == null) {
      const phase = progress ? phaseWords(progress.phase, lang(ctx)) : '';
      return phase ? `<span class="job-phase">${ctx.esc(phase)}</span>` : '';
    }
    const label = fractionLabel(progress, lang(ctx));
    const extra = ['awaiting_synthesis', 'synthesizing', 'revising'].includes(progress.phase) ? ` · ${phaseWords(progress.phase, lang(ctx))}` : progress.failed ? ` · ${ar ? `${progress.failed} تعثّر` : `${progress.failed} failed`}` : '';
    return `<span class="job-progress"><span class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${progress.total}" aria-valuenow="${progress.delivered}" aria-label="${ctx.esc(label)}"><span style="width:${width}%"></span></span><span class="num fraction" dir="ltr">${progress.delivered}/${progress.total}</span><span class="sr-only">${ctx.esc(label)}</span>${extra ? `<span class="job-phase">${ctx.esc(extra.replace(/^ · /, ''))}</span>` : ''}</span>`;
  };

  const paintActive = (current, objectives, attention, sessions) => {
    const slot = ctx.view.querySelector('#activeSlot');
    if (!slot) return;
    if (current.status !== 'fulfilled') {
      slot.innerHTML = `<div class="state-card">${ctx.errorBlock(current.reason?.message, ctx.esc)}<button class="btn btn-sm" type="button" data-retry>${t('إعادة المحاولة', 'Try again')}</button></div>`;
      slot.querySelector('[data-retry]').onclick = () => { slot.innerHTML = skeleton(2); refresher.trigger(); };
      return;
    }
    const ownerItems = attention.status === 'fulfilled' ? attention.value.items || [] : [];
    const coding = sessions.status === 'fulfilled' ? sessions.value.sessions.filter((session) => !session.jobId) : [];
    const cards = objectives.map((objective) => {
      const graph = graphs.get(objective.id)?.graph || null;
      const progress = graph ? deliveryProgress(graph.nodes, { final: graph.final, jobStatus: graph.job.status }) : null;
      const people = graph ? [...new Map(graph.nodes.filter((node) => node.kind !== 'plan' && node.kind !== 'synthesis' && node.agentSlug).map((node) => [node.agentSlug, { slug: node.agentSlug, label: node.agentLabel }])).values()]
        : (objective.orchestration?.participants || []);
      const test = objective.classification?.class === 'TEST';
      const needs = objective.lifecycle === 'NEEDS_OWNER' || objective.counts?.needsOwner > 0;
      return `<a class="job-card material" href="#/job/${ctx.esc(objective.id)}">
        <div class="job-card-top"><h3 dir="auto">${ctx.esc(objective.title)}</h3>${statusPill(ctx, objective)}</div>
        <p class="job-desc" dir="auto">${ctx.esc(objective.goal || '')}</p>
        <div class="job-card-foot">${people.length ? avatars(ctx, [{ slug: 'chief-of-staff', label: 'CHIEF' }, ...people.filter((person) => person.slug !== 'chief-of-staff')]) : avatars(ctx, [{ slug: 'chief-of-staff', label: 'CHIEF' }])}
          ${progressBlock(progress)}
          ${needs ? `<span class="attention-chip">${ICON.alert}${t('يحتاجك', 'Needs you')}</span>` : ''}${test ? `<span class="tag">${t('اختبار', 'Test')}</span>` : ''}</div>
      </a>`;
    });
    for (const session of coding) {
      const state = codingSessionState(session, ownerItems, lang(ctx));
      cards.push(`<a class="job-card material" href="#/task/${ctx.esc(session.id)}">
        <div class="job-card-top"><h3 dir="auto">${ctx.esc(session.title)}</h3>${statusPill(ctx, state.status)}</div>
        <p class="job-desc">${t('مهمة برمجية', 'Coding session')}${state.phase ? ` · ${ctx.esc(state.phase)}` : ''}</p>
        <div class="job-card-foot">${avatars(ctx, [{ slug: 'coding-agent', label: 'CODING' }])}${state.needs ? `<span class="attention-chip">${ICON.alert}${t('يحتاجك', 'Needs you')}</span>` : ''}</div>
      </a>`);
    }
    slot.innerHTML = cards.length ? `<div class="job-grid">${cards.join('')}</div>`
      : `<div class="empty-state material"><span class="empty-mark" aria-hidden="true">${ICON.check}</span><div><strong>${t('لا يوجد عمل جارٍ الآن', 'Nothing is running right now')}</strong><p>${t('اكتب هدفًا في الأعلى، وسيبدأ CHIEF بتنسيق الفريق. المهام المنتهية في الأرشيف.', 'Write a goal above and CHIEF will coordinate the team. Finished work is in the Archive.')}</p></div><a class="btn btn-sm" href="#/archive">${t('الأرشيف', 'Archive')}</a></div>`;
    slot.querySelectorAll('.job-card').forEach((link) => { link.onclick = () => { try { sessionStorage.setItem('hub-job-origin', '#/'); } catch {} }; });
  };

  const paintTeam = (result) => {
    const slot = ctx.view.querySelector('#teamSlot');
    if (!slot) return;
    if (result.status !== 'fulfilled') { slot.innerHTML = `<div class="state-card">${ctx.errorBlock(result.reason?.message, ctx.esc)}</div>`; return; }
    slot.innerHTML = `<div class="team-grid">${result.value.agents.map((agent) => {
      const state = employeeState(agent, lang(ctx));
      const copy = employeeCopy(agent.slug);
      const now = state.busy || state.key === 'waiting' || state.key === 'needs' ? (agent.assignment?.objective || agent.assignment?.title || '') : '';
      return `<button type="button" class="emp-card material ${state.busy ? 'is-busy' : ''}" data-employee="${ctx.esc(agent.slug)}" aria-label="${ctx.esc(`${agent.label} — ${state.label}`)}">
        <span class="emp-avatar" style="--emp:${employeeColor(agent.slug)}" aria-hidden="true">${ctx.esc(String(agent.label || '?').slice(0, 1))}</span>
        <span class="emp-text"><span class="emp-name">${ar && copy.ar ? `<strong>${ctx.esc(copy.ar)}</strong><small dir="ltr">${ctx.esc(agent.label)}</small>` : `<strong dir="ltr">${ctx.esc(agent.label)}</strong>${copy.ar ? `<small>${ctx.esc(copy.ar)}</small>` : ''}`}</span>
          ${copy.tagline ? `<span class="emp-tagline" dir="ltr">${ctx.esc(copy.tagline)}</span>` : ''}
          ${now ? `<span class="emp-now" dir="auto">${ctx.esc(now)}</span>` : ''}</span>
        <span class="emp-state st-${state.key}">${ctx.esc(state.label)}</span>
      </button>`;
    }).join('')}</div>`;
    slot.querySelectorAll('[data-employee]').forEach((button) => { button.onclick = () => ctx.openEmployee(button.dataset.employee); });
  };

  const refresher = createRefresher(load, { hidden: () => document.hidden, connectedEvery: 120_000, disconnectedEvery: 30_000 });
  watchVisibility(ctx, refresher);
  ctx.onLiveChange(() => refresher.trigger(), (connected) => {
    refresher.setConnected(connected);
    const element = ctx.view.querySelector('#liveState');
    if (element) element.innerHTML = connected ? `<span class="live-dot" aria-hidden="true"></span>${t('مباشر', 'Live')}` : `<span class="live-dot is-off" aria-hidden="true"></span>${t('يتحدّث كل 30 ثانية', 'Refreshing every 30s')}`;
  });
  ctx.every(10_000, () => refresher.tick());
  await refresher.trigger();
}

// A hidden tab does not poll; it catches up once when shown again.
function watchVisibility(ctx, refresher) {
  const onVisible = () => { if (!document.hidden) refresher.visible(); };
  document.addEventListener('visibilitychange', onVisible);
  ctx.onLeave(() => { document.removeEventListener('visibilitychange', onVisible); refresher.stop(); });
}

// ===================================================================== Job detail
const STEP_WORDS = { plan: ['التخطيط', 'Plan'], delegate: ['التوزيع', 'Delegate'], assign: ['التكليف', 'Assign'], depend: ['الاعتماديات', 'Dependencies'], deliver: ['التسليم', 'Deliver'], review: ['المراجعة', 'Review'], revise: ['التعديل', 'Revise'], synthesize: ['الخلاصة', 'Synthesize'], close: ['الإغلاق', 'Close'] };
const STEP_STATE = { done: ['تم', 'Done'], current: ['الآن', 'Now'], waiting: ['لاحقًا', 'Later'], skipped: ['لا يلزم', 'Not needed'] };

export async function renderJobDetail(ctx, id) {
  const t = words(ctx);
  const ar = lang(ctx) === 'ar';
  let origin = '#/';
  try { origin = sessionStorage.getItem('hub-job-origin') === '#/archive' ? '#/archive' : '#/'; } catch {}
  ctx.view.innerHTML = `<div class="pg job-page">${skeleton(4)}</div>`;
  const ui = { tab: null, technical: null, technicalOpen: false };
  let signature = '';
  let renderedShell = false;

  const load = async () => {
    const workflow = await ctx.api(`/api/workflows/${id}`);
    const [objective, conversation] = await Promise.all([
      ctx.api(`/api/work/objectives/${id}${ctx.q({ workspaceId: ctx.ws(), tier: 'operational' })}`).then((data) => data.objective).catch(() => null),
      workflow.job.conversationId ? ctx.api(`/api/conversations/${workflow.job.conversationId}`).catch(() => null) : Promise.resolve(null),
    ]);
    if (!ctx.isCurrent()) return workflow.job.status;
    const next = JSON.stringify([workflow, objective, conversation?.messages?.map((message) => [message.jobId, message.assistant.status, message.assistant.text.length])]);
    if (next === signature) return workflow.job.status;
    signature = next;
    paint({ workflow, objective, conversation });
    return workflow.job.status;
  };

  const paint = ({ workflow, objective, conversation }) => {
    const job = workflow.job;
    const row = { status: job.status, lifecycle: objective?.lifecycle };
    const status = jobStatus(row, lang(ctx));
    const progress = deliveryProgress(workflow.nodes, { final: workflow.final, jobStatus: job.status });
    const tabs = employeeTabs(workflow.nodes);
    const workspace = ctx.workspaces().find((item) => item.id === (objective?.projectId || ctx.ws()));
    const direct = conversation?.conversation?.agent && conversation.conversation.agent.slug && conversation.conversation.agent.slug !== 'chief-of-staff' ? conversation.conversation.agent : null;
    const message = conversation?.messages?.find((entry) => entry.jobId === job.id) || null;
    ctx.setTitle(job.title);
    if (!renderedShell) {
      renderedShell = true;
      ctx.view.innerHTML = `<div class="pg job-page">
        <a class="back-link" href="${origin}">${ICON.back}<span>${origin === '#/archive' ? t('الأرشيف', 'Archive') : t('المكتب', 'Office')}</span></a>
        <header class="job-head" id="jobHead"></header>
        <div id="workflowVisual"></div>
        <section class="synthesis material" id="synthesis" aria-labelledby="synthesisTitle"></section>
        <section class="group" aria-labelledby="teamOutTitle"><div class="group-head"><h2 id="teamOutTitle">${t('مخرجات الفريق', 'Team deliverables')}</h2></div><div id="teamOut"></div></section>
        <section class="group" aria-labelledby="followTitle"><div class="group-head"><h2 id="followTitle">${t('المتابعة', 'Follow-up')}</h2></div><div id="followSlot"></div><div id="composerSlot"></div></section>
        <details class="exec-details" id="execDetails"><summary>${t('تفاصيل التنفيذ', 'Execution details')}</summary><div class="exec-body" id="execBody"></div></details>
      </div>`;
      paintComposer(job, direct);
      const details = ctx.view.querySelector('#execDetails');
      details.addEventListener('toggle', () => { ui.technicalOpen = details.open; if (details.open && !ui.technical) loadTechnical(); });
    }
    const head = ctx.view.querySelector('#jobHead');
    head.innerHTML = `<div class="job-meta-row">${statusPill(ctx, row)}${workspace ? `<span class="meta" dir="auto">${ctx.esc(workspace.name)}</span>` : ''}${direct ? `<span class="meta">${dot(direct.slug)}${t('محادثة مباشرة مع', 'Direct chat with')} ${ctx.esc(direct.label || direct.slug)}</span>` : ''}</div>
      <h1 class="job-title" dir="auto">${ctx.esc(job.title)}</h1>
      ${job.objective && job.objective !== job.title ? `<p class="job-goal" dir="auto">${ctx.esc(job.objective)}</p>` : ''}
      <dl class="job-facts">
        <div><dt>${t('أُنشئت', 'Created')}</dt><dd>${isoDate(ctx, job.createdAt) || '—'}</dd></div>
        ${job.completedAt ? `<div><dt>${status.key === 'completed' ? t('اكتملت', 'Completed') : t('انتهت', 'Ended')}</dt><dd>${isoDate(ctx, job.completedAt)}</dd></div>` : ''}
        <div><dt>${t('الفريق', 'Team')}</dt><dd>${tabs.length ? avatars(ctx, tabs.map((tab) => ({ slug: tab.slug, label: tab.label })), 9) : `<span class="muted">${t('CHIEF فقط', 'CHIEF only')}</span>`}</dd></div>
        <div><dt>${t('التكليفات المُسلّمة', 'Assignments delivered')}</dt><dd>${progress.fraction ? `<span class="num" dir="ltr" title="${ctx.esc(fractionLabel(progress, lang(ctx)))}">${progress.delivered}/${progress.total}</span>` : `<span class="muted">${ctx.esc(phaseWords(progress.phase, lang(ctx)) || '—')}</span>`}</dd></div>
      </dl>`;
    paintSynthesis({ workflow, objective, progress, direct, message });
    paintWorkflowVisual(workflow, objective);
    paintTeam(workflow, tabs);
    paintFollow({ workflow, objective, conversation, job });
    paintExec({ workflow, objective });
  };

  const paintWorkflowVisual = (workflow, objective) => {
    const slot = ctx.view.querySelector('#workflowVisual');
    if (!slot) return;
    slot.innerHTML = workflowVisual(ctx, workflow, objective);
    slot.querySelectorAll('[data-map-employee]').forEach((button) => {
      button.onclick = () => ctx.openEmployee(button.dataset.mapEmployee);
    });
  };

  const paintSynthesis = ({ workflow, objective, progress, direct, message }) => {
    const slot = ctx.view.querySelector('#synthesis');
    const job = workflow.job;
    const answerOnly = !workflow.nodes.some((node) => node.kind === 'workstream' || node.kind === 'development');
    let body;
    let content = null;
    let heading = t('الخلاصة النهائية من CHIEF', 'CHIEF’s final synthesis');
    if (workflow.final) {
      content = workflow.final.content;
      body = ctx.markdown(content);
    } else if (job.status === 'completed' && answerOnly && message?.assistant?.text) {
      // No team workstreams: the reply on this job is the answer itself.
      content = message.assistant.text;
      heading = direct ? `${t('رد', 'Reply from')} ${direct.label || direct.slug}` : t('رد CHIEF', 'CHIEF’s answer');
      body = ctx.markdown(content);
    } else if (!isTerminal(job.status)) {
      const width = fractionWidth(progress);
      body = `<div class="synthesis-wait"><span class="wait-mark" aria-hidden="true">${ICON.clock}</span><div><p>${t('الفريق يعمل على المهمة. سيجمع CHIEF النتائج في تقرير نهائي بعد اكتمال المخرجات المطلوبة.', 'The team is working on this. CHIEF will consolidate the results into a final report once the required deliverables are in.')}</p>
        <p class="muted small">${ctx.esc(phaseWords(progress.phase, lang(ctx)))}${progress.fraction ? ` · ${ctx.esc(fractionLabel(progress, lang(ctx)))}` : ''}</p>
        ${width != null ? `<span class="bar bar-lg" aria-hidden="true"><span style="width:${width}%"></span></span>` : ''}</div></div>`;
    } else if (job.status === 'failed') {
      const reason = objective?.nextAction?.basis === 'RECORDED' ? objective.nextAction.text : null;
      body = `<div class="synthesis-wait is-error"><span class="wait-mark" aria-hidden="true">${ICON.alert}</span><div><p>${t('توقفت المهمة قبل أن يكتمل التقرير النهائي.', 'This job stopped before a final report was produced.')}</p><p class="muted small" dir="auto">${reason ? ctx.esc(reason) : t('لم يُسجَّل سبب للفشل.', 'No failure reason was recorded.')}</p></div></div>`;
    } else if (job.status === 'cancelled') {
      body = `<div class="synthesis-wait"><span class="wait-mark" aria-hidden="true">${ICON.alert}</span><div><p>${t('أُلغيت هذه المهمة قبل التقرير النهائي.', 'This job was cancelled before a final report.')}</p></div></div>`;
    } else {
      body = `<div class="synthesis-wait"><span class="wait-mark" aria-hidden="true">${ICON.alert}</span><div><p>${t('اكتملت المهمة بدون تقرير نهائي مسجّل.', 'The job completed without a recorded final report.')}</p></div></div>`;
    }
    slot.classList.toggle('is-final', Boolean(content));
    slot.innerHTML = `<div class="synthesis-head"><div><span class="eyebrow">${dot('chief-of-staff')}${content ? ctx.esc(heading) : t('الخلاصة النهائية', 'Final synthesis')}</span><h2 id="synthesisTitle" class="sr-only">${ctx.esc(heading)}</h2>${workflow.final?.at ? `<span class="muted small"> · ${isoDate(ctx, workflow.final.at)}</span>` : ''}</div>
      ${content ? `<div class="row"><button class="btn btn-ghost btn-sm" type="button" data-copy-final>${ICON.copy}${t('نسخ', 'Copy')}</button><button class="btn btn-ghost btn-sm" type="button" data-download-final>${ICON.download}${t('تنزيل', 'Download')}</button></div>` : statusPill(ctx, { status: job.status, lifecycle: objective?.lifecycle })}</div>
      <div class="synthesis-body">${body}</div>`;
    if (content) {
      slot.querySelector('[data-copy-final]').onclick = () => navigator.clipboard?.writeText(content).then(() => ctx.toast(t('تم النسخ', 'Copied')));
      slot.querySelector('[data-download-final]').onclick = () => {
        const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
        const link = Object.assign(document.createElement('a'), { href: url, download: `${String(job.title || 'result').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'result'}.md` });
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
    }
  };

  const paintTeam = (workflow, tabs) => {
    const slot = ctx.view.querySelector('#teamOut');
    if (!tabs.length) {
      const planned = workflow.nodes.some((node) => node.kind === 'plan' && node.state === 'done') || isTerminal(workflow.job.status);
      slot.innerHTML = `<div class="empty-state material"><span class="empty-mark" aria-hidden="true">${dot('chief-of-staff')}</span><div><strong>${planned ? t('لا توجد مخرجات منفصلة للفريق', 'No separate team deliverables') : t('لم يوزّع CHIEF العمل بعد', 'CHIEF has not delegated yet')}</strong><p>${planned ? t('تولّى CHIEF هذه المهمة بنفسه.', 'CHIEF handled this job directly.') : t('ستظهر تكليفات الفريق هنا فور توزيعها.', 'Team assignments appear here as soon as CHIEF delegates.')}</p></div></div>`;
      return;
    }
    if (!ui.tab || !tabs.some((tab) => tab.slug === ui.tab)) ui.tab = (tabs.find((tab) => tab.working) || tabs[0]).slug;
    const artifactsByTask = new Map();
    for (const artifact of workflow.artifacts || []) artifactsByTask.set(artifact.taskId, [...(artifactsByTask.get(artifact.taskId) || []), artifact]);
    const tabButton = (tab) => `<button type="button" role="tab" class="emp-tab" id="tab-${ctx.esc(tab.slug)}" aria-controls="panel-${ctx.esc(tab.slug)}" aria-selected="${tab.slug === ui.tab}" tabindex="${tab.slug === ui.tab ? 0 : -1}" data-tab="${ctx.esc(tab.slug)}">
        ${dot(tab.slug)}<span dir="ltr">${ctx.esc(tab.label)}</span>${tab.delivered ? `<span class="tab-check" aria-label="${t('سلّم', 'Delivered')}">${ICON.check}</span>` : tab.failed ? `<span class="tab-fail" aria-label="${t('تعثّر', 'Failed')}">!</span>` : tab.working ? `<span class="tab-live" aria-label="${t('يعمل', 'Working')}"></span>` : ''}
      </button>`;
    const nodeCard = (node) => {
      const artifacts = artifactsByTask.get(node.id) || [];
      const assignment = `<div class="assignment"><span class="eyebrow">${t('التكليف من CHIEF', 'Assignment from CHIEF')}</span><p dir="auto"><strong>${ctx.esc(node.title)}</strong>${node.revision ? ` <span class="tag">${t('تعديل', 'Revision')}</span>` : ''}${node.kind === 'consult' ? ` <span class="tag">${t('استشارة', 'Consult')}</span>` : ''}</p>
        <p class="muted small"><span class="node-state st-${ctx.esc(node.state)}">${ctx.esc(nodeStateLabel(node.state, lang(ctx)))}</span>${node.startedAt ? ` · ${t('بدأ', 'started')} ${isoDate(ctx, node.startedAt)}` : ''}${node.completedAt ? ` · ${t('سلّم', 'delivered')} ${isoDate(ctx, node.completedAt)}` : ''}${node.state === 'capacity' && node.resumesAt ? ` · ${t('يستأنف', 'resumes')} ${isoDate(ctx, node.resumesAt)}` : ''}</p>
        ${node.codingTask ? `<a class="small" href="#/task/${ctx.esc(node.codingTask.id)}">${t('مهمة برمجية', 'Coding task')}: ${ctx.esc(node.codingTask.title || '')} · ${ctx.esc(node.codingTask.status)}${node.codingTask.phase ? ` · ${ctx.esc(node.codingTask.phase)}` : ''}</a>` : ''}</div>`;
      let output;
      if (node.output) {
        output = `<div class="output"><div class="output-head"><span class="eyebrow">${t('التسليم', 'Delivered output')}</span><span class="type-chips">${outputTypes(artifacts).map((type) => `<span class="type-chip">${ctx.esc(type)}</span>`).join('')}</span></div>${ctx.markdown(node.output.content || node.output.summary || '')}</div>`;
      } else if (node.state === 'failed' || node.state === 'blocked') {
        output = `<div class="output-pending is-error">${ICON.alert}<div><strong>${ctx.esc(nodeStateLabel(node.state, lang(ctx)))}</strong><p class="small muted">${t('لم يكتمل هذا التكليف. التفاصيل التقنية في «تفاصيل التنفيذ».', 'This assignment did not finish. Technical details are under “Execution details”.')}</p></div></div>`;
      } else {
        output = `<div class="output-pending">${ICON.clock}<div><strong>${ctx.esc(nodeStateLabel(node.state, lang(ctx)))}</strong><p class="small muted">${t('سيظهر التسليم هنا فور اكتماله.', 'The deliverable appears here as soon as it is ready.')}</p></div></div>`;
      }
      return `<article class="node-card">${assignment}${output}</article>`;
    };
    const active = tabs.find((tab) => tab.slug === ui.tab);
    slot.innerHTML = `<div class="emp-tabs" role="tablist" aria-label="${t('مخرجات الفريق', 'Team deliverables')}">${tabs.map(tabButton).join('')}</div>
      <div class="emp-panel material" role="tabpanel" id="panel-${ctx.esc(active.slug)}" aria-labelledby="tab-${ctx.esc(active.slug)}" tabindex="0"><div class="emp-panel-head"><div>${dot(active.slug)}<strong dir="ltr">${ctx.esc(active.label)}</strong><span class="small muted">${ctx.esc(nodeStateLabel(active.state, lang(ctx)))}</span></div><button type="button" class="btn btn-ghost btn-sm" data-employee-sheet="${ctx.esc(active.slug)}">${t('تفاصيل الموظف', 'Employee details')}</button></div>${active.nodes.map(nodeCard).join('')}</div>`;
    const buttons = [...slot.querySelectorAll('[role="tab"]')];
    const select = (slug, focus = false) => { ui.tab = slug; paintTeam(workflow, tabs); if (focus) ctx.view.querySelector(`#tab-${CSS.escape(slug)}`)?.focus(); };
    buttons.forEach((button, index) => {
      button.onclick = () => select(button.dataset.tab);
      button.onkeydown = (event) => {
        const rtl = document.documentElement.dir === 'rtl';
        const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[event.key];
        if (step) { event.preventDefault(); select(buttons[(index + step + buttons.length) % buttons.length].dataset.tab, true); }
        if (event.key === 'Home') { event.preventDefault(); select(buttons[0].dataset.tab, true); }
        if (event.key === 'End') { event.preventDefault(); select(buttons.at(-1).dataset.tab, true); }
      };
    });
    slot.querySelector('[data-employee-sheet]')?.addEventListener('click', (event) => ctx.openEmployee(event.currentTarget.dataset.employeeSheet));
  };

  const paintFollow = ({ workflow, objective, conversation, job }) => {
    const slot = ctx.view.querySelector('#followSlot');
    const attention = objective?.ownerAttention || [];
    const decisions = workflow.decisions || [];
    const thread = conversation?.messages || [];
    const parts = [];
    if (attention.length) {
      parts.push(`<div class="follow-card is-alert"><span class="eyebrow">${ICON.alert}${t('بانتظار قرارك', 'Waiting for your decision')}</span>${attention.map((item) => `<a class="follow-row" href="${item.sessionId ? `#/task/${ctx.esc(item.sessionId)}` : '#/settings/approvals'}"><span class="grow" dir="auto">${ctx.esc(item.title)}</span><span class="small">${t('افتح', 'Open')}</span></a>`).join('')}</div>`);
    }
    if (decisions.length) {
      parts.push(`<div class="follow-card"><span class="eyebrow">${t('قرارات اقترحها الفريق', 'Decisions raised by the team')}</span>${decisions.map((decision) => `<div class="decision"><span class="small muted" dir="ltr">${ctx.esc(decision.from)}</span>${ctx.markdown(decision.text)}</div>`).join('')}</div>`);
    }
    if (thread.length > 1) {
      parts.push(`<div class="follow-card"><span class="eyebrow">${t('المحادثة', 'Conversation')}</span><ol class="thread">${thread.map((entry) => `<li class="${entry.jobId === job.id ? 'is-current' : ''}">${entry.jobId === job.id ? `<span class="thread-text" dir="auto">${ctx.esc(entry.user.text)}</span><span class="tag">${t('هذه المهمة', 'This job')}</span>` : `<a class="thread-text" href="#/job/${ctx.esc(entry.jobId)}" dir="auto">${ctx.esc(entry.user.text)}</a>`}${statusPill(ctx, { status: entry.assistant.status })}</li>`).join('')}</ol></div>`);
    }
    slot.innerHTML = parts.join('');
  };

  const paintComposer = (job, direct) => {
    const slot = ctx.view.querySelector('#composerSlot');
    const conversationId = job.conversationId;
    const running = !isTerminal(job.status);
    if (!conversationId) {
      slot.innerHTML = `<div class="follow-card"><p class="small muted">${t('هذه المهمة بدون محادثة مرتبطة. يمكنك بدء متابعة جديدة مع CHIEF.', 'This job has no linked conversation. You can start a follow-up with CHIEF.')}</p><button class="btn btn-sm" type="button" data-followup>${t('متابعة مع CHIEF', 'Follow up with CHIEF')}</button></div>`;
      slot.querySelector('[data-followup]').onclick = () => {
        try { sessionStorage.setItem('hub-chief-draft', `${t('متابعة لـ', 'Follow-up on')}: ${job.title}\n\n`); } catch {}
        location.hash = '#/chief';
      };
      return;
    }
    slot.innerHTML = `<form class="reply material" id="replyForm" novalidate>
        <label class="sr-only" for="replyText">${t('تعليمات إضافية', 'Additional instructions')}</label>
        <textarea id="replyText" class="command-input" rows="1" dir="auto" maxlength="8000" placeholder="${direct ? `${t('اكتب رسالتك لـ', 'Message')} ${ctx.esc(direct.label || '')}…` : t('أضف تعليمات أو اطلب متابعة من CHIEF…', 'Add instructions or ask CHIEF to follow up…')}"></textarea>
        <div class="command-bar"><div class="row"><a class="btn btn-ghost btn-sm" href="#/chat/${ctx.esc(conversationId)}">${t('افتح المحادثة', 'Open conversation')}</a>${running ? `<button class="btn btn-ghost btn-sm" type="button" id="stopJob">${t('أوقف', 'Stop')}</button>` : ''}</div>
          <button class="btn btn-primary btn-send" type="submit" id="sendReply">${ICON.send}<span>${t('أرسل وتابع', 'Reply & continue')}</span></button></div>
        <p class="form-error hidden" id="replyError" role="alert"></p>
      </form>`;
    const text = slot.querySelector('#replyText');
    text.addEventListener('input', () => { text.style.height = 'auto'; text.style.height = `${Math.min(text.scrollHeight, 240)}px`; });
    text.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); slot.querySelector('#replyForm').requestSubmit(); } });
    slot.querySelector('#replyForm').onsubmit = async (event) => {
      event.preventDefault();
      const message = text.value.trim();
      const error = slot.querySelector('#replyError');
      if (!message) { error.textContent = t('اكتب رسالتك أولًا.', 'Write your message first.'); error.classList.remove('hidden'); return; }
      const button = slot.querySelector('#sendReply');
      button.disabled = true;
      try {
        const created = await ctx.api(`/api/conversations/${conversationId}/messages`, { method: 'POST', body: { message } });
        text.value = '';
        ctx.refreshSidebar();
        location.hash = `#/job/${created.jobId}`;
      } catch (failure) {
        error.textContent = ctx.humanError(failure.message);
        error.classList.remove('hidden');
        button.disabled = false;
      }
    };
    const stop = slot.querySelector('#stopJob');
    if (stop) stop.onclick = async () => {
      if (!(await ctx.confirmDialog(t('إيقاف هذه المهمة؟', 'Stop this job?'), t('يتوقف العمل الجاري في هذه المحادثة. ما تم إنجازه يبقى محفوظًا.', 'Running work in this conversation stops. Work already done is kept.')))) return;
      try { await ctx.api(`/api/conversations/${conversationId}/stop`, { method: 'POST' }); ctx.toast(t('تم الإيقاف', 'Stopped')); signature = ''; await refresher.trigger(); } catch (failure) { ctx.toast(failure.message); }
    };
  };

  const paintExec = ({ workflow, objective }) => {
    const body = ctx.view.querySelector('#execBody');
    const steps = objective?.orchestration?.steps || [];
    const flowRow = (node) => `<li class="flow-line st-${ctx.esc(node.state)}"><span class="flow-mark" aria-hidden="true"></span><span class="grow"><strong dir="ltr">${ctx.esc(node.agentLabel)}</strong> — <span dir="auto">${ctx.esc(node.title)}</span>${node.revision ? ` <span class="tag">${t('تعديل', 'Revision')}</span>` : ''}</span><span class="small muted">${ctx.esc(nodeStateLabel(node.state, lang(ctx)))}${node.completedAt ? ` · ${isoDate(ctx, node.completedAt)}` : ''}</span></li>`;
    const sections = [];
    if (steps.length) sections.push(`<div class="exec-block"><h3>${t('مراحل CHIEF', 'CHIEF stages')}</h3><ol class="steps">${steps.map((step) => `<li class="step step-${ctx.esc(step.state)}"><span>${ctx.esc((STEP_WORDS[step.id] || [step.id, step.id])[ar ? 0 : 1])}</span><small>${ctx.esc((STEP_STATE[step.state] || [step.state, step.state])[ar ? 0 : 1])}</small></li>`).join('')}</ol>${objective?.nextAction?.text ? `<p class="small muted" dir="auto">${t('الخطوة التالية', 'Next')}: ${ctx.esc(objective.nextAction.text)}</p>` : ''}</div>`);
    sections.push(`<div class="exec-block"><h3>${t('سير العمل', 'Workflow')}</h3>${workflow.nodes.length ? `<ol class="flow-list">${workflow.nodes.map(flowRow).join('')}</ol>` : `<p class="small muted">${t('لا توجد خطوات مسجلة بعد.', 'No steps recorded yet.')}</p>`}</div>`);
    if (workflow.handoffs?.length) sections.push(`<div class="exec-block"><h3>${t('التسليمات بين الفريق', 'Handoffs')} <span class="num">(${workflow.handoffs.length})</span></h3><ul class="plain">${workflow.handoffs.map((handoff) => `<li><span dir="ltr">${ctx.esc(handoff.from)} → ${ctx.esc(handoff.to)}</span> <span class="muted small">${isoDate(ctx, handoff.at)}</span></li>`).join('')}</ul></div>`);
    if (workflow.revisions?.length) sections.push(`<div class="exec-block"><h3>${t('تعديلات طلبها CHIEF', 'Revisions requested by CHIEF')}</h3><ul class="plain">${workflow.revisions.map((revision) => `<li dir="auto">${ctx.esc(revision.workstream)}: ${ctx.esc(revision.instruction)}</li>`).join('')}</ul></div>`);
    if (workflow.consults?.length) sections.push(`<div class="exec-block"><h3>${t('استشارات داخلية', 'Internal consults')}</h3><ul class="plain">${workflow.consults.flatMap((entry) => entry.consults.map((consult) => `<li dir="auto"><strong>${ctx.esc(entry.from)}</strong> → <strong>${ctx.esc(consult.to)}</strong>: ${ctx.esc(consult.question)}</li>`)).join('')}</ul></div>`);
    sections.push(`<div class="exec-block"><h3>${t('التكلفة', 'Cost')}</h3><p class="num" dir="ltr">${workflow.job.costUsd == null ? t('غير متاح', 'Unavailable') : `$${Number(workflow.job.costUsd).toFixed(Number(workflow.job.costUsd) < 0.1 ? 4 : 2)}`}</p></div>`);
    sections.push(`<div class="exec-block" id="technicalSlot">${ui.technical ? technicalHtml(ui.technical) : `<p class="small muted">${ui.technicalOpen ? t('نحمّل النماذج والأحداث…', 'Loading models and events…') : ''}</p>`}</div>`);
    body.innerHTML = sections.join('');
  };

  const technicalHtml = (technical) => {
    if (technical.error) return `<h3>${t('النماذج والأحداث', 'Models and events')}</h3>${ctx.errorBlock(technical.error, ctx.esc)}`;
    const attempts = technical.attempts;
    const events = technical.events;
    return `<h3>${t('النماذج المستخدمة', 'Models used')}</h3>${attempts == null ? `<p class="small muted">${t('غير متاح', 'Unavailable')}</p>` : attempts.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>${t('النموذج', 'Model')}</th><th>${t('المزوّد', 'Provider')}</th><th>${t('الحالة', 'Status')}</th><th>${t('التوكنات', 'Tokens')}</th><th>${t('التكلفة', 'Cost')}</th><th>${t('الوقت', 'Time')}</th></tr></thead><tbody>${attempts.map((attempt) => `<tr><td dir="ltr" class="mono">${ctx.esc(attempt.model || '')}</td><td dir="ltr">${ctx.esc(attempt.provider || '')}</td><td>${ctx.esc(attempt.status || '')}${attempt.error_code ? ` <span class="muted mono">${ctx.esc(attempt.error_code)}</span>` : ''}</td><td class="num" dir="ltr">${attempt.input_tokens == null ? '—' : `${attempt.input_tokens}/${attempt.output_tokens ?? '—'}`}</td><td class="num" dir="ltr">${attempt.cost_usd == null ? '—' : `$${Number(attempt.cost_usd).toFixed(4)}`}</td><td>${isoDate(ctx, attempt.started_at)}</td></tr>`).join('')}</tbody></table></div>` : `<p class="small muted">${t('لا توجد محاولات نماذج مسجلة.', 'No model attempts recorded.')}</p>`}
      <h3>${t('الأحداث', 'Events')}</h3>${events == null ? `<p class="small muted">${t('غير متاح', 'Unavailable')}</p>` : events.length ? `<ul class="plain events">${events.slice(0, 40).map((event) => `<li><span class="mono small">${ctx.esc(event.type)}</span> <span dir="auto">${ctx.esc(event.message || '')}</span> <span class="muted small">${isoDate(ctx, event.created_at)}</span></li>`).join('')}</ul>` : `<p class="small muted">${t('لا توجد أحداث.', 'No events.')}</p>`}`;
  };

  const loadTechnical = async () => {
    try {
      const { objective } = await ctx.api(`/api/work/objectives/${id}${ctx.q({ workspaceId: ctx.ws(), tier: 'technical' })}`);
      ui.technical = objective.technical || { attempts: null, events: null };
    } catch (failure) {
      ui.technical = { error: failure.message };
    }
    const slot = ctx.view.querySelector('#technicalSlot');
    if (slot && ctx.isCurrent()) slot.innerHTML = technicalHtml(ui.technical);
  };

  // While the job is open: live changes refresh it, the safety poll is 30 s
  // with a live stream and 8 s without one, and nothing loads while hidden.
  // Once the job is terminal the page stops refreshing.
  let failed = null;
  const refresher = createRefresher(async () => {
    try {
      const current = await load();
      if (isTerminal(current)) refresher.stop();
    } catch (failure) { failed = failure; }
  }, { hidden: () => document.hidden, connectedEvery: 30_000, disconnectedEvery: 8_000 });
  await refresher.trigger();
  if (failed) {
    const failure = failed;
    ctx.view.innerHTML = `<div class="pg job-page"><a class="back-link" href="${origin}">${ICON.back}<span>${origin === '#/archive' ? t('الأرشيف', 'Archive') : t('المكتب', 'Office')}</span></a><div class="state-card">${ctx.errorBlock(failure.message, ctx.esc)}</div></div>`;
    return;
  }
  watchVisibility(ctx, refresher);
  ctx.onLiveChange(() => refresher.trigger(), (connected) => refresher.setConnected(connected));
  ctx.every(4000, () => refresher.tick());
}

// ===================================================================== Archive
const ARCHIVE_KEY = 'hub-archive-filters';
export async function renderArchive(ctx) {
  const t = words(ctx);
  ctx.setTitle(t('الأرشيف', 'Archive'));
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem(ARCHIVE_KEY) || '{}') || {}; } catch {}
  const filters = { status: ['', 'completed', 'failed', 'cancelled'].includes(saved.status) ? saved.status : '', q: String(saved.q || ''), from: String(saved.from || ''), to: String(saved.to || ''), employee: String(saved.employee || ''), tests: Boolean(saved.tests) };
  const segments = [['', t('الكل', 'All')], ['completed', t('مكتملة', 'Completed')], ['failed', t('فشلت', 'Failed')], ['cancelled', t('ملغاة', 'Cancelled')]];
  ctx.view.innerHTML = `<div class="pg archive-page">
    <header class="page-title"><h1 class="display-sm">${t('الأرشيف', 'Archive')}</h1><p>${t('كل المهام المنتهية: المكتملة والفاشلة والملغاة. لا يُحذف شيء ولا يُنقل.', 'Every finished job — completed, failed and cancelled. Nothing is deleted or moved.')}</p></header>
    <div class="archive-controls material" role="search">
      <div class="search-field"><label class="sr-only" for="archiveQ">${t('بحث في الأرشيف', 'Search the archive')}</label><input id="archiveQ" class="input" type="search" dir="auto" placeholder="${t('ابحث بالعنوان أو الهدف…', 'Search by title or goal…')}" value="${ctx.esc(filters.q)}"></div>
      <div class="segmented" role="radiogroup" aria-label="${t('الحالة', 'Status')}">${segments.map(([value, label]) => `<button type="button" role="radio" aria-checked="${filters.status === value}" data-status="${value}">${label}</button>`).join('')}</div>
      <div class="filter-row">
        <label class="filter"><span>${t('من', 'From')}</span><input class="input input-sm" type="date" id="archiveFrom" value="${ctx.esc(filters.from)}"></label>
        <label class="filter"><span>${t('إلى', 'To')}</span><input class="input input-sm" type="date" id="archiveTo" value="${ctx.esc(filters.to)}"></label>
        <label class="filter"><span>${t('الموظف', 'Employee')}</span><select class="input input-sm" id="archiveEmployee"><option value="">${t('الكل', 'Everyone')}</option>${ROSTER.map((person) => `<option value="${person.slug}" ${filters.employee === person.slug ? 'selected' : ''}>${person.label}${employeeCopy(person.slug).ar && lang(ctx) === 'ar' ? ` — ${employeeCopy(person.slug).ar}` : ''}</option>`).join('')}</select></label>
        <label class="check filter-check"><input type="checkbox" id="archiveTests" ${filters.tests ? 'checked' : ''}><span>${t('إظهار مهام الاختبار', 'Show test jobs')}</span></label>
        <button type="button" class="btn btn-ghost btn-sm" id="archiveClear">${t('مسح الفلاتر', 'Clear filters')}</button>
      </div>
    </div>
    <p class="small muted" id="archiveSummary" aria-live="polite"></p>
    <div id="archiveList">${skeleton(4)}</div>
    <div id="archiveMore" class="archive-more"></div>
  </div>`;
  const list = { items: [], cursor: null, hasMore: false, sequence: 0 };
  const persist = () => { try { sessionStorage.setItem(ARCHIVE_KEY, JSON.stringify(filters)); } catch {} };
  const row = (item) => {
    const statusText = jobStatus({ lifecycle: item.lifecycle }, lang(ctx));
    const when = item.closedAt || item.openedAt;
    const people = item.participants || [];
    return `<li><a class="archive-row" href="#/job/${ctx.esc(item.id)}" data-archive-row>
      <span class="archive-main"><span class="archive-title" dir="auto">${ctx.esc(item.title)}</span>${item.goal && item.goal !== item.title ? `<span class="archive-desc" dir="auto">${ctx.esc(item.goal)}</span>` : ''}</span>
      <span class="archive-meta">${people.length ? `<span class="dots" title="${ctx.esc(people.map((person) => person.label).join('، '))}">${people.slice(0, 6).map((person) => dot(person.slug)).join('')}</span>` : ''}
        ${item.classification?.class === 'TEST' ? `<span class="tag">${t('اختبار', 'Test')}</span>` : ''}
        <span class="archive-date"><span class="small muted">${item.closedAt ? (statusText.key === 'completed' ? t('اكتملت', 'Completed') : t('انتهت', 'Ended')) : t('أُنشئت', 'Created')}</span> ${isoDate(ctx, when)}</span>
        <span class="status-pill tone-${statusText.tone}">${ctx.esc(statusText.label)}</span></span>
    </a></li>`;
  };
  const paint = () => {
    const visible = archiveFilter(list.items, { from: filters.from, to: filters.to, employee: filters.employee, includeTests: filters.tests });
    const hiddenTests = filters.tests ? 0 : list.items.filter((item) => item.classification?.class === 'TEST').length;
    const holder = ctx.view.querySelector('#archiveList');
    const narrowed = filters.from || filters.to || filters.employee;
    ctx.view.querySelector('#archiveSummary').textContent = lang(ctx) === 'ar'
      ? `${visible.length} من ${list.items.length} محمّلة${hiddenTests ? ` · ${hiddenTests} مهام اختبار مخفية` : ''}${list.hasMore && narrowed ? ' · فلاتر التاريخ والموظف تطبّق على المحمّل فقط' : ''}`
      : `${visible.length} of ${list.items.length} loaded${hiddenTests ? ` · ${hiddenTests} test jobs hidden` : ''}${list.hasMore && narrowed ? ' · date and employee filters apply to loaded rows' : ''}`;
    holder.innerHTML = visible.length ? `<ul class="archive-list material">${visible.map(row).join('')}</ul>`
      : `<div class="empty-state material"><span class="empty-mark" aria-hidden="true">${ICON.check}</span><div><strong>${list.items.length ? t('لا توجد نتائج لهذه الفلاتر', 'No results for these filters') : t('الأرشيف فارغ', 'The archive is empty')}</strong><p>${list.items.length ? t('جرّب مسح الفلاتر أو تحميل المزيد.', 'Try clearing filters or loading more.') : t('ستظهر المهام هنا بعد اكتمالها أو فشلها أو إلغائها.', 'Jobs appear here once they complete, fail or are cancelled.')}</p></div></div>`;
    holder.querySelectorAll('[data-archive-row]').forEach((link) => { link.onclick = () => { try { sessionStorage.setItem('hub-job-origin', '#/archive'); } catch {} }; });
    ctx.view.querySelector('#archiveMore').innerHTML = list.hasMore ? `<button type="button" class="btn" id="archiveLoadMore">${t('تحميل المزيد', 'Load more')}</button>` : '';
    const more = ctx.view.querySelector('#archiveLoadMore');
    if (more) more.onclick = () => fetchPage(true);
  };
  const fetchPage = async (append = false) => {
    const mine = ++list.sequence;
    const params = { workspaceId: ctx.ws(), limit: 30 };
    if (filters.status) params.category = filters.status;
    if (filters.q.trim()) params.q = filters.q.trim();
    if (append && list.cursor) params.cursor = list.cursor;
    const more = ctx.view.querySelector('#archiveLoadMore');
    if (more) { more.disabled = true; more.textContent = t('نحمّل…', 'Loading…'); }
    try {
      const data = await ctx.api(`/api/work/history${ctx.q(params)}`);
      if (mine !== list.sequence || !ctx.isCurrent()) return;
      list.items = append ? [...list.items, ...data.objectives] : data.objectives;
      list.cursor = data.nextCursor || null;
      list.hasMore = Boolean(data.hasMore);
      paint();
    } catch (failure) {
      if (mine !== list.sequence || !ctx.isCurrent()) return;
      ctx.view.querySelector('#archiveList').innerHTML = `<div class="state-card">${ctx.errorBlock(failure.message, ctx.esc)}<button class="btn btn-sm" type="button" id="archiveRetry">${t('إعادة المحاولة', 'Try again')}</button></div>`;
      ctx.view.querySelector('#archiveRetry').onclick = () => fetchPage(append);
    }
  };
  let timer = null;
  ctx.view.querySelector('#archiveQ').oninput = (event) => { filters.q = event.target.value; persist(); clearTimeout(timer); timer = setTimeout(() => fetchPage(false), 250); };
  ctx.view.querySelectorAll('[data-status]').forEach((button) => {
    button.onclick = () => {
      filters.status = button.dataset.status; persist();
      ctx.view.querySelectorAll('[data-status]').forEach((other) => other.setAttribute('aria-checked', String(other === button)));
      fetchPage(false);
    };
  });
  const segmentButtons = [...ctx.view.querySelectorAll('[data-status]')];
  segmentButtons.forEach((button, index) => {
    button.onkeydown = (event) => {
      const rtl = document.documentElement.dir === 'rtl';
      const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const next = segmentButtons[(index + step + segmentButtons.length) % segmentButtons.length];
      next.focus(); next.click();
    };
  });
  const local = (key, element) => { element.onchange = () => { filters[key] = element.type === 'checkbox' ? element.checked : element.value; persist(); paint(); }; };
  local('from', ctx.view.querySelector('#archiveFrom'));
  local('to', ctx.view.querySelector('#archiveTo'));
  local('employee', ctx.view.querySelector('#archiveEmployee'));
  local('tests', ctx.view.querySelector('#archiveTests'));
  ctx.view.querySelector('#archiveClear').onclick = () => {
    Object.assign(filters, { status: '', q: '', from: '', to: '', employee: '', tests: false });
    persist();
    ctx.rerender();
  };
  await fetchPage(false);
}
