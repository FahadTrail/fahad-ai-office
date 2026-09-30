// Core Final Lock alert watchdog: pure finding rules (no network, no credentials).
import test from 'node:test';
import assert from 'node:assert/strict';
import { alertText, findings, newFindings } from '../tools/ops-watch.mjs';

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
