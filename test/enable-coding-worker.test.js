import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const skip = process.platform === 'win32' && 'bash-only operator script';
const TOKEN = 'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789';
const BASE_ENV = 'SUPABASE_URL=https://x.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=service-role-test\nANTHROPIC_API_KEY=sk-ant-test-1234567890';

function run({ env = BASE_ENV, input = `${TOKEN}\n` } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'enable-coding-worker-'));
  mkdirSync(join(dir, 'ops'));
  mkdirSync(join(dir, 'app'));
  writeFileSync(join(dir, 'app', '.env'), env);
  writeFileSync(join(dir, 'ops', 'install-deploy.sh'), `echo installed >> '${dir}/commands'\n`);
  const mocks = `
id() { [[ "$1" == -u ]] && printf '0\\n'; }
sleep() { :; }
docker() {
  printf 'docker %s\\n' "$*" >> '${dir}/commands'
  if [[ "$1" == inspect ]]; then printf 'healthy\\n'; fi
  if [[ "$1" == logs ]]; then printf 'sandbox mode: isolated; routable models: anthropic:claude-sonnet-5\\n'; fi
  return 0
}
`;
  const source = readFileSync(new URL('../ops/enable-coding-worker.sh', import.meta.url), 'utf8').replace('APP=/opt/fahad-ai-office', `APP='${dir}/app'`);
  writeFileSync(join(dir, 'ops', 'enable.sh'), mocks + source);
  const result = spawnSync('bash', [join(dir, 'ops', 'enable.sh')], { encoding: 'utf8', input, timeout: 15000 });
  const commands = existsSync(join(dir, 'commands')) ? readFileSync(join(dir, 'commands'), 'utf8') : '';
  const finalEnv = readFileSync(join(dir, 'app', '.env'), 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return { ...result, commands, finalEnv };
}

test('enable-coding-worker stores the token without printing it and starts only the worker', { skip }, () => {
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!result.stdout.includes(TOKEN) && !result.stderr.includes(TOKEN), 'the token is never printed');
  assert.match(result.finalEnv, new RegExp(`\\nCODING_GITHUB_TOKEN=${TOKEN}\\nCOMPOSE_PROFILES=coding\\n$`));
  assert.match(result.commands, /^installed$/m);
  assert.match(result.commands, /compose -f .*docker-compose\.yml --profile coding up -d --no-deps coding-worker/);
  assert.ok(!/up -d(?! --no-deps coding-worker)/.test(result.commands), 'the Office runtime is not restarted');
  assert.match(result.commands, /exec fahad-office-coding-worker node src\/coding-agent\/verify-isolation\.js/);
  const again = run({ env: result.finalEnv, input: '' });
  assert.equal(again.status, 0, 'idempotent');
  assert.equal(again.finalEnv, result.finalEnv, 'nothing is appended twice');
});

test('enable-coding-worker refuses broad or malformed tokens and incomplete configuration', { skip }, () => {
  for (const [env, input, why] of [
    [BASE_ENV, 'ghp_classicTokenWithTooMuchScope1234567890\n', 'classic tokens are refused'],
    [BASE_ENV, 'not-a-token\n', 'malformed input is refused'],
    ['SUPABASE_URL=https://x.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=k', `${TOKEN}\n`, 'no model provider key'],
    [`${BASE_ENV}\nCOMPOSE_PROFILES=other`, `${TOKEN}\n`, 'foreign compose profile left untouched'],
  ]) {
    const result = run({ env, input });
    assert.equal(result.status, 1, why);
    assert.ok(!result.commands.includes('up -d'), `${why}: nothing started`);
    assert.equal(result.finalEnv, env, `${why}: .env unchanged`);
    assert.equal(result.commands, '', `${why}: nothing installed or started`);
    assert.ok(!result.stdout.includes('ghp_') && !result.stdout.includes(TOKEN), `${why}: input not echoed`);
  }
});
