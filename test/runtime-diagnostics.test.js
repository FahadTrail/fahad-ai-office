import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeDiagnostics } from '../src/canary/runtime-diagnostics.js';

test('runtime diagnostics report routing settings and probes without any secret value', async () => {
  const secret = ['AQ', 'Ab8RN6' + 'z'.repeat(40)].join('.');
  const env = {
    HUB_ENABLED: 'true', HUB_BIND: '0.0.0.0', HUB_PORT: '2132', HUB_TRAEFIK_ENABLED: 'true', HUB_PUBLIC_HOST: 'office.trimedia.me',
    GEMINI_API_KEY: secret, SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-value', HUB_OWNER_EMAIL: 'owner@example.com',
  };
  const seen = [];
  const fetchFn = async (url) => {
    seen.push(url);
    if (url.startsWith('http://127.0.0.1')) return new Response(JSON.stringify({ ok: true, service: 'fahad-ai-hub', version: 'c2e6cb8f8701' }), { headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/healthz')) return new Response('404 page not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    return new Response(`<html>${'x'.repeat(500)}${secret}</html>`, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const report = await runtimeDiagnostics({ env, fetchFn, resolve: async () => [{ address: '203.0.113.7' }] });
  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /Ab8RN6|service-role-secret|owner@example/, 'no credential or personal value is reported');
  assert.equal(report.settings.HUB_PUBLIC_HOST, 'office.trimedia.me');
  assert.equal(report.credentials.GEMINI_API_KEY, true);
  assert.equal(report.credentials.OPENAI_API_KEY, false);
  const local = report.probes.find((probe) => probe.name === 'hub-local');
  assert.deepEqual([local.status, local.version], [200, 'c2e6cb8f8701']);
  const publicHealth = report.probes.find((probe) => probe.name === 'public:office.trimedia.me/healthz');
  assert.deepEqual([publicHealth.status, publicHealth.bodyLine, publicHealth.resolvesTo[0]], [404, '404 page not found', '203.0.113.7']);
  assert.equal(report.probes.find((probe) => probe.name === 'public:office.trimedia.me/').bodyBytes > 0, true);
  assert.ok(seen.includes('https://fahad-ai-office.srv1964598.hstgr.cloud/healthz'));
});

test('an unreachable probe is reported as an error code, never thrown', async () => {
  const report = await runtimeDiagnostics({ env: {}, fetchFn: async () => { throw Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }); }, resolve: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); } });
  assert.equal(report.probes[0].error, 'ECONNREFUSED');
  assert.match(String(report.probes[1].resolvesTo), /^DNS_ERROR:ENOTFOUND$/);
});
