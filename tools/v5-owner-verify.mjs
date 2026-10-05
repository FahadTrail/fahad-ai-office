// Owner interaction regression test. Loopback fixture only: no production,
// provider calls, server credentials or worker processes are used.
// PLAYWRIGHT_MODULE and PW_CHROMIUM may point at an existing installation.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { startPreview } from './hub-preview.mjs';
import { ownerWorkCounts } from '../src/hub-ui/owner-facts.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { server, db, url } = await startPreview({ port: 0 });
const originalRpc = db.rpc;
const decisions = [];
db.rpc = async (name, args) => {
  if (name === 'create_hub_project') {
    const project = { id: crypto.randomUUID(), name: args.p_name, description: '', default_repository: null };
    db.tables.projects.push(project);
    db.tables.workspace_policies.push({ workspace_id: project.id, enabled: true, monthly_budget_usd: 0, max_request_budget_usd: 0, spent_usd: 0, reserved_usd: 0 });
    return { data: project, error: null };
  }
  if (name === 'decide_agent_approval') {
    decisions.push(args);
    const approval = db.tables.agent_approvals.find((item) => item.id === args.p_approval);
    approval.status = args.p_decision;
    return { data: approval, error: null };
  }
  return originalRpc(name, args);
};
const browser = await chromium.launch({ headless: true, executablePath: process.env.PW_CHROMIUM || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir('/opt/cursor/artifacts', { recursive: true });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => { if (!localStorage.getItem('hub-workspace-id')) localStorage.setItem('hub-workspace-id', '11111111-1111-4111-8111-111111111111'); });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.locator('.owner-hero').waitFor();
  assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');
  const workspaceId = await page.locator('#projectSelect').inputValue();
  const read = (path) => page.evaluate(async (apiPath) => (await fetch(apiPath)).json(), path);
  const [jobData, taskData, office] = await Promise.all([
    read(`./api/jobs?workspaceId=${workspaceId}`),
    read(`./api/tasks?workspaceId=${workspaceId}`),
    read(`./api/office?workspaceId=${workspaceId}`),
  ]);
  const counts = ownerWorkCounts({ jobs: jobData.jobs, tasks: taskData.tasks, agents: office.agents });
  const employeesOnGoal = office.agents.filter((agent) => ['THINKING', 'WORKING', 'TESTING', 'REVIEWING'].includes(agent.state) && agent.assignment?.jobId && jobData.jobs.some((job) => job.id === agent.assignment.jobId && !['completed', 'failed', 'cancelled'].includes(job.status))).length;
  assert.ok(employeesOnGoal > 0, 'preview should have employees working on the active objective');
  assert.equal(await page.locator('[data-owner-objectives]').innerText(), String(counts.objectives));
  assert.notEqual(Number(await page.locator('[data-owner-objectives]').innerText()), counts.objectives + employeesOnGoal);
  assert.equal(await page.locator('#runningCount').innerText(), String(counts.running));
  const resultHrefs = await page.locator('[data-latest-result]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')));
  assert.ok(resultHrefs.length > 1);
  assert.equal(new Set(resultHrefs).size, resultHrefs.length, 'latest results must not repeat the same job or task');
  const healthLabel = await page.locator('[data-owner-health]').innerText();
  assert.notEqual(healthLabel, '0');
  assert.match(healthLabel, /سليمة|غير متاحة|غير مؤكدة|فيها خلل/);
  for (const cost of await page.locator('.owner-cost dd').allInnerTexts()) {
    if (cost.includes('غير متاح')) assert.equal(cost.includes('$'), false, cost);
  }
  await page.screenshot({ path: '/opt/cursor/artifacts/v5-home-mobile-ar.png', fullPage: true });
  await page.locator('#menuButton').click();
  await page.locator('[data-nav="projects"]').click();
  await page.locator('#createProject').click();
  await page.locator('dialog textarea').fill('V5 local owner smoke');
  await page.locator('dialog button[value="ok"]').click();
  await page.locator('.cc-hero h1').waitFor();
  assert.equal(await page.locator('.cc-hero h1').innerText(), 'V5 local owner smoke');
  const project = db.tables.projects.find((item) => item.name === 'V5 local owner smoke');
  assert.ok(project);
  await page.locator('#projectWork').waitFor();
  await page.locator('#ccBody a[href="#/new-work"]').click();
  await page.locator('#workGoal').fill('اكتب قائمة قصيرة لتنظيم المكتب، بدون أدوات أو تغييرات خارجية.');
  await page.locator('#workPriority').selectOption('high');
  const creation = page.waitForResponse((response) => response.url().endsWith('/api/jobs') && response.request().method() === 'POST');
  await page.locator('#submitWork').click();
  const response = await creation;
  assert.equal(response.status(), 201);
  assert.equal(response.request().postDataJSON().priority, 'high');
  const { job } = await response.json();
  await page.waitForURL(`**/#/job/${job.id}`);
  await page.getByText('وصل الطلب. ينتظر CHIEF والسعة المتاحة.').waitFor();
  assert.equal(db.tables.jobs.find((item) => item.id === job.id).project_id, project.id);
  // Emulate the worker's persisted completion, not an actual execution smoke.
  Object.assign(db.tables.jobs.find((item) => item.id === job.id), { status: 'completed', final_summary: 'نتيجة اختبار محلي محفوظة — ليست عملًا من الإنتاج.' });
  await page.reload();
  await page.getByText('نتيجة اختبار محلي محفوظة — ليست عملًا من الإنتاج.').waitFor();
  await page.locator('a[href="#/work"]').last().click();
  await page.locator(`a[href="#/job/${job.id}"]`).waitFor();
  const approval = { id: crypto.randomUUID(), workspace_id: project.id, session_id: crypto.randomUUID(), tool_name: 'test-only', action: 'fixture_decision', risk: 'low', summary: 'Local fixture approval — no external effect', arguments_preview: { repository: 'example/fixture', estimatedCostUsd: 0, token: 'MUST_NOT_DISPLAY' }, status: 'pending', requested_at: new Date().toISOString() };
  db.tables.agent_approvals.push(approval);
  await page.goto(`${url}#/attention`);
  await page.locator('[data-approval-decision="approved"]').waitFor();
  assert.ok(!(await page.locator('#view').innerText()).includes('MUST_NOT_DISPLAY'));
  await page.locator('[data-approval-decision="approved"]').click();
  await page.getByText('ما في إجراءات تنتظر موافقتك.').waitFor();
  assert.equal(decisions[0].p_decision, 'approved');
  assert.equal(decisions[0].p_approval, approval.id);
  const rejection = { ...approval, id: crypto.randomUUID(), status: 'pending', summary: 'Local rejection fixture' };
  db.tables.agent_approvals.push(rejection);
  await page.reload();
  await page.locator('[data-approval-decision="rejected"]').click();
  await page.locator('dialog textarea').fill('Not needed in this local test');
  await page.locator('dialog button[value="ok"]').click();
  await page.getByText('ما في إجراءات تنتظر موافقتك.').waitFor();
  assert.equal(decisions[1].p_decision, 'rejected');
  assert.equal(decisions[1].p_note, 'Not needed in this local test');
  await page.goto(`${url}#/settings`);
  await page.locator('[data-language="en"]').click();
  await page.getByRole('heading', { name: 'Settings & platform' }).waitFor();
  assert.equal(await page.locator('html').getAttribute('dir'), 'ltr');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.screenshot({ path: '/opt/cursor/artifacts/v5-settings-mobile-en.png', fullPage: true });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  await desktop.addInitScript(() => { if (!localStorage.getItem('hub-workspace-id')) localStorage.setItem('hub-workspace-id', '11111111-1111-4111-8111-111111111111'); });
  const wide = await desktop.newPage();
  wide.on('pageerror', (error) => errors.push(error.message));
  await wide.goto(url);
  await wide.locator('.owner-hero').waitFor();
  assert.equal(await wide.locator('[data-owner-objectives]').innerText(), String(counts.objectives));
  const cleared = wide.waitForFunction(() => document.querySelector('[data-owner-objectives]')?.textContent === '0' && document.querySelector('#runningCount')?.classList.contains('hidden'));
  await wide.locator('#projectSelect').selectOption({ label: 'Fahad AI Office' });
  await cleared;
  const restored = wide.waitForFunction((expected) => document.querySelector('[data-owner-objectives]')?.textContent === expected, String(counts.objectives));
  await wide.locator('#projectSelect').selectOption({ label: 'Qahwa Run' });
  await restored;
  await wide.getByText('Qahwa Run — launch plan').waitFor();
  await wide.screenshot({ path: '/opt/cursor/artifacts/v5-home-desktop-ar-light.png', fullPage: true });
  await wide.goto(`${url}#/settings`);
  await wide.locator('[data-theme-choice="dark"]').click();
  await wide.locator('[data-language="en"]').click();
  await wide.getByRole('heading', { name: 'Settings & platform' }).waitFor();
  await wide.goto(`${url}#/`);
  await wide.locator('.owner-hero').waitFor();
  assert.equal(await wide.locator('html').getAttribute('dir'), 'ltr');
  await wide.screenshot({ path: '/opt/cursor/artifacts/v5-home-desktop-en-dark.png', fullPage: true });
  await wide.goto(`${url}#/projects`);
  await wide.locator('.project-card-v5').first().waitFor();
  const projectText = await wide.locator('.project-card-v5').first().innerText();
  assert.equal(projectText.includes('Unavailable') && projectText.includes('$0'), false);
  assert.match(projectText, /\$/);
  const qahwa = await wide.locator('.project-card-v5', { hasText: 'Qahwa Run' }).innerText();
  assert.match(qahwa, /\$0\.0073/);
  assert.equal(qahwa.includes('Unavailable'), false);
  await wide.screenshot({ path: '/opt/cursor/artifacts/v5-projects-desktop-en-dark.png', fullPage: true });
  for (const route of ['/', '/projects', '/employees', '/work', '/new-work', '/attention', '/continuity', '/models', '/artifacts', '/settings']) {
    await wide.goto(`${url}#${route}`);
    await wide.waitForTimeout(300);
    assert.equal(await wide.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `desktop overflow ${route}`);
  }
  await desktop.close();
  assert.deepEqual(errors, []);
  if (process.env.AXE_SCRIPT) {
    const axe = await readFile(process.env.AXE_SCRIPT, 'utf8');
    for (const language of ['ar', 'en']) {
      await page.goto(`${url}#/settings`);
      await page.locator(`[data-language="${language}"]`).click();
      for (const route of ['/', '/projects', '/employees', '/work', '/new-work', '/attention', '/continuity', '/models', '/artifacts', '/settings']) {
        await page.goto(`${url}#${route}`);
        await page.waitForTimeout(400);
        await page.addScriptTag({ content: axe });
        const violations = await page.evaluate(async () => (await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })).violations.map((item) => ({ id: item.id, targets: item.nodes.map((node) => node.target) })));
        assert.deepEqual(violations, [], `${language} ${route} accessibility`);
      }
    }
    console.log('PASS: 20 mobile Arabic/English WCAG 2 A/AA route checks.');
  }
  console.log('PASS: mobile navigation → create project → create prioritized job → persisted result → Work → safe approval → language switch. Fixture only; worker completion simulated.');
  await context.close();
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
