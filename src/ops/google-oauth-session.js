import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';

export const SESSION_TTL_MS = 10 * 60_000;
const verifierPattern = /^[A-Za-z0-9_-]{43,128}$/;

export function newSession(clientId, now = Date.now()) {
  if (!clientId) throw new Error('GOOGLE_OAUTH_CLIENT_ID is not set');
  return { clientId, createdAt: now, state: randomBytes(32).toString('base64url'), verifier: randomBytes(32).toString('base64url') };
}

export function validateSession(session, clientId, now = Date.now()) {
  if (!session || session.clientId !== clientId || !clientId
      || !verifierPattern.test(session.verifier || '') || !verifierPattern.test(session.state || '')
      || !Number.isFinite(session.createdAt) || now < session.createdAt || now - session.createdAt >= SESSION_TTL_MS) {
    throw new Error('OAuth session is missing, expired or belongs to another client. Start again with --url.');
  }
  return session;
}

export function challengeFor(verifier) {
  if (!verifierPattern.test(verifier || '')) throw new Error('A valid PKCE verifier is required');
  return createHash('sha256').update(verifier).digest('base64url');
}

export function callbackCode(pasted, session, clientId, redirectUri, now = Date.now()) {
  validateSession(session, clientId, now);
  let callback;
  try { callback = new URL(String(pasted).trim()); } catch { throw new Error('Paste the complete loopback callback address using hidden input.'); }
  const expected = new URL(redirectUri);
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.username || callback.password
      || callback.hash || callback.searchParams.has('error') || callback.searchParams.getAll('state').length !== 1
      || callback.searchParams.getAll('code').length !== 1) throw new Error('OAuth callback was refused. Start again with --url.');
  const state = Buffer.from(callback.searchParams.get('state') || '');
  const wanted = Buffer.from(session.state);
  if (state.length !== wanted.length || !timingSafeEqual(state, wanted)) throw new Error('OAuth state mismatch; no token request was sent.');
  const code = callback.searchParams.get('code');
  if (!code || code.length > 4096) throw new Error('OAuth callback contains no valid code.');
  return code;
}

// Exclusive creation prevents clobbering a pending session or following a
// pre-created symlink. The verifier is temporary local credential material.
export async function saveSession(path, session) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(session)); } finally { await handle.close(); }
}

export async function loadSession(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096
        || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) {
      throw new Error('OAuth session file is not a private owner-controlled file.');
    }
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}

export async function consumeSession(path) { await unlink(path); }
