// Core Final Lock alert watchdog (docs/core-final-lock.md §5).
//
// Read-only: reads production telemetry for the last window and sends at
// most one Telegram message per NEW finding to the owner's chat (the same
// bot as the Office channel). It never changes routing, state or keys.
//
//   node src/ops/ops-watch.js [--minutes=15] [--dry-run]
//
// Cron on the VPS (every 15 minutes, as the app user):
//   */15 * * * * cd /opt/fahad-ai-office && docker compose exec -T runtime node src/ops/ops-watch.js
// Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY; OPS_WATCH_HEALTH_URL (e.g.
// http://127.0.0.1:2132/healthz) enables the health probe; Telegram delivery also needs
// TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_CHAT_ID (without them it only prints).
// Findings already announced are remembered in public.events
// (payload.kind = 'ops_watch_alert'), so a restart never repeats an alert.

import { pathToFileURL } from 'node:url';

const INCIDENTS = new Set(['paid_on_free_route', 'free_route_model_mismatch']);

// Office steps record a free-route incident as events.payload
// {kind:'free_route_incident', incident, route}; coding sessions as an
// agent_events 'guard' row with payload {code:'FREE_ROUTE_INCIDENT', kind, route}.
function incidentOf(event) {
  const payload = event.payload || {};
  if (payload.kind === 'free_route_incident' && INCIDENTS.has(payload.incident)) return { kind: payload.incident, route: payload.route };
  if (payload.code === 'FREE_ROUTE_INCIDENT' && INCIDENTS.has(payload.kind)) return { kind: payload.kind, route: payload.route };
  return null;
}

// Account blockers are named for what they are: an empty balance or an
// account that was never activated is the owner's optional decision (free
// routes keep working); a rejected key is a real credential problem.
function accountFinding(id, code = '') {
  if (/NO_CREDITS/.test(code || '')) return { severity: 'medium', text: `Provider account has no credits: ${id}. Optional: top up, or ignore it (free routes keep working).` };
  if (/NOT_ACTIVATED/.test(code || '')) return { severity: 'medium', text: `Provider account is not activated: ${id}. Optional: activate it in the provider console.` };
  return { severity: 'high', text: `Provider rejected the key: ${id} (${code || 'auth error'}). Check the key with ops/set-secret.sh.` };
}

// Pure: every finding in the window, each with a stable key for dedupe.
export function findings({ attempts = [], statuses = [], events = [], tasks = [], sessions = [], health = null, configured = null }) {
  const out = [];
  const paid = attempts.filter((row) => Number(row.cost_usd || 0) > 0);
  if (paid.length) {
    const cost = paid.reduce((sum, row) => sum + Number(row.cost_usd || 0), 0);
    out.push({ key: `paid:${paid.map((row) => row.id).sort().join(',')}`, severity: 'high',
      text: `Paid model calls: ${paid.length} (${[...new Set(paid.map((row) => `${row.provider}:${row.model}`))].join(', ')}), $${cost.toFixed(4)}.` });
  }
  for (const event of events) {
    const incident = incidentOf(event);
    if (incident) out.push({ key: `incident:${event.id}`, severity: 'high', text: `Free-route guard: ${incident.kind} on ${incident.route || 'a route'} (blocked 24 h, cost recorded).` });
  }
  for (const row of statuses) {
    const id = `${row.provider}:${row.model}`;
    if (row.health === 'auth_error' && (!configured || configured.has(row.provider))) {
      out.push({ key: `auth:${id}:${row.last_error_code || ''}`, ...accountFinding(id, row.last_error_code) });
    }
  }
  for (const task of tasks) {
    if (task.status === 'failed' && Number(task.wait_count || 0) >= 48) out.push({ key: `starved:${task.id}`, severity: 'medium', text: `Capacity starvation: task "${task.title || task.id}" failed after ${task.wait_count} capacity waits.` });
  }
  for (const session of sessions) {
    if (session.status === 'blocked') out.push({ key: `blocked:${session.id}:${session.error_code || ''}`, severity: 'medium', text: `Coding session blocked (${session.error_code || 'blocked'}): ${String(session.title || session.id).slice(0, 80)}.` });
  }
  // The runtime heartbeat is a file inside the container, checked by Docker;
  // from outside, the Hub's /healthz is the signal. Keyed by hour so a long
  // outage is re-announced hourly, not every run.
  if (health && !health.ok) {
    out.push({ key: `health:${health.status || 'unreachable'}:${String(health.at || '').slice(0, 13)}`, severity: 'high', text: `Hub /healthz is failing (${health.status ? `HTTP ${health.status}` : 'unreachable'}).` });
  }
  return out;
}

