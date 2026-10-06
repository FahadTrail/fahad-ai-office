-- Behavioral checks for creating a project from the Hub (create_hub_project).
-- Runs inside a rolled-back transaction against a local replay; never
-- production. The V5.4 certification found that every call failed with
-- "column reference name is ambiguous" and that new projects never received
-- the template's free routes.
do $$
declare
  v_template uuid;
  v_project record;
  v_failed boolean;
begin
  insert into public.projects(name) values ('Fahad AI Office') returning id into v_template;
  insert into public.workspace_policies (workspace_id, enabled, monthly_budget_usd, max_request_budget_usd, budget_period_start, budget_period_end)
    values (v_template, true, 2, 0.1, date_trunc('month', now()), date_trunc('month', now()) + interval '1 month');
  insert into public.workspace_provider_permissions (workspace_id, provider, models, secret_ref, enabled) values
    (v_template, 'anthropic', array['claude-sonnet-5', 'claude-opus-5'], 'env://ANTHROPIC_API_KEY', true),
    (v_template, 'deepseek', array['deepseek-flash'], 'env://DEEPSEEK_API_KEY', true),
    (v_template, 'openrouter', array['*:free'], 'env://OPENROUTER_API_KEY', true),
    (v_template, 'groq', array['*:free'], 'env://GROQ_API_KEY', false);
  insert into public.workspace_tool_grants (workspace_id, broker, tool_name, action, scopes, risk, decision, enabled) values
    (v_template, 'model-host', 'WebSearch', 'invoke', '{}', 'low', 'auto', true),
    (v_template, 'coding', 'git.push', 'publish', array['github:branch'], 'medium', 'auto', true),
    (v_template, 'coding', 'github.pr_merge', 'merge', array['github:merge'], 'medium', 'approval', true),
    (v_template, 'model-host', 'Bash', 'invoke', '{}', 'high', 'deny', true);

  select * into v_project from public.create_hub_project('  Pop-up plan  ');
  assert v_project.name = 'Pop-up plan', 'the name is trimmed and returned';
  assert (select monthly_budget_usd from public.workspace_policies where workspace_id = v_project.id and enabled) = 0.5, 'the new budget is capped at 0.50';
  assert (select max_request_budget_usd from public.workspace_policies where workspace_id = v_project.id) = 0.1, 'the request cap follows the template';
  assert (select array_agg(provider order by provider) from public.workspace_provider_permissions where workspace_id = v_project.id and enabled)
    = array['anthropic', 'deepseek', 'openrouter'], 'every enabled template route is inherited, free routes included';
  assert not exists (select 1 from public.workspace_provider_permissions where workspace_id = v_project.id and provider = 'groq'), 'a disabled template route is not inherited';
  assert (select models from public.workspace_provider_permissions where workspace_id = v_project.id and provider = 'openrouter') = array['*:free'], 'free-only model patterns are kept exactly';
  assert (select count(*) from public.workspace_tool_grants where workspace_id = v_project.id) = 3, 'the allowed tool grants are copied';
  assert (select decision from public.workspace_tool_grants where workspace_id = v_project.id and tool_name = 'github.pr_merge') = 'approval', 'merges still need approval';
  assert not exists (select 1 from public.workspace_tool_grants where workspace_id = v_project.id and tool_name = 'Bash'), 'denied tools are never copied';

  v_failed := false;
  begin perform public.create_hub_project('  fahad ai office '); exception when others then v_failed := sqlerrm = 'HUB_PROJECT_NAME_RESERVED'; end;
  assert v_failed, 'the template name is reserved';
  v_failed := false;
  begin perform public.create_hub_project('x'); exception when others then v_failed := sqlerrm = 'HUB_PROJECT_NAME_INVALID'; end;
  assert v_failed, 'a too-short name is refused';
end $$;
