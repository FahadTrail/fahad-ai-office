// The independent restore drill (supabase/verify/restore-drill.sh) against a
// local, password-protected stand-in for the production database: the drill
// must dump through a read-only snapshot, restore into its own scratch
// cluster, prove equal row counts and structure, keep no credential, and
// leave the source untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../', import.meta.url).pathname;

function postgresBin() {
  if (process.env.PGBIN) return process.env.PGBIN;
  const base = '/usr/lib/postgresql';
  if (!existsSync(base)) return null;
  const versions = readdirSync(base).filter((name) => existsSync(join(base, name, 'bin', 'initdb')) && existsSync(join(base, name, 'bin', 'pg_dump')));
  return versions.length ? join(base, versions.sort((a, b) => Number(a) - Number(b)).at(-1), 'bin') : null;
}

const PASSWORD = 'dr1ll p@ss:w/rd%';

const FIXTURE = join(root, 'testing/fixtures/restore-drill-source.sh');

test('the restore drill proves a complete, read-only, credential-free restore', { timeout: 300_000, skip: !postgresBin() && 'PostgreSQL binaries are unavailable' }, (t) => {
  const PGBIN = postgresBin();
  const src = mkdtempSync(join(tmpdir(), 'fahad-drill-src-'));
  const keep = join(src, 'kept');
  const port = String(40_000 + Math.floor(Math.random() * 20_000));
  const env = { ...process.env, PGBIN, DRILL_PASSWORD: PASSWORD };
  t.after(() => {
    spawnSync('bash', [FIXTURE, 'stop', src], { env });
    rmSync(src, { recursive: true, force: true });
  });
  const made = spawnSync('bash', [FIXTURE, 'start', src, port], { env, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);

  const url = `postgresql://postgres:${encodeURIComponent(PASSWORD)}@127.0.0.1:${port}/postgres`;
  const drill = spawnSync('bash', [join(root, 'supabase/verify/restore-drill.sh'), '--keep-dump', keep], {
    env: { ...process.env, PGBIN, PGSSLMODE: 'disable', RESTORE_SOURCE_URL: url }, encoding: 'utf8', timeout: 240_000,
  });
  const output = `${drill.stdout}\n${drill.stderr}`;
  assert.equal(drill.status, 0, output);
  assert.match(drill.stdout, /VERDICT\s+: PASS/);
  assert.match(drill.stdout, /restore errors\s+: 0/);
  assert.match(drill.stdout, /row-count mismatches: 0/);
  assert.match(drill.stdout, /structure mismatches: 0/);
  assert.match(drill.stdout, /tables\s+: [1-9]\d*/);
  // No credential in the report, and the kept dump is private.
  assert.ok(!output.includes(PASSWORD) && !output.includes(encodeURIComponent(PASSWORD)), 'the password never appears in the output');
  const dumps = readdirSync(keep);
  assert.equal(dumps.length, 1);
  assert.equal(statSync(join(keep, dumps[0])).mode & 0o777, 0o600);
  // The source is unchanged.
  const count = spawnSync('bash', [FIXTURE, 'count', src, port], { env, encoding: 'utf8' });
  assert.equal(count.stdout.trim(), '1');
});

test('the restore drill refuses a malformed source URI without doing anything', () => {
  const drill = spawnSync('bash', [join(root, 'supabase/verify/restore-drill.sh')], {
    env: { ...process.env, PGBIN: postgresBin() || '/nonexistent', RESTORE_SOURCE_URL: 'not-a-uri-with-secret-xyz' }, encoding: 'utf8',
  });
  assert.notEqual(drill.status, 0);
  assert.ok(!`${drill.stdout}${drill.stderr}`.includes('secret-xyz'), 'the rejected value is never echoed');
});
