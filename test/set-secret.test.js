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

test('set-secret accepts current Google AI Studio auth keys (AQ.) and legacy AIza keys, and rejects look-alikes', { skip }, () => {
  // Fake values are assembled at runtime so no credential-shaped literal is committed.
  const body = 'Ab8RN6' + 'x9_Y-z'.repeat(8) + '.' + 'Q7w'.repeat(5);
  const authKey = ['AQ', body].join('.');
  const ok = run({ input: `${authKey}\n` });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.ok(ok.finalEnv.endsWith(`\nGEMINI_API_KEY=${authKey}\n`));
  assert.ok(!ok.stdout.includes(authKey) && !ok.stderr.includes(authKey), 'the value is never printed');

  const legacy = ['AIza', 'S'.repeat(35)].join('');
  assert.equal(run({ input: `${legacy}\n` }).status, 0, 'a restricted legacy AIza key is still accepted');
  assert.equal(run({ input: `  ${authKey}  \n` }).status, 0, 'surrounding spaces from copy/paste are ignored');

  for (const [value, why] of [
    ['AQ.short', 'too short'],
    [`AQ.${body} extra`, 'embedded space'],
    [`AQ.${body}"`, 'quote character'],
    [`AQ.${body}\\nHERMES_KEY=x`, 'escaped newline / injection attempt'],
    [`AQ..${body}`, 'empty first segment'],
    [`AQ.${'a'.repeat(600)}`, 'longer than any real key'],
    [['AIza', 'S'.repeat(20)].join(''), 'truncated legacy key'],
    [`XQ.${body}`, 'wrong prefix'],
  ]) {
    const result = run({ input: `${value}\n` });
    assert.equal(result.status, 1, why);
    assert.equal(result.finalEnv, BASE_ENV, `${why}: .env unchanged`);
    assert.ok(!result.stdout.includes(value.trim()) && !result.stderr.includes(value.trim()), `${why}: the rejected value is not echoed`);
    assert.match(result.stdout, /received \d+ characters; expected pattern/, `${why}: explains the expected format without the value`);
  }
});

test('set-secret accepts Model Studio workspace keys (sk-ws-) and legacy Qwen keys, and rejects look-alikes', { skip }, () => {
  // Fake values are assembled at runtime so no credential-shaped literal is committed.
  const workspaceKey = ['sk', 'ws', 'Ab3dE' + 'f9_G-h'.repeat(6)].join('-');
  const ok = run({ name: 'QWEN_API_KEY', input: `${workspaceKey}\n` });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.ok(ok.finalEnv.endsWith(`\nQWEN_API_KEY=${workspaceKey}\n`));
  assert.ok(!ok.stdout.includes(workspaceKey) && !ok.stderr.includes(workspaceKey), 'the value is never printed');
  assert.match(ok.commands, /up -d --no-deps runtime/);

  const legacy = ['sk', 'a1B2c3D4'.repeat(4)].join('-');
  assert.equal(run({ name: 'QWEN_API_KEY', input: `${legacy}\n` }).status, 0, 'legacy account keys are still accepted');

  for (const [value, why] of [
    [['sk', 'ws', 'short'].join('-'), 'workspace key too short'],
    [['sk', 'ws', 'x'.repeat(24) + ' y'].join('-'), 'embedded space'],
    [['sk', 'ws', 'x'.repeat(24) + ';rm'].join('-'), 'shell metacharacter'],
    [['sk', 'ab-cd'.repeat(6)].join('-'), 'legacy keys contain no hyphens'],
    [['sk', 'or', 'x'.repeat(30)].join('-').replace('sk-or-', 'sk-or_'), 'other provider shape'],
    [['pk', 'ws', 'x'.repeat(30)].join('-'), 'wrong prefix'],
    [['sk', 'ws', 'x'.repeat(300)].join('-'), 'absurdly long'],
  ]) {
    const result = run({ name: 'QWEN_API_KEY', input: `${value}\n` });
    assert.equal(result.status, 1, why);
    assert.equal(result.finalEnv, BASE_ENV, `${why}: .env unchanged`);
    assert.ok(!result.stdout.includes(value), `${why}: the value is never echoed`);
  }
});
