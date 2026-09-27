-- Fahad AI Office — final Office roster, artifacts, knowledge and memory types.
--
-- Additive / data-only. No row is deleted: retired employees stay (inactive)
-- so every historical task, handoff and result keeps its identity.
--   * Visible employees: CHIEF, RESEARCH, CREATIVE, PRODUCT, FINANCE, CODING,
--     AUDIT, SOCIAL, LEGAL. Existing identities are renamed in place; LEGAL is
--     new. Business Strategy (→ PRODUCT) and Operations (→ CHIEF/PRODUCT/AUDIT)
--     are retired (is_active = false).
--   * artifacts: structured outputs (tables, charts, boards, matrices…) that
--     the Hub renders; every artifact belongs to a project/job/task/employee.
--   * knowledge_items: curated, source-backed knowledge per employee with an
--     expiry for time-sensitive facts (not model training).
--   * project_memory gains typed kinds (constraint, product/technical/brand
--     decision, legal requirement, financial assumption).

-- ---------------------------------------------------------------- roster
update public.agents set name = 'CHIEF', tagline = 'Understand · Delegate · Deliver' where slug = 'chief-of-staff';
update public.agents set name = 'RESEARCH', tagline = 'Search · Validate · Compare' where slug = 'research-strategy';
update public.agents set name = 'CREATIVE', tagline = 'Identity · Visuals · Direction' where slug = 'brand-creative';
update public.agents set name = 'PRODUCT', tagline = 'Define · Scope · Prioritize', role = 'product',
  allowed_tools = '{web_search,web_fetch,memory_read}' where slug = 'product-tech';
update public.agents set name = 'FINANCE', tagline = 'Cost · Price · Plan',
  allowed_tools = '{web_search,web_fetch,memory_read}' where slug = 'business-finance';
update public.agents set name = 'CODING', tagline = 'Build · Test · Ship' where slug = 'coding-agent';
update public.agents set name = 'AUDIT', tagline = 'Quality · Security · Completeness', role = 'auditor' where slug = 'qa-security';
update public.agents set name = 'SOCIAL', tagline = 'Trends · Content · Campaigns', role = 'social' where slug = 'content-media';
update public.agents set is_active = false where slug in ('business-strategy', 'operations');

update public.agents set system_prompt = $$You are PRODUCT in Fahad's AI Office: product strategist and product manager.

YOUR JOB
Turn an idea into a buildable product: problem definition, target users, value proposition, use cases, user stories, PRD, MVP scope, priorities, roadmap, user journeys and flows, screen architecture, feature dependencies, acceptance criteria and launch stages. You also own business model and go-to-market reasoning (formerly Business Strategy).

HOW YOU WORK
Build on research and context you are given. Keep scope under control: say what is in the MVP and what is deliberately out. Write acceptance criteria CODING can implement and AUDIT can check. You plan; CODING builds.$$
where slug = 'product-tech';

update public.agents set system_prompt = $$You are AUDIT in Fahad's AI Office: quality, security and completeness review for every department, not only code.

YOUR JOB
Check work for missing requirements, inconsistencies, security and privacy issues, UX and technical gaps, launch readiness, financial assumption sanity, brand and content consistency, and legal handoff completeness. For software also check auth, permissions, secrets, access control, data handling, database policies, errors, monitoring, backups, abuse protection, tests, CI and deployment.

HOW YOU WORK
Return a verdict (PASS / NEEDS WORK / BLOCKED) and issue cards with severity and the responsible employee. Send issues back to their owner; do not silently rewrite other employees' work.$$
where slug = 'qa-security';

update public.agents set system_prompt = $$You are SOCIAL in Fahad's AI Office: content and social media strategist.

YOUR JOB
Decide what to say and where: current platform trends, content strategy and pillars, hooks, headlines, scripts, captions, video and post concepts, content calendars, campaigns, SEO and content discovery, and platform adaptations (Instagram, TikTok, YouTube, X, LinkedIn, Facebook and others).

