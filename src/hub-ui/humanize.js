// Technical infrastructure problems in human language. The original text is
// kept for "View details"; this only chooses the words Fahad reads first.
const RULES = [
  [/PUSH_FORBIDDEN/, 'GitHub refused the Coding Agent\'s push (HTTP 403): its GitHub credential cannot write to this repository. Grant it Contents and Pull requests write access, then resume — the finished code is kept.'],
  [/PUSH_UNAUTHORIZED/, 'GitHub rejected the Coding Agent\'s credential (missing, expired or revoked). Renew it on the server, then resume — the finished code is kept.'],
  [/REMOTE_BRANCH_MISSING|PUSH_NOT_VERIFIED|PR_NOT_VERIFIED/, 'The work branch is not on GitHub yet, so no pull request was opened. Resume to publish it again — the finished code is kept.'],
  [/TOOLCHAIN_MISSING|is not installed in the worker image/i, 'This project needs a toolchain the Coding Agent does not have (only Node.js and Python are installed). Run it on a Node.js or Python repository, or ask for the toolchain to be added.'],
  [/^Stalled: no step can run/i, 'Stalled: no step can run, so this objective will not progress on its own. Stop it, then resume it where it stopped.'],
  [/WAITING_FOR_CAPACITY|NO_FREE_CAPACITY|free model capacity/i, 'Waiting for free model capacity — will resume automatically.'],
  [/\b429\b|RATE_LIMIT|rate.?limit|too many requests|quota|COOLDOWN_QUOTA/i, 'Free model capacity is temporarily full. The task will resume automatically.'],
  [/AccessDenied|Unpurchased|ACCOUNT_BLOCKED|auth_error|PROVIDER_AUTH|invalid api key|\b403\b.*provider|provider.*\b403\b|provider blocked/i, 'This provider needs account action (Models → provider).'],
  [/NO_ELIGIBLE_PROVIDER|NO_ALLOWED_MODEL|No allowed model|ALL_PROVIDERS_UNAVAILABLE/i, 'No allowed model can do this step right now. The Office retries when a model is back; see Models for why.'],
  [/CAPACITY_WAIT_EXHAUSTED/i, 'The Office waited a long time for free model capacity and stopped. Retry it, or allow another model in Models.'],
  [/BUDGET|spend limit|budget exceeded/i, 'The workspace budget is used up for this month. Nothing paid runs until you raise it in Settings.'],
  [/please sign in|\b401\b|unauthori[sz]ed/i, 'Please sign in again.'],
  [/Failed to fetch|NetworkError|network error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|timed? ?out/i, 'The Office could not be reached just now. It will retry; check your connection if this repeats.'],
  [/\b5\d\d\b|internal server error|Could not load Office data/i, 'Something went wrong on the Office side. Try again in a moment — nothing was lost.'],
];

