#!/usr/bin/env node
// OmniRoute provider harvesting (Capacity V2, Part 4).
//
// OmniRoute (MIT) keeps a large, auto-generated provider catalog. We use it as
// a DISCOVERY source only — never as a gateway and never as proof of a quota:
// every candidate it surfaces still needs the provider's own terms, a key the
// owner creates, a canary and qualification before it can serve work.
//
// The harvest reads the two published Markdown references and classifies each
// provider with the Fahad policy (Part 10: no consumer logins, no cookies, no
// reverse-engineered web apps; supported APIs with API keys only).
//
//   node tools/omniroute-harvest.mjs [--json] [--only=candidate]
//
// Network: raw.githubusercontent.com (GitHub). Nothing is written anywhere.

const BASE = 'https://raw.githubusercontent.com/diegosouzapw/OmniRoute/main/docs/reference/';

// Section heading → auth method (from PROVIDER_REFERENCE.md categories).
const SECTIONS = [
  [/^## No-auth/i, 'no-auth'], [/^## OAuth/i, 'oauth'], [/^## Web Cookie/i, 'web-cookie'], [/^## API Key/i, 'api-key'],
  [/^## Local/i, 'local'], [/^## Search/i, 'search'], [/^## Audio/i, 'audio'], [/^## Upstream Proxy/i, 'upstream-proxy'],
  [/^## Cloud Agent/i, 'cloud-agent'], [/^## System/i, 'system'],
];

// Policy verdicts, most restrictive first.
export const VERDICTS = Object.freeze({
  REJECTED_CONSUMER_LOGIN: 'Consumer subscription/CLI/OAuth login reused as an API (forbidden).',
  REJECTED_WEB_SCRAPING: 'Web-cookie or reverse-engineered web app (forbidden).',
  REJECTED_TOS: 'Provider terms forbid this use (OmniRoute ToS flag "avoid").',
  NOT_APPLICABLE: 'Local, search, audio, system or proxy entry — not a hosted LLM capacity pool.',
  NO_RECURRING_FREE: 'API key provider without a recurring free allowance (paid or one-time credits).',
  CANDIDATE: 'Supported API-key access with a recurring free allowance — review terms, then owner key + canary.',
});

// Minimal Markdown table reader: rows under a heading, cells trimmed.
export function parseTables(markdown) {
  const rows = [];
  let section = null;
  let header = null;
  for (const line of String(markdown || '').split('\n')) {
    if (line.startsWith('## ')) { section = SECTIONS.find(([pattern]) => pattern.test(line))?.[1] || null; header = null; continue; }
    if (!line.startsWith('|')) { header = null; continue; }
    const cells = line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    if (!header) { header = cells.map((cell) => cell.toLowerCase()); continue; }
    rows.push({ section, cells: Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ''])) });
  }
  return rows;
}

