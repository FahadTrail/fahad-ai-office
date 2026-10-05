// V5.3 owner UI: the Deliverables Center's board logic and the CODING
// workspace's readable thread. Pure checks plus source guards, no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { countByStatus, deliverablePreview, filterDeliverables, groupDeliverables, reasonElement, reasonText, sortDeliverables, typeLabel } from '../src/hub-ui/deliverables.js';
import { activityText, codingActivity, codingState, localNow, requestOf } from '../src/hub-ui/coding.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const item = (key, extra = {}) => ({ key, kind: 'office', agent: { key: 'finance', label: 'FINANCE', slug: 'business-finance' }, type: 'report', types: ['report'], title: key, summary: null,
  status: 'ready', reason: null, updatedAt: '2026-10-05T10:00:00Z', priority: 'normal', objective: null, artifacts: [], review: null, version: { number: 1, count: 1, pending: false, list: [] }, ...extra });
const ITEMS = [
  item('a', { status: 'waiting', reason: { code: 'capacity' }, updatedAt: '2026-10-05T12:00:00Z' }),
  item('b', { status: 'ready', updatedAt: '2026-10-05T11:00:00Z', agent: { key: 'creative', label: 'CREATIVE' }, type: 'moodboard', types: ['moodboard', 'table'], summary: 'Warm saffron palette' }),
  item('c', { status: 'needs_fahad', reason: { code: 'decision', text: 'Confirm Business Bay' }, updatedAt: '2026-10-04T09:00:00Z', objective: { id: 'o1', title: 'Launch plan', createdAt: '2026-10-04T08:00:00Z' } }),
  item('d', { status: 'ready', updatedAt: '2026-10-01T09:00:00Z', review: { pinned: true }, priority: 'urgent' }),
  item('e', { status: 'in_progress', reason: { code: 'working', since: '2026-10-05T12:30:00Z' }, updatedAt: '2026-10-05T12:30:00Z', agent: { key: 'audit', label: 'AUDIT' } }),
  item('f', { status: 'needs_review', reason: { code: 'audit', verdict: 'NEEDS WORK' }, updatedAt: '2026-10-03T09:00:00Z', review: { archived: true } }),
];

