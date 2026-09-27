#!/usr/bin/env node
// Visual QA: screenshots of the main Hub screens at desktop, laptop, tablet
// and mobile widths, light and dark, from the local preview (fictional data).
//
//   node tools/ui-screenshots.mjs <outDir> [label] [--only=office,center] [--theme=dark|light|both]
//
// Uses the Playwright install available on the machine (not a dependency).
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { startPreview } from './hub-preview.mjs';

const require = createRequire(join(execSync('npm root -g').toString().trim(), 'noop.js'));
const { chromium } = require('playwright');

const WS = '11111111-1111-4111-8111-111111111111';
export const SCREENS = {
  chief: '#/', office: '#/office', center: `#/project/${WS}`, employee: '#/agent/business-finance', coding: '#/agent/coding-agent',
  artifacts: '#/artifacts', attention: '#/attention', workflow: '#/workflow/b0000000-0000-4000-8000-000000000001',
  task: '#/task/e0000000-0000-4000-8000-000000000001', integrations: '#/integrations', chat: '#/chat/c0000000-0000-4000-8000-000000000001',
};
const VIEWPORTS = { desktop: [1440, 900], laptop: [1366, 768], tablet: [820, 1180], mobile: [390, 844] };

const [outDir = 'screenshots', label = 'shot', ...flags] = process.argv.slice(2);
const only = (flags.find((flag) => flag.startsWith('--only='))?.slice(7) || '').split(',').filter(Boolean);
const themeFlag = flags.find((flag) => flag.startsWith('--theme='))?.slice(8) || 'dark';
const sizes = (flags.find((flag) => flag.startsWith('--sizes='))?.slice(8) || 'desktop,mobile').split(',');
mkdirSync(outDir, { recursive: true });
const { server, url } = await startPreview({ port: 0 });
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const errors = [];
for (const theme of themeFlag === 'both' ? ['dark', 'light'] : [themeFlag]) {
  for (const size of sizes) {
    const [width, height] = VIEWPORTS[size];
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: 'reduce' });
    await context.addInitScript(([id, value]) => { localStorage.setItem('hub-workspace-id', id); localStorage.setItem('hub-theme', value); }, [WS, theme]);
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`${size}/${theme}: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`${size}/${theme}: ${message.text()}`); });
    for (const [name, hash] of Object.entries(SCREENS)) {
      if (only.length && !only.includes(name)) continue;
      await page.goto(`${url}${hash}`);
      await page.waitForTimeout(900);
      await page.screenshot({ path: join(outDir, `${label}-${name}-${size}-${theme}.png`), fullPage: size === 'mobile' ? false : true });
    }
    await context.close();
  }
}
await browser.close();
server.close();
console.log(errors.length ? `Console errors:\n${errors.join('\n')}` : 'No console errors.');
