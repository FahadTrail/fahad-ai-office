// Read-only self-check of the Coding Agent's Supabase tools, run when the
// Coding worker starts (every deployment recreates it). It uses the SAME
// client the agent's `supabase_query` tool uses and never calls a model:
//   1. project scoping — a project outside the allowlist is refused locally;
//   2. write guard     — data-changing SQL is refused locally;
//   3. a real read     — one harmless SELECT on the allowlisted project,
//                        through Supabase's read-only endpoint;
//   4. no exposure     — the token never appears in anything recorded.
// The outcome is one Office event (kind supabase_tools_check), metadata only.

import { SupabaseManagementClient } from './supabase.js';

const DEFAULT_PROJECT = 'zkzibipinjeswhdxnfgf';
const OUTSIDE_PROJECT = 'aaaaaaaaaaaaaaaaaaaa';

export async function supabaseSelfCheck({ env = process.env, fetchFn = fetch, record = async () => {}, now = () => Date.now() } = {}) {
  const token = String(env.CODING_SUPABASE_ACCESS_TOKEN || '').trim();
  const project = /^[a-z0-9]{20}$/.test(env.CODING_SUPABASE_SELFCHECK_PROJECT || '') ? env.CODING_SUPABASE_SELFCHECK_PROJECT : DEFAULT_PROJECT;
  const report = { kind: 'supabase_tools_check', project, token_present: Boolean(token), checked_at: new Date(now()).toISOString() };
  if (!token) {
    report.ok = false;
    report.error_code = 'SUPABASE_TOKEN_MISSING';
  } else {
    const client = new SupabaseManagementClient({ token, allowedProjects: [project], fetchFn, env });
    report.scope_enforced = await refused(() => client.queryReadOnly(OUTSIDE_PROJECT, 'select 1'), 'SUPABASE_PROJECT_NOT_ALLOWED');
    report.write_blocked = await refused(() => client.queryReadOnly(project, 'delete from public.jobs'), 'SQL_NOT_READ_ONLY');
    try {
      const result = await client.queryReadOnly(project, 'select current_user as db_role, current_database() as database', { maxRows: 1 });
      const row = result.rows?.[0] || {};
      report.read_ok = result.rowCount === 1;
      report.db_role = typeof row.db_role === 'string' ? row.db_role.slice(0, 60) : null;
    } catch (error) {
      report.read_ok = false;
      report.error_code = String(error.code || 'SUPABASE_READ_FAILED').slice(0, 60);
    }
    report.ok = Boolean(report.scope_enforced && report.write_blocked && report.read_ok);
  }
  // Nothing recorded may contain the credential.
  report.secret_exposed = Boolean(token) && JSON.stringify(report).includes(token);
  if (report.secret_exposed) Object.assign(report, { ok: false, db_role: null, error_code: 'SECRET_EXPOSURE_BLOCKED' });
  await record(report);
  return report;
}

async function refused(operation, code) {
  try {
    await operation();
    return false;
  } catch (error) {
    return error.code === code;
  }
}

// The Office event for the Hub's Integrations page.
export function supabaseCheckEvent(report) {
  return {
    type: 'activity', level: report.ok ? 'success' : 'warning',
    message: report.ok ? `Coding Agent Supabase tools verified (read-only) on ${report.project}.`
      : `Coding Agent Supabase tools not verified: ${report.error_code || 'check failed'}.`,
    payload: report,
  };
}
