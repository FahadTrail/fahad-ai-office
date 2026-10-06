-- Synthetic rows shaped like the V5.4 test-data manifest, used only by
-- ops/cleanup/verify-v5.4-cleanup.sh against a throwaway local database.
-- The harness first loads the manifest blocks of v5.4-test-data-cleanup.sql
-- into fixture.v54_jobs, fixture.v54_conversations and fixture.v54_continuity.
-- Every listed job gets exactly the dependent counts the manifest pins. Rows
-- that must survive are added as well: REAL and UNCERTAIN jobs, a mixed
-- conversation, a launch from a kept job, and a kept Continuity task.

set search_path = fixture, public;

create table fx_conversation_jobs (conversation_id uuid not null, job_id uuid not null);
insert into fx_conversation_jobs values
  ('ac8ce1e4-e9ef-401f-bd19-948afb9c5cb9', '3e322785-cd8a-418c-b21b-f4e3fc7b9f00'),
  ('df05337e-95d8-45a7-a2dd-1890d9cae6a3', '221b3c38-37c3-4147-9faf-d5d4ff726bae'),
  ('2e33a96c-63b7-4f70-a18e-b92c09d7d587', '849af6c6-d2e2-4230-b330-06c88cbe250a'),
  ('30a333b1-589d-4b01-a396-76b39e9da8fa', 'a4caea72-049d-4097-a554-08a5080f7ae0'),
  ('d6119681-cc1a-4f3e-89a6-3aad237ffea2', 'fdd024d0-8f3f-4b85-9900-1c1b55dc620a'),
  ('815f6538-816d-41fa-8147-41218f9e37a0', '24933de5-9d19-4897-b575-12455f22320e'),
  ('71205972-5c7c-4d36-839f-49f2346e03ca', 'f934cf5e-6487-4d6a-8a69-d66dc106ea55'),
  ('cfbd01d3-ebf9-4583-8258-9a52d5b8e3bb', 'be0411a4-b521-4e45-a399-7954a3918b9c'),
  ('5d39be43-59c2-4807-91e3-b67df639f0c6', 'fa3be66d-6789-45ae-913e-3346bc560632'),
  ('1ebc084f-99ed-459e-bdd1-c4975fb6a052', '21920eaf-c09e-445f-bf82-455638166b00'),
  ('e4b6e086-e3c9-4395-878d-17e3041a59ff', '3fa5d872-4ce1-4a77-a4f9-03cc92a0e21c'),
  ('bd8ecbb0-d2bb-4d19-9bac-f2a90a881855', '046c47b3-19e0-4ee5-ab87-258b5e05f5f1'),
  ('79dd1e82-37f1-41e4-81f9-fdafa6b30890', '63c7ad4b-964a-4276-bc59-f7e379aa0c3c'),
  ('34757668-2316-4914-b563-b3638ce98f1c', 'b4bca3a6-65c6-43dc-ad42-c0f5d5d1c856'),
  ('441fa85f-c750-4aca-a39f-82fb818c668e', '6adc823b-6172-4358-91ed-f42aab3f0b76'),
  ('c82a36fb-748f-4090-a78b-5a8f40a5387c', '4c3275d6-5589-4865-a251-e4d2970438fa'),
  ('74c58cf6-52da-4859-9290-a5aee50af1d6', '14107a98-9601-4619-8199-009afea94879'),
  ('580e88de-8a47-4be1-9969-2bfe91483b15', 'fab1b30e-15a4-4cff-89cb-c9fe2a3210d8'),
  ('3427b82a-8dec-44fe-a0e1-b234f2ccffdb', '419abe85-b680-48e4-8093-179eea98d1fd'),
  ('398bc14a-640e-4e38-92ab-61c329b244b6', '3f8f2482-70fc-46bb-b2bc-794c9df95358'),
  ('398bc14a-640e-4e38-92ab-61c329b244b6', '13e6929f-92d9-462b-ab8c-7fdec4a23376'),
  ('398bc14a-640e-4e38-92ab-61c329b244b6', 'e5739662-e29c-44fa-9516-5b2f2583ebf3'),
  ('398bc14a-640e-4e38-92ab-61c329b244b6', '43667334-8484-4f68-9a38-9b7e3f8c7874'),
  ('acd2f8dc-78e0-428f-82fb-22cfa77b2eca', '849e7cc8-81d4-4be6-a5b2-6226b235fb85'),
  ('b0d1f129-ced0-43f7-b030-1bfb6851ad25', '807397f6-5f31-4965-bc5c-d30eb93d330c'),
  ('98c75608-5b81-45d5-b2cd-613c0b69ad4e', 'c7c819ba-9260-4e6c-92b3-c657db691dce'),
  ('fdbb1736-a884-40a4-929c-05b22d3658f5', '8d7013c5-3d88-4cef-9d0f-79b56aaf907c'),
  ('f125b5e3-05a5-44d8-a8f7-05047fbf19d6', '8c856cdb-4b69-47f8-bfeb-6bf80785f125'),
  ('efe2ce7f-9c5a-4d19-8995-afeaf1acd66b', '8b293887-c455-4b41-a7dc-ebbf3a3f6b9e'),
  ('c2474816-6f0c-41dc-b2df-182abf54b340', '306f66e0-961a-4b27-a4ca-93650c594ecb'),
  ('b35f84a8-ca0f-4956-9f1b-40dfb09132b0', '0a5b8481-7d5c-4c13-b14a-7a4cd6c11014'),
  ('db9674d5-d275-4bdd-aead-60700c02110b', '1a797e28-5da5-4fdf-9bd1-5524f74186b9'),
  ('9ed20375-5275-4b63-aa98-ca34c04e76a4', 'fa6ca885-175b-4985-8d15-8c542e2e1a16'),
  -- The kept Telegram conversation mixes test, evidence and real jobs.
  ('d25764ca-233d-4821-89e6-4c6cc396f805', 'dc8dc266-b131-4d18-ae00-9f418b6455a1'),
  ('d25764ca-233d-4821-89e6-4c6cc396f805', '36b1da92-2a27-4a6b-ac5b-292328a2b1e2'),
  ('d25764ca-233d-4821-89e6-4c6cc396f805', 'e8ee0ff3-e88f-4242-9b66-93893231199e'),
  ('d25764ca-233d-4821-89e6-4c6cc396f805', 'e0db05dc-c1ae-4264-946d-31b07b2805d1'),
  ('d25764ca-233d-4821-89e6-4c6cc396f805', 'abaccdad-856e-4b8a-9898-b4116e6952e1'),
  ('d25764ca-233d-4821-89e6-4c6cc396f805', 'ca6c8c0d-1754-47e5-8e92-076d89404b5c');

