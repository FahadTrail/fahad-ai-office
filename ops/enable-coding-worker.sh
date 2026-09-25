#!/usr/bin/env bash
# Enables the Fahad Coding Agent worker on the production VPS. Run once, as
# root, from a fresh checkout of main (see docs/coding-agent.md):
#
#   sudo bash ops/enable-coding-worker.sh
#
# Steps: installs the reviewed deployment files (ops/install-deploy.sh, no
# restart), asks for the agent's fine-grained GitHub token (hidden input; never
# printed or written to shell history), enables the "coding" compose profile,
# starts only the coding-worker container, waits for it to become healthy and
# verifies sandbox uid isolation. Idempotent. Touches nothing Hermes-related.
# Undo: docker compose -f /opt/fahad-ai-office/docker-compose.yml stop coding-worker
#       and remove the COMPOSE_PROFILES / CODING_GITHUB_TOKEN lines from .env.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run as root: sudo bash ops/enable-coding-worker.sh'; exit 1; }
ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)
APP=/opt/fahad-ai-office
ENV_FILE=$APP/.env
COMPOSE=(docker compose -f "$APP/docker-compose.yml")
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || { echo "Missing $ENV_FILE"; exit 1; }

# Preflight: every check runs before anything is written or installed.
for required in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY; do
  grep -q "^$required=." "$ENV_FILE" || { echo "$required is missing from .env; nothing changed."; exit 1; }
done
grep -Eq '^(ANTHROPIC|OPENAI|DEEPSEEK|QWEN|KIMI|ZHIPU|MINIMAX|GEMINI|OPENROUTER|GROQ)_API_KEY=.' "$ENV_FILE" || { echo 'No model provider key in .env; nothing changed.'; exit 1; }
if grep -q '^COMPOSE_PROFILES=' "$ENV_FILE" && ! grep -Eq '^COMPOSE_PROFILES=(.*,)?coding(,.*)?$' "$ENV_FILE"; then
  echo 'COMPOSE_PROFILES is set without "coding"; add it manually. Nothing changed.'; exit 1
fi

echo '1/5 Checking the Coding Agent GitHub token...'
if grep -Eq '^CODING_GITHUB_TOKEN=github_pat_[A-Za-z0-9_]{20,}' "$ENV_FILE"; then
  echo '    CODING_GITHUB_TOKEN already present (not shown).'
else
  grep -q '^CODING_GITHUB_TOKEN=' "$ENV_FILE" && { echo '    CODING_GITHUB_TOKEN exists but is not a fine-grained token (github_pat_...). Replace it manually; nothing changed.'; exit 1; }
  read -rsp '    Paste the fine-grained GitHub token for the Coding Agent (input hidden): ' token; echo
  [[ $token =~ ^github_pat_[A-Za-z0-9_]{20,}$ ]] || { unset token; echo '    Not a fine-grained token (github_pat_...); nothing changed.'; exit 1; }
  [[ -z $(tail -c1 "$ENV_FILE") ]] || printf '\n' >> "$ENV_FILE"
  printf 'CODING_GITHUB_TOKEN=%s\n' "$token" >> "$ENV_FILE"
  unset token
  echo '    Stored in .env (not shown).'
fi

echo '2/5 Installing the reviewed compose file and deploy helper (no restart)...'
bash "$ROOT/ops/install-deploy.sh"

echo '3/5 Enabling the coding compose profile...'
if ! grep -q '^COMPOSE_PROFILES=' "$ENV_FILE"; then
  [[ -z $(tail -c1 "$ENV_FILE") ]] || printf '\n' >> "$ENV_FILE"
  printf 'COMPOSE_PROFILES=coding\n' >> "$ENV_FILE"
fi

echo '4/5 Starting the coding worker (the Office runtime is not restarted)...'
"${COMPOSE[@]}" --profile coding up -d --no-deps coding-worker
for attempt in $(seq 1 24); do
  health=$(docker inspect -f '{{.State.Health.Status}}' fahad-office-coding-worker 2>/dev/null || echo missing)
  [[ $health == healthy ]] && break
  [[ $health == unhealthy || $health == missing ]] && [[ $attempt -gt 6 ]] && break
  sleep 5
done
echo "    worker health: $health"
[[ $health == healthy ]] || { echo '    The worker is not healthy; recent log lines:'; docker logs --tail 30 fahad-office-coding-worker 2>&1 | sed 's/^/    /'; exit 1; }

echo '5/5 Verifying sandbox isolation inside the worker...'
docker exec fahad-office-coding-worker node src/coding-agent/verify-isolation.js
docker logs fahad-office-coding-worker 2>&1 | grep -m1 'routable models' | sed 's/^/    /' || true
echo 'Coding Agent worker is running. Next: Hub → Coding Agent → start a small task.'
