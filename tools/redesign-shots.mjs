#!/usr/bin/env node
// Visual QA for the premium redesign: the four primary screens in light and
// dark at desktop and mobile widths (16 shots), plus the edge cases, from the
// local preview (fictional data, real Hub handlers; never Supabase).
//
//   node tools/redesign-shots.mjs <outDir> [--only=office,job] [--edge]
//
// Uses the Playwright install available on the machine (not a dependency).
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { startPreview } from './hub-preview.mjs';

const moduleRoot = process.env.PLAYWRIGHT_NODE_MODULES || execSync('npm root -g').toString().trim();
const require = createRequire(join(moduleRoot, 'noop.js'));
const { chromium } = require('playwright');

const WS = '11111111-1111-4111-8111-111111111111';
const job = (n) => `#/job/b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const PRIMARY = { office: '#/', job: job(2), archive: '#/archive', settings: '#/settings/approvals' };
export const EDGE = {
  'job-running': [job(1), 'history'], 'job-failed': [job(4), 'history'], 'job-cancelled': [job(5), 'history'], 'job-long-report': [job(6), 'history'],
  'job-planning': [job(7), 'history'], 'office-many': ['#/', 'history'], 'office-empty': ['#/', 'idle'], 'archive-history': ['#/archive', 'history'],
  'settings-team': ['#/settings/team', 'work'], 'settings-models': ['#/settings/models', 'work'], 'settings-coding': ['#/settings/coding', 'work'],
  'settings-health': ['#/settings/health', 'work'], 'settings-appearance': ['#/settings/appearance', 'work'], 'menu-open': ['#/', 'work', '#navMore > summary'],
  'employee-sheet': ['#/', 'work', '[data-employee]'], 'approval-confirm': ['#/settings/approvals', 'work', '[data-approval-decision="approved"]'],
  'english-office': ['#/', 'history', null, 'en'], 'english-job': [job(1), 'history', null, 'en'],
};
const VIEWPORTS = { desktop: [1440, 900], mobile: [390, 844] };

const [outDir = 'screenshots', ...flags] = process.argv.slice(2);
const only = (flags.find((flag) => flag.startsWith('--only='))?.slice(7) || '').split(',').filter(Boolean);
const edge = flags.includes('--edge');
mkdirSync(outDir, { recursive: true });
const previews = new Map();
const preview = async (moment) => { if (!previews.has(moment)) previews.set(moment, await startPreview({ port: 0, moment })); return previews.get(moment).url; };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const errors = [];
const overflow = [];

async function shoot({ name, hash, moment = 'history', click = null, language = 'ar', theme, size }) {
  const [width, height] = VIEWPORTS[size];
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: 'reduce' });
  await context.addInitScript(([id, value, lang]) => { localStorage.setItem('hub-workspace-id', id); localStorage.setItem('hub-theme', value); localStorage.setItem('hub-language', lang); }, [WS, theme, language]);
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(`${name}/${size}/${theme}: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error' && !/ERR_CERT_AUTHORITY_INVALID|localStorage|EventSource|status of 404/.test(message.text())) errors.push(`${name}/${size}/${theme}: ${message.text()}`); });
  await page.goto(`${await preview(moment)}${hash}`);
  await page.waitForTimeout(1200);
  if (click) { await page.locator(click).first().click(); await page.waitForTimeout(400); }
  const wide = await page.evaluate(() => {
    const view = document.querySelector('#view');
    return { doc: document.documentElement.scrollWidth > window.innerWidth + 1, view: view ? view.scrollWidth > view.clientWidth + 1 : false };
  });
  if (wide.doc || wide.view) overflow.push(`${name}/${size}/${theme}`);
  // The view is the scroller (the translucent bar overlays it): capture its full height.
  const full = await page.evaluate(() => document.querySelector('#view')?.scrollHeight || 0);
  if (full > height) await page.setViewportSize({ width, height: Math.min(full, 6000) });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(outDir, `${name}-${size}-${theme}.png`) });
  await context.close();
}

for (const [name, hash] of Object.entries(PRIMARY)) {
  if (only.length && !only.includes(name)) continue;
  for (const theme of ['light', 'dark']) for (const size of ['desktop', 'mobile']) await shoot({ name, hash, theme, size });
}
if (edge) {
  for (const [name, [hash, moment, click, language]] of Object.entries(EDGE)) {
    if (only.length && !only.includes(name)) continue;
    for (const size of ['desktop', 'mobile']) await shoot({ name, hash, moment, click, language, theme: size === 'desktop' ? 'light' : 'dark', size });
  }
}
await browser.close();
for (const { server } of previews.values()) server.close();
console.log(errors.length ? `Console errors:\n${errors.join('\n')}` : 'No console errors.');
console.log(overflow.length ? `Horizontal overflow:\n${overflow.join('\n')}` : 'No horizontal overflow.');
