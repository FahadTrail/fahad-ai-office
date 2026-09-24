import { randomUUID } from 'node:crypto';
import { ToolBroker } from './broker.js';

const BROKER = 'mcp-office';

export async function runProductionToolBrokerCanary({
  db,
  broker,
  policyStore,
  transport,
  workspaceName = 'Fahad AI Office',
}) {
  const workspace = await one(db.from('projects').select('id,name').eq('name', workspaceName).maybeSingle(), 'workspace');
  if (!workspace?.id) throw new Error('Tool Broker canary workspace is missing');

  const agents = await rows(db.from('agents')
    .select('id,slug,is_active')
    .in('slug', ['chief-of-staff', 'research-strategy'])
    .eq('is_active', true), 'agents');
  const chief = agents.find((agent) => agent.slug === 'chief-of-staff');
  const research = agents.find((agent) => agent.slug === 'research-strategy');
  if (!chief || !research) throw new Error('Tool Broker canary agents are missing');

  const runs = await rows(db.from('runs')
    .select('id,job_id,task_id,agent_id,started_at')
    .in('agent_id', [chief.id, research.id])
    .eq('status', 'succeeded')
    .order('started_at', { ascending: false })
    .limit(50), 'runs');
  const jobIds = [...new Set(runs.map((run) => run.job_id).filter(Boolean))];
  const jobs = jobIds.length
    ? await rows(db.from('jobs').select('id,project_id').in('id', jobIds), 'jobs')
    : [];
  const workspaceJobs = new Set(jobs.filter((job) => job.project_id === workspace.id).map((job) => job.id));
  const chiefRun = runs.find((run) => run.agent_id === chief.id && workspaceJobs.has(run.job_id));
  const researchRun = runs.find((run) => run.agent_id === research.id && workspaceJobs.has(run.job_id));
  if (!chiefRun || !researchRun) throw new Error('Tool Broker canary lineage is missing');

  const chiefContext = context(workspace.id, chiefRun);
  const researchContext = context(workspace.id, researchRun);
  const before = await policyStore.getPolicy(workspace.id);
  if (!before.enabled) throw new Error('Tool Broker canary workspace policy is disabled');

  const discovered = await broker.discover(chiefContext);
  const names = discovered.map(({ name }) => name).sort();
  if (names.join(',') !== 'office.current_time,office.echo') {
    throw new Error('Tool Broker canary catalog is not restricted to the reviewed tools');
  }

  const callsBefore = transport.calls.length;
  const echo = await broker.execute({
    context: chiefContext,
    broker: BROKER,
    tool: 'office.echo',
    action: 'invoke',
    arguments: { message: 'phase-2e-production-canary' },
    idempotencyKey: 'phase-2e-production-canary:v1:echo',
  });
  const time = await broker.execute({
    context: chiefContext,
    broker: BROKER,
    tool: 'office.current_time',
    action: 'read',
    arguments: {},
    idempotencyKey: 'phase-2e-production-canary:v1:current-time',
  });
  const callsAfterFirstPass = transport.calls.length;
  const replay = await broker.execute({
    context: chiefContext,
    broker: BROKER,
    tool: 'office.echo',
    action: 'invoke',
    arguments: { message: 'phase-2e-production-canary' },
    idempotencyKey: 'phase-2e-production-canary:v1:echo',
  });
  if (!replay.replayed || transport.calls.length !== callsAfterFirstPass) {
    throw new Error('Tool Broker canary idempotency replay failed');
  }
  if (!echo.replayed && echo.structuredContent?.message !== 'phase-2e-production-canary') {
    throw new Error('Tool Broker echo result failed validation');
  }
  if (!time.replayed && !/^\d{4}-\d{2}-\d{2}T/.test(time.structuredContent?.iso || '')) {
    throw new Error('Tool Broker time result failed validation');
  }

  const agentDeniedCalls = transport.calls.length;
  await rejectsCode(() => broker.execute({
    context: researchContext,
    broker: BROKER,
    tool: 'office.echo',
    action: 'invoke',
    arguments: { message: 'must-not-run' },
    idempotencyKey: 'phase-2e-production-canary:v1:agent-denied',
  }), 'TOOL_AGENT_DENIED');
  if (transport.calls.length !== agentDeniedCalls) throw new Error('Denied agent reached MCP transport');

  const crossWorkspaceCalls = transport.calls.length;
  await rejectsCode(() => broker.discover({ ...chiefContext, workspaceId: randomUUID() }), 'CROSS_WORKSPACE_ACCESS_DENIED');
  if (transport.calls.length !== crossWorkspaceCalls) throw new Error('Cross-workspace request reached MCP transport');

  const deniedDefinition = {
    ...broker.definitions.get('mcp-office:office.current_time:read'),
    action: 'invoke',
  };
  const deniedBroker = new ToolBroker({
    policyStore,
    auditStore: broker.auditStore,
    agentStore: broker.agentStore,
    clients: [...broker.clients.values()],
    definitions: [deniedDefinition],
  });
  const missingGrantCalls = transport.calls.length;
  await rejectsCode(() => deniedBroker.execute({
    context: chiefContext,
    broker: BROKER,
    tool: 'office.current_time',
    action: 'invoke',
    arguments: {},
    idempotencyKey: 'phase-2e-production-canary:v1:missing-grant',
  }), 'WORKSPACE_TOOL_DENIED');
  if (transport.calls.length !== missingGrantCalls) throw new Error('Missing grant reached MCP transport');

  const after = await policyStore.getPolicy(workspace.id);
  if (Number(after.budget.spentUsd) !== Number(before.budget.spentUsd) ||
      Number(after.budget.reservedUsd) !== Number(before.budget.reservedUsd)) {
    throw new Error('Zero-cost Tool Broker canary changed workspace budget');
  }

  return Object.freeze({
    ok: true,
    workspaceId: workspace.id,
    discovered: names,
    echoExecutionId: echo.executionId,
    timeExecutionId: time.executionId,
    externalCalls: transport.calls.length - callsBefore,
    replayVerified: true,
    agentDenied: true,
    missingGrantDenied: true,
    crossWorkspaceDenied: true,
    budgetDeltaUsd: 0,
  });
}

function context(workspaceId, run) {
  return Object.freeze({
    workspaceId,
    jobId: run.job_id,
    taskId: run.task_id,
    runId: run.id,
    agentId: run.agent_id,
  });
}

async function one(query, label) {
  const { data, error } = await query;
  if (error) throw new Error(`Tool Broker canary could not read ${label}`);
  return data;
}

async function rows(query, label) {
  const { data, error } = await query;
  if (error || !Array.isArray(data)) throw new Error(`Tool Broker canary could not read ${label}`);
  return data;
}

async function rejectsCode(operation, code) {
  try {
    await operation();
  } catch (error) {
    if (error?.code === code) return;
    throw error;
  }
  throw new Error(`Tool Broker canary expected ${code}`);
}
