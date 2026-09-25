// Wires the Coding Agent from shared Office infrastructure: durable session
// store, Model Pool + turn gateway, provider state, workspace policy, Tool
// Broker and audit. Production uses Supabase-backed stores; tests and local
// runs inject the in-memory equivalents with identical contracts.

import { hostname } from 'node:os';
import { ToolBroker } from '../tool-broker/broker.js';
import { EnvironmentSecretResolver } from '../tool-broker/secret-resolver.js';
import { WorkspacePolicyEngine } from '../workspace-policy/engine.js';
import { AgentTurnGateway } from '../model-gateway/agentic/turn-gateway.js';
import { createModelPool, DEFAULT_BILLING_PRIORITY } from '../model-gateway/agentic/model-pool.js';
import { CodingAgentController } from './controller.js';
import { CODING_SECRET_REFERENCES, CODING_TOOL_DEFINITIONS, createCodingToolServer } from './tools.js';
import { GitHubClient } from './github.js';
import { SupabaseManagementClient } from './supabase.js';
import { Sandbox, resolveSandboxMode } from './sandbox.js';

export function billingPriority(env = process.env) {
  const values = String(env.CODING_BILLING_PRIORITY || '').split(',').map((value) => value.trim()).filter(Boolean);
  return values.length ? values : [...DEFAULT_BILLING_PRIORITY];
}

export function createCodingRuntime({
  env = process.env,
  sessionStore,
  providerStateStore,
  policyStore,
  auditStore,
  modelAttemptSink = async () => {},
  pool = null,
  fetchFn = fetch,
  sandboxRoot = env.CODING_AGENT_WORKSPACE_ROOT || '/app/workspace/coding',
  sandboxMode = null,
  limits = {},
  log = (...parts) => console.log(`[${new Date().toISOString()}] [coding]`, ...parts),
  sleepFn,
  now,
}) {
  const mode = sandboxMode || resolveSandboxMode(env);
  const modelPool = pool || createModelPool({ env, fetchFn });
  const gateway = new AgentTurnGateway({
    pool: modelPool,
    stateStore: providerStateStore,
    billingPriority: billingPriority(env),
    minQualityTier: Number(env.CODING_MIN_QUALITY_TIER || 4),
    sleepFn,
    now,
  });
  const secretResolver = new EnvironmentSecretResolver({ env, allowedReferences: CODING_SECRET_REFERENCES });

  const createSandbox = async (session) => new Sandbox({ root: sandboxRoot, sessionId: session.id, mode, env });
  const createBroker = (session, sandbox) => {
    const config = session.config || {};
    const client = createCodingToolServer({
      sandbox,
      github: (token) => new GitHubClient({ token, repository: session.repository, fetchFn, env, apiBase: config.githubApiBase || undefined }),
      supabase: (token) => new SupabaseManagementClient({ token, allowedProjects: config.supabase?.projects || [], fetchFn, env, apiBase: config.supabaseApiBase || undefined }),
      verifyHosts: config.verify?.hosts || [],
      fetchFn,
      pushUrl: config.pushUrl || null,
    });
    return new ToolBroker({
      policyStore, auditStore, agentStore: auditStore, clients: [client], definitions: CODING_TOOL_DEFINITIONS,
      secretResolver, approvalStore: sessionStore,
    });
  };

  // A model route is usable for a session only if the workspace explicitly
  // authorizes that provider, model and controller-side secret reference.
  const authorizeRoute = async (route, session) => {
    const policy = await policyStore.getPolicy(session.workspaceId);
    new WorkspacePolicyEngine({ providerSecretRefs: { [route.provider]: route.secretRef } })
      .authorizeProvider(policy, route.provider, route.model);
  };

  // Paid model turns reserve their worst-case cost against the workspace's
  // monthly budget before the provider is called and settle afterwards.
  const budget = {
    reserve: async (session, { route, estimateUsd, attemptId }) => {
      if (!(estimateUsd > 0)) return null;
      const policy = await policyStore.getPolicy(session.workspaceId);
      const amountUsd = Math.min(Number(policy.budget?.maxRequestUsd || estimateUsd), estimateUsd);
      const idempotencyKey = `agent-turn:${session.id}:${attemptId}`;
      const reservation = await policyStore.reserveBudget({ workspaceId: session.workspaceId, idempotencyKey, amountUsd });
      return { ...reservation, idempotencyKey, route: route.id };
    },
    settle: async (session, reservation, actualUsd) => {
      if (!reservation) return;
      await policyStore.settleBudget({
        workspaceId: session.workspaceId, reservationId: reservation.reservationId,
        idempotencyKey: reservation.idempotencyKey, actualUsd,
      });
    },
  };

  const controller = new CodingAgentController({
    budget,
    store: sessionStore,
    gateway,
    createSandbox,
    createBroker,
    authorizeRoute,
    recordModelAttempt: modelAttemptSink,
    limits,
    log,
    sleepFn,
    now,
    env,
  });
  return { controller, gateway, pool: modelPool, mode };
}

export class CodingWorker {
  constructor({ runtime, sessionStore, pollMs = 5000, log = () => {}, workerId = `${hostname()}:${process.pid}`, onHeartbeat = () => {} }) {
    this.runtime = runtime;
    this.store = sessionStore;
    this.pollMs = pollMs;
    this.log = log;
    this.workerId = workerId;
    this.onHeartbeat = onHeartbeat;
    this.running = false;
    this.current = null;
  }

  async runOnce() {
    const session = await this.store.claim({ worker: this.workerId, leaseSeconds: 300 });
    if (!session) return null;
    this.current = session.id;
    this.log(`claimed session ${session.id} (${session.phase}, iteration ${session.iteration})`);
    try {
      const outcome = await this.runtime.controller.run(session);
      this.log(`session ${session.id} → ${outcome.status}${outcome.blocker ? `: ${outcome.blocker}` : ''}`);
      return { sessionId: session.id, ...outcome };
    } finally {
      this.current = null;
    }
  }

  async start() {
    this.running = true;
    while (this.running) {
      try {
        this.onHeartbeat({ busy: false, current: null });
        const outcome = await this.runOnce();
        if (!outcome) await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      } catch (error) {
        this.log('worker error:', error?.message || error);
        await new Promise((resolve) => setTimeout(resolve, this.pollMs * 2));
      }
    }
  }

  stop() {
    this.running = false;
  }
}
