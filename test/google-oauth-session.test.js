import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newSession, validateSession, challengeFor, callbackCode, saveSession, loadSession, consumeSession, SESSION_TTL_MS } from '../src/ops/google-oauth-session.js';
import { consentUrl, exchangeCode, REDIRECT_URI } from '../src/ops/google-oauth-setup.js';
import { GOOGLE_SCOPES } from '../src/integrations/google-workspace.js';

const clientId = '123-example.apps.googleusercontent.com';
const callback = (session) => `${REDIRECT_URI}?code=synthetic-code&state=${session.state}`;

test('PKCE uses RFC 7636 S256; independent requests get fresh state and verifiers', () => {
  assert.equal(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const session = newSession(clientId);
  const other = newSession(clientId);
  assert.notEqual(session.state, other.state);
  assert.notEqual(session.verifier, other.verifier);
  const url = new URL(consentUrl(clientId, session));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), challengeFor(session.verifier));
  assert.equal(url.searchParams.get('state'), session.state);
  assert.equal(url.searchParams.get('scope'), GOOGLE_SCOPES.join(' '));
  assert.equal(url.href.includes(session.verifier), false);
});

test('callback binds exact redirect and one state/code to the same client and unexpired session', () => {
  const session = newSession(clientId);
  assert.equal(callbackCode(callback(session), session, clientId, REDIRECT_URI), 'synthetic-code');
  for (const value of [
    'bare-code', callback(session).replace('127.0.0.1', 'example.com'),
    callback(session).replace('/?', '/wrong?'), callback(session).replace(session.state, 'wrong-state'),
    `${callback(session)}&state=${session.state}`, `${callback(session)}&code=other`,
    `${callback(session)}&error=access_denied`, `${callback(session)}#fragment`,
  ]) assert.throws(() => callbackCode(value, session, clientId, REDIRECT_URI));
  assert.throws(() => callbackCode(callback(session), session, 'another-client', REDIRECT_URI));
  assert.throws(() => validateSession(session, clientId, session.createdAt + SESSION_TTL_MS));
  assert.throws(() => validateSession(session, clientId, session.createdAt - 1));
});

test('exchange sends verifier, refuses missing PKCE before fetch and refuses partial consent', async () => {
  const session = newSession(clientId);
  let calls = 0;
  const fetchFn = async (_url, init) => {
    calls += 1;
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('code_verifier'), session.verifier);
    assert.equal(body.get('redirect_uri'), REDIRECT_URI);
    return { ok: true, json: async () => ({ refresh_token: 'synthetic-refresh', scope: GOOGLE_SCOPES.join(' ') }) };
  };
  await assert.rejects(exchangeCode({ code: 'synthetic-code', fetchFn }), /PKCE/);
  assert.equal(calls, 0);
  assert.equal(await exchangeCode({ code: 'synthetic-code', codeVerifier: session.verifier, fetchFn }), 'synthetic-refresh');
  await assert.rejects(exchangeCode({ code: 'synthetic-code', codeVerifier: session.verifier,
    fetchFn: async () => ({ ok: true, json: async () => ({ refresh_token: 'synthetic-refresh', scope: GOOGLE_SCOPES[1] }) }),
  }), /required scopes/);
  await assert.rejects(exchangeCode({ code: 'synthetic-code', codeVerifier: session.verifier,
    fetchFn: async () => ({ ok: false, status: 400, json: async () => ({ error: 'DO-NOT-ECHO-PROVIDER-BODY' }) }),
  }), (error) => !error.message.includes('DO-NOT-ECHO'));
});

test('temporary session is private, cannot overwrite another attempt and is consumed once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'office-oauth-test-'));
  const path = join(dir, 'session.json');
  try {
    const session = newSession(clientId);
    await saveSession(path, session);
    assert.deepEqual(await loadSession(path), session);
    await assert.rejects(saveSession(path, newSession(clientId)), { code: 'EEXIST' });
    if (process.platform !== 'win32') {
      assert.equal((await stat(path)).mode & 0o077, 0);
      await chmod(path, 0o644);
      await assert.rejects(loadSession(path), /private/);
      await chmod(path, 0o600);
    }
    await consumeSession(path);
    await assert.rejects(loadSession(path), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
