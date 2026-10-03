#!/usr/bin/env bash
# Prepares the official external Continuity workers (OpenCode, Gemini CLI) on
# the Fahad AI Office host. Verify-only by default; installs only with
# --install. Full runbook: docs/CONTINUITY-VPS-WORKERS.md.
#
#   bash ops/setup-continuity-workers.sh --check         # read-only capability report
#   sudo bash ops/setup-continuity-workers.sh --install  # install/update the official CLIs
#
# Guarantees (both modes):
#   * never reads, prints or embeds credentials (set/absent and counts only);
#   * never edits production .env or any Continuity feature flag;
#   * never restarts, redeploys or touches any container or Hermes;
#   * installs only the official npm packages: opencode-ai and
#     @google/gemini-cli (npm view / npm install -g @latest, auditable).
set -euo pipefail

MODE=${1:-}
case "$MODE" in
  --check|--install) ;;
  *) echo "Usage: bash ops/setup-continuity-workers.sh --check | --install" >&2; exit 2 ;;
esac

FAILURES=0
WARNINGS=0
pass() { printf '  [PASS] %s\n' "$1"; }
warn() { printf '  [WARN] %s\n' "$1"; WARNINGS=$((WARNINGS + 1)); }
fail() { printf '  [FAIL] %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

echo "1/7 Operating system and architecture"
OS_NAME=$(uname -s)
ARCH=$(uname -m)
case "$OS_NAME" in
  Linux) pass "OS: Linux" ;;
  Darwin) pass "OS: macOS (development host)" ;;
  *) fail "unsupported OS: $OS_NAME (Continuity workers run on Linux VPS or macOS dev)" ;;
esac
case "$ARCH" in
  x86_64|amd64|aarch64|arm64) pass "architecture: $ARCH" ;;
  *) fail "unsupported architecture: $ARCH" ;;
esac

echo "2/7 Node.js and npm prerequisites (Gemini CLI requires Node >= 20)"
if ! command -v node >/dev/null 2>&1; then
  fail "node is not installed"
  NODE_MAJOR=0
