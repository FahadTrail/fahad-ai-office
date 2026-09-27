import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { decide, parseAudit } from '../tools/hermes-decision.mjs';

const files = (dir) => readdirSync(dir).flatMap((name) => { const path = join(dir, name); return statSync(path).isDirectory() ? files(path) : [path]; });

test('no Office module depends on Hermes: every mention is a guard', () => {
  const guards = new Set(['src/coding-agent/policy.js', 'src/coding-agent/controller.js', 'src/coding-agent/prompts.js', 'src/coding-agent/tools.js', 'src/office/web-tools.js', 'src/hub-ui/app.js']);
  const src = new URL('../src/', import.meta.url).pathname;
  for (const path of files(src)) {
    const text = readFileSync(path, 'utf8');
    const relative = `src/${path.slice(src.length)}`;
    if (/hermes/i.test(text)) assert.ok(guards.has(relative), `${relative} mentions Hermes`);
    assert.doesNotMatch(text, /from\s+['"][^'"]*hermes|process\.env\.HERMES|env\.HERMES_|HERMES_[A-Z_]*(URL|TOKEN|KEY|HOST)/i, `${relative} must not import Hermes or read Hermes settings`);
  }
  for (const path of files(new URL('../src/channels/', import.meta.url).pathname)) assert.doesNotMatch(readFileSync(path, 'utf8'), /hermes/i, 'the Telegram path is Office-native');
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
  assert.match(ready.plan[0], /^docker stop hermes-bot {3}# reversible/);
  assert.ok(ready.plan.findIndex((step) => /docker rm/.test(step)) > ready.plan.findIndex((step) => /Observe 7 days/.test(step)), 'removal only after observation');
  assert.equal(decide(parseAudit('== Host ==\nx\n')).decision.startsWith('NOTHING TO DECOMMISSION'), true);
});