-- REAL and UNCERTAIN jobs that must survive every run.
create table fx_kept_jobs (job_id uuid primary key, conversation_id uuid, coding boolean not null);
insert into fx_kept_jobs values
  ('f45e3086-631a-45b9-bbb1-8fd5019c2023', 'd25764ca-233d-4821-89e6-4c6cc396f805', false),
  ('bdb7a5bf-b1f6-49c1-a924-bc42dfabdba5', null, true),
  ('3550062e-4d0a-4e25-bba7-c0717aa4ec3f', '993d4761-917a-48d5-9142-dbabccfce3b3', false);

insert into public.projects (id, name) values
  ('2ae856da-00cb-4594-a7e6-710f2011d0c3', 'Fahad AI Office'),
  ('09627575-684a-4c8f-b21b-e25bcf6ed65f', 'CERTIFICATION V5.4 (test, safe to delete)');
insert into public.workspace_policies (workspace_id, enabled, monthly_budget_usd, max_request_budget_usd, budget_period_start, budget_period_end)
select id, true, 2, 0.1, date_trunc('month', now()), date_trunc('month', now()) + interval '1 month' from public.projects;
insert into public.workspace_provider_permissions (workspace_id, provider, models, secret_ref) values
  ('09627575-684a-4c8f-b21b-e25bcf6ed65f', 'groq', array['fixture-model'], 'env://GROQ_API_KEY'),
  ('2ae856da-00cb-4594-a7e6-710f2011d0c3', 'groq', array['fixture-model'], 'env://GROQ_API_KEY');
insert into public.workspace_tool_grants (workspace_id, broker, tool_name) values
  ('09627575-684a-4c8f-b21b-e25bcf6ed65f', 'mcp', 'read_file'),
  ('2ae856da-00cb-4594-a7e6-710f2011d0c3', 'mcp', 'read_file');
insert into public.deliverable_reviews (project_id, deliverable_key)
  values ('09627575-684a-4c8f-b21b-e25bcf6ed65f', 'task:c0117041-6c21-412f-afd6-cfc57634f517');

