// Fahad Coding Agent worker. Runs separately from the Office runtime, as
// container root, so sandboxed commands can drop to an unprivileged uid that
// cannot read this process's credentials. Sessions are durable in Supabase;
// a restarted worker resumes them from their latest checkpoint.

import { writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { SupabaseAgentSessionStore } from './agent-state/session-store.js';
import { SupabaseProviderStateStore } from './model-gateway/agentic/provider-state.js';
import { SupabaseWorkspacePolicyStore } from './workspace-policy/supabase-store.js';
import { SupabaseToolBrokerStore } from './tool-broker/supabase-store.js';
import { CodingWorker, createCodingRuntime } from './coding-agent/runtime.js';

const log = (...parts) => console.log(`[${new Date().toISOString()}] [coding-worker]`, ...parts);

export function modelAttemptRow(session, attempt) {
  const usage = attempt.usage || {};
  return {
    id: attempt.id,
    workspace_id: session.workspaceId,
    job_id: session.jobId,
    task_id: session.taskId,
    run_id: session.runId,
    attempt_no: Math.max(1, session.iteration + 1),
    provider_attempt: Math.max(1, attempt.attempt || 1),
    provider: attempt.route.provider,
    model: attempt.route.model,
    stage: 'coding',
    status: attempt.status === 'blocked' ? 'blocked' : attempt.status,
    idempotency_key: `${session.id}:turn:${session.iteration + 1}`,
    client_request_id: attempt.id,
    provider_request_id: attempt.requestId || null,
    route: [{ provider: attempt.route.provider, model: attempt.route.model, billingClass: attempt.route.billingClass }],
    input_tokens: Number(usage.inputTokens || 0),
    output_tokens: Number(usage.outputTokens || 0),
    reasoning_tokens: Number(usage.reasoningTokens || 0),
    cached_input_tokens: Number(usage.cachedInputTokens || 0),
    cost_usd: Number(usage.costUsd || 0),
    duration_ms: Number(attempt.durationMs || 0),
    error_code: attempt.error?.code || null,
    failure_class: attempt.error?.failureClass || null,
    http_status: attempt.error?.status || null,
    started_at: attempt.startedAt || new Date().toISOString(),
    ended_at: attempt.status === 'started' ? null : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const sessionStore = new SupabaseAgentSessionStore(db);
  const auditStore = new SupabaseToolBrokerStore(db);
  const runtime = createCodingRuntime({
    sessionStore,
    providerStateStore: new SupabaseProviderStateStore(db),
    policyStore: new SupabaseWorkspacePolicyStore(db),
    auditStore,
    modelAttemptSink: async (session, attempt) => {
      const { error } = await db.from('model_attempts').upsert(modelAttemptRow(session, attempt), { onConflict: 'id' });
      if (error) log('WARN model attempt not recorded:', error.message);
    },
    log,
  });
  const routable = runtime.pool.filter((route) => !route.unavailableReasons.length).map((route) => route.id);
  log(`sandbox mode: ${runtime.mode}; routable models: ${routable.join(', ') || 'none'}`);
  const worker = new CodingWorker({
    runtime, sessionStore, log,
    onHeartbeat: (state) => writeFileSync('/tmp/fahad-coding-worker-health.json', JSON.stringify({ ...state, pid: process.pid, updatedAt: Date.now() })),
  });
  const shutdown = () => {
    log('shutdown requested; the active session keeps its checkpoint and resumes after restart');
    worker.stop();
    setTimeout(() => process.exit(0), 15_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  await worker.start();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    log('FATAL:', error?.message || error);
    process.exit(1);
  });
}
