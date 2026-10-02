// Manual, local-only measurement scaffold. It records metadata, never file content.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const directory = join(root, 'graphify-out', 'benchmarks');
const [action, idOrMode, value] = process.argv.slice(2);
const safeId = /^[0-9a-f-]{36}$/i;

async function record(id) {
  if (!safeId.test(id || '')) throw new Error('Expected a benchmark run ID');
  return JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8'));
}
async function save(row) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${row.id}.json`), `${JSON.stringify(row, null, 2)}\n`, { mode: 0o600 });
}

try {
  if (action === 'begin') {
    if (!['without', 'with'].includes(idOrMode) || !value) throw new Error('Usage: begin without|with "task label"');
    const row = { id: randomUUID(), mode: idOrMode, task: String(value).slice(0, 200), startedAt: new Date().toISOString(),
      finishedAt: null, graphQueries: 0, filesOpened: [], bytesRead: 0, estimatedContextTokens: 0 };
    await save(row);
    process.stdout.write(`${row.id}\n`);
  } else if (action === 'file') {
    const row = await record(idOrMode);
    const path = String(value || '').replaceAll('\\', '/');
    const absolute = resolve(root, path);
    const rel = relative(root, absolute);
    if (!/^(?:src\/|test\/|supabase\/migrations\/)[A-Za-z0-9_./-]+$/.test(path)
      || /secret|credential|hermes|\.env|private.?key/i.test(path) || !rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('Only non-sensitive repository code paths may be recorded');
    }
    const bytes = Number(process.argv[5] || (await stat(absolute)).size);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Bytes must be a non-negative integer');
    row.filesOpened.push({ path, bytes });
    row.bytesRead += bytes;
    row.estimatedContextTokens = Math.ceil(row.bytesRead / 4);
    await save(row);
  } else if (action === 'query') {
    const row = await record(idOrMode);
    row.graphQueries += 1;
    await save(row);
  } else if (action === 'finish') {
    const row = await record(idOrMode);
    row.finishedAt = new Date().toISOString();
    row.identificationMs = Date.parse(row.finishedAt) - Date.parse(row.startedAt);
    await save(row);
    process.stdout.write(`${JSON.stringify(row, null, 2)}\n`);
  } else throw new Error('Usage: begin|file|query|finish (see docs/GRAPHIFY.md)');
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
