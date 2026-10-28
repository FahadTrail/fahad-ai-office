# Fahad AI Office — Privacy Policy (Google Drive integration)

> **DRAFT — not published.** Prepared from the code on `main` (2026-10-28) for
> the Google OAuth consent screen. Publishing it, and the contact address
> below, need the owner's approval. Every statement maps to code; the source
> is cited in brackets so a reviewer can check it. Remove the bracketed
> citations before publishing.

**Effective date:** [to be set on publication]
**Operator:** Fahad (owner and only user of this private application)
**Contact:** [OWNER CONTACT EMAIL — owner to provide]

## Who uses this application

Fahad AI Office is a private, single-owner workspace. Only the owner's own
Google account is connected. The app does not offer sign-up to the public.
[`src/hub-server.js`: the Hub admits one `HUB_OWNER_EMAIL`]

## What Google data the app accesses

The app requests two Google OAuth scopes:
[`src/integrations/google-workspace.js` `GOOGLE_SCOPES`]

* `https://www.googleapis.com/auth/drive.readonly` — read file names, metadata
  and contents.
* `https://www.googleapis.com/auth/drive.file` — create new files.

Google grants `drive.readonly` for the whole Drive. The app limits itself in
code to one folder chosen by the owner, the "Office folder":

* Search adds an "in this folder" condition to every query.
* Reading checks that the file's parent is the Office folder. If it is not,
  the read is refused (`FILE_OUTSIDE_OFFICE_FOLDER`).

[`search()` / `read()`; default `GOOGLE_DRIVE_READ_SCOPE=folder`]

Whole-Drive reading is possible only if the owner explicitly sets
`GOOGLE_DRIVE_READ_SCOPE=drive` on his server.

What the app reads:

* names, types, modification times and links of files in the Office folder;
* the text of Google Docs (exported as plain text), the first sheet of Google
  Sheets (exported as CSV), and plain-text, Markdown, CSV or JSON files under
  2 MB.

No other file types are read. [`read()`]

What the app writes:

* It **only creates new** Google Docs and Sheets inside the Office folder.
* It never edits, moves, shares or deletes any file. No such operation exists
  in the code. [`create()`]

## How the data is used

Drive is used only when the owner explicitly asks the Office for Google
Drive, Docs or Sheets in a request.
[`wantsGoogleWorkspace()`, `src/workflow.js`]

When that happens:

* The text of files the Office reads is given to an AI model, so that model
  can answer that request.
* That run is restricted to AI providers that the owner has approved for
  private data: providers whose terms state that API content is not used to
  train their models. [`src/office/pool-runner.js` `requiresPrivateData`;
  `privacyApproved` in `src/model-gateway/agentic/model-pool.js`]
* Web search is withheld during such a run unless the search provider is
  also approved for private data.

Use and transfer of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including its Limited Use requirements:

* Google user data is used only to provide the features the owner asks for.
* It is not sold.
* It is not used for advertising.
* It is not used to train generalized AI or machine-learning models.
* It is not transferred to anyone except the AI provider processing the
  owner's own request, as described above.

## Storage and retention

* **Google credentials.** The OAuth client secret and refresh token are
  stored only in the owner's server configuration, which is readable by root
  only. Access tokens are held in memory only.
* **Logs and prompts.** Credentials are never written to logs, prompts, tool
  results or the database. [header of `google-workspace.js`;
  `src/ops/google-oauth-setup.js`]
* **Drive file contents.** These are not stored as copies. The Office's
  answers to the owner may quote or summarise them. Those answers are stored
  in the owner's private database:
  * Supabase;
  * row-level security on;
  * service-role access only.

  They remain until the owner deletes them.
* **Files the app creates.** Their ids, names and links are kept with the
  request as evidence of what was created.

## Revoking access

The owner can disconnect Google at any time at
<https://myaccount.google.com/permissions>. After that the app can no longer
read or create anything.

To delete stored answers, use the owner's database.

## Changes

Any change to scopes or data use is made in this policy before it takes
effect.
