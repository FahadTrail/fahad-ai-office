import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const skip = process.platform !== 'linux' && 'bash + GNU coreutils operator script';
const SECRET = 'sk-ant-secret-value-1234567890';
const BASE_ENV = `SUPABASE_URL=https://x.supabase.co\nANTHROPIC_API_KEY=${SECRET}\nHUB_TRAEFIK_ENABLED=true\nHUB_PUBLIC_HOST=fahad-ai-office.srv1964598.hstgr.cloud\nCOMPOSE_PROFILES=coding\n`;

function run({ domain = 'office.trimedia.me', env = BASE_ENV, curlCode = '200' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'set-hub-domain-'));
  mkdirSync(join(dir, 'ops'));
  mkdirSync(join(dir, 'app'));
  writeFileSync(join(dir, 'app', '.env'), env, { mode: 0o600 });
  writeFileSync(join(dir, 'ops', 'install-deploy.sh'), `echo installed >> '${dir}/commands'\n`);
  const mocks = `
id() { [[ "$1" == -u ]] && printf '0\\n'; }
chown() { :; }
sleep() { :; }
curl() { printf 'curl %s\\n' "$*" >> '${dir}/commands'; printf '${curlCode}'; }
docker() {
  printf 'docker %s\\n' "$*" >> '${dir}/commands'
  if [[ "$1" == inspect ]]; then printf 'healthy\\n'; fi
  return 0
}
`;
  const source = readFileSync(new URL('../ops/set-hub-domain.sh', import.meta.url), 'utf8').replace('APP=/opt/fahad-ai-office', `APP='${dir}/app'`);
  writeFileSync(join(dir, 'ops', 'set.sh'), mocks + source);
  const result = spawnSync('bash', [join(dir, 'ops', 'set.sh'), domain], { encoding: 'utf8', timeout: 15000 });
  const commands = existsSync(join(dir, 'commands')) ? readFileSync(join(dir, 'commands'), 'utf8') : '';
  const finalEnv = readFileSync(join(dir, 'app', '.env'), 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return { ...result, commands, finalEnv };
}

test('set-hub-domain routes the new domain, keeps the old host, preserves every other line and restarts only the runtime', { skip }, () => {
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.finalEnv, `SUPABASE_URL=https://x.supabase.co\nANTHROPIC_API_KEY=${SECRET}\nHUB_TRAEFIK_ENABLED=true\nCOMPOSE_PROFILES=coding\nHUB_PUBLIC_HOST=office.trimedia.me\nHUB_EXTRA_PUBLIC_HOST=fahad-ai-office.srv1964598.hstgr.cloud\n`);
  assert.ok(!result.stdout.includes(SECRET) && !result.stderr.includes(SECRET), 'no secret is printed');
  assert.match(result.commands, /^installed$/m, 'the reviewed compose file is installed first');
  assert.match(result.commands, /compose -f .*docker-compose\.yml up -d --no-deps runtime\n/);
  assert.doesNotMatch(result.commands, /coding-worker|hermes/i, 'the worker and Hermes are untouched');
  assert.match(result.commands, /curl .*https:\/\/office\.trimedia\.me\/healthz/);
  assert.match(result.commands, /curl .*https:\/\/fahad-ai-office\.srv1964598\.hstgr\.cloud\/healthz/);
  const again = run({ env: result.finalEnv });
  assert.equal(again.status, 0, 'idempotent');
  assert.equal(again.finalEnv, result.finalEnv, 'a rerun keeps the previous extra host instead of duplicating the domain');
});

test('set-hub-domain refuses invalid or Hermes domains and reports an unreachable domain', { skip }, () => {
  for (const domain of ['', 'Office.Trimedia.me', 'office trimedia.me', 'hermes.trimedia.me', 'a;rm -rf /', 'localhost']) {
    const result = run({ domain });
    assert.equal(result.status, 1, `refused: ${JSON.stringify(domain)}`);
    assert.equal(result.finalEnv, BASE_ENV, 'nothing changed');
    assert.ok(!result.commands.includes('up -d'), 'nothing restarted');
  }
  const unreachable = run({ curlCode: '404' });
  assert.equal(unreachable.status, 1);
  assert.match(unreachable.stdout, /HTTP 404/);
});

test('the compose route serves the primary and the additional public host', () => {
  const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  assert.match(compose, /rule=Host\(`\$\{HUB_PUBLIC_HOST:-fahad-ai-office\.srv1964598\.hstgr\.cloud\}`\) \|\| Host\(`\$\{HUB_EXTRA_PUBLIC_HOST:-fahad-ai-office\.srv1964598\.hstgr\.cloud\}`\)/);
});
