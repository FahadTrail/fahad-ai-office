-- Platform foundation: current work and project history stay bounded as a
-- project accumulates terminal objectives. Additive indexes only. No data
-- change, no privilege change.

create index jobs_project_current_idx
  on public.jobs (project_id, created_at desc)
  where status in ('planning', 'running', 'waiting_approval', 'blocked', 'review');

create index jobs_project_history_idx
  on public.jobs (project_id, completed_at desc, created_at desc)
  where status in ('completed', 'failed', 'cancelled');
