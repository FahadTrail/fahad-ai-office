#!/usr/bin/env bash
# Installed root-owned at /usr/local/bin/fahad-office-deploy; runs as deploy.
# Uses only the existing seven project-specific sudo commands. No shell access.
set -euo pipefail
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
APP=/opt/fahad-ai-office
REPO=$APP/.deploy-repo
LOG=$APP/logs/deploy.log
DOCKER=/usr/bin/docker
DC=(sudo "$DOCKER" compose -f "$APP/docker-compose.yml")
IMAGE=fahad-ai-office/runtime:0.1.0
PREVIOUS=fahad-ai-office/runtime:previous
say() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG"; }
exec 9>"$APP/logs/deploy.lock"
flock -n 9 || { say 'DEPLOY FAILED: another deployment is active'; exit 1; }
[[ $(id -un) == deploy && -d "$APP/src" && ! -L "$APP/src" && ! -L "$REPO" ]] || exit 1
BACKUP=$(mktemp -d "$APP/logs/rollback.XXXXXXXX")
COPIED=0
SAVED=0
SWITCHED=0
restore_sources() {
  if [[ -d "$BACKUP/previous-src" ]]; then
    [[ ! -e "$BACKUP/failed-src" ]] || { say 'ROLLBACK FAILED: failed source snapshot already exists'; exit 1; }
    [[ ! -d "$APP/src" ]] || mv "$APP/src" "$BACKUP/failed-src"
    mv "$BACKUP/previous-src" "$APP/src"
  fi
  cp -f "$BACKUP/package.json" "$APP/package.json"
  [[ ! -f "$BACKUP/package-lock.json" ]] || cp -f "$BACKUP/package-lock.json" "$APP/package-lock.json"
}
rollback() {
  local reason=$1
  trap - ERR INT TERM HUP
  set +e
  say "DEPLOY FAILED: $reason"
  if [[ "$COPIED" == 1 ]]; then restore_sources; fi
  if [[ "$SAVED" == 1 ]]; then
    if ! sudo "$DOCKER" image tag "$PREVIOUS" "$IMAGE"; then
      say 'ROLLBACK FAILED: previous image could not be restored'; exit 1
    fi
  fi
  if [[ "$SWITCHED" == 1 ]]; then
    say 'Restoring the previous runtime image...'
    if ! "${DC[@]}" up -d >>"$LOG" 2>&1; then
      say 'ROLLBACK FAILED: previous runtime could not start'; exit 1
    fi
    sleep 10
    local status
    status=$("${DC[@]}" ps 2>/dev/null)
    if printf '%s\n' "$status" | grep 'fahad-office-runtime' | grep -Eq 'Up|running' &&
       ! printf '%s\n' "$status" | grep 'fahad-office-runtime' | grep -Eqi 'unhealthy|restarting|exited'; then
      say 'ROLLBACK SUCCEEDED: previous runtime is running'
    else
      say 'ROLLBACK FAILED: runtime needs operator attention'
    fi
  else
    say 'Running container was not replaced.'
  fi
  say "Diagnostic log: $LOG; source backup: $BACKUP"
  exit 1
}
trap 'rollback "unexpected deployment error at line $LINENO"' ERR
trap 'rollback "deployment interrupted"' INT TERM HUP
say 'Deployment started (branch: main)'
if [[ ! -d "$REPO/.git" ]]; then
  git init "$REPO" >>"$LOG" 2>&1
  git -C "$REPO" remote add origin https://github.com/FahadTrail/fahad-ai-office.git
fi
git -C "$REPO" remote set-url origin https://github.com/FahadTrail/fahad-ai-office.git
git -C "$REPO" fetch --depth 1 origin main >>"$LOG" 2>&1
git -C "$REPO" reset --hard origin/main >>"$LOG" 2>&1
COMMIT=$(git -C "$REPO" rev-parse HEAD)
say "Candidate commit $COMMIT"
for file in db.js chief.js index.js selftest.js healthcheck.js; do
  [[ -f "$REPO/src/$file" && ! -L "$REPO/src/$file" ]] || rollback "missing source file: $file"
done
[[ -z "$(find "$REPO/src" -type l -print -quit)" ]] || rollback 'source tree contains a symbolic link'
[[ -f "$REPO/package.json" && -s "$REPO/package-lock.json" ]] || rollback 'missing package manifest or lockfile'
cp -p "$APP/package.json" "$BACKUP/package.json"
[[ ! -f "$APP/package-lock.json" ]] || cp -p "$APP/package-lock.json" "$BACKUP/package-lock.json"
sudo "$DOCKER" image tag "$IMAGE" "$PREVIOUS"
SAVED=1
cp -a "$REPO/src" "$BACKUP/candidate-src"
COPIED=1
mv "$APP/src" "$BACKUP/previous-src"
mv "$BACKUP/candidate-src" "$APP/src"
cp -f "$REPO/package.json" "$APP/package.json"
cp -f "$REPO/package-lock.json" "$APP/package-lock.json"
say 'Building candidate; current runtime remains running'
"${DC[@]}" build >>"$LOG" 2>&1 || rollback 'candidate build failed'
say 'Checking candidate (read-only; zero AI calls)'
"${DC[@]}" run --rm --no-deps runtime node src/healthcheck.js >>"$LOG" 2>&1 || rollback 'candidate readiness failed'
say 'Candidate passed; switching runtime'
SWITCHED=1
"${DC[@]}" up -d >>"$LOG" 2>&1 || rollback 'candidate startup failed'
stable=0
for attempt in {1..18}; do
  sleep 5
  status=$("${DC[@]}" ps 2>/dev/null)
  row=$(printf '%s\n' "$status" | grep 'fahad-office-runtime' || true)
  if printf '%s\n' "$row" | grep -Eqi 'unhealthy|restarting|exited'; then
    rollback 'candidate runtime became unhealthy'
  fi
  if printf '%s\n' "$row" | grep -Fq '(healthy)'; then
    stable=$((stable + 1))
    [[ $stable -lt 3 ]] || break
  else
    stable=0
  fi
done
[[ $stable -ge 3 ]] || rollback 'candidate did not reach stable healthy state within 90 seconds'
printf '%s\n' "$COMMIT" > "$APP/logs/deployed-sha"
trap - ERR INT TERM HUP
say "DEPLOYMENT SUCCESSFUL — now running commit ${COMMIT:0:7} ($COMMIT); container healthy"
