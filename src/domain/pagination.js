// Stable cursor pagination for derived lists. The cursor is the last returned
// id. Items must already be ordered. An unknown cursor fails closed.

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 30;

export function pageLimit(value, { max = MAX_LIMIT, fallback = DEFAULT_LIMIT } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(max, parsed);
}

export function encodeCursor(id) {
  return Buffer.from(String(id), 'utf8').toString('base64url');
}

export function decodeCursor(cursor) {
  if (cursor == null || cursor === '') return null;
  try {
    const id = Buffer.from(String(cursor), 'base64url').toString('utf8');
    if (!id || id.length > 200) throw new Error('bad cursor');
    return id;
  } catch {
    throw Object.assign(new Error('INVALID_CURSOR'), { statusCode: 400 });
  }
}

export function paginate(items, { limit = DEFAULT_LIMIT, cursor = null, idOf = (item) => item.id } = {}) {
  const size = pageLimit(limit);
  const token = cursor ? decodeCursor(cursor) : null;
  let start = 0;
  if (token) {
    const index = items.findIndex((item) => idOf(item) === token);
    if (index < 0) throw Object.assign(new Error('INVALID_CURSOR'), { statusCode: 400 });
    start = index + 1;
  }
  const slice = items.slice(start, start + size);
  const more = items.length > start + size;
  const last = slice.at(-1);
  return {
    items: slice,
    page: {
      limit: size,
      returned: slice.length,
      hasMore: more,
      nextCursor: more && last ? encodeCursor(idOf(last)) : null,
    },
  };
}

export function matchesQuery(parts, query) {
  const term = String(query || '').trim().toLowerCase();
  if (term.length < 1) return true;
  return parts.filter((part) => part != null && part !== '').join('\n').toLowerCase().includes(term);
}
