// Fictional Office data for the local UI preview and visual QA only
// (tools/hub-preview.mjs). It is never shipped with the runtime and never
// written to a real database. The rows go through the REAL Hub handlers, so
// every state the UI shows is what the backend would compute from them.
//
// Scenario: "Qahwa Run" (a fictional coffee pre-order app in Dubai) mid-way
// through a multi-agent launch plan — RESEARCH and PRODUCT delivered, FINANCE
// and LEGAL working, CREATIVE waiting for free model capacity, SOCIAL waiting
// for CREATIVE, AUDIT waiting for everyone, and CODING waiting for Fahad's
// merge approval.

const uuid = (group, n) => `${group}-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const PREVIEW_WORKSPACE = '11111111-1111-4111-8111-111111111111';
const HQ = '22222222-2222-4222-8222-222222222222';

const AGENTS = [
  ['chief-of-staff', 'CHIEF', 'رئيس الديوان', 'Understand · Delegate · Deliver', '#2563EB'],
  ['research-strategy', 'RESEARCH', 'البحث والاستراتيجية', 'Search · Validate · Compare', '#8B5CF6'],
  ['brand-creative', 'CREATIVE', 'العلامة والإبداع', 'Identity · Visuals · Direction', '#F43F5E'],
  ['product-tech', 'PRODUCT', 'المنتج والتقنية', 'Define · Scope · Prioritize', '#06B6D4'],
  ['business-finance', 'FINANCE', 'الأعمال والمالية', 'Cost · Price · Plan', '#10B981'],
  ['coding-agent', 'CODING', 'وكيل البرمجة', 'Build · Test · Ship', '#0EA5E9'],
  ['qa-security', 'AUDIT', 'الجودة والأمن', 'Quality · Security · Completeness', '#F59E0B'],
  ['content-media', 'SOCIAL', 'المحتوى والإعلام', 'Trends · Content · Campaigns', '#14B8A6'],
  ['legal-compliance', 'LEGAL', 'القانونية والامتثال', 'Comply · Review · Protect', '#64748B'],
];
const agentId = (slug) => uuid('a0000000', AGENTS.findIndex(([entry]) => entry === slug) + 1);

const brief = (stage, extra = {}) => JSON.stringify({ workflow: 'chief-research-chief', workflow_version: 1, stage, ...extra });
const art = (body) => `\n\`\`\`artifact\n${JSON.stringify(body)}\n\`\`\`\n`;

// Moments of the same fictional afternoon, for the Office's required design
// views: 'work' (default), 'many' (most of the Office working at once, fresh
// handoffs), 'blocked' (LEGAL blocked after a failed step, one clear alert)
// and 'idle' (everything delivered long ago, nobody working).
export const PREVIEW_MOMENTS = Object.freeze(['work', 'many', 'blocked', 'idle']);

export function previewTables(now = Date.now(), { moment = 'work' } = {}) {
  const tables = baseTables(now);
  const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();
  const task = (n) => tables.tasks.find((entry) => entry.id === uuid('d0000000', n));
  if (moment === 'many') {
    for (const n of [2, 3, 6, 7]) Object.assign(task(n), { status: 'running', started_at: ago(4), completed_at: null, not_before: null });
    Object.assign(task(8), { status: 'running', started_at: ago(2), depends_on: [] });
    const fresh = [['research-strategy', 'brand-creative', 2, 6, 1.5], ['brand-creative', 'content-media', 6, 7, 1], ['product-tech', 'qa-security', 3, 8, 2], ['legal-compliance', 'qa-security', 5, 8, 0.5]];
    for (const [from, to, a, b, minutes] of fresh) tables.handoffs.push({ id: uuid('f0000000', 20 + a * 10 + b), job_id: uuid('b0000000', 1), from_agent_id: agentId(from), to_agent_id: agentId(to), from_task_id: uuid('d0000000', a), to_task_id: uuid('d0000000', b), created_at: ago(minutes) });
    tables.agent_approvals = []; Object.assign(tables.agent_sessions[0], { status: 'running', phase: 'test' });
  }
  if (moment === 'blocked') {
    Object.assign(task(5), { status: 'blocked', completed_at: ago(2) });
    tables.handoffs.push({ id: uuid('f0000000', 90), job_id: uuid('b0000000', 1), from_agent_id: agentId('product-tech'), to_agent_id: agentId('legal-compliance'), from_task_id: uuid('d0000000', 3), to_task_id: uuid('d0000000', 5), created_at: ago(1) });
    tables.agent_approvals = []; Object.assign(tables.agent_sessions[0], { status: 'completed', phase: 'done', completed_at: ago(30) });
  }
  if (moment === 'idle') {
    for (const entry of tables.tasks) Object.assign(entry, { status: 'done', started_at: entry.started_at || ago(400), completed_at: ago(380), not_before: null });
    for (const job of tables.jobs) Object.assign(job, { status: 'completed', progress: 100, completed_at: ago(380) });
    for (const entry of tables.handoffs) entry.created_at = ago(390);
    tables.agent_approvals = []; Object.assign(tables.agent_sessions[0], { status: 'completed', phase: 'done', completed_at: ago(370) });
  }
  withEventLog(tables);
  return tables;
}

