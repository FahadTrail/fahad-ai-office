#!/usr/bin/env bash
# READ-ONLY inventory of Hermes for its decommission plan.
#
#   sudo bash ops/hermes-audit.sh > hermes-audit.txt
#
# It changes nothing: no stop, restart, delete, prune, edit or network call.
# It prints NAMES only — container, image, volume, network, unit, cron line
# owner, directory, env variable and label names — never file contents or
# environment VALUES, so no Hermes credential is read or copied.
# Review the output, then share it; the Office maps each Hermes capability to
# its replacement in docs/hermes-decommission.md.
set -uo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run as root (read-only): sudo bash ops/hermes-audit.sh'; exit 1; }
PATTERN='[Hh]ermes'
section() { printf '\n== %s ==\n' "$1"; }

section 'Host'
hostname; date -u +%FT%TZ

if command -v docker >/dev/null; then
  section 'Containers (name | image | status | ports | compose project)'
  docker ps -a --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}|{{.Label "com.docker.compose.project"}}' | grep -E "$PATTERN" || echo '(none)'
  HERMES_CONTAINERS=$(docker ps -a --format '{{.Names}}|{{.Image}}|{{.Label "com.docker.compose.project"}}' | grep -E "$PATTERN" | cut -d'|' -f1)
  for container in $HERMES_CONTAINERS; do
    section "Container $container"
    echo 'Environment variable NAMES (values not shown):'
    docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" | sed -E 's/=.*$//' | sort -u | sed 's/^/  /'
    echo 'Mounts (type source -> destination):'
    docker inspect --format '{{range .Mounts}}{{.Type}} {{.Source}} {{.Destination}}{{println}}{{end}}' "$container" | while read -r type source destination; do
      [[ -n $type ]] && printf '  %s %s -> %s  (%s)\n' "$type" "$source" "$destination" "$(du -sh "$source" 2>/dev/null | cut -f1)"
    done
    echo 'Networks:'
    docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}  {{$name}}{{println}}{{end}}' "$container"
    echo 'Traefik / routing labels (names and host rules only):'
    docker inspect --format '{{range $key, $value := .Config.Labels}}{{$key}}={{$value}}{{println}}{{end}}' "$container" | grep -E '^traefik\..*\.rule=' | sed 's/^/  /' || true
    echo 'Restart policy:'; docker inspect --format '  {{.HostConfig.RestartPolicy.Name}}' "$container"
  done
  section 'Images'; docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep -E "$PATTERN" || echo '(none)'
  section 'Volumes'; docker volume ls --format '{{.Name}}' | grep -E "$PATTERN" || echo '(none)'
  section 'Volume sizes (persistent data)'
  for volume in $(docker volume ls --format '{{.Name}}' | grep -E "$PATTERN"); do
    printf '  %s  %s\n' "$volume" "$(du -sh "$(docker volume inspect --format '{{.Mountpoint}}' "$volume")" 2>/dev/null | cut -f1)"
  done
  section 'Networks'; docker network ls --format '{{.Name}}' | grep -E "$PATTERN" || echo '(none)'
  section 'Containers attached to Hermes networks (an Office container here is a dependency)'
  for network in $(docker network ls --format '{{.Name}}' | grep -E "$PATTERN"); do
    printf '  %s: %s\n' "$network" "$(docker network inspect --format '{{range .Containers}}{{.Name}} {{end}}' "$network")"
  done
  section 'Credential independence (shared NAMES only; values compared here, never printed)'
  OFFICE_ENV=${HERMES_AUDIT_OFFICE_ENV:-/opt/fahad-ai-office/.env}
  for container in $HERMES_CONTAINERS; do
    docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" | while IFS= read -r pair; do
      name=${pair%%=*}
      [[ $name =~ ^[A-Za-z_][A-Za-z0-9_]*$ && -f $OFFICE_ENV ]] || continue
      office=$(grep -E "^${name}=" "$OFFICE_ENV" | tail -n 1) || continue
      office=${office#*=}; office=${office#[\"\']}; office=${office%[\"\']}
      [[ -n $office ]] || continue
      [[ $office == "${pair#*=}" ]] && same=yes || same=no
      printf '  %s: in both, same value: %s\n' "$name" "$same"
    done
  done | sort -u
  echo '  (end)'
fi

section 'Traefik file-provider rules mentioning Hermes (file names and Host rules only)'
for base in /etc/traefik /opt /srv /root; do
  find "$base" -maxdepth 4 -type f -not -path '*/.git*' -not -path '*/node_modules/*' \( -name '*.yml' -o -name '*.yaml' -o -name '*.toml' \) 2>/dev/null | while read -r file; do
    grep -qiE hermes "$file" 2>/dev/null || continue
    echo "  $file"
    grep -oE 'Host(SNI)?\(`[^)]*`\)' "$file" 2>/dev/null | sort -u | sed 's/^/    /'
  done
done

section 'systemd units'
systemctl list-unit-files --no-pager 2>/dev/null | grep -E "$PATTERN" || echo '(none)'
section 'Cron entries mentioning Hermes (owner and schedule only)'
for file in /etc/crontab /etc/cron.d/* /var/spool/cron/crontabs/*; do
  [[ -f $file ]] && grep -lE "$PATTERN" "$file" 2>/dev/null | while read -r match; do echo "  $match: $(grep -cE "$PATTERN" "$match") line(s)"; done
done
section 'Directories named like Hermes (top level: name, size, owner)'
for base in /opt /srv /home /root /var/lib; do
  find "$base" -maxdepth 2 -type d -iname '*hermes*' 2>/dev/null | while read -r dir; do
    printf '  %s  %s  %s\n' "$dir" "$(du -sh "$dir" 2>/dev/null | cut -f1)" "$(stat -c %U "$dir")"
  done
done
section 'Listening sockets owned by Hermes processes'
ss -ltnpH 2>/dev/null | grep -E "$PATTERN" || echo '(none found by process name)'
section 'Separation check: Office paths that mention Hermes (should be none)'
grep -rlE "$PATTERN" /opt/fahad-ai-office/.env 2>/dev/null && echo '  WARNING: the Office .env mentions Hermes' || echo '  Office .env does not mention Hermes'
echo; echo 'Audit finished. Nothing was changed.'