insert into public.conversations (id, project_id, title)
select distinct m.conversation_id, coalesce(j.project_id, '2ae856da-00cb-4594-a7e6-710f2011d0c3'), 'Fixture conversation'
from fx_conversation_jobs as m join v54_jobs as j on j.job_id = m.job_id;
insert into public.conversations (id, project_id, title)
  values ('993d4761-917a-48d5-9142-dbabccfce3b3', '2ae856da-00cb-4594-a7e6-710f2011d0c3', 'Kept conversation');

create table fx_all_jobs as
  select job_id, grp, project_id, created_at, tasks, runs, model_attempts, tool_executions, agent_sessions, knowledge_items from v54_jobs
  union all
  select job_id, 'K', '2ae856da-00cb-4594-a7e6-710f2011d0c3', timestamptz '2026-09-27 14:18:00Z', 2, 2, 2, case when coding then 2 else 0 end, case when coding then 1 else 0 end, 1
  from fx_kept_jobs;

insert into public.jobs (id, project_id, goal, title, status, created_at, conversation_id)
select a.job_id, a.project_id, 'Fixture objective ' || a.grp, 'Fixture objective ' || a.grp,
       case when a.job_id = 'a1c49941-5e46-458c-ab3e-9364035ed0d0' then 'cancelled' else 'completed' end,
       a.created_at,
       coalesce((select m.conversation_id from fx_conversation_jobs as m where m.job_id = a.job_id),
                (select k.conversation_id from fx_kept_jobs as k where k.job_id = a.job_id))
from fx_all_jobs as a;

insert into public.tasks (job_id, agent_id, title, status, created_at)
select a.job_id, (select id from public.agents where slug = 'chief-of-staff'), 'Fixture task ' || g, 'done', a.created_at
from fx_all_jobs as a cross join lateral generate_series(1, a.tasks) as g;

create table fx_tasks as
  select t.id, t.job_id, row_number() over (partition by t.job_id order by t.id) as n
  from public.tasks as t where t.job_id in (select job_id from fx_all_jobs);

insert into public.runs (task_id, job_id, agent_id, status, started_at)
select t.id, a.job_id, (select id from public.agents where slug = 'chief-of-staff'), 'succeeded', a.created_at
from fx_all_jobs as a
cross join lateral generate_series(1, a.runs) as g
join fx_tasks as t on t.job_id = a.job_id and t.n = ((g - 1) % a.tasks) + 1;

create table fx_first_run as
  select distinct on (r.job_id) r.job_id, r.task_id, r.id as run_id
  from public.runs as r where r.job_id in (select job_id from fx_all_jobs) order by r.job_id, r.id;

insert into public.model_attempts (workspace_id, job_id, task_id, run_id, attempt_no, provider_attempt, provider, model, stage, status, idempotency_key, started_at, cost_usd)
select a.project_id, a.job_id, f.task_id, f.run_id, g, 1,
       case when a.grp = 'B' then 'anthropic' else 'groq' end, 'fixture-model', 'task', 'succeeded',
       'fixture:' || a.job_id || ':' || g, a.created_at, case when a.grp = 'B' then 0.01 else 0 end
from fx_all_jobs as a cross join lateral generate_series(1, a.model_attempts) as g
join fx_first_run as f on f.job_id = a.job_id;

insert into public.tool_executions (workspace_id, job_id, task_id, run_id, agent_id, broker, tool_name, action, risk, decision,
                                    server_name, protocol_version, idempotency_key, status, started_at, ended_at)
select a.project_id, a.job_id, f.task_id, f.run_id, (select id from public.agents where slug = 'chief-of-staff'),
       'mcp', 'read_file', 'read', 'low', 'auto', 'fixture', '2025-06-18', 'fixture:' || a.job_id || ':' || g,
       'succeeded', a.created_at, a.created_at + interval '1 second'
from fx_all_jobs as a cross join lateral generate_series(1, a.tool_executions) as g
join fx_first_run as f on f.job_id = a.job_id;

insert into public.agent_sessions (workspace_id, job_id, task_id, run_id, agent_id, title, objective, repository, status, phase, created_at, updated_at)
select a.project_id, a.job_id, f.task_id, f.run_id, (select id from public.agents where slug = 'coding-agent'),
       'Fixture session', 'Fixture coding objective for the cleanup check.', 'FahadTrail/fahad-ai-office',
       case when a.job_id = 'a1c49941-5e46-458c-ab3e-9364035ed0d0' then 'cancelled' else 'completed' end, 'done', a.created_at, a.created_at
from fx_all_jobs as a join fx_first_run as f on f.job_id = a.job_id
where a.agent_sessions > 0;

