# Fahad AI Office

GitHub is the source of truth for code. Supabase holds the database, memory,
events and realtime. Hostinger runs the production container. Step 3B is
implemented; Step 3C remains out of scope for this deployment change.

## Runtime

`src/db.js`, `src/chief.js` and the original polling loop in `src/index.js`
were recovered from the installer and matched against production SHA-256
hashes before modification. The runtime uses `public.claim_next_job()`;
the private implementation stays behind its service-role-only public wrapper.

Dependencies are pinned to the versions found in production on 2026-09-21:
Claude Agent SDK 0.3.278 and Supabase JS 2.116.0. `package-lock.json` locks
the dependency tree; builds use `npm ci`.

## Deployment

`.github/workflows/deploy.yml` validates code, runs tests and builds an image
before using the existing `VPS_HOST` and `VPS_SSH_KEY_B64` secrets. Deployments
are serialized and are limited to `main`. The SSH host public key is pinned
to the key read through the authenticated Hostinger console.

The forced SSH command runs root-owned `ops/deploy.sh`, installed at
`/usr/local/bin/fahad-office-deploy`. It fetches main, backs up sources and the
current image, builds the candidate and runs a read-only readiness check.
Only a passing candidate replaces the runtime. Three consecutive Docker
healthy observations are required for success; failed startup or readiness
triggers rollback. Build and preflight failure leave the running container
untouched. Logs and source backups remain in `/opt/fahad-ai-office/logs/`.

The installer in `ops/install-deploy.sh` updates only the Office's helper,
Dockerfile, ignore file and lockfile on an already-hardened server. It needs
root authorization once, does not restart containers, and does not broaden
the existing seven-command sudo whitelist. The workflow never updates these
root-owned files itself. Infrastructure changes require a reviewed root install.

The legacy `setup.sh` and `deploy-setup.sh` now exit without changing anything.
Their historical contents remain recoverable from Git history.

## Checks

`npm test` runs isolated tests without live credentials or AI calls.
`npm run healthcheck` and `npm run selftest` perform the same read-only
production readiness check: settings, JavaScript syntax, SDK imports, Chief
configuration, database access and public RPC visibility. They never claim a
job, modify database records, or invoke Claude. Run them inside the Office
container, where the existing environment is already available.

Docker's health check uses `node src/healthcheck.js --runtime` to verify the
process heartbeat and successful job polling. It makes no network or AI calls.
The startup readiness check verifies database access before polling starts.

## Boundaries

The runtime exposes no ports and keeps its own network and volumes. No command
in this deployment lists, inspects, or controls unrelated containers.
Supabase and Anthropic credentials stay solely in the server's root-owned
`.env`. Do not add them to GitHub, Actions, logs, artifacts, or source files.
`selftest` intentionally no longer performs the historical billable Claude call.

Rollback restores the prior image and source files and verifies it is running.
An initial rollback target may predate Docker health checks; later targets have
the health check. A real AI task is not part of deployment verification.
