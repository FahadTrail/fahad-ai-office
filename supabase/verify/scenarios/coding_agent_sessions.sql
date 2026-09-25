-- Behavioral checks for the Coding Agent state functions. Runs inside a
-- rolled-back transaction against a local replay; never against production.
do $$
declare
  v_workspace uuid;
  v_session public.agent_sessions%rowtype;
  v_claim public.agent_sessions%rowtype;
  v_token uuid;
  v_seq integer;
  v_approval uuid;
  v_ok boolean;
  v_failed boolean := false;
begin
  insert into public.projects(name) values ('Fahad AI Office') returning id into v_workspace;
  insert into public.workspace_policies (workspace_id, enabled, monthly_budget_usd, max_request_budget_usd, budget_period_start, budget_period_end)
    values (v_workspace, true, 10, 1, now() - interval '1 day', now() + interval '1 day');

  select * into v_session from public.create_coding_session(v_workspace, 'Fix a bug', 'Fix the failing parser test and open a PR', 'FahadTrail/fahad-ai-office');
  assert v_session.status = 'queued', 'session starts queued';
  assert (select status from public.jobs where id = v_session.job_id) = 'running', 'coding job is not claimable by the Office queue';
  assert (select status from public.tasks where id = v_session.task_id) = 'assigned', 'coding task is invisible to claim_next_task';
  assert public.claim_next_job() is null or (public.claim_next_job()).id is null, 'Office claim_next_job ignores coding jobs';
  perform public.assert_workspace_execution_context(v_workspace, v_session.job_id, v_session.task_id, v_session.run_id);

  select * into v_claim from public.claim_agent_session('worker-a', 60);
  assert v_claim.id = v_session.id and v_claim.status = 'running', 'worker claims the queued session';
  v_token := v_claim.lease_token;
  assert (select count(*) from public.claim_agent_session('worker-b', 60)) = 0, 'a leased session cannot be claimed twice';

  v_seq := public.save_agent_checkpoint(v_session.id, v_token, 'turn',
    jsonb_build_object('phase', 'implement', 'iteration', 3, 'current_route', 'anthropic:claude-opus-5',
      'state', jsonb_build_object('files_changed', jsonb_build_array('src/a.js'))),
    jsonb_build_object('messages', jsonb_build_array()), null);
  assert v_seq = 1, 'first checkpoint sequence';
  assert (select phase from public.agent_sessions where id = v_session.id) = 'implement', 'patch applied';

  begin
    perform public.save_agent_checkpoint(v_session.id, gen_random_uuid(), 'turn', '{}'::jsonb, null, null);
  exception when others then
    v_failed := sqlerrm = 'AGENT_LEASE_LOST';
  end;
  assert v_failed, 'a stale lease holder cannot write state';

  -- An expired lease is reclaimable and invalidates the old token.
  update public.agent_sessions set lease_expires_at = now() - interval '1 second' where id = v_session.id;
  select * into v_claim from public.claim_agent_session('worker-b', 60);
  assert v_claim.id = v_session.id and v_claim.lease_token <> v_token, 'expired lease reclaimed with a new token';
  v_failed := false;
  begin
    perform public.save_agent_checkpoint(v_session.id, v_token, 'turn', '{}'::jsonb, null, null);
  exception when others then v_failed := true;
  end;
  assert v_failed, 'the previous worker is fenced off after reclaim';
  v_token := v_claim.lease_token;

  select ok into v_ok from public.renew_agent_session_lease(v_session.id, v_token, 120);
  assert v_ok, 'lease renewal';

  v_approval := public.request_agent_approval(v_session.id, v_token, 'call-1', 'coding', 'github.pr_merge', 'merge', 'medium',
    'Merge PR #1', repeat('a', 64), '{"pr": 1}'::jsonb);
  assert v_approval = public.request_agent_approval(v_session.id, v_token, 'call-1', 'coding', 'github.pr_merge', 'merge', 'medium',
    'Merge PR #1', repeat('a', 64), '{"pr": 1}'::jsonb), 'approval requests are idempotent per call';
  perform public.finish_agent_session(v_session.id, v_token, 'awaiting_approval', null, 'Merge requires approval', null);
  assert (select status from public.jobs where id = v_session.job_id) = 'waiting_approval', 'job mirrors approval wait';
  assert not public.consume_agent_approval(v_approval, v_session.id, 'call-1', 'github.pr_merge', repeat('a', 64)), 'pending approval cannot be consumed';
  perform public.decide_agent_approval(v_approval, 'approved', 'owner@example.com', null);
  assert (select status from public.agent_sessions where id = v_session.id) = 'queued', 'approval re-queues the session';
  assert not public.consume_agent_approval(v_approval, v_session.id, 'call-1', 'github.pr_merge', repeat('b', 64)), 'approval is bound to the exact arguments';
  assert not public.consume_agent_approval(v_approval, v_session.id, 'call-1', 'supabase.migration_apply', repeat('a', 64)), 'approval is bound to the approved tool';
  assert public.consume_agent_approval(v_approval, v_session.id, 'call-1', 'github.pr_merge', repeat('a', 64)), 'approved request consumed';
  assert not public.consume_agent_approval(v_approval, v_session.id, 'call-1', 'github.pr_merge', repeat('a', 64)), 'approval is single use';

  select * into v_claim from public.claim_agent_session('worker-c', 60);
  perform public.finish_agent_session(v_claim.id, v_claim.lease_token, 'completed',
    jsonb_build_object('summary', 'Done', 'report', '# Report'), null, null);
  assert (select status from public.jobs where id = v_session.job_id) = 'completed', 'job completes with the session';
  assert (select status from public.runs where id = v_session.run_id) = 'succeeded', 'run succeeds';
  assert (select count(*) from public.results where job_id = v_session.job_id and kind = 'final') = 1, 'final result stored';

  perform public.record_provider_outcome('anthropic', 'claude-opus-5', 'paid', false, 'rate_limited', now() + interval '10 minutes',
    'PROVIDER_RATE_LIMIT', '{"requestsRemaining": 0}'::jsonb, 0, 0, 0);
  perform public.record_provider_outcome('anthropic', 'claude-opus-5', 'paid', true, 'healthy', null, null, null, 100, 10, 0.01);
  assert (select requests_total = 1 and failures_total = 1 and consecutive_failures = 0 and health = 'healthy'
    from public.provider_status where provider = 'anthropic'), 'provider outcomes accumulate';
end;
$$;

-- Client roles have no access to agent state.
set local role anon;
do $$
begin
  begin
    perform 1 from public.agent_sessions;
    raise exception 'anon could read agent_sessions';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.claim_agent_session('x', 60);
    raise exception 'anon could claim sessions';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
