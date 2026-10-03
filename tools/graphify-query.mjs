// Developer-only Graphify entry point. No hook, service, API key or runtime dependency.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const localBinary = join(root, '.graphify-venv', process.platform === 'win32' ? 'Scripts/graphify.exe' : 'bin/graphify');
const binary = process.env.GRAPHIFY_BIN || (existsSync(localBinary) ? localBinary : 'graphify');

function localEnv() {
  const result = { GRAPHIFY_QUERY_LOG_DISABLE: '1', PYTHONUTF8: '1', PYTHONNOUSERSITE: '1' };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'LANG']) {
    if (process.env[key]) result[key] = process.env[key];
  }
  return result;
}

async function run(args, timeoutMs = 120_000) {
  return new Promise((res, rej) => {
    const child = spawn(binary, args, { cwd: root, env: localEnv(), stdio: 'inherit', windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    timer.unref?.();
    child.once('error', (error) => { clearTimeout(timer); rej(error); });
    child.once('close', (code) => { clearTimeout(timer); code === 0 ? res() : rej(new Error(`Graphify exited ${code}`)); });
  });
}

const [action, ...rest] = process.argv.slice(2);
try {
  if (process.env.GRAPHIFY_BIN && !isAbsolute(process.env.GRAPHIFY_BIN)) throw new Error('GRAPHIFY_BIN must be an absolute executable path');
  if (action === 'build') {
    await run(['extract', '.', '--code-only', '--max-workers', '4']);
    await run(['cluster-only', '.', '--no-label']);
  } else if (action === 'update') {
    await run(['update', '.']);
    await run(['cluster-only', '.', '--no-label']);
  } else if (action === 'query' || (action && !['build', 'update', 'path'].includes(action) && !action.startsWith('-'))) {
    const question = (action === 'query' ? rest : [action, ...rest]).join(' ').trim();
    if (!question || question.length > 500) throw new Error('Provide a question of 1–500 characters');
    await run(['query', question, '--graph', 'graphify-out/graph.json', '--budget', '900'], 15_000);
  } else if (action === 'path') {
    if (rest.length !== 2) throw new Error('Usage: graphify-query.mjs path <source> <target>');
    await run(['path', rest[0], rest[1], '--undirected', '--graph', 'graphify-out/graph.json'], 15_000);
  } else {
    throw new Error('Usage: graphify-query.mjs build|update|query <question>|path <source> <target>');
  }
} catch (error) {
  process.stderr.write(`Graphify is optional: ${error.message}\n`);
  process.exitCode = 1;
}
