-- Indexes for the queries the runtime and UI run constantly

create index idx_tasks_job        on public.tasks(job_id);
create index idx_tasks_status     on public.tasks(status);
create index idx_tasks_agent      on public.tasks(agent_id);
create index idx_tasks_ready      on public.tasks(job_id, status, sequence);

create index idx_runs_task        on public.runs(task_id);
create index idx_runs_job         on public.runs(job_id);

create index idx_events_job_time  on public.events(job_id, created_at desc);
create index idx_events_id_desc   on public.events(id desc);
create index idx_events_type      on public.events(type);
create index idx_events_agent     on public.events(agent_id);

create index idx_handoffs_job     on public.handoffs(job_id, created_at desc);

create index idx_results_job      on public.results(job_id);
create index idx_results_task     on public.results(task_id);

create index idx_memory_scope     on public.memory(scope, scope_ref);
create index idx_memory_key       on public.memory(key);

create index idx_files_job        on public.files(job_id);

create index idx_approvals_status on public.approvals(status, created_at desc);
create index idx_approvals_job    on public.approvals(job_id);

create index idx_jobs_status      on public.jobs(status, created_at desc);
