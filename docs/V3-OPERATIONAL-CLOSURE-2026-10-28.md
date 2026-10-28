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

**Privacy pages.** No privacy policy or terms page exists in this repository,
and the drafts written in the ChatGPT Work environment are not available to
this session. They are needed once: send them, and they will be reviewed
against the actual data flow before anything is published. The facts they
must state truthfully:

* read-only access limited in code to the Office folder;
* create-only writes;
* no deletion or sharing;
* Drive content goes only to privacy-approved models;
* revoke at <https://myaccount.google.com/permissions>.

## 5. Independent backup and restore drill — PLAN (tested locally), owner runs it

The project is on Supabase **Pro** (organization plan read with the Supabase
tools). Daily backups are included. An independent copy and a restore proof
need no new service:

```sh
# Dashboard → Connect → "Session pooler" URI (port 5432). Hidden prompt.
docker run --rm -it -v "$PWD":/w -w /w postgres:17 \
  bash supabase/verify/restore-drill.sh --keep-dump /w/backups
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

The live production run needs the database password, which only Fahad holds.
The production restore drill therefore stays OWNER until he runs it and keeps
the printed report.
