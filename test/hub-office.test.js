import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilityView, officeState, workflowView } from '../src/hub-office.js';
import { workflowSummary } from '../src/hub-workspace.js';

const now = Date.parse('2026-09-28T12:00:00Z');
const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
const agents = [
  { id: 'a-chief', slug: 'chief-of-staff' }, { id: 'a-research', slug: 'research-strategy' }, { id: 'a-strategy', slug: 'business-strategy' },
  { id: 'a-finance', slug: 'business-finance' }, { id: 'a-brand', slug: 'brand-creative' }, { id: 'a-coding', slug: 'coding-agent' },
];
const brief = (stage, extra = {}) => JSON.stringify({ workflow: 'chief-research-chief', workflow_version: 1, stage, ...extra });
const job = { id: 'job-1', title: 'Morning Harbor launch', goal: 'Create a launch concept', status: 'running', created_at: at(30) };
const tasks = [
  { id: 't-plan', job_id: 'job-1', agent_id: 'a-chief', title: 'Chief planning', status: 'done', brief: brief('chief_plan'), depends_on: [], sequence: 10, created_at: at(30), completed_at: at(29) },
  { id: 't-research', job_id: 'job-1', agent_id: 'a-research', title: 'Market research', status: 'done', brief: brief('specialist'), depends_on: ['t-plan'], sequence: 100, created_at: at(29), completed_at: at(5) },
  { id: 't-strategy', job_id: 'job-1', agent_id: 'a-strategy', title: 'Business model', status: 'running', brief: brief('specialist'), depends_on: ['t-research'], sequence: 101, created_at: at(29), started_at: at(4) },
  { id: 't-finance', job_id: 'job-1', agent_id: 'a-finance', title: 'Launch budget', status: 'queued', brief: brief('specialist'), depends_on: ['t-strategy'], sequence: 102, created_at: at(29) },
  { id: 't-synth', job_id: 'job-1', agent_id: 'a-chief', title: 'Chief synthesis', status: 'queued', brief: brief('synthesis', { round: 1 }), depends_on: ['t-research', 't-strategy', 't-finance'], sequence: 900, created_at: at(29) },
];

test('live Office states come only from real task, session and approval rows', () => {
  const states = officeState({ agents, jobs: [job], tasks, sessions: [], approvals: [], now });
  assert.equal(states.get('business-strategy').state, 'WORKING');
  assert.match(states.get('business-strategy').detail, /Business model/);
  assert.equal(states.get('business-finance').state, 'WAITING');
  assert.match(states.get('business-finance').detail, /Waiting for Business Strategy/);
  assert.equal(states.get('research-strategy').state, 'COMPLETED', 'delivered five minutes ago');
  assert.equal(states.get('chief-of-staff').state, 'WAITING', 'the synthesis waits for the team');
  assert.equal(states.get('brand-creative').state, 'AVAILABLE', 'no task row, no invented activity');
  assert.equal(states.get('content-media').state, 'AVAILABLE');
});

test('the Coding Agent shows TESTING while testing and NEEDS FAHAD when approval is pending', () => {
  const session = { id: 's-1', title: 'Add landing page', status: 'running', phase: 'test', updated_at: at(1), created_at: at(20) };
  assert.equal(officeState({ agents, sessions: [session], now }).get('coding-agent').state, 'TESTING');
  const waiting = { ...session, status: 'awaiting_approval' };
  const approval = { id: 'ap-1', session_id: 's-1', status: 'pending', tool_name: 'repo.protected_change', arguments_preview: { paths: ['ops/x.sh'] } };
  const state = officeState({ agents, sessions: [waiting], approvals: [approval], now }).get('coding-agent');
  assert.equal(state.state, 'NEEDS FAHAD');
  assert.match(state.detail, /approval/);
  const question = { ...session, status: 'blocked', error_code: 'HUMAN_INPUT_REQUIRED', blocker: 'Agent needs the owner: x — which one?' };
  assert.equal(officeState({ agents, sessions: [question], now }).get('coding-agent').state, 'NEEDS FAHAD');
});

test('the Chief is THINKING while planning and REVIEWING while consolidating', () => {
  const planning = [{ ...tasks[0], status: 'running', started_at: at(1) }];
  assert.equal(officeState({ agents, jobs: [job], tasks: planning, now }).get('chief-of-staff').state, 'THINKING');
  const consolidating = tasks.map((task) => (task.id === 't-synth' ? { ...task, status: 'running', started_at: at(1) } : { ...task, status: 'done', completed_at: at(2) }));
  assert.equal(officeState({ agents, jobs: [job], tasks: consolidating, now }).get('chief-of-staff').state, 'REVIEWING');
});

test('the workflow view shows who did what, the handoffs and the decisions', () => {
  const results = [
    { task_id: 't-research', kind: 'task', summary: 's', content: '## Summary\nThe market is growing.\n\n## Work\n...\n\n## Decisions for Fahad\nPick the district.', created_at: at(5) },
  ];
  const handoffs = [{ from_agent_id: 'a-research', to_agent_id: 'a-strategy', from_task_id: 't-research', to_task_id: 't-strategy', created_at: at(5) }];
  const view = workflowView({ job, tasks, agents, results, handoffs, events: [] });
  assert.equal(view.multiAgent, true);
  assert.deepEqual(view.nodes.map((node) => `${node.agentLabel}:${node.kind}:${node.state}`), [
    'Chief of Staff:plan:done', 'Research:workstream:done', 'Business Strategy:workstream:working', 'Finance:workstream:waiting', 'Chief of Staff:synthesis:waiting',
  ]);
  assert.equal(view.nodes[1].output.summary, 'The market is growing.');
  assert.deepEqual(view.decisions, [{ from: 'Research', text: 'Pick the district.' }]);
  assert.deepEqual(view.handoffs.map((handoff) => `${handoff.from}→${handoff.to}`), ['Research→Business Strategy']);
  assert.deepEqual(view.participants.map((entry) => entry.label), ['Research', 'Business Strategy', 'Finance']);
  const summary = workflowSummary(tasks.map((task) => ({ ...task, agent_slug: agents.find((agent) => agent.id === task.agent_id).slug })));
  assert.deepEqual(summary.streams.map((stream) => `${stream.agent}:${stream.state}`), ['Research:done', 'Business Strategy:working', 'Finance:waiting']);
});

test('connectors are "Connected" only with evidence of a real successful use', () => {
  const view = capabilityView({
    toolRuns: [{ tool_name: 'github.pr_create', status: 'succeeded', last: at(60) }, { tool_name: 'repo.edit', status: 'succeeded', last: at(60) }, { tool_name: 'github.ci_status', status: 'succeeded', last: at(60) }],
    webRuns: { web_fetch: at(120) }, env: { CODING_GITHUB_TOKEN: 'ghp_fake_secret_value', GEMINI_API_KEY: 'fake-gemini-secret' }, now,
  });
  const byId = Object.fromEntries(view.map((item) => [item.id, item]));
  assert.equal(byId.github.status, 'Connected');
  assert.equal(byId.pull_requests.status, 'Connected');
  assert.equal(byId.web_fetch.status, 'Connected');
  assert.equal(byId.web_search.status, 'Configured — not verified', 'a key alone is not proof');
  assert.equal(byId.deployment.status, 'Not configured');
  assert.equal(byId.supabase_tools.status, 'Not configured');
  assert.match(byId.supabase_tools.detail, /CODING_SUPABASE_ACCESS_TOKEN is missing/);
  assert.ok(!/fake_secret_value|fake-gemini-secret/.test(JSON.stringify(view)), 'credential values never appear');
});
