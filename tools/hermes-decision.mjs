#!/usr/bin/env node
// Turns the output of `sudo bash ops/hermes-audit.sh` into ONE decommission
// decision. Read-only: it parses text and prints a plan; it never touches
// Hermes, the server or the network.
//
//   node tools/hermes-decision.mjs hermes-audit.txt [--telegram-live]
//
// READY only when every Hermes capability found in the audit has a proven
// Office replacement. Even then nothing is deleted: the printed plan is for
// Fahad's single final approval, reversible steps first.
import { readFileSync } from 'node:fs';

export function parseAudit(text) {
  const sections = {};
  let current = null;
  for (const line of String(text || '').split('\n')) {
    const header = line.match(/^== (.+) ==$/);
    if (header) { current = header[1]; sections[current] = []; continue; }
    if (current && line.trim() && line.trim() !== '(none)') sections[current].push(line.replace(/\s+$/, ''));
  }
  const pick = (prefix) => Object.entries(sections).filter(([name]) => name.startsWith(prefix)).flatMap(([, lines]) => lines);
  const containers = pick('Containers').map((line) => line.split('|')[0]).filter(Boolean);
  const envNames = [...new Set(Object.entries(sections).filter(([name]) => name.startsWith('Container ')).flatMap(([, lines]) => lines)
    .filter((line) => /^\s{2}[A-Z][A-Z0-9_]{1,80}$/.test(line)).map((line) => line.trim()))];
  const routes = pick('Container ').filter((line) => /traefik\..*\.rule=/.test(line)).map((line) => line.trim());
  return {
    containers, envNames, routes,
    images: pick('Images'), volumes: pick('Volumes'), networks: pick('Networks'),
    units: pick('systemd units'), cron: pick('Cron entries'), directories: pick('Directories'), sockets: pick('Listening sockets'),
    officeEnvMentionsHermes: pick('Separation check').some((line) => /WARNING/.test(line)),
  };
}

// Capabilities a Hermes install may provide, how to recognise them, and the
// Office replacement that must be proven first.
const CAPABILITIES = [
  { id: 'telegram', label: 'Telegram assistant', match: (a) => a.envNames.some((name) => /TELEGRAM/.test(name)), replacement: 'Office Telegram → CHIEF (src/channels/telegram.js)', proven: (opts) => opts.telegramLive },
  { id: 'whatsapp', label: 'WhatsApp assistant', match: (a) => a.envNames.some((name) => /WHATSAPP|TWILIO/.test(name)), replacement: 'Office channel bridge (WhatsApp adapter not built yet)', proven: () => false },
  { id: 'schedules', label: 'Scheduled jobs', match: (a) => a.cron.length > 0 || a.units.some((unit) => /\.timer/.test(unit)), replacement: 'Office scheduled jobs (to build if needed)', proven: () => false },
  { id: 'web', label: 'Public web routes', match: (a) => a.routes.length > 0, replacement: 'Hub routes on HUB_PUBLIC_HOST (per route)', proven: () => false },
  { id: 'data', label: 'Persistent data', match: (a) => a.volumes.length > 0 || a.directories.length > 0, replacement: 'Export agreed with Fahad (no automatic migration)', proven: (opts) => opts.dataExported },
  { id: 'models', label: 'Model/API usage', match: (a) => a.envNames.some((name) => /(OPENAI|ANTHROPIC|GEMINI|GROQ|OPENROUTER|DEEPSEEK)_/.test(name)), replacement: 'Office Model Pool (own credentials, never shared)', proven: () => true },
];

export function decide(audit, opts = {}) {
  const found = CAPABILITIES.filter((capability) => capability.match(audit))
    .map((capability) => ({ id: capability.id, label: capability.label, replacement: capability.replacement, proven: Boolean(capability.proven(opts)) }));
  const nothingFound = !audit.containers.length && !audit.units.length && !audit.cron.length && !audit.directories.length && !audit.volumes.length;
  const blockers = [
    ...found.filter((capability) => !capability.proven).map((capability) => `${capability.label}: replacement not proven (${capability.replacement})`),
    ...(audit.officeEnvMentionsHermes ? ['The Office .env mentions Hermes: separate the credentials first'] : []),
  ];
  const ready = !nothingFound && blockers.length === 0;
  const plan = ready ? [
    ...audit.containers.map((name) => `docker stop ${name}   # reversible: docker start ${name}`),
    'Observe 7 days: Office Telegram/Hub/jobs healthy, nobody missed Hermes',
    ...audit.volumes.map((name) => `docker run --rm -v ${name}:/v -v /root/hermes-backup:/b alpine tar czf /b/${name}.tgz -C /v .   # backup`),
    ...audit.containers.map((name) => `docker rm ${name}`),
    ...audit.units.map((unit) => `systemctl disable --now ${unit.split(/\s+/)[0]}`),
    'Remove Hermes Traefik routes/DNS only after the 7-day observation',
  ] : [];
  return {
    decision: nothingFound ? 'NOTHING TO DECOMMISSION FOUND (check the audit ran as root on the right host)' : ready ? 'HERMES READY FOR FINAL DECOMMISSION' : 'NOT READY',
    inventory: { containers: audit.containers, envNames: audit.envNames, routes: audit.routes, volumes: audit.volumes, units: audit.units, cron: audit.cron, directories: audit.directories },
    capabilities: found, blockers, plan,
    note: 'Nothing is executed. The plan needs Fahad\'s single final approval.',
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node tools/hermes-decision.mjs hermes-audit.txt [--telegram-live] [--data-exported]'); process.exit(1); }
  const result = decide(parseAudit(readFileSync(file, 'utf8')), { telegramLive: process.argv.includes('--telegram-live'), dataExported: process.argv.includes('--data-exported') });
  console.log(JSON.stringify(result, null, 2));
}
