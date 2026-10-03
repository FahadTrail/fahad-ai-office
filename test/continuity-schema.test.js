// Coding Continuity Supervisor, Phase A: migration shape, security
// assumptions, scenario coverage and the state machine. The behaviour itself
// runs in supabase/verify/scenarios/coding_continuity.sql (schema replay test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canTransition, FAILURES, LIFECYCLE, nextStates, STATES } from '../src/continuity/states.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const sql = read('supabase/migrations/20261004090000_coding_continuity.sql');
const geminiSql = read('supabase/migrations/20261005090000_continuity_gemini_worker.sql');
const scenario = read('supabase/verify/scenarios/coding_continuity.sql');
const TABLES = ['coding_workers', 'coding_worker_sessions', 'coding_checkpoints', 'coding_leases', 'coding_handoffs', 'coding_usage_snapshots'];
const RPCS = ['acquire_coding_lease', 'heartbeat_coding_lease', 'save_continuity_checkpoint', 'release_coding_lease',
  'freeze_stale_coding_leases', 'reclaim_coding_lease', 'propose_handoff', 'accept_handoff'];

test('continuity migration: additive, six tables, RLS and service-role-only privileges', () => {
  for (const table of TABLES) assert.match(sql, new RegExp(`create table public\\.${table} \\(`), table);
  assert.doesNotMatch(sql, /\b(drop|truncate)\b|alter table public\.(?!%I)/i, 'no change to existing objects');
  // The applied 2026-09-22 POC owns continuity_checkpoints / continuity_handoffs; never touch them.
  assert.doesNotMatch(sql, /public\.continuity_/);
  const loop = sql.slice(sql.indexOf('-- ---------------------------------------------------------------- privileges'));
  for (const table of TABLES) assert.ok(loop.includes(`'${table}'`), `${table} in the RLS/grant loop`);
  assert.match(loop, /enable row level security/);
  assert.match(loop, /revoke all on table public\.%I from public, anon, authenticated, service_role/);
  assert.match(loop, /revoke all on function %s from public, anon, authenticated, service_role/);
  assert.doesNotMatch(sql, /grant [^;]* to (anon|authenticated|public)\b/i);
});

test('continuity migration: every RPC follows the project style and is granted to service_role only', () => {
  for (const name of RPCS) {
    const start = sql.indexOf(`create function public.${name}(`);
    assert.ok(start >= 0, name);
    const header = sql.slice(start, sql.indexOf('as $$', start));
    assert.match(header, /security invoker/, `${name} security invoker`);
    assert.match(header, /set search_path = ''/, `${name} empty search_path`);
    assert.match(sql, new RegExp(`'public\\.${name}\\(`), `${name} in the grant loop`);
  }
  assert.equal((sql.match(/create function /g) || []).length, RPCS.length);
});

