// The public /privacy page (Google OAuth consent screen): unpublished (404)
// until the owner sets the contact and effective date, public and locked down
// once published, and every factual statement still true of the code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createHubServer } from '../src/hub-server.js';
import { privacyConfig, privacyPage } from '../src/hub-privacy.js';
import { GOOGLE_SCOPES } from '../src/integrations/google-workspace.js';

const PUBLISHED = { PRIVACY_CONTACT_EMAIL: 'owner@example.com', PRIVACY_EFFECTIVE_DATE: '2026-11-01' };
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

async function withServer(env, fn) {
  const saved = { PRIVACY_CONTACT_EMAIL: process.env.PRIVACY_CONTACT_EMAIL, PRIVACY_EFFECTIVE_DATE: process.env.PRIVACY_EFFECTIVE_DATE };
  for (const key of Object.keys(saved)) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  // Auth on: the policy must still be public.
  const server = createHubServer({ db: { auth: {} }, store: {}, port: 0, authEnabled: true, ownerEmail: 'owner@example.com' });
  await once(server, 'listening');
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('the privacy page is not published until the owner sets contact and date', async () => {
  for (const env of [{}, { PRIVACY_CONTACT_EMAIL: 'owner@example.com' }, { PRIVACY_EFFECTIVE_DATE: '2026-11-01' },
    { PRIVACY_CONTACT_EMAIL: 'not an email', PRIVACY_EFFECTIVE_DATE: '2026-11-01' }, { PRIVACY_CONTACT_EMAIL: 'owner@example.com', PRIVACY_EFFECTIVE_DATE: 'soon' }]) {
    assert.equal(privacyConfig(env), null);
    assert.equal(privacyPage('en', env), null);
  }
  await withServer({}, async (base) => {
    for (const path of ['/privacy', '/privacy/ar']) assert.equal((await fetch(base + path)).status, 404);
  });
});

test('once published, both languages are public, complete and locked down', async () => {
  await withServer(PUBLISHED, async (base) => {
    for (const [path, lang, dir] of [['/privacy', 'en', 'ltr'], ['/privacy/ar', 'ar', 'rtl']]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type'), /text\/html/);
      assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
      const html = await response.text();
      assert.match(html, new RegExp(`<html lang="${lang}" dir="${dir}">`));
      assert.ok(html.includes('owner@example.com') && html.includes('2026-11-01'));
      assert.doesNotMatch(html, /\{\{|<script/i, 'no unfilled placeholder and no script');
    }
  });
});

test('the policy text matches what the code does', () => {
  const en = read('src/legal/privacy-en.md');
  const ar = read('src/legal/privacy-ar.md');
  const connector = read('src/integrations/google-workspace.js');
  const workflow = read('src/workflow.js');
  const runner = read('src/office/pool-runner.js');
  // Exactly the scopes the app requests, in both languages.
  for (const scope of GOOGLE_SCOPES) assert.ok(en.includes(scope) && ar.includes(scope), scope);
  assert.equal((en.match(/https:\/\/www\.googleapis\.com\/auth\//g) || []).length, GOOGLE_SCOPES.length);
  // Folder boundary, 2 MB read limit, create-only writes.
  assert.match(connector, /in parents/);
  assert.match(connector, /FILE_OUTSIDE_OFFICE_FOLDER/);
  assert.match(connector, /> 2_000_000/);
  assert.doesNotMatch(connector, /method: '(PATCH|DELETE|PUT)'/, 'no edit or delete call exists');
  assert.doesNotMatch(connector, /\/permissions/, 'no sharing call exists');
  // Drive only when asked; private-data routes only; search withheld.
  assert.match(workflow, /useWorkspaceTools: .*wantsGoogleWorkspace\(request\.goal\)/);
  assert.match(runner, /requiresPrivateData = .*workspaceTools\.length > 0/);
  assert.match(runner, /allowSearch: !requiresPrivateData \|\|/);
  // The paused-request excerpt limit stated in the policy (1,200 characters).
  assert.match(workflow, /summary: String\(call\.summary \|\| ''\)\.slice\(0, 1200\)/);
  assert.ok(en.includes('1,200') && ar.includes('1,200'));
});
