-- Owner-only Hub project creation inherits only the proven production grants.
-- The service-role-only function is atomic: no unprotected or half-configured
-- project can be returned to the Hub.
alter table public.jobs
  add column requested_provider text not null default 'auto'
  check (requested_provider in ('auto', 'anthropic', 'deepseek'));

create function public.create_hub_project(p_name text)
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
  if (select count(*) from public.projects where name = 'Fahad AI Office') <> 1 then
    raise exception 'HUB_PROJECT_TEMPLATE_AMBIGUOUS' using errcode = '42501';
  end if;
  select p.id into v_template from public.projects p where p.name = 'Fahad AI Office';
  select * into v_policy from public.workspace_policies
    where workspace_id = v_template and enabled;
  if not found then
    raise exception 'HUB_PROJECT_TEMPLATE_UNAVAILABLE' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.workspace_provider_permissions
    where workspace_id = v_template and provider = 'anthropic' and enabled
      and models @> array['claude-sonnet-5']::text[]
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
  select v_project, provider, models, secret_ref, true
  from public.workspace_provider_permissions
  where workspace_id = v_template and enabled and provider in ('anthropic', 'deepseek');
  insert into public.workspace_tool_grants
    (workspace_id, broker, tool_name, action, scopes, risk, decision, secret_ref, enabled)
  select v_project, broker, tool_name, action, scopes, risk, decision, secret_ref, true
  from public.workspace_tool_grants
  where workspace_id = v_template and enabled and decision = 'auto'
    and ((broker = 'model-host' and tool_name in ('WebSearch', 'WebFetch'))
      or (broker = 'mcp-office' and tool_name in ('office.echo', 'office.current_time')));
  return query select p.id, p.name from public.projects p where p.id = v_project;
end;
$$;

revoke all on function public.create_hub_project(text) from public, anon, authenticated;
grant execute on function public.create_hub_project(text) to service_role;

