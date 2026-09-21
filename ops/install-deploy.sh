#!/usr/bin/env bash
# One-time update of this already-hardened Office installation, run as root.
# Does not create credentials, expand sudo, alter other applications, or restart anything.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Root authorization is required'; exit 1; }
ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)
APP=/opt/fahad-ai-office
[[ -d "$APP/src" && -f "$APP/.env" && ! -L "$APP" && ! -L "$APP/src" ]] || exit 1
[[ -f /etc/sudoers.d/fahad-office-deploy && -f /usr/local/bin/fahad-office-deploy ]] || exit 1
[[ $(command -v docker) == /usr/bin/docker ]] || exit 1
id deploy >/dev/null
bash -n "$ROOT/ops/deploy.sh"
visudo -c -f /etc/sudoers.d/fahad-office-deploy >/dev/null
BACKUP=$(mktemp -d "$APP/deploy-config-backup.XXXXXXXX")
chmod 700 "$BACKUP"
cp -p /usr/local/bin/fahad-office-deploy "$BACKUP/deploy.sh"
cp -p "$APP/Dockerfile" "$BACKUP/Dockerfile"
[[ ! -f "$APP/.dockerignore" ]] || cp -p "$APP/.dockerignore" "$BACKUP/.dockerignore"
install -o root -g root -m 755 "$ROOT/ops/deploy.sh" /usr/local/bin/fahad-office-deploy
install -o root -g root -m 644 "$ROOT/Dockerfile" "$APP/Dockerfile"
install -o root -g root -m 644 "$ROOT/.dockerignore" "$APP/.dockerignore"
if [[ ! -f "$APP/package-lock.json" ]]; then
  install -o deploy -g deploy -m 644 "$ROOT/package-lock.json" "$APP/package-lock.json"
fi
[[ $(stat -c '%U' "$APP/package-lock.json") == deploy ]] || { echo 'Lockfile ownership needs review'; exit 1; }
echo "Deployment helper updated; backup: $BACKUP"
echo 'No container was restarted. Existing SSH restrictions and sudo whitelist are unchanged.'
