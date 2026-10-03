// Office-leg workspace selection for the live Phase N drill
// (tools/continuity-phase-n-live.mjs). `create_coding_session` rejects any
// workspace whose `workspace_policies.enabled` is not true, so the drill must
// hold a real, enabled, Coding-Agent-intended workspace before it starts.
//
// Rules, fail closed:
//   * An explicit PHASE_N_WORKSPACE_ID is preferred and is validated: the
//     project exists, workspace_policies.enabled = true, and the workspace
//     carries enabled Coding Agent tool grants (intended for Coding Agent
//     runs, safe for the disposable PUBLIC drill).
//   * Without an explicit ID the ONLY automatic answer is the single enabled
//     Coding Agent workspace. Zero or several candidates is an exact blocker,
//     never an arbitrary pick.
//   * Nothing here mutates policy; it is read-only validation.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function blocked(blocker, detail = null) {
  const error = new Error(detail ? `${blocker}: ${detail}` : blocker);
  error.blocker = blocker;
  return error;
}

async function unwrap(query, label) {
  let response;
  try { response = await query; } catch (error) { throw blocked('WORKSPACE_LOOKUP_FAILED', `${label}: ${error.message}`); }
  if (response?.error) throw blocked('WORKSPACE_LOOKUP_FAILED', `${label}: ${response.error.message}`);
  return response?.data ?? null;
}

async function assertCodingWorkspace(db, workspaceId, projectName) {
  const grants = await unwrap(
    db.from('workspace_tool_grants').select('tool_name').eq('workspace_id', workspaceId).eq('broker', 'coding').eq('enabled', true).limit(1),
    'workspace_tool_grants');
  if (!grants?.length) {
    throw blocked('WORKSPACE_NOT_CODING', `project ${projectName} has no enabled Coding Agent tool grants — not intended for Coding Agent runs`);
  }
}

/**
 * Resolve the workspace the Phase N Office leg must run in.
 * @param {{ db: object, requestedId?: string|null }} options
 * @returns {Promise<{ workspaceId: string, projectName: string, source: string }>}
 * @throws an Error with `.blocker` set to the exact fail-closed reason.
 */
export async function resolvePhaseNWorkspace({ db, requestedId = null } = {}) {
  if (!db) throw blocked('WORKSPACE_LOOKUP_FAILED', 'no database client');

  const id = String(requestedId || '').trim();
  if (id) {
    if (!UUID.test(id)) throw blocked('PHASE_N_WORKSPACE_ID_INVALID', 'not a UUID');
    const project = await unwrap(db.from('projects').select('id,name').eq('id', id).maybeSingle(), 'projects');
    if (!project) throw blocked('PHASE_N_WORKSPACE_NOT_FOUND', `no project ${id}`);
    const policy = await unwrap(db.from('workspace_policies').select('enabled').eq('workspace_id', id).maybeSingle(), 'workspace_policies');
    if (!policy) throw blocked('WORKSPACE_POLICY_MISSING', `project ${project.name} has no workspace policy`);
    if (policy.enabled !== true) throw blocked('WORKSPACE_DISABLED', `workspace_policies.enabled = false for project ${project.name}`);
    await assertCodingWorkspace(db, id, project.name);
    return { workspaceId: id, projectName: project.name, source: 'PHASE_N_WORKSPACE_ID' };
  }

  const policies = await unwrap(
    db.from('workspace_policies')
      .select('workspace_id, projects(id, name), workspace_tool_grants(broker, enabled)')
      .eq('enabled', true),
    'workspace_policies') || [];
  const candidates = policies.filter((row) => row.projects
    && (row.workspace_tool_grants || []).some((grant) => grant.broker === 'coding' && grant.enabled === true));
  if (candidates.length === 1) {
    return { workspaceId: candidates[0].workspace_id, projectName: candidates[0].projects.name, source: 'auto-resolved' };
  }
  if (candidates.length === 0) {
    throw blocked('WORKSPACE_UNRESOLVED', 'no enabled Coding Agent workspace — set PHASE_N_WORKSPACE_ID explicitly');
  }
  throw blocked('WORKSPACE_AMBIGUOUS', `${candidates.length} enabled Coding Agent workspaces — set PHASE_N_WORKSPACE_ID explicitly (an arbitrary workspace is never used)`);
}
