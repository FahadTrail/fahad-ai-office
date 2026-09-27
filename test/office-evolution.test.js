import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficeWorkflow, SEQUENCES } from '../src/workflow.js';
import { validatePlan, planJob } from '../src/chief.js';
import { parseConsultRequest } from '../src/office/specialist.js';
import { mentionedEmployees } from '../src/office/agents.js';
import { ARTIFACT_TYPES, artifactInstructions, parseArtifacts, parseSources, stripArtifacts } from '../src/office/artifacts.js';
import { commandCenter, officeState } from '../src/hub-office.js';
import { OFFICE_ROLES } from '../src/office-agents/roles.js';
import { MemoryStore } from '../testing/fixtures/office-memory-store.js';

const outcome = (text) => ({ text, tokensIn: 10, tokensOut: 5, costUsd: 0, durationMs: 5, turns: 1 });
const block = (value) => `\`\`\`artifact\n${JSON.stringify(value)}\n\`\`\``;

async function drain(workflow, limit = 40) {
  for (let index = 0; index < limit; index += 1) if (!await workflow.runOnce()) return;
  throw new Error('Workflow did not become idle');
}

test('Fahad\'s nicknames name employees (Arabic prefixes, English only in capitals)', () => {
  assert.deepEqual(mentionedEmployees('حولها للفاينانس'), ['finance']);
  assert.deepEqual(mentionedEmployees('خل الليغال يراجع'), ['legal']);
  assert.deepEqual(mentionedEmployees('اسأل الريسيرش'), ['research']);
  assert.deepEqual(mentionedEmployees('خل الكرييتف يشتغل عليها'), ['creative']);
  assert.deepEqual(mentionedEmployees('حول المشروع للكودينج'), ['coding']);
  assert.deepEqual(mentionedEmployees('Let LEGAL review it, then FINANCE'), ['legal', 'finance']);
  assert.deepEqual(mentionedEmployees('please do some research on our content'), [], 'ordinary words are not dispatches');
  assert.deepEqual(mentionedEmployees('ask OPERATIONS'), ['product'], 'retired names reach their successor');
});

test('the Chief is told which employees Fahad named', async () => {
  let prompt = '';
  const plan = { route: 'answer', answer: 'ok', plan_summary: 'ok' };
  await planJob({ agent: { system_prompt: 'Chief' }, goal: 'حولها للفاينانس وخل الليغال يراجع', run: async (input) => { prompt = input.prompt; return outcome(JSON.stringify(plan)); } });
  assert.match(prompt, /EMPLOYEES FAHAD NAMED IN THIS MESSAGE: FINANCE, LEGAL/);
  for (const label of ['RESEARCH', 'CREATIVE', 'PRODUCT', 'FINANCE', 'CODING', 'AUDIT', 'SOCIAL', 'LEGAL']) assert.match(prompt, new RegExp(`: ${label} —`));
  assert.doesNotMatch(prompt, /Business Strategy|Operations/);
  assert.equal(validatePlan(JSON.stringify({ route: 'orchestrate', plan_summary: 'x', workstreams: [{ id: 'l', agent: 'الليغال', title: 'Terms', brief: 'Review the terms of service for UAE rules.', depends_on: [] }] })).workstreams[0].agent, 'legal');
});