const idOf = (cell) => String(cell || '').replace(/`/g, '').trim();

// Recurring free allowance wording in the catalog note (conservative).
const RECURRING = /(\bper (day|month|minute)\b|\/day|\/month|\bdaily\b|\bmonthly\b|\bRPD\b|\bRPM\b|tokens\/day|free tier|free plan|free models?|:free)/i;
const ONE_TIME = /(signup|sign-up|on signup|trial|one-time|lifetime top-up|credits on sign)/i;
// The note itself says the free access ended or cannot be relied on.
const ENDED = /(paused|revoked|ended|discontinued|no recurring|pay-as-you-go only|not a free|were not confirmed|not treated as a quota)/i;
const PERSONAL_ONLY = /(personal, educational or research use only|personal use only|do not use for com)/i;
const CONSUMER = /(CLI login|browser|cookie|session token|harvester|sign in with|oauth|consumer|reverse-engineered|playwright)/i;

// FREE_TIERS.md: provider → { freeType, steady, tos }.
export function freeTierIndex(markdown) {
  const index = new Map();
  for (const { cells } of parseTables(markdown)) {
    const id = idOf(cells.provider);
    if (!id || !cells['free type']) continue;
    index.set(id, { freeType: cells['free type'], steady: cells['steady tokens/mo'] || null, tos: cells.tos || null });
  }
  return index;
}

export function classify(entry, tiers = new Map()) {
  const tier = tiers.get(entry.id) || null;
  const note = entry.note || '';
  let verdict;
  if (['oauth'].includes(entry.auth) || (entry.auth === 'no-auth' && /login|sign.?in|CLI/i.test(note))) verdict = 'REJECTED_CONSUMER_LOGIN';
  else if (['web-cookie'].includes(entry.auth) || (entry.auth === 'no-auth' && /reverse-engineered|playground|websocket|playwright/i.test(note))) verdict = 'REJECTED_WEB_SCRAPING';
  else if (tier?.tos === 'avoid' || PERSONAL_ONLY.test(note)) verdict = 'REJECTED_TOS';
  else if (entry.auth === 'api-key' && CONSUMER.test(note)) verdict = 'REJECTED_CONSUMER_LOGIN';
  else if (entry.auth !== 'api-key') verdict = entry.auth === 'no-auth' ? 'REJECTED_WEB_SCRAPING' : 'NOT_APPLICABLE';
  else if (ENDED.test(note)) verdict = 'NO_RECURRING_FREE';
  else if (tier ? ['recurring', 'uncapped'].includes(tier.freeType) : (RECURRING.test(note) && !ONE_TIME.test(note))) verdict = 'CANDIDATE';
  else verdict = 'NO_RECURRING_FREE';
  return {
    id: entry.id, name: entry.name, auth: entry.auth, tags: entry.tags, website: entry.website, freeNote: note || null,
    freeType: tier?.freeType || null, steadyTokensPerMonth: tier?.steady || null, tos: tier?.tos || null,
    toolCalling: entry.toolCalling || null, verdict, reason: VERDICTS[verdict],
  };
}

export function harvest(referenceMarkdown, freeTiersMarkdown = '') {
  const tiers = freeTierIndex(freeTiersMarkdown);
  const seen = new Set();
  const out = [];
  for (const { section, cells } of parseTables(referenceMarkdown)) {
    const id = idOf(cells.id);
    if (!id || !section || seen.has(id)) continue;
    seen.add(id);
    const website = (String(cells.website || '').match(/\((https?:[^)]+)\)/) || [])[1] || null;
    out.push(classify({ id, name: cells.name || id, auth: section, tags: cells.tags || '', website, note: cells.notes || '', toolCalling: cells['tool calling'] || null }, tiers));
  }
  return out.toSorted((left, right) => Object.keys(VERDICTS).indexOf(right.verdict) - Object.keys(VERDICTS).indexOf(left.verdict) || left.id.localeCompare(right.id));
}

async function fetchText(name, fetchFn = fetch) {
  const response = await fetchFn(`${BASE}${name}`);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return response.text();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const only = args.find((arg) => arg.startsWith('--only='))?.slice(7).toUpperCase() || null;
  const [reference, tiers] = await Promise.all([fetchText('PROVIDER_REFERENCE.md'), fetchText('FREE_TIERS.md').catch(() => '')]);
  const results = harvest(reference, tiers).filter((entry) => !only || entry.verdict === only);
  if (args.includes('--json')) console.log(JSON.stringify(results, null, 2));
  else {
    const counts = results.reduce((all, entry) => ({ ...all, [entry.verdict]: (all[entry.verdict] || 0) + 1 }), {});
    console.log(`OmniRoute providers: ${results.length}`, counts);
    for (const entry of results.filter((item) => item.verdict === 'CANDIDATE')) {
      console.log(`- ${entry.id}: ${entry.freeType || '?'} ${entry.steadyTokensPerMonth || ''} tos=${entry.tos || '?'} — ${String(entry.freeNote || '').slice(0, 140)}`);
    }
  }
}
