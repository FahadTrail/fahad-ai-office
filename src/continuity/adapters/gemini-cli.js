// Official Google Gemini CLI (`@google/gemini-cli`): headless mode, structured
// stream output and safe non-interactive execution. Every flag, exit code and
// event shape below was verified against the official CLI reference
// (docs/cli/headless.md in google-gemini/gemini-cli) and the installed official
// package — nothing is built against guessed flags:
//   * Headless mode triggers automatically in a non-TTY environment or with
//     `-p/--prompt`; the shared driver always pipes stdin, so the continuation
//     packet is delivered as the prompt through the official non-TTY path.
//   * `--output-format stream-json` emits newline-delimited JSON events:
//     `init` (session_id), `message`, `tool_use`, `tool_result`, `error`
//     (severity: warning|error) and the terminal `result`
//     (status: success|error, error, stats.total_tokens).
//   * `--approval-mode yolo` approves tools non-interactively; without it a
//     headless turn cannot edit files. `--skip-trust` clears the interactive
//     workspace-trust prompt. `gemini --help` re-verifies all of these at
//     runtime, so a CLI that drops one fails closed as UNSUPPORTED_VERSION.
//   * Exit codes: 0 success, 1 general/API error, 41 unauthenticated
//     (observed on 0.40.1), 42 input error, 53 turn limit exceeded.
//   * `--resume` only accepts "latest" or a numeric index — neither is a
//     durable provider-issued session id, and "latest" could resume a
//     DIFFERENT task's session. A stale resume must fail closed, so this
//     adapter declares no native resume: recovery always starts a fresh
//     session from the continuation packet at the exact checkpoint commit.
//   * There is no auth subcommand; readiness checks credential PRESENCE only
//     (the GEMINI_API_KEY environment variable name, or the existence of
//     ~/.gemini/oauth_creds.json after an official OAuth login). Values and
//     identity fields are never read, logged or returned.
// Vertex AI / GCA paths are deliberately excluded from the child environment
// so the billing source can never silently change to paid cloud capacity.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ExternalCliAdapter } from './external-cli.js';

// Names only. The adapter never reads or returns a value for these keys.
const GEMINI_ENV_KEYS = Object.freeze(['GEMINI_API_KEY']);

export class GeminiCliContinuityAdapter extends ExternalCliAdapter {
  constructor({ driver, inspectCheckpoint, enabled = false, timeoutMs, platform = process.platform, model = null } = {}) {
    super({
      key: 'gemini-cli', binary: 'gemini', driver, inspectCheckpoint, enabled, timeoutMs, platform,
      minimumVersion: { major: 0, minor: 40, patch: 0 }, maximumMajor: 1,
      envKeys: [...GEMINI_ENV_KEYS],
    });
    this.model = String(model || '').trim();
  }

  capabilities() {
    return {
      executionMode: 'EXECUTABLE', headless: true,
      // `--resume` accepts only "latest" or a numeric index; neither is a
      // durable id, so a checkpointed session never resumes natively — the
      // supervisor restarts from the continuation packet instead.
      resume: false,
      checkpoint: true, structuredOutput: true, usageReporting: 'when-emitted',
      worktrees: true, worktreeManagement: 'supervisor',
      authRequirement: 'Gemini CLI OAuth login or GEMINI_API_KEY on the worker host',
      maxContext: null,
      // Conservative: eligible only for PUBLIC-class work until the owner
      // verifies the provider's data handling on the VPS.
      privacyClasses: ['PUBLIC'],
      taskSizes: ['small', 'medium', 'large', 'refactor'], taskTypes: ['coding'],
      quality: 4, taskFit: { small: 4, medium: 4, large: 4, refactor: 4 }, speed: 4,
      // Never claim a free or included cost class before the owner verifies
      // the actual auth path and its quota; UNKNOWN keeps the worker out of
      // free-capacity math.
      costClass: 'unknown', quotaSource: 'gemini-cli',
      supportedVersion: '>=0.40.0 <1.0.0, required flags verified at runtime',
      ownerAction: 'Authenticate the Gemini CLI on the VPS (official OAuth login or GEMINI_API_KEY), verify its quota and data policy, then set CONTINUITY_GEMINI_CLI_ENABLED.',
    };
  }

  async verifyFeatures() {
    const help = await this.driver.inspect('gemini', ['--help'], { extraEnvKeys: this.envKeys });
    return {
      ok: help.ok && ['--output-format', 'stream-json', '--approval-mode', 'yolo', '--skip-trust']
        .every((flag) => help.stdout.includes(flag)) && (!this.model || help.stdout.includes('--model')),
    };
  }

  async verifyAuth() {
    // Presence only: the value is never read, logged or returned.
    try {
      const env = typeof this.driver.environment === 'function' ? this.driver.environment(this.envKeys) : {};
      if (env.GEMINI_API_KEY) return { ok: true };
      // A completed official OAuth login stores its credential file under HOME.
      const home = env.HOME;
      if (home && existsSync(join(home, '.gemini', 'oauth_creds.json'))) return { ok: true };
    } catch { /* fall through to fail-closed */ }
    return { ok: false };
  }

  command() {
    // cwd (the supervisor-owned worktree) is set by the driver; the prompt is
    // piped on stdin, which is the official non-TTY headless entry point.
    return [...(this.model ? ['--model', this.model] : []), '--output-format', 'stream-json', '--approval-mode', 'yolo', '--skip-trust'];
  }

  consumeEvent(event, state) {
    state.lastEvent = event;
    if (event.session_id) state.id ||= event.session_id;
    // `error` events with severity "warning" are non-fatal by contract; only
    // severity "error" (or an untyped error) fails the turn.
    if (event.type === 'error' && event.severity !== 'warning') state.providerFailure = event;
    if (event.type === 'result') {
      state.resultSeen = true;
      if (event.status === 'error') state.providerFailure = event;
      const stats = event.stats;
      const total = Number(stats?.total_tokens);
      if (Number.isFinite(total)) {
        state.usage = {
          total_tokens: total,
          input_tokens: Number(stats.input_tokens) || 0,
          output_tokens: Number(stats.output_tokens) || 0,
        };
      }
    }
  }
}

export function createGeminiCliAdapter(options = {}) {
  return new GeminiCliContinuityAdapter(options);
}
// Compatibility for registry readers; this instance is intentionally OFF.
export const geminiCliAdapter = createGeminiCliAdapter();
