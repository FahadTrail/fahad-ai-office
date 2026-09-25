-- ============================================================
-- FAHAD AI OFFICE — CORE SCHEMA
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- 1. AGENTS (the 6 employees) ----------
create table public.agents (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  name          text not null,
  name_ar       text,
  role          text not null,
  tagline       text,
  system_prompt text not null default '',
  model_tier    text not null default 'standard'
                check (model_tier in ('light','standard','deep')),
  allowed_tools text[] not null default '{}',
  desk_x        numeric not null default 0,
  desk_y        numeric not null default 0,
  desk_z        numeric not null default 0,
  accent_color  text not null default '#3B82F6',
  sort_order    int  not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ---------- 2. PROJECTS ----------
create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  status      text not null default 'active'
              check (status in ('active','paused','archived')),
  created_at  timestamptz not null default now()
);

-- ---------- 3. JOBS (one goal from Fahad) ----------
create table public.jobs (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid references public.projects(id) on delete set null,
  title          text,
  goal           text not null,
  status         text not null default 'planning'
                 check (status in ('planning','running','waiting_approval','blocked','review','completed','failed','cancelled')),
  priority       text not null default 'normal'
                 check (priority in ('low','normal','high','urgent')),
  progress       int  not null default 0 check (progress between 0 and 100),
  token_budget   int  not null default 400000,
  tokens_used    int  not null default 0,
  cost_usd       numeric(10,4) not null default 0,
  final_summary  text,
  created_at     timestamptz not null default now(),
  started_at     timestamptz,
  completed_at   timestamptz
);

-- ---------- 4. TASKS (one unit of work for one agent) ----------
create table public.tasks (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.jobs(id) on delete cascade,
  agent_id     uuid not null references public.agents(id),
  title        text not null,
  brief        text not null default '',
  status       text not null default 'queued'
               check (status in ('queued','assigned','running','handoff','review','waiting_approval','blocked','done','failed','skipped')),
  sequence     int  not null default 0,
  depends_on   uuid[] not null default '{}',
  progress     int  not null default 0 check (progress between 0 and 100),
  attempts     int  not null default 0,
  max_attempts int  not null default 3,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  completed_at timestamptz
);

-- ---------- 5. RUNS (one execution attempt) ----------
create table public.runs (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid not null references public.tasks(id) on delete cascade,
  job_id        uuid not null references public.jobs(id) on delete cascade,
  agent_id      uuid not null references public.agents(id),
  attempt_no    int  not null default 1,
  status        text not null default 'running'
                check (status in ('running','succeeded','failed','cancelled','timeout')),
  model         text,
  tokens_in     int not null default 0,
  tokens_out    int not null default 0,
  cost_usd      numeric(10,4) not null default 0,
  error_message text,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz
);

-- ---------- 6. EVENTS (live feed + 3D animation source) ----------
create table public.events (
  id            bigserial primary key,
  job_id        uuid references public.jobs(id) on delete cascade,
  task_id       uuid references public.tasks(id) on delete cascade,
  run_id        uuid references public.runs(id) on delete set null,
  agent_id      uuid references public.agents(id),
  from_agent_id uuid references public.agents(id),
  to_agent_id   uuid references public.agents(id),
  type          text not null
                check (type in (
                  'job_created','plan_created','task_created','agent_assigned',
                  'agent_started','status_changed','progress','activity',
                  'result_produced','handoff','error','retry',
                  'approval_requested','approval_granted','approval_rejected',
                  'job_completed','job_failed'
                )),
  level         text not null default 'info'
                check (level in ('info','success','warning','error')),
  message       text not null,
  payload       jsonb not null default '{}',
  created_at    timestamptz not null default now()
);

-- ---------- 7. HANDOFFS ----------
create table public.handoffs (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references public.jobs(id) on delete cascade,
  from_agent_id uuid references public.agents(id),
  to_agent_id   uuid not null references public.agents(id),
  from_task_id  uuid references public.tasks(id) on delete set null,
  to_task_id    uuid references public.tasks(id) on delete set null,
  summary       text not null default '',
  payload       jsonb not null default '{}',
  created_at    timestamptz not null default now()
);

-- ---------- 8. RESULTS ----------
create table public.results (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references public.jobs(id) on delete cascade,
  task_id    uuid references public.tasks(id) on delete cascade,
  agent_id   uuid references public.agents(id),
  kind       text not null default 'task'
             check (kind in ('task','final')),
  summary    text not null default '',
  content    text not null default '',
  format     text not null default 'markdown'
             check (format in ('markdown','json','html','text')),
  created_at timestamptz not null default now()
);

-- ---------- 9. MEMORY (shared knowledge) ----------
create table public.memory (
  id            uuid primary key default gen_random_uuid(),
  scope         text not null default 'global'
                check (scope in ('global','project','agent','job')),
  scope_ref     uuid,
  key           text not null,
  content       text not null,
  tags          text[] not null default '{}',
  source_job_id uuid references public.jobs(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------- 10. FILES ----------
create table public.files (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid references public.jobs(id) on delete cascade,
  task_id      uuid references public.tasks(id) on delete set null,
  agent_id     uuid references public.agents(id),
  name         text not null,
  storage_path text not null,
  mime_type    text,
  size_bytes   bigint,
  created_at   timestamptz not null default now()
);

-- ---------- 11. APPROVALS (human gate) ----------
create table public.approvals (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.jobs(id) on delete cascade,
  task_id      uuid references public.tasks(id) on delete cascade,
  agent_id     uuid references public.agents(id),
  action_type  text not null
               check (action_type in ('payment','publish','external_message','delete_production','new_credential','irreversible','other')),
  title        text not null,
  description  text not null default '',
  risk         text not null default 'medium'
               check (risk in ('low','medium','high')),
  payload      jsonb not null default '{}',
  status       text not null default 'pending'
               check (status in ('pending','approved','rejected','expired')),
  decided_at   timestamptz,
  decided_note text,
  created_at   timestamptz not null default now()
);