else
  NODE_VERSION=$(node --version 2>/dev/null || echo v0.0.0)
  NODE_MAJOR=$(printf '%s' "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)
  if [ "${NODE_MAJOR:-0}" -ge 20 ]; then pass "node $NODE_VERSION"; else fail "node $NODE_VERSION (need >= 20)"; fi
fi
if command -v npm >/dev/null 2>&1; then pass "npm $(npm --version 2>/dev/null || echo '?')"; else fail "npm is not installed"; fi

echo "3/7 Git (supervisor worktrees depend on it)"
if command -v git >/dev/null 2>&1; then pass "git $(git --version 2>/dev/null | awk '{print $3}')"; else fail "git is not installed"; fi

echo "4/7 Official CLI presence and versions"
check_version() { # binary label minimum-major
  local bin=$1 label=$2 min_major=$3
  if ! command -v "$bin" >/dev/null 2>&1; then
    if [ "$MODE" = "--install" ]; then warn "$label not installed yet (install step follows)"; else fail "$label not installed (run with --install)"; fi
    return
  fi
  local out major
  out=$("$bin" --version 2>/dev/null | head -1 || true)
  major=$(printf '%s' "$out" | sed 's/^[^0-9]*//' | cut -d. -f1)
  if [ -n "$out" ] && [ "${major:-0}" -ge "$min_major" ]; then
    pass "$label $out"
  elif [ -n "$out" ]; then
    warn "$label $out (verified baseline starts at major $min_major; flags are re-checked below)"
  else
    fail "$label --version produced no output"
  fi
}
check_version opencode "OpenCode" 1
check_version gemini "Gemini CLI" 0

if [ "$MODE" = "--install" ]; then
  echo "5/7 Installing/updating official CLIs (npm globals, no credentials)"
  if npm install -g opencode-ai@latest; then pass "opencode-ai updated"; else fail "npm install -g opencode-ai@latest failed (rerun with sudo)"; fi
  if npm install -g @google/gemini-cli@latest; then pass "@google/gemini-cli updated"; else fail "npm install -g @google/gemini-cli@latest failed (rerun with sudo)"; fi
  check_version opencode "OpenCode" 1
  check_version gemini "Gemini CLI" 0
else
  echo "5/7 Install step skipped (--check is verify-only)"
fi

echo "6/7 Non-secret capability checks (flags the Continuity adapters require)"
if command -v opencode >/dev/null 2>&1; then
  # The official 1.18.34 CLI (yargs) writes `run --help` entirely on STDERR
  # (exit 0, stdout empty), optionally ANSI-styled, with column-wrapped
  # descriptions. Capture BOTH streams once, strip ANSI/CR, then require every
  # flag as a whole token: formatting can never hide a flag, and a genuinely
  # absent flag still fails closed as UNSUPPORTED_VERSION.
  OC_HELP=$(opencode run --help 2>&1 || true)
  OC_ESC=$'\033'
  OC_HELP=${OC_HELP//$'\r'/}
  OC_HELP=$(printf '%s' "$OC_HELP" | sed -e "s/${OC_ESC}\\[[0-9;?]*[A-Za-z]//g")
  OC_MISSING=""
  for OC_FLAG in --format --session --continue --dir --auto; do
    OC_RE="(^|[[:space:],(])${OC_FLAG}([^[:alnum:]-]|$)"
    if ! [[ "$OC_HELP" =~ $OC_RE ]]; then OC_MISSING="$OC_MISSING $OC_FLAG"; fi
  done
  if [ -z "$OC_MISSING" ]; then
    pass "opencode run exposes --format --session --continue --dir --auto"
  else
    fail "opencode run is missing a required flag:$OC_MISSING (UNSUPPORTED_VERSION)"
  fi
  # Credential counts only; `auth list` never prints a value.
  if timeout 20 opencode auth list 2>/dev/null | head -3 | sed 's/^/         /'; then
    pass "opencode auth list answered (counts only, no values shown)"
  else
    warn "opencode auth list did not answer (not authenticated yet)"
  fi
else
  fail "opencode unavailable for capability checks"
fi
if command -v gemini >/dev/null 2>&1; then
  if gemini --help 2>/dev/null | grep -q -- '--output-format' \
    && gemini --help 2>/dev/null | grep -q -- 'stream-json' \
    && gemini --help 2>/dev/null | grep -q -- '--approval-mode' \
    && gemini --help 2>/dev/null | grep -q -- '--skip-trust'; then
    pass "gemini exposes --output-format stream-json --approval-mode yolo --skip-trust"
  else
    fail "gemini is missing a required flag (UNSUPPORTED_VERSION)"
  fi
  # Presence only, never a value.
  if [ -n "${GEMINI_API_KEY:-}" ]; then pass "GEMINI_API_KEY: set (value not shown)"; fi
  if [ -f "${HOME:-}/.gemini/oauth_creds.json" ]; then pass "Gemini OAuth credential file: present"; fi
  if [ -z "${GEMINI_API_KEY:-}" ] && [ ! -f "${HOME:-}/.gemini/oauth_creds.json" ]; then
    warn "Gemini CLI not authenticated yet (AUTH_REQUIRED until the runbook step is done)"
  fi
else
  fail "gemini unavailable for capability checks"
fi

echo "7/7 Host isolation capability (reported, never modified)"
if command -v unshare >/dev/null 2>&1 && unshare -U -r true 2>/dev/null; then
  pass "user namespaces available (unshare -U -r)"
else
  warn "user namespaces unavailable: OS-sandbox workers (Codex) will report HOST_CAPABILITY_REQUIRED here"
fi
if [ -d /sys/kernel/security/apparmor ]; then
  warn "AppArmor is present on this host; verify OS-sandbox workers with a real canary before enabling them"
else
  pass "no AppArmor securityfs mounted"
fi
if [ -r /proc/sys/kernel/unprivileged_userns_clone ]; then
  if [ "$(cat /proc/sys/kernel/unprivileged_userns_clone)" = 1 ]; then pass "unprivileged_userns_clone=1"; else warn "unprivileged_userns_clone=0"; fi
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "RESULT: $FAILURES failure(s), $WARNINGS warning(s) — workers stay OFF; see docs/CONTINUITY-VPS-WORKERS.md."
  exit 1
fi
echo "RESULT: all checks passed ($WARNINGS warning(s))."
echo "No flags were changed and nothing was restarted. Next: authenticate per docs/CONTINUITY-VPS-WORKERS.md, then run the Phase N drill."
