// Fictional DEMO scenario for the private V5 immersive preview only
// (tools/v5-preview-build.mjs). It extends the preview fixture
// (hub-preview-data.js) so every representative Office state is visible at
// once. It is never shipped with the runtime and never written to a real
// database; the rows go through the REAL Hub handlers.
//
// Two moments of the same fictional afternoon:
//   work  — CHIEF planning a new idea, CODING running CI, CREATIVE designing,
//           LEGAL working, FINANCE just delivered VERIFIED figures, PRODUCT
//           just delivered, SOCIAL and AUDIT waiting, RESEARCH available.
//   needs — CI passed: CODING waits for Fahad's merge approval (Needs Fahad),
//           CREATIVE delivered a moodboard and handed off to SOCIAL.

import { previewTables } from './hub-preview-data.js';
import { publishFinance, validateFinance } from '../../src/office/finance.js';

export const DEMO_MOMENTS = Object.freeze(['work', 'needs']);

const art = (body) => `\n\`\`\`artifact\n${JSON.stringify(body)}\n\`\`\`\n`;

// FINANCE's figures go through the real calculator and validator.
function verifiedFinance() {
  const model = {
    type: 'financial_model', title: 'Qahwa Run — pilot year (5 cafés)', currency: 'AED', months: 12,
    items: [
      { category: 'Build', item: 'MVP app (contract team)', one_time: 30000, month: 1, basis: 'ESTIMATED' },
      { category: 'Legal', item: 'E-commerce trade licence', one_time: 6500, month: 1, basis: 'KNOWN' },
      { category: 'Infrastructure', item: 'Hosting and database', monthly: 180, basis: 'ESTIMATED' },
      { category: 'Marketing', item: 'Always-on campaign', monthly: 1400, basis: 'ESTIMATED' },
      { category: 'Operations', item: 'Café partner support', monthly: 900, basis: 'ASSUMPTION' },
    ],
    revenue: { price_monthly: 450, starting_customers: 0, new_customers: 3, churn_rate: 0.02, trial_months: 0 },
  };
  const draft = `## Summary\nPilot-year model for five partner cafés, then organic growth.${art(model)}`;
  const first = validateFinance(draft);
  const c = first.calculated;
  const claimed = `## Summary\nYear revenue AED ${Math.round(c.year_revenue).toLocaleString('en-US')}; costs AED ${Math.round(c.year_costs).toLocaleString('en-US')}.${art({ ...model, claims: { year_revenue: c.year_revenue, year_costs: c.year_costs, net: c.net, break_even_month: c.break_even_month } })}`;
  const validation = validateFinance(claimed);
  if (validation.state !== 'VERIFIED') throw new Error(`demo finance did not verify: ${JSON.stringify(validation.issues)}`);
  return publishFinance(claimed, validation);
}

