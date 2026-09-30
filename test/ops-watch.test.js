// Core Final Lock alert watchdog: pure finding rules (no network, no credentials).
import test from 'node:test';
import assert from 'node:assert/strict';
import { alertText, findings, newFindings } from '../tools/ops-watch.mjs'; // re-exports src/ops/ops-watch.js

test('ops watch: paid calls, free-route incidents from Office and Coding, auth errors', () => {
  const all = findings({
    attempts: [{ id: 'b', provider: 'anthropic', model: 'claude-sonnet-5', cost_usd: 0.02 }, { id: 'a', provider: 'anthropic', model: 'claude-sonnet-5', cost_usd: '0.01' }, { id: 'c', provider: 'gemini', model: 'gemma', cost_usd: 0 }],
    events: [
      { id: 7, payload: { kind: 'free_route_incident', incident: 'paid_on_free_route', route: 'openrouter:x:free' } },
      { id: 'agent:9', payload: { code: 'FREE_ROUTE_INCIDENT', kind: 'free_route_model_mismatch', route: 'zai:glm' } },
      { id: 8, payload: { kind: 'model_escalation' } },
    ],
    statuses: [
      { provider: 'mistral', model: 'm', health: 'auth_error', last_error_code: 'CREDENTIAL_INVALID' },
      { provider: 'kimi', model: 'k', health: 'auth_error' },
      { provider: 'gemini', model: 'g', health: 'rate_limited' },
    ],
    configured: new Set(['mistral', 'gemini']),
  });
  const keys = all.map((item) => item.key);
  assert.deepEqual(keys, ['paid:a,b', 'incident:7', 'incident:agent:9', 'auth:mistral:m:CREDENTIAL_INVALID']);
  assert.match(all[0].text, /2 \(anthropic:claude-sonnet-5\), \$0\.0300/);
  assert.ok(all.every((item) => item.severity === 'high'));
});

test('ops watch: starvation, blocked sessions and a failing /healthz', () => {
  const all = findings({
    tasks: [{ id: 't1', title: 'Report', status: 'failed', wait_count: 48 }, { id: 't2', status: 'failed', wait_count: 3 }],
    sessions: [{ id: 's1', title: 'Fix CI', status: 'blocked', error_code: 'OWNER_INPUT' }],
    health: { ok: false, status: 502, at: '2026-09-30T10:14:00Z' },
  });
  assert.deepEqual(all.map((item) => item.key), ['starved:t1', 'blocked:s1:OWNER_INPUT', 'health:502:2026-09-30T10']);
  assert.deepEqual(findings({ health: { ok: true, status: 200 } }), []);
  assert.deepEqual(findings({}), []);
});

test('ops watch: only new findings are announced, with severity markers', () => {
  const items = [{ key: 'a', severity: 'high', text: 'A' }, { key: 'b', severity: 'medium', text: 'B' }];
  assert.deepEqual(newFindings(items, ['a']).map((item) => item.key), ['b']);
  assert.equal(alertText(items), 'Fahad AI Office — ops watch\n🔴 A\n🟠 B');
});

// A chainable stand-in for the Supabase client: each table answers with
// canned rows; the announced-alerts read is the events query on ops_watch_alert.
function fakeDb({ paid = [], announced = [], failAnnounced = false, failInsert = false } = {}) {
  const inserts = [];
  const db = {
    inserts,
    from(table) {
      const filters = [];
      const builder = {
        select() { return builder; }, gte() { return builder; }, gt() { return builder; }, eq() { return builder; }, in() { return builder; },
        contains(_column, value) { filters.push(value); return builder; },
        insert(row) { inserts.push(row); return Promise.resolve(failInsert ? { error: { message: 'denied' } } : { error: null }); },
        then(resolve) {
          if (table === 'model_attempts') return resolve({ data: paid, error: null });
          if (table === 'events' && filters.some((value) => value.kind === 'ops_watch_alert')) {
            return resolve(failAnnounced ? { data: null, error: { message: 'timeout' } } : { data: announced.map((keys) => ({ payload: { keys } })), error: null });
          }
          return resolve({ data: [], error: null });
        },
      };
      return builder;
    },
  };
  return db;
}
const PAID = [{ id: 'x1', provider: 'anthropic', model: 'claude-sonnet-5', cost_usd: 0.01 }];
const ENV = { TELEGRAM_BOT_TOKEN: 'bot-token-placeholder', TELEGRAM_OWNER_CHAT_ID: '42' };

test('ops watch run: records the alert, then sends it once; the next run sends nothing', async () => {
  const { runOpsWatch } = await import('../src/ops/ops-watch.js');
  const sent = [];
  const fetchFn = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; };
  const db = fakeDb({ paid: PAID });
  const first = await runOpsWatch([], { env: ENV, db, fetchFn, log: () => {}, pool: [] });
  assert.equal(first.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.chat_id, '42');
  assert.match(sent[0].body.text, /Paid model calls: 1/);
  assert.ok(!sent[0].body.text.includes('bot-token-placeholder'), 'no secret in the message');
  assert.deepEqual(db.inserts[0].payload, { kind: 'ops_watch_alert', keys: ['paid:x1'] });
  const again = await runOpsWatch([], { env: ENV, db: fakeDb({ paid: PAID, announced: [['paid:x1']] }), fetchFn, log: () => {}, pool: [] });
  assert.equal(again.sent, 0);
  assert.equal(sent.length, 1, 'no repeat');
});

test('ops watch run: a failed read or a failed record sends nothing (no alert loop)', async () => {
  const { runOpsWatch } = await import('../src/ops/ops-watch.js');
  let calls = 0;
  const fetchFn = async () => { calls += 1; return { ok: true, status: 200 }; };
  await assert.rejects(runOpsWatch([], { env: ENV, db: fakeDb({ paid: PAID, failAnnounced: true }), fetchFn, log: () => {}, pool: [] }), /read failed: timeout/);
  await assert.rejects(runOpsWatch([], { env: ENV, db: fakeDb({ paid: PAID, failInsert: true }), fetchFn, log: () => {}, pool: [] }), /nothing sent/);
  assert.equal(calls, 0);
  const dry = await runOpsWatch(['--dry-run'], { env: ENV, db: fakeDb({ paid: PAID }), fetchFn, log: () => {}, pool: [] });
  assert.deepEqual(dry, { sent: 0, dryRun: true });
  assert.equal(calls, 0);
});
