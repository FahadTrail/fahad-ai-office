// Regression tests for the VPS capability checker's OpenCode flag detection.
//
// The official OpenCode 1.18.34 CLI (yargs) writes `opencode run --help`
// entirely to STDERR — stdout stays empty and the exit code is 0. The old
// checker ran `opencode run --help 2>/dev/null | grep -q -- '--format'`, which
// discarded the only stream the help lives in and reported a false
// "missing a required flag (UNSUPPORTED_VERSION)" on a perfectly capable
// worker. These tests run the real script against a fake `opencode` binary
// that reproduces the official help shape, plus the ANSI and missing-flag
// variants, so the parser stays robust without ever weakening the gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const skip = process.platform === 'win32' && 'bash-only operator script';

// Byte-for-byte capture of the official `opencode run --help` (OpenCode 1.18.34).
const OPENCODE_RUN_HELP = readFileSync(new URL('../testing/fixtures/opencode-run-help-1.18.34.txt', import.meta.url), 'utf8');

const FAKE_GEMINI = `#!/bin/sh
if [ "$1" = "--version" ]; then printf '0.40.1\\n'; exit 0; fi
if [ "$1" = "--help" ]; then
  printf '%s\\n' '  -o, --output-format  [choices: "text","json","stream-json"]' '      --approval-mode  [choices: "default","auto_edit","yolo","plan"]' '      --skip-trust     skip the trust prompt'
  exit 0
fi
exit 0
`;

// Runs `bash ops/setup-continuity-workers.sh --check` with a fake `opencode`
// whose `run --help` writes the given text to STDERR, exactly like the real
// CLI, and a fake `gemini` that reports the official flags on stdout.
function runCheck(opencodeHelp) {
  const dir = mkdtempSync(join(tmpdir(), 'continuity-setup-workers-'));
  try {
    writeFileSync(join(dir, 'opencode'), `#!/bin/sh
if [ "$1" = "--version" ]; then printf '1.18.34\\n'; exit 0; fi
if [ "$1" = "auth" ]; then printf '0 credentials\\n'; exit 0; fi
if [ "$1" = "run" ] && [ "$2" = "--help" ]; then
  cat >&2 <<'OPENCODE_HELP_EOF'
${opencodeHelp}
OPENCODE_HELP_EOF
  exit 0
fi
exit 0
`, { mode: 0o755 });
    writeFileSync(join(dir, 'gemini'), FAKE_GEMINI, { mode: 0o755 });
    const scriptPath = join(dir, 'setup-continuity-workers.sh');
    writeFileSync(scriptPath, readFileSync(new URL('../ops/setup-continuity-workers.sh', import.meta.url), 'utf8'));
    return spawnSync('bash', [scriptPath, '--check'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      timeout: 60_000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the VPS checker accepts the real OpenCode 1.18.34 help from stderr', { skip }, () => {
  const result = runCheck(OPENCODE_RUN_HELP);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.includes('[PASS] opencode run exposes --format --session --continue --dir --auto'), result.stdout);
  assert.ok(!result.stdout.includes('opencode run is missing a required flag'), result.stdout);
});

test('the VPS checker tolerates ANSI styling in the OpenCode help', { skip }, () => {
  const ansiHelp = OPENCODE_RUN_HELP.replace(/--(format|session|continue|dir|auto)\b/g, '\u001b[1m$&\u001b[0m');
  const result = runCheck(ansiHelp);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.includes('[PASS] opencode run exposes --format --session --continue --dir --auto'), result.stdout);
});

test('the VPS checker still fails closed when a required OpenCode flag is absent', { skip }, () => {
  const withoutAuto = OPENCODE_RUN_HELP.replace(/^.*--auto.*\n?/m, '');
  assert.ok(!withoutAuto.includes('--auto'));
  const result = runCheck(withoutAuto);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stdout.includes('[FAIL] opencode run is missing a required flag: --auto (UNSUPPORTED_VERSION)'), result.stdout);
});
