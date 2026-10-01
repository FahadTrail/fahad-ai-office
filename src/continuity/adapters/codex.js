// Verified locally on 2026-10-01 against codex-cli 0.158.0-alpha.2.1:
//   codex exec --json --sandbox workspace-write --approve-for-me -C <worktree> -
//   codex exec resume --json <session-id> -
// JSONL output and resume are official CLI surfaces. The adapter never reads
// consumer cookies or OAuth tokens and never claims quota the CLI did not emit.
import { spawn as nodeSpawn } from 'node:child_process';
import { normalizedStatus, unknownUsage } from '../adapter-contract.js';

function parseLines(state, chunk) {
  state.buffer += chunk.toString('utf8');
  const lines = state.buffer.split(/\r?\n/);
  state.buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      state.events.push(event);
      state.id ||= event.thread_id || event.session_id || event.thread?.id || (event.type === 'thread.started' ? event.thread_id : null);
      const usage = event.usage || event.token_usage || event.info?.usage;
      if (usage) state.usage = usage;
    } catch { state.events.push({ type: 'unparsed', text: line.slice(0, 2000) }); }
  }
}
export class CodexContinuityAdapter {
  key = 'codex';

  constructor({ spawn = nodeSpawn, probe = async () => ({ ok: false, reason: 'NOT_CONFIGURED' }), inspectCheckpoint, enabled = false, stopTimeoutMs = 30_000 } = {}) {
    this.spawn = spawn;
    this.probe = probe;
    this.inspectCheckpoint = inspectCheckpoint;
    this.enabled = enabled;
    this.stopTimeoutMs = stopTimeoutMs;
    this.sessions = new Map();
  }

  capabilities() {
    return {
      headless: true, resume: true, structuredOutput: true, usageReporting: 'when-emitted', worktrees: true,
      worktreeManagement: 'supervisor',
      maxContext: null, privacyClasses: ['PUBLIC', 'NORMAL', 'PRIVATE'], taskSizes: ['small', 'medium', 'large', 'refactor'],
      taskTypes: ['coding'], quality: 5, taskFit: { small: 4, medium: 5, large: 5, refactor: 5 }, speed: 4,
      costClass: 'included', quotaSource: 'openai-chatgpt', cliVersion: '0.158.0-alpha.2.1',
    };
  }

  async available() {
    if (!this.enabled) return { ok: false, reason: 'NOT_CONFIGURED' };
    return this.probe();
  }

  async health() {
    const available = await this.available();
    return { status: available.ok ? 'healthy' : 'down', basis: 'MEASURED', detail: available.reason || 'codex CLI available' };
  }

  launch(args, prompt, worktree) {
    if (!worktree) throw new Error('CODEX_WORKTREE_REQUIRED');
    const child = this.spawn('codex', args, { cwd: worktree, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const state = { child, id: null, events: [], usage: null, buffer: '', exitCode: null, error: null, worktree };
    child.stdout?.on('data', (chunk) => parseLines(state, chunk));
    child.stderr?.on('data', (chunk) => { state.error = chunk.toString('utf8').slice(-2000); });
    child.on?.('error', (error) => { state.error = error.message; state.exitCode = -1; });
    child.on?.('exit', (code) => { state.exitCode = code; });
    child.stdin?.end(prompt);
    return state;
  }

  async start({ continuationPacket, worktree }) {
    const state = this.launch(['exec', '--json', '--sandbox', 'workspace-write', '--approve-for-me', '-C', worktree, '-'], continuationPacket, worktree);
    const key = `pending-${Date.now()}-${this.sessions.size}`;
    this.sessions.set(key, state);
    return { session: { id: key, worktree }, process: state.child };
  }

  async resume({ session, continuationPacket }) {
    const previous = this.sessions.get(session.id);
    const cliId = previous?.id || session.cliSessionId;
    if (!cliId) throw new Error('CODEX_RESUME_SESSION_ID_UNKNOWN');
    const state = this.launch(['exec', 'resume', '--json', cliId, '-'], continuationPacket, session.worktree);
    this.sessions.set(session.id, state);
    return { session };
  }

  async stop({ session, reason }) {
    const state = this.sessions.get(session.id);
    if (!state) return { stopped: false, reason: 'SESSION_NOT_FOUND' };
    state.stopReason = reason;
    if (state.exitCode != null || state.child.exitCode != null) return { stopped: true, draining: false };
    await new Promise((resolve, reject) => {
      const child = state.child;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener('exit', onExit);
        child.removeListener('error', onError);
        if (error) reject(error);
        else resolve();
      };
      const onExit = () => finish();
      const onError = (error) => finish(error);
      const timer = setTimeout(() => finish(new Error('CODEX_STOP_UNCONFIRMED')), this.stopTimeoutMs);
      child.once('exit', onExit);
      child.once('error', onError);
      try {
        if (child.kill?.('SIGTERM') === false && state.exitCode == null && child.exitCode == null) {
          finish(new Error('CODEX_STOP_UNCONFIRMED'));
        }
      } catch (error) { finish(error); }
    });
    return { stopped: true, draining: false };
  }

  async status({ session }) {
    const state = this.sessions.get(session.id);
    if (!state) return normalizedStatus(this.key, session, 'UNAVAILABLE', { error: 'SESSION_NOT_FOUND' });
    const status = state.exitCode == null ? 'ACTIVE' : state.exitCode === 0 ? 'CHECKPOINTING' : 'FAILED';
    return normalizedStatus(this.key, { ...session, cliSessionId: state.id }, status, { usage: await this.usage({ session }), error: state.error, health: 'healthy' });
  }

  async usage({ session }) {
    const raw = this.sessions.get(session?.id)?.usage;
    if (!raw) return unknownUsage();
    const taskTokens = Number(raw.total_tokens ?? raw.total ?? (Number(raw.input_tokens || 0) + Number(raw.output_tokens || 0)));
    return { task_tokens: Number.isFinite(taskTokens) ? taskTokens : null, session_pct: null, weekly_pct: null, reset_at: raw.reset_at || null, basis: 'PROVIDER_REPORTED' };
  }

  async checkpoint({ session, context }) {
    if (!this.inspectCheckpoint && !context?.checkpoint) throw new Error('CODEX_CHECKPOINT_INSPECTOR_REQUIRED');
    // The caller's checkpoint is a baseline, not proof of the current Git
    // head. Inspect the worktree before every handoff when an inspector exists.
    const payload = this.inspectCheckpoint
      ? await this.inspectCheckpoint({ session, state: this.sessions.get(session.id), context })
      : context.checkpoint;
    return { payload, nativeCheckpointId: null };
  }

  async handoff({ session, context }) {
    return { checkpoint: await this.checkpoint({ session, context }), packet: context?.packet || null };
  }
}
