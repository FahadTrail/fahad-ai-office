import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = (name) => fileURLToPath(new URL(`../src/hub-ui/${name}`, import.meta.url));

test('Coding continuity remains a valid nested project view and also has an owner-safe top-level destination', () => {
  execFileSync(process.execPath, ['--check', file('project.js')]);
  const project = readFileSync(file('project.js'), 'utf8');
  const app = readFileSync(file('app.js'), 'utf8');
  const index = readFileSync(file('index.html'), 'utf8');
  const topNavigation = index.slice(index.indexOf('<nav class="nav">'), index.indexOf('</nav>'));
  assert.match(project, /href="#\/project\/\$\{esc\(id\)\}\/continuity"/);
  assert.match(project, /role="tab"[^>]+aria-selected="\$\{mode === 'continuity'\}"/);
  assert.match(app, /\['map', 'continuity'\]\.includes\(sub\)/);
  assert.match(topNavigation, /href="#\/continuity"[^>]+data-nav="continuity"/);
  assert.match(project, /export async function renderContinuityPage/);
  assert.match(project, /Advanced details and controls/);
});

test('continuity dashboard labels every number basis and exposes controls only when enabled', () => {
  const project = readFileSync(file('project.js'), 'utf8');
  assert.match(project, /function basis\(value\)/);
  for (const label of ['Task tokens', 'Usage', 'Checkpoint', 'Last commit', 'Lifetime tokens', 'Completed / failed', 'Success', 'Average latency', 'Handoffs', 'Quota used', 'Reset']) {
    assert.ok(project.includes(label), label);
  }
  assert.match(project, /data\.enabled && active \?/);
  assert.match(project, /data\.enabled && pending \?/);
  assert.match(project, /data\.enabled && \(worker\.enabled \|\| worker\.executionMode === 'EXECUTABLE'\) \? `<button/);
  assert.match(project, /aria-live="polite"/);
  assert.match(project, /highestPct\(activeUsage\?\.sessionPct, activeUsage\?\.weeklyPct\)/, 'a measured zero remains 0%, not UNKNOWN');
});

test('continuity dashboard has responsive and reduced-motion-safe project styling', () => {
  const css = readFileSync(file('project.css'), 'utf8');
  assert.match(css, /\.continuity-workers \{ display: grid;/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(css, /@media \(max-width: 480px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'continuity styles use the existing design tokens');
});
