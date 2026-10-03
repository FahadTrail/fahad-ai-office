import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolvePhaseNWorkspace } from '../src/continuity/phase-n-workspace.js';

const WORKSPACE = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function query(data = null, error = null) {
  const value = { data, error };
  const api = {
    select: () => api, eq: () => api, limit: () => api,
    maybeSingle: async () => value,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return api;
}

function stubDb({ project = null, policy = null, policies = null, grants = null, error = null } = {}) {
  return {
    from(table) {
      if (table === 'projects') return query(project, error);
      if (table === 'workspace_policies') return query(policy ?? policies, error);
      if (table === 'workspace_tool_grants') return query(grants, error);
      return query(null, error);
    },
  };
}

const codingWorkspace = (name = 'Fahad AI Office') => ({
  workspace_id: WORKSPACE, projects: { id: WORKSPACE, name },
  workspace_tool_grants: [{ broker: 'coding', enabled: true }],
});

test('an explicit PHASE_N_WORKSPACE_ID is validated end to end: project exists, policy enabled, Coding Agent grants present', async () => {
  const db = stubDb({ project: { id: WORKSPACE, name: 'Fahad AI Office' }, policy: { enabled: true }, grants: [{ tool_name: 'git.push' }] });
  const resolved = await resolvePhaseNWorkspace({ db, requestedId: WORKSPACE });
  assert.equal(resolved.workspaceId, WORKSPACE);
  assert.equal(resolved.projectName, 'Fahad AI Office');
  assert.equal(resolved.source, 'PHASE_N_WORKSPACE_ID');
});

test('a disabled workspace fails closed with WORKSPACE_DISABLED before the drill can start', async () => {
  const db = stubDb({ project: { id: WORKSPACE, name: 'Fahad AI Office' }, policy: { enabled: false } });
  await assert.rejects(resolvePhaseNWorkspace({ db, requestedId: WORKSPACE }), (error) => error.blocker === 'WORKSPACE_DISABLED');
});

test('an explicit ID naming no project fails closed with PHASE_N_WORKSPACE_NOT_FOUND', async () => {
  const db = stubDb({ project: null });
  await assert.rejects(resolvePhaseNWorkspace({ db, requestedId: WORKSPACE }), (error) => error.blocker === 'PHASE_N_WORKSPACE_NOT_FOUND');
});

test('a project without a workspace policy fails closed with WORKSPACE_POLICY_MISSING', async () => {
  const db = stubDb({ project: { id: WORKSPACE, name: 'Fahad AI Office' }, policy: null });
  await assert.rejects(resolvePhaseNWorkspace({ db, requestedId: WORKSPACE }), (error) => error.blocker === 'WORKSPACE_POLICY_MISSING');
});

test('an enabled workspace without Coding Agent tool grants is refused (WORKSPACE_NOT_CODING)', async () => {
  const db = stubDb({ project: { id: WORKSPACE, name: 'Other' }, policy: { enabled: true }, grants: [] });
  await assert.rejects(resolvePhaseNWorkspace({ db, requestedId: WORKSPACE }), (error) => error.blocker === 'WORKSPACE_NOT_CODING');
});

test('a malformed PHASE_N_WORKSPACE_ID fails closed with PHASE_N_WORKSPACE_ID_INVALID', async () => {
  await assert.rejects(resolvePhaseNWorkspace({ db: stubDb(), requestedId: 'not-a-uuid' }), (error) => error.blocker === 'PHASE_N_WORKSPACE_ID_INVALID');
});

test('without an explicit ID, only the single enabled Coding Agent workspace is auto-resolved', async () => {
  const db = stubDb({ policies: [codingWorkspace()] });
  const resolved = await resolvePhaseNWorkspace({ db, requestedId: null });
  assert.equal(resolved.workspaceId, WORKSPACE);
  assert.equal(resolved.source, 'auto-resolved');
});

test('without an explicit ID, zero enabled Coding Agent workspaces never guess (WORKSPACE_UNRESOLVED)', async () => {
  const withoutGrants = codingWorkspace();
  withoutGrants.workspace_tool_grants = [{ broker: 'coding', enabled: false }];
  await assert.rejects(resolvePhaseNWorkspace({ db: stubDb({ policies: [withoutGrants] }), requestedId: null }),
    (error) => error.blocker === 'WORKSPACE_UNRESOLVED');
  await assert.rejects(resolvePhaseNWorkspace({ db: stubDb({ policies: [] }), requestedId: null }),
    (error) => error.blocker === 'WORKSPACE_UNRESOLVED');
});

test('two enabled Coding Agent workspaces are never chosen arbitrarily (WORKSPACE_AMBIGUOUS)', async () => {
  const second = codingWorkspace('Second Project');
  second.workspace_id = '9b8f6c1e-2d3a-4f5b-8c7d-1e2f3a4b5c6d';
  await assert.rejects(resolvePhaseNWorkspace({ db: stubDb({ policies: [codingWorkspace(), second] }), requestedId: null }),
    (error) => error.blocker === 'WORKSPACE_AMBIGUOUS');
});

test('database lookup failures and a missing client surface as exact blockers, never a silent pass', async () => {
  await assert.rejects(resolvePhaseNWorkspace({ db: stubDb({ error: { message: 'boom' } }), requestedId: WORKSPACE }),
    (error) => error.blocker === 'WORKSPACE_LOOKUP_FAILED' && error.message.includes('boom'));
  await assert.rejects(resolvePhaseNWorkspace({ db: null, requestedId: WORKSPACE }),
    (error) => error.blocker === 'WORKSPACE_LOOKUP_FAILED');
});

test('the Phase N drill never starts the Office leg with a null or unvalidated workspace', () => {
  // Regression guard for the live VPS failure: the Office leg ran with
  // `projectId: null` and create_coding_session rejected it with
  // WORKSPACE_DISABLED only after the drill had already started. The drill
  // must resolve the workspace inside preflight and gate on it before any
  // branch, supervisor or worker exists.
  const src = readFileSync(new URL('../tools/continuity-phase-n-live.mjs', import.meta.url), 'utf8');
  assert.ok(!src.includes('projectId: null'), 'the Office leg task must never carry a null projectId');
  assert.ok(src.includes('projectId: pre.workspaceId,'), 'the task takes the workspace preflight validated');
  assert.ok(src.includes("must(pre.workspaceId, 'PHASE_N_WORKSPACE_UNRESOLVED'"), 'a missing workspace aborts before anything runs');
  assert.ok(src.includes('resolvePhaseNWorkspace({ db, requestedId: process.env.PHASE_N_WORKSPACE_ID || null })'),
    'preflight validates the explicit ID or safely auto-resolves');
  const at = (needle) => { const index = src.indexOf(needle); assert.ok(index > 0, `missing: ${needle}`); return index; };
  const preflightDefined = at('async function preflight');
  const resolution = at('resolvePhaseNWorkspace(');
  const runDrillDefined = at('async function runDrill');
  const gate = at('must(pre.ok');
  const workspaceGate = at('must(pre.workspaceId');
  const branchCreated = at("git(repoRoot, 'branch', branch)");
  const workerStarted = at('supervisorA.startTask');
  assert.ok(preflightDefined < resolution && resolution < runDrillDefined, 'workspace resolution runs inside preflight');
  assert.ok(gate < workspaceGate && workspaceGate < branchCreated, 'a failed preflight aborts before the disposable branch exists');
  assert.ok(workspaceGate < workerStarted, 'the Office worker can only start with a validated workspace');
});
