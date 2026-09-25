-- ============================================================
-- REALTIME — powers the Live Feed, task board and the future 3D office
-- ============================================================

alter publication supabase_realtime add table public.events;
alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.jobs;
alter publication supabase_realtime add table public.approvals;
alter publication supabase_realtime add table public.handoffs;

-- Send the full row on update/delete so the UI can animate transitions
alter table public.events    replica identity full;
alter table public.tasks     replica identity full;
alter table public.jobs      replica identity full;
alter table public.approvals replica identity full;
alter table public.handoffs  replica identity full;
