#!/usr/bin/env bash
# Historical initial hardening is already installed. Never rerun it on production.
set -euo pipefail
printf '%s\n' 'Initial deploy setup is retired; no changes were made.' >&2
printf '%s\n' 'For a reviewed deployment-helper update, root may run ops/install-deploy.sh.' >&2
exit 1
