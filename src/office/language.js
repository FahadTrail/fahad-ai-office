// How the Office speaks to Fahad: one language policy for CHIEF, every
// employee, synthesis, direct chats, consults, the Hub and Telegram.
//
//   Arabic message        → polished Emirati (UAE) conversational Arabic
//   English message       → English
//   Arabic + English mix  → the same natural mix
//
// Technical and role terms stay in English when that is how Fahad says them.
// Formal Modern Standard Arabic only for legal, contractual, official and
// technical-definition text. Clarity always beats dialect.

const ARABIC_LETTER = /[ء-ي٠-٩ٮ-ۓۺ-ۿ]/g;
const LATIN_LETTER = /[A-Za-z]/g;

// English words that are simply how Fahad names things; they do not make an
// Arabic message "mixed".
export const ENGLISH_TERMS = Object.freeze([
  'Chief', 'Research', 'Creative', 'Product', 'Finance', 'Coding', 'Audit', 'Social', 'Legal',
  'PR', 'CI', 'deploy', 'model', 'API', 'dashboard', 'workflow', 'Hub', 'Telegram', 'GitHub', 'Supabase',
]);
const TERM_PATTERN = new RegExp(`\\b(${ENGLISH_TERMS.join('|')}|Fahad|AI|Office|MVP|UI|UX|KPI|SEO|AED|USD|URL|app|link)s?\\b`, 'gi');

// 'ar' | 'en' | 'mixed'. Counts letters, ignoring code, links and known terms.
export function detectLanguage(text) {
  const plain = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
  const arabic = (plain.match(ARABIC_LETTER) || []).length;
  if (!arabic) return 'en';
  const latin = (plain.replace(TERM_PATTERN, ' ').match(LATIN_LETTER) || []).length;
  const share = arabic / (arabic + latin);
  if (share >= 0.7) return 'ar';
  return share <= 0.15 ? 'en' : 'mixed';
}

// Routing: Arabic output needs a model that writes Arabic well.
export const routingLanguage = (text) => (detectLanguage(text) === 'en' ? null : 'ar');

const TERMS_LINE = `Keep these terms in English as Fahad says them, never awkwardly translated: ${ENGLISH_TERMS.slice(0, 16).join(', ')}.`;

const EMIRATI = [
  'Write in polished Emirati (UAE) conversational Arabic — how a sharp UAE colleague writes to Fahad: natural, clear and professional.',
  'Grammar must be correct: noun–adjective and subject–verb agreement, clean sentence order, correct prepositions.',
  'Natural Gulf/Emirati phrasing where it fits (الحين، خلني، هالخطوة، يروح، نبدأ، ما يحتاج، وايد only sparingly); no heavy slang, no exaggerated dialect.',
  'Never translate literally from English and never use stiff, translated constructions (e.g. not «قم بعمل»، «يتم القيام بـ»، «في هذا السياق»، «من الجدير بالذكر»).',
  'Do not mix formal Arabic and slang inside one sentence. Use Modern Standard Arabic only for legal text, contracts, formal reports, official documents and technical definitions.',
  TERMS_LINE,
  'Tone examples: «تمام، خلني أرتب لك الموضوع.» «الحين عندنا ثلاث نقاط مهمة.» «هذا الجزء يروح للـ Finance.» «خل الـ Legal يراجع الموضوع قبل الإطلاق.» «إذا خلصت هالخطوة، ننتقل للـ Coding.» «الموضوع شغال وما يحتاج منك تدخل الحين.»',
  'Clarity first: if a dialect word could confuse, use the clearer word.',
];

// The instruction block for a prompt, chosen by the language of `text`
// (Fahad's message or objective).
export function languageInstruction(text, { audience = 'Fahad' } = {}) {
  const language = detectLanguage(text);
  if (language === 'en') return `LANGUAGE: ${audience === 'Fahad' ? 'Fahad wrote in English' : 'The request is in English'} — write everything in clear, natural English.`;
  if (language === 'mixed') {
    return ['LANGUAGE: Fahad mixes Arabic and English — answer in the same natural mix: Emirati Arabic sentences, keeping the English words and phrases he uses in English.',
      ...EMIRATI.slice(1)].join('\n');
  }
  return ['LANGUAGE: Fahad wrote in Arabic — answer in Arabic.', ...EMIRATI].join('\n');
}

// Office facts CHIEF may state; everything else about the Office needs a
// source in the context. Built from the live roster so it never drifts.
export function officeFacts(agents) {
  const specialists = agents.filter((agent) => agent.executor !== 'chief').map((agent) => agent.label);
  return [
    `OFFICE FACTS (true; use them when asked about the Office, its team or its status): Fahad AI Office has ${specialists.length + 1} roles —`,
    `CHIEF (you: the head, who plans, dispatches and consolidates) and ${specialists.length} specialists: ${specialists.join(', ')}.`,
    `Never say the office has a different number of specialists and never leave one out. Fahad sees everything in the Hub (web) and on Telegram.`,
    'Never invent people, members, organizations, projects, numbers or status. If the context does not say something, say you do not know it or point Fahad to the Hub.',
  ].join('\n');
}
