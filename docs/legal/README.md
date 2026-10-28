# Legal texts

* **Privacy policy (Google OAuth consent screen).**
  * Published text: `src/legal/privacy-en.md` and `src/legal/privacy-ar.md`.
  * Served by the Hub at `/privacy` and `/privacy/ar` (`src/hub-privacy.js`).
  * The owner-approved contact and the effective date are in
    `src/legal/privacy-config.json`. The page answers **404 until the
    effective date is set**, which happens in the publishing commit after the
    owner approves the final text.
* **Proof that the text matches the code.** `test/hub-privacy.test.js` fails
  if any of these change without the text changing:
  * the requested scopes;
  * the folder boundary;
  * the 2 MB read limit;
  * create-only writes (no edit, delete or share call);
  * the "only when asked" rule;
  * private-data-only routing;
  * the search withholding;
  * the 1,200-character checkpoint excerpt.
* Third-party licences: `legal/license-decisions.json`.
