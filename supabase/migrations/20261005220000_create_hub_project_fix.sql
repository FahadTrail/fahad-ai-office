-- V5.4 certification fix: creating a project from the Hub.
--
-- 1. Every call failed with "column reference name is ambiguous": the
--    function's RETURNS TABLE (id, name) columns are PL/pgSQL variables and
--    one query read projects.name unqualified, so the Hub's "New project"
--    never worked. Every column reference is now qualified.
-- 2. A new project inherited only the Anthropic and DeepSeek routes, so it
--    could never use the template's free routes: free-first routing and
--    [free-only] objectives did not work outside the template project. It now
--    inherits every enabled route of the template. Its budget cap is
--    unchanged (at most 0.50 USD a month, 0.10 per request), so paid use
--    stays bounded exactly as before.
--
-- Same signature, same grants; no table or data changes.

create or replace function public.create_hub_project(p_name text)
returns table (id uuid, name text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_template uuid;
  v_policy public.workspace_policies%rowtype;
  v_project uuid;
begin
  if p_name is null or char_length(btrim(p_name)) not between 2 and 80 then
    raise exception 'HUB_PROJECT_NAME_INVALID' using errcode = '22023';
  end if;
  if lower(btrim(p_name)) = lower('Fahad AI Office') then
    raise exception 'HUB_PROJECT_NAME_RESERVED' using errcode = '22023';
  end if;
  if (select count(*) from public.projects p where p.name = 'Fahad AI Office') <> 1 then
    raise exception 'HUB_PROJECT_TEMPLATE_AMBIGUOUS' using errcode = '42501';
  end if;
  select p.id into v_template from public.projects p where p.name = 'Fahad AI Office';
  select * into v_policy from public.workspace_policies wp
    where wp.workspace_id = v_template and wp.enabled;
  if not found then
    raise exception 'HUB_PROJECT_TEMPLATE_UNAVAILABLE' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.workspace_provider_permissions pp
    where pp.workspace_id = v_template and pp.provider = 'anthropic' and pp.enabled
      and pp.models @> array['claude-sonnet-5']::text[]
  ) then
    raise exception 'HUB_PROJECT_DEFAULT_PROVIDER_UNAVAILABLE' using errcode = '42501';
  end if;

  insert into public.projects(name) values (btrim(p_name)) returning projects.id into v_project;
  insert into public.workspace_policies (
    workspace_id, enabled, monthly_budget_usd, max_request_budget_usd,
    budget_period_start, budget_period_end
  ) values (
    v_project, true, least(v_policy.monthly_budget_usd, 0.50),
    least(v_policy.max_request_budget_usd, 0.10),
    date_trunc('month', now()), date_trunc('month', now()) + interval '1 month'
  );
  insert into public.workspace_provider_permissions
    (workspace_id, provider, models, secret_ref, enabled)
  select v_project, pp.provider, pp.models, pp.secret_ref, true
  from public.workspace_provider_permissions pp
  where pp.workspace_id = v_template and pp.enabled;
  insert into public.workspace_tool_grants
    (workspace_id, broker, tool_name, action, scopes, risk, decision, secret_ref, enabled)
  select v_project, g.broker, g.tool_name, g.action, g.scopes, g.risk, g.decision, g.secret_ref, true
  from public.workspace_tool_grants g
  where g.workspace_id = v_template and g.enabled and g.decision in ('auto', 'approval')
    and ((g.broker = 'model-host' and g.tool_name in ('WebSearch', 'WebFetch') and g.decision = 'auto')
      or (g.broker = 'mcp-office' and g.tool_name in ('office.echo', 'office.current_time') and g.decision = 'auto')
      or g.broker = 'coding');
  return query select p.id, p.name from public.projects p where p.id = v_project;
end;
$$;

revoke all on function public.create_hub_project(text) from public, anon, authenticated;
grant execute on function public.create_hub_project(text) to service_role;
