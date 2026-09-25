// Non-secret routing diagnostics attached to every provider canary report.
// It lets an operator without shell access see what the running Office
// container was started with and how the Hub answers locally and through the
// public reverse proxy (probed from inside the VPS). Only allowlisted,
// non-secret setting names are reported; credentials are reported as
// present/absent only; response bodies are never stored beyond a short,
// plain-text status line such as "404 page not found".

import { lookup } from 'node:dns/promises';

const PLAIN_SETTINGS = ['HUB_ENABLED', 'HUB_BIND', 'HUB_PORT', 'HUB_AUTH_ENABLED', 'HUB_TRAEFIK_ENABLED', 'HUB_PUBLIC_HOST', 'COMPOSE_PROFILES', 'NODE_ENV'];
const PRESENCE = ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'QWEN_API_KEY', 'HUB_ACCESS_TOKEN', 'HUB_OWNER_EMAIL', 'CODING_GITHUB_TOKEN', 'CODING_SUPABASE_ACCESS_TOKEN'];
const KNOWN_PUBLIC_HOSTS = ['office.trimedia.me', 'fahad-ai-office.srv1964598.hstgr.cloud'];
const HOST_RE = /^[a-z0-9.-]{1,253}$/i;

export async function runtimeDiagnostics({ env = process.env, fetchFn = fetch, resolve = lookup, timeoutMs = 8000 } = {}) {
  const settings = Object.fromEntries(PLAIN_SETTINGS.map((name) => [name, env[name] === undefined ? null : String(env[name]).slice(0, 120)]));
  const credentials = Object.fromEntries(PRESENCE.map((name) => [name, Boolean(String(env[name] || '').trim())]));
  const port = /^\d{2,5}$/.test(String(env.HUB_PORT || '')) ? env.HUB_PORT : '2132';
  const hosts = [...new Set([env.HUB_PUBLIC_HOST, ...KNOWN_PUBLIC_HOSTS].filter((host) => host && HOST_RE.test(host)))];
  const probes = [{ name: 'hub-local', url: `http://127.0.0.1:${port}/healthz` },
    ...hosts.flatMap((host) => [{ name: `public:${host}/healthz`, url: `https://${host}/healthz`, host }, { name: `public:${host}/`, url: `https://${host}/`, host }])];
  const results = await Promise.all(probes.map(async (probe) => {
    const result = { name: probe.name };
    if (probe.host) {
      try {
        const addresses = await resolve(probe.host, { all: true });
        result.resolvesTo = addresses.map((entry) => entry.address).slice(0, 4);
      } catch (error) {
        result.resolvesTo = `DNS_ERROR:${String(error?.code || 'unknown').slice(0, 40)}`;
      }
    }
    try {
      const response = await fetchFn(probe.url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      result.status = response.status;
      result.server = response.headers.get('server');
      result.contentType = response.headers.get('content-type');
      const text = await response.text().catch(() => '');
      if (/json/.test(result.contentType || '')) {
        try {
          const body = JSON.parse(text);
          result.version = typeof body.version === 'string' ? body.version.slice(0, 40) : null;
          result.service = typeof body.service === 'string' ? body.service.slice(0, 40) : null;
        } catch {}
      } else if (text.length <= 60 && /^[\w .:-]*$/.test(text.trim())) {
        result.bodyLine = text.trim();
      } else {
        result.bodyBytes = text.length;
        result.looksLikeHub = /Fahad AI/.test(text);
      }
    } catch (error) {
      result.error = String(error?.cause?.code || error?.name || 'FETCH_FAILED').slice(0, 60);
    }
    return result;
  }));
  return { at: new Date().toISOString(), settings, credentials, probes: results };
}
