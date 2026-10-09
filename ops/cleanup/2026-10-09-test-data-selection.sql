-- The CONFIRMED TEST selection of 2026-10-09 (Live Operations rollout).
-- 82 jobs by explicit id: probes, canaries, verification and smoke runs,
-- Office tests, V2 checks, acceptance, benchmark, burn-in, load and launch
-- smokes, Continuity Phase N drill legs, V5 production smokes and the
-- 2026-10-09 routing test. CONFIRMED REAL and UNCERTAIN jobs are not listed,
-- so nothing can select them. The classification is in
-- docs/cleanup/2026-10-09-test-data-cleanup.md.
create temporary table if not exists cleanup_jobs (job_id uuid primary key) on commit drop;
insert into cleanup_jobs (job_id) select unnest(array[
'f61c09ba-278c-495e-aaa2-a9f7302ca095','cf0a595e-fe1d-4cc4-9ba7-1b69251a6e17','eecf20f4-ee10-476a-ba48-f7e41c47329a','771d6445-172a-4485-8a0b-70175aeaf64d',
'7fb7cfea-00b9-46e6-8b1d-55ac6f64f869','221b3c38-37c3-4147-9faf-d5d4ff726bae','849af6c6-d2e2-4230-b330-06c88cbe250a','a4caea72-049d-4097-a554-08a5080f7ae0',
'3cf847c3-30c3-4e56-acbc-ef16b02f01a6','fdd024d0-8f3f-4b85-9900-1c1b55dc620a','24933de5-9d19-4897-b575-12455f22320e','f934cf5e-6487-4d6a-8a69-d66dc106ea55',
'be0411a4-b521-4e45-a399-7954a3918b9c','fa3be66d-6789-45ae-913e-3346bc560632','21920eaf-c09e-445f-bf82-455638166b00','3fa5d872-4ce1-4a77-a4f9-03cc92a0e21c',
'046c47b3-19e0-4ee5-ab87-258b5e05f5f1','63c7ad4b-964a-4276-bc59-f7e379aa0c3c','b4bca3a6-65c6-43dc-ad42-c0f5d5d1c856','31db22ba-15ee-4abe-af8b-8bfd7e23839f',
'1e2bff90-7bec-4318-a1cc-7a145e0815a5','2595de7e-70c5-4b39-a32e-be63a39ce6b4','6adc823b-6172-4358-91ed-f42aab3f0b76','14107a98-9601-4619-8199-009afea94879',
'fab1b30e-15a4-4cff-89cb-c9fe2a3210d8','419abe85-b680-48e4-8093-179eea98d1fd','4c3275d6-5589-4865-a251-e4d2970438fa','cf20325f-928d-4727-87db-67ed964680d9',
'3f8f2482-70fc-46bb-b2bc-794c9df95358','13e6929f-92d9-462b-ab8c-7fdec4a23376','e5739662-e29c-44fa-9516-5b2f2583ebf3','43667334-8484-4f68-9a38-9b7e3f8c7874',
'ebc4388d-ac52-4857-9047-69d077c16628','849e7cc8-81d4-4be6-a5b2-6226b235fb85','a0fe4224-96e6-46ce-831d-d76d32c169d7','c7c819ba-9260-4e6c-92b3-c657db691dce',
'8d7013c5-3d88-4cef-9d0f-79b56aaf907c','8c856cdb-4b69-47f8-bfeb-6bf80785f125','8b293887-c455-4b41-a7dc-ebbf3a3f6b9e','0a5b8481-7d5c-4c13-b14a-7a4cd6c11014',
'306f66e0-961a-4b27-a4ca-93650c594ecb','dc8dc266-b131-4d18-ae00-9f418b6455a1','e8ee0ff3-e88f-4242-9b66-93893231199e','3550062e-4d0a-4e25-bba7-c0717aa4ec3f',
'bdb7a5bf-b1f6-49c1-a924-bc42dfabdba5','e0db05dc-c1ae-4264-946d-31b07b2805d1','abaccdad-856e-4b8a-9898-b4116e6952e1','1a797e28-5da5-4fdf-9bd1-5524f74186b9',
'fa6ca885-175b-4985-8d15-8c542e2e1a16','ca6c8c0d-1754-47e5-8e92-076d89404b5c','36b1da92-2a27-4a6b-ac5b-292328a2b1e2','85d5210f-239b-4242-85f9-81a4843faaec',
'9b32953a-532a-4d98-8e58-ce0454ab439e','000991aa-a1a7-4023-af4f-42599f4597f0','3489317d-5ebc-4506-9db3-3b22f6663a80','9efd098a-5eec-4317-b491-b23911da1419',
'8f79aeb8-85b2-495f-b25a-c5f102dad94e','668ad9a5-6f4c-4edb-8b6c-5ce0ae80079f','aec7e773-78e6-41e6-858c-44995551875a','4e14eabc-cfa8-4b11-852c-832535a9d1bd',
'a58602b7-b0af-433d-a11c-04d4197c9911','e445770e-50a5-420c-926d-482c57d538cc','eedd47f4-f6ad-4f0e-9a43-68207a9cb1e6','6fad4ac3-7f1c-4ad8-aa24-e8e3689ebcf6',
'6487ce49-2505-48fe-8ce2-2d03eaa32a9f','80ecf446-3a80-4821-ad5d-e494c6cd2338','d850ed0e-9e7b-442a-b516-401b717abfe1','a836c5d4-4011-4f08-bbad-333d6f01b1e1',
'6ac14ebf-981c-43b7-8eab-0b75286768ff','30bad2da-383d-449f-a246-ca1b806208ab','d84667cc-cbcd-4165-bc9e-83c5863de998','f16c7611-c266-411c-850d-bc1987f303e6',
'd257def1-5088-4952-9ecf-0e65b30b5e73','3b31e0c3-9297-40ab-b695-c7848894544c','691b8d80-6001-4e8f-92d1-bb1d8896b66e','6766330c-8ce3-4133-aaf4-2f37f1f2e389',
'b4ad4aca-cdd7-4346-924c-25f920c3a70a','4edaab99-23b5-493a-a334-c5d74e5fe2b2','ace907cb-4e64-420c-aa64-270a29aae061','c41212bb-3567-452e-8f50-d0fc101f5830',
'776a9b1a-0688-4141-9264-9146db823384','4882216d-f800-481d-a9ed-9af61fc5d842'
]::uuid[]) on conflict do nothing;
