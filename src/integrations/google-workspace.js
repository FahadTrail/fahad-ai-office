// Google Workspace connector (Drive, Docs, Sheets) for Office employees.
//
// Authorization: the owner's own OAuth client and a refresh token obtained
// once with tools/google-oauth-setup.mjs (stored with ops/set-secret.sh). The
// Office never sees a password, never stores an access token outside memory,
// and never puts a credential in a URL, a prompt, a log or a tool result.
//
//   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN
//   + GOOGLE_DRIVE_OFFICE_FOLDER_ID
//       → drive_search / drive_read inside that folder only, and docs_create /
//         sheets_create, which only CREATE new files in it. Nothing is edited,
//         shared, moved or deleted.
//   GOOGLE_DRIVE_READ_SCOPE=drive (optional, Fahad's explicit choice)
//       → search and read anywhere in his Drive.
//
// Privacy: Drive content is the owner's private data. A run that is offered
// these tools is routed to privacy-approved models only (pool-runner), and the
// tools are offered only when the request asks for Drive/Docs/Sheets.
//
// Status: IMPLEMENTED — NOT CONNECTED. No credential exists on the server yet;
// the Hub shows "Not configured" until it does and "Connected" only after a
// real successful call.

import { renderMarkdown } from '../hub-ui/markdown.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const MAX_TEXT = 12_000;
const MAX_ROWS = 2_000;
const TIMEOUT_MS = 20_000;

// drive.readonly to find and read the owner's files; drive.file to create new
// ones (drive.file only ever reaches files this app created).
export const GOOGLE_SCOPES = Object.freeze(['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file']);

const READ_VARS = ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REFRESH_TOKEN'];
const present = (env, name) => String(env[name] || '').trim().length > 0;

// Read scope. Google has no OAuth scope for "one folder, including files
// Fahad puts there himself" (drive.file only reaches files this app created),
// so the token carries drive.readonly and the Office enforces the boundary in
// code: by default it searches and reads only inside the Office folder.
// GOOGLE_DRIVE_READ_SCOPE=drive is Fahad's explicit opt-in to whole-Drive reads.
export function googleReadScope(env = process.env) {
  return String(env.GOOGLE_DRIVE_READ_SCOPE || '').trim().toLowerCase() === 'drive' ? 'drive' : 'folder';
}

export function googleWorkspaceStatus(env = process.env) {
  const credentials = READ_VARS.filter((name) => !present(env, name));
  const folder = present(env, 'GOOGLE_DRIVE_OFFICE_FOLDER_ID');
  const readScope = googleReadScope(env);
  const read = credentials.length === 0 && (folder || readScope === 'drive');
  const write = credentials.length === 0 && folder;
  return {
    state: credentials.length === 0 ? 'CONFIGURED_UNVERIFIED' : 'NOT_CONFIGURED',
    read, write, readScope, missing: [...credentials, ...(folder ? [] : ['GOOGLE_DRIVE_OFFICE_FOLDER_ID'])],
  };
}

// Does Fahad's request ask for Drive / Docs / Sheets? Only then are the tools
// offered (and the run made private).
// "drive" alone is a common verb ("drive more traffic"), so it must name Drive.
const INTENT = /google\s*(drive|docs?|sheets?)|\bgdrive\b|\bmy drive\b|\bdrive\s+(folder|file|doc)s?\b|جوجل\s*(درايف|دوكس|شيتس?)|درايف|مستند(ات)?\s*جوجل|جدول\s*بيانات\s*جوجل|شيت\s*جوجل/i;
export function wantsGoogleWorkspace(text) {
  return INTENT.test(String(text || ''));
}

// Writes land in Fahad's real Drive, so a file is created only on his request:
// a live "is Drive connected?" question once made RESEARCH create a test Doc
// and Sheet (job 1a96a5c5). The rule sits in the tool itself because CHIEF
// writes RESEARCH's brief and may leave it out.
const CREATE_ONLY_WHEN_ASKED = 'Use only when Fahad explicitly asks for a new file; never to test or prove the connection (drive_search / drive_read do that).';

