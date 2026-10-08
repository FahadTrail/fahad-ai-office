#!/usr/bin/env node
// Accessibility and RTL audit for the redesigned Office: axe-core (WCAG 2.1
// A/AA + best practice) over the real Hub and 3D Office with fictional
// preview data, in Arabic and English, by day and by night, with the agent
// panel, the handoffs list and the summary open, plus the simplified Office
// on a phone. Also checks keyboard reach and RTL mirroring.
//
//   AXE_SCRIPT=<path to axe.min.js> node tools/office-a11y.mjs [outDir]
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { startPreview } from './hub-preview.mjs';

const require = createRequire(join(execSync('npm root -g').toString().trim(), 'noop.js'));
const { chromium } = require('playwright');
const axe = readFileSync(process.env.AXE_SCRIPT || require.resolve('axe-core/axe.min.js'), 'utf8');
const outDir = process.argv[2] || 'office-a11y';
mkdirSync(outDir, { recursive: true });
const WS = '11111111-1111-4111-8111-111111111111';

const CASES = [
  { name: 'ar-day-overview', language: 'ar', light: 'light' },
  { name: 'ar-night-panel', language: 'ar', light: 'immersive', step: (page) => page.click('.o3d-label[data-key="finance"] .o3d-card') },
  { name: 'en-day-handoffs', language: 'en', light: 'light', step: (page) => page.click('.ov-view[data-view="handoffs"]') },
  { name: 'en-night-summary', language: 'en', light: 'immersive', step: (page) => page.click('#ovSummaryBtn') },
  { name: 'ar-day-departments-menu', language: 'ar', light: 'light', step: (page) => page.click('.ov-view[data-view="departments"]') },
  { name: 'ar-phone-simplified', language: 'ar', size: [390, 844], view: 'auto' },
];

const { server, url } = await startPreview({ port: 0 });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const results = [];
for (const shot of CASES) {
  const [width, height] = shot.size || [1440, 900];
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, hasTouch: Boolean(shot.size), isMobile: Boolean(shot.size) });
  await context.addInitScript(([id, language, light, view]) => {
    localStorage.setItem('hub-workspace-id', id); localStorage.setItem('hub-language', language); localStorage.setItem('hub-office-light-mode', light || 'auto');
    localStorage.setItem('hub-office-view', view); localStorage.setItem('hub-office-quality', 'light');
    document.addEventListener('DOMContentLoaded', () => { const style = document.createElement('style'); style.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }'; document.head.append(style); });
  }, [WS, shot.language, shot.light, shot.view || '3d']);
  const page = await context.newPage();
  await page.goto(`${url}#/office`);
  if (!shot.size) {
    await page.waitForFunction(() => window.__fahadOffice3d?.ready?.(), null, { timeout: 60_000 });
    await page.evaluate(() => window.__fahadOffice3d.ready());
    await page.waitForSelector('.o3d-label .o3d-card', { timeout: 30_000 });
  } else await page.waitForSelector('.station', { timeout: 30_000 });
  await page.waitForTimeout(1500);
  if (shot.step) { await shot.step(page); await page.waitForTimeout(1500); }
  await page.addScriptTag({ content: axe });
  const accessibility = await page.evaluate(async () => {
    const result = await window.axe.run(document.querySelector('.office'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } });
    return { version: window.axe.version, violations: result.violations.map((item) => ({ id: item.id, impact: item.impact, nodes: item.nodes.length, sample: item.nodes[0]?.html?.slice(0, 160) })), incomplete: result.incomplete.length };
  });
  // Keyboard: every label is reachable with Tab; RTL: the document, labels and panel mirror.
  const checks = await page.evaluate(() => {
    const office = document.querySelector('.office');
    const labels = [...document.querySelectorAll('.o3d-label:not([hidden]) .o3d-card')];
    const panel = document.querySelector('#ovPanel:not([hidden])')?.getBoundingClientRect();
    const stage = document.querySelector('#immersive')?.getBoundingClientRect();
    return {
      dir: office?.getAttribute('dir'), lang: document.documentElement.lang, renderer: window.__fahadOffice3d?.renderer?.()?.render || null,
      tabbableLabels: labels.filter((element) => element.tabIndex >= 0).length, labels: labels.length,
      panelSide: panel && stage ? (panel.left - stage.left < stage.right - panel.right ? 'start-left' : 'end-right') : null,
      stationButtons: document.querySelectorAll('#scene:not([hidden]) .station').length,
    };
  });
  await page.screenshot({ path: join(outDir, `${shot.name}.png`) });
  const serious = accessibility.violations.filter((item) => ['serious', 'critical'].includes(item.impact));
  results.push({ name: shot.name, ok: serious.length === 0, accessibility, checks });
  console.log(shot.name, serious.length ? 'SERIOUS' : 'ok', JSON.stringify(checks), accessibility.violations.map((item) => `${item.id}(${item.impact}×${item.nodes})`).join(' '));
  await context.close();
}
writeFileSync(join(outDir, 'a11y.json'), JSON.stringify(results, null, 2));
await browser.close(); server.close();
process.exitCode = results.every((entry) => entry.ok) ? 0 : 1;
