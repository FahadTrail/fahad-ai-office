// Worker truthfulness (2026-10-09 audit): disabled or unconfigured adapters
// are never presented as working employees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { workerTruth } from '../src/hub-continuity.js';
import { workerGroups } from '../src/hub-ui/project.js';

// The production registry (coding_workers, 2026-10-09) as the API sees it with the Supervisor off.
const PRODUCTION = [
  { key: 'office', displayName: 'Fahad Office Coding Agent', kind: 'native', enabled: true, executionMode: 'DISABLED', authState: 'NOT_CONFIGURED', availability: 'SUPERVISOR_OFF', health: 'unknown', quotaSource: 'office-pools' },
  { key: 'claude-code', displayName: 'Claude Code', kind: 'cli', enabled: false, executionMode: 'EXECUTABLE', authState: 'NOT_AUTHENTICATED', availability: 'AUTH_REQUIRED', health: 'unknown' },
  { key: 'codex', displayName: 'OpenAI Codex', kind: 'cli', enabled: false, executionMode: 'EXECUTABLE', authState: 'CLI_NOT_INSTALLED', availability: 'CLI_NOT_FOUND', health: 'unknown' },
  { key: 'opencode', displayName: 'OpenCode', kind: 'cli', enabled: false, executionMode: 'EXECUTABLE', authState: 'NOT_CONFIGURED', availability: 'NOT_CONFIGURED', health: 'unknown' },
  { key: 'gemini-cli', displayName: 'Gemini CLI', kind: 'cli', enabled: false, executionMode: 'EXECUTABLE', authState: 'NOT_CONFIGURED', availability: 'NOT_CONFIGURED', health: 'unknown' },
  { key: 'antigravity', displayName: 'Google Antigravity', kind: 'cli', enabled: false, executionMode: 'DISABLED', authState: 'NOT_CONFIGURED', availability: 'SUPERVISOR_OFF', health: 'unknown' },
  { key: 'kilo', displayName: 'Kilo Code', kind: 'cli', enabled: false, executionMode: 'DISABLED', authState: 'NOT_CONFIGURED', availability: 'SUPERVISOR_OFF', health: 'unknown' },
  { key: 'freebuff', displayName: 'Freebuff', kind: 'manual', enabled: false, executionMode: 'MANUAL_ONLY', authState: 'NOT_CONFIGURED', availability: 'SUPERVISOR_OFF', health: 'unknown' },
];

test('production registry: one ACTIVE worker; nothing else claims it can execute or take handoffs', () => {
  const truth = Object.fromEntries(PRODUCTION.map((worker) => [worker.key, workerTruth(worker, { supervisorOn: false })]));
  assert.equal(truth.office.class, 'ACTIVE');
  assert.equal(truth.office.automaticHandoff, 'yes — Office development workstreams');
  for (const key of ['claude-code', 'codex', 'opencode', 'gemini-cli']) assert.equal(truth[key].class, 'DISABLED', key);
  for (const key of ['antigravity', 'kilo']) assert.equal(truth[key].class, 'EXPERIMENTAL', key);
  assert.equal(truth.freebuff.class, 'MANUAL_ONLY');
  const claimants = Object.entries(truth).filter(([, value]) => value.canExecuteNow || value.automaticHandoff !== 'no').map(([key]) => key);
  assert.deepEqual(claimants, ['office']);
  for (const [key, value] of Object.entries(truth)) if (key !== 'office') assert.equal(value.realQuota, 'unknown — never reported', `${key} claims no quota it never reported`);
});

test('an enabled external worker is ACTIVE only when verified and the Supervisor runs', () => {
  const claude = { kind: 'cli', enabled: true, executionMode: 'EXECUTABLE', authState: 'AUTHENTICATED', availability: 'OPERATIONAL' };
  assert.equal(workerTruth(claude, { supervisorOn: true }).class, 'ACTIVE');
  assert.equal(workerTruth(claude, { supervisorOn: false }).class, 'CONFIGURED_UNAVAILABLE');
  assert.equal(workerTruth(claude, { supervisorOn: false }).why, 'Continuity Supervisor is off.');
  const unauth = workerTruth({ ...claude, authState: 'NOT_AUTHENTICATED', availability: 'AUTH_REQUIRED' }, { supervisorOn: true });
  assert.deepEqual([unauth.class, unauth.authenticated, unauth.why], ['CONFIGURED_UNAVAILABLE', 'no', 'Not authenticated on the server.']);
  const reported = workerTruth({ ...claude, metrics: { latestUsage: { takenAt: '2026-10-08T10:00:00Z', weeklyPct: 40 } } }, { supervisorOn: true });
  assert.equal(reported.realQuota, 'reported 2026-10-08');
});

test('the Workers page groups by class, ACTIVE first, and answers the five questions', () => {
  const workers = PRODUCTION.map((worker) => ({ ...worker, truth: workerTruth(worker, { supervisorOn: false }) }));
  const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
  const html = workerGroups({ enabled: false, workers }, { esc, number: String, basis: () => '', pct: String, elapsed: String, highestPct: () => null, when: String });
  const order = [...html.matchAll(/class="worker-group" data-class="([A-Z_]+)"/g)].map((match) => match[1]);
  assert.deepEqual(order, ['ACTIVE', 'DISABLED', 'MANUAL_ONLY', 'EXPERIMENTAL']);
  assert.match(html, /Active — can take work now · 1/);
  for (const question of ['Can execute now', 'Authenticated', 'Enabled', 'Real quota', 'Automatic handoff from the Office']) assert.ok(html.includes(question), question);
  assert.doesNotMatch(html, /data-worker-action/, 'no enable buttons while the Supervisor is off');
});

test('new objectives go to the real project: archived or test projects never become the default again', async () => {
  const { defaultProject } = await import('../src/hub-ui/owner-facts.js');
  const real = { id: 'r', name: 'Fahad AI Office', status: 'active' };
  const cert = { id: 'c', name: 'CERTIFICATION V5.4 (test, safe to delete)', status: 'active' };
  const archived = { id: 'a', name: 'Old client', status: 'archived' };
  const client = { id: 'k', name: 'Qahwa Run', status: 'active' };
  assert.equal(defaultProject([cert, real], 'c').id, 'r', 'a remembered test project is not reused');
  assert.equal(defaultProject([archived, real], 'a').id, 'r', 'a remembered archived project is not reused');
  assert.equal(defaultProject([cert, real], 'deleted-id').id, 'r', 'a deleted project falls back to the real one');
  assert.equal(defaultProject([real, client], 'k').id, 'k', 'an explicitly chosen real project is kept');
  assert.equal(defaultProject([cert, client], null).id, 'k', 'without the Office project, the first real project');
  assert.equal(defaultProject([], null), null);
});
