-- Fahad AI Office — UX & Workflow V2.
--
-- Additive only: no existing row, column or function is removed or changed in
-- a way that alters current behaviour.
--   * conversations: multi-turn chat threads; each user message is a job.
--     Existing chat jobs are backfilled as one-message conversations so the
--     current history stays visible.
--   * projects gain working context (description already exists; a default
--     repository) and project_memory (facts/decisions the Chief reuses).
--   * agent_sessions can belong to a conversation (a task launched from chat).
--   * agent_owner_inputs: the owner's reply to a blocked Coding Agent session;
--     the SAME session resumes and receives it as an owner message.
--   * agent_events accept the 'owner' type (owner replies in the timeline).
-- Every new object is service-role only with RLS enabled.

-- ---------------------------------------------------------------- conversations
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null default 'New chat' check (char_length(title) between 1 and 200),
  title_source text not null default 'auto' check (title_source in ('auto', 'owner')),
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create index conversations_project_idx on public.conversations (project_id, archived, last_message_at desc);

alter table public.jobs
  add column conversation_id uuid references public.conversations(id) on delete set null;
create index jobs_conversation_idx on public.jobs (conversation_id, created_at) where conversation_id is not null;

alter table public.agent_sessions
  add column conversation_id uuid references public.conversations(id) on delete set null;
create index agent_sessions_conversation_idx on public.agent_sessions (conversation_id) where conversation_id is not null;

-- Backfill: every existing Office chat job (not a Coding Agent session job)
-- becomes a one-message conversation, keeping its original timestamps.
with chat_jobs as (
  select j.id, j.project_id, coalesce(nullif(btrim(j.title), ''), left(btrim(j.goal), 120)) as title, j.created_at
  from public.jobs j
  where j.project_id is not null
    and j.conversation_id is null
    and not exists (select 1 from public.agent_sessions s where s.job_id = j.id)
), inserted as (
  insert into public.conversations (project_id, title, title_source, created_at, updated_at, last_message_at)
  select c.project_id, left(coalesce(nullif(c.title, ''), 'Conversation'), 200), 'auto', c.created_at, c.created_at, c.created_at
  from chat_jobs c
  order by c.created_at
  returning id, project_id, created_at, title
)
update public.jobs j
set conversation_id = i.id
from inserted i, chat_jobs c
where c.id = j.id and i.project_id = c.project_id and i.created_at = c.created_at
  and i.title = left(coalesce(nullif(c.title, ''), 'Conversation'), 200)
  and j.conversation_id is null;

-- ---------------------------------------------------------------- project context
alter table public.projects
  add column default_repository text
  check (default_repository is null or default_repository ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$');

update public.projects set default_repository = 'FahadTrail/fahad-ai-office'
where name = 'Fahad AI Office' and default_repository is null;

create table public.project_memory (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  kind text not null default 'fact' check (kind in ('fact', 'decision', 'preference')),
  content text not null check (char_length(btrim(content)) between 3 and 2000),
  source text not null default 'owner' check (source in ('owner', 'office')),
  created_at timestamptz not null default now()
);

create index project_memory_project_idx on public.project_memory (project_id, created_at desc);

-- ---------------------------------------------------------------- owner replies
create table public.agent_owner_inputs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.agent_sessions(id) on delete cascade,
  message text not null check (char_length(btrim(message)) between 1 and 8000),
  created_by text check (created_by is null or char_length(created_by) <= 320),
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);

create index agent_owner_inputs_pending_idx on public.agent_owner_inputs (session_id, created_at) where consumed_at is null;

alter table public.agent_events drop constraint agent_events_type_check;
alter table public.agent_events add constraint agent_events_type_check check (type in (
  'session', 'phase', 'plan', 'model_turn', 'provider_switch', 'checkpoint', 'tool_call', 'tool_result',
  'test', 'git', 'github', 'ci', 'deploy', 'verify', 'supabase', 'approval', 'guard', 'error', 'report', 'note', 'owner'
));

-- The owner answers a session that is waiting for input. The reply is stored
-- for the controller (it is appended to the same transcript as an owner
-- message) and a blocked session is re-queued so a worker resumes it from its
-- latest checkpoint. Replies to running sessions are delivered on the next turn.
create function public.reply_agent_session(p_session uuid, p_message text, p_created_by text default null)
returns public.agent_owner_inputs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_session public.agent_sessions%rowtype;
  v_input public.agent_owner_inputs%rowtype;
begin
  if p_message is null or char_length(btrim(p_message)) not between 1 and 8000 then
    raise exception 'AGENT_REPLY_INVALID' using errcode = '22023';
  end if;
  select * into v_session from public.agent_sessions s where s.id = p_session for update;
  if not found then
    raise exception 'AGENT_SESSION_NOT_FOUND' using errcode = '42704';
  end if;
  if v_session.status in ('completed', 'failed', 'cancelled') or v_session.cancel_requested then
    raise exception 'AGENT_SESSION_CLOSED' using errcode = '42501';
  end if;
  insert into public.agent_owner_inputs (session_id, message, created_by)
    values (p_session, btrim(p_message), left(p_created_by, 320))
    returning * into v_input;
  insert into public.agent_events (session_id, type, level, message, payload)
    values (p_session, 'owner', 'info', left('Fahad replied: ' || btrim(p_message), 2000),
      jsonb_build_object('input_id', v_input.id));
  if v_session.status = 'blocked' then
    update public.agent_sessions s set status = 'queued', blocker = null, error_code = null, updated_at = now()
      where s.id = p_session;
    update public.jobs j set status = 'running' where j.id = v_session.job_id and j.status in ('blocked', 'waiting_approval');
  end if;
  return v_input;
end;
$$;

-- The controller takes the pending replies exactly once.
create function public.consume_agent_owner_inputs(p_session uuid, p_token uuid)
returns setof public.agent_owner_inputs
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (select 1 from public.agent_sessions s where s.id = p_session and s.lease_token = p_token) then
    raise exception 'AGENT_LEASE_LOST' using errcode = '42501';
  end if;
  return query
    update public.agent_owner_inputs i set consumed_at = now()
    where i.session_id = p_session and i.consumed_at is null
    returning i.*;
end;
$$;

-- ---------------------------------------------------------------- grants
do $$
declare v_table text;
begin
  foreach v_table in array array['conversations', 'project_memory', 'agent_owner_inputs'] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', v_table);
  end loop;
end;
$$;
grant select, insert, update, delete on table public.conversations to service_role;
grant select, insert, update, delete on table public.project_memory to service_role;
grant select, insert, update on table public.agent_owner_inputs to service_role;

revoke all on function public.reply_agent_session(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.reply_agent_session(uuid, text, text) to service_role;
revoke all on function public.consume_agent_owner_inputs(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.consume_agent_owner_inputs(uuid, uuid) to service_role;

comment on table public.conversations is 'Hub chat threads. Each owner message is a job (jobs.conversation_id).';
comment on table public.project_memory is 'Owner-curated project facts, decisions and preferences the Chief reuses.';
comment on table public.agent_owner_inputs is 'Owner replies to a Coding Agent session; consumed once by the controller.';
