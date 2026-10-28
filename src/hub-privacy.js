// Public privacy policy for the Google OAuth consent screen: GET /privacy
// (English) and /privacy/ar (Arabic). The text lives in src/legal/ and is
// rendered with the Hub's safe Markdown renderer.
//
// Owner approval gate: the page is served only once the owner has set both
// PRIVACY_CONTACT_EMAIL and PRIVACY_EFFECTIVE_DATE (YYYY-MM-DD) on the server.
// Until then both paths answer 404, so merging the code publishes nothing.

import { readFileSync } from 'node:fs';
import { renderMarkdown } from './hub-ui/markdown.js';

const TEXT = Object.freeze({
  en: readFileSync(new URL('./legal/privacy-en.md', import.meta.url), 'utf8'),
  ar: readFileSync(new URL('./legal/privacy-ar.md', import.meta.url), 'utf8'),
});
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const PRIVACY_PATHS = Object.freeze({ '/privacy': 'en', '/privacy/': 'en', '/privacy/ar': 'ar', '/privacy/ar/': 'ar' });

export function privacyConfig(env = process.env) {
  const contact = String(env.PRIVACY_CONTACT_EMAIL || '').trim();
  const effective = String(env.PRIVACY_EFFECTIVE_DATE || '').trim();
  const valid = EMAIL.test(contact) && DATE.test(effective) && !Number.isNaN(Date.parse(`${effective}T00:00:00Z`));
  return valid ? { contact, effective } : null;
}

// The complete HTML page, or null when the owner has not published it.
export function privacyPage(lang, env = process.env) {
  const config = privacyConfig(env);
  if (!config || !TEXT[lang]) return null;
  const body = renderMarkdown(TEXT[lang].replaceAll('{{CONTACT_EMAIL}}', config.contact).replaceAll('{{EFFECTIVE_DATE}}', config.effective));
  const ar = lang === 'ar';
  const other = ar ? '<a href="/privacy" lang="en">English</a>' : '<a href="/privacy/ar" lang="ar">العربية</a>';
  return `<!doctype html>
<html lang="${ar ? 'ar' : 'en'}" dir="${ar ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${ar ? 'سياسة الخصوصية — مكتب فهد للذكاء الاصطناعي' : 'Privacy Policy — Fahad AI Office'}</title>
<style>:root{color-scheme:light dark;--ink:#16202f;--muted:#5b6678;--bg:#fbfaf7;--line:#e3e0d8;--link:#2f55c8}
@media(prefers-color-scheme:dark){:root{--ink:#e8edf7;--muted:#9aa6ba;--bg:#0d1320;--line:#26334a;--link:#9fb4ff}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 system-ui,-apple-system,"Segoe UI","IBM Plex Sans Arabic",sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px 56px}nav{text-align:end;font-size:14px}a{color:var(--link)}
h1{font-size:28px;line-height:1.25;margin:16px 0 12px}h2{font-size:20px;margin:32px 0 8px;border-top:1px solid var(--line);padding-top:20px}
code{font-size:13px;word-break:break-all;background:color-mix(in srgb,var(--line) 55%,transparent);padding:1px 5px;border-radius:5px}
ul{padding-inline-start:22px}</style></head>
<body><main><nav>${other}</nav>${body}</main></body></html>`;
}

export function sendPrivacyPage(response, lang, env = process.env) {
  const html = privacyPage(lang, env);
  if (!html) {
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return response.end(JSON.stringify({ ok: false, error: 'NOT_FOUND' }));
  }
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'public, max-age=300',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  return response.end(html);
}
