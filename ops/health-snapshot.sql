-- One read-only operability snapshot of the Fahad AI Office (V5.4 Phase 8).
-- It returns a single JSON row. Run it in the Supabase SQL editor, or with psql
-- as postgres or service_role. It reads metadata only: no secrets, no
-- message bodies and no writes. It is the database-side view of what
-- /healthz and the ops watch report, so it still works when the Hub domain
-- cannot be reached.
--
--   psql "$DB_URL" -X -A -t -f ops/health-snapshot.sql | jq .
--
-- Thresholds: "stuck" means an open objective with no event for 2 hours.
-- "Failures" means the last 24 hours.
select jsonb_pretty(jsonb_build_object(
  'generatedAt', now(),
  -- Production version: one event per runtime start. On a deploy's own start
  -- `version` still names the previous commit (ops/deploy.sh writes deployed-sha
  -- after its health observations); `codeFingerprint` identifies the running
  -- code (node src/build-info.js <checkout>). The deploy log and /healthz name
  -- the deployed commit.
  'runtime', (
    select jsonb_build_object('version', e.payload->>'version', 'codeFingerprint', e.payload->>'codeFingerprint',
                              'startedAt', e.created_at, 'restartsLast24h',
                              (select count(*) from public.events as r where r.payload->>'kind' = 'runtime_started' and r.created_at > now() - interval '24 hours'))
    from public.events as e where e.payload->>'kind' = 'runtime_started' order by e.created_at desc limit 1),
  'lastOfficeActivityAt', (select max(created_at) from public.events where job_id is not null),
  'lastCodingActivityAt', (select max(created_at) from public.agent_events),
  -- Workers that report a heartbeat, including the native Office coding worker
  -- and the Continuity workers (all OFF unless Fahad enabled them).
  'workers', (
    select coalesce(jsonb_agg(jsonb_build_object('key', w.key, 'enabled', w.enabled, 'health', w.health, 'lastSeenAt', w.last_seen_at) order by w.key), '[]'::jsonb)
    from public.coding_workers as w),
  'continuity', jsonb_build_object(
    'activeLeases', (select count(*) from public.coding_leases where status = 'active' and released_at is null),
    'lastLeaseHeartbeatAt', (select max(heartbeat_at) from public.coding_leases),
    'pendingHandoffs', (select count(*) from public.coding_handoffs where accepted_at is null and status not in ('accepted', 'rejected', 'cancelled', 'completed'))),
  'failuresLast24h', jsonb_build_object(
    'jobsFailed', (select count(*) from public.jobs where status = 'failed' and coalesce(completed_at, created_at) > now() - interval '24 hours'),
    'tasksFailed', (select count(*) from public.tasks where status = 'failed' and coalesce(completed_at, created_at) > now() - interval '24 hours'),
    'codingSessionsFailedOrBlocked', (select count(*) from public.agent_sessions where status in ('failed', 'blocked') and updated_at > now() - interval '24 hours'),
    'modelAttemptsFailed', (select count(*) from public.model_attempts where status = 'failed' and started_at > now() - interval '24 hours'),
    'errorEvents', (select count(*) from public.events where level = 'error' and created_at > now() - interval '24 hours')),
  'providers', jsonb_build_object(
    'total', (select count(*) from public.provider_status),
    'notHealthy', (
      select coalesce(jsonb_agg(jsonb_build_object('route', p.provider || ':' || p.model, 'health', p.health, 'error', p.last_error_code,
                                                   'coolingDownUntil', case when p.cooldown_until > now() then p.cooldown_until end) order by p.provider, p.model), '[]'::jsonb)
      from public.provider_status as p
      where p.health is distinct from 'healthy' or p.cooldown_until > now())),
  'spend', jsonb_build_object(
    'workspaces', (
      select coalesce(jsonb_agg(jsonb_build_object('workspace', pr.name, 'monthlyBudgetUsd', wp.monthly_budget_usd, 'spentUsd', wp.spent_usd,
                                                   'reservedUsd', wp.reserved_usd, 'periodEnd', wp.budget_period_end,
                                                   'periodEnded', now() >= wp.budget_period_end) order by pr.name), '[]'::jsonb)
      from public.workspace_policies as wp join public.projects as pr on pr.id = wp.workspace_id where wp.enabled),
    'modelCostThisMonthUsd', (select coalesce(sum(cost_usd), 0) from public.model_attempts where started_at >= date_trunc('month', now())),
    'paidAttemptsLast24h', (select count(*) from public.model_attempts where cost_usd > 0 and started_at > now() - interval '24 hours')),
  'pendingOwnerItems', jsonb_build_object(
    'officeApprovals', (select count(*) from public.approvals where status = 'pending'),
    'codingApprovals', (select count(*) from public.agent_approvals where status = 'pending'),
    'blockedCodingSessions', (select count(*) from public.agent_sessions where status in ('blocked', 'awaiting_approval'))),
  'stuck', jsonb_build_object(
    'openObjectivesWithoutEventFor2h', (
      select count(*) from public.jobs as j
      where j.status in ('planning', 'running', 'review', 'waiting_approval')
        and coalesce((select max(e.created_at) from public.events as e where e.job_id = j.id), j.created_at) < now() - interval '2 hours'),
    'runsLeftRunningOnClosedObjectives', (
      select count(*) from public.runs as r join public.jobs as j on j.id = r.job_id
      where r.status = 'running' and j.status in ('completed', 'failed', 'cancelled', 'blocked'))),
  'opsWatch', (
    select jsonb_build_object('lastAlertAt', max(created_at), 'alertsLast24h', count(*) filter (where created_at > now() - interval '24 hours'))
    from public.events where payload->>'kind' = 'ops_watch_alert')
)) as health_snapshot;
