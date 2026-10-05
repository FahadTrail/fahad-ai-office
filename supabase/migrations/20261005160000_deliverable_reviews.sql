-- V5.3 Project Deliverables Center: Fahad's curation of project deliverables.
--
-- Additive and isolated. Deliverables themselves are derived by the Hub from
-- existing rows (results, artifacts, agent_sessions); this table only keeps
-- the owner's marks on them: pinned, archived, and his latest decision on one
-- exact version (approved / revision requested). One row per project and
-- deliverable chain (the first version's key). No Office engine reads or
-- writes it, so execution is unchanged. Service role only; RLS on.

create table public.deliverable_reviews (
  project_id uuid not null references public.projects(id) on delete cascade,
  deliverable_key text not null
    check (deliverable_key ~ '^(task|session|artifact):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  pinned boolean not null default false,
  archived boolean not null default false,
  decision text check (decision in ('approved', 'revision_requested')),
  decision_key text
    check (decision_key ~ '^(task|session|artifact):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  decision_note text check (decision_note is null or char_length(decision_note) <= 2000),
  decided_by text check (decided_by is null or char_length(decided_by) <= 320),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, deliverable_key),
  constraint deliverable_reviews_decision_complete
    check ((decision is null) = (decision_key is null) and (decision is null) = (decided_at is null))
);

alter table public.deliverable_reviews enable row level security;
revoke all on table public.deliverable_reviews from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.deliverable_reviews to service_role;

comment on table public.deliverable_reviews is
  'V5.3 owner curation of project deliverables (pin, archive, approve, revision requested). Written by the Hub only; never read by the Office engines.';