export const GOOGLE_WORKSPACE_TOOLS = Object.freeze({
  read: [
    {
      name: 'drive_search',
      description: "Search Fahad's Google Drive (the Office folder unless he allowed his whole Drive) by words in the file name or content. Returns file id, name, type, modified time and link. Use specific words.",
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words to look for' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['query'] },
    },
    {
      name: 'drive_read',
      description: 'Read one Google Drive file as text: Google Docs as text, Google Sheets as CSV (first sheet), plain text, Markdown and CSV files. Other types are refused.',
      inputSchema: { type: 'object', properties: { fileId: { type: 'string', description: 'File id from drive_search' } }, required: ['fileId'] },
    },
  ],
  write: [
    {
      name: 'docs_create',
      description: `Create a NEW Google Doc in Fahad's Office folder from Markdown (headings, lists, tables). Returns its link. Never edits existing files. ${CREATE_ONLY_WHEN_ASKED}`,
      inputSchema: { type: 'object', properties: { title: { type: 'string' }, markdown: { type: 'string' } }, required: ['title', 'markdown'] },
    },
    {
      name: 'sheets_create',
      description: `Create a NEW Google Sheet in Fahad's Office folder from rows (first row = header). Returns its link. Never edits existing files. ${CREATE_ONLY_WHEN_ASKED}`,
      inputSchema: {
        type: 'object',
        // Cells are strings (numbers as text): some providers refuse union types in tool schemas.
        properties: { title: { type: 'string' }, rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } } },
        required: ['title', 'rows'],
      },
    },
  ],
});

export function googleWorkspaceTools(env = process.env) {
  const status = googleWorkspaceStatus(env);
  return [...(status.read ? GOOGLE_WORKSPACE_TOOLS.read : []), ...(status.write ? GOOGLE_WORKSPACE_TOOLS.write : [])];
}
export const GOOGLE_WORKSPACE_TOOL_NAMES = new Set([...GOOGLE_WORKSPACE_TOOLS.read, ...GOOGLE_WORKSPACE_TOOLS.write].map((tool) => tool.name));

function workspaceError(code, message, status = null) {
  return Object.assign(new Error(message), { code, status });
}

