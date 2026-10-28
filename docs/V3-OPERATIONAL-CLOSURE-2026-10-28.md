# V3.0 operational closure — 2026-10-28

Follows the Python Coding Agent acceptance (#141, `docs/coding-agent-publish-verification.md`).
Each item is marked **DONE** (verified here, with evidence), **OWNER** (only
Fahad can do it), or **PLAN** (prepared and tested, not yet run).

## 1. Python acceptance fixture PR — DONE

[`fahad-office-python-acceptance#1`](https://github.com/FahadTrail/fahad-office-python-acceptance/pull/1)
was closed without merging at 19:55:35 UTC (`merged: false`), with a closing
[comment](https://github.com/FahadTrail/fahad-office-python-acceptance/pull/1#issuecomment-6479117147).
The evidence branch is kept: `git ls-remote` still shows
`refs/heads/fahad/python-acceptance-clamp-and-dura-bb02c85e` at
`659573e19f8ec206ae2fa0326c81a75cff5eef4f`. `main` is unchanged (`e8d4c5d`).

## 2. Temporary repository access of the Coding Agent credential — OWNER

`CODING_GITHUB_TOKEN` is a fine-grained personal access token (`github_pat_…`,
enforced by `ops/enable-coding-worker.sh`). Only the token's owner can change
its repository list, and the agent cannot read it (it is a server secret), so
this cannot be verified or done from an agent session.

1. Open <https://github.com/settings/personal-access-tokens>, then the Coding
   Agent token, then **Edit**.
2. **Repository access → Only select repositories**: remove
   `FahadTrail/fahad-office-python-acceptance` and keep `FahadTrail/fahad-ai-office`.
3. **Update**.

The token value does not change, so the server needs no change. The token's
page then lists one repository; that page is the evidence. If the token is
ever used on the fixture again, the Coding Agent now reports
`PUSH_FORBIDDEN` and never records a false push.

## 3. Google OAuth: can `drive.readonly` be dropped for `drive.file`? — analysed; scopes unchanged

The current code is in `src/integrations/google-workspace.js`.

* `GOOGLE_SCOPES` = `drive.readonly` + `drive.file`.
* `drive_search` and `drive_read` work inside the Office folder by default
  (`GOOGLE_DRIVE_READ_SCOPE=folder`). The folder boundary is enforced in code.
* `docs_create` and `sheets_create` create new files in the folder.

With only `drive.file`, Google gives the app access to files the app created
itself, or files the user explicitly opened with the app (Picker / "Open with").

| Capability | With `drive.file` only |
| --- | --- |
| Create Docs/Sheets | Kept, **if the Office folder is reachable by the app**. A folder Fahad created by hand is not, so the setup must let the app create the Office folder (a code change). |
| Search/read files the Office created | Kept. |
| Search/read files Fahad puts in the folder himself (uploads, his own Docs) | **Lost.** They are invisible to a `drive.file` token. Restoring this needs a Google Picker flow in the Hub (new UI plus a Picker API key), and each file must be picked once. |
| Whole-Drive read (`GOOGLE_DRIVE_READ_SCOPE=drive`) | Lost. |

**Conclusion.** Dropping `drive.readonly` removes the main read use case:
"read my documents in the Office folder". Do not change the scopes yet.

The trade-off is security: `drive.readonly` is a restricted scope, and a
stolen refresh token could read the whole Drive. If Fahad prefers least
privilege over reading his own files, the `drive.file` route needs:

1. app-created folder setup;
2. optionally, a Picker;
3. a re-consent.

Before any scope change, verify it with a separate test grant:

1. Revoke the Office grant at <https://myaccount.google.com/permissions>.
   The consent link uses `include_granted_scopes=true`, so without a revoke
   the new token would silently keep `drive.readonly`.
2. Authorize a `drive.file`-only client in a scratch folder.
3. Check create, search and read on an app-created file and on a
   hand-uploaded file. Expected result: the hand-uploaded file fails.
4. Only then change `GOOGLE_SCOPES` and the setup's required-scope check
   (`src/ops/google-oauth-setup.js`).

## 4. From Google "Testing" to continuous use — PLAN

Facts in this section come from the code and the docs in this repository.
Google's own help pages could not be fetched from the agent environment (its
network blocks them), so the Google policy points below must be confirmed
against Google Cloud Console before acting.

* An External OAuth app in **Testing** issues refresh tokens that expire after
  7 days. The connector already reports this as `GOOGLE_REAUTHORIZE`
  (`invalid_grant`).
* Path A (no cost, single owner): Google Cloud Console, then **Google Auth
  Platform → Audience → Publish app** (move to *In production*) **without**
  submitting for verification. Fahad then sees an "unverified app" warning at
  consent, and the app keeps a small user cap. Both are acceptable for one
  user. Refresh tokens stop expiring after 7 days.
* Path B: a **Google Workspace** account with an *Internal* app. No
  verification and no expiry, but it requires a Workspace subscription, which
  is a paid service and is not recommended.
* Avoid: submitting `drive.readonly` for verification. Restricted scopes need
  a paid third-party security assessment.

Steps (owner):

1. In Google Cloud Console, confirm the user type is External and that only
   the Drive API is enabled.
2. Fill the branding page:
   * app name;
   * support email;
   * home page;
   * privacy policy URL (see the privacy pages note below).
3. Publish to production.
4. Re-run the consent:
   * revoke the old grant;
   * run `src/ops/google-oauth-setup.js --url` then `--exchange` (PKCE, in the
     same runtime within 10 minutes);
   * store the refresh token with `ops/set-secret.sh`.
5. Evidence: one search, read and create now, and again **after 8 days**. The
   second run proves the token no longer expires. Record the Drive file ids.

**Privacy pages — DRAFTED, not published.**
The text is `src/legal/privacy-en.md` and `src/legal/privacy-ar.md`, served at
`/privacy` and `/privacy/ar` (see the 2026-10-28 late update below and
[`docs/legal/README.md`](legal/README.md)).

* The drafts in the ChatGPT Work environment were not available to this
  session, so these drafts were written independently.
* Publishing needs the owner's approval of three things:
  * the text;
  * a contact address;
  * where it is served (for example a static `/privacy` page on the Hub
    domain, which needs a small code change and a deploy).

The facts the pages state:

* read-only access limited in code to the Office folder;
* create-only writes;
* no deletion or sharing;
* Drive content goes only to privacy-approved models;
* revoke at <https://myaccount.google.com/permissions>.

**Production evidence today:** the database holds no trace of an Office run
using Drive in the last 5 days:

* no Drive links in results or artifacts;
* no `GOOGLE_*` errors.

The earlier successful read and create was a setup test outside Office
workflows. Continuous use is therefore unproven until the re-consent and the
8-day check in the steps above.

## 5. Independent backup and restore drill — PLAN (tested locally), owner runs it

The project is on Supabase **Pro** (organization plan read with the Supabase
tools). Daily backups are included. An independent copy and a restore proof
need no new service:

```sh
# Dashboard → Connect → "Session pooler" URI (port 5432). Hidden prompt.
mkdir -p "$HOME/office-backups"     # outside any git repository
docker run --rm -it -v "$PWD":/w:ro -v "$HOME/office-backups":/backups -w /w postgres:17 \
  bash supabase/verify/restore-drill.sh --keep-dump /backups
```

`supabase/verify/restore-drill.sh`:

* Production is read-only.
  * Every source session runs with `default_transaction_read_only=on`.
  * Only `SELECT` and `pg_dump` run against it.
* Row counts are consistent.
  * One REPEATABLE READ session exports its snapshot.
  * It counts every table, and `pg_dump --snapshot` dumps that same snapshot.
  * So live writes cannot make the comparison drift.
* The restore runs into a throwaway local cluster:
  * with the Supabase stand-ins;
  * with stand-in `auth.users` ids for the owner foreign key;
  * with the Realtime publication re-added.
* The verdict is PASS only if all of these hold:
  * zero `pg_restore` errors;
  * every table's row count is equal;
  * the full-text structural fingerprint is equal.
* ACL lines are ignored, because the dump excludes privileges.
* Constraint text is compared without parentheses, because pg_dump re-prints
  CHECK expressions.
* No credential is exposed.
  * The URI is read from `RESTORE_SOURCE_URL` or a hidden prompt.
  * The password goes to a 0600 `PGPASSFILE`, deleted on exit.
  * It never appears on a command line or in the report.
* `--keep-dump` keeps the dump (mode 0600) as the independent copy.

Evidence so far: `test/restore-drill.test.js` runs the drill against a local
password-protected database built from all migrations, as root and as a
normal user.

* The drill reports PASS on 44 tables.
* The password never appears in the output.
* The kept dump is 0600.
* The source is unchanged.
* A malformed URI is refused without being echoed.

**Where dumps go.**

* Without `--keep-dump`, the dump lives only in a private temporary
  directory and is deleted on exit.
* `--keep-dump DIR` is refused before connecting when `DIR` is inside this
  repository or inside any git work tree.
* The kept directory is set to 0700 and the dump file to 0600.
* `.gitignore` also ignores `*.dump` and `backups/`.
* The repository is mounted read-only in the docker command.

**Coverage — what the drill proves and what it does not.**
Production was inventoried read-only on 2026-10-28.

| Data | In the drill | Production today | Protection |
| --- | --- | --- | --- |
| `public`, `private` (44 tables, all Office data, ~1.9k rows, 23 MB database) | Yes: row counts and structure | — | drill + Supabase daily backups |
| `supabase_migrations.schema_migrations` (migration history) | Yes: row count | 38 rows | drill + daily backups |
| `auth` (Hub login) | **No** (Supabase-owned schema; does not restore into plain PostgreSQL) | 2 users, 2 identities | Supabase daily backups. If lost, the Hub admits the owner by `HUB_OWNER_EMAIL` with an email code, so signing in again recreates the user. Nothing in the Office depends on the old user id except the legacy `office_owners` row (RLS helper; the server uses the service role) |
| `storage` | No | 0 buckets, 0 objects | nothing to protect today |
| `vault` | No | 0 secrets | secrets live only in the server `.env` |
| `backup_20261028` | No | in-database snapshot of 21 tables | redundant with the drill's copy |

A **full** restore, including `auth`, is proven only by restoring a Supabase
daily backup. Doing that into a new project is paid. It was not done and is
not claimed.

Production pre-check (read-only): no `public`/`private` object depends on an
extension, so the restore needs no Supabase-only extension. The server is
PostgreSQL 17.6, so the drill must run with PostgreSQL 17 tools. The docker
image does that. The local tests ran with PostgreSQL 16, the only version
available in the agent environment, and the drill refuses tools older than
the source.

**Schema drift found (read-only).** Production has 1216 fingerprint lines
against 1218 in the repository. The repository migration
`20261009160000_platform_work_indexes` is not applied in production. It adds
two indexes on `public.jobs`:

* `jobs_project_current_idx`
* `jobs_project_history_idx`

They are additive and change no data. Applying it is a production migration,
so it needs the owner's approval.

Production also records the bulk-delete guard as `20261028054117`, and the
session-runs fix as `20261009105021` where the repository says
`20261009090000`. These are history metadata only, and the objects match.

The live production run needs the database password, which only Fahad holds.
The production restore drill therefore stays OWNER until he runs it and keeps
the printed report.

## Update — 2026-10-28 (late)

| Item | Status | Evidence |
| --- | --- | --- |
| Token access to `fahad-office-python-acceptance` removed | **BLOCKED (owner)** | Not verifiable by an agent: the token is a server secret and its repository list is visible only on the owner's GitHub settings page |
| Restore drill on real production data | **BLOCKED (owner)** | No authorized database credential exists in the agent environment. Reading rows through the SQL tool would copy production data into a chat transcript, so it was refused as unsafe. The script, its tests and the command are unchanged (§5) |
| `/privacy` page | **PR for review, not published** | `src/hub-privacy.js`, `test/hub-privacy.test.js`. Two corrections were found against the code and are now stated (below) |
| Google connection | **Unproven** | `events` has **zero** Drive tool events (`drive_search`, `drive_read`, `docs_create`, `sheets_create`) since the project started, and no `GOOGLE_*` error. No Office run has used Drive in production yet |
| Migration `20261009160000` | **Prepared, not applied** | [`docs/migrations/20261009160000-apply-runbook.md`](migrations/20261009160000-apply-runbook.md): read-only checks, lock analysis, atomic apply and rollback, local rehearsal reproducing production's digest exactly |

**Corrections to the earlier privacy draft (verified in code).**

* **Paused requests store excerpts.** While a request waits for model
  capacity, `tasks.wait_info.checkpoint` stores a summary of each completed
  tool call: at most 1,200 characters (`fitCheckpoint` in `src/workflow.js`).
  For a Drive read, this summary is an excerpt of the file. It is not cleared
  when the task finishes. The earlier draft said no copy of file contents is
  stored; the published text now states this storage.
* **Search words and file ids are logged.** The provider-switch checkpoint
  event in `events.payload` records each tool call's arguments: the search
  words and the file ids. The published text states this too.

**Publishing gate.** Merging the PR publishes nothing. `/privacy` answers 404
until the owner sets both values on the server:

```bash
sudo bash ops/set-secret.sh PRIVACY_CONTACT_EMAIL
```

```bash
sudo bash ops/set-secret.sh PRIVACY_EFFECTIVE_DATE
```

