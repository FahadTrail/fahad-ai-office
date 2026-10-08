#!/usr/bin/env node
// Visual QA for the redesigned Office ("Daylight Atrium"): renders the REAL
// Hub and 3D scene over the fictional preview data in headless Chromium
// (software WebGL) and saves the ten required design views plus renderer
// statistics (report.json).
//
//   node tools/office-shots.mjs <outDir> [--only=01-day-overview,...] [--size=1440x900] [--quality=high|balanced|light] [--stage]
//
// --stage crops each image to the 3D stage; otherwise the whole page.
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { startPreview } from './hub-preview.mjs';

const require = createRequire(join(execSync('npm root -g').toString().trim(), 'noop.js'));
const { chromium } = require('playwright');
const WS = '11111111-1111-4111-8111-111111111111';
const [outDir = 'shots-office', ...flags] = process.argv.slice(2);
const flag = (name) => flags.find((entry) => entry.startsWith(`--${name}=`))?.split('=')[1];
const only = (flag('only') || '').split(',').filter(Boolean);
const [width, height] = (flag('size') || '1440x900').split('x').map(Number);
const quality = flag('quality') || 'high';
const stageOnly = flags.includes('--stage');
const moment = flag('moment') || 'work';
mkdirSync(outDir, { recursive: true });

const view = (request) => (page) => page.evaluate((value) => window.__fahadOffice3d.view(value, { instant: true }), request);
const light = (mode) => (page) => page.evaluate((value) => window.__fahadOffice3d.lightMode(value), mode);
const both = (...steps) => async (page) => { for (const step of steps) await step(page); };

// The ten required design views (§15).
const SHOTS = {
  '01-day-overview': { steps: both(light('light'), view({ name: 'overview' })) },
  '02-night-overview': { steps: both(light('immersive'), view({ name: 'overview' })) },
  '03-chief-focus': { steps: both(light('light'), view({ name: 'chief' })) },
  '04-department': { steps: both(light('light'), view({ name: 'department', key: 'coding' })) },
  '05-agent': { steps: both(light('light'), view({ name: 'agent', key: 'finance' })) },
  '06-handoffs': { steps: both(light('immersive'), view({ name: 'handoffs' })) },
  '07-blocked': { moment: 'blocked', steps: both(light('light'), view({ name: 'department', key: 'legal' })) },
  '08-many-working': { moment: 'many', steps: both(light('light'), view({ name: 'overview' })) },
  '09-idle': { moment: 'idle', steps: both(light('auto'), view({ name: 'overview' })) },
  '10-executive': { steps: both(light('light'), view({ name: 'overview' }), (page) => page.evaluate(() => window.__fahadOffice3d.summary?.(true))) },
};

const previews = new Map();
const previewFor = async (name) => { if (!previews.has(name)) previews.set(name, await startPreview({ port: 0, moment: name })); return previews.get(name); };
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const report = {};
for (const [name, shot] of Object.entries(SHOTS)) {
  if (only.length && !only.includes(name)) continue;
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: shot.reducedMotion ? 'reduce' : 'no-preference' });
  await context.addInitScript(([id, q, m]) => {
    localStorage.setItem('hub-workspace-id', id); localStorage.setItem('hub-office-view', '3d'); localStorage.setItem('hub-office-quality', q);
    localStorage.setItem('hub-language', 'en'); window.__officePreviewMoment = m; localStorage.setItem('hub-office-watchdog', 'off');
  }, [WS, quality, shot.moment || moment]);
  const page = await context.newPage();
  // Software WebGL starves the main thread; CSS transitions would be caught mid-way.
  await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const style = document.createElement('style'); style.textContent = '*, *::before, *::after { transition: none !important; }'; document.head.append(style); }));
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (['error', 'warning'].includes(message.type()) && !/GPU stall|Automatic fallback|ReadPixels/.test(message.text())) errors.push(message.text()); });
  const started = Date.now();
  const { url } = await previewFor(shot.moment || moment);
  await page.goto(`${url}#/office`);
  await page.waitForSelector('.o3d-canvas', { timeout: 60_000 }).catch(() => errors.push('no canvas'));
  await page.waitForFunction(() => window.__fahadOffice3d?.ready?.(), null, { timeout: 60_000 }).catch(() => {});
  await page.evaluate(() => window.__fahadOffice3d.ready()).catch(() => {});
  const readyAt = Date.now() - started;
  try { await shot.steps(page); } catch (error) { errors.push(`step: ${error.message.split('\n')[0]}`); }
  await page.waitForTimeout(2500);
  const clip = stageOnly ? await page.evaluate(() => { const box = document.querySelector('#o3dStage')?.getBoundingClientRect(); return box && box.width > 10 ? { x: box.x, y: box.y, width: box.width, height: box.height } : null; }) : null;
  await page.screenshot({ path: join(outDir, `${name}.png`), timeout: 180_000, ...(clip ? { clip } : {}) });
  report[name] = { readyMs: readyAt, stats: await page.evaluate(() => window.__fahadOffice3d?.stats?.() || null).catch(() => null),
    overlay: await page.evaluate(() => ({ lightMode: document.querySelector('.ov-mode-btn[aria-pressed="true"]')?.dataset.light || null, view: document.querySelector('.ov-view[aria-pressed="true"]')?.dataset.view || null,
      labels: [...document.querySelectorAll('.o3d-label')].filter((element) => !element.hidden).map((element) => `${element.dataset.key}:${element.dataset.lod}`) })).catch(() => null), errors };
  console.log(name, JSON.stringify(report[name].stats), errors.length ? errors : '');
  await context.close();
}
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
await browser.close();
for (const preview of previews.values()) preview.server.close();
