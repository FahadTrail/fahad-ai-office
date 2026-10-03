// Official OpenCode CLI: `run --format json`, `auth list`, `--session` resume.
//
// Everything this adapter relies on was taken from the official CLI reference
// (https://opencode.ai/docs/cli/) and the published `run` command source, not
// from guessed flags:
//   * `opencode run [message..]` is the non-interactive entry point; the
//     interactive TUI only starts under `--mini`, so `run` is always headless.
//   * The prompt is read from piped stdin when no message argument is given
//     (`Bun.stdin.text()` → `resolveRunInput`), which is how the shared driver
//     hands over the continuation packet.
//   * `--format json` writes newline-delimited JSON objects of the shape
//     `{ type, timestamp, sessionID, ... }`; `sessionID` is on every line, so
//     the resume id is provider-issued, not invented.
//   * Without `--auto`, non-interactive runs auto-reject every permission, so
//     `--auto` is required for a worker that must actually edit files.
//   * `auth list` prints "N credentials" and optionally "N environment
//     variables"; there is no JSON mode, so readiness parses those counts.
//   * `--session <id>` exits 1 when the session does not exist: a stale
//     resume id fails closed instead of forking the wrong conversation.
// Every required flag is re-checked at runtime by `verifyFeatures`, so a CLI
// that drops one fails closed as UNSUPPORTED_VERSION.
//
// The owner-verification gates are provider-neutral and are still evaluated
// before any subprocess runs: this adapter is OFF by default and only the
// owner can satisfy them. The Zen promotion gate applies only when the
// declared model provider is Zen; any other verified free provider (e.g.
// OpenRouter Free) never needs it.
import { ExternalCliAdapter } from './external-cli.js';

const minimumVersion = { major: 1, minor: 18, patch: 0 };

// The flags `verifyFeatures` requires at runtime: every one of them must be
// present, so a CLI that drops one still fails closed as UNSUPPORTED_VERSION.
const REQUIRED_RUN_FLAGS = Object.freeze(['--format', '--session', '--continue', '--dir', '--auto']);

// The official 1.18.34 CLI (yargs) writes `opencode run --help` entirely to
// STDERR — stdout stays empty and the exit code is 0 — optionally wrapped in
// ANSI styling when attached to a terminal, with column-wrapped descriptions.
// Normalise both streams (ANSI escapes, CR) before matching so formatting can
// never hide a flag; whitespace-insensitivity covers the column padding.
function normalizeHelp(...streams) {
  return streams
    .map((stream) => String(stream || '')
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\u001b[@-_]/g, '')
      .replace(/\r/g, ''))
    .join('\n');
}

// Whole-token match: the flag may sit at the start of a line, after the
// comma of a short option ("-c, --continue") or after indentation, and must
// not be a prefix of a longer flag such as "--formatting".
function helpHasFlag(text, flag) {
  return new RegExp(`(?:^|[\\s,(])${flag}(?![\\w-])`, 'm').test(text);
}

// OpenCode reads provider credentials from its own credentials file under
// HOME or from provider environment variables. Names only — no value is ever
// read, logged or returned here.
const OPENCODE_ENV_KEYS = Object.freeze([
  'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_SERVER_USERNAME',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY',
  'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY',
]);

export class OpenCodeContinuityAdapter extends ExternalCliAdapter {
  constructor({ driver, inspectCheckpoint, enabled = false, timeoutMs, platform = process.platform,
    freeVerified, zenFree = false, promotionActive = false, legitimateAccess = false, dataClassAllowed = false,
    autoReload = true, modelProvider = 'zen' } = {}) {
    super({
      key: 'opencode', binary: 'opencode', driver, inspectCheckpoint, enabled, timeoutMs, platform,
      minimumVersion, maximumMajor: 2, envKeys: [...OPENCODE_ENV_KEYS],
    });
    // Provider-neutral owner gates, all default closed. `zenFree` stays an
    // accepted legacy option name, and `modelProvider` defaults to 'zen' so
    // existing setups keep exactly their previous behaviour, including the
    // Zen promotion gate.
    const provider = String(modelProvider ?? 'zen').trim().toLowerCase() || 'zen';
    this.gates = {
      freeVerified: Boolean(freeVerified ?? zenFree),
      promotionActive: Boolean(promotionActive),
      legitimateAccess: Boolean(legitimateAccess),
      dataClassAllowed: Boolean(dataClassAllowed),
      autoReload: Boolean(autoReload),
      modelProvider: provider,
    };
  }

