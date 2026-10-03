-- Coding Continuity: register the Gemini CLI worker for the VPS Phase-N chain
-- (FAHAD OFFICE -> OPENCODE -> GEMINI CLI, see docs/CONTINUITY-VPS-WORKERS.md).
--
-- Data only: no schema change, so supabase/verify/schema-fingerprint.txt is
-- unchanged. Like every external worker it starts disabled; its adapter stays
-- OFF until the owner authenticates the CLI on the VPS and sets
-- CONTINUITY_GEMINI_CLI_ENABLED.
-- quota_source 'gemini-cli' is the Gemini CLI's own quota (official OAuth free
-- quota or a GEMINI_API_KEY), deliberately distinct from antigravity's
-- google-ai-pro subscription: the two must never share capacity.
-- Applied on top of the Phase A stack migration
-- (20261004090000_coding_continuity.sql), which is never edited.
insert into public.coding_workers (key, display_name, kind, quota_source, enabled)
values ('gemini-cli', 'Gemini CLI', 'cli', 'gemini-cli', false)
on conflict (key) do nothing;
