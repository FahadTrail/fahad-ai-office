// A small in-memory stand-in for the supabase-js query builder, enough for
// the Hub's read paths (and simple writes) in tests and the UI preview.
// Supports select (column lists, JSON arrows ignored), eq/neq/in/gte/gt/
// lte/lt/is/not/like/ilike/contains/or (simple), order, limit, range,
// single, maybeSingle, insert, update, upsert, delete and rpc stubs.

const pick = (row, columns) => {
  if (!columns || columns === '*') return { ...row };
  const out = {};
  for (const column of columns.split(',').map((part) => part.trim()).filter(Boolean)) {
    const name = column.replace(/:.*$/, '').replace(/\(.*$/, '');
    if (name in row) out[name] = row[name];
  }
  return out;
};

const read = (row, key) => {
  const arrow = key.match(/^([a-z_]+)->>?([a-z_]+)$/i);
  if (arrow) return row[arrow[1]]?.[arrow[2]];
  return row[key];
};

let counter = 0;
const newId = () => {
  counter += 1;
  const hex = counter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
};

export function memoryPostgrest(tables = {}, { rpc = {} } = {}) {
  const from = (name) => {
    tables[name] ||= [];
    const filters = [];
    let columns = '*';
    let orders = [];
    let limit = null;
    let offset = 0;
    let mode = 'select';
    let payload = null;
    let single = null;
    let returning = false;
    const api = {
      select(cols = '*') { if (mode === 'select') columns = cols; else { returning = true; columns = cols; } return api; },
      eq(key, value) { filters.push((row) => String(read(row, key)) === String(value)); return api; },
      neq(key, value) { filters.push((row) => String(read(row, key)) !== String(value)); return api; },
      in(key, values) { const set = new Set(values.map(String)); filters.push((row) => set.has(String(read(row, key)))); return api; },
      gte(key, value) { filters.push((row) => String(read(row, key) ?? '') >= String(value)); return api; },
      gt(key, value) { filters.push((row) => String(read(row, key) ?? '') > String(value)); return api; },
      lte(key, value) { filters.push((row) => String(read(row, key) ?? '') <= String(value)); return api; },
      lt(key, value) { filters.push((row) => String(read(row, key) ?? '') < String(value)); return api; },
      is(key, value) { filters.push((row) => (read(row, key) ?? null) === value); return api; },
      not(key, op, value) { if (op === 'is') filters.push((row) => (read(row, key) ?? null) !== value); return api; },
      like(key, pattern) { const re = new RegExp(`^${String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`); filters.push((row) => re.test(String(read(row, key) ?? ''))); return api; },
      ilike(key, pattern) { const re = new RegExp(`^${String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, 'i'); filters.push((row) => re.test(String(read(row, key) ?? ''))); return api; },
      contains(key, value) { filters.push((row) => (Array.isArray(value) ? value.every((item) => (read(row, key) || []).includes(item)) : true)); return api; },
      or() { return api; },
      filter(key, op, value) { if (op === 'eq') return api.eq(key, value); return api; },
      match(object) { for (const [key, value] of Object.entries(object)) api.eq(key, value); return api; },
      order(key, { ascending = true } = {}) { orders.push([key, ascending]); return api; },
      limit(value) { limit = value; return api; },
      range(start, end) { offset = start; limit = end - start + 1; return api; },
      single() { single = 'single'; return api; },
      maybeSingle() { single = 'maybe'; return api; },
      insert(value) { mode = 'insert'; payload = value; return api; },
      upsert(value) { mode = 'upsert'; payload = value; return api; },
      update(value) { mode = 'update'; payload = value; return api; },
      delete() { mode = 'delete'; return api; },
      then(resolve, reject) { try { resolve(run()); } catch (error) { reject?.(error); } },
    };
    const matched = () => tables[name].filter((row) => filters.every((fn) => fn(row)));
    const finish = (list) => {
      const shaped = list.map((row) => pick(row, columns));
      if (single === 'single') return shaped.length === 1 ? { data: shaped[0], error: null } : { data: null, error: { message: 'Expected one row' } };
      if (single === 'maybe') return { data: shaped[0] || null, error: null };
      return { data: shaped, error: null, count: shaped.length };
    };
    const run = () => {
      if (mode === 'insert' || mode === 'upsert') {
        const list = (Array.isArray(payload) ? payload : [payload]).map((row) => ({ id: newId(), created_at: new Date().toISOString(), ...row }));
        tables[name].push(...list);
        return returning || single ? finish(list) : { data: null, error: null };
      }
      if (mode === 'update') {
        const list = matched();
        for (const row of list) Object.assign(row, payload);
        return returning || single ? finish(list) : { data: null, error: null };
      }
      if (mode === 'delete') {
        const doomed = new Set(matched());
        tables[name] = tables[name].filter((row) => !doomed.has(row));
        return { data: null, error: null };
      }
      let list = matched();
      for (const [key, ascending] of orders.toReversed()) {
        list = list.toSorted((a, b) => {
          const [left, right] = [read(a, key), read(b, key)];
          const compare = typeof left === 'number' && typeof right === 'number' ? left - right : String(left ?? '').localeCompare(String(right ?? ''));
          return ascending ? compare : -compare;
        });
      }
      if (offset) list = list.slice(offset);
      if (limit != null) list = list.slice(0, limit);
      return finish(list);
    };
    return api;
  };
  return {
    tables,
    from,
    rpc: async (name, args) => (rpc[name] ? rpc[name](args, tables) : { data: null, error: { message: `rpc ${name} is not available in the preview` } }),
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  };
}
