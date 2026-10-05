// Artifact library — deliverables, not files. Filter by project, employee,
// type, date and status; search titles, objectives and content; open a
// deliverable to read, export it (CSV, document, image, print/PDF) or, for an
// AUDIT finding, send it back to the employee who owns the fix.
import { roleMark } from './characters.js?v=__UI_VERSION__';
import { artifactPreview } from './artifacts.js';
import { artifactsSummary } from './summaries.js';
import { download, fileName, moodboardPng, printArtifact, svgToPng, toCsv, toMarkdown } from './export.js?v=__UI_VERSION__';

const FAMILY = {
  table: 'Tables', financial_model: 'Finance', chart: 'Charts', compliance_matrix: 'Legal', audit_report: 'Audit', moodboard: 'Creative', content_calendar: 'Social',
  kanban: 'Product', timeline: 'Product', flow: 'Product', checklist: 'Checklists', evidence: 'Research', risk_matrix: 'Risk',
};
const needsAttention = (artifact) => (artifact.type === 'audit_report' && ['NEEDS WORK', 'BLOCKED'].includes(artifact.data?.verdict))
  || (artifact.type === 'compliance_matrix' && (artifact.data?.items || []).some((item) => ['RISK FLAG', 'PROFESSIONAL REVIEW REQUIRED'].includes(item.classification)));

