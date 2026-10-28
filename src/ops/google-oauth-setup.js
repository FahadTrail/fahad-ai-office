// One-time Google Workspace authorization for the Office (owner action).
//
// Prerequisite: in Google Cloud Console create an OAuth client of type
// "Desktop app", enable the Google Drive API, and store its id and secret:
//   sudo bash ops/set-secret.sh GOOGLE_OAUTH_CLIENT_ID
//   sudo bash ops/set-secret.sh GOOGLE_OAUTH_CLIENT_SECRET
// (recreate the runtime so it sees them: docker compose up -d runtime)
//
// 1. Print the consent link and open it in your browser:
//      docker compose exec -T runtime node src/ops/google-oauth-setup.js --url
// 2. After you allow access the browser goes to http://127.0.0.1:8765/?code=…
//    and shows "cannot connect" — that is expected. Copy that whole address,
//    then (the address is read with hidden input and never shown):
//      read -rs URL; printf '%s' "$URL" | docker compose exec -T runtime node src/ops/google-oauth-setup.js --exchange | sudo bash ops/set-secret.sh GOOGLE_OAUTH_REFRESH_TOKEN; unset URL
//    The refresh token goes from Google straight into .env; it is never printed.
// 3. Create a folder "Fahad AI Office" in Drive, copy its id from the address
//    bar and store it: sudo bash ops/set-secret.sh GOOGLE_DRIVE_OFFICE_FOLDER_ID
// 4. docker compose up -d runtime. The Hub's Integrations page shows
//    "Configured — not verified" until the first real Drive call succeeds.
//
// Revoke at any time: https://myaccount.google.com/permissions
// --url creates a private, 10-minute PKCE/state session in the runtime's
// temporary directory. Run --exchange in the SAME runtime as the SAME user;
// do not recreate the container between these commands. Paste the complete
// callback URL, not a bare code. A successful exchange consumes the session.
// If restarting setup, remove only your pending OAuth session file first
// (never .env); --url refuses to overwrite it. GOOGLE_OAUTH_SESSION_FILE may
// select a private temporary path for a separate authorization attempt.

import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GOOGLE_SCOPES } from '../integrations/google-workspace.js';
import { newSession, validateSession, challengeFor, callbackCode, saveSession, loadSession, consumeSession } from './google-oauth-session.js';

export const REDIRECT_URI = 'http://127.0.0.1:8765/';

export function consentUrl(clientId, session) {
  validateSession(session, clientId);
  return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: clientId, redirect_uri: REDIRECT_URI, response_type: 'code', scope: GOOGLE_SCOPES.join(' '),
    // offline + consent: Google returns a refresh token every time.
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
    state: session.state, code_challenge: challengeFor(session.verifier), code_challenge_method: 'S256',
  })}`;
}

export function codeFrom(pasted) {
  const text = String(pasted || '').trim();
  let code = null;
  try { code = new URL(text).searchParams.get('code'); } catch { code = /^[A-Za-z0-9/_.-]{10,}$/.test(text) ? text : null; }
  if (!code) throw new Error('No authorization code found in the pasted address');
  return code;
}

export async function exchangeCode({ code, codeVerifier, env = process.env, fetchFn = fetch }) {
  challengeFor(codeVerifier); // Fail before network access if PKCE is missing.
  const response = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: REDIRECT_URI, client_id: env.GOOGLE_OAUTH_CLIENT_ID || '', client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET || '' }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Google refused the code (HTTP ${response.status}). Start again from --url.`);
  if (!body.refresh_token) throw new Error('Google returned no refresh token. Remove the app at https://myaccount.google.com/permissions and start again from --url.');
  const granted = String(body.scope || '').split(' ');
  const missing = GOOGLE_SCOPES.filter((scope) => !granted.includes(scope));
  if (missing.length) throw new Error('Google did not grant all required scopes; no refresh token was handed to storage.');
  return body.refresh_token;
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const sessionFile = process.env.GOOGLE_OAUTH_SESSION_FILE || join(tmpdir(), `fahad-google-oauth-${process.getuid?.() ?? 'owner'}.json`);
    if (process.argv.includes('--url')) {
      const session = newSession(clientId);
      await saveSession(sessionFile, session);
      console.log(consentUrl(clientId, session));
    }
    else if (process.argv.includes('--exchange')) {
      const session = await loadSession(sessionFile);
      const code = callbackCode(await readStdin(), session, clientId, REDIRECT_URI);
      const token = await exchangeCode({ code, codeVerifier: session.verifier });
      await consumeSession(sessionFile);
      // stdout is the pipe into ops/set-secret.sh; everything else goes to stderr.
      process.stdout.write(`${token}\n`);
      console.error('Refresh token received and handed to set-secret (not shown).');
    } else console.error('Usage: node src/ops/google-oauth-setup.js --url | --exchange (see the header of this file)');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
