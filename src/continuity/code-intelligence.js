// Optional, local, read-only navigation over an existing Graphify code graph.
// This module never builds a graph, reads secrets or affects task correctness.
import { execFile as nodeExecFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { isSafeCodeHintPath } from '../coding-agent/policy.js';

const execFile = promisify(nodeExecFile);
const allowed = /^(?:src\/|test\/|supabase\/migrations\/)[A-Za-z0-9_./-]+$/;
const unavailable = (reason) => ({ available: false, reason, text: '', files: [] });

function filesIn(output, root) {
  const files = new Set();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/\[src=([^\]\s]+) loc=/);
    if (!match) continue;
    const path = match[1].replaceAll('\\', '/');
    if (!allowed.test(path) || !isSafeCodeHintPath(path)) continue;
    const rel = relative(root, resolve(root, path));
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) files.add(path);
    if (files.size >= 12) break;
  }
  return [...files];
}

export function createCodeIntelligence({ root, enabled = false, binary = 'graphify', graphPath = null,
  run = execFile, timeoutMs = 8_000 } = {}) {
  if (!root || !isAbsolute(root)) throw new TypeError('Code intelligence needs an absolute repository root');
  const repository = resolve(root);
  const graph = resolve(graphPath || resolve(repository, 'graphify-out', 'graph.json'));

  async function invoke(args) {
    if (!enabled) return unavailable('DISABLED');
    const rel = relative(repository, graph);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return unavailable('GRAPH_OUTSIDE_REPOSITORY');
    try {
      const entry = await lstat(graph);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 64 * 1024 * 1024) return unavailable('GRAPH_UNSAFE');
      const actualRoot = await realpath(repository);
      const actualGraph = await realpath(graph);
      const actualRelative = relative(actualRoot, actualGraph);
      if (!actualRelative || actualRelative.startsWith('..') || isAbsolute(actualRelative)) return unavailable('GRAPH_UNSAFE');
    } catch { return unavailable('GRAPH_MISSING'); }
    const env = { GRAPHIFY_QUERY_LOG_DISABLE: '1', PYTHONUTF8: '1', PYTHONNOUSERSITE: '1' };
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    try {
      const { stdout } = await run(binary, [...args, '--graph', graph], {
        cwd: repository, env, timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024,
      });
      const text = String(stdout || '').slice(0, 12_000);
      return { available: true, reason: null, text, files: filesIn(text, repository) };
    } catch { return unavailable('GRAPHIFY_UNAVAILABLE'); }
  }

  const queryArchitecture = (question) => {
    if (typeof question !== 'string' || !question.trim() || question.length > 500) return Promise.resolve(unavailable('QUESTION_INVALID'));
    return invoke(['query', question.trim(), '--budget', '900']);
  };
  return {
    queryArchitecture,
    getRelatedFiles: (symbolOrPath) => queryArchitecture(symbolOrPath),
    traceDependency(source, target) {
      if (![source, target].every((value) => typeof value === 'string' && value.length > 0 && value.length <= 200)) {
        return Promise.resolve(unavailable('QUESTION_INVALID'));
      }
      return invoke(['path', source, target, '--undirected']);
    },
    async getContextForTask(task) {
      const objective = String(task?.objective || task?.title || '').slice(0, 400);
      if (!objective) return unavailable('QUESTION_INVALID');
      const result = await queryArchitecture(objective);
      return { ...result, files: result.files.slice(0, 8) };
    },
  };
}