  capabilities() {
    return {
      executionMode: 'EXECUTABLE', headless: true, resume: true, checkpoint: true,
      structuredOutput: true, usageReporting: 'when-emitted', worktrees: true,
      worktreeManagement: 'supervisor',
      authRequirement: 'Verified OpenCode provider credentials',
      maxContext: null, privacyClasses: ['PUBLIC'],
      taskSizes: ['small', 'medium', 'large', 'refactor'], taskTypes: ['coding'],
      quality: 4, taskFit: { small: 4, medium: 4, large: 4, refactor: 4 }, speed: 3,
      // Never claim a free or included cost class before the owner verifies
      // the model source; UNKNOWN keeps the worker out of free-capacity math.
      costClass: 'unknown', quotaSource: 'opencode',
      supportedVersion: '>=1.18.0 <2.0.0, required flags verified at runtime',
      ownerAction: 'Verify a legitimately free model source, disabled auto-reload and the data-class policy, then set CONTINUITY_OPENCODE_ENABLED.',
    };
  }

  // The owner-verification gates are evaluated before the enabled flag and
  // before any subprocess, so their reason is reported verbatim. Required for
  // every provider: auto-reload off, a verified free model source, legitimate
  // access and data-class/privacy approval. The Zen promotion is a Zen-only
  // concept and is required only when the model provider is Zen — never for
  // another verified free provider such as OpenRouter Free.
  gateReason() {
    const { autoReload, freeVerified, promotionActive, legitimateAccess, dataClassAllowed, modelProvider } = this.gates;
    if (autoReload) return 'AUTO_RELOAD_MUST_BE_OFF';
    if (!freeVerified) return 'FREE_ACCESS_NOT_VERIFIED';
    if (modelProvider === 'zen' && !promotionActive) return 'ZEN_PROMOTION_INACTIVE';
    if (!legitimateAccess) return 'ACCESS_NOT_VERIFIED';
    if (!dataClassAllowed) return 'PRIVACY_NOT_ALLOWED';
    return null;
  }

  async probe() {
    const gate = this.gateReason();
    if (gate) return { ok: false, authState: 'OWNER_ACTION_REQUIRED', reason: gate };
    return super.probe();
  }

  async verifyFeatures() {
    // Both streams are read because the help lives on stderr; the stderr
    // bound is raised for this one inspection so the whole help (about 3 KB)
    // survives instead of only the last 1000 characters.
    const help = await this.driver.inspect('opencode', ['run', '--help'], {
      extraEnvKeys: this.envKeys, timeoutMs: 20_000, stderrLimit: 64 * 1024,
    });
    const text = normalizeHelp(help.stdout, help.stderr);
    return {
      ok: Boolean(help.ok) && REQUIRED_RUN_FLAGS.every((flag) => helpHasFlag(text, flag)),
    };
  }

  async verifyAuth() {
    const list = await this.driver.inspect('opencode', ['auth', 'list'], { extraEnvKeys: this.envKeys, timeoutMs: 20_000 });
    if (!list.ok) return { ok: false, reason: 'AUTH_REQUIRED' };
    const text = String(list.stdout || '');
    const credentials = Number(/(\d+)\s+credentials/.exec(text)?.[1] || 0);
    const environment = Number(/(\d+)\s+environment variable/.exec(text)?.[1] || 0);
    return { ok: credentials > 0 || environment > 0, reason: 'AUTH_REQUIRED' };
  }

  command({ worktree, resumeId }) {
    // The prompt is delivered on stdin (verified in the official source); the
    // supervisor-owned worktree is passed explicitly as well as used as cwd.
    return ['run', '--format', 'json', '--auto', '--dir', worktree, ...(resumeId ? ['--session', resumeId] : [])];
  }

  consumeEvent(event, state) {
    state.lastEvent = event;
    if (event.sessionID) state.id ||= event.sessionID;
    // OpenCode emits `error` from its failure paths only; treating it as a
    // provider failure keeps a failed turn from being reported as success.
    if (event.type === 'error') state.providerFailure = event;
    // There is no terminal "result" event in the published run command, so a
    // completed text part or step is the completion signal. A run that exits
    // without either is still rejected by the driver as WORKER_OUTPUT_INVALID.
    if (event.type === 'text' || event.type === 'step_finish') state.resultSeen = true;
    const tokens = event.part?.tokens || event.tokens || event.usage;
    if (tokens) {
      const input = Number(tokens.input ?? tokens.input_tokens);
      const output = Number(tokens.output ?? tokens.output_tokens);
      const total = Number(tokens.total ?? tokens.total_tokens
        ?? (Number.isFinite(input) && Number.isFinite(output) ? input + output : Number.NaN));
      if (Number.isFinite(total)) state.usage = { total_tokens: total, input_tokens: input, output_tokens: output };
    }
  }
}

export function createOpenCodeAdapter(options = {}) {
  return new OpenCodeContinuityAdapter(options);
}
export const openCodeAdapter = createOpenCodeAdapter();
