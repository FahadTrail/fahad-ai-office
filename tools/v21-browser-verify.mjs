#!/usr/bin/env node
// Premium Office local-only browser and accessibility verification. Fictional preview
// rows pass through the real Hub handlers; nothing reaches production.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { startPreview } from './hub-preview.mjs';

const moduleRoot = process.env.PLAYWRIGHT_NODE_MODULES || execSync('npm root -g').toString().trim();
const require = createRequire(join(moduleRoot, 'noop.js'));
const { chromium } = require('playwright');
const axeSource = readFileSync(process.env.AXE_SCRIPT || require.resolve('axe-core/axe.min.js'), 'utf8');
const WS = '11111111-1111-4111-8111-111111111111';
const JOB = '#/job/b0000000-0000-4000-8000-000000000001';
const VIEWS = [['office', '#/'], ['job', JOB], ['archive', '#/archive'], ['approvals', '#/settings/approvals']];
const SIZES = { desktop: [1440, 900], mobile: [390, 844] };
const preview = await startPreview({ port: 0, moment: 'work' });
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const failures = [];
let axeViews = 0;
let flowChecks = 0;

const contextFor = async ({ size = 'desktop', theme = 'light', motion = 'reduce' } = {}) => {
  const [width, height] = SIZES[size];
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: motion });
  await context.addInitScript(([workspace, value]) => {
    localStorage.setItem('hub-workspace-id', workspace);
    localStorage.setItem('hub-language', 'ar');
    localStorage.setItem('hub-theme', value);
  }, [WS, theme]);
  return context;
};

for (const [name, hash] of VIEWS) for (const theme of ['light', 'dark']) for (const size of Object.keys(SIZES)) {
  const context = await contextFor({ size, theme });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !/EventSource|ERR_CERT|status of 404/.test(message.text())) errors.push(message.text()); });
  await page.goto(`${preview.url}${hash}`);
  await page.waitForTimeout(900);
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
  axeViews += 1;
  if (result.violations.length) failures.push(`${name}/${theme}/${size}: axe ${result.violations.map((item) => item.id).join(', ')}`);
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > window.innerWidth + 1, unnamed: [...document.querySelectorAll('button, a[href]')].filter((element) => !String(element.getAttribute('aria-label') || element.textContent || '').trim()).length }));
  if (layout.overflow) failures.push(`${name}/${theme}/${size}: horizontal document overflow`);
  if (layout.unnamed) failures.push(`${name}/${theme}/${size}: ${layout.unnamed} unnamed controls`);
  if (errors.length) failures.push(`${name}/${theme}/${size}: ${errors.join(' | ')}`);
  await context.close();
}

const context = await contextFor({ motion: 'no-preference' });
const page = await context.newPage();
await page.goto(`${preview.url}${JOB}`);
await page.waitForSelector('.workflow-map .map-node');
const edgeCount = await page.locator('.map-edge').count();
if (edgeCount < 1) failures.push('flow: the real dependency map has no recorded edge'); else flowChecks += 1;
const currentStage = await page.locator('.stage-stop[aria-current="step"]').count();
if (currentStage < 1) failures.push('flow: no current stage is exposed'); else flowChecks += 1;
const employeeNode = page.locator('.map-node[data-map-employee]').first();
await employeeNode.focus();
await employeeNode.click();
await page.waitForSelector('.sheet.open [role="dialog"]');
if (!(await page.locator('.sheet-title').textContent())) failures.push('flow: employee sheet has no title'); else flowChecks += 1;
await page.keyboard.press('Escape');
await page.waitForSelector('.sheet', { state: 'detached' });
if (await employeeNode.evaluate((node) => document.activeElement === node)) flowChecks += 1; else failures.push('flow: employee sheet did not restore focus');

await page.goto(`${preview.url}#/settings/approvals`);
const approve = page.locator('[data-approval-decision="approved"]').first();
await approve.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
if (await approve.count()) {
  await approve.click();
  await page.waitForSelector('dialog.app-dialog[open]');
  if ((await page.locator('dialog.app-dialog').textContent()).includes('موافقة')) flowChecks += 1; else failures.push('flow: contextual approval dialog copy is missing');
  await page.locator('dialog.app-dialog [value="cancel"]').click();
} else failures.push('flow: preview has no approval for the confirmation flow');

await page.goto(`${preview.url}${JOB}`);
await page.waitForSelector('#composerSlot');
await page.waitForTimeout(350);
const reply = page.locator('#replyText');
if (await reply.count()) {
  await reply.fill('متابعة محلية لاختبار الواجهة فقط');
  await page.locator('#replyForm').evaluate((form) => form.requestSubmit());
  await page.waitForURL(/#\/job\//);
  flowChecks += 1;
} else failures.push('flow: Reply & Continue composer is missing');

await page.goto(`${preview.url}#/`);
await page.waitForSelector('.living-dashboard');
if (await page.locator('.pulse-kpi').count() === 4) flowChecks += 1; else failures.push('flow: Living Dashboard KPI strip is incomplete');
if (await page.locator('.living-flow .flow-step').count()) flowChecks += 1; else failures.push('flow: Living Dashboard delegation flow is missing');
const dashboardEmployee = page.locator('[data-dashboard-employee]').first();
await dashboardEmployee.focus();
await dashboardEmployee.click();
await page.waitForSelector('.sheet.open [role="dialog"]');
await page.keyboard.press('Escape');
await page.waitForSelector('.sheet', { state: 'detached' });
if (await dashboardEmployee.evaluate((node) => document.activeElement === node)) flowChecks += 1; else failures.push('flow: dashboard employee sheet did not restore focus');
await page.locator('#goal').fill('اختبار محلي لخريطة التفويض في المعاينة');
await page.locator('#command').evaluate((form) => form.requestSubmit());
await page.waitForURL(/#\/job\//);
flowChecks += 1;

await context.close();
await browser.close();
preview.server.close();

if (failures.length) {
  console.error(`Premium Office verification failed (${failures.length}):\n${failures.map((item) => `- ${item}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Premium Office browser verification passed: ${axeViews} axe views, ${flowChecks} interaction checks, 0 violations, 0 console errors, 0 overflow.`);
}
