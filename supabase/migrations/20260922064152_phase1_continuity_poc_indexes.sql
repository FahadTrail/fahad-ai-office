create index if not exists continuity_events_task_id_idx on public.continuity_events(task_id);
create index if not exists continuity_usage_task_id_idx on public.continuity_usage(task_id);
create index if not exists continuity_handoffs_checkpoint_id_idx on public.continuity_handoffs(checkpoint_id);