# V3.0 closure checkpoint — 2026-10-28

Status: **NOT CLOSED. Python activation rolled back after deployment transport failure.**

## Execution and verified evidence

- Reviewed and cloned main at approved SHA `5219bbb8afb74abbd1d7d2a671aa365a829fe066`; VPS clean checkout matched origin/main.
- Accessed the owner's authenticated Hostinger console for srv1964598 as root. No SSH identity was installed and no permissions were bypassed.
- Verified shell syntax for install-deploy.sh/deploy.sh, existing sudoers syntax, deploy account, required files, non-symlink app/SSH paths, executable Docker path, available disk/memory, and Compose validity.
- .dockerignore, Compose and deployed helper matched reviewed source. Dockerfile change adds Python/pip. .dockerignore excludes environment files, keys, deployment backups and work directories.
- Installer's SSH ownership/modes were reviewed against actual state: root:deploy 750 directory and root:root 644 authorized_keys were already correct. No effective SSH permission change, sudo edit or SSH configuration change occurred.
- Retained an independent root-only deployment-file backup outside the Docker context, checksum manifest, SSH metadata, pre-change container inventory and rollback instructions under /var/backups. Kept a separately tagged baseline image and installer backup.
- Applied reviewed installer; verified installed files against source. No container restart occurred during installation.
- Dispatched main workflow [#117](https://github.com/FahadTrail/fahad-ai-office/actions/runs/40729290040), job 122960910507 at 20:46 Dubai.
- Code/tests/schema replay, CI image build and sandbox privilege separation passed. VPS deployment failed: **SSH port 22 connection timed out**, exit 255, before the remote deployment command started.
- Stopped activation per owner's condition. No retry, manual deployment, firewall/SSH modification or Python agent session was attempted after failure.
- Reverted deployment configuration from the independent baseline backup and verified file equality, Compose validity and unchanged SSH metadata. The runtime image and sources never switched.

## Production observation

At 20:49 Dubai, /healthz returned HTTP 200, ok true, version `5219bbb8afb7`; deployed-sha held the full approved SHA.
Both Office containers retained their pre-change IDs and image, were healthy, and had RestartCount 0. Python/pip commands were absent in both.
HABRAH staging and the remaining pre-existing VPS services retained their pre-change container IDs and running states. No commands were executed inside HABRAH; no database deletion, reset, restore or migration was performed.
These observations establish unchanged process health, not a fresh end-to-end Office objective or Coding task acceptance.

## Budget and integrations

Production application read-only queries confirmed enabled workspace budget $2/month, $0.10/request, spent $0, reserved $0, period ending November 1. No model calls, budget/provider changes or paid service activation occurred. Provider invoices were not independently reconciled.

Google OAuth client ID, client secret, refresh token and Office folder configuration were all absent (presence checks only; values were never printed). Owner setup/consent remains required; no Google permissions or credentials were created.

The production Supabase project identity was verified from the running Office endpoint and workspace metadata before reading its dashboard. Its backup page lists daily physical backups for October 21–28, latest October 28 01:50:36 UTC (05:50:36 Dubai). These are provider-managed copies, independent of the live database; an owner-controlled off-site backup and successful scratch restore remain unverified. Storage objects are explicitly excluded. No restore or paid clone was started.

## Remaining gates

1. Review and resolve the GitHub-to-VPS SSH connectivity failure without weakening restrictions; then obtain authorization to resume the stopped activation attempt.
2. Repeat installer and deployment only after transport/preflight checks; verify Python and pip in both containers, exact production SHA, sustained health and unchanged neighboring services.
3. Run the dedicated synthetic Python Coding Agent drill described in V3-ACTIVATION-AUDIT-2026-10-28.md. It remains NOT EXECUTED; no local or CI test is represented as agent production E2E evidence.
4. Owner-controlled Google OAuth setup/consent, then real folder-bound integration verification.
5. Establish evidence of an independent off-site backup and a safe restore drill, without resetting production.

This checkpoint supersedes earlier assumptions that server access was unavailable. It does not certify V3.0 closure.
