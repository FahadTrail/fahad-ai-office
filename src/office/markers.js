// Control markers in a request are routing metadata, not message text.
// [free-only] / [مجاني فقط] keep one objective on free routes; they are
// removed before the request is stored or shown, and kept as jobs.free_only.
export const FREE_ONLY_MARKER = /\[(free-only|مجاني فقط)\]/i;
const FREE_ONLY_MARKERS = /\[(free-only|مجاني فقط)\]/gi;

export function extractFreeOnly(text) {
  const raw = String(text ?? '');
  if (!FREE_ONLY_MARKER.test(raw)) return { text: raw, freeOnly: false };
  return { text: raw.replace(FREE_ONLY_MARKERS, ' ').replace(/[ \t]{2,}/g, ' ').trim(), freeOnly: true };
}