insert into public.agent_events (session_id, type, message, created_at)
select s.id, 'session', 'Fixture event ' || g, s.created_at
from public.agent_sessions as s cross join generate_series(1, 3) as g;
insert into public.agent_checkpoints (session_id, sequence, reason, phase, created_at)
select s.id, 1, 'final', 'done', s.created_at from public.agent_sessions as s;

insert into public.knowledge_items (project_id, job_id, agent_slug, title, source_url)
select a.project_id, a.job_id, 'research-strategy', 'Fixture source ' || g, 'https://example.com/fixture/' || a.job_id || '/' || g
from fx_all_jobs as a cross join lateral generate_series(1, a.knowledge_items) as g;

insert into public.events (job_id, type, level, message, payload, created_at)
select a.job_id, 'activity', 'info', 'Fixture activity', '{}'::jsonb, a.created_at
from fx_all_jobs as a cross join generate_series(1, 2);
insert into public.results (job_id, task_id, kind, content, created_at)
select f.job_id, f.task_id, 'task', 'Fixture result', a.created_at
from fx_all_jobs as a join fx_first_run as f on f.job_id = a.job_id;
insert into public.handoffs (job_id, from_task_id, to_task_id, to_agent_id, created_at)
select a.job_id, t1.id, t2.id, (select id from public.agents where slug = 'chief-of-staff'), a.created_at
from fx_all_jobs as a
join fx_tasks as t1 on t1.job_id = a.job_id and t1.n = 1
join fx_tasks as t2 on t2.job_id = a.job_id and t2.n = 2;
insert into public.artifacts (project_id, job_id, task_id, conversation_id, agent_slug, type, title, data, created_at)
select a.project_id, a.job_id, f.task_id, j.conversation_id, 'chief-of-staff', 'report', 'Fixture artifact', '{}'::jsonb, a.created_at
from fx_all_jobs as a
join fx_first_run as f on f.job_id = a.job_id
join public.jobs as j on j.id = a.job_id
where a.project_id is not null;

-- The kept CHIEF objective launched the kept coding session (PR #64 in production).
insert into public.events (job_id, type, level, message, payload, created_at)
select '3550062e-4d0a-4e25-bba7-c0717aa4ec3f', 'activity', 'info', 'Launched a coding task',
       jsonb_build_object('kind', 'task_launched', 'session_id', s.id), timestamptz '2026-09-27 14:18:30Z'
from public.agent_sessions as s where s.job_id = 'bdb7a5bf-b1f6-49c1-a924-bc42dfabdba5';

-- Continuity: the two proof-of-concept tasks with the manifest's child counts, plus one kept task.
create table fx_continuity as
  select task_id, idempotency_key, checkpoints, events, handoffs, usage from v54_continuity
  union all
  select '5e0d1c2b-0000-4000-8000-00000000c0de'::uuid, 'kept-continuity-task', 1, 1, 1, 1;
insert into public.continuity_tasks (id, idempotency_key, repository, base_branch, expected_sha, working_branch, owner_provider,
                                     budget_usd, task_envelope, status, stage, lease_token, lease_expires_at)
select c.task_id, c.idempotency_key, 'FahadTrail/fahad-ai-office', 'main', repeat('a', 40), 'continuity/fixture-' || left(c.task_id::text, 8),
       'anthropic', 1, '{}'::jsonb, 'completed', 'completed', gen_random_uuid(), timestamptz '2026-09-22 10:00:00Z'
from fx_continuity as c;
insert into public.continuity_checkpoints (task_id, sequence, stage, owner_provider, expected_sha, repo_state, payload, progress_hash)
select c.task_id, g, 'implement', 'anthropic', repeat('a', 40), '{}'::jsonb, '{}'::jsonb, 'fixture-' || g
from fx_continuity as c cross join lateral generate_series(1, c.checkpoints) as g;
insert into public.continuity_events (task_id, type, message)
select c.task_id, 'progress', 'Fixture event' from fx_continuity as c cross join lateral generate_series(1, c.events);
insert into public.continuity_handoffs (task_id, from_provider, to_provider, checkpoint_id, verification)
select c.task_id, 'anthropic', 'openai',
       (select x.id from public.continuity_checkpoints as x where x.task_id = c.task_id order by x.sequence limit 1), '{}'::jsonb
from fx_continuity as c cross join lateral generate_series(1, c.handoffs);
insert into public.continuity_usage (task_id, provider, model, stage, attempt)
select c.task_id, 'anthropic', 'fixture-model', 'implement', g
from fx_continuity as c cross join lateral generate_series(1, c.usage) as g;

reset search_path;
