# Fahad AI Office — Privacy Policy

**Effective date:** {{EFFECTIVE_DATE}}
**Contact:** [{{CONTACT_EMAIL}}](mailto:{{CONTACT_EMAIL}})

Fahad AI Office is a private, single-owner workspace. Only its owner can sign
in, and only the owner's own Google account is connected. It offers no public
sign-up. This policy explains what the app does with Google user data.

## Google data the app accesses

The app requests two Google OAuth scopes:

* `https://www.googleapis.com/auth/drive.readonly`: lets the app see and read
  file names, metadata and contents.
* `https://www.googleapis.com/auth/drive.file`: lets the app create new files.

Google grants read access for the whole Drive. The app limits itself to one
folder chosen by the owner (the "Office folder"):

* every search is restricted to that folder;
* a file outside it is refused.

Whole-Drive reading happens only if the owner explicitly enables it on the
owner's own server.

What the app reads:

* the names, types, modification times and links of files in the Office
  folder;
* the text of Google Docs;
* the first sheet of Google Sheets;
* plain-text, Markdown, CSV or JSON files under 2 MB.

Other file types are not read.

What the app writes:

* It only **creates new** Google Docs and Sheets in the Office folder.
* It never edits, moves, shares or deletes a file.

## How the data is used

Google Drive is used only when the owner explicitly asks for Google Drive,
Docs or Sheets in a request.

* The text of the files read for that request is given to an AI model so it
  can answer that request.
* Such a request is processed only by AI providers that the owner has approved
  for private data: providers whose terms state that API content is not used
  to train their models.
* Web search is not used during such a request unless the search provider is
  also approved for private data.
* The AI model may open public web pages while answering. Such a fetch sends
  that website only the page address; no file is attached to it.

The use and transfer of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements. Google user data is:

* used only to provide the features the owner asks for;
* never sold;
* never used for advertising;
* never used to train generalized AI or machine-learning models;
* never transferred to anyone except the service providers listed below, which
  process it only to run the app for the owner.

## Service providers

The app runs on these services, which process data only to operate it for
the owner:

* **Supabase** hosts the owner's database. Everything described under
  "Storage and retention" is stored there.
* **Hostinger** hosts the server (a virtual private server) that runs the
  app and holds its configuration, including the Google credentials.
* **AI providers approved by the owner for private data** process the
  owner's requests, as described above.
* **Telegram** delivers the owner's own messages, but only if the owner uses
  the app's private Telegram bot.
  * When a request is sent through that bot, the answer is delivered to the
    owner's Telegram chat. That answer may quote Drive files, and up to 3,500
    characters are sent.
  * For requests made in the Office itself, only a short completion notice
    with the request's title is sent there.

Google user data is not shared with anyone else.

## Storage and retention

* **Google credentials.** The OAuth client secret and the refresh token are
  stored only in the owner's server configuration. Access tokens are kept in
  memory only. Credentials are never written to logs, prompts or the database.
* **Where data is stored.** Everything below is kept in the owner's private
  database, hosted by Supabase, until the owner deletes it. Only the owner's
  server and the owner can access it.
* **Answers.** The app's answers to the owner may quote or summarize the
  files that were read.
* **Activity record.** The task's activity record contains the search words
  and file ids used.
* **Paused requests.** A request may pause while it waits for free AI
  capacity. In that case, a short excerpt of each tool result (at most 1,200
  characters per file read) is saved with the task so that the request can
  resume without reading the files again.
* **Created files.** The ids, names and links of the files the app created
  are kept with the request.
* No other copy of Drive file contents is stored.
* **Backups.** The records and excerpts above are part of the database, so
  they are also included in backups. These are:
  * Supabase's automatic database backups;
  * any database snapshot or backup copy the owner makes.

  Backups follow their own retention period, which can differ from the
  original data's. A record deleted from the database can therefore remain
  in an existing backup until that backup expires or is deleted.

## Revoking access

The owner can disconnect Google at any time at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).
After that the app can no longer read or create anything. Stored answers and
records can be deleted from the owner's database.

## Changes

Any change to the scopes or to how Google data is used is reflected in this
policy before it takes effect.
