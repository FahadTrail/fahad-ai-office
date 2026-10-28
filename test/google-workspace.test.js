import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGoogleWorkspaceClient, googleWorkspaceStatus, googleWorkspaceTools, wantsGoogleWorkspace, rowsToCsv, markdownToDocHtml, GOOGLE_SCOPES,
} from '../src/integrations/google-workspace.js';
import { consentUrl, codeFrom, exchangeCode } from '../src/ops/google-oauth-setup.js';
import { newSession } from '../src/ops/google-oauth-session.js';
import { createOfficeToolExecutor } from '../src/office/web-tools.js';
import { capabilityView } from '../src/hub-office.js';

const READ = { GOOGLE_OAUTH_CLIENT_ID: '123-abc.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-secretsecretsecret', GOOGLE_OAUTH_REFRESH_TOKEN: '1//refresh-token-value-xyz' };
const FULL = { ...READ, GOOGLE_DRIVE_OFFICE_FOLDER_ID: 'FOLDER_abcdefghij' };
const WHOLE_DRIVE = { ...READ, GOOGLE_DRIVE_READ_SCOPE: 'drive' };
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

function fakeGoogle(routes) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'ya29.access', expires_in: 3600 });
    for (const [match, reply] of routes) if (String(url).includes(match)) return typeof reply === 'function' ? reply(url, init) : reply;
    return json({ error: 'unexpected' }, 500);
  };
  return { fetchFn, calls };
}

