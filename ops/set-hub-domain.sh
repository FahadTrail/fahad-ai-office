#!/usr/bin/env bash
# Serves the Fahad AI Office Hub on a public domain (for example
# office.trimedia.me) while keeping the current host name working. Run as
# root from a fresh checkout of main:
#
#   sudo bash ops/set-hub-domain.sh office.trimedia.me
#
# Steps: installs the reviewed compose file (ops/install-deploy.sh, which
# keeps a backup and validates it), sets HUB_PUBLIC_HOST=<domain> and
# HUB_EXTRA_PUBLIC_HOST=<previous host> in .env (no other line changes; no
# secret is read or printed), recreates only the Office runtime so Traefik
# picks up the new route, then checks both domains over HTTPS.
# Touches nothing Hermes-related. Idempotent.
# Undo: rerun with the previous domain.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run as root: sudo bash ops/set-hub-domain.sh DOMAIN'; exit 1; }
ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)
APP=/opt/fahad-ai-office
ENV_FILE=$APP/.env
COMPOSE=(docker compose -f "$APP/docker-compose.yml")
DOMAIN=${1:-}
DEFAULT_HOST=fahad-ai-office.srv1964598.hstgr.cloud
[[ $DOMAIN =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || { echo 'Usage: sudo bash ops/set-hub-domain.sh DOMAIN (lowercase host name, e.g. office.trimedia.me)'; exit 1; }
[[ $DOMAIN != *hermes* ]] || { echo 'Refusing a Hermes host name; nothing changed.'; exit 1; }
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || { echo "Missing $ENV_FILE; nothing changed."; exit 1; }

current=$(grep -E '^HUB_PUBLIC_HOST=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)
current=${current:-$DEFAULT_HOST}
extra=$current
[[ $extra != "$DOMAIN" ]] || extra=$(grep -E '^HUB_EXTRA_PUBLIC_HOST=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)
extra=${extra:-$DEFAULT_HOST}

echo "1/4 Installing the reviewed compose file (backup kept; no restart)..."
bash "$ROOT/ops/install-deploy.sh"

echo "2/4 Setting HUB_PUBLIC_HOST=$DOMAIN and HUB_EXTRA_PUBLIC_HOST=$extra in .env..."
tmp=$(mktemp "$APP/.env.XXXXXX")
trap 'rm -f "$tmp"' EXIT
grep -Ev '^(HUB_PUBLIC_HOST|HUB_EXTRA_PUBLIC_HOST)=' "$ENV_FILE" > "$tmp" || true
[[ ! -s $tmp || -z $(tail -c1 "$tmp") ]] || printf '\n' >> "$tmp"
printf 'HUB_PUBLIC_HOST=%s\nHUB_EXTRA_PUBLIC_HOST=%s\n' "$DOMAIN" "$extra" >> "$tmp"
grep -q '^HUB_TRAEFIK_ENABLED=true$' "$tmp" || echo '    Note: HUB_TRAEFIK_ENABLED is not "true" in .env; the reverse proxy will not route the Hub.'
chown --reference="$ENV_FILE" "$tmp"
chmod --reference="$ENV_FILE" "$tmp"
mv -f "$tmp" "$ENV_FILE"

echo '3/4 Recreating the Office runtime with the new route (the coding worker keeps running)...'
"${COMPOSE[@]}" up -d --no-deps runtime
for attempt in $(seq 1 24); do
  health=$(docker inspect -f '{{.State.Health.Status}}' fahad-office-runtime 2>/dev/null || echo missing)
  [[ $health == healthy ]] && break
  sleep 5
done
echo "    runtime health: $health"
[[ $health == healthy ]] || { echo '    The runtime is not healthy; check: docker logs --tail 50 fahad-office-runtime'; exit 1; }

echo '4/4 Checking both domains over HTTPS (the first certificate can take up to a minute)...'
failed=0
for host in "$DOMAIN" "$extra"; do
  code=000
  for attempt in $(seq 1 12); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$host/healthz" || true)
    [[ $code == 200 ]] && break
    sleep 5
  done
  echo "    https://$host/healthz → HTTP $code"
  [[ $code == 200 ]] || failed=1
done
[[ $failed == 0 ]] || { echo 'A domain is not answering yet; check DNS and: docker logs --tail 50 traefik'; exit 1; }
echo "Done: the Hub is served at https://$DOMAIN (and https://$extra)."
