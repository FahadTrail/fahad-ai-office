import test from 'node:test';
import assert from 'node:assert/strict';
import { supabaseSelfCheck, supabaseCheckEvent } from '../src/coding-agent/supabase-check.js';
import { capabilityView } from '../src/hub-office.js';

const TOKEN = 'sbp_testtoken0123456789abcdefghijklmnop';

test('the Supabase self-check is read-only, project-scoped and never records the token', async () => {
  const requests = [];
  const fetchFn = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
    return { ok: true, status: 200, text: async () => JSON.stringify([{ rows: [{ db_role: 'supabase_read_only_user', database: 'postgres' }] }]) };
  };
  const recorded = [];
  const report = await supabaseSelfCheck({ env: { CODING_SUPABASE_ACCESS_TOKEN: TOKEN }, fetchFn, record: async (entry) => recorded.push(entry) });
  assert.equal(report.ok, true);
  assert.equal(report.scope_enforced, true, 'a project outside the allowlist was refused without a request');
  assert.equal(report.write_blocked, true, 'a DELETE was refused without a request');
  assert.equal(report.db_role, 'supabase_read_only_user');
  assert.equal(requests.length, 1, 'exactly one network request');
  assert.match(requests[0].url, /\/v1\/projects\/zkzibipinjeswhdxnfgf\/database\/query\/read-only$/);
  assert.match(requests[0].body.query, /^select coalesce\(json_agg/);
  assert.equal(report.secret_exposed, false);
  assert.ok(!JSON.stringify(recorded).includes(TOKEN));
  assert.equal(supabaseCheckEvent(report).level, 'success');
});

test('missing token and failures are reported honestly', async () => {
  const missing = await supabaseSelfCheck({ env: {} });
  assert.deepEqual([missing.ok, missing.error_code, missing.token_present], [false, 'SUPABASE_TOKEN_MISSING', false]);
  const denied = await supabaseSelfCheck({ env: { CODING_SUPABASE_ACCESS_TOKEN: TOKEN },
    fetchFn: async () => ({ ok: false, status: 403, text: async () => `forbidden for ${TOKEN}` }) });
  assert.equal(denied.ok, false);
  assert.equal(denied.error_code, 'SUPABASE_HTTP_403');
  assert.ok(!JSON.stringify(denied).includes(TOKEN), 'the provider echo is redacted');
  const view = (check) => capabilityView({ supabaseCheck: check }).find((item) => item.id === 'supabase_tools');
  assert.equal(view({ ok: true, project: 'zkzibipinjeswhdxnfgf', db_role: 'r', checked_at: new Date().toISOString(), token_present: true }).status, 'Connected');
  assert.equal(view(denied).status, 'Configured — not verified');
  assert.equal(view(missing).status, 'Not configured');
});
