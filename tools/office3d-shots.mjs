#!/usr/bin/env node
// Visual QA for the immersive Office: renders the real 3D scene over the
// fictional preview data in headless Chromium (software WebGL) and saves
// screenshots plus renderer stats.
//
//   node tools/office3d-shots.mjs <outDir> [--only=overview-light,...]
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { startPreview } from './hub-preview.mjs';

const require = createRequire(join(execSync('npm root -g').toString().trim(), 'noop.js'));
const { chromium } = require('playwright');
const WS = '11111111-1111-4111-8111-111111111111';
const [outDir = 'shots-3d', ...flags] = process.argv.slice(2);
const only = (flags.find((flag) => flag.startsWith('--only='))?.slice(7) || '').split(',').filter(Boolean);
mkdirSync(outDir, { recursive: true });

// name → { theme, size, mode, steps(page) }
const SHOTS = {
  'overview-light': { theme: 'light' },
  'overview-dark': { theme: 'dark' },
  'chief-focus': { theme: 'light', steps: (page) => page.click('.o3d-label[data-key="chief"]') },
  'coding-active': { theme: 'dark', steps: (page) => page.focus('.o3d-label[data-key="coding"]') },
  'creative-focus': { theme: 'light', steps: (page) => page.focus('.o3d-label[data-key="creative"]') },
  'handoff': { theme: 'light', steps: async (page) => { await page.click('.o3d-handoffs summary'); await page.waitForTimeout(200); await page.click('.o3d-handoff'); } },
  'project-mode': { theme: 'dark', steps: (page) => page.selectOption('#o3dProject', { index: 1 }) },
  'needs-fahad': { theme: 'light', steps: (page) => page.focus('.o3d-label[data-key="coding"]') },
  'fallback-light-office': { theme: 'light', mode: 'light' },
  'tablet-fallback': { theme: 'light', size: [820, 1180], mode: 'immersive' },
  'mobile-fallback': { theme: 'dark', size: [390, 844], mode: 'immersive' },
  'reduced-motion': { theme: 'light', reducedMotion: true, steps: (page) => page.focus('.o3d-label[data-key="finance"]') },
  'project-mode-2': { theme: 'light', steps: (page) => page.selectOption('#o3dProject', { index: 2 }) },
};

const { server, url } = await startPreview({ port: 0 });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const report = {};
for (const [name, shot] of Object.entries(SHOTS)) {
  if (only.length && !only.includes(name)) continue;
  const [width, height] = shot.size || [1440, 900];
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: shot.theme, reducedMotion: shot.reducedMotion ? 'reduce' : 'no-preference' });
  await context.addInitScript(([id, theme, mode]) => {
    localStorage.setItem('hub-workspace-id', id); localStorage.setItem('hub-theme', theme);
    localStorage.setItem('hub-office-mode', mode); localStorage.setItem('hub-office-quality', 'high');
  }, [WS, shot.theme, shot.mode || 'immersive']);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (['error', 'warning'].includes(message.type()) && !/ERR_CERT|localStorage|GPU stall|Automatic fallback/.test(message.text())) errors.push(message.text()); });
  const started = Date.now();
  await page.goto(`${url}#/office`);
  await page.waitForSelector(shot.mode === 'light' || width < 1100 ? '.station' : '.o3d-canvas', { timeout: 30_000 }).catch(() => {});
  const readyAt = Date.now() - started;
  await page.waitForTimeout(2500);
  if (shot.steps) { await shot.steps(page); await page.waitForTimeout(1800); }
  await page.screenshot({ path: join(outDir, `${name}.png`) });
  const metrics = await page.evaluate(() => ({
    mode: document.querySelector('.office')?.classList.contains('is-immersive') ? 'immersive' : 'light',
    stats: window.__fahadOffice3d?.stats?.() || null,
    heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    transferKb: Math.round(performance.getEntriesByType('resource').reduce((sum, entry) => sum + (entry.transferSize || 0), 0) / 1024),
  }));
  report[name] = { readyMs: readyAt, errors, ...metrics };
  await context.close();
}
await browser.close();
server.close();
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