test('artifacts are validated per type; invalid ones are dropped, never rendered as HTML', () => {
  const md = [
    '## Summary\nBudget.',
    block({ type: 'financial_model', title: 'Launch', currency: 'AED', items: [{ category: 'Build', item: 'MVP', one_time: 30000, basis: 'guess' }] }),
    block({ type: 'moodboard', title: 'Mood', palette: [{ name: 'Sea', hex: '#1e3a5f' }, { name: 'bad', hex: 'red;background:url(x)' }], typography: [{ family: 'Fraunces<script>' }] }),
    block({ type: 'evidence', claims: [{ claim: 'Market is growing', status: 'VERIFIED' }, { claim: 'Cited', status: 'VERIFIED', source: 'https://example.com' }] }),
    block({ type: 'audit_report', verdict: 'needs work', findings: [{ title: 'No privacy policy', severity: 'high', owner: 'legal' }] }),
    block({ type: 'html', html: '<b>x</b>' }),
    '```artifact\n{not json}\n```',
  ].join('\n\n');
  const { artifacts, errors } = parseArtifacts(md);
  assert.deepEqual(artifacts.map((entry) => entry.type), ['financial_model', 'moodboard', 'evidence', 'audit_report']);
  assert.equal(artifacts[0].data.items[0].basis, 'ESTIMATED', 'unknown basis never becomes KNOWN');
  assert.deepEqual(artifacts[1].data.palette.map((swatch) => swatch.hex), ['#1E3A5F']);
  assert.equal(artifacts[1].data.typography[0].family, 'Frauncesscript');
  assert.deepEqual(artifacts[2].data.claims.map((claim) => claim.status), ['LIKELY', 'VERIFIED'], 'VERIFIED needs a source');
  assert.equal(artifacts[3].data.verdict, 'NEEDS WORK');
  assert.equal(errors.length, 2);
  assert.doesNotMatch(stripArtifacts(md), /```artifact/);
  assert.ok(artifactInstructions(['chart']).join('\n').includes('"type":"chart"'));
  assert.ok(Object.keys(ARTIFACT_TYPES).length >= 13);
});

test('sources are read from the Sources section only', () => {
  const sources = parseSources('## Work\nhttps://not-a-source.example\n\n## Sources\n- [UAE PDPL](https://u.ae/pdpl).\n- https://example.com/b\n- [UAE PDPL again](https://u.ae/pdpl)');
  assert.deepEqual(sources.map((source) => source.url), ['https://u.ae/pdpl', 'https://example.com/b']);
});

test('an employee consults a colleague during a direct chat, then answers with that input', async () => {
  const store = new MemoryStore({ goal: 'How much will hosting cost per month?', projectId: 'ws-1' });
  store.conversationAgent = async () => 'business-finance';
  store.jobContext = async () => ({ text: '', conversationId: 'conv-1', project: { id: 'ws-1', name: 'Harbor' } });
  const calls = [];
  const workflow = new OfficeWorkflow({
    store, now: () => store.now,
    direct: async (input) => {
      calls.push({ role: input.role, consultFrom: input.consultFrom || null, allowConsult: input.allowConsult, consults: input.consults?.map((entry) => entry.agent_slug) || [] });
      if (input.consultFrom) return outcome('About 40 USD/month on a small VPS (ESTIMATED).');
      if (input.allowConsult) return outcome('{"consult":[{"employee":"الكودينج","question":"What infrastructure does the MVP need and what does it cost monthly?"},{"employee":"finance","question":"self consult is ignored"}]}');
      return outcome('## Summary\nHosting ≈ 40 USD/month (ESTIMATED, from CODING).\n\n' + block({ type: 'chart', title: 'Monthly', labels: ['M1', 'M2'], series: [{ name: 'Hosting', values: [40, 40] }] }));
    },
  });
  await drain(workflow);
  assert.equal(store.jobs[0].status, 'completed');
  assert.deepEqual(calls, [
    { role: 'finance', consultFrom: null, allowConsult: true, consults: [] },
    { role: 'coding', consultFrom: 'FINANCE', allowConsult: false, consults: [] },
    { role: 'finance', consultFrom: null, allowConsult: false, consults: ['coding-agent'] },
  ]);
  assert.deepEqual(store.tasks.map((task) => [task.agent_slug, task.sequence]), [['business-finance', SEQUENCES.PLAN], ['coding-agent', SEQUENCES.CONSULT], ['business-finance', SEQUENCES.DIRECT_FOLLOWUP]]);
  assert.match(store.results.find((result) => result.kind === 'final').content, /Hosting ≈ 40/);
  assert.ok(store.events.some((event) => event.payload?.kind === 'consult_requested'));
  assert.deepEqual(store.artifacts.map((row) => [row.type, row.agent_slug, row.project_id, row.conversation_id]), [['chart', 'business-finance', 'ws-1', 'conv-1']]);
});

test('workstream artifacts and cited sources are stored; knowledge comes back next time', async () => {
  const store = new MemoryStore({ goal: 'Check UAE privacy rules for the app.', projectId: 'ws-1' });
  store.jobContext = async () => ({ text: '', project: { id: 'ws-1', name: 'Harbor' } });
  const plan = { route: 'orchestrate', plan_summary: 'Legal check.', synthesis_brief: 'Summary.', workstreams: [{ id: 'law', agent: 'legal', title: 'Privacy rules', brief: 'List UAE privacy requirements for a consumer app.', depends_on: [] }] };
  const seen = [];
  const workflow = new OfficeWorkflow({
    store, now: () => Date.parse('2026-09-27T00:00:00Z'),
    plan: async () => ({ ...outcome(JSON.stringify(plan)), plan: validatePlan(JSON.stringify(plan)) }),
    specialist: async (input) => {
      seen.push(input.knowledge.map((item) => item.source_url));
      return outcome(['## Summary\nPDPL applies.', block({ type: 'compliance_matrix', items: [{ requirement: 'Privacy notice', jurisdiction: 'UAE', classification: 'RISK FLAG' }] }), '## Sources\n- [PDPL](https://u.ae/pdpl)'].join('\n\n'));
    },
    synthesize: async () => outcome('Final.\n\n' + block({ type: 'checklist', items: [{ text: 'Publish privacy notice' }] })),
  });
  await drain(workflow);
  assert.deepEqual(store.artifacts.map((row) => `${row.agent_slug}:${row.type}`), ['legal-compliance:compliance_matrix', 'chief-of-staff:checklist']);
  assert.equal(store.knowledge.length, 1);
  assert.equal(store.knowledge[0].expires_at, '2027-03-26T00:00:00.000Z', 'legal knowledge expires after 180 days');
  assert.ok(store.events.some((event) => event.payload?.kind === 'output_ready' && event.payload.artifacts === 1 && event.payload.sources === 1));
  assert.deepEqual(await store.knowledgeFor('ws-1', 'legal-compliance').then((items) => items.map((item) => item.source_url)), ['https://u.ae/pdpl']);
  assert.deepEqual(seen, [[]]);
});

test('consult requests are bounded, deduplicated and never target the asker, CHIEF or retired employees', () => {
  const text = JSON.stringify({ consult: [
    { employee: 'coding', question: 'What does the infrastructure cost?' },
    { employee: 'coding', question: 'Duplicate question for coding' },
    { employee: 'chief', question: 'Chief is not consultable here' },
    { employee: 'finance', question: 'Self consult is not allowed' },
    { employee: 'legal', question: 'Is a privacy policy required?' },
    { employee: 'social', question: 'Beyond the limit of two' },
  ] });
  assert.deepEqual(parseConsultRequest(text, 'finance').map((entry) => entry.employee), ['coding', 'legal']);
  assert.deepEqual(parseConsultRequest('A normal answer.', 'finance'), []);
});

test('office states include QUEUED and FAILED; the Office floor lists only the nine employees', () => {
  const agents = [{ id: 'a1', slug: 'research-strategy' }, { id: 'a2', slug: 'legal-compliance' }, { id: 'a3', slug: 'business-finance' }];
  const jobs = [{ id: 'j1', status: 'running', title: 'X' }];
  const now = Date.parse('2026-09-27T10:00:00Z');
  const tasks = [
    { id: 't1', job_id: 'j1', agent_id: 'a1', title: 'Research', status: 'queued', depends_on: [], brief: '{"stage":"specialist"}', created_at: '2026-09-27T09:59:00Z' },
    { id: 't2', job_id: 'j1', agent_id: 'a2', title: 'Legal', status: 'failed', depends_on: [], brief: '{"stage":"specialist"}', created_at: '2026-09-27T09:00:00Z', completed_at: '2026-09-27T09:30:00Z' },
    { id: 't3', job_id: 'j1', agent_id: 'a3', title: 'Budget', status: 'queued', depends_on: ['t1'], brief: '{"stage":"specialist"}', created_at: '2026-09-27T09:59:00Z' },
  ];
  const states = officeState({ agents, jobs, tasks, now });
  assert.equal(states.get('research-strategy').state, 'QUEUED');
  assert.equal(states.get('legal-compliance').state, 'FAILED');
  assert.equal(states.get('business-finance').state, 'WAITING');
  assert.deepEqual(OFFICE_ROLES.map((role) => role.label), ['CHIEF', 'RESEARCH', 'CREATIVE', 'PRODUCT', 'FINANCE', 'CODING', 'AUDIT', 'SOCIAL', 'LEGAL']);
  assert.ok(OFFICE_ROLES.find((role) => role.id === 'social').skills.includes('SEO'));
});

test('the Project Command Center summarizes real rows only', () => {
  const live = { jobs: [{ id: 'j1', status: 'running', title: 'Launch' }, { id: 'j2', status: 'completed' }], tasks: [], sessions: [], approvals: [{ id: 'p1' }] };
  const artifacts = [
    { id: 'x1', type: 'audit_report', title: 'Audit', agent_slug: 'qa-security', data: { verdict: 'NEEDS WORK', findings: [{ title: 'No backups', severity: 'critical', owner: 'coding' }, { title: 'Typo', severity: 'low' }] }, created_at: '2026-09-27T09:00:00Z' },
    { id: 'x2', type: 'compliance_matrix', title: 'Legal', agent_slug: 'legal-compliance', data: { items: [{ requirement: 'Privacy notice', classification: 'RISK FLAG' }, { requirement: 'Info', classification: 'INFORMATION' }] }, created_at: '2026-09-27T08:00:00Z' },
  ];
  const view = commandCenter({ project: { id: 'p', name: 'Harbor' }, live, states: new Map(), artifacts, memory: [{ kind: 'brand_decision', content: 'Blue' }], knowledge: [], costs: [{ cost_usd: 0.01 }, { cost_usd: 0.02 }] });
  assert.equal(view.objectives.active.length, 1);
  assert.equal(view.needsFahad, 1);
  assert.equal(view.latestAudit.verdict, 'NEEDS WORK');
  assert.deepEqual(view.risks.map((risk) => `${risk.from}:${risk.text}`), ['AUDIT:No backups', 'LEGAL:Privacy notice']);
  assert.equal(view.costUsd, 0.03);
  assert.deepEqual(view.memory.byKind, { brand_decision: 1 });
  assert.deepEqual(view.team, [], 'nobody is shown working without a task row');
});

test('the visual engine draws every artifact type and escapes everything', async () => {
  const { renderArtifact, splitArtifacts } = await import('../src/hub-ui/artifacts.js');
  const samples = {
    table: { columns: ['<b>A</b>'], rows: [['<img src=x onerror=alert(1)>']] },
    chart: { kind: 'bar', labels: ['Jan', 'Feb'], series: [{ name: 'Cost', values: [10, 20] }] },
    timeline: { items: [{ label: 'MVP' }] }, checklist: { items: [{ text: 'Ship', status: 'done' }] },
    kanban: { columns: [{ name: 'Must', cards: [{ title: 'Login' }] }] }, flow: { steps: [{ id: 'a', label: 'Start', next: [] }] },
    moodboard: { palette: [{ name: 'Sea', hex: '#1E3A5F' }, { name: 'x', hex: 'red;background:url(javascript:1)' }], typography: [{ family: "Inter');x:(" }] },
    financial_model: { currency: 'AED', items: [{ item: 'VPS', monthly: 40, basis: 'KNOWN' }] },
    compliance_matrix: { items: [{ requirement: 'Privacy notice', classification: 'RISK FLAG', source: 'javascript:alert(1)' }] },
    audit_report: { verdict: 'BLOCKED', findings: [{ title: 'No auth', severity: 'critical' }] },
    content_calendar: { entries: [{ hook: 'Hi' }] }, evidence: { claims: [{ claim: 'x', status: 'VERIFIED' }] },
    risk_matrix: { items: [{ risk: 'Outage', likelihood: 4, impact: 5 }] },
  };
  for (const [type, data] of Object.entries(samples)) {
    const html = renderArtifact({ type, title: `<t>${type}`, data });
    assert.match(html, /<figure class="artifact/, type);
    assert.doesNotMatch(html, /<img|<b>A|<t>|href="javascript:|url\(/, type);
  }
  assert.match(renderArtifact({ type: 'evidence', data: samples.evidence }), /LIKELY/, 'unsourced VERIFIED is shown as LIKELY');
  assert.equal(renderArtifact({ type: 'script', data: {} }), '');
  const parts = splitArtifacts('Before\n```artifact\n{"type":"checklist","items":[{"text":"a"}]}\n```\nAfter\n```artifact\n{broken\n```');
  assert.deepEqual(parts.map((part) => (part.artifact ? part.artifact.type : part.text.trim())), ['Before', 'checklist', 'After']);
});

test('when Fahad names a colleague in a direct chat, the consult happens without asking the model first', async () => {
  const store = new MemoryStore({ goal: 'قبل ما تجاوب اسأل الكودينج: كم تكلفة الاستضافة؟', projectId: 'ws-1' });
  store.conversationAgent = async () => 'business-finance';
  const calls = [];
  const workflow = new OfficeWorkflow({
    store, now: () => store.now,
    direct: async (input) => {
      calls.push({ role: input.role, consultFrom: input.consultFrom || null, consults: input.consults?.map((entry) => entry.agent_slug) || [] });
      return outcome(input.consultFrom ? 'Hosting ≈ 25 USD/month (ESTIMATED).' : '## Summary\nAbout 92 AED/month (ESTIMATED, CODING input).');
    },
  });
  await drain(workflow);
  assert.deepEqual(calls, [
    { role: 'coding', consultFrom: 'FINANCE', consults: [] },
    { role: 'finance', consultFrom: null, consults: ['coding-agent'] },
  ]);
  assert.match(store.results.find((result) => result.kind === 'final').content, /92 AED/);
});

test('placeholder and malformed links are never saved as sources or evidence', () => {
  const md = '## Sources\n- `https://apps.apple.com/ae/app/starbucks-uae/...`\n- https://apps.apple.com/ae/app/x/id...\n- https://deliveroo.ae`\n- [PDPL](https://u.ae/pdpl)\n- https://x';
  assert.deepEqual(parseSources(md).map((source) => source.url), ['https://deliveroo.ae', 'https://u.ae/pdpl']);
  const { artifacts } = parseArtifacts(block({ type: 'evidence', claims: [{ claim: 'x', status: 'VERIFIED', source: 'https://apps.apple.com/ae/app/y/id...' }] }));
  assert.deepEqual(artifacts[0].data.claims[0], { claim: 'x', status: 'LIKELY', source: '' });
});
