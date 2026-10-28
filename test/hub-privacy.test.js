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

const APPROVED = JSON.parse(readFileSync(new URL('../src/legal/privacy-config.json', import.meta.url), 'utf8'));
const SAMPLE = { contactEmail: 'idotaste@gmail.com', effectiveDate: '2026-11-01' };
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the approved contact is recorded; the page stays unpublished without a valid date', () => {
  assert.equal(APPROVED.contactEmail, 'idotaste@gmail.com');
  for (const config of [{}, { contactEmail: 'idotaste@gmail.com' }, { contactEmail: 'idotaste@gmail.com', effectiveDate: null },
    { effectiveDate: '2026-11-01' }, { contactEmail: 'not an email', effectiveDate: '2026-11-01' }, { contactEmail: 'idotaste@gmail.com', effectiveDate: 'soon' }]) {
    assert.equal(privacyConfig(config), null);
    assert.equal(privacyPage('en', config), null);
  }
});

test('both languages render completely and safely once published', () => {
  for (const [lang, dir] of [['en', 'ltr'], ['ar', 'rtl']]) {
    const html = privacyPage(lang, SAMPLE);
    assert.match(html, new RegExp(`<html lang="${lang}" dir="${dir}">`));
    assert.ok(html.includes('mailto:idotaste@gmail.com') && html.includes('2026-11-01'));
    assert.doesNotMatch(html, /\{\{|<script/i, 'no unfilled placeholder and no script');
  }
});

test('the Hub serves /privacy publicly exactly when the committed approval is complete', async () => {
  const published = Boolean(privacyConfig());
  // Auth on: the policy must still be public.
  const server = createHubServer({ db: { auth: {} }, store: {}, port: 0, authEnabled: true, ownerEmail: 'owner@example.com' });
  await once(server, 'listening');
  try {
    for (const path of ['/privacy', '/privacy/ar']) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
      assert.equal(response.status, published ? 200 : 404, path);
      if (published) {
        assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
        assert.match(await response.text(), new RegExp(APPROVED.effectiveDate));
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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
  // Service providers and backups (owner-requested disclosures), tied to the code.
  const bridge = read('src/channels/office-bridge.js');
  for (const name of ['Supabase', 'Hostinger', 'Telegram']) assert.ok(en.includes(name) && ar.includes(name), name);
  assert.match(bridge, /clip\(body, 3500\)/, 'Telegram answers are clipped at 3,500 characters');
  assert.match(bridge, /clip\(job\.title \|\| job\.goal \|\| '', 140\)/, 'Hub objectives send only a title notice');
  assert.ok(en.includes('3,500') && ar.includes('3,500'));
  assert.match(en, /backups/i);
  assert.match(ar, /النسخ الاحتياطية/);
  // The Limited Use statement names the same recipients as "Service providers"
  // (not the AI provider alone), and that section's storage heading exists.
  assert.doesNotMatch(en, /except the AI provider/);
  assert.doesNotMatch(ar, /غير مزوّد الذكاء الاصطناعي الذي/);
  assert.match(en, /except the service providers listed below/);
  assert.match(ar, /غير مقدّمي الخدمات المذكورين أدناه/);
  assert.match(en, /^## Storage and retention$/m);
  assert.match(ar, /^## التخزين والاحتفاظ$/m);
  // web_fetch stays offered to private runs, and the policy says so.
  assert.match(runner, /useWebTools \|\| workspaceTools\.length \? officeWebTools\(\)/);
  assert.ok(en.includes('public web pages') && ar.includes('صفحات ويب عامة'));
});