// The event log a real objective writes (job created, plan, assigned, started,
// completed, handoffs), derived from the fixture's own fictional rows so the
// Live Operations timeline has what production has. Preview only.
function withEventLog(tables) {
  let id = 100; // below the ids tests append (the stream watermark is the newest id)
  const add = (row) => tables.events.push({ id: (id += 1), level: 'info', payload: {}, ...row });
  const stage = (task) => { try { return JSON.parse(task.brief || '{}').stage; } catch { return null; } };
  for (const job of tables.jobs) {
    add({ job_id: job.id, task_id: null, type: 'job_created', message: 'Fahad request accepted.', created_at: job.created_at });
    const own = tables.tasks.filter((task) => task.job_id === job.id);
    const plan = own.find((task) => stage(task) === 'chief_plan');
    if (plan?.completed_at) add({ job_id: job.id, task_id: plan.id, type: 'plan_created', message: 'Chief dispatched the workstreams.', payload: { kind: 'workflow_planned', workstreams: own.filter((task) => ['specialist', 'launch_dev'].includes(stage(task))).map((task) => ({ id: task.id })) }, created_at: plan.completed_at });
    for (const task of own) {
      add({ job_id: job.id, task_id: task.id, type: 'agent_assigned', message: `Assigned: ${task.title}`, created_at: task.created_at });
      if (task.started_at) add({ job_id: job.id, task_id: task.id, type: 'agent_started', message: `Started: ${task.title}`, payload: { attempt: 1 }, created_at: task.started_at });
      if (task.status === 'done' && task.completed_at) add({ job_id: job.id, task_id: task.id, type: 'task_completed', message: `Completed: ${task.title}`, created_at: task.completed_at });
    }
    for (const handoff of tables.handoffs.filter((entry) => entry.job_id === job.id)) add({ job_id: job.id, task_id: handoff.to_task_id, type: 'handoff', message: 'Handed off.', payload: { from_task: handoff.from_task_id, to_task: handoff.to_task_id }, created_at: handoff.created_at });
    if (job.status === 'completed' && job.completed_at) add({ job_id: job.id, task_id: null, type: 'job_completed', message: 'Job completed.', created_at: job.completed_at });
  }
}

