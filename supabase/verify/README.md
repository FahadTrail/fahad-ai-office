# Database reproducibility

`supabase/migrations/` mirrors production's `supabase_migrations.schema_migrations`
one-to-one (same versions and names). The base schema, continuity POC tables
and every later phase are present, so an empty project can be rebuilt from the
repository.

## Files

* `supabase-stubs.sql` — the minimal objects a hosted Supabase project provides
  before application migrations (API roles, `auth.uid()`, `extensions.pgcrypto`,
  the realtime publication, default privileges). Local replay only.
* `replay.sh [out]` — creates a throwaway PostgreSQL, applies the stubs and all
  migrations in order (each in one transaction), runs every
  `scenarios/*.sql` inside a rolled-back transaction, and prints the structural
  fingerprint.
* `fingerprint.sql` — read-only catalog query (columns, constraints, indexes,
  function-body hashes, ACLs, RLS policies, triggers, realtime publication).
  Carriage returns and the PostgreSQL 17 MAINTAIN privilege bit are normalized.
* `schema-fingerprint.txt` — the expected fingerprint after all repository
  migrations. `test/schema-replay.test.js` fails if a replay differs.

## Changing the schema

1. Add `supabase/migrations/<UTC timestamp>_<name>.sql`.
2. Add or extend a scenario under `scenarios/` for new functions.
3. `bash supabase/verify/replay.sh supabase/verify/schema-fingerprint.txt.new && sort -o supabase/verify/schema-fingerprint.txt supabase/verify/schema-fingerprint.txt.new && rm supabase/verify/schema-fingerprint.txt.new`
4. After the migration is applied to production (approval required), run the
   body of `fingerprint.sql` there (read-only) and confirm it equals
   `schema-fingerprint.txt`. Apply migrations with the tracked mechanism
   (`apply_migration` / `supabase db push`) so history stays aligned.

## History notes

* 2026-09-25: the Tool Broker migration (`20260924093000`) had been applied to
  production without a history row; the row was recorded (metadata only,
  md5-verified against the repository file). Production functions from that
  migration contain CRLF line endings; bodies are otherwise identical.
* The repository versions of `20260922210151` and `20260923170011` are the
  reviewed, slightly hardened texts; production recorded earlier texts whose
  differences are superseded by the immediately following migrations
  (`20260922210443`, `20260923170537`). The replay fingerprint proves the final
  schema is identical.
