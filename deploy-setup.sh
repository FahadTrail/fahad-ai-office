#!/usr/bin/env bash
# ============================================================
#  Fahad AI Office — deployment hardening (run once, as root)
#
#  Creates a `deploy` identity that is technically incapable of
#  anything except redeploying this one application.
#
#  The boundaries are enforced by the operating system, not by
#  the deploy script. Even if the deploy script is rewritten,
#  the holder of the deploy key cannot:
#
#    - open a shell (forced SSH command + no-pty)
#    - become root (no docker group, no general sudo)
#    - read .env (root-owned, mode 600)
#    - change the container's shape, volumes or privileges
#      (docker-compose.yml and Dockerfile are root-owned)
#    - see, stop, restart or inspect Hermes or any other
#      container (every permitted docker command is pinned to
#      this project's compose file by exact string match)
#
#  Hermes is never referenced, read, or touched by this script.
# ============================================================

set -euo pipefail

APP=/opt/fahad-ai-office
DEPLOY_USER=deploy
DEPLOY_HOME=/home/$DEPLOY_USER
SCRIPT=/usr/local/bin/fahad-office-deploy
SUDOERS=/etc/sudoers.d/fahad-office-deploy
COMPOSE_FILE=$APP/docker-compose.yml
DOCKER_BIN=$(command -v docker)

if [ "$(id -u)" -ne 0 ]; then
  echo "This must be run as root." >&2
  exit 1
fi

if [ ! -d "$APP" ]; then
  echo "$APP does not exist. Run the main setup first." >&2
  exit 1
fi

echo ""
echo "Fahad AI Office — deployment hardening"
echo "============================================================"

# ------------------------------------------------------------
# 1. Record Hermes state so we can prove we never touched it
# ------------------------------------------------------------
BEFORE=$("$DOCKER_BIN" ps --format '{{.Names}} {{.Status}}' | sort)
echo ""
echo "Containers before any change:"
echo "$BEFORE" | sed 's/^/    /'

# ------------------------------------------------------------
# 2. The deploy user — no password, no docker group
# ------------------------------------------------------------
if id "$DEPLOY_USER" >/dev/null 2>&1; then
  echo ""
  echo "[user]     $DEPLOY_USER already exists, reusing"
else
  adduser --system --group --shell /bin/bash --home "$DEPLOY_HOME" "$DEPLOY_USER"
  echo ""
  echo "[user]     created $DEPLOY_USER"
fi

# Password login is impossible for this account.
passwd -l "$DEPLOY_USER" >/dev/null 2>&1 || true

# Belt and braces: make absolutely sure it is not in the docker group.
# Docker group membership is equivalent to root and would expose Hermes.
if id -nG "$DEPLOY_USER" | tr ' ' '\n' | grep -qx docker; then
  deluser "$DEPLOY_USER" docker || true
  echo "[user]     removed $DEPLOY_USER from the docker group"
fi
echo "[user]     groups: $(id -nG "$DEPLOY_USER")"

# ------------------------------------------------------------
# 3. Ownership — the real security boundary
#
#    root owns everything that defines how the container runs.
#    deploy owns only application source code.
# ------------------------------------------------------------
mkdir -p "$APP/src" "$APP/logs" "$APP/.deploy-repo"

chown root:root "$APP"
chmod 755 "$APP"

for f in docker-compose.yml Dockerfile .dockerignore; do
  if [ -f "$APP/$f" ]; then
    chown root:root "$APP/$f"
    chmod 644 "$APP/$f"
  fi
done

# Secrets: readable by root only. The deploy user cannot read this
# file, and it never leaves the server.
chown root:root "$APP/.env"
chmod 600 "$APP/.env"

# Application code: the only thing a deployment may change.
chown -R "$DEPLOY_USER":"$DEPLOY_USER" "$APP/src" "$APP/logs" "$APP/.deploy-repo"
[ -f "$APP/package.json" ] && chown "$DEPLOY_USER":"$DEPLOY_USER" "$APP/package.json"

echo "[files]    root owns: docker-compose.yml, Dockerfile, .env"
echo "[files]    deploy owns: src/, package.json, logs/"

# ------------------------------------------------------------
# 4. Sudo whitelist — exact commands only, no wildcards
#
#    Every entry pins --file to this project's compose file, so
#    no permitted command can reach another container.
# ------------------------------------------------------------
cat > "$SUDOERS" <<ENDSUDO
# Fahad AI Office deployment. Exact commands only.
# No wildcards: sudo matches the full argument list literally.
Defaults:$DEPLOY_USER !requiretty
Defaults:$DEPLOY_USER env_reset