export function demoTables(now = Date.now(), moment = 'work') {
  const t = previewTables(now);
  const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();
  const byTitle = (title) => t.tasks.find((task) => task.title === title && task.job_id === t.jobs[0].id);
  const J1 = t.jobs[0].id;
  const agentId = (slug) => t.agents.find((agent) => agent.slug === slug).id;

  // The launch plan started 100 minutes ago.
  t.jobs[0].created_at = ago(100);
  t.jobs[0].progress = moment === 'needs' ? 72 : 64;
  const plan = t.tasks.find((task) => task.job_id === J1 && task.title === 'Chief planning');
  Object.assign(plan, { created_at: ago(100), started_at: ago(100), completed_at: ago(99) });
  Object.assign(byTitle('Dubai coffee pre-order market scan'), { started_at: ago(98), completed_at: ago(80) });
  Object.assign(byTitle('MVP scope and roadmap'), { started_at: ago(60), completed_at: ago(12) });
  Object.assign(byTitle('Pre-order API endpoint'), { started_at: ago(11), completed_at: ago(10) });
  const finance = byTitle('Launch budget and monthly costs');
  Object.assign(finance, { status: 'done', started_at: ago(11), completed_at: ago(3), progress: 100 });
  Object.assign(byTitle('UAE launch compliance checklist'), { status: 'running', started_at: ago(6) });
  const creative = byTitle('Brand direction and moodboard');
  delete creative.not_before; delete creative.wait_info; creative.wait_count = 0;
  const social = byTitle('Launch content calendar');
  if (moment === 'needs') {
    Object.assign(creative, { status: 'done', started_at: ago(9), completed_at: ago(1) });
    Object.assign(social, { status: 'running', started_at: ago(0.8) });
  } else {
    Object.assign(creative, { status: 'running', started_at: ago(9) });
  }
  for (const result of t.results) if (result.job_id === J1) result.created_at = result.task_id === byTitle('MVP scope and roadmap').id ? ago(12) : ago(80);
  for (const row of t.artifacts) if (row.job_id === J1) row.created_at = row.agent_slug === 'product-tech' ? ago(12) : ago(80);

  // FINANCE: VERIFIED model + calculated chart from the real finance code.
  const financeContent = verifiedFinance();
  t.results.push({ id: '0f000000-0000-4000-8000-000000000101', job_id: J1, task_id: finance.id, kind: 'specialist', summary: 'Pilot year calculated and VERIFIED by code.', content: financeContent, created_at: ago(3) });
  let n = 200;
  const addArtifacts = (content, slug, taskId, at) => {
    for (const match of content.matchAll(/```artifact\n([\s\S]*?)\n```/g)) {
      const { type, title, ...data } = JSON.parse(match[1]);
      t.artifacts.push({ id: `90000000-0000-4000-8000-${String(n++).padStart(12, '0')}`, project_id: t.projects[0].id, job_id: J1, task_id: taskId, conversation_id: t.jobs[0].conversation_id, agent_slug: slug, type, title, data, created_at: at });
    }
  };
  addArtifacts(financeContent, 'business-finance', finance.id, ago(3));
  if (moment === 'needs') {
    const moodboard = `## Summary\nLaunch visuals: the runner cup on sand, one saffron accent.${art({ type: 'moodboard', title: 'Qahwa Run — launch visuals', palette: [{ name: 'Espresso', hex: '#3B2A20', role: 'primary' }, { name: 'Sand', hex: '#E9DCC7', role: 'background' }, { name: 'Saffron', hex: '#E0A526', role: 'accent' }, { name: 'Cardamom', hex: '#7A8C5A', role: 'secondary' }], typography: [{ role: 'Headings', family: 'Fraunces', sample: 'Ready when you are' }, { role: 'Body', family: 'IBM Plex Sans Arabic', sample: 'قهوتك جاهزة' }], concepts: [{ name: 'Runner cup', description: 'Cup mark with a motion line.' }, { name: 'Pick-up stamp', description: 'A dallah silhouette stamp.' }], keywords: ['warm', 'quick', 'local'] })}`;
    t.results.push({ id: '0f000000-0000-4000-8000-000000000102', job_id: J1, task_id: creative.id, kind: 'specialist', summary: 'Launch visuals ready for SOCIAL.', content: moodboard, created_at: ago(1) });
    addArtifacts(moodboard, 'brand-creative', creative.id, ago(1));
  }

  // Handoffs: one completed long ago, fresh ones for the current work.
  const handoff = (id, from, to, fromTask, toTask, at) => ({ id: `70000000-0000-4000-8000-${String(id).padStart(12, '0')}`, from_agent_id: agentId(from), to_agent_id: agentId(to), from_task_id: fromTask, to_task_id: toTask, job_id: J1, created_at: at });
  const T = (title) => byTitle(title).id;
  t.handoffs = [
    handoff(1, 'chief-of-staff', 'research-strategy', plan.id, T('Dubai coffee pre-order market scan'), ago(99)),
    handoff(2, 'research-strategy', 'product-tech', T('Dubai coffee pre-order market scan'), T('MVP scope and roadmap'), ago(80)),
    handoff(3, 'research-strategy', 'legal-compliance', T('Dubai coffee pre-order market scan'), T('UAE launch compliance checklist'), ago(79)),
    handoff(4, 'product-tech', 'coding-agent', T('MVP scope and roadmap'), T('Pre-order API endpoint'), ago(11)),
    handoff(5, 'product-tech', 'business-finance', T('MVP scope and roadmap'), finance.id, ago(11)),
    handoff(6, 'business-finance', 'qa-security', finance.id, T('Launch readiness audit'), ago(3)),
    ...(moment === 'needs' ? [handoff(7, 'brand-creative', 'content-media', creative.id, social.id, ago(1))] : []),
  ];

  // A second objective CHIEF is planning right now (CHIEF active).
  const J3 = 'b0000000-0000-4000-8000-000000000009';
  t.jobs.push({ id: J3, project_id: t.projects[0].id, conversation_id: t.jobs[0].conversation_id, title: 'Qahwa Run — loyalty stamps idea', goal: 'Should loyalty stamps come in the pilot or after?', status: 'planning', progress: 5, cost_usd: 0, priority: 'normal', created_at: ago(2) });
  t.tasks.push({ id: 'd0000000-0000-4000-8000-000000000090', job_id: J3, agent_id: agentId('chief-of-staff'), title: 'Chief planning', status: 'running', brief: JSON.stringify({ workflow: 'chief-research-chief', workflow_version: 1, stage: 'chief_plan', goal: 'Should loyalty stamps come in the pilot or after?' }), depends_on: [], sequence: 10, created_at: ago(2), started_at: ago(2) });

  // CODING: CI running (work) or waiting for the merge approval (needs).
  const session = t.agent_sessions[0];
  t.agent_approvals = [];
  if (moment === 'needs') {
    Object.assign(session, { status: 'awaiting_approval', phase: 'deploy', updated_at: ago(0.5), result: { ...session.result, ci: { state: 'success', total: 1, failing: [], checkedAt: ago(0.6) } } });
    t.agent_approvals.push({ id: '60000000-0000-4000-8000-000000000001', workspace_id: t.projects[0].id, session_id: session.id, tool_name: 'github.merge_pull_request', action: 'merge', risk: 'high', summary: 'Merge PR #12 “Pre-order API endpoint” into main (CI passed, 4 files, 38 tests).', arguments_preview: { pull: 12 }, status: 'pending', requested_at: ago(0.5) });
  } else {
    Object.assign(session, { status: 'running', phase: 'ci', updated_at: ago(1), result: { ...session.result, ci: { state: 'pending', total: 1, failing: [], checkedAt: ago(1) } } });
  }
  t.agent_events.push({ id: 5, session_id: session.id, type: 'phase', level: 'info', message: 'Waiting for CI', payload: { phase: 'ci' }, created_at: ago(2) });
  return t;
}
