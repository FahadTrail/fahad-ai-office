// Official Codex CLI: `exec --json`, `exec resume --json`, `login status`.
// Version and required flags are checked at runtime. No deprecated approval
// flag, cookie access, direct OAuth-token reads, or invented quota percentage.
import { ExternalCliAdapter } from './external-cli.js';
import { sandboxDenial } from '../errors.js';

const minimumVersion = { major: 0, minor: 150, patch: 0 };

export class CodexContinuityAdapter extends ExternalCliAdapter {
  constructor({ driver, inspectCheckpoint, enabled = false, timeoutMs, platform = process.platform } = {}) {
    super({ key: 'codex', binary: 'codex', driver, inspectCheckpoint, enabled, timeoutMs,
      minimumVersion, maximumMajor: 1, envKeys: ['CODEX_HOME'], platform });
  }

  capabilities() {
    return {
      executionMode: 'EXECUTABLE', headless: true, resume: true, checkpoint: true,
      structuredOutput: true, usageReporting: 'when-emitted', worktrees: true,
      worktreeManagement: 'supervisor', authRequirement: 'Verified Codex CLI login',
      maxContext: null, privacyClasses: ['PUBLIC', 'NORMAL', 'PRIVATE'],
      taskSizes: ['small', 'medium', 'large', 'refactor'], taskTypes: ['coding'],
      quality: 5, taskFit: { small: 4, medium: 5, large: 5, refactor: 5 }, speed: 4,
      costClass: 'included', quotaSource: 'openai-chatgpt',
      supportedVersion: '>=0.150.0 <1.0.0, required flags verified at runtime',
    };
  }

  async verifyFeatures() {
    const [exec, resume] = await Promise.all([
      this.driver.inspect('codex', ['exec', '--help'], { extraEnvKeys: this.envKeys }),
      this.driver.inspect('codex', ['exec', 'resume', '--help'], { extraEnvKeys: this.envKeys }),
    ]);
    return { ok: exec.ok && resume.ok && ['--json', '--sandbox', '--cd', '--config'].every((flag) => exec.stdout.includes(flag))
      && ['--json', '--config'].every((flag) => resume.stdout.includes(flag)) };
  }

  async verifyAuth() {
    const auth = await this.driver.inspect('codex', ['login', 'status'], { extraEnvKeys: this.envKeys });
    return { ok: auth.ok };
  }

  // The workspace-write sandbox is an OS capability, not an account state.
  // Probe the host before any turn so a container that denies the sandbox is
  // reported as unavailable instead of burning a turn that cannot write.
  async verifySandbox() {
    if (this.platform !== 'linux') return { ok: true };
    const probe = await this.driver.inspect('codex', ['sandbox', 'linux', '--', 'true'],
      { extraEnvKeys: this.envKeys, timeoutMs: 15_000 });
    if (!probe.ok) return { ok: false, detail: 'host cannot start the Codex Linux sandbox' };
    return { ok: true };
  }

  command({ worktree, resumeId }) {
    const policy = 'approval_policy="never"';
    return resumeId
      ? ['exec', 'resume', '--json', '-c', policy, '-c', 'sandbox_mode="workspace-write"', resumeId, '-']
      : ['exec', '--json', '--sandbox', 'workspace-write', '-c', policy, '-C', worktree, '-'];
  }

  consumeEvent(event, state) {
    state.lastEvent = event;
    // Codex can exit successfully after every command failed to enter its
    // Linux sandbox. Do not mistake that no-op turn for completed work.
    if (event.type === 'item.completed' && event.item?.type === 'command_execution'
      && event.item?.exit_code !== 0
      && sandboxDenial(event.item?.aggregated_output)) {
      state.errorCode = 'SANDBOX_UNAVAILABLE';
    }
    if (event.type === 'thread.started') state.id = event.thread_id || event.thread?.id || state.id;
    if (event.thread_id) state.id ||= event.thread_id;
    const usage = event.usage || event.token_usage || event.info?.usage;
    if (usage) state.usage = usage;
    if (event.type === 'turn.completed') state.resultSeen = true;
    if (event.type === 'turn.failed' || event.type === 'error') state.providerFailure = event;
  }
}