test('the board filters by status, employee, type, date, priority, objective and words', () => {
  const now = Date.parse('2026-10-05T13:00:00Z');
  const keys = (filters, language = 'en') => filterDeliverables(ITEMS, filters, language, now).map((entry) => entry.key);
  assert.deepEqual(keys({}), ['a', 'b', 'c', 'd', 'e'], 'archived outputs stay out unless asked for');
  assert.deepEqual(keys({ showArchived: true }), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(keys({ status: 'ready' }), ['b', 'd']);
  assert.deepEqual(keys({ agent: 'creative' }), ['b']);
  assert.deepEqual(keys({ type: 'table' }), ['b'], 'a deliverable matches any of its visual types');
  assert.deepEqual(keys({ since: '1' }), ['a', 'b', 'e']);
  assert.deepEqual(keys({ priority: 'pinned' }), ['d']);
  assert.deepEqual(keys({ priority: 'high' }), ['d']);
  assert.deepEqual(keys({ objective: 'o1' }), ['c']);
  assert.deepEqual(keys({ objective: 'none' }), ['a', 'b', 'd', 'e']);
  assert.deepEqual(keys({ search: 'saffron' }), ['b'], 'summary text is searchable');
  assert.deepEqual(keys({ search: 'business bay' }), ['c'], 'the reason is searchable');
  assert.deepEqual(keys({ search: 'لوحة الهوية' }, 'ar'), ['b'], 'Arabic type names are searchable');
  assert.deepEqual(countByStatus(ITEMS), { needs_fahad: 1, blocked: 0, needs_review: 0, in_progress: 1, waiting: 1, ready: 2 });
});

test('smart order: pinned, then what needs Fahad, then new results, moving work and waiting work', () => {
  assert.deepEqual(sortDeliverables(ITEMS, 'smart', 'en').map((entry) => entry.key), ['d', 'c', 'f', 'b', 'e', 'a']);
  assert.deepEqual(sortDeliverables(ITEMS, 'newest', 'en').map((entry) => entry.key), ['e', 'a', 'b', 'c', 'f', 'd']);
  assert.deepEqual(sortDeliverables(ITEMS, 'oldest', 'en').map((entry) => entry.key).at(0), 'd');
  assert.deepEqual(sortDeliverables(ITEMS, 'employee', 'en').map((entry) => entry.agent.key), ['creative', 'finance', 'finance', 'finance', 'finance', 'audit']);
  assert.equal(sortDeliverables(ITEMS, 'status', 'en')[0].key, 'c');
});

test('groups follow the roster, the status order and the newest objective', () => {
  assert.deepEqual(groupDeliverables(ITEMS, 'employee', 'en').map((group) => group.label), ['CREATIVE', 'FINANCE', 'AUDIT']);
  assert.deepEqual(groupDeliverables(ITEMS, 'status', 'en').map((group) => group.key), ['needs_fahad', 'needs_review', 'in_progress', 'waiting', 'ready']);
  assert.deepEqual(groupDeliverables(ITEMS, 'objective', 'ar').map((group) => group.label), ['Launch plan', 'بدون هدف']);
  assert.ok(groupDeliverables(ITEMS, 'type', 'ar').some((group) => group.label === 'لوحة الهوية'));
});

test('every reason reads in Fahad’s language and quotes data with its own direction', () => {
  const codes = [['decision', { text: 'Pick A' }], ['approval', { text: 'Merge PR #1' }], ['question', { text: 'Which DB?' }], ['paused', { text: 'Budget used' }], ['audit', { verdict: 'BLOCKED' }],
    ['compliance', { count: 2 }], ['finance', { state: 'INCONSISTENT' }], ['ci_failed', {}], ['revision_requested', { at: 'x' }], ['approved', { at: 'x' }], ['working', { since: 'x' }],
    ['capacity', {}], ['dependency', { agents: ['CREATIVE', 'LEGAL'] }], ['queued', {}], ['failed', { text: 'boom' }], ['upstream_failed', {}], ['stopped', {}]];
  for (const [code, extra] of codes) {
    const entry = item(code, { reason: { code, ...extra } });
    const [en, ar] = [reasonText(entry, 'en'), reasonText(entry, 'ar')];
    assert.ok(en && ar && en !== ar, code);
    assert.match(ar, /[؀-ۿ]/, `${code} is Arabic`);
  }
  const html = reasonElement(item('x', { reason: { code: 'decision', text: '<img src=x onerror=alert(1)>' } }), 'ar', String, 'p', 'class="dl-reason"');
  assert.match(html, /^<p class="dl-reason">قرار مطلوب منك: <bdi>&lt;img src=x onerror=alert\(1\)&gt;<\/bdi><\/p>$/);
  assert.match(reasonElement(item('y', { summary: 'Plain data' }), 'ar', String), /dir="auto">Plain data</, 'pure data finds its own direction');
  assert.equal(typeLabel('financial_model', 'ar'), 'نموذج مالي');
  assert.equal(typeLabel('synthesis', 'en'), 'Executive summary');
});

test('previews show real output, an honest state, or the code change — never a mock-up', () => {
  const pending = deliverablePreview(item('p', { status: 'in_progress', reason: { code: 'working', since: 'x' } }), 'en');
  assert.match(pending, /pv-pending/);
  assert.doesNotMatch(pending, /pv-art|art-|svg/, 'no visual is drawn for output that does not exist yet');
  assert.match(deliverablePreview(item('w', { status: 'waiting', reason: { code: 'capacity' } }), 'ar'), /ينتظر السعة المجانية/);
  const board = deliverablePreview(item('k', { artifacts: [{ type: 'kanban', data: { columns: [{ name: 'Must', cards: [{ title: '<b>x</b>' }] }] } }, { type: 'timeline', data: { items: [] } }] }), 'en');
  assert.match(board, /pv-kb/);
  assert.match(board, /&lt;b&gt;x&lt;\/b&gt;/, 'model text inside a preview is escaped');
  assert.match(board, /pv-more num" dir="ltr">\+1/);
  const finance = deliverablePreview(item('f', { artifacts: [{ type: 'financial_model', data: { currency: 'AED', items: [{ one_time: 1000, monthly: 50 }], validation: { state: 'VERIFIED' } } }] }), 'ar');
  assert.match(finance, /التأسيس/);
  assert.match(finance, /1,000 AED/);
  assert.match(finance, /متحقق منها/);
  const code = deliverablePreview(item('c', { kind: 'coding', coding: { pr: { number: 7 }, ci: 'success', tests: 'passing', files: ['src/a.js', 'src/<x>.js'], filesCount: 6 } }), 'ar');
  assert.match(code, /pv-code-files" dir="ltr"/);
  assert.match(code, /src\/&lt;x&gt;\.js/);
  assert.match(code, /\+4/);
  assert.match(code, /CI نجحت/);
  const doc = deliverablePreview(item('d', { summary: 'Executive text', type: 'synthesis' }), 'en');
  assert.match(doc, /pv-doc-kicker">Executive summary/);
});

test('the CODING thread tells the story in plain words and leaves the machinery to Advanced', () => {
  const event = (id, type, message, payload = {}) => ({ id, type, message, payload, createdAt: `2026-10-05T10:${String(id).padStart(2, '0')}:00Z` });
  // The API returns events newest first.
  const events = [
    event(1, 'session', 'Coding Agent session started by worker w1.'), event(2, 'phase', 'Phase: understand', { phase: 'understand' }), event(3, 'model_turn', 'I will read the router first.'),
    event(4, 'tool_call', 'repo.read', { tool: 'repo.read' }), event(5, 'plan', 'Plan updated (3 steps). Next: edit', { plan: [{}, {}, {}] }), event(6, 'phase', 'Phase: implement', { phase: 'implement' }),
    event(7, 'test', 'npm test → exit 1'), event(8, 'owner', 'Fahad replied: Use Postgres, not SQLite.'), event(9, 'test', 'npm test → exit 0'), event(10, 'git', 'Committed abc1234 — orders'),
    event(11, 'github', 'Opened pull request #7.'), event(12, 'ci', 'Waiting for CI on abc1234'), event(13, 'ci', 'Waiting for CI on abc1234'), event(14, 'provider_switch', 'Model switch a → b (RATE_LIMIT).'),
    event(15, 'guard', 'All eligible models are cooling down'), event(16, 'ci', 'CI passed on abc1234'), event(17, 'report', 'Session completed.'),
  ].reverse();
  const approvals = [{ id: 'p', status: 'approved', requested_at: '2026-10-05T10:16:30Z', decided_at: '2026-10-05T10:16:45Z', card: { what: 'Merge the pull request' } }];
  const story = codingActivity(events, approvals);
  assert.deepEqual(story.map((entry) => entry.kind === 'owner' ? `owner:${entry.text}` : entry.code), [
    'started', 'phase', 'plan', 'phase', 'tests', 'owner:Use Postgres, not SQLite.', 'tests', 'commit', 'pr', 'ci_wait', 'ci_passed', 'approval_requested', 'approval_approved', 'completed',
  ], 'tool calls, model turns, guards and routes stay out; repeated CI polls collapse');
  assert.deepEqual([story[4].pass, story[6].pass, story[8].number], [false, true, 7]);
  for (const entry of story.filter((value) => value.code)) for (const language of ['en', 'ar']) assert.ok(activityText(entry, language), `${entry.code}/${language}`);
  assert.equal(activityText({ code: 'pr', number: 7 }, 'ar'), 'فتح طلب الدمج #7');
  assert.deepEqual(['needs', 'needs', 'paused', 'working', 'queued', 'done', 'failed', 'cancelled'], [
    codingState({ status: 'awaiting_approval', needs: { kind: 'approval' } }), codingState({ status: 'blocked', needs: { kind: 'question' } }), codingState({ status: 'blocked', needs: { kind: 'blocked' } }),
    codingState({ status: 'running' }), codingState({ status: 'queued' }), codingState({ status: 'completed' }), codingState({ status: 'failed' }), codingState({ status: 'cancelled' })]);
  assert.equal(localNow('Waiting for your approval.', 'ar'), 'ينتظر موافقتك.');
  assert.equal(localNow('Reading src/orders.js.', 'ar'), 'يقرأ src/orders.js');
  assert.equal(localNow('Next: add the tests', 'ar'), 'الخطوة الياية: add the tests');
  assert.equal(localNow('Something new.', 'ar'), 'Something new.', 'unknown sentences are shown as they are');
  assert.equal(localNow('Waiting for your approval.', 'en'), 'Waiting for your approval.');
  assert.equal(requestOf('Fix the login bug').author, 'owner');
  const launched = requestOf('Build the API\nINPUTS FROM THE OFFICE:\n...\n\nOriginal objective from Fahad: Launch the app');
  assert.deepEqual([launched.author, launched.original], ['chief', 'Launch the app'], 'a CHIEF-launched task is shown as written by CHIEF for Fahad');
});

test('the CODING surface keeps diagnostics behind Advanced and acts only through existing endpoints', () => {
  const source = read('src/hub-ui/coding.js');
  const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  const surface = between('function overview()', 'function activity()');
  for (const technical of ['currentModel', 'metrics', 'Tokens', 'iteration', 'modelsUsed', 'workBranch']) assert.ok(!surface.includes(technical), `${technical} stays out of the main surface`);
  const advanced = between('function drawAdvanced()', 'let composerState');
  for (const technical of ['currentModel', 'metrics', 'inputTokens', 'iterations', 'modelsUsed', 'workBranch', 'w.events(']) assert.ok(advanced.includes(technical), `${technical} is available under Advanced`);
  assert.match(source, /<details class="disclosure cw-advanced" id="cwAdvanced"><summary>/, 'Advanced is a closed disclosure');
  for (const endpoint of ['/api/tasks/${id}/reply', '/api/tasks/${id}/resume', '/api/tasks/${id}/cancel', '/api/approvals/${button.dataset.id}', "'/api/tasks'"]) assert.ok(source.includes(endpoint), endpoint);
  assert.doesNotMatch(source, /JSON\.stringify\((event|approval)\.(payload|arguments_preview)/, 'raw payloads are never printed');
  assert.doesNotMatch(source, /href="\$\{esc\(pr\.url\)\}"/, 'a PR link is rendered only after the https check');
  assert.match(source, /const httpsUrl = /);
  const deliverables = read('src/hub-ui/deliverables.js');
  for (const endpoint of ['/api/deliverables/review', '/api/deliverables/report', '/api/approvals/', '/api/conversations', '/api/projects/${id}/memory']) assert.ok(deliverables.includes(endpoint), endpoint);
  assert.match(deliverables, /reviewsOff/, 'unavailable curation is explained, not hidden');
  for (const css of ['deliverables.css', 'coding.css']) {
    const text = read(`src/hub-ui/${css}`);
    assert.deepEqual(text.match(/#[0-9a-f]{3,8}\b/gi) || [], [], `${css} uses design tokens only`);
    assert.match(text, /prefers-reduced-motion|max-width: 620px/, `${css} adapts to small screens or reduced motion`);
  }
});