// Google ids are URL-safe; anything else is refused before it reaches a URL.
const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;
// Drive query strings quote with single quotes; escape backslash and quote.
const quote = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const csvCell = (value) => {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
export function rowsToCsv(rows) {
  if (!Array.isArray(rows) || !rows.length || !rows.every(Array.isArray)) throw workspaceError('ROWS_INVALID', 'rows must be a non-empty array of arrays');
  if (rows.length > MAX_ROWS) throw workspaceError('ROWS_TOO_MANY', `At most ${MAX_ROWS} rows`);
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export function markdownToDocHtml(title, markdown) {
  // The same safe renderer the Hub uses: everything is escaped, links are
  // limited to http(s)/mailto. dir="auto" keeps Arabic right-to-left.
  const safeTitle = String(title).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title></head><body dir="auto">${renderMarkdown(String(markdown || ''))}</body></html>`;
}

export function createGoogleWorkspaceClient({ env = process.env, fetchFn = fetch, now = () => Date.now() } = {}) {
  const status = googleWorkspaceStatus(env);
  let cached = null;

  const accessToken = async () => {
    if (cached && cached.expiresAt - 60_000 > now()) return cached.token;
    if (!status.read) throw workspaceError('GOOGLE_NOT_CONFIGURED', `Google Workspace is not connected (missing: ${status.missing.join(', ')})`);
    const response = await fetchFn(TOKEN_URL, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', client_id: env.GOOGLE_OAUTH_CLIENT_ID, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET, refresh_token: env.GOOGLE_OAUTH_REFRESH_TOKEN,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await response.json().catch(() => ({}));
    // invalid_grant = the owner revoked access or the token expired (7 days
    // for an OAuth app left in "Testing"): an account action, not a retry.
    if (!response.ok || !body.access_token) {
      throw workspaceError(body.error === 'invalid_grant' ? 'GOOGLE_REAUTHORIZE' : 'GOOGLE_AUTH_FAILED',
        body.error === 'invalid_grant' ? 'Google access was revoked or expired; run tools/google-oauth-setup.mjs again' : `Google sign-in failed (HTTP ${response.status})`, response.status);
    }
    cached = { token: body.access_token, expiresAt: now() + Number(body.expires_in || 3600) * 1000 };
    return cached.token;
  };

  const call = async (url, init = {}, { raw = false } = {}) => {
    const token = await accessToken();
    const response = await fetchFn(url, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) {
      const code = response.status === 401 ? 'GOOGLE_AUTH_FAILED' : response.status === 403 ? 'GOOGLE_FORBIDDEN' : response.status === 404 ? 'GOOGLE_NOT_FOUND'
        : response.status === 429 ? 'GOOGLE_RATE_LIMITED' : 'GOOGLE_FAILED';
      if (response.status === 401) cached = null;
      throw workspaceError(code, `Google API refused the request (HTTP ${response.status})`, response.status);
    }
    return raw ? response.text() : response.json();
  };

  const fileView = (file) => ({ id: file.id, name: file.name, type: file.mimeType, modifiedAt: file.modifiedTime || null, link: file.webViewLink || null });

  return {
    status,
    async search({ query, limit = 10 }) {
      const words = String(query || '').trim().slice(0, 200);
      if (!words) throw workspaceError('QUERY_REQUIRED', 'query is required');
      const inFolder = status.readScope === 'folder' ? ` and ${quote(env.GOOGLE_DRIVE_OFFICE_FOLDER_ID)} in parents` : '';
      const q = `(name contains ${quote(words)} or fullText contains ${quote(words)}) and trashed = false${inFolder}`;
      const params = new URLSearchParams({ q, pageSize: String(Math.min(20, Math.max(1, Number(limit) || 10))), fields: 'files(id,name,mimeType,modifiedTime,webViewLink)', orderBy: 'modifiedTime desc', spaces: 'drive' });
      const body = await call(`${DRIVE}/files?${params}`);
      return { files: (body.files || []).map(fileView) };
    },
    async read({ fileId }) {
      if (!FILE_ID.test(String(fileId || ''))) throw workspaceError('FILE_ID_INVALID', 'Not a Google Drive file id');
      const meta = await call(`${DRIVE}/files/${fileId}?${new URLSearchParams({ fields: 'id,name,mimeType,modifiedTime,webViewLink,size,parents' })}`);
      if (status.readScope === 'folder' && !(meta.parents || []).includes(env.GOOGLE_DRIVE_OFFICE_FOLDER_ID)) {
        throw workspaceError('FILE_OUTSIDE_OFFICE_FOLDER', 'Only files inside the Office folder can be read (Fahad can allow whole-Drive reading with GOOGLE_DRIVE_READ_SCOPE=drive)');
      }
      let text;
      if (meta.mimeType === 'application/vnd.google-apps.document') text = await call(`${DRIVE}/files/${fileId}/export?mimeType=text%2Fplain`, {}, { raw: true });
      else if (meta.mimeType === 'application/vnd.google-apps.spreadsheet') text = await call(`${DRIVE}/files/${fileId}/export?mimeType=text%2Fcsv`, {}, { raw: true });
      else if (/^text\/|^application\/(json|csv)$/.test(meta.mimeType || '')) {
        if (Number(meta.size || 0) > 2_000_000) throw workspaceError('FILE_TOO_LARGE', 'The file is larger than 2 MB');
        text = await call(`${DRIVE}/files/${fileId}?alt=media`, {}, { raw: true });
      } else throw workspaceError('FILE_TYPE_UNSUPPORTED', `Cannot read ${meta.mimeType} as text`);
      return { ...fileView(meta), text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT };
    },
    async createDoc({ title, markdown }) {
      return create(title, 'application/vnd.google-apps.document', 'text/html', markdownToDocHtml(title, markdown));
    },
    async createSheet({ title, rows }) {
      return create(title, 'application/vnd.google-apps.spreadsheet', 'text/csv', rowsToCsv(rows));
    },
  };

  // Multipart upload with conversion, always into the Office folder.
  async function create(title, googleType, sourceType, content) {
    if (!status.write) throw workspaceError('GOOGLE_WRITE_NOT_CONFIGURED', 'Creating files needs GOOGLE_DRIVE_OFFICE_FOLDER_ID');
    const name = String(title || '').trim().slice(0, 200);
    if (!name) throw workspaceError('TITLE_REQUIRED', 'title is required');
    if (!FILE_ID.test(String(env.GOOGLE_DRIVE_OFFICE_FOLDER_ID))) throw workspaceError('FOLDER_ID_INVALID', 'GOOGLE_DRIVE_OFFICE_FOLDER_ID is not a Drive folder id');
    const boundary = `office-${now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const metadata = JSON.stringify({ name, mimeType: googleType, parents: [env.GOOGLE_DRIVE_OFFICE_FOLDER_ID] });
    const body = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\ncontent-type: ${sourceType}; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
    const file = await call(`${UPLOAD}?uploadType=multipart&fields=id,name,mimeType,modifiedTime,webViewLink`, {
      method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body,
    });
    return { created: true, ...fileView(file) };
  }
}

// Tool-call adapter used by the Office tool executor.
export async function runGoogleWorkspaceTool(client, call) {
  const args = call.arguments || {};
  if (call.name === 'drive_search') return client.search(args);
  if (call.name === 'drive_read') return client.read(args);
  if (call.name === 'docs_create') return client.createDoc(args);
  if (call.name === 'sheets_create') return client.createSheet(args);
  throw workspaceError('TOOL_UNKNOWN', `Unknown tool ${call.name}`);
}
