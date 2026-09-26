-- Behavioral checks for Workspace V2 (conversations, owner replies). Runs
-- inside a rolled-back transaction against a local replay; never production.
do $$
declare
  v_workspace uuid;
  v_session public.agent_sessions%rowtype;
  v_claim public.agent_sessions%rowtype;
  v_input public.agent_owner_inputs%rowtype;
  v_conversation uuid;
  v_failed boolean := false;
  v_count integer;
begin
  insert into public.projects(name) values ('Fahad AI Office') returning id into v_workspace;
  insert into public.workspace_policies (workspace_id, enabled, monthly_budget_usd, max_request_budget_usd, budget_period_start, budget_period_end)
    values (v_workspace, true, 10, 1, now() - interval '1 day', now() + interval '1 day');

  -- Conversations own chat jobs; deleting one keeps the jobs.
  insert into public.conversations (project_id, title) values (v_workspace, 'Plan the launch') returning id into v_conversation;
  insert into public.jobs (project_id, goal, conversation_id) values (v_workspace, 'first message', v_conversation);
  delete from public.conversations where id = v_conversation;
  assert (select count(*) from public.jobs where goal = 'first message' and conversation_id is null) = 1, 'jobs survive a deleted conversation';

  -- A reply to a blocked session re-queues the SAME session.
  select * into v_session from public.create_coding_session(v_workspace, 'Fix a bug', 'Fix the failing parser test and open a PR', 'FahadTrail/fahad-ai-office');
  select * into v_claim from public.claim_agent_session('worker-a', 60);
  update public.agent_sessions set status = 'blocked', blocker = 'Agent needs the owner: which file?', error_code = 'HUMAN_INPUT_REQUIRED',
    lease_owner = null, lease_token = null, lease_expires_at = null where id = v_session.id;
  select * into v_input from public.reply_agent_session(v_session.id, '  Use src/parser.js  ', 'owner@example.com');
  assert v_input.message = 'Use src/parser.js', 'reply is trimmed and stored';
  assert (select status from public.agent_sessions where id = v_session.id) = 'queued', 'blocked session is re-queued';
  assert (select blocker from public.agent_sessions where id = v_session.id) is null, 'blocker cleared';
  assert exists (select 1 from public.agent_events where session_id = v_session.id and type = 'owner'), 'owner event recorded';

  -- Only the lease holder consumes replies, exactly once.
  select * into v_claim from public.claim_agent_session('worker-b', 60);
  assert v_claim.id = v_session.id, 'the same session is resumed';
  begin
    perform public.consume_agent_owner_inputs(v_session.id, gen_random_uuid());
  exception when others then
    v_failed := sqlerrm = 'AGENT_LEASE_LOST';
  end;
  assert v_failed, 'a stale lease cannot consume replies';
  select count(*) into v_count from public.consume_agent_owner_inputs(v_session.id, v_claim.lease_token);
  assert v_count = 1, 'the pending reply is consumed';
  select count(*) into v_count from public.consume_agent_owner_inputs(v_session.id, v_claim.lease_token);
  assert v_count = 0, 'a reply is consumed exactly once';

  -- Closed sessions refuse replies; empty replies are refused.
  v_failed := false;
  begin
    perform public.reply_agent_session(v_session.id, '   ');
  exception when others then
    v_failed := sqlerrm = 'AGENT_REPLY_INVALID';
  end;
  assert v_failed, 'empty reply refused';
  update public.agent_sessions set status = 'completed' where id = v_session.id;
  v_failed := false;
  begin
    perform public.reply_agent_session(v_session.id, 'late');
  exception when others then
    v_failed := sqlerrm = 'AGENT_SESSION_CLOSED';
  end;
  assert v_failed, 'closed sessions refuse replies';

  -- Project memory rejects empty content; the Fahad AI Office default repo is set by the migration only for existing rows.
  v_failed := false;
  begin
    insert into public.project_memory (project_id, content) values (v_workspace, '  ');
  exception when check_violation then
    v_failed := true;
  end;
  assert v_failed, 'empty memory refused';
end;
$$;
