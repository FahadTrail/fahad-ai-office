# V3.0 activation audit — 2026-10-28

This is a verification update, not a claim of complete activation. The
authoritative product record remains `FAHAD-OFFICE-V3-FINAL.md`.

## Observed state

* Production `/healthz`: HTTP 200, `ok: true`, version `6f3d2382c487`,
  observed 08:30 UTC (12:30 Asia/Dubai).
* That version is merge #137. Deploy run
  [40649057522](https://github.com/FahadTrail/fahad-ai-office/actions/runs/40649057522)
  and PR validation run
  [40648876333](https://github.com/FahadTrail/fahad-ai-office/actions/runs/40648876333)
  both report completed/success. No redundant deploy was requested.
* The repository is PUBLIC. Its visibility was not changed.
* The available Supabase connector rejects project `zkzibipinjeswhdxnfgf`.
  No query, migration, restore or data change was made to that project.
* SSH: no local identity or running key agent was available. Fahad confirmed
  there is no ready authorized SSH connection. Server work is **BLOCKED**.

## Python and deployment — prepared, runtime verification BLOCKED

`Dockerfile` on the verified main commit installs `python3` and `python3-pip`.
`deploy.yml` builds/tests the image before contacting production, but the
server deploy only ships source and package files. A successful existing
deploy does not prove the server Dockerfile or runtime contains Python.

`ops/install-deploy.sh` requires root, `/opt/fahad-ai-office/src`, its `.env`,
the existing restricted deploy helper/sudoers, `/usr/bin/docker`, and the
deploy account/SSH files. It validates shell/sudoers/compose and backs up the
old deployment files. It also changes SSH-directory/key ownership and modes
and replaces the deploy helper, Dockerfile and compose. Some changes happen
before compose validation: this is not a wholly atomic or read-only operation.
It does not restart a container by itself.

When an authorized operator is available:

1. Verify the VPS identity against the owner's inventory and pinned SSH host
   key in `deploy.yml`; verify root authority and all script preconditions.
2. Use a clean checkout of the then-current reviewed `origin/main`; fetch,
   compare exact SHAs and inspect `git status --porcelain`. Review the current
   script and diff of Dockerfile, compose, dockerignore and deploy helper
   against server copies. Do not execute from a stale/unverified checkout.
3. Because the installer touches SSH file modes, confirm those changes are
   within the owner's authorization; otherwise stop before running it.
4. Run `sudo bash ops/install-deploy.sh` from that checkout, retain its backup
   location, then dispatch `deploy.yml` on main and watch it to success.
5. Verify `/healthz` equals that run's commit; execute `python3 --version` and
   `python3 -m pip --version` inside **both** runtime and enabled coding-worker
   containers as their configured user. Record image IDs and command outcomes.
6. Only then run the isolated Python Coding Agent drill below. A CI image
   build or local Python test is not runtime or agent E2E evidence.

## Google OAuth

Follow-up after #138: the Desktop setup helper is being hardened with S256
PKCE, per-attempt state, exact callback/client/expiry validation, private
temporary session storage and refusal of partial scope consent. These are
offline-tested safeguards, not evidence of Google account authorization.
Use `--url` and `--exchange` in the same runtime/user within ten minutes;
do not recreate the container between them. A full loopback callback URL is
required, and a successful exchange consumes its temporary session. Existing
refresh-token use in the connector is unchanged. The fix needs CI/review and
deployment before any real authorization attempt; no secrets are required to
test it. [Google Desktop OAuth guidance](https://developers.google.com/identity/protocols/oauth2/native-app).

**BLOCKED:** no verified server access or existing Office OAuth client was
available. The connected Google plugin is separate from the Office OAuth
client. No consent URL with a real client ID was generated; no secret changed.
The user's prohibition on changing production secrets also remains in force.

The real helper is `src/ops/google-oauth-setup.js` (older source comments naming
`tools/google-oauth-setup.mjs` are stale). It requests `drive.readonly` and
`drive.file`. The former grants read access across Drive at Google; the
default Office-folder boundary is enforced by code. A stolen refresh token
could read beyond that folder. Do not describe this as folder-scoped OAuth.

Preparation for the authorized owner/operator:

1. Use an owner-controlled Google Cloud project, enable Drive API, configure
   the consent screen and a Desktop OAuth client. Review the two scopes and
   token lifetime for the selected publishing/testing state.
2. Store the client ID/secret only through the reviewed hidden-input server
   mechanism, with specific authorization for those secret writes. Never paste
   them into chat, tickets, command arguments or a PR. `ops/set-secret.sh`
   reloads runtime and the enabled coding worker after each successful write.
3. Run the helper's `--url` inside runtime. Fahad completes Google consent.
   Its loopback redirect is `http://127.0.0.1:8765/`; the current helper does
   not run a callback listener, so a browser connection error is expected.
4. Follow the helper header's hidden-input `--exchange` pipeline directly into
   `ops/set-secret.sh GOOGLE_OAUTH_REFRESH_TOKEN`. Never run `--exchange`
   without the receiving pipe: its stdout is the refresh token. Use a shell
   with `pipefail`, no tracing, and verify every pipeline component succeeds.
5. Select/create the Office folder and store its ID through the same approved
   mechanism. Keep read scope at `folder` (the default).
6. Verify one real search and create one disposable Doc and Sheet in that
   folder, confirm their parent and read-back, then check audit redaction and
   integration status. Do not delete, share, move or overwrite existing files.
   A configured environment alone is not CONNECTED evidence.

Consent is not the only remaining owner step while the client and authorized
secret-storage access are missing. Do not ask Fahad to send an auth code in chat.

## Independent backups and safe recovery drill

**BLOCKED:** backup inventory, project plan and independent copy cannot be
verified with the available project permissions. `backup_20261028` remains an
in-database snapshot, not independent disaster recovery. The prior Pro-plan
statement is historical evidence, not a fresh billing or backup check.

Prepared drill (not executed):

1. Read the correct project's backup inventory, timestamps, successful state,
   retention and recovery coverage. Separately verify an encrypted off-site
   logical backup, checksum, owner-controlled storage and retention.
2. Prefer logical restore into an isolated local PostgreSQL target with
   outbound network blocked, no production credentials, no Office workers and
   no cron/webhook/extension activity. Review dump contents before restoring;
   execute only against an explicitly verified scratch host/database. Keep
   production read-only and never point restore commands at its connection.
3. Inspect schemas, row counts, constraints, RLS and role grants. Compare the
   schema fingerprint using the repository verifier and run the read-only
   health snapshot where applicable. Record expected differences, elapsed
   recovery time and the backup timestamp (observed recovery point).
4. Keep restored personal/auth data access-restricted; no artifact may contain
   row contents, tokens or credentials. Storage object contents require their
   own backup; database metadata is insufficient.
5. No project/branch creation, PITR purchase or paid clone was requested.
   Supabase's binary clone can start cron and other external extensions
   immediately and has additional cost, so it is not a safe default drill.
   Cleanup of any scratch data needs a separate authorized decision.

References: [backups](https://supabase.com/docs/guides/platform/backups),
[clone caveats](https://supabase.com/docs/guides/platform/clone-project).

## Old pull requests

Reviewed against main `6f3d238` and their actual diffs, not just titles:

* #124 head `ae8ec5e` and #125 head `7055675` are ancestors of main.
  `git diff 7055675 27ab29c` is empty: merged #126 contains the exact #125
  tree, including #124. Subsequent Cloudflare fixes remain on main.
* #109 changes only `AGENTS.md`: Cursor environment paths and operating notes.
  The durable test/replay, free-first, role, secrets, branch/PR and isolation
  rules are already in current guidance. Its V5 phase freeze is historical;
  its Cursor-specific environment setup is not a runtime feature. The branch
  retains those optional environment instructions without merging stale rules.
* #114 changes docs plus the obsolete cleanup manifest/verifier and a SQL
  comment. Current V3 records cover Supervisor ON, applied V5.4 migrations,
  deployed-version truth and the later coding E2E. The 2026-10-22 owner cleanup
  superseded its proposed 53-row cleanup inventory. Its historical activation
  detail remains in the PR and branch; do not execute that old cleanup or
  treat old OFF/unapplied statements as current. No runtime implementation is
  missing from main because this PR is closed.

All four were closed with explanatory comments and independently read back
as closed/unmerged via GitHub. Every branch and PR history was preserved.

## Visibility, coding isolation and cost

Do not change visibility without Fahad's specific approval. Before a private
conversion, verify server git-fetch authentication and the runtime GitHub
token's repository access, CI secrets/settings and any external integrations.
The connector's admin access does not prove the Office worker token's scope.

The reviewed deploy helper hard-codes an HTTPS origin and calls `git fetch`
without an explicit token argument. An existing credential helper might supply
access, but that was not observable here. Private conversion can therefore
break deployment unless server-side fetch authentication is verified first.

Standard public Actions runs are free; private runs consume the account's
included minutes/storage and may incur overage. The account's allowance,
remaining balance and spending-stop setting were not visible in this audit.
See [GitHub billing](https://docs.github.com/en/actions/concepts/billing-and-usage).

The Office agent is the native Coding Agent, not GitHub Copilot. Its privacy
gate, free guard and budget gate are independent. PRIVATE sessions cannot
use PUBLIC-only models; the September private-policy capacity statement is
historical, and present approved private capacity needs live verification.
Never label a private repo PUBLIC or enable a paid model to make a test run.

The $2/month and $0.10/request limits are documented requirements. Current
ledger totals/reservations, policy settings and provider billing are
**UNVERIFIED** because production Supabase/server access is blocked. Historical
October spend of $0 is not a current balance check. This audit made no model
calls, changed no budget/provider/privacy flag, and provisioned no paid service.

Dependency audit found seven production dependency alerts (three high, four
moderate). Compatible transitive lockfile updates address them without changing
the direct package pins: MCP SDK 1.30.0 → 1.32.2, body-parser 2.3.0 → 2.4.0,
fast-uri 3.1.8 → 3.1.9, hono 4.13.8 → 4.13.14, ip-address 10.7.2 → 10.7.5,
qs 6.16.0 → 6.17.0 and zod 4.6.5 → 4.6.7. After a clean `npm ci`,
`npm audit --omit=dev` reports zero vulnerabilities. This does not establish
exploitability of the old production image. CI must pass before merging;
production adoption requires successful deploy and version verification.
Advisory examples: [MCP](https://github.com/advisories/GHSA-6prh-2h8m-c8cw),
[Zod](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).

## Separate Python drill — prepared only

A separate local fixture is prepared outside the production repository. It
uses standard-library unittest and an explicit test command, requires no
provider credentials or dependencies, and has no deployment workflow.
Remote test-repository creation/token authorization and a live agent session
remain **BLOCKED** with the available connector capabilities and runtime access.

After Python runtime verification, use a dedicated authorized test repository
with synthetic code, explicit PRIVATE privacy if private, `allowPaid: false`,
test command `python3 -m unittest discover -s tests -v`, and no merge/deploy.
Task: add a clamp helper with negative, in-range, above-bound and invalid-bound
tests; require red then green evidence, a PR and CI. Stop at the reviewed PR.
Record session ID, worker/image, model attempts, cost and PR/check URLs.
If no privacy-approved free coding route is available, record
WAITING_FOR_CAPACITY/BLOCKED; do not lower privacy or increase budget.

## Local verification

After installing the corrected lockfile: 95 targeted tests, 94 passed, one
Linux/container-root isolation test skipped, zero failed. Coverage includes
Google scopes/folder boundary, Cloudflare caps, free/privacy routing, repository
toolchain detection, budget stops, redaction and command/path guards. The
separate Python fixture passed all three standard-library tests locally.

A broad Windows run under restricted filesystem access failed fixture setup
when Git could not write temporary repository config, then was stopped. It is
not a full-suite pass. The targeted run with authorized temporary-fixture
access passed; the project's Ubuntu CI remains the full-suite/image/schema
replay/container-isolation release gate. No security assertion was weakened.
