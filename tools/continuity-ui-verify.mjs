#!/usr/bin/env node
// Browser-only QA against the fictional, loopback-only Hub preview. Nothing
// here reaches production or invokes a coding worker.
// PLAYWRIGHT_MODULE and AXE_SCRIPT may point to existing local installations.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { startPreview } from './hub-preview.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const axeSource = await readFile(process.env.AXE_SCRIPT || require.resolve('axe-core/axe.min.js'), 'utf8');
const workspace = '11111111-1111-4111-8111-111111111111';
const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = new Date().toISOString();
const { server, db, url } = await startPreview({ port: 0 });
db.tables.coding_workers = [
  { key: 'office', display_name: 'Fahad Office Coding Agent', kind: 'native', quota_source: 'office-pools', enabled: true, health: 'healthy' },
  { key: 'codex', display_name: 'OpenAI Codex', kind: 'cli', quota_source: 'openai-chatgpt', enabled: false, health: 'unknown' },
  { key: 'claude-code', display_name: 'Claude Code', kind: 'cli', quota_source: 'anthropic-claude-subscription', enabled: false, health: 'unknown' },
];
db.tables.coding_worker_sessions = [
  { id: sessionId, worker_key: 'office', project_id: workspace, repository: 'example/fictional', branch: 'preview/continuity', objective: 'Finish a fictional task without losing the diff.', status: 'ACTIVE', started_at: now, created_at: now, task_tokens: 42, tokens_basis: 'MEASURED' },
];
db.tables.coding_leases = [];
db.tables.coding_checkpoints = [
  { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', session_id: sessionId, sequence: 2, last_commit: '1234567890abcdef1234567890abcdef12345678', status: 'ACTIVE', next_exact_action: 'Write the next fictional test.', created_at: now },
];
db.tables.coding_handoffs = [];
db.tables.coding_usage_snapshots = [
  { id: 1, worker_key: 'office', quota_source: 'office-pools', session_id: sessionId, taken_at: now, session_pct: null, weekly_pct: null, task_tokens: 42, reset_at: null, basis: 'MEASURED' },
];

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined, headless: true });
const results = [];
try {
  for (const [width, height] of [[375, 667], [390, 844], [768, 1024], [1280, 720], [1440, 900]]) {
    for (const theme of ['light', 'dark']) {
      for (const motion of ['no-preference', 'reduce']) {
        const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: motion });
        await context.addInitScript(([id, value]) => { localStorage.setItem('hub-workspace-id', id); localStorage.setItem('hub-theme', value); }, [workspace, theme]);
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        // Show controls without starting a Supervisor or allowing POST actions.
        await page.route('**/api/continuity?**', async (route) => {
          const response = await route.fetch();
          await route.fulfill({ response, json: { ...(await response.json()), enabled: true } });
        });
        await page.goto(`${url}#/project/${workspace}/continuity`);
        await page.locator('.continuity-baton').waitFor();
        const layout = await page.evaluate(() => {
          const box = (node) => node.getBoundingClientRect();
          const controls = [...document.querySelectorAll('#ccBody button, .cc-switch a')];
          const clipped = controls.filter((node) => { const r = box(node); return r.left < -1 || r.right > innerWidth + 1 || r.width < 24 || r.height < 20; });
          const rows = [...document.querySelectorAll('.continuity-timeline li')].map(box);
          const overlap = rows.some((row, index) => index > 0 && row.top < rows[index - 1].bottom - 1);
          const unreadable = [...document.querySelectorAll('.continuity-metrics > div, .continuity-worker')].filter((node) => node.scrollWidth > node.clientWidth + 1);
          return { theme: document.documentElement.dataset.theme, overflow: document.documentElement.scrollWidth > innerWidth + 1, clipped: clipped.length, overlap, unreadable: unreadable.length, buttons: document.querySelectorAll('#ccBody button').length };
        });
        await page.addScriptTag({ content: axeSource });
        const accessibility = await page.evaluate(async () => {
          const result = await window.axe.run(document.querySelector('.cc'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } });
          return {
            version: window.axe.version,
            violations: result.violations.map((item) => ({ id: item.id, impact: item.impact, targets: item.nodes.map((node) => node.target) })),
            contrastIncomplete: result.incomplete.find((item) => item.id === 'color-contrast')?.nodes.length || 0,
          };
        });
        let focusOrder = null;
        let drawer = null;
        if (width === 390 && theme === 'light' && motion === 'no-preference') {
          const sidebar = page.locator('#sidebar');
          const closedInert = await sidebar.evaluate((element) => element.inert && element.getAttribute('aria-hidden') === 'true');
          await page.locator('#menuButton').click();
          const openFocus = await page.evaluate(() => document.activeElement?.id);
          const openExpanded = await page.locator('#menuButton').getAttribute('aria-expanded');
          await page.keyboard.press('Escape');
          const closedFocus = await page.evaluate(() => document.activeElement?.id);
          const closedAgain = await sidebar.evaluate((element) => element.inert && element.getAttribute('aria-hidden') === 'true');
          drawer = { closedInert, openFocus, openExpanded, closedFocus, closedAgain };
          await page.locator('.cc-tabs [aria-selected="true"]').focus();
          focusOrder = [];
          for (let i = 0; i < 3; i++) {
            await page.keyboard.press('Tab');
            focusOrder.push(await page.evaluate(() => ({ label: document.activeElement.textContent.trim(), visible: !!document.activeElement.getClientRects().length })));
          }
        }
        const ok = !errors.length && layout.theme === theme && !layout.overflow && !layout.clipped && !layout.overlap && !layout.unreadable && layout.buttons >= 3
          && !accessibility.violations.some((item) => ['critical', 'serious'].includes(item.impact))
          && (!focusOrder || focusOrder.every((item) => item.visible))
          && (!drawer || (drawer.closedInert && drawer.openFocus === 'sidebarClose' && drawer.openExpanded === 'true' && drawer.closedFocus === 'menuButton' && drawer.closedAgain));
        results.push({ viewport: `${width}x${height}`, theme, motion, ok, errors, layout, accessibility, focusOrder, drawer });
        await context.close();
      }
    }
  }
} finally { await browser.close(); server.close(); }

const failed = results.filter((item) => !item.ok);
console.log(JSON.stringify({ cases: results.length, passed: results.length - failed.length, failed: failed.length, axeVersion: results[0]?.accessibility.version, critical: results.flatMap((item) => item.accessibility.violations).filter((item) => item.impact === 'critical').length, serious: results.flatMap((item) => item.accessibility.violations).filter((item) => item.impact === 'serious').length, contrastIncomplete: Math.max(...results.map((item) => item.accessibility.contrastIncomplete)), focusOrder: results.find((item) => item.focusOrder)?.focusOrder, drawer: results.find((item) => item.drawer)?.drawer, failures: failed }, null, 2));
if (failed.length) process.exitCode = 1;
