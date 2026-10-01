// Official Claude Code CLI: print mode, stream-json, auth status and session
// resume. Requires >=2.1.268 so auth status and unattended permission-denial
// semantics are available. Subscription login is used; API keys are excluded
// from the child environment to avoid silently changing the billing source.
import { ExternalCliAdapter } from './external-cli.js';

export class ClaudeCodeContinuityAdapter extends ExternalCliAdapter {
  constructor({ driver, inspectCheckpoint, enabled = false, timeoutMs } = {}) {
    super({ key: 'claude-code', binary: 'claude', driver, inspectCheckpoint, enabled, timeoutMs,
      minimumVersion: { major: 2, minor: 1, patch: 268 }, maximumMajor: 3,
      envKeys: ['CLAUDE_CODE_OAUTH_TOKEN'] });
  }

  capabilities() {
    return {
      executionMode: 'EXECUTABLE', headless: true, resume: true, checkpoint: true,
      structuredOutput: true, usageReporting: 'when-emitted', worktrees: true,
      worktreeManagement: 'supervisor', authRequirement: 'Claude Code subscription login',
      maxContext: null, privacyClasses: ['PUBLIC'],
      ownerAction: 'Verify Claude Code subscription login and approve any wider data-class policy before enabling.',
      taskSizes: ['small', 'medium', 'large', 'refactor'], taskTypes: ['coding'],
      quality: 5, taskFit: { small: 4, medium: 5, large: 5, refactor: 5 }, speed: 3,
      costClass: 'included', quotaSource: 'anthropic-claude-subscription',
      supportedVersion: '>=2.1.268 <3.0.0',
    };
  }

  async verifyAuth() {
    const auth = await this.driver.inspect('claude', ['auth', 'status'], { extraEnvKeys: this.envKeys });
    // The official command exits 0 when logged in and 1 otherwise. Its JSON
    // shape may grow; never return the account identity or configuration path.
    return { ok: auth.ok };
  }

  async verifyFeatures() {
    const help = await this.driver.inspect('claude', ['--help'], { extraEnvKeys: this.envKeys });
    return { ok: help.ok && ['--output-format', '--resume', '--permission-mode', '--permission-prompts', '--allowedTools']
      .every((flag) => help.stdout.includes(flag)) };
  }

  command({ resumeId }) {
    return [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
      ...(resumeId ? ['--resume', resumeId] : []),
      '--allowedTools', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
      'Bash(git status *)', 'Bash(git diff *)',
      'Bash(git add *)', 'Bash(git commit *)', 'Bash(git push origin *)',
      'Bash(node --test *)',
    ];
  }

  consumeEvent(event, state) {
    state.lastEvent = event;
    if (event.session_id) state.id ||= event.session_id;
    if (event.type === 'result') {
      state.resultSeen = true;
      state.usage = event.usage || state.usage;
      if (event.is_error || event.subtype !== 'success') state.providerFailure = state.lastRetry ? { error: { type: state.lastRetry } } : event;
    }
    if (event.type === 'system' && event.subtype === 'api_retry' && event.error) state.lastRetry = event.error;
  }
}

// Compatibility for registry readers; this instance is intentionally OFF.
export const claudeCodeAdapter = new ClaudeCodeContinuityAdapter();
