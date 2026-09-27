-- Behavioral checks for waiting on free model capacity. Runs inside a
-- rolled-back transaction against a local replay; never production.
do $$
declare
  v_job uuid;
  v_first uuid;
  v_second uuid;
  v_claim jsonb;
  v_result jsonb;
begin
  insert into public.jobs (title, goal, status) values ('Capacity', 'wait for capacity', 'running') returning id into v_job;
  v_first := public.create_task(v_job, 'research-strategy', 'Research', '{}', 1, '{}', 3);
  v_second := public.create_task(v_job, 'chief-of-staff', 'Synthesis', '{}', 2, array[v_first], 3);

  -- Completed work stays completed while a later task waits.
  v_claim := public.claim_next_task();
  assert (v_claim->>'task_id')::uuid = v_first, 'first task claimed';
  perform public.complete_task(v_first, (v_claim->>'run_id')::uuid, 'done', 'research output');
  v_claim := public.claim_next_task();
  assert (v_claim->>'task_id')::uuid = v_second, 'second task claimed';

  v_result := public.defer_task(v_second, (v_claim->>'run_id')::uuid, now() + interval '10 minutes',
    '{"reason":"NO_FREE_CAPACITY","routes":["openrouter:x:free"]}'::jsonb, 3);
  assert (v_result->>'waiting')::boolean, 'task deferred';
  assert (select status from public.tasks where id = v_second) = 'queued', 'waiting task is queued';
  assert (select max_attempts from public.tasks where id = v_second) = 4, 'waiting does not consume a retry';
  assert (select status from public.runs where id = (v_claim->>'run_id')::uuid) = 'cancelled', 'open run closed';
  assert (select error_message from public.runs where id = (v_claim->>'run_id')::uuid) = 'WAITING_FOR_CAPACITY', 'run explains why';
  assert (select status from public.jobs where id = v_job) = 'running', 'the job keeps running';
  assert (select count(*) from public.results where task_id = v_first) = 1, 'completed result preserved';
  assert public.claim_next_task() is null, 'not claimable before its recovery time';
  assert exists (select 1 from public.events where task_id = v_second and payload->>'status' = 'WAITING_FOR_CAPACITY'), 'waiting event recorded';

  -- Once the recovery time has passed it is claimed again with its upstream.
  update public.tasks set not_before = now() - interval '1 second' where id = v_second;
  v_claim := public.claim_next_task();
  assert (v_claim->>'task_id')::uuid = v_second, 'resumed after recovery time';
  assert (v_claim->'upstream'->0->>'content') = 'research output', 'upstream output handed over again';
  assert (v_claim->>'wait_count')::int = 1, 'wait count carried';
  assert (select not_before from public.tasks where id = v_second) is null, 'wait cleared on claim';

  -- Waits are bounded: after the limit the caller must fail the task.
  update public.tasks set wait_count = 3 where id = v_second;
  v_result := public.defer_task(v_second, (v_claim->>'run_id')::uuid, now() + interval '10 minutes', '{}'::jsonb, 3);
  assert (v_result->>'exhausted')::boolean, 'wait limit reported';
  assert (select status from public.tasks where id = v_second) = 'running', 'exhausted wait leaves the task to the caller';

  -- The recovery time is clamped to [30 s, 24 h].
  update public.tasks set wait_count = 0 where id = v_second;
  v_result := public.defer_task(v_second, (v_claim->>'run_id')::uuid, now() + interval '5 days', '{}'::jsonb, 3);
  assert (select not_before from public.tasks where id = v_second) <= now() + interval '24 hours', 'wait capped at 24 h';

  -- Invalid info is refused; only service_role may call it.
  begin
    perform public.defer_task(v_second, gen_random_uuid(), now(), '[]'::jsonb, 3);
    assert false, 'array info must be refused';
  exception when others then
    assert sqlerrm = 'DEFER_INFO_INVALID', 'info must be an object';
  end;
  assert not has_function_privilege('anon', 'public.defer_task(uuid,uuid,timestamptz,jsonb,integer)', 'execute'), 'anon cannot defer';
  assert not has_function_privilege('authenticated', 'public.defer_task(uuid,uuid,timestamptz,jsonb,integer)', 'execute'), 'authenticated cannot defer';
end;
$$;