$DEPLOY_USER ALL=(root) NOPASSWD: $DOCKER_BIN compose -f $COMPOSE_FILE build
$DEPLOY_USER ALL=(root) NOPASSWD: $DOCKER_BIN compose -f $COMPOSE_FILE up -d
$DEPLOY_USER ALL=(root) NOPASSWD: $DOCKER_BIN compose -f $COMPOSE_FILE ps
$DEPLOY_USER ALL=(root) NOPASSWD: $DOCKER_BIN compose -f $COMPOSE_FILE logs --tail=40
$DEPLOY_USER ALL=(root) NOPASSWD: $DOCKER_BIN compose -f $COMPOSE_FILE run --rm --no-deps runtime node src/healthcheck.js
$DEPLOY_USER ALL=(root) NOPASSWD: $DOCKER_BIN image tag fahad-ai-office/runtime\:0.1.0 fahad-ai-office/runtime\:previous
$DEPLOY_USER ALL=(root) NOPASSWD: $DOCKER_BIN image tag fahad-ai-office/runtime\:previous fahad-ai-office/runtime\:0.1.0
ENDSUDO

chmod 440 "$SUDOERS"

if visudo -c -f "$SUDOERS" >/dev/null; then
  echo "[sudo]     whitelist installed and validated (7 exact commands)"
else
  rm -f "$SUDOERS"
  echo "[sudo]     FAILED validation — removed, nothing changed" >&2
  exit 1
fi

# ------------------------------------------------------------
# 5. The deploy script — root-owned, deploy cannot modify it
# ------------------------------------------------------------
cat > "$SCRIPT" <<'ENDSCRIPT'
#!/usr/bin/env bash
# Fahad AI Office — deployment. Runs as the `deploy` user.
# Its powers are bounded by /etc/sudoers.d/fahad-office-deploy,
# not by anything written here.

set -uo pipefail

APP=/opt/fahad-ai-office
REPO=$APP/.deploy-repo
LOG=$APP/logs/deploy.log
BRANCH=main
GIT_URL=https://github.com/FahadTrail/fahad-ai-office.git
COMPOSE_FILE=$APP/docker-compose.yml
DOCKER=$(command -v docker)
DC="sudo $DOCKER compose -f $COMPOSE_FILE"

say() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"; }

fail() {
  say "DEPLOY FAILED: $*"
  say "The previous version is still running. Nothing was replaced."
  exit 1
}

say "============================================================"
say "Deployment started (branch: $BRANCH)"

# --- 1. Fetch the approved branch --------------------------------
if [ -d "$REPO/.git" ]; then
  git -C "$REPO" remote set-url origin "$GIT_URL" || fail "could not set remote"
  git -C "$REPO" fetch --depth 1 origin "$BRANCH" || fail "git fetch failed"
  git -C "$REPO" reset --hard "origin/$BRANCH" || fail "git reset failed"
else
  rm -rf "$REPO"
  git clone --depth 1 --branch "$BRANCH" "$GIT_URL" "$REPO" || fail "git clone failed"
fi

COMMIT=$(git -C "$REPO" rev-parse --short HEAD)
SUBJECT=$(git -C "$REPO" log -1 --pretty=%s)
say "Commit $COMMIT — $SUBJECT"

# --- 2. Copy application code only -------------------------------
# docker-compose.yml, Dockerfile and .env are root-owned and are
# deliberately NOT updated here. Changing how the container runs
# is a manual, root-only action.
[ -d "$REPO/src" ] || fail "repository has no src/ directory"

