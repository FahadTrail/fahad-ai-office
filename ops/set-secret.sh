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
  # Alibaba Cloud Model Studio. Alibaba documents only that keys created after
  # the workspace upgrade "start with sk-ws" (legacy keys start with sk-); it
  # does not publish the rest of the format. So the shape is a safety guard
  # only (prefix, no whitespace/quotes/shell characters, sane length) and the
  # provider itself verifies the key before it is stored (verify_qwen_key).
  [QWEN_API_KEY]='^sk-(ws[A-Za-z0-9._-]{8,256}|[A-Za-z0-9]{20,256})$'
  [MINIMAX_API_KEY]='^[A-Za-z0-9._-]{20,512}$'
)
if [[ -z $NAME || -z ${SHAPE[$NAME]+x} ]]; then
  echo "Usage: sudo bash ops/set-secret.sh NAME   (NAME is one of: ${!SHAPE[*]})"; exit 1
fi
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || { echo "Missing $ENV_FILE; nothing changed."; exit 1; }

read -rsp "Paste the value for $NAME (input hidden): " value; echo
value=${value//$'\r'/}
# Web consoles often copy invisible characters with a key: non-breaking and
# zero-width spaces, word joiners and byte-order marks (and tabs). They are
# never part of a credential, so they are removed before validation.
for invisible in $'\xc2\xa0' $'\xe2\x80\x8b' $'\xe2\x80\x8c' $'\xe2\x80\x8d' $'\xe2\x81\xa0' $'\xef\xbb\xbf' $'\t'; do
  value=${value//"$invisible"/}
done
if [[ ! $value =~ ${SHAPE[$NAME]} ]]; then
  # Only the length, the count of characters outside the safe set and the
  # expected pattern are shown, never the value.
  length=${#value}; odd=${value//[A-Za-z0-9._-]/}; odd=${#odd}; unset value
  echo "That does not look like a $NAME value (received $length characters, $odd outside [A-Za-z0-9._-]; expected pattern ${SHAPE[$NAME]}); nothing changed."; exit 1
fi

# Model Studio keys are verified with the provider before anything changes:
# the key's own model list on the configured endpoint (HTTP 200 = the key is
# valid for that workspace/region, even before models are activated). The key
# goes to curl on stdin as a header, never on a command line.
verify_qwen_key() {
  local endpoint models code
  endpoint=$(grep -m1 '^QWEN_API_ENDPOINT=' "$ENV_FILE" | cut -d= -f2- || true)
  endpoint=${endpoint:-https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions}
  [[ $endpoint =~ ^https://[A-Za-z0-9.-]+/[A-Za-z0-9/._-]*$ ]] || { echo 'QWEN_API_ENDPOINT in .env is not a plain HTTPS URL; nothing changed.'; return 1; }
  models=${endpoint%/chat/completions}/models
  code=$(printf 'Authorization: Bearer %s\n' "$value" | curl -sS --max-time 20 -o /dev/null -w '%{http_code}' -H @- "$models" 2>/dev/null || true)
  case $code in
    200) echo "Model Studio accepted the key (model list on ${models#https://} → HTTP 200)." ;;
    401) echo "Model Studio rejected the key (HTTP 401 on ${models#https://}): it is invalid or belongs to a different workspace/region than QWEN_API_ENDPOINT; nothing changed."; return 1 ;;
    *) echo "Could not verify the key with Model Studio (HTTP ${code:-none}); storing it anyway — the next live canary checks it." ;;
  esac
}
if [[ $NAME == QWEN_API_KEY && ${SET_SECRET_SKIP_VERIFY:-} != 1 ]]; then
  verify_qwen_key || { unset value; exit 1; }
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