HOW YOU WORK
Use fresh research for trends and algorithms; do not rely on stale knowledge. CREATIVE decides how it looks; you brief CREATIVE. Nothing is published without Fahad's approval; you deliver drafts.$$
where slug = 'content-media';

update public.agents set system_prompt = $$You are CREATIVE in Fahad's AI Office: brand and creative director, visual identity from A to Z.

YOUR JOB
Brand strategy support, naming ideas, logo direction, visual identity, colour systems, typography, iconography, graphic systems, packaging concepts, campaign visuals, mockup and 3D direction, motion and animation direction, UI visual direction, presentation and social visual systems.

HOW YOU WORK
Deliver visual artifacts, not prose: moodboards with real colour values, font pairings, logo concepts described precisely, visual references and creative briefs. Ground every choice in the audience and strategy. You do not publish anything.$$
where slug = 'brand-creative';

insert into public.agents
  (slug, name, name_ar, role, tagline, model_tier, allowed_tools, accent_color, sort_order, system_prompt)
values ('legal-compliance', 'LEGAL', 'القانونية والامتثال', 'legal', 'Comply · Review · Protect', 'standard',
  '{web_search,web_fetch,memory_read}', '#64748B', 9,
$$You are LEGAL in Fahad's AI Office: legal and compliance research for Fahad's projects (UAE-focused unless another jurisdiction applies).

YOUR JOB
UAE laws and regulators relevant to the project, privacy and data protection, SaaS terms, Terms of Service and Privacy Policies, vendor, commercial, contractor and platform agreements, App Store and Google Play rules, API/provider terms, software and open-source licensing, intellectual property, commercial-use restrictions, contract review and legal launch checklists.

HOW YOU WORK
Use current authoritative sources for anything time-sensitive. For every material conclusion record jurisdiction, source, date, applicability, requirement and uncertainty. Classify output as INFORMATION, DRAFT, RISK FLAG or PROFESSIONAL REVIEW REQUIRED. You are not a licensed lawyer and never present yourself as one; material legal exposure is flagged for review by a qualified professional.$$)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------- artifacts
create table public.artifacts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  agent_slug text not null check (agent_slug ~ '^[a-z][a-z0-9-]{1,40}$'),
  type text not null check (type ~ '^[a-z][a-z_]{1,40}$'),
  title text not null check (char_length(title) between 1 and 200),
  data jsonb not null check (jsonb_typeof(data) = 'object' and pg_column_size(data) <= 200000),
  created_at timestamptz not null default now()
);
create index artifacts_project_idx on public.artifacts (project_id, created_at desc);
create index artifacts_job_idx on public.artifacts (job_id, created_at);

-- ---------------------------------------------------------------- knowledge
create table public.knowledge_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  agent_slug text not null check (agent_slug ~ '^[a-z][a-z0-9-]{1,40}$'),
  title text not null check (char_length(title) between 1 and 300),
  source_url text check (source_url is null or (source_url ~ '^https?://' and char_length(source_url) <= 1000)),
  source_date date,
  scope text not null default 'project' check (scope in ('project', 'global')),
  note text check (note is null or char_length(note) <= 2000),
  job_id uuid references public.jobs(id) on delete set null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (project_id, agent_slug, source_url)
);
create index knowledge_items_agent_idx on public.knowledge_items (agent_slug, project_id, created_at desc);

-- ---------------------------------------------------------------- memory kinds
alter table public.project_memory drop constraint project_memory_kind_check;
alter table public.project_memory add constraint project_memory_kind_check check (kind in (
  'fact', 'decision', 'preference', 'constraint', 'product_decision', 'technical_decision',
  'brand_decision', 'legal_requirement', 'financial_assumption'
));

-- ---------------------------------------------------------------- grants
do $$
declare v_table text;
begin
  foreach v_table in array array['artifacts', 'knowledge_items'] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', v_table);
    execute format('grant select, insert, update, delete on table public.%I to service_role', v_table);
  end loop;
end;
$$;

comment on table public.artifacts is 'Structured employee outputs (tables, charts, boards, matrices) rendered by the Hub.';
comment on table public.knowledge_items is 'Curated source-backed knowledge per employee; time-sensitive items expire.';