test('status, tools and intent: nothing is offered until configured; writes need the Office folder', () => {
  assert.deepEqual(googleWorkspaceStatus({}).state, 'NOT_CONFIGURED');
  assert.deepEqual(googleWorkspaceTools({}), []);
  assert.deepEqual(googleWorkspaceTools(READ), [], 'credentials alone grant nothing: reads stay inside the Office folder by default');
  assert.deepEqual(googleWorkspaceTools(FULL).map((tool) => tool.name), ['drive_search', 'drive_read', 'docs_create', 'sheets_create']);
  assert.deepEqual(googleWorkspaceTools(WHOLE_DRIVE).map((tool) => tool.name), ['drive_search', 'drive_read'], 'whole-Drive reading only by explicit choice');
  assert.deepEqual(googleWorkspaceStatus(READ).missing, ['GOOGLE_DRIVE_OFFICE_FOLDER_ID']);
  assert.deepEqual([googleWorkspaceStatus(FULL).readScope, googleWorkspaceStatus(WHOLE_DRIVE).readScope], ['folder', 'drive']);
  for (const text of ['Summarise the pricing sheet in my Google Drive', 'حط الخطة في مستند جوجل', 'لخّص الملف في درايف', 'put it in a Google Sheet']) assert.ok(wantsGoogleWorkspace(text), text);
  for (const text of ['Plan a bakery launch', 'How do we drive more traffic to the site?']) assert.ok(!wantsGoogleWorkspace(text), text);
  assert.ok(wantsGoogleWorkspace('read the pricing file in my drive'));
  assert.deepEqual(GOOGLE_SCOPES, ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file']);
});

test('search escapes the query, reads Docs as text, and caches the access token', async () => {
  const { fetchFn, calls } = fakeGoogle([
    ['/files?', json({ files: [{ id: 'DOCID_123456', name: "Fahad's plan", mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-27T10:00:00Z', webViewLink: 'https://docs.google.com/d/DOCID_123456' }] })],
    ['/files/DOCID_123456/export', json('Plan text '.repeat(10))],
    ['/files/DOCID_123456?', json({ id: 'DOCID_123456', name: "Fahad's plan", mimeType: 'application/vnd.google-apps.document', parents: ['FOLDER_abcdefghij'] })],
    ['/files/OUTSIDE_1234567?', json({ id: 'OUTSIDE_1234567', name: 'Private', mimeType: 'application/vnd.google-apps.document', parents: ['OTHER_FOLDER_1'] })],
  ]);
  const client = createGoogleWorkspaceClient({ env: FULL, fetchFn });
  const found = await client.search({ query: "Fahad's plan" });
  assert.equal(found.files[0].id, 'DOCID_123456');
  const query = new URL(calls[1].url).searchParams.get('q');
  assert.match(query, /name contains 'Fahad\\'s plan'/);
  assert.match(query, /'FOLDER_abcdefghij' in parents/, 'search stays inside the Office folder');
  await assert.rejects(client.read({ fileId: 'OUTSIDE_1234567' }), { code: 'FILE_OUTSIDE_OFFICE_FOLDER' });
  const doc = await client.read({ fileId: 'DOCID_123456' });
  assert.match(doc.text, /^Plan text/);
  assert.equal(calls.filter((call) => call.url.startsWith('https://oauth2')).length, 1, 'one token refresh for several calls');
  assert.ok(calls.every((call) => !call.url.includes('ya29') && !call.url.includes('1//refresh')), 'credentials never travel in a URL');
  await assert.rejects(client.read({ fileId: '../etc/passwd' }), { code: 'FILE_ID_INVALID' });
});

test('creating files converts to Google formats inside the Office folder only, and refuses without it', async () => {
  const { fetchFn, calls } = fakeGoogle([['upload/drive/v3/files', json({ id: 'NEWDOC_123456', name: 'Launch plan', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://docs.google.com/d/NEWDOC_123456' })]]);
  const client = createGoogleWorkspaceClient({ env: FULL, fetchFn });
  const created = await client.createDoc({ title: 'Launch plan', markdown: '# خطة\n| a | b |\n|---|---|\n| 1 | 2 |' });
  assert.deepEqual([created.created, created.id], [true, 'NEWDOC_123456']);
  const upload = calls.find((call) => call.url.includes('upload/drive'));
  assert.equal(upload.init.method, 'POST');
  assert.match(upload.init.body, /"parents":\["FOLDER_abcdefghij"\]/);
  assert.match(upload.init.body, /"mimeType":"application\/vnd.google-apps.document"/);
  assert.match(upload.init.body, /<table>/);
  await assert.rejects(createGoogleWorkspaceClient({ env: READ, fetchFn }).createSheet({ title: 'x', rows: [['a']] }), { code: 'GOOGLE_WRITE_NOT_CONFIGURED' });
  assert.equal(rowsToCsv([['name', 'note'], ['a,b', 'say "hi"']]), 'name,note\r\n"a,b","say ""hi"""');
  assert.doesNotMatch(markdownToDocHtml('<script>', '<img onerror=x>'), /<script>|<img/);
});

test('a revoked grant is an account action, not a retry', async () => {
  const fetchFn = async () => json({ error: 'invalid_grant' }, 400);
  await assert.rejects(createGoogleWorkspaceClient({ env: FULL, fetchFn }).search({ query: 'x' }), { code: 'GOOGLE_REAUTHORIZE' });
  await assert.rejects(createGoogleWorkspaceClient({ env: {}, fetchFn }).search({ query: 'x' }), { code: 'GOOGLE_NOT_CONFIGURED' });
});

test('the Office executor runs Drive tools only when given a client and reports created files', async () => {
  const { fetchFn } = fakeGoogle([['upload/drive/v3/files', json({ id: 'NEWSHEET_1234', name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet', webViewLink: 'https://docs.google.com/s/NEWSHEET_1234' })]]);
  const plain = createOfficeToolExecutor({ env: {} });
  assert.equal((await plain({ name: 'sheets_create', arguments: { title: 'Budget', rows: [['a']] } })).result.error, 'TOOL_UNKNOWN');
  const executor = createOfficeToolExecutor({ env: FULL, googleWorkspace: createGoogleWorkspaceClient({ env: FULL, fetchFn }) });
  const outcome = await executor({ name: 'sheets_create', arguments: { title: 'Budget', rows: [['item', 'aed'], ['rent', '8000']] } });
  assert.equal(outcome.ok, true);
  assert.deepEqual(executor.report().workspaceFiles, [{ id: 'NEWSHEET_1234', name: 'Budget', link: 'https://docs.google.com/s/NEWSHEET_1234', type: 'application/vnd.google-apps.spreadsheet' }]);
});

test('the Integrations page shows the connector honestly', () => {
  const find = (view) => view.find((item) => item.id === 'google_workspace');
  assert.equal(find(capabilityView({ env: {} })).status, 'Not configured');
  assert.equal(find(capabilityView({ env: READ })).status, 'Configured — not verified');
  assert.equal(find(capabilityView({ env: READ, webRuns: { drive_search: new Date().toISOString() } })).status, 'Connected');
});

test('the one-time setup builds an offline consent link and never needs the token on screen', async () => {
  const session = newSession('123-abc.apps.googleusercontent.com');
  const url = new URL(consentUrl('123-abc.apps.googleusercontent.com', session));
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:8765/');
  assert.equal(codeFrom('http://127.0.0.1:8765/?code=4/0Abc-def_123&scope=x'), '4/0Abc-def_123');
  assert.throws(() => codeFrom('http://127.0.0.1:8765/?error=access_denied'));
  const token = await exchangeCode({ code: '4/0Abc', codeVerifier: session.verifier, env: READ, fetchFn: async () => json({ refresh_token: '1//new', scope: GOOGLE_SCOPES.join(' ') }) });
  assert.equal(token, '1//new');
});