// The same problems in natural Gulf Arabic, for the Arabic interface. The
// Office-specific causes come first so a step failure reads as what happened.
const RULES_AR = [
  [/PUSH_FORBIDDEN/, 'GitHub رفض رفع شغل وكيل البرمجة (HTTP 403): صلاحية GitHub عنده ما تسمح بالكتابة في هذا المستودع. أعطه صلاحية Contents و Pull requests للكتابة ثم استأنف — الكود المنجز محفوظ.'],
  [/PUSH_UNAUTHORIZED/, 'GitHub رفض صلاحية وكيل البرمجة (ناقصة أو منتهية أو ملغاة). جدّدها على السيرفر ثم استأنف — الكود المنجز محفوظ.'],
  [/REMOTE_BRANCH_MISSING|PUSH_NOT_VERIFIED|PR_NOT_VERIFIED/, 'فرع الشغل مو موجود على GitHub للحين، فما انفتح طلب دمج. استأنف عشان ينرفع مرة ثانية — الكود المنجز محفوظ.'],
  [/TOOLCHAIN_MISSING|is not installed in the worker image/i, 'هذا المشروع يحتاج أدوات برمجة غير مثبتة عند وكيل البرمجة (المثبت فقط Node.js و Python). شغّله على مستودع Node.js أو Python، أو اطلب إضافة الأدوات.'],
  [/^Stalled: no step can run/i, 'المهمة متوقفة: ما في خطوة تقدر تشتغل، فما بتتقدم بروحها. أوقفها ثم استأنفها من حيث وقفت.'],
  [/web search provider returned no results|web search is unavailable|SEARCH_UNAVAILABLE/i, 'خدمة البحث على الإنترنت ما ردّت بنتائج. تقدر تستأنف المهمة، والفريق بيعيد المحاولة.'],
  [/Stale: no heartbeat|assumed crashed/i, 'انقطع العامل أثناء الشغل (إعادة تشغيل أو عطل). تقدر تستأنف المهمة من حيث وقفت.'],
  [/WAITING_FOR_CAPACITY|NO_FREE_CAPACITY|free model capacity/i, 'ننتظر سعة مجانية من النماذج، والعمل بيكمل بروحه.'],
  [/CAPACITY_WAIT_EXHAUSTED/i, 'المكتب انتظر وقت طويل سعة مجانية من النماذج ووقف. استأنف المهمة لاحقًا، أو اسمح بنموذج ثاني من الإعدادات.'],
  [/\b429\b|RATE_LIMIT|rate.?limit|too many requests|quota|COOLDOWN_QUOTA/i, 'السعة المجانية للنماذج ممتلئة حاليًا، والعمل بيكمل بروحه.'],
  [/AccessDenied|Unpurchased|ACCOUNT_BLOCKED|auth_error|PROVIDER_AUTH|invalid api key|\b403\b.*provider|provider.*\b403\b|provider blocked/i, 'هذا المزوّد يحتاج إجراء في الحساب (الإعدادات ← النماذج).'],
  [/NO_ELIGIBLE_PROVIDER|NO_ALLOWED_MODEL|No allowed model|ALL_PROVIDERS_UNAVAILABLE/i, 'ما في نموذج مسموح يقدر يسوي هالخطوة الحين. استأنفها لاحقًا أو راجع النماذج في الإعدادات.'],
  [/BUDGET|spend limit|budget exceeded/i, 'ميزانية هالشهر خلصت. ما بيشتغل شي مدفوع إلا إذا رفعتها من الإعدادات.'],
  [/please sign in|\b401\b|unauthori[sz]ed/i, 'سجّل دخولك مرة ثانية.'],
  [/Failed to fetch|NetworkError|network error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|timed? ?out/i, 'ما قدرنا نوصل للمكتب الحين. بنعيد المحاولة؛ تأكد من الاتصال إذا تكرر.'],
  [/exhausted its attempts|gave up|after exhausting retries/i, 'الخطوة تعثّرت بعد أكثر من محاولة. تقدر تستأنف المهمة، وما تم تسليمه يبقى محفوظ.'],
  [/\b5\d\d\b|internal server error|Could not load Office data/i, 'صار خلل من جهة المكتب. جرّب بعد شوي — ما ضاع شي.'],
];

export function humanError(message, lang = 'en') {
  const text = String(message || '').trim();
  const ar = lang === 'ar';
  if (!text) return ar ? 'صار خلل. جرّب بعد شوي.' : 'Something went wrong. Try again in a moment.';
  for (const [pattern, words] of ar ? RULES_AR : RULES) if (pattern.test(text)) return words;
  if (ar) return 'تعثّرت المهمة بسبب مشكلة تقنية. التفاصيل تحت، وتقدر تستأنفها.';
  return text.length > 240 ? `${text.slice(0, 237)}…` : text;
}

// A human sentence plus the original under "View details" (HTML, escaped).
export function errorBlock(message, escape) {
  const human = humanError(message);
  const raw = String(message || '').trim();
  return `<div class="error-note" role="alert">${escape(human)}${raw && raw !== human ? `<details class="error-details"><summary>View details</summary><code dir="ltr">${escape(raw.slice(0, 1200))}</code></details>` : ''}</div>`;
}
