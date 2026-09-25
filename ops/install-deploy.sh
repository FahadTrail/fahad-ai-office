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
DEPLOY_SSH=/home/deploy/.ssh
[[ -d "$DEPLOY_SSH" && ! -L "$DEPLOY_SSH" && -f "$DEPLOY_SSH/authorized_keys" && ! -L "$DEPLOY_SSH/authorized_keys" ]] || exit 1
# sshd reads authorized_keys under the target user's identity. Root-only 700
# prevents even the already-authorized forced-command key from authenticating.
# Group traversal restores that existing access; deploy still cannot edit keys.
chown root:deploy "$DEPLOY_SSH"
chmod 750 "$DEPLOY_SSH"
chown root:root "$DEPLOY_SSH/authorized_keys"
chmod 644 "$DEPLOY_SSH/authorized_keys"
bash -n "$ROOT/ops/deploy.sh"
visudo -c -f /etc/sudoers.d/fahad-office-deploy >/dev/null
BACKUP=$(mktemp -d "$APP/deploy-config-backup.XXXXXXXX")
chmod 700 "$BACKUP"
cp -p /usr/local/bin/fahad-office-deploy "$BACKUP/deploy.sh"
cp -p "$APP/Dockerfile" "$BACKUP/Dockerfile"
cp -p "$APP/docker-compose.yml" "$BACKUP/docker-compose.yml"
[[ ! -f "$APP/.dockerignore" ]] || cp -p "$APP/.dockerignore" "$BACKUP/.dockerignore"
install -o root -g root -m 755 "$ROOT/ops/deploy.sh" /usr/local/bin/fahad-office-deploy
install -o root -g root -m 644 "$ROOT/Dockerfile" "$APP/Dockerfile"
install -o root -g root -m 644 "$ROOT/.dockerignore" "$APP/.dockerignore"
# The compose file adds the opt-in coding-worker service (profile "coding").
# It starts only after COMPOSE_PROFILES=coding is added to $APP/.env.
install -o root -g root -m 644 "$ROOT/docker-compose.yml" "$APP/docker-compose.yml.candidate"
docker compose -f "$APP/docker-compose.yml.candidate" config --quiet || { rm -f "$APP/docker-compose.yml.candidate"; echo 'Compose file validation failed; nothing changed'; exit 1; }
mv -f "$APP/docker-compose.yml.candidate" "$APP/docker-compose.yml"
if [[ ! -f "$APP/package-lock.json" ]]; then
  install -o deploy -g deploy -m 644 "$ROOT/package-lock.json" "$APP/package-lock.json"
fi
[[ $(stat -c '%U' "$APP/package-lock.json") == deploy ]] || { echo 'Lockfile ownership needs review'; exit 1; }
echo "Deployment helper updated; backup: $BACKUP"
echo 'No container was restarted. Existing SSH restrictions and sudo whitelist are unchanged.'
echo 'To enable the Coding Agent worker later: add COMPOSE_PROFILES=coding and its credentials to .env (see docs/coding-agent.md).'
