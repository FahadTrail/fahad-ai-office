#!/usr/bin/env node
// Turns the output of `sudo bash ops/hermes-audit.sh` into ONE decommission
// decision. Read-only: it parses text and prints a report; it never touches
// Hermes, the server or the network.
//
//   node tools/hermes-decision.mjs hermes-audit.txt [--telegram-live] [--data-exported]
//        [--obsolete web,schedules] [--json]
//
// Every capability found in the audit is classified as REPLACED BY OFFICE,
// MUST MIGRATE, NO LONGER NEEDED (Fahad said so with --obsolete) or UNKNOWN.
// READY only when nothing is MUST MIGRATE or UNKNOWN, no Office container
// depends on Hermes and no credential value is shared. Even then nothing is
// deleted: the plan waits for Fahad's single final approval.
import { readFileSync } from 'node:fs';

// The indented lines under one sub-heading of a "Container" section.
function block(lines, heading) {
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && !/^\s/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

export function parseAudit(text) {
  const sections = {};
  let current = null;
  for (const line of String(text || '').split('\n')) {
    const header = line.match(/^== (.+) ==$/);
    if (header) { current = header[1]; sections[current] = []; continue; }
    if (current && line.trim() && !['(none)', '(end)'].includes(line.trim())) sections[current].push(line.replace(/\s+$/, ''));
  }
  const pick = (prefix) => Object.entries(sections).filter(([name]) => name.startsWith(prefix)).flatMap(([, lines]) => lines);
  const perContainer = Object.entries(sections).filter(([name]) => name.startsWith('Container ')).map(([name, lines]) => ({
    name: name.slice('Container '.length),
    envNames: block(lines, /^Environment variable NAMES/).filter((line) => /^\s{2}[A-Za-z_][A-Za-z0-9_]{1,80}$/.test(line)).map((line) => line.trim()),
    routes: lines.filter((line) => /traefik\..*\.rule=/.test(line)).map((line) => line.trim()),
    mounts: lines.filter((line) => /^\s{2}(volume|bind) /.test(line)).map((line) => line.trim()),
  }));
  const containers = [...new Set([...pick('Containers (').map((line) => line.split('|')[0]).filter(Boolean), ...perContainer.map((entry) => entry.name)])];
  const fileRoutes = pick('Traefik file-provider').map((line) => line.trim());
  const routes = [...perContainer.flatMap((entry) => entry.routes), ...fileRoutes.filter((line) => /^Host/.test(line))];
  const shared = pick('Credential independence').map((line) => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*): in both, same value: (yes|no)/)).filter(Boolean)
    .map((match) => ({ name: match[1], sameValue: match[2] === 'yes' }));
  const officeOnHermesNetworks = pick('Containers attached to Hermes networks').flatMap((line) => {
    const [network, members = ''] = line.trim().split(/:\s*/);
    return members.split(/\s+/).filter((name) => /fahad|office/i.test(name)).map((name) => `${name} on ${network}`);
  });
  return {
    containers, perContainer, routes, shared, officeOnHermesNetworks,
    envNames: [...new Set(perContainer.flatMap((entry) => entry.envNames))].sort(),
    domains: [...new Set(routes.flatMap((rule) => [...rule.matchAll(/`([^`]+)`/g)].map((match) => match[1])))],
    images: pick('Images'), volumes: pick('Volumes'), volumeSizes: pick('Volume sizes').map((line) => line.trim()), networks: pick('Networks'),
    units: pick('systemd units'), cron: pick('Cron entries'), directories: pick('Directories'), sockets: pick('Listening sockets'),
    officeEnvMentionsHermes: pick('Separation check').some((line) => /WARNING/.test(line)),
  };
}

// Capabilities a Hermes install may provide, how to recognise them, and the
// Office replacement that must be proven first.
const CAPABILITIES = [
  { id: 'telegram', label: 'Telegram assistant', env: /TELEGRAM/, replacement: 'Office Telegram → CHIEF (src/channels/telegram.js)', proven: (opts) => opts.telegramLive },
  { id: 'whatsapp', label: 'WhatsApp assistant', env: /WHATSAPP|TWILIO/, replacement: 'none built (WhatsApp is out of scope)', proven: () => false },
  { id: 'models', label: 'Model/API usage', env: /(OPENAI|ANTHROPIC|GEMINI|GOOGLE|GROQ|OPENROUTER|DEEPSEEK|MISTRAL|QWEN|DASHSCOPE)_/, replacement: 'Office Model Pool (own credentials)', proven: () => true },
  { id: 'github', label: 'GitHub access', env: /^GITHUB_|^GH_/, replacement: 'Coding Agent GitHub tools (own token)', proven: () => true },
  { id: 'supabase', label: 'Supabase/database access', env: /SUPABASE|DATABASE_URL|POSTGRES/, replacement: 'Office Supabase project (own service key)', proven: () => true },
  { id: 'schedules', label: 'Scheduled jobs', match: (a) => a.cron.length > 0 || a.units.some((unit) => /\.timer/.test(unit)), replacement: 'none built (Office jobs can be scheduled when needed)', proven: () => false },
  { id: 'web', label: 'Public web routes', match: (a) => a.routes.length > 0, replacement: 'Hub routes on HUB_PUBLIC_HOST', proven: () => false },
  { id: 'data', label: 'Persistent data', match: (a) => a.volumes.length > 0 || a.directories.length > 0 || a.perContainer.some((entry) => entry.mounts.length), replacement: 'back up first, then rerun with --data-exported', proven: (opts) => opts.dataExported },
];
const INFRA_ENV = /^(PATH|HOME|HOSTNAME|TERM|LANG|LC_[A-Z]+|TZ|NODE_ENV|NODE_VERSION|YARN_VERSION|PYTHON[A-Z_]*|GPG_KEY|PIP_[A-Z_]+|PORT|HOST|DEBUG|LOG_LEVEL)$/;
const SECRET_NAME = /(TOKEN|KEY|SECRET|PASSWORD|PASS|CREDENTIAL|PRIVATE)/;

export function decide(audit, opts = {}) {
  const obsolete = new Set(opts.obsolete || []);
  const matches = (capability, env) => (capability.env ? env.some((name) => capability.env.test(name)) : capability.match(audit));
  const found = CAPABILITIES.filter((capability) => matches(capability, audit.envNames)).map((capability) => {
    const proven = Boolean(capability.proven(opts));
    const status = obsolete.has(capability.id) ? 'NO LONGER NEEDED' : proven ? 'REPLACED BY OFFICE' : 'MUST MIGRATE';
    return { id: capability.id, label: capability.label, status, replacement: capability.replacement };
  });
  // A Hermes container whose purpose cannot be recognised from its settings.
  for (const entry of audit.perContainer) {
    const recognised = CAPABILITIES.some((capability) => capability.env && entry.envNames.some((name) => capability.env.test(name))) || entry.routes.length;
    if (!recognised) found.push({ id: `container:${entry.name}`, label: `Container ${entry.name}`, status: obsolete.has(`container:${entry.name}`) ? 'NO LONGER NEEDED' : 'UNKNOWN', replacement: 'purpose not recognisable from names — Fahad decides' });
  }
  const nothingFound = !audit.containers.length && !audit.units.length && !audit.cron.length && !audit.directories.length && !audit.volumes.length;
  const sharedValues = audit.shared.filter((entry) => entry.sameValue).map((entry) => entry.name);
  const blockers = [
    ...found.filter((item) => item.status === 'MUST MIGRATE').map((item) => `${item.label}: replacement not proven (${item.replacement})`),
    ...found.filter((item) => item.status === 'UNKNOWN').map((item) => `${item.label}: ${item.replacement} (--obsolete ${item.id} if unused)`),
    ...audit.officeOnHermesNetworks.map((entry) => `Office dependency: ${entry} — detach it first`),
    ...sharedValues.map((name) => `${name}: the Office uses the SAME value as Hermes — give the Office its own credential first`),
    ...(audit.officeEnvMentionsHermes ? ['The Office .env mentions Hermes: separate the credentials first'] : []),
  ];
  const ready = !nothingFound && blockers.length === 0;
  const credentials = audit.envNames.filter((name) => SECRET_NAME.test(name) && !INFRA_ENV.test(name));
  const dataItems = [...(audit.volumeSizes.length ? audit.volumeSizes : audit.volumes), ...audit.perContainer.flatMap((entry) => entry.mounts.filter((mount) => /^bind /.test(mount))), ...audit.directories.map((line) => line.trim())];
  const plan = ready ? [
    ...(dataItems.length ? [`Back up: ${dataItems.length} data location(s) to /root/hermes-backup (volumes via tar, directories via tar)`] : []),
    ...audit.containers.map((name) => `docker stop ${name}   # reversible: docker start ${name}`),
    'Observe 7 days: Office Telegram/Hub/jobs healthy, nobody missed Hermes',
    ...audit.containers.map((name) => `docker rm ${name}`),
    ...audit.units.map((unit) => `systemctl disable --now ${unit.split(/\s+/)[0]}`),
    ...audit.images.map((line) => `docker image rm ${line.split(/\s+/)[0]}   # only if no other container uses it`),
    ...audit.volumes.map((name) => `docker volume rm ${name}   # only after the backup is verified`),
    ...audit.networks.map((name) => `docker network rm ${name}`),
    ...(audit.domains.length ? [`Remove Traefik routes/DNS for: ${audit.domains.join(', ')}`] : []),
    ...(credentials.length ? [`Revoke at each provider: ${credentials.join(', ')} (Hermes copies; the Office keeps its own)`] : []),
  ] : [];
  return {
    decision: nothingFound ? 'NOTHING TO DECOMMISSION FOUND (check the audit ran as root on the right host)' : ready ? 'HERMES READY FOR FINAL DECOMMISSION' : 'NOT READY',
    contains: { containers: audit.containers, images: audit.images, volumes: audit.volumeSizes.length ? audit.volumeSizes : audit.volumes, networks: audit.networks, domains: audit.domains, units: audit.units, cron: audit.cron, directories: audit.directories, envNames: audit.envNames },
    capabilities: found,
    migrated: found.filter((item) => item.status === 'REPLACED BY OFFICE').map((item) => `${item.label} → ${item.replacement}`),
    obsolete: found.filter((item) => item.status === 'NO LONGER NEEDED').map((item) => item.label),
    credentials: { revokeAfterRemoval: credentials, sharedNames: audit.shared.map((entry) => entry.name), sharedValues },
    backup: dataItems.length ? (opts.dataExported ? `done (${dataItems.join('; ')})` : `required first: ${dataItems.join('; ')}`) : 'no persistent data found',
    blockers, plan,
    note: 'Nothing is executed. The plan needs Fahad\'s single final approval.',
  };
}

export function renderDecision(result) {
  const list = (items) => (items.length ? items.join(', ') : 'none');
  const lines = [result.decision, '',
    `Contains: containers ${list(result.contains.containers)}; images ${list(result.contains.images)}; volumes ${list(result.contains.volumes)}; networks ${list(result.contains.networks)}; domains ${list(result.contains.domains)}; units ${list(result.contains.units)}; cron ${list(result.contains.cron)}`,
    ...result.capabilities.map((item) => `  ${item.status.padEnd(18)} ${item.label} — ${item.replacement}`),
    `Migrated: ${list(result.migrated)}`,
    `Obsolete: ${list(result.obsolete)}`,
    `Credentials to revoke/rotate: ${list(result.credentials.revokeAfterRemoval)}${result.credentials.sharedValues.length ? ` (SHARED with the Office: ${result.credentials.sharedValues.join(', ')})` : ''}`,
    `Backup/rollback: ${result.backup}; every stop is reversible until the 7-day observation ends`,
  ];
  if (result.blockers.length) lines.push('', 'Blockers:', ...result.blockers.map((line) => `  - ${line}`));
  if (result.plan.length) lines.push('', 'Will be removed (after ONE approval):', ...result.plan.map((line) => `  ${line}`));
  lines.push('', result.note);
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node tools/hermes-decision.mjs hermes-audit.txt [--telegram-live] [--data-exported] [--obsolete id,id] [--json]'); process.exit(1); }
  const flag = process.argv.indexOf('--obsolete');
  const result = decide(parseAudit(readFileSync(file, 'utf8')), {
    telegramLive: process.argv.includes('--telegram-live'), dataExported: process.argv.includes('--data-exported'),
    obsolete: flag > 0 ? String(process.argv[flag + 1] || '').split(',').filter(Boolean) : [],
  });
  console.log(process.argv.includes('--json') ? JSON.stringify(result, null, 2) : renderDecision(result));
}
