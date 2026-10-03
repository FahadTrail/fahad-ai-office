import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { redact } from '../coding-agent/policy.js';
import { classifyCliFailure, continuityError } from './errors.js';

const SYSTEM_ENV = Object.freeze([
  'PATH', 'Path', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME',
  'XDG_DATA_HOME', 'XDG_STATE_HOME', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TMP', 'TEMP',
  'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'CI', 'GIT_CONFIG_GLOBAL', 'GIT_SSH_COMMAND',
  'SSH_AUTH_SOCK', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
]);

function limitedEnv(source, extraKeys) {
  const env = {};
  for (const key of [...SYSTEM_ENV, ...extraKeys]) if (source[key] !== undefined) env[key] = source[key];
  return env;
}

function boundedText(value, env, length = 1000) {
  return redact(String(value || '').slice(-length), env, length);
}

export function externalFailureEvidence(state, limit = 4000) {
  const source = state || {};
  return [
    `${source.errorCode || ''} exit=${source.exitCode}`,
    `stderr=${JSON.stringify(String(source.stderr || '').slice(-limit))}`,
    `stdout=${JSON.stringify(String(source.stdoutTail || '').slice(-limit))}`,
  ].join(' ');
}

export class ExternalWorkerDriver {
  constructor({ spawn = nodeSpawn, execFile = nodeExecFile, env = process.env, maxLineBytes = 1024 * 1024 } = {}) {
    this.spawn = spawn;
    this.execFile = execFile;
    this.env = env;
    this.maxLineBytes = maxLineBytes;
  }

  environment(extraKeys = []) { return limitedEnv(this.env, extraKeys); }

  inspect(binary, args, { extraEnvKeys = [], timeoutMs = 10_000, stderrLimit = 1000 } = {}) {
    return new Promise((resolve) => {
      this.execFile(binary, args, {
        windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024,
        env: this.environment(extraEnvKeys),
      }, (error, stdout, stderr) => resolve({
        ok: !error, exitCode: error?.code ?? 0,
        stdout: String(stdout || '').slice(0, 64 * 1024),
        // Error classification wants the tail of stderr; a verifier that
        // parses a full help text raises the bound explicitly for that call.
        stderr: boundedText(stderr, this.env, stderrLimit),
        missing: error?.code === 'ENOENT',
      }));
    });
  }

  launch({ binary, args, prompt, cwd, extraEnvKeys = [], timeoutMs = 60 * 60_000, onEvent = () => {} }) {
    if (!isAbsolute(cwd || '')) throw continuityError('WORKTREE_UNSAFE');
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) throw new TypeError('CLI arguments must be a string list');
    const child = this.spawn(binary, args, {
      cwd, env: this.environment(extraEnvKeys), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const state = {
      child, cwd, id: null, usage: null, lastEvent: null, eventCount: 0, exitCode: null,
      signal: null, errorCode: null, stderr: '', stdoutTail: '', buffer: '', timedOut: false, finished: false,
    };
    let resolveDone;
    state.done = new Promise((resolve) => { resolveDone = resolve; });
    const finish = (code, signal) => {
      if (state.finished) return;
      state.finished = true;
      clearTimeout(timer);
      state.exitCode = code;
      state.signal = signal;
      if (state.buffer.trim()) consume(state.buffer);
      state.buffer = '';
      state.errorCode ||= classifyCliFailure({ event: state.providerFailure || state.lastEvent, exitCode: state.providerFailure ? 1 : code, stderr: state.stderr, timedOut: state.timedOut });
      if (!state.errorCode && !state.resultSeen) state.errorCode = 'WORKER_OUTPUT_INVALID';
      resolveDone(state);
    };
    const consume = (line) => {
      if (!line.trim()) return;
      if (Buffer.byteLength(line) > this.maxLineBytes) { state.errorCode = 'WORKER_OUTPUT_INVALID'; return; }
      try {
        const event = JSON.parse(line);
        state.eventCount++;
        onEvent(event, state);
      } catch { state.errorCode = 'WORKER_OUTPUT_INVALID'; }
    };
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      state.stdoutTail = boundedText(state.stdoutTail + text, this.env, 4000);
      state.buffer += text;
      if (Buffer.byteLength(state.buffer) > this.maxLineBytes * 2) { state.errorCode = 'WORKER_OUTPUT_INVALID'; child.kill('SIGTERM'); return; }
      const lines = state.buffer.split(/\r?\n/);
      state.buffer = lines.pop() || '';
      for (const line of lines) consume(line);
    });
    child.stderr?.on('data', (chunk) => { state.stderr = boundedText(state.stderr + chunk.toString('utf8'), this.env); });
    child.once('error', (error) => { state.errorCode = error.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'WORKER_CRASHED'; finish(-1, null); });
    child.once('close', finish);
    const timer = setTimeout(() => {
      state.timedOut = true;
      state.errorCode = 'WORKER_TIMEOUT';
      child.kill('SIGTERM');
      setTimeout(() => { if (!state.finished) child.kill('SIGKILL'); }, 5_000).unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdin?.on('error', () => { /* The child may exit before consuming input. */ });
    child.stdin?.end(String(prompt || ''));
    return state;
  }

  async stop(state, { gracefulMs = 10_000, terminateMs = 10_000 } = {}) {
    if (!state) return { stopped: false, reason: 'SESSION_NOT_FOUND' };
    if (state.finished) return { stopped: true, exitCode: state.exitCode };
    const wait = (ms) => Promise.race([state.done.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), ms))]);
    try { state.child.kill('SIGINT'); } catch { /* Fall through to termination. */ }
    if (!(await wait(gracefulMs))) {
      try { state.child.kill('SIGTERM'); } catch { /* Fall through to forced stop. */ }
      if (!(await wait(terminateMs))) {
        try { state.child.kill('SIGKILL'); } catch { /* Remains unconfirmed. */ }
        if (!(await wait(5_000))) throw continuityError('WORKER_STOP_UNCONFIRMED');
      }
    }
    return { stopped: true, exitCode: state.exitCode };
  }
}
