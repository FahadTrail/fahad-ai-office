// Provider-neutral web tools for Office agents. Any tool-calling model in the
// shared Model Pool can use them, so Research no longer depends on one
// vendor's hosted tools.
//
//   web_search(query)  Google Search grounding through the existing Gemini
//                      API key (free tier, Flash-Lite by default). Returns
//                      source titles/URLs and a short grounded summary.
//   web_fetch(url)     Plain HTTP(S) GET of a public page, converted to text.
//
// Safety: only http(s) on ports 80/443; hosts that resolve to private,
// loopback, link-local or metadata addresses are refused (re-checked on every
// redirect); responses are size- and time-limited; nothing Hermes-related is
// fetched; credentials are never placed in URLs or returned.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const OFFICE_WEB_TOOLS = Object.freeze([
  {
    name: 'web_search',
    description: 'Search the public web. Returns relevant sources (title, url) and a short summary grounded in them. Use specific queries.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a public web page and return its readable text (truncated). Use it to verify facts from a source URL.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Absolute http(s) URL' } }, required: ['url'] },
  },
]);

const MAX_BYTES = 1_500_000;
const MAX_TEXT = 12_000;

function privateAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const value = address.toLowerCase();
  if (value.startsWith('::ffff:')) return privateAddress(value.slice(7));
  return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80') || value.startsWith('ff');
}

export async function assertPublicUrl(raw, { resolve = lookup } = {}) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw toolError('URL_INVALID', 'Not a valid absolute URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw toolError('URL_SCHEME_DENIED', 'Only http and https URLs are allowed');
  if (url.username || url.password) throw toolError('URL_CREDENTIALS_DENIED', 'URLs with credentials are not allowed');
  if (url.port && !['80', '443'].includes(url.port)) throw toolError('URL_PORT_DENIED', 'Only ports 80 and 443 are allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local') || /hermes/.test(host)) {
    throw toolError('URL_HOST_DENIED', 'This host is not allowed');
  }
  const addresses = isIP(host) ? [{ address: host }] : await resolve(host, { all: true }).catch(() => {
    throw toolError('URL_DNS_FAILED', 'The host name could not be resolved');
  });
  if (!addresses.length || addresses.some((entry) => privateAddress(entry.address))) {
    throw toolError('URL_PRIVATE_ADDRESS_DENIED', 'The host resolves to a private or reserved address');
  }
  return url;
}

export function htmlToText(html) {
  const title = (String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim();
  const body = String(html)
    .replace(/<(script|style|noscript|svg|head|title)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return { title, text: body };
}

export async function webFetch({ url }, { fetchFn = fetch, resolve = lookup, timeoutMs = 15_000 } = {}) {
  let target = await assertPublicUrl(url, { resolve });
  for (let hop = 0; hop < 4; hop += 1) {
    const response = await fetchFn(target.href, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5', 'user-agent': 'FahadAIOffice-Research/1.0' },
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      target = await assertPublicUrl(new URL(response.headers.get('location'), target).href, { resolve });
      continue;
    }
    if (!response.ok) return { url: target.href, status: response.status, error: `HTTP ${response.status}` };
    const type = response.headers.get('content-type') || '';
    if (!/text|json|xml/.test(type)) return { url: target.href, status: response.status, error: `Unsupported content type ${type.split(';')[0]}` };
    const buffer = new Uint8Array(await response.arrayBuffer());
    const raw = new TextDecoder().decode(buffer.slice(0, MAX_BYTES));
    const { title, text } = /html/.test(type) ? htmlToText(raw) : { title: '', text: raw };
    return { url: target.href, status: response.status, title: title.slice(0, 300), text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT };
  }
  throw toolError('URL_TOO_MANY_REDIRECTS', 'Too many redirects');
}

// Google Search grounding via the Gemini API (official feature, free tier).
export async function webSearch({ query }, { env = process.env, fetchFn = fetch, timeoutMs = 30_000 } = {}) {
  const apiKey = String(env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw toolError('SEARCH_UNAVAILABLE', 'Web search is not configured (no Gemini key); use web_fetch on known sources');
  const q = String(query || '').trim().slice(0, 400);
  if (!q) throw toolError('SEARCH_QUERY_EMPTY', 'The query is empty');
  const model = /^[A-Za-z0-9._-]+$/.test(env.OFFICE_SEARCH_MODEL || '') ? env.OFFICE_SEARCH_MODEL : 'gemini-flash-lite-latest';
  const response = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `Search the web for: ${q}\nSummarize the most relevant current facts in at most 8 short bullet points.` }] }],
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: 800 },
    }),
  });
  if (!response.ok) throw toolError('SEARCH_FAILED', `Search provider returned HTTP ${response.status}`, response.status);
  const body = await response.json();
  const candidate = body.candidates?.[0] || {};
  const summary = (candidate.content?.parts || []).map((part) => part.text || '').join('').trim().slice(0, 3000);
  const sources = (candidate.groundingMetadata?.groundingChunks || [])
    .map((chunk) => chunk.web).filter(Boolean)
    .map((web) => ({ title: String(web.title || '').slice(0, 200), url: String(web.uri || '') }))
    .filter((source) => /^https?:\/\//.test(source.url)).slice(0, 8);
  return { query: q, summary, sources, provider: 'Google Search grounding (Gemini API)' };
}

export function createOfficeToolExecutor({ env = process.env, fetchFn = fetch, resolve = lookup, allowSearch = true } = {}) {
  return async (call) => {
    try {
      if (call.name === 'web_fetch') return { ok: true, result: await webFetch(call.arguments || {}, { fetchFn, resolve }) };
      if (call.name === 'web_search') {
        if (!allowSearch) throw toolError('SEARCH_NOT_ALLOWED_FOR_DATA_CLASS', 'Web search is disabled for confidential tasks');
        return { ok: true, result: await webSearch(call.arguments || {}, { env, fetchFn }) };
      }
      throw toolError('TOOL_UNKNOWN', `Unknown tool ${call.name}`);
    } catch (error) {
      return { ok: false, result: { error: error.code || 'TOOL_FAILED', message: String(error.message || 'Tool failed').slice(0, 300) } };
    }
  };
}

function toolError(code, message, status = null) {
  return Object.assign(new Error(message), { code, status });
}
