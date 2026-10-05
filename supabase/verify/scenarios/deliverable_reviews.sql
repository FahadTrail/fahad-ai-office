-- Behavioral checks for the V5.3 deliverable reviews (owner curation). Runs
-- inside a rolled-back transaction against a local replay; never production.
do $$
declare
  v_project uuid;
  v_key text := 'task:' || gen_random_uuid();
  v_failed boolean;
begin
  insert into public.projects(name) values ('Deliverables scenario') returning id into v_project;

  -- Pin and archive need no decision; one row per project and chain.
  insert into public.deliverable_reviews (project_id, deliverable_key, pinned) values (v_project, v_key, true);
  assert (select pinned and not archived from public.deliverable_reviews where project_id = v_project and deliverable_key = v_key), 'pinned row stored';
  v_failed := false;
  begin
    insert into public.deliverable_reviews (project_id, deliverable_key) values (v_project, v_key);
  exception when unique_violation then v_failed := true;
  end;
  assert v_failed, 'one row per project and deliverable chain';

  -- A decision always names its exact version and time.
  update public.deliverable_reviews set decision = 'approved', decision_key = v_key, decided_at = now(), decided_by = 'owner@example.com'
    where project_id = v_project and deliverable_key = v_key;
  assert (select decision from public.deliverable_reviews where deliverable_key = v_key) = 'approved', 'decision stored';
  v_failed := false;
  begin
    update public.deliverable_reviews set decision_key = null where deliverable_key = v_key;
  exception when check_violation then v_failed := true;
  end;
  assert v_failed, 'a decision without its version is refused';
  v_failed := false;
  begin
    update public.deliverable_reviews set decision = 'merged' where deliverable_key = v_key;
  exception when check_violation then v_failed := true;
  end;
  assert v_failed, 'unknown decisions are refused';
  v_failed := false;
  begin
    insert into public.deliverable_reviews (project_id, deliverable_key) values (v_project, 'task:../../etc/passwd');
  exception when check_violation then v_failed := true;
  end;
  assert v_failed, 'keys are task/session/artifact UUIDs only';

  -- Service role only, RLS on.
  assert (select relrowsecurity from pg_class where oid = 'public.deliverable_reviews'::regclass), 'RLS enabled';
  assert not has_table_privilege('anon', 'public.deliverable_reviews', 'select'), 'anon cannot read';
  assert not has_table_privilege('authenticated', 'public.deliverable_reviews', 'select'), 'authenticated cannot read';
  assert has_table_privilege('service_role', 'public.deliverable_reviews', 'insert'), 'service role writes';

  -- Removing a project removes its curation.
  delete from public.projects where id = v_project;
  assert not exists (select 1 from public.deliverable_reviews where project_id = v_project), 'cascade on project delete';
end $$;