// Only findings not announced before.
export function newFindings(all, announcedKeys) {
  const seen = new Set(announcedKeys);
  return all.filter((finding) => !seen.has(finding.key));
}

export function alertText(items) {
  return ['Fahad AI Office — ops watch', ...items.map((item) => `${item.severity === 'high' ? '🔴' : '🟠'} ${item.text}`)].join('\n');
}

export async function runOpsWatch(args = process.argv.slice(2), { env = process.env, db = null, fetchFn = fetch, log = console.log, pool = null } = {}) {
  const minutes = Number(args.find((arg) => arg.startsWith('--minutes='))?.slice(10) || 15);
  const dryRun = args.includes('--dry-run');
  if (!db) {
    const { createClient } = await import('@supabase/supabase-js');
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  const { createModelPool } = await import('../model-gateway/agentic/model-pool.js');
  const configured = new Set((pool || createModelPool({ env })).filter((route) => !route.unavailableReasons?.includes('CREDENTIAL_MISSING')).map((route) => route.provider));
  const probe = async (url) => {
    if (!url) return null;
    try { const response = await fetchFn(url, { signal: AbortSignal.timeout(10_000) }); return { ok: response.ok, status: response.status, at: new Date().toISOString() }; }
    catch { return { ok: false, status: null, at: new Date().toISOString() }; }
  };
  const [attempts, statuses, events, agentEvents, tasks, sessions, health, announced] = await Promise.all([
    db.from('model_attempts').select('id,provider,model,cost_usd').gte('started_at', since).gt('cost_usd', 0),
    db.from('provider_status').select('provider,model,health,last_error_code'),
    db.from('events').select('id,payload').gte('created_at', since).eq('type', 'activity').contains('payload', { kind: 'free_route_incident' }),
    db.from('agent_events').select('id,payload').gte('created_at', since).eq('type', 'guard').contains('payload', { code: 'FREE_ROUTE_INCIDENT' }),
    db.from('tasks').select('id,title,status,wait_count').gte('created_at', new Date(Date.now() - 86_400_000).toISOString()).eq('status', 'failed'),
    db.from('agent_sessions').select('id,title,status,error_code').gte('updated_at', since).eq('status', 'blocked'),
    probe(env.OPS_WATCH_HEALTH_URL),
    db.from('events').select('payload').eq('type', 'activity').contains('payload', { kind: 'ops_watch_alert' }).gte('created_at', new Date(Date.now() - 7 * 86_400_000).toISOString()),
  ]);
  // A failed read must never look like "nothing announced yet" (that would
  // repeat every alert each run) or "nothing wrong": abort instead.
  const failed = [attempts, statuses, events, agentEvents, tasks, sessions, announced].find((result) => result.error);
  if (failed) throw new Error(`ops watch read failed: ${failed.error.message}`);
  const all = findings({
    attempts: attempts.data || [], statuses: statuses.data || [], tasks: tasks.data || [], sessions: sessions.data || [],
    events: [...(events.data || []), ...(agentEvents.data || []).map((row) => ({ ...row, id: `agent:${row.id}` }))],
    health, configured,
  });
  const fresh = newFindings(all, (announced.data || []).flatMap((row) => row.payload?.keys || []));
  if (!fresh.length) { log(JSON.stringify({ ok: true, findings: all.length, new: 0 })); return { sent: 0 }; }
  const text = alertText(fresh);
  log(text);
  if (dryRun) return { sent: 0, dryRun: true };
  // Recorded before sending: a Telegram failure loses one message, while a
  // failed record after sending would repeat the alert on every run.
  const recorded = await db.from('events').insert({ type: 'activity', level: 'warning', message: `Ops watch: ${fresh.length} new finding(s).`, payload: { kind: 'ops_watch_alert', keys: fresh.map((item) => item.key) } });
  if (recorded.error) throw new Error(`ops watch could not record the alert, nothing sent: ${recorded.error.message}`);
  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = env.TELEGRAM_OWNER_CHAT_ID;
  if (token && chat) {
    const response = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text }), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) console.error(`Telegram delivery failed: HTTP ${response.status}`);
    return { sent: response.ok ? fresh.length : 0 };
  }
  return { sent: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runOpsWatch();