function baseTables(now) {
  const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();
  const ahead = (minutes) => new Date(now + minutes * 60_000).toISOString();
  const J1 = uuid('b0000000', 1);
  const J0 = uuid('b0000000', 2);
  const J2 = uuid('b0000000', 3);
  const C1 = uuid('c0000000', 1);
  const C2 = uuid('c0000000', 2);
  const C3 = uuid('c0000000', 3);
  const T = (n) => uuid('d0000000', n);
  const S1 = uuid('e0000000', 1);
  const S0 = uuid('e0000000', 2);
  const goal = 'Plan the Qahwa Run launch in Dubai: market check, MVP scope, budget, legal checklist, brand direction, launch content and a final audit.';

  const tasks = [
    { id: T(1), job_id: J1, agent_id: agentId('chief-of-staff'), title: 'Chief planning', status: 'done', brief: brief('chief_plan', { goal }), depends_on: [], sequence: 10, created_at: ago(42), started_at: ago(42), completed_at: ago(41) },
    { id: T(2), job_id: J1, agent_id: agentId('research-strategy'), title: 'Dubai coffee pre-order market scan', status: 'done', brief: brief('specialist', { agent: 'research' }), depends_on: [T(1)], sequence: 100, created_at: ago(41), started_at: ago(40), completed_at: ago(27) },
    { id: T(3), job_id: J1, agent_id: agentId('product-tech'), title: 'MVP scope and roadmap', status: 'done', brief: brief('specialist', { agent: 'product' }), depends_on: [T(2)], sequence: 110, created_at: ago(41), started_at: ago(26), completed_at: ago(9) },
    { id: T(4), job_id: J1, agent_id: agentId('business-finance'), title: 'Launch budget and monthly costs', status: 'running', brief: brief('specialist', { agent: 'finance' }), depends_on: [T(3)], sequence: 120, created_at: ago(41), started_at: ago(8) },
    { id: T(5), job_id: J1, agent_id: agentId('legal-compliance'), title: 'UAE launch compliance checklist', status: 'running', brief: brief('specialist', { agent: 'legal' }), depends_on: [T(2)], sequence: 130, created_at: ago(41), started_at: ago(6) },
    { id: T(6), job_id: J1, agent_id: agentId('brand-creative'), title: 'Brand direction and moodboard', status: 'queued', brief: brief('specialist', { agent: 'creative' }), depends_on: [T(2)], sequence: 140, created_at: ago(41), not_before: ahead(4), wait_count: 1,
      wait_info: { reason: 'NO_FREE_CAPACITY', message: 'Waiting for free model capacity — will resume automatically.', expected_at: ahead(4) } },
    { id: T(7), job_id: J1, agent_id: agentId('content-media'), title: 'Launch content calendar', status: 'queued', brief: brief('specialist', { agent: 'social' }), depends_on: [T(6)], sequence: 150, created_at: ago(41) },
    { id: T(8), job_id: J1, agent_id: agentId('qa-security'), title: 'Launch readiness audit', status: 'queued', brief: brief('specialist', { agent: 'audit' }), depends_on: [T(3), T(4), T(5), T(6), T(7)], sequence: 160, created_at: ago(41) },
    { id: T(9), job_id: J1, agent_id: agentId('chief-of-staff'), title: 'Chief synthesis', status: 'queued', brief: brief('synthesis'), depends_on: [T(8)], sequence: 900, created_at: ago(41) },
    { id: T(10), job_id: J1, agent_id: agentId('coding-agent'), title: 'Pre-order API endpoint', status: 'done', brief: brief('launch_dev', { agent: 'coding' }), depends_on: [T(3)], sequence: 170, created_at: ago(41), started_at: ago(9), completed_at: ago(8) },
    // Yesterday's completed objective.
    { id: T(20), job_id: J0, agent_id: agentId('chief-of-staff'), title: 'Chief planning', status: 'done', brief: brief('chief_plan'), depends_on: [], sequence: 10, created_at: ago(1500), started_at: ago(1500), completed_at: ago(1499) },
    { id: T(21), job_id: J0, agent_id: agentId('business-finance'), title: 'First-pass budget', status: 'done', brief: brief('specialist', { agent: 'finance' }), depends_on: [T(20)], sequence: 100, created_at: ago(1499), started_at: ago(1498), completed_at: ago(1480) },
    { id: T(22), job_id: J0, agent_id: agentId('legal-compliance'), title: 'Licensing and data protection', status: 'done', brief: brief('specialist', { agent: 'legal' }), depends_on: [T(20)], sequence: 110, created_at: ago(1499), started_at: ago(1498), completed_at: ago(1475) },
    { id: T(23), job_id: J0, agent_id: agentId('brand-creative'), title: 'Brand exploration', status: 'done', brief: brief('specialist', { agent: 'creative' }), depends_on: [T(20)], sequence: 120, created_at: ago(1499), started_at: ago(1498), completed_at: ago(1470) },
    { id: T(24), job_id: J0, agent_id: agentId('content-media'), title: 'Teaser content ideas', status: 'done', brief: brief('specialist', { agent: 'social' }), depends_on: [T(23)], sequence: 130, created_at: ago(1499), started_at: ago(1469), completed_at: ago(1455) },
    { id: T(25), job_id: J0, agent_id: agentId('qa-security'), title: 'First-pass audit', status: 'done', brief: brief('specialist', { agent: 'audit' }), depends_on: [T(21), T(22), T(23), T(24)], sequence: 140, created_at: ago(1499), started_at: ago(1454), completed_at: ago(1445) },
    { id: T(26), job_id: J0, agent_id: agentId('chief-of-staff'), title: 'Chief synthesis', status: 'done', brief: brief('synthesis'), depends_on: [T(25)], sequence: 900, created_at: ago(1499), started_at: ago(1444), completed_at: ago(1440) },
    // A direct chat with FINANCE this morning.
    { id: T(30), job_id: J2, agent_id: agentId('business-finance'), title: 'Conversation with FINANCE', status: 'done', brief: brief('direct', { agent: 'finance' }), depends_on: [], sequence: 10, created_at: ago(190), started_at: ago(190), completed_at: ago(188) },
  ];

  const results = [
    { id: uuid('f0000000', 1), job_id: J1, task_id: T(2), kind: 'specialist', summary: 'Pre-order demand is real in Dubai office districts; two direct competitors, both delivery-first.', created_at: ago(27),
      content: `## Summary\nPre-order demand is real in Dubai office districts (DIFC, Business Bay). Two direct competitors exist, both delivery-first; pick-up pre-order at independent cafés is underserved.\n\n## Work\nThe scan covered delivery apps, café chains' own apps and independent cafés.${art({ type: 'evidence', title: 'Key claims', claims: [{ claim: 'Talabat and Deliveroo dominate coffee delivery in Dubai', status: 'LIKELY', source: '' }, { claim: 'Independent cafés rarely offer app-based pick-up pre-order', status: 'LIKELY', source: '' }, { claim: 'Morning peak demand 7:30–9:30 in office districts', status: 'UNKNOWN', source: '' }] })}${art({ type: 'table', title: 'Competitor snapshot', columns: ['Player', 'Model', 'Pick-up pre-order', 'Fee'], rows: [['Delivery apps', 'Delivery', 'No', 'High'], ['Chain apps', 'Own app', 'Chain only', 'None'], ['Qahwa Run', 'Pick-up pre-order', 'Yes — any partner café', 'Low']] })}\n## Handoff\nPRODUCT: scope pick-up pre-order first. LEGAL: check payments and data rules.\n\n## Decisions for Fahad\nNone yet.` },
    { id: uuid('f0000000', 2), job_id: J1, task_id: T(3), kind: 'specialist', summary: 'MVP: order ahead, pay in app, pick up at partner cafés; loyalty and delivery later.', created_at: ago(9),
      content: `## Summary\nMVP: order ahead, pay in app, pick up at partner cafés. Loyalty and delivery are deliberately later.\n\n## Work\nScope is limited to five partner cafés in Business Bay for the pilot.${art({ type: 'kanban', title: 'MVP board', columns: [{ name: 'Must', cards: [{ title: 'Menu and order ahead' }, { title: 'Apple Pay / card payment' }, { title: 'Pick-up code' }] }, { name: 'Should', cards: [{ title: 'Order history' }, { title: 'Café dashboard' }] }, { name: 'Later', cards: [{ title: 'Loyalty stamps' }, { title: 'Delivery' }] }] })}${art({ type: 'timeline', title: 'Roadmap', items: [{ label: 'Pilot build', start: 'Week 1', end: 'Week 4', status: 'planned' }, { label: 'Five-café pilot', start: 'Week 5', end: 'Week 8', status: 'planned' }, { label: 'Public launch', start: 'Week 9', end: 'Week 10', status: 'planned' }] })}${art({ type: 'flow', title: 'Order journey', steps: [{ id: 'open', label: 'Open app', next: ['pick'] }, { id: 'pick', label: 'Pick café and drink', next: ['pay'] }, { id: 'pay', label: 'Pay', next: ['ready'] }, { id: 'ready', label: 'Ready notification', next: ['collect'] }, { id: 'collect', label: 'Collect with code', next: [] }] })}\n## Handoff\nFINANCE: cost the pilot. CODING: pre-order API endpoint.\n\n## Decisions for Fahad\nConfirm Business Bay as the pilot area.` },
    { id: uuid('f0000000', 10), job_id: J0, task_id: T(21), kind: 'specialist', summary: 'Pilot budget ≈ AED 38,500 setup and AED 2,140 per month.', created_at: ago(1480),
      content: `## Summary\nPilot budget ≈ AED 38,500 setup and AED 2,140 per month.${art({ type: 'financial_model', title: 'Pilot budget', currency: 'AED', items: [{ category: 'Build', item: 'MVP app (contract team)', one_time: 30000, monthly: 0, basis: 'ESTIMATED', note: '6 weeks, 2 developers' }, { category: 'Infrastructure', item: 'Hosting and database', one_time: 0, monthly: 180, basis: 'ESTIMATED' }, { category: 'Payments', item: 'Card processing (2.9%)', one_time: 0, monthly: 560, basis: 'ASSUMPTION', note: 'on AED 19k monthly GMV' }, { category: 'Legal', item: 'Trade licence (e-commerce)', one_time: 6500, monthly: 0, basis: 'KNOWN' }, { category: 'Marketing', item: 'Launch campaign', one_time: 2000, monthly: 1400, basis: 'ESTIMATED' }] })}${art({ type: 'chart', title: 'Monthly running cost (AED)', kind: 'bar', unit: 'AED', labels: ['Hosting', 'Payments', 'Marketing'], series: [{ name: 'Monthly', values: [180, 560, 1400] }] })}` },
    { id: uuid('f0000000', 11), job_id: J0, task_id: T(22), kind: 'specialist', summary: 'E-commerce licence and PDPL data rules apply; payment terms need professional review.', created_at: ago(1475),
      content: `## Summary\nAn e-commerce trade licence and the UAE PDPL apply. Payment and refund terms need professional review.${art({ type: 'compliance_matrix', title: 'Launch compliance', items: [{ requirement: 'E-commerce trade licence', jurisdiction: 'Dubai', source: 'https://www.dubaided.gov.ae', source_date: '2026-06-01', applicability: 'Selling online in Dubai', status: 'required', classification: 'INFORMATION', uncertainty: 'low' }, { requirement: 'Personal data consent and privacy policy (PDPL)', jurisdiction: 'UAE', source: 'https://u.ae', source_date: '2026-03-15', applicability: 'Customer accounts and orders', status: 'required', classification: 'DRAFT', uncertainty: 'medium' }, { requirement: 'Refund and cancellation terms for pre-paid orders', jurisdiction: 'UAE', source: '', source_date: '', applicability: 'In-app payments', status: 'recommended', classification: 'PROFESSIONAL REVIEW REQUIRED', uncertainty: 'high' }] })}` },
    { id: uuid('f0000000', 12), job_id: J0, task_id: T(23), kind: 'specialist', summary: 'Warm, crafted direction: sand, espresso and a single saffron accent.', created_at: ago(1470),
      content: `## Summary\nWarm, crafted direction: sand, espresso and a single saffron accent.${art({ type: 'moodboard', title: 'Qahwa Run — brand direction', palette: [{ name: 'Espresso', hex: '#3B2A20', role: 'primary' }, { name: 'Sand', hex: '#E9DCC7', role: 'background' }, { name: 'Saffron', hex: '#E0A526', role: 'accent' }, { name: 'Cardamom', hex: '#7A8C5A', role: 'secondary' }, { name: 'Milk', hex: '#FAF7F2', role: 'surface' }], typography: [{ role: 'Headings', family: 'Fraunces', sample: 'Your coffee, ready when you are' }, { role: 'Body', family: 'IBM Plex Sans Arabic', sample: 'قهوتك جاهزة قبل ما توصل' }], concepts: [{ name: 'The runner cup', description: 'A cup mark with a motion line — speed without delivery.' }, { name: 'Dallah stamp', description: 'A modern dallah silhouette as a pick-up stamp.' }], keywords: ['warm', 'crafted', 'quick', 'local'] })}` },
    { id: uuid('f0000000', 13), job_id: J0, task_id: T(24), kind: 'specialist', summary: 'Two-week teaser plan on Instagram and TikTok.', created_at: ago(1455),
      content: `## Summary\nTwo-week teaser plan on Instagram and TikTok.${art({ type: 'content_calendar', title: 'Teaser fortnight', entries: [{ date: 'Week 1 Mon', platform: 'Instagram', format: 'Reel', hook: 'Skip the queue at your favourite café', caption: 'Coming soon to Business Bay.' }, { date: 'Week 1 Thu', platform: 'TikTok', format: 'Video', hook: 'POV: your flat white is waiting for you', caption: '' }, { date: 'Week 2 Mon', platform: 'Instagram', format: 'Carousel', hook: 'Meet the five pilot cafés', caption: '' }] })}` },
    { id: uuid('f0000000', 14), job_id: J0, task_id: T(25), kind: 'specialist', summary: 'NEEDS WORK: refund terms and card-fee assumption.', created_at: ago(1445),
      content: `## Summary\nNEEDS WORK: two issues before launch.${art({ type: 'audit_report', title: 'First-pass readiness', verdict: 'NEEDS WORK', findings: [{ title: 'Refund terms not drafted', severity: 'high', area: 'legal', owner: 'legal', detail: 'Pre-paid orders need clear refund rules.' }, { title: 'Card-fee figure is an assumption', severity: 'medium', area: 'finance', owner: 'finance', detail: 'Confirm with the payment provider.' }, { title: 'Brand colours pass contrast checks', severity: 'low', area: 'brand', owner: 'creative', detail: 'Saffron on sand needs a darker text colour.' }] })}` },
    { id: uuid('f0000000', 15), job_id: J0, task_id: T(26), kind: 'final', summary: 'First pass done.', created_at: ago(1440),
      content: `## Executive summary\nFirst pass is done: budget, legal basics, brand direction and teaser content. Two issues remain (refund terms, card fees).\n\n## Next actions\n- LEGAL drafts refund terms\n- FINANCE confirms card fees` },
    { id: uuid('f0000000', 20), job_id: J2, task_id: T(30), kind: 'final', summary: 'Card fees.', created_at: ago(188),
      content: 'تمام، رسوم البطاقات عند أغلب مزودي الدفع في الإمارات بين **2.5% و 3%** لكل عملية (ESTIMATED). أحتاج اسم المزود عشان أثبت الرقم.' },
  ];

  const artifactRows = [];
  const pushArtifacts = (job, taskId, slug, content, at) => {
    for (const match of content.matchAll(/```artifact\n([\s\S]*?)\n```/g)) {
      const data = JSON.parse(match[1]);
      const { type, title, ...rest } = data;
      artifactRows.push({ id: uuid('90000000', artifactRows.length + 1), project_id: PREVIEW_WORKSPACE, job_id: job, task_id: taskId, conversation_id: job === J1 ? C1 : null, agent_slug: slug, type, title, data: rest, created_at: at });
    }
  };
  pushArtifacts(J1, T(2), 'research-strategy', results[0].content, ago(27));
  pushArtifacts(J1, T(3), 'product-tech', results[1].content, ago(9));
  pushArtifacts(J0, T(21), 'business-finance', results[2].content, ago(1480));
  pushArtifacts(J0, T(22), 'legal-compliance', results[3].content, ago(1475));
  pushArtifacts(J0, T(23), 'brand-creative', results[4].content, ago(1470));
  pushArtifacts(J0, T(24), 'content-media', results[5].content, ago(1455));
  pushArtifacts(J0, T(25), 'qa-security', results[6].content, ago(1445));

  const handoff = (from, to, fromTask, toTask, job, at) => ({ id: uuid('70000000', fromTask.length + toTask.length + Math.round(Math.random() * 1e6)), from_agent_id: agentId(from), to_agent_id: agentId(to), from_task_id: fromTask, to_task_id: toTask, job_id: job, created_at: at });
  const handoffs = [
    handoff('chief-of-staff', 'research-strategy', T(1), T(2), J1, ago(41)),
    handoff('research-strategy', 'product-tech', T(2), T(3), J1, ago(27)),
    handoff('research-strategy', 'legal-compliance', T(2), T(5), J1, ago(6)),
    handoff('product-tech', 'business-finance', T(3), T(4), J1, ago(8)),
    handoff('product-tech', 'coding-agent', T(3), T(10), J1, ago(9)),
  ];

  return {
    projects: [
      { id: PREVIEW_WORKSPACE, name: 'Qahwa Run', description: 'Fictional coffee pre-order app in Dubai (preview data).', default_repository: 'FahadTrail/qahwa-run', created_at: ago(4000) },
      { id: HQ, name: 'Fahad AI Office', description: 'The Office itself.', default_repository: 'FahadTrail/fahad-ai-office', created_at: ago(9000) },
    ],
    agents: AGENTS.map(([slug, name, nameAr, tagline, color], index) => ({ id: uuid('a0000000', index + 1), slug, name, name_ar: nameAr, role: slug, tagline, accent_color: color, is_active: true, allowed_tools: [], system_prompt: '' })),
    conversations: [
      { id: C1, project_id: PREVIEW_WORKSPACE, title: 'Qahwa Run launch plan', archived: false, agent_slug: null, created_at: ago(43), updated_at: ago(8), last_message_at: ago(43) },
      { id: C2, project_id: PREVIEW_WORKSPACE, title: 'Telegram · CHIEF', archived: false, agent_slug: null, created_at: ago(3000), updated_at: ago(1440), last_message_at: ago(1500) },
      { id: C3, project_id: PREVIEW_WORKSPACE, title: 'Card fees', archived: false, agent_slug: 'business-finance', created_at: ago(190), updated_at: ago(188), last_message_at: ago(190) },
    ],
    jobs: [
      { id: J1, project_id: PREVIEW_WORKSPACE, conversation_id: C1, title: 'Qahwa Run — launch plan', goal, status: 'running', progress: 55, cost_usd: 0.0042, tokens_used: 48000, priority: 'normal', created_at: ago(42) },
      { id: J0, project_id: PREVIEW_WORKSPACE, conversation_id: C2, title: 'Qahwa Run — first pass', goal: 'اعطني أول تصور لقهوة رن: ميزانية، متطلبات قانونية، هوية، محتوى تشويقي، ومراجعة.', status: 'completed', progress: 100, cost_usd: 0.0031, priority: 'normal', created_at: ago(1500), completed_at: ago(1440) },
      { id: J2, project_id: PREVIEW_WORKSPACE, conversation_id: C3, title: 'Card fees', goal: 'كم رسوم البطاقات تقريباً؟', status: 'completed', progress: 100, cost_usd: 0, priority: 'normal', created_at: ago(190), completed_at: ago(188) },
    ],
    tasks, results, handoffs, artifacts: artifactRows,
    events: [
      { id: 1, job_id: J1, task_id: T(10), type: 'activity', level: 'info', message: 'Development handed to the Coding Agent.', payload: { kind: 'task_launched', session_id: S1 }, created_at: ago(8) },
      { id: 2, job_id: J1, task_id: T(6), type: 'status_changed', level: 'warning', message: 'Waiting for free model capacity — will resume automatically.', payload: { status: 'WAITING_FOR_CAPACITY' }, created_at: ago(5) },
    ],
    agent_sessions: [
      { id: S1, workspace_id: PREVIEW_WORKSPACE, job_id: J1, conversation_id: C1, title: 'Pre-order API endpoint', objective: 'Add POST /orders with pick-up code and tests.', repository: 'FahadTrail/qahwa-run', base_branch: 'main', work_branch: 'office/pre-order-api',
        status: 'awaiting_approval', phase: 'deploy', iteration: 6, budget_usd: 1, spent_usd: 0.021, tokens_in: 81000, tokens_out: 9400, current_route: 'gemini:gemini-flash-latest', result: { pr: { url: 'https://github.com/FahadTrail/qahwa-run/pull/12', number: 12 }, ci: { state: 'success', total: 1, failing: [], checkedAt: ago(4) }, filesChanged: ['src/orders.js', 'src/pickup-code.js', 'test/orders.test.js', 'docs/api.md'], routesUsed: ['gemini:gemini-flash-latest'] },
        created_at: ago(9), updated_at: ago(3), started_at: ago(9) },
      { id: S0, workspace_id: PREVIEW_WORKSPACE, job_id: null, conversation_id: null, title: 'Fix menu price rounding', objective: 'Round AED prices to 2 decimals.', repository: 'FahadTrail/qahwa-run', status: 'completed', phase: 'done', spent_usd: 0.008,
        result: { pr: { url: 'https://github.com/FahadTrail/qahwa-run/pull/11', number: 11 }, ci: { state: 'success', total: 1, failing: [], checkedAt: ago(262) }, filesChanged: ['src/menu.js', 'test/menu.test.js'] }, created_at: ago(300), updated_at: ago(260), completed_at: ago(260) },
    ],
    agent_approvals: [
      { id: uuid('60000000', 1), workspace_id: PREVIEW_WORKSPACE, session_id: S1, tool_name: 'github.merge_pull_request', action: 'merge', risk: 'high', summary: 'Merge PR #12 “Pre-order API endpoint” into main (CI passed, 4 files, 38 tests).', arguments_preview: { pull: 12 }, status: 'pending', requested_at: ago(3) },
    ],
    agent_events: [
      { id: 1, session_id: S1, type: 'phase', level: 'info', message: 'Understanding the task', payload: { phase: 'understand' }, created_at: ago(9) },
      { id: 2, session_id: S1, type: 'phase', level: 'info', message: 'Editing code', payload: { phase: 'implement' }, created_at: ago(7) },
      { id: 3, session_id: S1, type: 'phase', level: 'info', message: 'Running tests', payload: { phase: 'test' }, created_at: ago(5) },
      { id: 4, session_id: S1, type: 'phase', level: 'info', message: 'Opening the pull request', payload: { phase: 'publish' }, created_at: ago(4) },
    ],
    project_memory: [
      { id: uuid('50000000', 1), project_id: PREVIEW_WORKSPACE, kind: 'decision', content: 'Pilot area is Business Bay with five partner cafés.', source: 'owner', created_at: ago(1400) },
      { id: uuid('50000000', 2), project_id: PREVIEW_WORKSPACE, kind: 'brand_decision', content: 'Palette: espresso, sand and one saffron accent.', source: 'agent', created_at: ago(1430) },
      { id: uuid('50000000', 3), project_id: PREVIEW_WORKSPACE, kind: 'financial_assumption', content: 'Card processing ≈ 2.9% of GMV until the provider confirms.', source: 'agent', created_at: ago(1480) },
      { id: uuid('50000000', 4), project_id: PREVIEW_WORKSPACE, kind: 'legal_requirement', content: 'Privacy policy and consent under the UAE PDPL before launch.', source: 'agent', created_at: ago(1475) },
      { id: uuid('50000000', 5), project_id: PREVIEW_WORKSPACE, kind: 'preference', content: 'Fahad prefers short answers in Emirati Arabic.', source: 'owner', created_at: ago(5000) },
    ],
    knowledge_items: [
      { id: uuid('40000000', 1), project_id: PREVIEW_WORKSPACE, agent_slug: 'research-strategy', title: 'Dubai coffee delivery landscape', source_url: '', source_date: '2026-09-26', expires_at: ahead(60 * 24 * 30), created_at: ago(27) },
    ],
    model_attempts: [
      { id: uuid('30000000', 3), job_id: J1, task_id: T(4), provider: 'deepseek', model: 'deepseek-flash', status: 'succeeded', cost_usd: 0.0011, input_tokens: 6400, output_tokens: 1300, duration_ms: 21000, started_at: ago(7) },
      { id: uuid('30000000', 4), job_id: J1, task_id: T(4), provider: 'deepseek', model: 'deepseek-flash', status: 'started', cost_usd: 0.0004, input_tokens: 3100, output_tokens: 400, duration_ms: 0, started_at: ago(2) },
      { id: uuid('30000000', 1), job_id: J1, provider: 'gemini', model: 'gemini-flash-latest', status: 'succeeded', cost_usd: 0, input_tokens: 9000, output_tokens: 1800, started_at: ago(40) },
      { id: uuid('30000000', 2), job_id: J1, provider: 'deepseek', model: 'deepseek-flash', status: 'succeeded', cost_usd: 0.0042, input_tokens: 12000, output_tokens: 2400, started_at: ago(8) },
    ],
    tool_executions: [], provider_status: [], provider_canary_runs: [], workspace_routing_policies: [], workspace_provider_permissions: [], workspace_policies: [], workspace_tool_grants: [], runs: [],
  };
}
