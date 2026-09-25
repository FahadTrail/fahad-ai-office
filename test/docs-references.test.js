import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Documentation must not drift from the code: every repository path quoted
// in `backticks` in the agent handoff docs has to exist.
const root = new URL('..', import.meta.url).pathname;
const PATH_RE = /`((?:src|test|testing|docs|ops|supabase|\.github)\/[^`\s]+)`/g;

function docs() {
  const files = ['AGENTS.md', 'CLAUDE.md', 'README.md'].filter((file) => existsSync(join(root, file)));
  const walk = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory()
    ? walk(`${dir}/${entry.name}`) : entry.name.endsWith('.md') ? [`${dir}/${entry.name}`] : []));
  return [...files, ...walk('docs')];
}

test('repository paths referenced in the documentation exist', () => {
  const missing = [];
  for (const file of docs()) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const [, raw] of text.matchAll(PATH_RE)) {
      const path = raw.replace(/[.,;:)]+$/, '').replace(/[#?].*$/, '').replace(/\s*→.*$/, '');
      if (/[*<>{}]/.test(path)) continue; // globs and placeholders
      if (!existsSync(join(root, path))) missing.push(`${file} references missing path ${path}`);
    }
  }
  assert.deepEqual(missing, [], missing.join('\n'));
});
