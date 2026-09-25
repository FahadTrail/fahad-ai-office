-- now() is frozen for a whole transaction; clock_timestamp() is the real
-- wall-clock moment each row is written. The Live Feed and 3D handoff
-- animations need true ordering.
alter table public.handoffs alter column created_at set default clock_timestamp();
alter table public.events   alter column created_at set default clock_timestamp();
alter table public.results  alter column created_at set default clock_timestamp();
alter table public.runs     alter column started_at set default clock_timestamp();