export async function renderLibrary(ctx, initialType = '') {
  const { api, esc, q, ws, view, setTitle, when } = ctx;
  const ar = ctx.language === 'ar';
  setTitle(ar ? 'الملفات والنتائج' : 'Files & results');
  const state = { project: ws(), agent: '', type: initialType, since: '', status: '', search: '' };
  view.innerHTML = `<div class="page page-wide library">
    <div class="page-head"><div><h1>${ar ? 'الملفات والنتائج' : 'Files & results'}</h1><p class="page-summary" id="libSummary" aria-live="polite">${ar ? 'كل نتيجة أنجزها المكتب، مرتبة حسب المشروع والمهمة — افتحها أو نزّلها.' : 'Every completed Office output, organized by project and job — preview or download.'}</p></div></div>
    <div class="lib-filters" role="search">
      <label class="sr-only" for="libSearch">${ar ? 'بحث' : 'Search'}</label><input id="libSearch" class="input" type="search" dir="auto" placeholder="${ar ? 'ابحث في العناوين والأهداف والمحتوى…' : 'Search titles, objectives and content…'}">
      <label class="sr-only" for="libProject">Project</label><select id="libProject" class="input">${ctx.workspaces().map((workspace) => `<option value="${esc(workspace.id)}">${esc(workspace.name)}</option>`).join('')}</select>
      <label class="sr-only" for="libAgent">${ar ? 'الموظف' : 'Employee'}</label><select id="libAgent" class="input"><option value="">${ar ? 'كل الموظفين' : 'All employees'}</option></select>
      <label class="sr-only" for="libType">${ar ? 'النوع' : 'Type'}</label><select id="libType" class="input"><option value="">${ar ? 'كل الأنواع' : 'All types'}</option></select>
      <label class="sr-only" for="libSince">${ar ? 'التاريخ' : 'Date'}</label><select id="libSince" class="input"><option value="">${ar ? 'أي وقت' : 'Any time'}</option><option value="1">${ar ? 'آخر 24 ساعة' : 'Last 24 hours'}</option><option value="7">${ar ? 'آخر 7 أيام' : 'Last 7 days'}</option><option value="30">${ar ? 'آخر 30 يوم' : 'Last 30 days'}</option></select>
      <label class="sr-only" for="libStatus">${ar ? 'الحالة' : 'Status'}</label><select id="libStatus" class="input"><option value="">${ar ? 'أي حالة' : 'Any status'}</option><option value="attention">${ar ? 'يحتاج انتباه' : 'Needs attention'}</option><option value="clear">${ar ? 'واضح' : 'Clear'}</option></select>
    </div>
    <div id="libCount" class="small muted" aria-live="polite"></div>
    <div id="libGrid" class="lib-grid"><div class="drawer-loading"></div></div></div>`;
  view.querySelector('#libProject').value = state.project;
  let artifacts = [];
  let types = [];
  const load = async () => {
    const data = await api(`/api/artifacts${q({ workspaceId: state.project, limit: 200 })}`);
    artifacts = data.artifacts;
    types = data.types;
    view.querySelector('#libSummary').textContent = ar ? (artifacts.length ? `${artifacts.length} نتائج محفوظة — افتح أو نزّل اللي تحتاجه.` : 'ما في نتائج بعد. بتظهر هني أول ما ينجز المكتب الشغل.') : artifactsSummary(artifacts);
    const agents = [...new Map(artifacts.map((artifact) => [artifact.agent, artifact.agentLabel])).entries()];
    view.querySelector('#libAgent').innerHTML = `<option value="">${ar ? 'كل الموظفين' : 'All employees'}</option>${agents.map(([key, label]) => `<option value="${esc(key)}">${esc(label)}</option>`).join('')}`;
    view.querySelector('#libAgent').value = agents.some(([key]) => key === state.agent) ? state.agent : '';
    view.querySelector('#libType').innerHTML = `<option value="">${ar ? 'كل الأنواع' : 'All types'}</option>${types.map((type) => `<option value="${esc(type)}">${esc(ctx.labels[type] || type)}</option>`).join('')}`;
    view.querySelector('#libType').value = state.type;
    draw();
  };
  const matches = (artifact) => {
    if (state.agent && artifact.agent !== state.agent) return false;
    if (state.type && artifact.type !== state.type) return false;
    if (state.since && Date.now() - Date.parse(artifact.at) > Number(state.since) * 86400_000) return false;
    if (state.status === 'attention' && !needsAttention(artifact)) return false;
    if (state.status === 'clear' && needsAttention(artifact)) return false;
    if (state.search) {
      const haystack = `${artifact.title} ${artifact.objective || ''} ${artifact.agentLabel} ${ctx.labels[artifact.type] || artifact.type} ${JSON.stringify(artifact.data)}`.toLowerCase();
      if (!state.search.toLowerCase().split(/\s+/).every((word) => haystack.includes(word))) return false;
    }
    return true;
  };
  const draw = () => {
    const list = artifacts.filter(matches);
    view.querySelector('#libCount').textContent = ar ? `${list.length} من ${artifacts.length} نتيجة` : `${list.length} of ${artifacts.length} deliverable${artifacts.length === 1 ? '' : 's'}`;
    view.querySelector('#libGrid').innerHTML = list.length ? list.map((artifact, index) => `<button type="button" class="lib-card" data-index="${artifacts.indexOf(artifact)}" style="--i:${index}">
      <span class="lib-head">${roleMark(artifact.agent, artifact.agentLabel)}<span class="lib-type">${esc(FAMILY[artifact.type] || '')} · ${esc(ctx.labels[artifact.type] || artifact.type)}</span>${needsAttention(artifact) ? '<span class="lib-flag">Needs attention</span>' : ''}</span>
      <span class="lib-title" dir="auto">${esc(artifact.title || ctx.labels[artifact.type] || artifact.type)}</span>
      <span class="lib-preview">${artifactPreview(artifact)}</span>
      <span class="lib-meta"><span>${esc(artifact.agentLabel)}</span><span>${esc(when(artifact.at))}</span></span>
      ${artifact.objective ? `<span class="lib-objective" dir="auto">${esc(artifact.objective)}</span>` : ''}</button>`).join('')
      : `<div class="empty"><h3>${artifacts.length ? (ar ? 'ما في نتيجة تطابق البحث' : 'Nothing matches') : (ar ? 'ما في نتائج بعد' : 'No deliverables yet')}</h3><p>${artifacts.length ? (ar ? 'غيّر الفلتر أو كلمات البحث.' : 'Try another filter or search.') : (ar ? 'كلّف CHIEF، وبتظهر نتائج الموظفين هني.' : 'Ask CHIEF for a plan, budget, brand direction or review — the employees’ deliverables appear here.')}</p></div>`;
    view.querySelectorAll('.lib-card').forEach((card) => { card.onclick = () => openArtifact(ctx, artifacts[Number(card.dataset.index)]); });
  };
  const bindFilter = (id, key, reload = false) => { view.querySelector(id).oninput = (event) => { state[key] = event.target.value; if (reload) load().catch((error) => ctx.toast(error.message)); else draw(); }; };
  bindFilter('#libSearch', 'search'); bindFilter('#libAgent', 'agent'); bindFilter('#libType', 'type'); bindFilter('#libSince', 'since'); bindFilter('#libStatus', 'status'); bindFilter('#libProject', 'project', true);
  await load();
  ctx.onChange(() => load().catch(() => {}));
}

