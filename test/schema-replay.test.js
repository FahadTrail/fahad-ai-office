import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../', import.meta.url);
const migrations = readdirSync(new URL('supabase/migrations/', root)).filter((name) => name.endsWith('.sql')).sort();

function postgresBin() {
  if (process.env.PGBIN) return process.env.PGBIN;
  const base = '/usr/lib/postgresql';
  if (!existsSync(base)) return null;
  const versions = readdirSync(base).filter((name) => existsSync(join(base, name, 'bin', 'initdb')));
  return versions.length ? join(base, versions.sort((a, b) => Number(a) - Number(b)).at(-1), 'bin') : null;
}

test('migration versions are unique, ordered and tracked by git', () => {
  const versions = migrations.map((name) => name.split('_')[0]);
  assert.equal(new Set(versions).size, versions.length);
  for (const version of versions) assert.match(version, /^\d{14}$/);
  const ignored = spawnSync('git', ['check-ignore', '--no-index', ...migrations.map((name) => `supabase/migrations/${name}`)], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(ignored.stdout.trim(), '', 'a migration file is hidden by .gitignore');
});

test('replaying every migration reproduces the recorded production schema', { skip: !postgresBin() && 'PostgreSQL server binaries are unavailable' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'fahad-schema-'));
  try {
    const out = join(dir, 'fingerprint.txt');
    const result = spawnSync('bash', ['supabase/verify/replay.sh', out], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PGBIN: postgresBin() }, timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const actual = readFileSync(out, 'utf8').trim().split('\n').sort();
    const expected = readFileSync(new URL('supabase/verify/schema-fingerprint.txt', root), 'utf8').trim().split('\n').sort();
    const missing = expected.filter((line) => !actual.includes(line));
    const extra = actual.filter((line) => !expected.includes(line));
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
