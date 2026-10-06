-- V5.4 test-data cleanup (certification Phase 9).
-- PREVIEW BY DEFAULT. Written and verified, NOT executed by the certification.
-- Fahad approves every apply run; the manifest is docs/v5.4-test-data-manifest.md.
--
-- It removes only confirmed test/demo rows listed below by explicit ID.
-- CONFIRMED REAL and UNCERTAIN rows are not listed, so no option can select them.
--
-- Safety
--   * Without cleanup.apply = 'yes' the script only checks and counts; no row
--     changes.
--   * Explicit IDs only. There is no wildcard, title, pattern or date-range delete.
--   * One transaction. Any failed check raises an error and rolls back the whole
--     transaction.
--   * It fails closed:
--     - when a listed row changed since the manifest (timestamp, project,
--       status, dependent counts, activity in the last hour, a live lease);
--     - when a row outside the selection depends on a row inside it.
--   * Rows the docs cite as evidence are held unless
--     cleanup.include_evidence = 'yes'.
--   * Deletes run in foreign-key order. Every DELETE must remove exactly the
--     row count shown in the preview.
--   * Applying writes one audit event (payload kind test_data_cleanup) with
--     the counts and the historical model cost removed from model_attempts.
--     The workspace spent_usd counters are not changed.
--
-- Groups
--   A  this sprint's certification: 2 jobs and the whole CERTIFICATION V5.4
--      project (workspace policy, conversation, artifacts, knowledge items and
--      the neutral review row)
--   B  probes, canaries, smoke and verification runs (27 jobs, 1 cited as evidence)
--   C  tests, acceptance, benchmarks, burn-in, load and launch checks
--      (37 jobs, 13 cited as evidence)
--   D  Continuity Phase N drill Office legs (14 jobs, all cited as evidence)
--   P  Continuity proof-of-concept tasks from 2026-09-22 (2 tasks and their children)
--
-- Options (session settings):
--   cleanup.groups            comma list of A,B,C,D,P (preview default A,B,C,P)
--   cleanup.include_evidence  yes = also remove the rows cited as evidence
--   cleanup.apply             yes = delete; needs cleanup.groups and cleanup.expect_jobs
--   cleanup.expect_jobs       the job count the preview printed, typed back
--
-- Preview, using a direct or session-pooler connection:
--   psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f ops/cleanup/v5.4-test-data-cleanup.sql
-- Apply the recommended set, only after Fahad approves it:
--   psql "$DB_URL" -X -v ON_ERROR_STOP=1 \
--     -c "set cleanup.groups = 'A,B,C,P'" -c "set cleanup.expect_jobs = '52'" \
--     -c "set cleanup.apply = 'yes'" -f ops/cleanup/v5.4-test-data-cleanup.sql
-- Supabase SQL editor: put the same SET statements, each ending in ';', on the
-- lines above this script.

begin;
set local lock_timeout = '10s';
set local statement_timeout = '10min';

create or replace function pg_temp.v54_removed(p_table text, p_got bigint, p_expected bigint)
returns void
language plpgsql
as $$
begin
  if p_got is distinct from p_expected then
    raise exception 'STOP: % removed % rows but the preview counted %; nothing was committed', p_table, p_got, p_expected;
  end if;
  raise notice '  removed  %  %', rpad(p_table, 30), p_got;
end;
$$;

create temporary table v54_jobs (
  job_id uuid primary key,
  grp text not null check (grp in ('A', 'B', 'C', 'D')),
  evidence boolean not null,
  project_id uuid,
  created_at timestamptz not null,
  tasks integer not null,
  runs integer not null,
  model_attempts integer not null,
  tool_executions integer not null,
  agent_sessions integer not null,
  knowledge_items integer not null
) on commit drop;

