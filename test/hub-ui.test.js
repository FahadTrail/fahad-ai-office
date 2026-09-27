import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { escapeHtml, renderMarkdown } from '../src/hub-ui/markdown.js';

const file = (name) => fileURLToPath(new URL(`../src/hub-ui/${name}`, import.meta.url));

test('the Workspace V2 scripts are valid modules', () => {
  for (const name of ['app.js', 'markdown.js', 'auth.js']) execFileSync(process.execPath, ['--check', file(name)]);
});

test('markdown renders the common constructs', () => {
  const html = renderMarkdown('# Title\n\nSome **bold**, *italic* and `code`.\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n```js\nconst a = 1 < 2;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n> quoted\n\n[link](https://example.com)');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul><li>one<\/li><li>two<ul><li>nested<\/li><\/ul><\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<pre data-lang="js"><code>const a = 1 &lt; 2;<\/code><\/pre>/);
  assert.match(html, /<table><thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody><\/table>/);
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.match(html, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">link<\/a>/);
});

test('markdown never lets model output inject markup or script URLs', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> <script>alert(1)</script>\n\n[x](javascript:alert(1)) [y](data:text/html,hi) **<b>**\n\n```\n</code><script>1</script>\n```');
  assert.doesNotMatch(html, /<img|<script|<b>|href="javascript|href="data/i);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(escapeHtml('"\'<>&'), '&quot;&#39;&lt;&gt;&amp;');
});

test('the V2 interface uses the centralized design tokens and covers the owner flows', () => {
  const css = readFileSync(file('app.css'), 'utf8');
  const js = readFileSync(file('app.js'), 'utf8');
  for (const token of ['--bg', '--surface', '--text', '--accent', '--success', '--warning', '--danger', '--s-4', '--fs-md', '--r-md']) assert.match(css, new RegExp(`${token}:`));
  // Component rules use tokens, not raw colours (the token blocks are the only place colours are defined).
  const rules = css.replace(/:root(\[data-theme="(?:light|dark)"\])?\s*\{[\s\S]*?\n\}/g, '').replace(/@media \(prefers-color-scheme: light\)\s*\{[\s\S]*?\n\}/, '');
  const raw = (rules.match(/#[0-9a-f]{3,8}\b/gi) || []).filter((colour) => !['#fff', '#06140e', '#1a1204', '#8b5cf6'].includes(colour.toLowerCase()));
  assert.deepEqual(raw, [], 'raw colours outside the token blocks');
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /:root\[data-theme="light"\]/, 'Fahad can choose the light theme');
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \.desk/, 'the Living Office respects reduced motion');
  for (const phrase of ['/api/artifacts', '/api/command-center', 'renderArtifact', 'drawHandoffs', '#/employees', '#/integrations']) assert.ok(js.includes(phrase) || readFileSync(file('index.html'), 'utf8').includes(phrase), phrase);
  for (const phrase of ['What do you want me to build or fix?', 'Reply &amp; Continue', 'data-decide="approved"', 'data-decide="rejected"', 'View details', 'Needs attention', '/api/tasks/${id}/reply']) {
    assert.ok(js.includes(phrase), phrase);
  }
});

test('sign-in errors are honest: only a 403 says the email cannot sign in', async () => {
  const { loginErrorMessage } = await import('../src/hub-ui/auth.js');
  assert.equal(loginErrorMessage(403, { error: 'EMAIL_NOT_ALLOWED' }), 'That email cannot sign in.');
  assert.match(loginErrorMessage(500, { error: 'Could not send verification code: For security purposes, you can only request this after 55 seconds.' }), /code was sent recently/);
  assert.match(loginErrorMessage(429, {}), /code was sent recently/);
  assert.doesNotMatch(loginErrorMessage(500, { error: 'boom' }), /cannot sign in/);
});

test('the sign-in form is set up once per signed-out state and stops background polling', () => {
  const js = readFileSync(file('app.js'), 'utf8');
  const body = js.slice(js.indexOf('async function showLogin()'), js.indexOf("$('#app').classList.add('hidden')", js.indexOf('async function showLogin()')));
  assert.match(body, /clearTimers\(\)/);
  assert.match(body, /clearInterval\(state\.sidebarTimer\)/);
  assert.match(body, /if \(state\.signedOut\) return;/);
  assert.match(js, /state\.sidebarTimer = setInterval\(refreshSidebar/);
  assert.match(js, /loginErrorMessage\(response\.status/);
});
