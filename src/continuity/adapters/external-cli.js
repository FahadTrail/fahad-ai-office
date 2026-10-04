import { randomUUID } from 'node:crypto';
import { ExternalWorkerDriver } from '../external-driver.js';
import { normalizedStatus, unknownUsage } from '../adapter-contract.js';
import { continuityError } from '../errors.js';

export function parseCliVersion(value) {
  const match = String(value || '').match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?/i);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}

export function versionAtLeast(version, minimum) {
  if (!version) return false;
  for (const field of ['major', 'minor', 'patch']) {
    if (version[field] !== minimum[field]) return version[field] > minimum[field];
  }
  return true;
}

export class ExternalCliAdapter {
  constructor({ key, binary, enabled = false, driver = new ExternalWorkerDriver(), inspectCheckpoint,
    envKeys = [], timeoutMs = 60 * 60_000, minimumVersion, maximumMajor, versionArgs = ['--version'],
    platform = process.platform } = {}) {
    this.key = key;
    this.binary = binary;
    this.enabled = enabled;
    this.driver = driver;
    this.inspectCheckpoint = inspectCheckpoint;
    this.envKeys = envKeys;
    this.timeoutMs = timeoutMs;
    this.minimumVersion = minimumVersion;
    this.maximumMajor = maximumMajor;
    this.versionArgs = versionArgs;
    this.platform = platform;
    this.sessions = new Map();
    this.lastProbe = null;
  }

  async probe() {
    if (!this.enabled) return { ok: false, authState: 'OWNER_ACTION_REQUIRED', reason: 'NOT_CONFIGURED' };
    if (this.lastProbe && Date.now() - this.lastProbe.at < 60_000) return this.lastProbe.value;
    const versionResult = await this.driver.inspect(this.binary, this.versionArgs, { extraEnvKeys: this.envKeys });
    let value;
    if (versionResult.missing) value = { ok: false, authState: 'CLI_NOT_INSTALLED', reason: 'CLI_NOT_FOUND' };
    else if (!versionResult.ok) value = { ok: false, authState: 'OWNER_ACTION_REQUIRED', reason: 'CLI_VERSION_UNAVAILABLE' };
    else {
      const version = parseCliVersion(versionResult.stdout || versionResult.stderr);
      if (!versionAtLeast(version, this.minimumVersion) || version.major >= this.maximumMajor) {
        value = { ok: false, authState: 'UNSUPPORTED_VERSION', reason: 'UNSUPPORTED_VERSION', version };
      } else {
        const features = await this.verifyFeatures(version);
        if (!features.ok) value = { ok: false, authState: 'UNSUPPORTED_VERSION', reason: 'UNSUPPORTED_VERSION', version };
        else {
          // A working login is not enough: the host must also be able to run
          // this worker's isolation layer, or every write would fail later.
          const sandbox = await this.verifySandbox();
          if (!sandbox.ok) value = { ok: false, authState: 'HOST_CAPABILITY_REQUIRED', reason: 'SANDBOX_UNAVAILABLE', version, features, detail: sandbox.detail || null };
          else {
            const auth = await this.verifyAuth();
            value = { ok: auth.ok, authState: auth.ok ? 'AUTHENTICATED' : 'NOT_AUTHENTICATED', reason: auth.ok ? null : 'AUTH_REQUIRED', version, features };
          }
        }
      }
    }
    this.lastProbe = { at: Date.now(), value };
    return value;
  }

  async available() { return this.probe(); }
  async authReadiness() { return this.probe(); }
  async health() {
    const probe = await this.probe();
    return { status: probe.ok ? 'healthy' : 'down', basis: 'MEASURED', detail: probe.reason || 'CLI ready' };
  }

  async verifyFeatures() { return { ok: true }; }
  async verifyAuth() { return { ok: false }; }
  // Host isolation capability (user namespaces, sandbox binary, policy).
  // Workers without an OS sandbox inherit the safe default.
  async verifySandbox() { return { ok: true }; }
  command() { throw new TypeError('ExternalCliAdapter.command is required'); }
  consumeEvent() { throw new TypeError('ExternalCliAdapter.consumeEvent is required'); }

