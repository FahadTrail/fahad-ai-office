import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

test('model-attempt migration is service-only, indexed, and stores no prompt content', () => {
  const file = readdirSync(new URL('../supabase/migrations/', import.meta.url))
    .find((name) => name.endsWith('_provider_neutral_model_gateway.sql'));
  assert.ok(file);
  const sql = readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8').toLowerCase();
  assert.match(sql, /create table public\.model_attempts/);
  assert.match(sql, /workspace_id uuid references public\.projects/);
  assert.match(sql, /alter table public\.model_attempts enable row level security/);
  assert.match(sql, /revoke all on table public\.model_attempts from public, anon, authenticated/);
  assert.match(sql, /grant select, insert, update on table public\.model_attempts to service_role/);
  assert.doesNotMatch(sql, /\b(prompt|response_body|secret_value|chain_of_thought)\s+(text|jsonb)/);
});
