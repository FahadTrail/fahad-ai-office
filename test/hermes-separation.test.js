import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, parseAudit, renderDecision } from '../tools/hermes-decision.mjs';

const files = (dir) => readdirSync(dir).flatMap((name) => { const path = join(dir, name); return statSync(path).isDirectory() ? files(path) : [path]; });

test('no Office module depends on Hermes: every mention is a guard', () => {
  const guards = new Set(['src/coding-agent/policy.js', 'src/coding-agent/controller.js', 'src/coding-agent/prompts.js', 'src/coding-agent/tools.js', 'src/office/web-tools.js', 'src/hub-ui/app.js']);
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  for (const path of files(src)) {
    const text = readFileSync(path, 'utf8');
    const relative = `src/${path.slice(src.length).replaceAll('\\', '/')}`;
    if (/hermes/i.test(text)) assert.ok(guards.has(relative), `${relative} mentions Hermes`);
    assert.doesNotMatch(text, /from\s+['"][^'"]*hermes|process\.env\.HERMES|env\.HERMES_|HERMES_[A-Z_]*(URL|TOKEN|KEY|HOST)/i, `${relative} must not import Hermes or read Hermes settings`);
  }
  for (const path of files(fileURLToPath(new URL('../src/channels/', import.meta.url)))) assert.doesNotMatch(readFileSync(path, 'utf8'), /hermes/i, 'the Telegram path is Office-native');
});

const SAMPLE = `== Host ==
vps
== Containers (name | image | status | ports | compose project) ==
hermes-bot|hermes:latest|Up 3 days||hermes
== Container hermes-bot ==
Environment variable NAMES (values not shown):
  OPENAI_API_KEY
  TELEGRAM_BOT_TOKEN
Mounts (type source -> destination):
  volume /var/lib/docker/volumes/hermes_data/_data -> /data
Networks:
  hermes_default
Traefik / routing labels (names and host rules only):
Restart policy:
  unless-stopped
== Images ==
hermes:latest 300MB
== Volumes ==
hermes_data
== Networks ==
hermes_default
== systemd units ==
(none)
== Cron entries mentioning Hermes (owner and schedule only) ==
== Directories named like Hermes (top level: name, size, owner) ==
== Listening sockets owned by Hermes processes ==
(none found by process name)
== Separation check: Office paths that mention Hermes (should be none) ==
  Office .env does not mention Hermes
`;

test('a supplied audit becomes one decision: NOT READY until the replacements are proven', () => {
  const audit = parseAudit(SAMPLE);
  assert.deepEqual(audit.containers, ['hermes-bot']);
  assert.deepEqual(audit.envNames, ['OPENAI_API_KEY', 'TELEGRAM_BOT_TOKEN']);
  const now = decide(audit);
  assert.equal(now.decision, 'NOT READY');
  assert.ok(now.blockers.some((line) => /Telegram assistant/.test(line)));
  assert.ok(now.blockers.some((line) => /Persistent data/.test(line)));
  assert.deepEqual(now.plan, [], 'no plan while not ready');
  const ready = decide(audit, { telegramLive: true, dataExported: true });
  assert.equal(ready.decision, 'HERMES READY FOR FINAL DECOMMISSION');
  assert.match(ready.plan[0], /^Back up: 1 data location/);
  assert.match(ready.plan[1], /^docker stop hermes-bot {3}# reversible/);
  assert.equal(ready.capabilities.find((item) => item.id === 'telegram').status, 'REPLACED BY OFFICE');
  assert.deepEqual(ready.credentials.revokeAfterRemoval, ['OPENAI_API_KEY', 'TELEGRAM_BOT_TOKEN']);
  assert.ok(ready.plan.findIndex((step) => /docker rm/.test(step)) > ready.plan.findIndex((step) => /Observe 7 days/.test(step)), 'removal only after observation');
  assert.equal(decide(parseAudit('== Host ==\nx\n')).decision.startsWith('NOTHING TO DECOMMISSION'), true);
});

const AUDIT_V2 = `${SAMPLE.replace('Traefik / routing labels (names and host rules only):\n', 'Traefik / routing labels (names and host rules only):\n  traefik.http.routers.h.rule=Host(`bot.example.com`)\n')}== Container hermes-cron ==
Environment variable NAMES (values not shown):
  PATH
== Volume sizes (persistent data) ==
  hermes_data  591M
== Containers attached to Hermes networks (an Office container here is a dependency) ==
  hermes_default: hermes-bot fahad-office-runtime
== Credential independence (shared NAMES only; values compared here, never printed) ==
  OPENAI_API_KEY: in both, same value: yes
  TELEGRAM_BOT_TOKEN: in both, same value: no
  (end)
`;

test('capabilities get one of four classes; shared credentials and Office dependencies block the decision', () => {
  const audit = parseAudit(AUDIT_V2);
  assert.deepEqual(audit.domains, ['bot.example.com']);
  assert.deepEqual(audit.officeOnHermesNetworks, ['fahad-office-runtime on hermes_default']);
  assert.deepEqual(audit.shared, [{ name: 'OPENAI_API_KEY', sameValue: true }, { name: 'TELEGRAM_BOT_TOKEN', sameValue: false }]);
  const first = decide(audit, { telegramLive: true, dataExported: true });
  const status = Object.fromEntries(first.capabilities.map((item) => [item.id, item.status]));
  assert.deepEqual(status, { telegram: 'REPLACED BY OFFICE', models: 'REPLACED BY OFFICE', web: 'MUST MIGRATE', data: 'REPLACED BY OFFICE', 'container:hermes-cron': 'UNKNOWN' });
  assert.equal(first.decision, 'NOT READY');
  assert.ok(first.blockers.some((line) => /fahad-office-runtime on hermes_default/.test(line)));
  assert.ok(first.blockers.some((line) => /OPENAI_API_KEY: the Office uses the SAME value/.test(line)));
  // Fahad marks the old web UI and the unknown container obsolete; the Office
  // is detached and gets its own key → ready, with one removal plan.
  const fixed = parseAudit(AUDIT_V2.replace(' fahad-office-runtime', '').replace('same value: yes', 'same value: no'));
  const ready = decide(fixed, { telegramLive: true, dataExported: true, obsolete: ['web', 'container:hermes-cron'] });
  assert.equal(ready.decision, 'HERMES READY FOR FINAL DECOMMISSION');
  assert.deepEqual(ready.obsolete, ['Public web routes', 'Container hermes-cron']);
  assert.ok(ready.plan.some((line) => /Remove Traefik routes\/DNS for: bot\.example\.com/.test(line)));
  assert.ok(ready.plan.indexOf(ready.plan.find((line) => /docker volume rm/.test(line))) > ready.plan.findIndex((line) => /Observe 7 days/.test(line)));
  const text = renderDecision(ready);
  assert.match(text, /^HERMES READY FOR FINAL DECOMMISSION/);
  assert.match(text, /Credentials to revoke\/rotate: OPENAI_API_KEY, TELEGRAM_BOT_TOKEN/);
  assert.match(text, /Backup\/rollback: done/);
});
