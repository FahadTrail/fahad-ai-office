// Database layer. Every meaningful thing that happens in the office
// is written to `events` — the single source of truth for the future
// Live Feed and 3D office.

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  process.exit(1);
}

export const db = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export function log(...parts) {
  console.log('[' + new Date().toISOString() + ']', ...parts);
}

// Never throws: a logging failure must not kill a job.
export async function emit(event) {
  const row = {
    job_id: event.jobId ?? null,
    task_id: event.taskId ?? null,
    run_id: event.runId ?? null,
    agent_id: event.agentId ?? null,
    from_agent_id: event.fromAgentId ?? null,
    to_agent_id: event.toAgentId ?? null,
    type: event.type,
    level: event.level ?? 'info',
    message: event.message,
    payload: event.payload ?? {},
  };

  const { error } = await db.from('events').insert(row);
  if (error) {
    log('WARN  could not write event:', error.message);
  } else {
    log('event  ' + row.type.padEnd(18) + ' ' + row.message);
  }
}

export async function getAgent(slug) {
  const { data, error } = await db
    .from('agents')
    .select('*')
    .eq('slug', slug)
    .single();

  if (error) throw new Error('Agent "' + slug + '" not found: ' + error.message);
  return data;
}

export async function claimNextJob() {
  const { data, error } = await db.rpc('claim_next_job');
  if (error) throw new Error('claim_next_job failed: ' + error.message);
  return data && data.id ? data : null;
}
