import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const bash = process.env.OFFICE_TEST_BASH || 'bash';
const skip = process.platform === 'win32' && !process.env.OFFICE_TEST_BASH;
for (const scenario of ['success', 'build-failed', 'preflight-failed', 'startup-failed', 'unhealthy', 'timeout']) {
  test('deployment: ' + scenario, { skip }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'office-deploy-test-'));
    const app = dir.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase());
    try {
      for (const name of ['src', 'logs', '.deploy-repo/.git', '.deploy-repo/src']) mkdirSync(join(dir, name), { recursive: true });
      for (const name of ['db.js', 'chief.js', 'index.js', 'selftest.js', 'healthcheck.js']) {
        writeFileSync(join(dir, 'src', name), 'old-source');
        writeFileSync(join(dir, '.deploy-repo/src', name), 'new-source');
      }
      for (const name of ['package.json', 'package-lock.json']) {
        writeFileSync(join(dir, name), 'old-manifest');
        writeFileSync(join(dir, '.deploy-repo', name), 'new-manifest');
      }
      const mocks = `
id() { printf 'deploy\\n'; }
flock() { return 0; }
sleep() { :; }
git() { if [[ "$*" == *rev-parse* ]]; then printf '0123456789012345678901234567890123456789\\n'; fi; }
tee() { while IFS= read -r line; do printf '%s\\n' "$line" >> "$2"; printf '%s\\n' "$line"; done; }
sudo() {
  printf '%s\\n' "$*" >> '${app}/commands'
  if [[ "$*" == *'image tag fahad-ai-office/runtime:previous'* ]]; then touch '${app}/restored'; return 0; fi
  if [[ "$*" == *' build' && '${scenario}' == build-failed ]]; then return 1; fi
  if [[ "$*" == *' run --rm'* && '${scenario}' == preflight-failed ]]; then return 1; fi
  if [[ "$*" == *' up -d' && '${scenario}' == startup-failed && ! -f '${app}/restored' ]]; then return 1; fi
  if [[ "$*" == *' ps' ]]; then
    if [[ -f '${app}/restored' ]]; then printf 'fahad-office-runtime Up 10 seconds\\n';
    elif [[ '${scenario}' == unhealthy ]]; then printf 'fahad-office-runtime Up 10 seconds (unhealthy)\\n';
    elif [[ '${scenario}' == timeout ]]; then printf 'fahad-office-runtime Up 10 seconds (health: starting)\\n';
    else printf 'fahad-office-runtime Up 10 seconds (healthy)\\n'; fi
  fi
}
`;
      const source = readFileSync(new URL('../ops/deploy.sh', import.meta.url), 'utf8').replace('APP=/opt/fahad-ai-office', `APP='${app}'`);
      const script = join(dir, 'run.sh');
      writeFileSync(script, mocks + source);
      const result = spawnSync(bash, [script.replaceAll('\\', '/')], { encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, scenario === 'success' ? 0 : 1, result.stdout + result.stderr);
      const commands = readFileSync(join(dir, 'commands'), 'utf8');
      const switched = !['build-failed', 'preflight-failed'].includes(scenario);
      assert.equal(commands.includes(' up -d'), switched);
      assert.equal(readFileSync(join(dir, 'src/index.js'), 'utf8'), scenario === 'success' ? 'new-source' : 'old-source');
      assert.equal(readFileSync(join(dir, 'package-lock.json'), 'utf8'), scenario === 'success' ? 'new-manifest' : 'old-manifest');
      if (scenario === 'success') assert.match(result.stdout, /DEPLOYMENT SUCCESSFUL/);
      else if (switched) assert.match(result.stdout, /ROLLBACK SUCCEEDED/);
      else assert.match(result.stdout, /Running container was not replaced/);
      for (const line of commands.trim().split('\n')) assert.match(line, /^\/usr\/bin\/docker (compose -f .*\/docker-compose.yml |image tag fahad-ai-office\/runtime:)/);
    } finally {
      // This is the exact disposable directory created by this test only.
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
