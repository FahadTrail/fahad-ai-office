import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Hub project creation is atomic and service-role-only with conservative policy cloning', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260925125200_hub_daily_use.sql', import.meta.url), 'utf8');
  assert.match(sql, /create function public\.create_hub_project\(p_name text\)/i);
  assert.match(sql, /security invoker/i);
  assert.match(sql, /revoke all on function public\.create_hub_project\(text\) from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.create_hub_project\(text\) to service_role/i);
  assert.match(sql, /least\(v_policy\.monthly_budget_usd, 0\.50\)/i);
  assert.match(sql, /least\(v_policy\.max_request_budget_usd, 0\.10\)/i);
  assert.match(sql, /provider in \('anthropic', 'deepseek'\)/i);
  assert.match(sql, /decision = 'auto'/i);
  assert.doesNotMatch(sql, /hermes|qwen|kimi|minimax|zhipu/i);
});
