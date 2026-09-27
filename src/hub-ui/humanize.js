// Technical infrastructure problems in human language. The original text is
// kept for "View details"; this only chooses the words Fahad reads first.
const RULES = [
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

export function humanError(message) {
  const text = String(message || '').trim();
  if (!text) return 'Something went wrong. Try again in a moment.';
  for (const [pattern, words] of RULES) if (pattern.test(text)) return words;
  return text.length > 240 ? `${text.slice(0, 237)}…` : text;
}

// A human sentence plus the original under "View details" (HTML, escaped).
export function errorBlock(message, escape) {
  const human = humanError(message);
  const raw = String(message || '').trim();
  return `<div class="error-note" role="alert">${escape(human)}${raw && raw !== human ? `<details class="error-details"><summary>View details</summary><code dir="ltr">${escape(raw.slice(0, 1200))}</code></details>` : ''}</div>`;
}
