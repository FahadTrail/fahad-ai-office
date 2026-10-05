import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (name) => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');

test('V5 owner shell exposes the nine requested product areas and Arabic-first RTL', () => {
  const index = read('src/hub-ui/index.html');
  assert.match(index, /<html lang="ar" dir="rtl">/);
  for (const nav of ['home', 'projects', 'employees', 'work', 'attention', 'continuity', 'models', 'artifacts', 'settings']) {
    assert.match(index, new RegExp(`data-nav="${nav}"`), nav);
  }
  assert.match(index, /data-i18n="askChief"/);
  const app = read('src/hub-ui/app.js');
  assert.match(app, /localStorage\.getItem\('hub-language'\) \|\| 'ar'/);
  assert.match(app, /document\.documentElement\.dir = value === 'ar' \? 'rtl' : 'ltr'/);
  assert.match(app, /data-language="ar"/);
  assert.match(app, /data-language="en"/);
});

test('Home is composed only from real owner APIs and keeps models as execution details', () => {
  const app = read('src/hub-ui/app.js');
  for (const endpoint of ['/api/command-center', '/api/attention', '/api/office', '/api/capacity', '/api/platform', '/api/tasks']) assert.ok(app.includes(endpoint), endpoint);
  assert.match(app, /function renderHome\(/);
  assert.match(app, /A model is an execution engine, never an employee identity/);
  assert.doesNotMatch(app, /demo project|sample task|fake capacity/i);
});

test('Approvals show safe facts and decide through the existing owner RPC endpoint', () => {
  const app = read('src/hub-ui/app.js');
  assert.match(app, /\/api\/approvals\$\{q\(/);
  assert.match(app, /data-approval-decision="approved"/);
  assert.match(app, /data-approval-decision="rejected"/);
  assert.match(app, /estimatedCostUsd/);
  assert.match(app, /arguments_preview/);
  assert.doesNotMatch(app, /JSON\.stringify\(approval\.arguments_preview/);
});

test('Continuity and platform keep technical state behind advanced disclosures', () => {
  const project = read('src/hub-ui/project.js');
  const app = read('src/hub-ui/app.js');
  assert.match(project, /Advanced details and controls/);
  assert.match(project, /Last checkpoint/);
  assert.match(project, /Next action/);
  assert.match(project, /Handoff history/);
  assert.match(app, /Provider and key status/);
  assert.match(app, /Secret values are never returned/);
  execFileSync(process.execPath, ['--check', fileURLToPath(new URL('../src/hub-ui/app.js', import.meta.url))]);
});