test('continuity migration: one writer per branch, checkpoint guards, seven permanent workers', () => {
  assert.match(sql, /create unique index coding_leases_one_writer on public\.coding_leases \(repository, branch\) where status in \('ACTIVE', 'FROZEN'\)/);
  assert.match(sql, /unique \(session_id, sequence\)/);
  assert.match(sql, /payload->>'schema' = 'continuity\.checkpoint\.v1'/);
  assert.match(sql, /last_commit text not null check \(last_commit ~ '\^\[0-9a-f\]\{40\}\$'\)/);
  assert.match(sql, /next_exact_action text not null check \(length\(btrim\(next_exact_action\)\) between 1 and 2000\)/);
  assert.match(sql, /CODING_LEASE_CHECKPOINT_REQUIRED/);
  const seed = sql.slice(sql.indexOf('insert into public.coding_workers'), sql.indexOf('-- ---------------------------------------------------------------- sessions'));
  const rows = [...seed.matchAll(/\('([a-z-]+)', '[^']+', '(native|cli|manual)', '([a-z-]+)', (true|false)\)/g)]
    .map(([, key, kind, source, enabled]) => ({ key, kind, source, enabled: enabled === 'true' }));
  assert.deepEqual(rows.map((row) => row.key), ['office', 'claude-code', 'codex', 'antigravity', 'opencode', 'kilo', 'freebuff']);
  assert.deepEqual(rows.filter((row) => row.enabled).map((row) => row.key), ['office'], 'external workers start disabled');
  const source = Object.fromEntries(rows.map((row) => [row.key, row.source]));
  assert.equal(source.codex, 'openai-chatgpt');
  assert.equal(source.antigravity, 'google-ai-pro', 'Google AI Pro is not Gemini API capacity');
  // The Phase A seed deliberately holds no Gemini quota source: Antigravity's
  // Google AI Pro subscription must never be conflated with Gemini capacity.
  assert.ok(!Object.values(source).some((value) => /gemini/.test(value)));
  assert.equal(rows.find((row) => row.key === 'freebuff').kind, 'manual');
});

test('continuity migration: the Gemini CLI worker is data-only, disabled and has its own quota source', () => {
  // Data only: no schema objects change, so the schema fingerprint is untouched.
  assert.doesNotMatch(geminiSql, /\b(create|alter|drop)\s+(table|function|index|schema|type)\b/i);
  assert.doesNotMatch(geminiSql, /\btruncate\b/i);
  assert.match(geminiSql, /insert into public\.coding_workers/);
  const row = /\('([a-z-]+)', '[^']+', '(native|cli|manual)', '([a-z-]+)', (true|false)\)/.exec(geminiSql);
  assert.deepEqual(row && { key: row[1], kind: row[2], source: row[3], enabled: row[4] === 'true' },
    { key: 'gemini-cli', kind: 'cli', source: 'gemini-cli', enabled: false },
    'gemini-cli is a CLI worker, disabled at insert, with a quota source of its own');
  // The Gemini CLI's quota is not Google AI Pro (Antigravity) and not any
  // other worker's source: it must never be deduplicated against them.
  assert.notEqual(row[3], 'google-ai-pro');
  // The Phase A migration itself stays untouched.
  assert.ok(sql.includes("('freebuff', 'Freebuff', 'manual', 'freebuff', false);"));
});

test('continuity scenario covers the lease, checkpoint and handoff contract', () => {
  for (const check of ['eight permanent workers', 'only office starts enabled', 'gemini-cli has its own quota source',
    'gemini-cli starts disabled', 'second acquire on the same branch fails', 'wrong token heartbeat fails', 'valid heartbeat works',
    'release without checkpoint fails', 'checkpoints are sequenced', 'release with checkpoint works', 'one stale lease frozen',
    'frozen lease still blocks the branch', 'frozen lease reclaimed', 'handoff proposed', 'handoff accepted', 'secret material refused',
    'short commit refused', 'empty next action refused', 'accept waits for the release']) {
    assert.ok(scenario.includes(`'${check}'`), check);
  }
});

test('state machine: the locked lifecycle passes, everything else is refused', () => {
  assert.deepEqual(LIFECYCLE, ['STANDBY', 'ACQUIRING', 'ACTIVE', 'DRAINING', 'CHECKPOINTING', 'HANDOFF_READY', 'RELEASED']);
  assert.deepEqual(FAILURES, ['RATE_LIMITED', 'QUOTA_EXHAUSTED', 'AUTH_REQUIRED', 'UNAVAILABLE', 'FAILED', 'ABNORMAL_EXIT']);
  for (let i = 0; i < LIFECYCLE.length - 1; i += 1) assert.ok(canTransition(LIFECYCLE[i], LIFECYCLE[i + 1]), `${LIFECYCLE[i]} → ${LIFECYCLE[i + 1]}`);
  assert.ok(canTransition('CHECKPOINTING', 'COMPLETED'));
  for (const failure of FAILURES) {
    assert.ok(canTransition('ACTIVE', failure), `ACTIVE → ${failure}`);
    assert.ok(canTransition(failure, 'HANDOFF_READY'), `${failure} → HANDOFF_READY (recovery)`);
  }
  assert.ok(canTransition('RATE_LIMITED', 'ACTIVE'), 'rate limit is transient');
  for (const [from, to] of [['STANDBY', 'ACTIVE'], ['ACTIVE', 'RELEASED'], ['ACTIVE', 'HANDOFF_READY'], ['DRAINING', 'ACTIVE'],
    ['ACTIVE', 'COMPLETED'], ['QUOTA_EXHAUSTED', 'ACTIVE'], ['ABNORMAL_EXIT', 'ACTIVE'], ['RELEASED', 'ACTIVE'], ['COMPLETED', 'ACTIVE'],
    ['HANDOFF_READY', 'ACTIVE'], ['ACTIVE', 'ACTIVE'], ['NOPE', 'ACTIVE'], ['ACTIVE', 'NOPE'], ['toString', 'ACTIVE']]) {
    assert.equal(canTransition(from, to), false, `${from} → ${to}`);
  }
  for (const state of STATES) for (const next of nextStates(state)) assert.ok(STATES.includes(next));
  assert.deepEqual(nextStates('RELEASED'), []);
  // Every state is reachable from STANDBY.
  const seen = new Set(['STANDBY']);
  const queue = ['STANDBY'];
  while (queue.length) for (const next of nextStates(queue.shift())) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  assert.deepEqual([...seen].sort(), [...STATES].sort());
});

test('state machine: the database accepts exactly the same state names', () => {
  const check = sql.slice(sql.indexOf("status text not null default 'STANDBY' check (status in ("));
  const names = check.slice(0, check.indexOf('))')).match(/'([A-Z_]+)'/g).map((name) => name.slice(1, -1));
  assert.deepEqual([...new Set(names)].sort(), [...STATES].sort());
});