cp -f "$REPO"/src/*.js "$APP/src/" || fail "could not copy source files"
[ -f "$REPO/package.json" ] && cp -f "$REPO/package.json" "$APP/package.json"
say "Source updated: $(ls -1 "$APP"/src/*.js | wc -l) files"

# --- 3. Keep the current image so we can roll back ---------------
if sudo "$DOCKER" image tag fahad-ai-office/runtime:0.1.0 fahad-ai-office/runtime:previous 2>/dev/null; then
  say "Saved current image as :previous"
  HAVE_ROLLBACK=1
else
  say "No existing image to save (first deployment)"
  HAVE_ROLLBACK=0
fi

# --- 4. Build the new version. The old one is still serving. -----
say "Building new image..."
if ! $DC build >>"$LOG" 2>&1; then
  say "Build failed. See $LOG"
  [ "$HAVE_ROLLBACK" = "1" ] && sudo "$DOCKER" image tag fahad-ai-office/runtime:previous fahad-ai-office/runtime:0.1.0
  fail "build error"
fi
say "Build succeeded"

# --- 5. Test the new image BEFORE it replaces anything -----------
say "Testing new image (no Claude calls, no cost)..."
if ! $DC run --rm --no-deps runtime node src/healthcheck.js >>"$LOG" 2>&1; then
  say "Health check failed on the NEW image."
  if [ "$HAVE_ROLLBACK" = "1" ]; then
    sudo "$DOCKER" image tag fahad-ai-office/runtime:previous fahad-ai-office/runtime:0.1.0
    say "Restored the previous image. Running version is untouched."
  fi
  fail "new version did not pass its health check"
fi
say "Health check passed"

# --- 6. Switch over ----------------------------------------------
say "Switching to the new version..."
if ! $DC up -d >>"$LOG" 2>&1; then
  say "Could not start the new version. Rolling back..."
  if [ "$HAVE_ROLLBACK" = "1" ]; then
    sudo "$DOCKER" image tag fahad-ai-office/runtime:previous fahad-ai-office/runtime:0.1.0
    $DC up -d >>"$LOG" 2>&1
    say "Rolled back to the previous version."
  fi
  fail "could not start new version"
fi

# --- 7. Confirm it is actually alive -----------------------------
sleep 8
STATUS=$($DC ps 2>/dev/null | grep fahad-office-runtime || true)

if echo "$STATUS" | grep -qiE 'up|running'; then
  say "Container is running"
else
  say "Container is NOT running after switch. Rolling back..."
  if [ "$HAVE_ROLLBACK" = "1" ]; then
    sudo "$DOCKER" image tag fahad-ai-office/runtime:previous fahad-ai-office/runtime:0.1.0
    $DC up -d >>"$LOG" 2>&1
    say "Rolled back."
  fi
  fail "container did not stay up"
fi

if $DC logs --tail=40 2>/dev/null | grep -q "Runtime v1"; then
  say "Startup banner confirmed — the office is listening"
else
  say "WARNING: startup banner not seen yet (may still be starting)"
fi

say "DEPLOYMENT SUCCESSFUL — now running commit $COMMIT"
say "============================================================"
exit 0
ENDSCRIPT

chown root:root "$SCRIPT"
chmod 755 "$SCRIPT"
echo "[script]   installed at $SCRIPT (root-owned, deploy cannot modify)"

# ------------------------------------------------------------
# 6. SSH key, locked to that one command
# ------------------------------------------------------------
mkdir -p "$DEPLOY_HOME/.ssh"

if [ ! -f "$DEPLOY_HOME/.ssh/id_ed25519" ]; then
  ssh-keygen -t ed25519 -N "" -C "github-actions-fahad-ai-office" \
    -f "$DEPLOY_HOME/.ssh/id_ed25519" >/dev/null
  echo "[ssh]      new key pair generated"
else
  echo "[ssh]      key pair already exists, reusing"
fi

# The forced command is the hard gate: this key can start the
# deploy script and nothing else. No shell, no port forwarding,
# no pty, no agent forwarding.
{
  printf 'command="%s",no-port-forwarding,no-agent-forwarding,' "$SCRIPT"
  printf 'no-X11-forwarding,no-pty,restrict '
  cat "$DEPLOY_HOME/.ssh/id_ed25519.pub"
} > "$DEPLOY_HOME/.ssh/authorized_keys"

# Root owns .ssh so the deploy user cannot add its own key or
# remove the forced command. sshd accepts root-owned files here.
chown -R root:root "$DEPLOY_HOME/.ssh"
chmod 700 "$DEPLOY_HOME/.ssh"
chmod 644 "$DEPLOY_HOME/.ssh/authorized_keys"
chmod 600 "$DEPLOY_HOME/.ssh/id_ed25519"
chown root:root "$DEPLOY_HOME/.ssh/id_ed25519"

echo "[ssh]      forced command set — this key cannot open a shell"

# ------------------------------------------------------------
# 7. Prove Hermes was not touched
# ------------------------------------------------------------
AFTER=$("$DOCKER_BIN" ps --format '{{.Names}} {{.Status}}' | sort)

echo ""
echo "Containers after:"
echo "$AFTER" | sed 's/^/    /'

echo ""
if [ "$BEFORE" = "$AFTER" ]; then
  echo "VERIFIED: every container is exactly as it was. Hermes untouched."
else
  echo "NOTE: container list changed. Review the two lists above."
fi

echo ""
echo "============================================================"
echo "Done. Next: copy the private key into GitHub."
echo ""
echo "Security summary:"
echo "  deploy is in groups : $(id -nG "$DEPLOY_USER")"
echo "  deploy in docker grp: $(id -nG "$DEPLOY_USER" | grep -qw docker && echo 'YES - PROBLEM' || echo 'no')"
echo "  can deploy read .env: $(sudo -u "$DEPLOY_USER" test -r "$APP/.env" 2>/dev/null && echo 'YES - PROBLEM' || echo 'no')"
echo "  permitted sudo cmds : 7 (all pinned to this project)"
echo ""
