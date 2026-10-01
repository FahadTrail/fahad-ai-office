-- Behavioral checks for the Coding Continuity Supervisor (Phase A). Runs
-- inside a rolled-back transaction against a local replay; never production.
do $$
declare
  v_a uuid;
  v_b uuid;
  v_lease public.coding_leases%rowtype;
  v_lease_b public.coding_leases%rowtype;
  v_cp public.coding_checkpoints%rowtype;
  v_cp2 public.coding_checkpoints%rowtype;
  v_handoff public.coding_handoffs%rowtype;
  v_payload jsonb;
  v_failed boolean;
begin
  assert (select count(*) from public.coding_workers) = 7, 'seven permanent workers';
  assert (select array_agg(key order by key) from public.coding_workers where enabled) = array['office'], 'only office starts enabled';
  assert (select quota_source from public.coding_workers where key = 'codex') = 'openai-chatgpt', 'codex quota source';
  assert (select quota_source from public.coding_workers where key = 'antigravity') = 'google-ai-pro', 'antigravity is not Gemini API';

  insert into public.coding_worker_sessions (worker_key, repository, branch, objective)
    values ('office', 'FahadTrail/fahad-ai-office', 'codex/continuity-phase-a', 'Phase A') returning id into v_a;
  insert into public.coding_worker_sessions (worker_key, repository, branch, objective)
    values ('codex', 'FahadTrail/fahad-ai-office', 'codex/continuity-phase-a', 'Phase A') returning id into v_b;

  -- Acquire; a second writer on the same branch fails.
  select * into v_lease from public.acquire_coding_lease(v_a, 300);
  assert v_lease.status = 'ACTIVE', 'lease acquired';
  assert (select status from public.coding_worker_sessions where id = v_a) = 'ACTIVE', 'session active';
  v_failed := false;
  begin
    perform public.acquire_coding_lease(v_b, 300);
  exception when others then
    v_failed := sqlerrm = 'CODING_LEASE_HELD';
  end;
  assert v_failed, 'second acquire on the same branch fails';

  -- Heartbeat is token guarded.
  assert not public.heartbeat_coding_lease(v_lease.id, gen_random_uuid(), 300), 'wrong token heartbeat fails';
  assert public.heartbeat_coding_lease(v_lease.id, v_lease.token, 300), 'valid heartbeat works';

  -- Release without a checkpoint fails.
  v_failed := false;
  begin
    perform public.release_coding_lease(v_lease.id, v_lease.token, null);
  exception when others then
    v_failed := sqlerrm = 'CODING_LEASE_CHECKPOINT_REQUIRED';
  end;
  assert v_failed, 'release without checkpoint fails';

  -- Checkpoints: token guarded, schema checked, secrets refused, sequenced.
  v_payload := jsonb_build_object(
    'schema', 'continuity.checkpoint.v1', 'repository', 'FahadTrail/fahad-ai-office', 'branch', 'codex/continuity-phase-a',
    'status', 'ACTIVE', 'last_commit', repeat('a', 40), 'next_exact_action', 'Write the migration tests.');
  v_failed := false;
  begin
    perform public.save_continuity_checkpoint(v_lease.id, gen_random_uuid(), v_payload);
  exception when others then
    v_failed := sqlerrm = 'CODING_LEASE_INVALID';
  end;
  assert v_failed, 'checkpoint with a wrong token fails';
  v_failed := false;
  begin
    perform public.save_continuity_checkpoint(v_lease.id, v_lease.token, v_payload || '{"schema":"v0"}');
  exception when others then
    v_failed := sqlerrm = 'CHECKPOINT_SCHEMA_INVALID';
  end;
  assert v_failed, 'wrong schema refused';
  v_failed := false;
  begin
    perform public.save_continuity_checkpoint(v_lease.id, v_lease.token, v_payload || jsonb_build_object('errors', jsonb_build_array('ghp_' || repeat('x', 30))));
  exception when others then
    v_failed := sqlerrm = 'CHECKPOINT_SECRET_MATERIAL';
  end;
  assert v_failed, 'secret material refused';
  v_failed := false;
  begin
    perform public.save_continuity_checkpoint(v_lease.id, v_lease.token, v_payload || '{"next_exact_action":"  "}');
  exception when check_violation then
    v_failed := true;
  end;
  assert v_failed, 'empty next action refused';
  v_failed := false;
  begin
    perform public.save_continuity_checkpoint(v_lease.id, v_lease.token, v_payload || '{"last_commit":"abc123"}');
  exception when check_violation then
    v_failed := true;
  end;
  assert v_failed, 'short commit refused';
  v_cp := public.save_continuity_checkpoint(v_lease.id, v_lease.token, v_payload);
  v_cp2 := public.save_continuity_checkpoint(v_lease.id, v_lease.token, v_payload || '{"status":"HANDOFF_READY"}');
  assert v_cp.sequence = 1 and v_cp2.sequence = 2, 'checkpoints are sequenced';
  assert (select checkpoint_id from public.coding_leases where id = v_lease.id) = v_cp2.id, 'lease points at the latest checkpoint';

  -- Handoff cannot be accepted while the branch is still leased.
  v_handoff := public.propose_handoff(v_a, v_cp2.id, 'quota draining', 'Continue Phase A.', 'codex');
  assert v_handoff.status = 'PROPOSED' and v_handoff.from_worker = 'office', 'handoff proposed';
  v_failed := false;
  begin
    perform public.propose_handoff(v_a, v_cp2.id, 'again', 'packet');
  exception when others then
    v_failed := sqlerrm = 'HANDOFF_ALREADY_PROPOSED';
  end;
  assert v_failed, 'one open handoff per session';
  v_failed := false;
  begin
    perform public.accept_handoff(v_handoff.id, v_b);
  exception when others then
    v_failed := sqlerrm = 'HANDOFF_BRANCH_STILL_LEASED';
  end;
  assert v_failed, 'accept waits for the release';

  -- Release with a checkpoint, then the receiver accepts and acquires.
  assert public.release_coding_lease(v_lease.id, v_lease.token, v_cp2.id, 'HANDOFF_READY'), 'release with checkpoint works';
  assert (select status from public.coding_worker_sessions where id = v_a) = 'HANDOFF_READY', 'session handoff ready';
  assert not public.heartbeat_coding_lease(v_lease.id, v_lease.token, 300), 'released lease cannot heartbeat';
  v_handoff := public.accept_handoff(v_handoff.id, v_b);
  assert v_handoff.status = 'ACCEPTED' and v_handoff.to_session_id = v_b and v_handoff.accepted_at is not null, 'handoff accepted';
  select * into v_lease_b from public.acquire_coding_lease(v_b, 300);
  assert v_lease_b.worker_key = 'codex', 'next worker holds the branch';

  -- A stale lease is frozen (session ABNORMAL_EXIT), blocks the branch, then is reclaimed.
  update public.coding_leases set expires_at = now() - interval '6 minutes' where id = v_lease_b.id;
  assert not public.heartbeat_coding_lease(v_lease_b.id, v_lease_b.token, 300), 'expired lease cannot heartbeat';
  assert (select count(*) from public.freeze_stale_coding_leases()) = 1, 'one stale lease frozen';
  assert (select status from public.coding_leases where id = v_lease_b.id) = 'FROZEN', 'lease frozen';
  assert (select status from public.coding_worker_sessions where id = v_b) = 'ABNORMAL_EXIT', 'session abnormal exit';
  v_failed := false;
  begin
    perform public.acquire_coding_lease(v_a, 300);
  exception when others then
    v_failed := sqlerrm in ('CODING_LEASE_HELD', 'CODING_SESSION_NOT_FOUND');
  end;
  assert v_failed, 'frozen lease still blocks the branch';
  assert public.reclaim_coding_lease(v_lease_b.id), 'frozen lease reclaimed';
  assert not public.reclaim_coding_lease(v_lease_b.id), 'reclaim is one-shot';
  insert into public.coding_worker_sessions (worker_key, repository, branch, objective)
    values ('claude-code', 'FahadTrail/fahad-ai-office', 'codex/continuity-phase-a', 'Recover Phase A') returning id into v_a;
  assert (select count(*) from public.acquire_coding_lease(v_a, 300)) = 1, 'branch free after reclaim';
end;
$$;