  async launch({ continuationPacket, worktree, resumeId = null }) {
    const probe = await this.available();
    if (!probe.ok) throw continuityError(probe.reason === 'UNSUPPORTED_VERSION' ? 'UNSUPPORTED_VERSION' : probe.reason === 'CLI_NOT_FOUND' ? 'CLI_NOT_FOUND' : probe.reason === 'SANDBOX_UNAVAILABLE' ? 'SANDBOX_UNAVAILABLE' : 'AUTH_REQUIRED');
    if (!this.inspectCheckpoint) throw continuityError('CHECKPOINT_FAILED');
    const command = this.command({ worktree, resumeId, probe });
    const binary = Array.isArray(command) ? this.binary : command?.binary;
    const args = Array.isArray(command) ? command : command?.args;
    if (!binary || !Array.isArray(args)) throw new TypeError('External CLI command must be an argument list or { binary, args }');
    const state = this.driver.launch({
      binary, args, prompt: continuationPacket,
      cwd: worktree, extraEnvKeys: this.envKeys, timeoutMs: this.timeoutMs,
      onEvent: (event, current) => this.consumeEvent(event, current),
    });
    const id = randomUUID();
    this.sessions.set(id, state);
    return { session: { id, worktree, cliSessionId: resumeId }, process: state.child };
  }

  async start({ continuationPacket, worktree }) { return this.launch({ continuationPacket, worktree }); }
  async resume({ session, continuationPacket }) {
    const previous = this.sessions.get(session.id);
    const cliId = previous?.id || session.cliSessionId;
    if (!cliId) throw continuityError('CHECKPOINT_FAILED');
    return this.launch({ continuationPacket, worktree: session.worktree, resumeId: cliId });
  }

  async stop({ session }) {
    const state = this.sessions.get(session.id);
    const result = await this.driver.stop(state);
    if (!result.stopped) throw continuityError('WORKER_STOP_UNCONFIRMED');
    return { stopped: true, draining: false, exitCode: result.exitCode };
  }

  async status({ session }) {
    const state = this.sessions.get(session.id);
    if (!state) return normalizedStatus(this.key, session, 'UNAVAILABLE', { error: 'SESSION_NOT_FOUND' });
    const code = state.errorCode;
    const status = !state.finished ? 'ACTIVE' : !code && state.exitCode === 0 ? 'CHECKPOINTING'
      : code === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : code === 'RATE_LIMITED' ? 'RATE_LIMITED'
        : code === 'QUOTA_EXHAUSTED' ? 'QUOTA_EXHAUSTED' : 'FAILED';
    return normalizedStatus(this.key, { ...session, cliSessionId: state.id }, status, {
      usage: await this.usage({ session }), error: code, health: status === 'ACTIVE' || status === 'CHECKPOINTING' ? 'healthy' : 'down',
    });
  }

  async usage({ session } = {}) {
    const raw = this.sessions.get(session?.id)?.usage;
    if (!raw) return unknownUsage();
    const tokens = Number(raw.total_tokens ?? raw.total ?? (Number(raw.input_tokens || 0) + Number(raw.output_tokens || 0)));
    return { task_tokens: Number.isFinite(tokens) ? tokens : null, session_pct: null, weekly_pct: null, reset_at: null, basis: 'PROVIDER_REPORTED' };
  }

  async checkpoint({ session, context }) {
    if (!this.inspectCheckpoint) throw continuityError('CHECKPOINT_FAILED');
    try {
      const state = this.sessions.get(session.id);
      const payload = await this.inspectCheckpoint({ session, state, context });
      // A provider-issued session id is durable resume metadata, never an
      // authentication token. Persist only when it was observed in output.
      if (state?.id && typeof state.id === 'string') payload.cli_session_id = state.id;
      return { payload, nativeCheckpointId: null };
    } catch (error) { throw continuityError('CHECKPOINT_FAILED', error); }
  }

  async handoff({ session, context }) {
    return { checkpoint: await this.checkpoint({ session, context }), packet: context?.packet || null };
  }

  cleanup({ session }) {
    const state = this.sessions.get(session?.id);
    if (state && !state.finished) throw continuityError('WORKER_STOP_UNCONFIRMED');
    if (session?.id) this.sessions.delete(session.id);
    return true;
  }
}
