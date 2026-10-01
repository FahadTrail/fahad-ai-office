// Official Codex CLI: `exec --json`, `exec resume --json`, `login status`.
// Version and required flags are checked at runtime. No deprecated approval
// flag, cookie access, direct OAuth-token reads, or invented quota percentage.
import { ExternalCliAdapter } from './external-cli.js';

const minimumVersion = { major: 0, minor: 150, patch: 0 };

export class CodexContinuityAdapter extends ExternalCliAdapter {
  constructor({ driver, inspectCheckpoint, enabled = false, timeoutMs } = {}) {
    super({ key: 'codex', binary: 'codex', driver, inspectCheckpoint, enabled, timeoutMs,
      minimumVersion, maximumMajor: 1, envKeys: ['CODEX_HOME'] });
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

  command({ worktree, resumeId }) {
    const policy = 'approval_policy="never"';
    return resumeId
      ? ['exec', 'resume', '--json', '-c', policy, '-c', 'sandbox_mode="workspace-write"', resumeId, '-']
      : ['exec', '--json', '--sandbox', 'workspace-write', '-c', policy, '-C', worktree, '-'];
  }

  consumeEvent(event, state) {
    state.lastEvent = event;
    if (event.type === 'thread.started') state.id = event.thread_id || event.thread?.id || state.id;
    if (event.thread_id) state.id ||= event.thread_id;
    const usage = event.usage || event.token_usage || event.info?.usage;
    if (usage) state.usage = usage;
    if (event.type === 'turn.completed') state.resultSeen = true;
    if (event.type === 'turn.failed' || event.type === 'error') state.providerFailure = event;
  }
}
