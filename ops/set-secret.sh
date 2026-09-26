#!/usr/bin/env bash
# Adds or replaces ONE allowlisted credential in the production .env and
# reloads only the Fahad AI Office containers. Run as root from a checkout:
#
#   sudo bash ops/set-secret.sh GEMINI_API_KEY
#
# The value is read with hidden input, checked against the credential's
# documented shape, never printed, never passed on a command line and never
# written to shell history. Other .env lines are preserved byte for byte.
# Touches nothing Hermes-related. Undo: run again with the previous value, or
# delete the line from .env and run `docker compose up -d --no-deps runtime`.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run as root: sudo bash ops/set-secret.sh NAME'; exit 1; }
APP=/opt/fahad-ai-office
ENV_FILE=$APP/.env
COMPOSE=(docker compose -f "$APP/docker-compose.yml")
NAME=${1:-}

# name → accepted shape (anchored). Only these names can be written.
declare -A SHAPE=(
  [CODING_SUPABASE_ACCESS_TOKEN]='^sbp_[A-Za-z0-9_]{20,}$'
  # Google AI Studio issues "auth keys" (AQ.…) since 2026-05-28; legacy
  # standard keys (AIza + 35 chars) are accepted while Google still honours them.
  [GEMINI_API_KEY]='^(AQ\.[A-Za-z0-9_-][A-Za-z0-9._-]{30,510}|AIza[0-9A-Za-z_-]{35})$'
  [GROQ_API_KEY]='^gsk_[A-Za-z0-9]{20,}$'
  [OPENROUTER_API_KEY]='^sk-or-[A-Za-z0-9_-]{20,}$'
  [CEREBRAS_API_KEY]='^csk-[A-Za-z0-9]{20,}$'
  [MISTRAL_API_KEY]='^[A-Za-z0-9]{24,64}$'
  [GITHUB_MODELS_TOKEN]='^github_pat_[A-Za-z0-9_]{20,}$'
  [KIMI_API_KEY]='^sk-[A-Za-z0-9]{20,}$'
  [ZHIPU_API_KEY]='^[A-Za-z0-9._-]{20,128}$'
  # Alibaba Cloud Model Studio: current workspace-scoped keys (sk-ws-…, issued
  # per workspace, e.g. Singapore) and legacy account keys (sk- + alphanumerics).
  [QWEN_API_KEY]='^sk-(ws-[A-Za-z0-9_-]{20,256}|[A-Za-z0-9]{20,256})$'
  [MINIMAX_API_KEY]='^[A-Za-z0-9._-]{20,512}$'
)
if [[ -z $NAME || -z ${SHAPE[$NAME]+x} ]]; then
  echo "Usage: sudo bash ops/set-secret.sh NAME   (NAME is one of: ${!SHAPE[*]})"; exit 1
fi
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || { echo "Missing $ENV_FILE; nothing changed."; exit 1; }

read -rsp "Paste the value for $NAME (input hidden): " value; echo
value=${value//$'\r'/}
if [[ ! $value =~ ${SHAPE[$NAME]} ]]; then
  # Only the length and the expected pattern are shown, never the value.
  length=${#value}; unset value
  echo "That does not look like a $NAME value (received $length characters; expected pattern ${SHAPE[$NAME]}); nothing changed."; exit 1
fi

# Rewrite .env atomically with the same owner and mode: drop old NAME lines,
# append the new one.
tmp=$(mktemp "$APP/.env.XXXXXX")
trap 'rm -f "$tmp"' EXIT
grep -v "^$NAME=" "$ENV_FILE" > "$tmp" || true
[[ ! -s $tmp || -z $(tail -c1 "$tmp") ]] || printf '\n' >> "$tmp"
printf '%s=%s\n' "$NAME" "$value" >> "$tmp"
unset value
chown --reference="$ENV_FILE" "$tmp"
chmod --reference="$ENV_FILE" "$tmp"
mv -f "$tmp" "$ENV_FILE"
echo "Stored $NAME in .env (not shown)."

echo 'Reloading the Office runtime (and the coding worker when enabled)...'
services=(runtime)
if grep -Eq '^COMPOSE_PROFILES=(.*,)?coding(,.*)?$' "$ENV_FILE"; then services+=(coding-worker); COMPOSE+=(--profile coding); fi
"${COMPOSE[@]}" up -d --no-deps "${services[@]}"
for attempt in $(seq 1 24); do
  health=$(docker inspect -f '{{.State.Health.Status}}' fahad-office-runtime 2>/dev/null || echo missing)
  [[ $health == healthy ]] && break
  sleep 5
done
echo "Office runtime health: $health"
[[ $health == healthy ]] || { echo 'The runtime is not healthy; check: docker logs --tail 50 fahad-office-runtime'; exit 1; }
echo 'Done. Next: Hub → Coding Agent → Model pool → Run live canary.'
