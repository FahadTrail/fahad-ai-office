#!/usr/bin/env bash
# Retired: the runtime now lives in src/ and package.json.
# Never overwrite a hardened production installation with the old bootstrap.
set -euo pipefail
printf '%s\n' 'setup.sh is retired. Use the reviewed main-branch deployment workflow.' >&2
printf '%s\n' 'No files, containers, credentials, or database records were changed.' >&2
exit 1