-- MANIFEST JOBS BEGIN
-- (job_id, group, evidence, project_id, created_at, tasks, runs, model_attempts, tool_executions, agent_sessions, knowledge_items)
insert into v54_jobs values
  -- A: V5.4 certification (this sprint, CERTIFICATION V5.4 project)
  ('3e322785-cd8a-418c-b21b-f4e3fc7b9f00', 'A', false, '09627575-684a-4c8f-b21b-e25bcf6ed65f', '2026-10-05T21:04:39.169404Z', 9, 9, 30, 0, 0, 15),
  ('a1c49941-5e46-458c-ab3e-9364035ed0d0', 'A', false, '09627575-684a-4c8f-b21b-e25bcf6ed65f', '2026-10-05T21:04:54.067702Z', 1, 1, 0, 0, 1, 0),
  -- B: probes, canaries, smoke and verification runs
  ('f61c09ba-278c-495e-aaa2-a9f7302ca095', 'B', false, null, '2026-09-20T18:42:32.707210Z', 1, 1, 0, 0, 0, 0),
  ('cf0a595e-fe1d-4cc4-9ba7-1b69251a6e17', 'B', false, null, '2026-09-20T18:45:01.049193Z', 1, 1, 0, 0, 0, 0),
  ('eecf20f4-ee10-476a-ba48-f7e41c47329a', 'B', false, null, '2026-09-22T19:26:01.179322Z', 3, 3, 0, 0, 0, 0),
  ('771d6445-172a-4485-8a0b-70175aeaf64d', 'B', false, null, '2026-09-22T21:28:24.328211Z', 3, 3, 3, 0, 0, 0),
  ('7fb7cfea-00b9-46e6-8b1d-55ac6f64f869', 'B', false, null, '2026-09-23T17:12:57.612686Z', 3, 3, 3, 0, 0, 0),
  ('221b3c38-37c3-4147-9faf-d5d4ff726bae', 'B', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-24T04:53:13.283651Z', 3, 3, 3, 1, 0, 0),
  ('849af6c6-d2e2-4230-b330-06c88cbe250a', 'B', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-24T04:55:05.705812Z', 1, 2, 0, 0, 0, 0),
  ('a4caea72-049d-4097-a554-08a5080f7ae0', 'B', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-24T04:55:48.759811Z', 3, 3, 1, 3, 0, 0),
  ('fdd024d0-8f3f-4b85-9900-1c1b55dc620a', 'B', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-24T04:58:14.534990Z', 1, 2, 7, 0, 0, 0),
  ('3cf847c3-30c3-4e56-acbc-ef16b02f01a6', 'B', false, null, '2026-09-24T04:58:14.534990Z', 3, 3, 3, 0, 0, 0),
  ('24933de5-9d19-4897-b575-12455f22320e', 'B', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-24T14:06:54.147393Z', 3, 4, 4, 0, 0, 0),
  ('f934cf5e-6487-4d6a-8a69-d66dc106ea55', 'B', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-24T14:46:37.681620Z', 3, 3, 3, 0, 0, 0),
  ('be0411a4-b521-4e45-a399-7954a3918b9c', 'B', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-24T15:04:09.247226Z', 3, 3, 3, 0, 0, 0),
  ('fa3be66d-6789-45ae-913e-3346bc560632', 'B', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-24T20:06:23.354564Z', 3, 3, 3, 0, 0, 0),
  ('21920eaf-c09e-445f-bf82-455638166b00', 'B', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-25T12:14:45.590938Z', 3, 3, 3, 0, 0, 0),
  ('3fa5d872-4ce1-4a77-a4f9-03cc92a0e21c', 'B', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-25T12:16:25.430343Z', 3, 3, 3, 0, 0, 0),
  ('046c47b3-19e0-4ee5-ab87-258b5e05f5f1', 'B', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-25T13:41:15.021754Z', 3, 3, 3, 0, 0, 0),
  ('63c7ad4b-964a-4276-bc59-f7e379aa0c3c', 'B', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-25T16:00:07.706026Z', 3, 3, 3, 0, 0, 0),
  ('b4bca3a6-65c6-43dc-ad42-c0f5d5d1c856', 'B', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-25T16:01:39.281276Z', 3, 3, 3, 0, 0, 0),
  ('31db22ba-15ee-4abe-af8b-8bfd7e23839f', 'B', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-25T19:47:23.420733Z', 1, 1, 0, 0, 1, 0),
  ('1e2bff90-7bec-4318-a1cc-7a145e0815a5', 'B', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-25T20:05:06.862176Z', 1, 1, 0, 0, 1, 0),
  ('2595de7e-70c5-4b39-a32e-be63a39ce6b4', 'B', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-25T21:01:43.943944Z', 1, 1, 0, 0, 1, 0),
  ('cf20325f-928d-4727-87db-67ed964680d9', 'B', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-26T10:04:08.862133Z', 1, 1, 0, 0, 1, 0),
  ('dc8dc266-b131-4d18-ae00-9f418b6455a1', 'B', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-27T11:02:38.129531Z', 1, 1, 4, 0, 0, 0),
  ('36b1da92-2a27-4a6b-ac5b-292328a2b1e2', 'B', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-29T10:47:48.075623Z', 3, 3, 3, 0, 0, 0),
  ('c41212bb-3567-452e-8f50-d0fc101f5830', 'B', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-10-05T10:50:04.188163Z', 1, 1, 2, 0, 0, 0),
  ('776a9b1a-0688-4141-9264-9146db823384', 'B', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-10-05T11:01:15.321668Z', 1, 1, 1, 0, 0, 0),
  -- C: tests, acceptance runs, benchmarks, burn-in, load and launch checks
  ('6adc823b-6172-4358-91ed-f42aab3f0b76', 'C', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-26T09:53:47.742750Z', 3, 3, 3, 0, 0, 0),
  ('14107a98-9601-4619-8199-009afea94879', 'C', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-26T09:56:40.748304Z', 3, 3, 9, 0, 0, 0),
  ('fab1b30e-15a4-4cff-89cb-c9fe2a3210d8', 'C', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-26T09:56:40.748304Z', 3, 3, 19, 0, 0, 0),
  ('419abe85-b680-48e4-8093-179eea98d1fd', 'C', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-26T09:56:40.748304Z', 3, 3, 3, 0, 0, 0),
  ('4c3275d6-5589-4865-a251-e4d2970438fa', 'C', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-26T09:56:40.748304Z', 3, 3, 11, 0, 0, 0),
  ('3f8f2482-70fc-46bb-b2bc-794c9df95358', 'C', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-26T19:32:45.104155Z', 1, 1, 1, 0, 0, 0),
  ('13e6929f-92d9-462b-ab8c-7fdec4a23376', 'C', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-26T19:32:58.947626Z', 1, 1, 1, 0, 0, 0),
  ('e5739662-e29c-44fa-9516-5b2f2583ebf3', 'C', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-26T19:38:40.120535Z', 1, 1, 1, 0, 0, 0),
  ('43667334-8484-4f68-9a38-9b7e3f8c7874', 'C', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-26T19:38:46.234841Z', 1, 1, 2, 0, 0, 0),
  ('849e7cc8-81d4-4be6-a5b2-6226b235fb85', 'C', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-26T23:58:27.345951Z', 1, 1, 1, 0, 0, 0),
  ('807397f6-5f31-4965-bc5c-d30eb93d330c', 'C', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-27T00:07:25.633632Z', 5, 5, 5, 0, 0, 0),
  ('c7c819ba-9260-4e6c-92b3-c657db691dce', 'C', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-27T07:13:43.785161Z', 7, 7, 32, 0, 0, 0),
  ('8d7013c5-3d88-4cef-9d0f-79b56aaf907c', 'C', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-27T07:13:50.496824Z', 1, 1, 5, 0, 0, 0),
  ('8c856cdb-4b69-47f8-bfeb-6bf80785f125', 'C', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-27T07:31:34.155899Z', 5, 6, 30, 0, 0, 1),
  ('8b293887-c455-4b41-a7dc-ebbf3a3f6b9e', 'C', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-27T07:31:34.155899Z', 3, 4, 1, 0, 0, 0),
  ('0a5b8481-7d5c-4c13-b14a-7a4cd6c11014', 'C', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-27T08:09:06.087847Z', 5, 5, 13, 0, 0, 0),
  ('306f66e0-961a-4b27-a4ca-93650c594ecb', 'C', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-27T08:09:06.087847Z', 3, 4, 4, 0, 0, 0),
  ('e8ee0ff3-e88f-4242-9b66-93893231199e', 'C', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-27T14:15:21.922492Z', 3, 3, 5, 0, 0, 0),
  ('e0db05dc-c1ae-4264-946d-31b07b2805d1', 'C', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-27T15:14:50.159032Z', 9, 10, 41, 0, 0, 16),
  ('abaccdad-856e-4b8a-9898-b4116e6952e1', 'C', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-28T03:36:47.754649Z', 6, 13, 35, 0, 0, 2),
  ('1a797e28-5da5-4fdf-9bd1-5524f74186b9', 'C', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-28T03:36:55.615461Z', 6, 9, 12, 0, 0, 0),
  ('fa6ca885-175b-4985-8d15-8c542e2e1a16', 'C', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-28T03:49:46.715417Z', 1, 1, 1, 0, 0, 0),
  ('ca6c8c0d-1754-47e5-8e92-076d89404b5c', 'C', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-29T09:56:22.594883Z', 4, 4, 4, 0, 0, 0),
  ('85d5210f-239b-4242-85f9-81a4843faaec', 'C', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-29T20:09:55.114649Z', 1, 1, 0, 0, 1, 0),
  ('9b32953a-532a-4d98-8e58-ce0454ab439e', 'C', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-29T20:16:24.360358Z', 1, 1, 0, 0, 1, 0),
  ('000991aa-a1a7-4023-af4f-42599f4597f0', 'C', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-29T20:25:29.921152Z', 1, 1, 5, 2, 1, 0),
  ('3489317d-5ebc-4506-9db3-3b22f6663a80', 'C', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-29T20:33:06.286439Z', 1, 1, 10, 6, 1, 0),
  ('9efd098a-5eec-4317-b491-b23911da1419', 'C', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-29T20:54:32.800659Z', 1, 1, 21, 12, 1, 0),
  ('8f79aeb8-85b2-495f-b25a-c5f102dad94e', 'C', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-29T21:16:42.147189Z', 1, 1, 16, 8, 1, 0),
  ('668ad9a5-6f4c-4edb-8b6c-5ce0ae80079f', 'C', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-29T21:18:54.857774Z', 4, 5, 29, 0, 0, 1),
  ('aec7e773-78e6-41e6-858c-44995551875a', 'C', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-29T21:39:07.192040Z', 1, 1, 31, 17, 1, 0),
  ('4e14eabc-cfa8-4b11-852c-832535a9d1bd', 'C', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-30T11:09:55.713992Z', 1, 1, 33, 26, 1, 0),
  ('a58602b7-b0af-433d-a11c-04d4197c9911', 'C', false, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-30T11:09:57.727125Z', 4, 5, 22, 0, 0, 4),
  ('e445770e-50a5-420c-926d-482c57d538cc', 'C', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-30T22:18:05.280209Z', 5, 7, 26, 0, 0, 1),
  ('eedd47f4-f6ad-4f0e-9a43-68207a9cb1e6', 'C', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-09-30T22:18:09.320185Z', 1, 1, 18, 14, 1, 0),
  ('6fad4ac3-7f1c-4ad8-aa24-e8e3689ebcf6', 'C', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-10-01T09:24:53.368112Z', 5, 5, 33, 0, 0, 2),
  ('6487ce49-2505-48fe-8ce2-2d03eaa32a9f', 'C', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-10-01T09:24:55.893099Z', 1, 1, 22, 17, 1, 0),
  -- D: Continuity Phase N drill Office legs (evidence: docs/CONTINUITY-LIVE-CLOSURE-2026-10-04.md)
  ('80ecf446-3a80-4821-ad5d-e494c6cd2338', 'D', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-10-03T13:23:21.298187Z', 1, 1, 44, 40, 1, 0),
  ('d850ed0e-9e7b-442a-b516-401b717abfe1', 'D', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-10-03T15:45:16.027117Z', 1, 1, 65, 58, 1, 0),
  ('a836c5d4-4011-4f08-bbad-333d6f01b1e1', 'D', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-10-03T17:42:24.289739Z', 1, 1, 36, 33, 1, 0),
  ('6ac14ebf-981c-43b7-8eab-0b75286768ff', 'D', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-10-03T21:29:45.482296Z', 1, 1, 19, 18, 1, 0),
  ('30bad2da-383d-449f-a246-ca1b806208ab', 'D', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-10-03T21:57:27.911842Z', 1, 1, 14, 12, 1, 0),
  ('d84667cc-cbcd-4165-bc9e-83c5863de998', 'D', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-10-03T22:06:14.657611Z', 1, 1, 10, 9, 1, 0),
  ('f16c7611-c266-411c-850d-bc1987f303e6', 'D', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-10-03T22:12:28.319490Z', 1, 1, 16, 12, 1, 0),
  ('d257def1-5088-4952-9ecf-0e65b30b5e73', 'D', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-10-03T22:21:21.322611Z', 1, 1, 20, 20, 1, 0),
  ('3b31e0c3-9297-40ab-b695-c7848894544c', 'D', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-10-04T08:45:51.771699Z', 1, 1, 16, 15, 1, 0),
  ('691b8d80-6001-4e8f-92d1-bb1d8896b66e', 'D', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-10-04T08:50:55.692778Z', 1, 1, 17, 19, 1, 0),
  ('6766330c-8ce3-4133-aaf4-2f37f1f2e389', 'D', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-10-04T09:06:31.272035Z', 1, 1, 20, 19, 1, 0),
  ('b4ad4aca-cdd7-4346-924c-25f920c3a70a', 'D', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-10-04T09:14:41.082179Z', 1, 1, 20, 19, 1, 0),
  ('4edaab99-23b5-493a-a334-c5d74e5fe2b2', 'D', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-10-04T09:28:37.930897Z', 1, 1, 23, 20, 1, 0),
  ('ace907cb-4e64-420c-aa64-270a29aae061', 'D', true, '2ae856da-00cb-4594-a7e6-710f2011d0c3', '2026-10-04T09:43:18.814945Z', 1, 1, 23, 25, 1, 0);
-- MANIFEST JOBS END

-- Conversations made only of listed test jobs. Each is deleted only when every
-- job, coding session and artifact in it is selected in the same run.
create temporary table v54_conversations (
  conversation_id uuid primary key,
  grp text not null check (grp in ('A', 'B', 'C'))
) on commit drop;

-- MANIFEST CONVERSATIONS BEGIN
insert into v54_conversations values
  ('ac8ce1e4-e9ef-401f-bd19-948afb9c5cb9', 'A'),
  ('df05337e-95d8-45a7-a2dd-1890d9cae6a3', 'B'),
  ('2e33a96c-63b7-4f70-a18e-b92c09d7d587', 'B'),
  ('30a333b1-589d-4b01-a396-76b39e9da8fa', 'B'),
  ('d6119681-cc1a-4f3e-89a6-3aad237ffea2', 'B'),
  ('815f6538-816d-41fa-8147-41218f9e37a0', 'B'),
  ('71205972-5c7c-4d36-839f-49f2346e03ca', 'B'),
  ('cfbd01d3-ebf9-4583-8258-9a52d5b8e3bb', 'B'),
  ('5d39be43-59c2-4807-91e3-b67df639f0c6', 'B'),
  ('1ebc084f-99ed-459e-bdd1-c4975fb6a052', 'B'),
  ('e4b6e086-e3c9-4395-878d-17e3041a59ff', 'B'),
  ('bd8ecbb0-d2bb-4d19-9bac-f2a90a881855', 'B'),
  ('79dd1e82-37f1-41e4-81f9-fdafa6b30890', 'B'),
  ('34757668-2316-4914-b563-b3638ce98f1c', 'B'),
  ('441fa85f-c750-4aca-a39f-82fb818c668e', 'C'),
  ('c82a36fb-748f-4090-a78b-5a8f40a5387c', 'C'),
  ('74c58cf6-52da-4859-9290-a5aee50af1d6', 'C'),
  ('580e88de-8a47-4be1-9969-2bfe91483b15', 'C'),
  ('3427b82a-8dec-44fe-a0e1-b234f2ccffdb', 'C'),
  ('398bc14a-640e-4e38-92ab-61c329b244b6', 'C'),
  ('acd2f8dc-78e0-428f-82fb-22cfa77b2eca', 'C'),
  ('b0d1f129-ced0-43f7-b030-1bfb6851ad25', 'C'),
  ('98c75608-5b81-45d5-b2cd-613c0b69ad4e', 'C'),
  ('fdbb1736-a884-40a4-929c-05b22d3658f5', 'C'),
  ('f125b5e3-05a5-44d8-a8f7-05047fbf19d6', 'C'),
  ('efe2ce7f-9c5a-4d19-8995-afeaf1acd66b', 'C'),
  ('c2474816-6f0c-41dc-b2df-182abf54b340', 'C'),
  ('b35f84a8-ca0f-4956-9f1b-40dfb09132b0', 'C'),
  ('db9674d5-d275-4bdd-aead-60700c02110b', 'C'),
  ('9ed20375-5275-4b63-aa98-ca34c04e76a4', 'C');
-- MANIFEST CONVERSATIONS END

-- Continuity proof-of-concept tasks (group P).
create temporary table v54_continuity (
  task_id uuid primary key,
  idempotency_key text not null unique,
  checkpoints integer not null,
  events integer not null,
  handoffs integer not null,
  usage integer not null
) on commit drop;

-- MANIFEST CONTINUITY BEGIN
insert into v54_continuity values
  ('f4b57e4b-b20a-4f9f-bd40-02b7e66b9bcf', 'continuity-poc:c7846c3e8410c4cd9b4a079b11e2aa895cb77e6d', 2, 26, 1, 2),
  ('77506b45-eac2-456b-aad6-63c6c8c25177', 'continuity-poc:v2:c7846c3e8410c4cd9b4a079b11e2aa895cb77e6d', 2, 42, 1, 2);
-- MANIFEST CONTINUITY END

do $cleanup$
declare
  c_cert constant uuid := '09627575-684a-4c8f-b21b-e25bcf6ed65f';
  c_cert_name constant text := 'CERTIFICATION V5.4 (test, safe to delete)';
  v_apply boolean := lower(btrim(coalesce(current_setting('cleanup.apply', true), ''))) = 'yes';
  v_evidence boolean := lower(btrim(coalesce(current_setting('cleanup.include_evidence', true), ''))) = 'yes';
  v_groups_raw text := btrim(coalesce(current_setting('cleanup.groups', true), ''));
  v_expect text := btrim(coalesce(current_setting('cleanup.expect_jobs', true), ''));
  v_groups text[];
  v_cert boolean;
  v_poc boolean;
  v_bad text;
  v_jobs bigint;
  v_absent bigint;
  v_held bigint;
  v_kept_knowledge bigint;
  v_cost numeric;
  v_by_provider jsonb;
  v_counts jsonb;
  v_key text;
  v_n bigint;
begin
  -- 1. Options.
  if v_apply and v_groups_raw = '' then
    raise exception 'STOP: cleanup.apply = yes needs an explicit cleanup.groups list';
  end if;
  v_groups := array(
    select distinct upper(btrim(g))
    from unnest(string_to_array(case when v_groups_raw = '' then 'A,B,C,P' else v_groups_raw end, ',')) as g
    where btrim(g) <> ''
    order by 1);
  if cardinality(v_groups) = 0 or exists (select 1 from unnest(v_groups) as g where g not in ('A', 'B', 'C', 'D', 'P')) then
    raise exception 'STOP: cleanup.groups may only list A, B, C, D and P (got "%")', v_groups_raw;
  end if;
  -- Rows an earlier approved run already removed are reported, not re-checked.
  v_cert := 'A' = any(v_groups) and exists (select 1 from public.projects where id = c_cert);
  v_poc := 'P' = any(v_groups) and exists (select 1 from public.continuity_tasks where id in (select task_id from v54_continuity));

  -- 2. The lists in this file are the reviewed manifest, unedited.
  if (select count(*) from v54_jobs) <> 80
     or (select count(*) from v54_jobs where evidence) <> 28
     or (select string_agg(grp || n, ',' order by grp) from (select grp, count(*) as n from v54_jobs group by grp) as x) <> 'A2,B27,C37,D14'
     or (select count(*) from v54_conversations) <> 30
     or (select count(*) from v54_continuity) <> 2 then
    raise exception 'STOP: the lists in this file no longer match docs/v5.4-test-data-manifest.md';
  end if;

  -- 3. Selection: listed rows of the chosen groups that still exist.
  create temporary table v54_sel on commit drop as
    select m.* from v54_jobs as m
    where m.grp = any(v_groups) and (v_evidence or not m.evidence)
      and exists (select 1 from public.jobs as j where j.id = m.job_id);
  select count(*) into v_jobs from v54_sel;
  select count(*) into v_absent from v54_jobs as m
  where m.grp = any(v_groups) and (v_evidence or not m.evidence)
    and not exists (select 1 from public.jobs as j where j.id = m.job_id);
  select count(*) into v_held from v54_jobs where grp = any(v_groups) and evidence and not v_evidence;
  create temporary table v54_sel_tasks on commit drop as
    select t.id from public.tasks as t where t.job_id in (select job_id from v54_sel);
  create temporary table v54_sel_runs on commit drop as
    select r.id from public.runs as r where r.job_id in (select job_id from v54_sel);
  create temporary table v54_sel_sessions on commit drop as
    select s.id from public.agent_sessions as s where s.job_id in (select job_id from v54_sel);
  create temporary table v54_sel_conversations on commit drop as
    select c.conversation_id as id from v54_conversations as c
    where c.grp = any(v_groups) and exists (select 1 from public.conversations as x where x.id = c.conversation_id);

  if v_jobs = 0 and not v_cert and not v_poc and not exists (select 1 from v54_sel_conversations) then
    raise exception 'STOP: nothing left to remove in groups % (already cleaned up?)', array_to_string(v_groups, ',');
  end if;

  -- 4. Every selected job is still exactly the row the manifest describes.
  select string_agg(left(s.job_id::text, 8), ', ' order by s.job_id) into v_bad
  from v54_sel as s
  join public.jobs as j on j.id = s.job_id
  where j.created_at <> s.created_at
     or j.project_id is distinct from s.project_id
     or j.status not in ('completed', 'failed', 'cancelled', 'blocked')
     or (select count(*) from public.tasks as x where x.job_id = s.job_id) <> s.tasks
     or (select count(*) from public.runs as x where x.job_id = s.job_id) <> s.runs
     or (select count(*) from public.model_attempts as x where x.job_id = s.job_id) <> s.model_attempts
     or (select count(*) from public.tool_executions as x where x.job_id = s.job_id) <> s.tool_executions
     or (select count(*) from public.agent_sessions as x where x.job_id = s.job_id) <> s.agent_sessions
     or (select count(*) from public.knowledge_items as x where x.job_id = s.job_id) <> s.knowledge_items;
  if v_bad is not null then
    raise exception 'STOP: these jobs no longer match the manifest: %', v_bad;
  end if;

  -- 5. Nothing selected is active.
  if exists (select 1 from public.agent_sessions as a
             where a.id in (select id from v54_sel_sessions)
               and (a.status not in ('completed', 'cancelled', 'blocked', 'failed') or a.lease_expires_at > now()))
     or exists (select 1 from public.events as e
                where e.job_id in (select job_id from v54_sel) and e.created_at > now() - interval '1 hour')
     or exists (select 1 from public.agent_events as e
                where e.session_id in (select id from v54_sel_sessions) and e.created_at > now() - interval '1 hour') then
    raise exception 'STOP: a selected job or coding session was active in the last hour or holds a lease';
  end if;

  -- 6. Nothing outside the selection depends on it.
  select string_agg(k, ', ') into v_bad from (
    select 'events.task_id' as k where exists (select 1 from public.events as e where e.task_id in (select id from v54_sel_tasks) and (e.job_id is null or e.job_id not in (select job_id from v54_sel)))
    union all select 'events.run_id' where exists (select 1 from public.events as e where e.run_id in (select id from v54_sel_runs) and (e.job_id is null or e.job_id not in (select job_id from v54_sel)))
    union all select 'handoffs' where exists (select 1 from public.handoffs as h where (h.from_task_id in (select id from v54_sel_tasks) or h.to_task_id in (select id from v54_sel_tasks)) and h.job_id not in (select job_id from v54_sel))
    union all select 'artifacts.task_id' where exists (select 1 from public.artifacts as a where a.task_id in (select id from v54_sel_tasks) and (a.job_id is null or a.job_id not in (select job_id from v54_sel)))
    union all select 'files.task_id' where exists (select 1 from public.files as f where f.task_id in (select id from v54_sel_tasks) and (f.job_id is null or f.job_id not in (select job_id from v54_sel)))
    union all select 'approvals.task_id' where exists (select 1 from public.approvals as a where a.task_id in (select id from v54_sel_tasks) and a.job_id not in (select job_id from v54_sel))
    union all select 'results.task_id' where exists (select 1 from public.results as x where x.task_id in (select id from v54_sel_tasks) and x.job_id not in (select job_id from v54_sel))
    union all select 'runs.task_id' where exists (select 1 from public.runs as x where x.task_id in (select id from v54_sel_tasks) and x.job_id not in (select job_id from v54_sel))
    union all select 'model_attempts' where exists (select 1 from public.model_attempts as m where (m.task_id in (select id from v54_sel_tasks) or m.run_id in (select id from v54_sel_runs)) and m.job_id not in (select job_id from v54_sel))
    union all select 'tool_executions' where exists (select 1 from public.tool_executions as x where (x.task_id in (select id from v54_sel_tasks) or x.run_id in (select id from v54_sel_runs)) and x.job_id not in (select job_id from v54_sel))
    union all select 'agent_sessions' where exists (select 1 from public.agent_sessions as x where (x.task_id in (select id from v54_sel_tasks) or x.run_id in (select id from v54_sel_runs)) and x.job_id not in (select job_id from v54_sel))
    union all select 'coding_worker_sessions' where exists (select 1 from public.coding_worker_sessions as c where c.native_session_id in (select id from v54_sel_sessions))
    union all select 'memory' where exists (select 1 from public.memory as m where m.source_job_id in (select job_id from v54_sel))
    union all select 'a selected job launched a kept session' where exists (select 1 from public.events as e where e.job_id in (select job_id from v54_sel) and e.payload->>'session_id' is not null and e.payload->>'session_id' not in (select id::text from v54_sel_sessions))
    union all select 'a kept job launched a selected session' where exists (select 1 from public.events as e where (e.job_id is null or e.job_id not in (select job_id from v54_sel)) and e.payload->>'session_id' in (select id::text from v54_sel_sessions))
  ) as x;
  if v_bad is not null then
    raise exception 'STOP: rows outside the selection depend on it: %', v_bad;
  end if;

  -- 7. A conversation goes only when everything in it goes.
  select string_agg(left(c.id::text, 8), ', ' order by c.id) into v_bad
  from v54_sel_conversations as c
  where not exists (select 1 from public.jobs as j where j.conversation_id = c.id and j.id in (select job_id from v54_sel))
     or exists (select 1 from public.jobs as j where j.conversation_id = c.id and j.id not in (select job_id from v54_sel))
     or exists (select 1 from public.agent_sessions as a where a.conversation_id = c.id and a.id not in (select id from v54_sel_sessions))
     or exists (select 1 from public.artifacts as a where a.conversation_id = c.id and (a.job_id is null or a.job_id not in (select job_id from v54_sel)));
  if v_bad is not null then
    raise exception 'STOP: these conversations hold rows outside the selection: %', v_bad;
  end if;

  -- 8. The certification project holds nothing but certification rows.
  if v_cert then
    if not exists (select 1 from public.projects as p where p.id = c_cert and p.name = c_cert_name) then
      raise exception 'STOP: the certification project was renamed';
    end if;
    select string_agg(k, ', ') into v_bad from (
      select 'jobs' as k where exists (select 1 from public.jobs as j where j.project_id = c_cert and j.id not in (select job_id from v54_sel))
      union all select 'agent_sessions' where exists (select 1 from public.agent_sessions as a where a.workspace_id = c_cert and a.id not in (select id from v54_sel_sessions))
      union all select 'agent_approvals' where exists (select 1 from public.agent_approvals as a where a.workspace_id = c_cert and a.session_id not in (select id from v54_sel_sessions))
      union all select 'tool_executions' where exists (select 1 from public.tool_executions as t where t.workspace_id = c_cert and t.job_id not in (select job_id from v54_sel))
      union all select 'model_attempts' where exists (select 1 from public.model_attempts as m where m.workspace_id = c_cert and m.job_id not in (select job_id from v54_sel))
      union all select 'artifacts' where exists (select 1 from public.artifacts as a where a.project_id = c_cert and (a.job_id is null or a.job_id not in (select job_id from v54_sel)))
      union all select 'conversations' where exists (select 1 from public.conversations as c where c.project_id = c_cert and c.id not in (select id from v54_sel_conversations))
      union all select 'coding_worker_sessions' where exists (select 1 from public.coding_worker_sessions as c where c.project_id = c_cert)
      union all select 'project_memory' where exists (select 1 from public.project_memory as m where m.project_id = c_cert)
    ) as x;
    if v_bad is not null then
      raise exception 'STOP: the certification project holds rows outside the selection: %', v_bad;
    end if;
  end if;

  -- 9. The Continuity proof-of-concept tasks are unchanged and idle.
  if v_poc then
    select string_agg(left(p.task_id::text, 8), ', ' order by p.task_id) into v_bad
    from v54_continuity as p
    join public.continuity_tasks as t on t.id = p.task_id
    where t.idempotency_key <> p.idempotency_key
       or t.status <> 'completed'
       or t.lease_expires_at > now()
       or (select count(*) from public.continuity_checkpoints as x where x.task_id = p.task_id) <> p.checkpoints
       or (select count(*) from public.continuity_events as x where x.task_id = p.task_id) <> p.events
       or (select count(*) from public.continuity_handoffs as x where x.task_id = p.task_id) <> p.handoffs
       or (select count(*) from public.continuity_usage as x where x.task_id = p.task_id) <> p.usage
       or exists (select 1 from public.continuity_handoffs as h
                  join public.continuity_checkpoints as c on c.id = h.checkpoint_id
                  where c.task_id = p.task_id and h.task_id not in (select task_id from v54_continuity));
    if v_bad is not null then
      raise exception 'STOP: these Continuity tasks no longer match the manifest: %', v_bad;
    end if;
  end if;

  -- 10. Preview.
  v_counts := jsonb_build_object(
    'continuity_handoffs', case when v_poc then (select count(*) from public.continuity_handoffs where task_id in (select task_id from v54_continuity)) else 0 end,
    'continuity_checkpoints', case when v_poc then (select count(*) from public.continuity_checkpoints where task_id in (select task_id from v54_continuity)) else 0 end,
    'continuity_events', case when v_poc then (select count(*) from public.continuity_events where task_id in (select task_id from v54_continuity)) else 0 end,
    'continuity_usage', case when v_poc then (select count(*) from public.continuity_usage where task_id in (select task_id from v54_continuity)) else 0 end,
    'continuity_tasks', case when v_poc then (select count(*) from public.continuity_tasks where id in (select task_id from v54_continuity)) else 0 end,
    'agent_owner_inputs', (select count(*) from public.agent_owner_inputs where session_id in (select id from v54_sel_sessions)),
    'agent_approvals', (select count(*) from public.agent_approvals where session_id in (select id from v54_sel_sessions)),
    'agent_checkpoints', (select count(*) from public.agent_checkpoints where session_id in (select id from v54_sel_sessions)),
    'agent_events', (select count(*) from public.agent_events where session_id in (select id from v54_sel_sessions)),
    'tool_executions', (select count(*) from public.tool_executions where job_id in (select job_id from v54_sel)),
    'agent_sessions', (select count(*) from v54_sel_sessions),
    'model_attempts', (select count(*) from public.model_attempts where job_id in (select job_id from v54_sel)),
    'events', (select count(*) from public.events where job_id in (select job_id from v54_sel)),
    'handoffs', (select count(*) from public.handoffs where job_id in (select job_id from v54_sel)),
    'results', (select count(*) from public.results where job_id in (select job_id from v54_sel)),
    'artifacts', (select count(*) from public.artifacts where job_id in (select job_id from v54_sel)),
    'approvals', (select count(*) from public.approvals where job_id in (select job_id from v54_sel)),
    'files', (select count(*) from public.files where job_id in (select job_id from v54_sel)),
    'runs', (select count(*) from v54_sel_runs),
    'tasks', (select count(*) from v54_sel_tasks),
    'jobs', v_jobs,
    'conversations', (select count(*) from v54_sel_conversations),
    'projects', case when v_cert then 1 else 0 end);
  select coalesce(sum(m.cost_usd), 0) into v_cost
  from public.model_attempts as m where m.job_id in (select job_id from v54_sel);
  select coalesce(jsonb_object_agg(x.provider, x.cost), '{}'::jsonb) into v_by_provider
  from (select m.provider, round(sum(m.cost_usd), 6) as cost
        from public.model_attempts as m
        where m.job_id in (select job_id from v54_sel) and m.cost_usd > 0
        group by m.provider) as x;
  select count(*) into v_kept_knowledge
  from public.knowledge_items as k
  where k.job_id in (select job_id from v54_sel) and not (v_cert and k.project_id = c_cert);

  raise notice 'V5.4 test-data cleanup: groups %, evidence rows %, mode %',
    array_to_string(v_groups, ','), case when v_evidence then 'INCLUDED' else 'held' end, case when v_apply then 'APPLY' else 'PREVIEW' end;
  raise notice 'Jobs selected: %   evidence rows held back: %   already removed earlier: %', v_jobs, v_held, v_absent;
  for v_key, v_n in select key, value::bigint from jsonb_each_text(v_counts) loop
    raise notice '  preview  %  %', rpad(v_key, 30), v_n;
  end loop;
  if v_cert then
    raise notice 'Removed with the CERTIFICATION V5.4 project: % workspace policy, % provider permissions, % tool grants, % review rows, % knowledge items',
      (select count(*) from public.workspace_policies where workspace_id = c_cert),
      (select count(*) from public.workspace_provider_permissions where workspace_id = c_cert),
      (select count(*) from public.workspace_tool_grants where workspace_id = c_cert),
      (select count(*) from public.deliverable_reviews where project_id = c_cert),
      (select count(*) from public.knowledge_items where project_id = c_cert);
  end if;
  raise notice 'Knowledge items kept, with their job link cleared: %', v_kept_knowledge;
  raise notice 'Historical model cost leaving model_attempts: % USD %. Workspace spent_usd counters are not changed.', v_cost, v_by_provider;

  if not v_apply then
    raise notice 'PREVIEW ONLY: nothing was deleted. To apply, set cleanup.groups = ''%'', cleanup.expect_jobs = ''%'' and cleanup.apply = ''yes''.',
      array_to_string(v_groups, ','), v_jobs;
    return;
  end if;
  if v_expect !~ '^[0-9]+$' or v_expect::bigint <> v_jobs then
    raise exception 'STOP: cleanup.expect_jobs ("%") must equal the selected job count (%)', v_expect, v_jobs;
  end if;

  -- 11. Delete in foreign-key order. Each statement must remove exactly the previewed rows.
  if v_poc then
    delete from public.continuity_handoffs where task_id in (select task_id from v54_continuity);
    get diagnostics v_n = row_count;
    perform pg_temp.v54_removed('continuity_handoffs', v_n, (v_counts->>'continuity_handoffs')::bigint);
    delete from public.continuity_checkpoints where task_id in (select task_id from v54_continuity);
    get diagnostics v_n = row_count;
    perform pg_temp.v54_removed('continuity_checkpoints', v_n, (v_counts->>'continuity_checkpoints')::bigint);
    delete from public.continuity_events where task_id in (select task_id from v54_continuity);
    get diagnostics v_n = row_count;
    perform pg_temp.v54_removed('continuity_events', v_n, (v_counts->>'continuity_events')::bigint);
    delete from public.continuity_usage where task_id in (select task_id from v54_continuity);
    get diagnostics v_n = row_count;
    perform pg_temp.v54_removed('continuity_usage', v_n, (v_counts->>'continuity_usage')::bigint);
    delete from public.continuity_tasks where id in (select task_id from v54_continuity);
    get diagnostics v_n = row_count;
    perform pg_temp.v54_removed('continuity_tasks', v_n, (v_counts->>'continuity_tasks')::bigint);
  end if;

  delete from public.agent_owner_inputs where session_id in (select id from v54_sel_sessions);
  get diagnostics v_n = row_count;
  perform pg_temp.v54_removed('agent_owner_inputs', v_n, (v_counts->>'agent_owner_inputs')::bigint);
  delete from public.agent_approvals where session_id in (select id from v54_sel_sessions);
  get diagnostics v_n = row_count;
  perform pg_temp.v54_removed('agent_approvals', v_n, (v_counts->>'agent_approvals')::bigint);
  delete from public.agent_checkpoints where session_id in (select id from v54_sel_sessions);
  get diagnostics v_n = row_count;
  perform pg_temp.v54_removed('agent_checkpoints', v_n, (v_counts->>'agent_checkpoints')::bigint);
  delete from public.agent_events where session_id in (select id from v54_sel_sessions);
  get diagnostics v_n = row_count;
  perform pg_temp.v54_removed('agent_events', v_n, (v_counts->>'agent_events')::bigint);
  delete from public.tool_executions where job_id in (select job_id from v54_sel);
  get diagnostics v_n = row_count;
  perform pg_temp.v54_removed('tool_executions', v_n, (v_counts->>'tool_executions')::bigint);
  delete from public.agent_sessions where id in (select id from v54_sel_sessions);
  get diagnostics v_n = row_count;
  perform pg_temp.v54_removed('agent_sessions', v_n, (v_counts->>'agent_sessions')::bigint);
  delete from public.model_attempts where job_id in (select job_id from v54_sel);
  get diagnostics v_n = row_count;
  perform pg_temp.v54_removed('model_attempts', v_n, (v_counts->>'model_attempts')::bigint);
  delete from public.events where job_id in (select job_id from v54_sel);
  get diagnostics v_n = row_count;
  perform pg_temp.v54_removed('events', v_n, (v_counts->>'events')::bigint);
  delete from public.handoffs where job_id in (select job_id from v54_sel);
  get diagnostics v_n = row_count;
  perform pg_temp.v54_removed('handoffs', v_n, (v_counts->>'handoffs')::bigint);
  delete from public.results where job_id in (select job_id from v54_sel);
  get diagnostics v_n = row_count;
  perform pg_temp.v54_removed('results', v_n, (v_counts->>'results')::bigint);
  delete from public.artifacts where job_id in (select job_id from v54_sel);
  get diagnostics v_n = row_count;
  perform pg_temp.v54_removed('artifacts', v_n, (v_counts->>'artifacts')::bigint);
  delete from public.approvals where job_id in (select job_id from v54_sel);
  get diagnostics v_n = row_count;
  perform pg_temp.v54_removed('approvals', v_n, (v_counts->>'approvals')::bigint);
  delete from public.files where job_id in (select job_id from v54_sel);
  get diagnostics v_n = row_count;
  perform pg_temp.v54_removed('files', v_n, (v_counts->>'files')::bigint);
  delete from public.runs where job_id in (select job_id from v54_sel);
  get diagnostics v_n = row_count;
  perform pg_temp.v54_removed('runs', v_n, (v_counts->>'runs')::bigint);
  delete from public.tasks where job_id in (select job_id from v54_sel);
  get diagnostics v_n = row_count;
  perform pg_temp.v54_removed('tasks', v_n, (v_counts->>'tasks')::bigint);
  delete from public.jobs where id in (select job_id from v54_sel);
  get diagnostics v_n = row_count;
  perform pg_temp.v54_removed('jobs', v_n, v_jobs);
  delete from public.conversations where id in (select id from v54_sel_conversations);
  get diagnostics v_n = row_count;
  perform pg_temp.v54_removed('conversations', v_n, (v_counts->>'conversations')::bigint);
  if v_cert then
    delete from public.projects where id = c_cert and name = c_cert_name;
    get diagnostics v_n = row_count;
    perform pg_temp.v54_removed('projects', v_n, 1);
  end if;

  -- 12. Nothing selected is left behind.
  if exists (select 1 from public.jobs where id in (select job_id from v54_sel))
     or exists (select 1 from public.knowledge_items where job_id in (select job_id from v54_sel))
     or (v_cert and exists (select 1 from public.workspace_policies where workspace_id = c_cert))
     or (v_poc and exists (select 1 from public.continuity_tasks where id in (select task_id from v54_continuity))) then
    raise exception 'STOP: selected rows are still present after the delete; nothing was committed';
  end if;

  -- 13. Audit record of what was removed.
  insert into public.events (type, level, message, payload)
  values ('activity', 'info',
          format('Test data cleanup (V5.4 manifest): removed %s test objectives.', v_jobs),
          jsonb_build_object(
            'kind', 'test_data_cleanup',
            'manifest', 'docs/v5.4-test-data-manifest.md',
            'groups', to_jsonb(v_groups),
            'evidenceIncluded', v_evidence,
            'jobIds', coalesce((select jsonb_agg(job_id order by job_id) from v54_sel), '[]'::jsonb),
            'alreadyRemovedJobs', v_absent,
            'removed', v_counts,
            'removedModelCostUsd', v_cost,
            'removedModelCostByProvider', v_by_provider,
            'by', session_user));
  raise notice 'APPLIED: % test objectives removed; audit event written.', v_jobs;
end
$cleanup$;

commit;