// The deliverable viewer, shared by the library, drawers and chats.
export async function openArtifact(ctx, artifact) {
  const { esc, when } = ctx;
  const office = await import('./office.js?v=__UI_VERSION__');
  await office.ensureOfficeStyles();
  const csv = toCsv(artifact);
  const imageable = ['chart', 'moodboard'].includes(artifact.type);
  const panel = office.sheet(ctx, { title: artifact.title || ctx.labels[artifact.type] || 'Deliverable', size: 'xl', body: `
    <div class="viewer-meta">${roleMark(artifact.agent, artifact.agentLabel)}<span><strong>${esc(artifact.agentLabel)}</strong> · ${esc(ctx.labels[artifact.type] || artifact.type)} · ${esc(when(artifact.at))}</span></div>
    ${artifact.objective ? `<p class="small muted" dir="auto">For: ${artifact.jobId ? `<a href="#/workflow/${esc(artifact.jobId)}">${esc(artifact.objective)}</a>` : esc(artifact.objective)}</p>` : ''}
    <div class="viewer-actions" role="group" aria-label="Export">
      ${csv ? '<button type="button" class="btn btn-sm" data-export="csv">CSV</button>' : ''}
      <button type="button" class="btn btn-sm" data-export="md">Document</button>
      ${imageable ? '<button type="button" class="btn btn-sm" data-export="png">Image</button>' : ''}
      <button type="button" class="btn btn-sm" data-export="print">Print / PDF</button>
      ${artifact.conversationId ? `<a class="btn btn-ghost btn-sm" href="#/chat/${esc(artifact.conversationId)}">Open chat</a>` : ''}</div>
    <div class="viewer-body">${ctx.renderArtifact(artifact)}</div>` });
  const root = panel.element;
  loadBrandFonts(root);
  // AUDIT → owner: a finding goes back to the employee who owns the fix, as a
  // direct conversation (visible in the Hub) — never silently.
  root.querySelectorAll('[data-send-owner]').forEach((button) => {
    const owner = button.dataset.sendOwner;
    if (!ctx.directSlugs[owner]) return;
    button.hidden = false;
    button.onclick = async () => {
      if (!(await ctx.confirmDialog(`Send this finding to ${owner.toUpperCase()}?`, 'It opens a direct conversation with that employee asking for the fix.'))) return;
      try {
        const message = `AUDIT finding for you (${artifact.title || 'audit'}): ${button.dataset.issue}${button.dataset.detail ? ` — ${button.dataset.detail}` : ''}. Please propose the fix.`;
        const created = await ctx.api('/api/conversations', { method: 'POST', body: { workspaceId: ctx.ws(), message, agentSlug: ctx.directSlugs[owner] } });
        panel.close();
        location.hash = `#/chat/${created.conversation.id}`;
      } catch (error) { ctx.toast(error.message); }
    };
  });
  root.querySelectorAll('[data-export]').forEach((button) => { button.onclick = async () => {
    const kind = button.dataset.export;
    try {
      if (kind === 'csv') download(fileName(artifact, 'csv'), `﻿${csv}`, 'text/csv;charset=utf-8');
      if (kind === 'md') download(fileName(artifact, 'md'), toMarkdown(artifact), 'text/markdown;charset=utf-8');
      if (kind === 'print') printArtifact(root.querySelector('.viewer-body').innerHTML, artifact.title || '');
      if (kind === 'png') {
        const styles = getComputedStyle(document.documentElement);
        const background = styles.getPropertyValue('--surface').trim();
        const blob = artifact.type === 'chart' ? await svgToPng(root.querySelector('.art-chart svg'), { background })
          : await moodboardPng(artifact, { background, ink: styles.getPropertyValue('--text').trim() });
        download(fileName(artifact, 'png'), blob, 'image/png');
      }
    } catch (error) { ctx.toast(`Export failed: ${error.message}`); }
  }; });
}

// CREATIVE names real, freely licensed font families; the brand preview
// loads just those families from Google Fonts when it is opened.
function loadBrandFonts(root) {
  const families = [...new Set([...root.querySelectorAll('[data-fonts]')].flatMap((element) => element.dataset.fonts.split('|')).filter((family) => /^[\p{L}\p{N} -]{2,60}$/u.test(family)))];
  if (!families.length) return;
  const href = `https://fonts.googleapis.com/css2?${families.map((family) => `family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@400;600;700`).join('&')}&display=swap`;
  if (document.querySelector(`link[data-brand-fonts="${CSS.escape(href)}"]`)) return;
  document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href, referrerPolicy: 'no-referrer' }));
  document.head.lastChild.dataset.brandFonts = href;
}
