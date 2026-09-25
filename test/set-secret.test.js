import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const skip = process.platform !== 'linux' && 'bash + GNU coreutils operator script';
const KEY = 'AIzaSyD-test0123456789abcdefghijklmnopq';
const BASE_ENV = 'SUPABASE_URL=https://x.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=service-role-test\nGEMINI_API_KEY=AIzaOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLD\nCOMPOSE_PROFILES=coding\n';

function run({ name = 'GEMINI_API_KEY', input = `${KEY}\n`, env = BASE_ENV } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'set-secret-'));
  mkdirSync(join(dir, 'ops'));
  mkdirSync(join(dir, 'app'));
  writeFileSync(join(dir, 'app', '.env'), env, { mode: 0o600 });
  const mocks = `
id() { [[ "$1" == -u ]] && printf '0\\n'; }
chown() { :; }
sleep() { :; }
docker() {
  printf 'docker %s\\n' "$*" >> '${dir}/commands'
  if [[ "$1" == inspect ]]; then printf 'healthy\\n'; fi
  return 0
}
`;
  const source = readFileSync(new URL('../ops/set-secret.sh', import.meta.url), 'utf8').replace('APP=/opt/fahad-ai-office', `APP='${dir}/app'`);
  writeFileSync(join(dir, 'ops', 'set.sh'), mocks + source);
  const result = spawnSync('bash', [join(dir, 'ops', 'set.sh'), name], { encoding: 'utf8', input, timeout: 15000 });
  const commands = existsSync(join(dir, 'commands')) ? readFileSync(join(dir, 'commands'), 'utf8') : '';
  const finalEnv = readFileSync(join(dir, 'app', '.env'), 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return { ...result, commands, finalEnv };
}

test('set-secret replaces one allowlisted credential without printing it and reloads only Office services', { skip }, () => {
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!result.stdout.includes(KEY) && !result.stderr.includes(KEY), 'the value is never printed');
  assert.equal(result.finalEnv, `SUPABASE_URL=https://x.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=service-role-test\nCOMPOSE_PROFILES=coding\nGEMINI_API_KEY=${KEY}\n`);
  assert.match(result.commands, /compose -f .*docker-compose\.yml --profile coding up -d --no-deps runtime coding-worker/);
  assert.doesNotMatch(result.commands, /hermes/i);
});

test('set-secret refuses unknown names and malformed values and changes nothing', { skip }, () => {
  for (const [name, input, why] of [
    ['SUPABASE_SERVICE_ROLE_KEY', `${KEY}\n`, 'the service-role key is not writable'],
    ['HERMES_API_KEY', `${KEY}\n`, 'Hermes credentials are never touched'],
    ['GEMINI_API_KEY', 'not-a-key\n', 'malformed value'],
    ['CODING_SUPABASE_ACCESS_TOKEN', 'sk-wrong-shape-0123456789012345\n', 'Supabase tokens start with sbp_'],
    ['', '', 'no name'],
  ]) {
    const result = run({ name, input });
    assert.equal(result.status, 1, why);
    assert.equal(result.finalEnv, BASE_ENV, `${why}: .env unchanged`);
    assert.ok(!result.commands.includes('up -d'), `${why}: nothing restarted`);
  }
  // Built at runtime so no credential-shaped literal is committed.
  const fakeToken = ['sbp', 'fake'.repeat(10)].join('_');
  const ok = run({ name: 'CODING_SUPABASE_ACCESS_TOKEN', input: `${fakeToken}\n` });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.ok(ok.finalEnv.endsWith(`\nCODING_SUPABASE_ACCESS_TOKEN=${fakeToken}\n`));
});
