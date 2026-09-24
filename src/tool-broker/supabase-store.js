import { ToolBrokerError } from './contracts.js';

export class SupabaseToolBrokerStore {
  constructor(client) {
    if (!client?.from || !client?.rpc) throw new TypeError('Supabase client is required');
    this.db = client;
  }

  async getAgentPermissions(agentId) {
    const { data, error } = await this.db
      .from('agents')
      .select('id,slug,allowed_tools,is_active')
      .eq('id', agentId)
      .maybeSingle();
    if (error) throw storeError('TOOL_AGENT_READ_FAILED', error);
    if (!data || !data.is_active) throw new ToolBrokerError('Tool agent is missing or inactive', { code: 'TOOL_AGENT_DENIED' });
    return Object.freeze({
      id: data.id,
      slug: data.slug,
      allowedTools: Object.freeze([...(data.allowed_tools || [])]),
    });
  }

  async beginExecution(input) {
    const { data, error } = await this.db.rpc('begin_tool_execution', {
      p_workspace: input.context.workspaceId,
      p_job: input.context.jobId,
      p_task: input.context.taskId,
      p_run: input.context.runId,
      p_agent: input.context.agentId,
      p_broker: input.broker,
      p_tool: input.tool,
      p_action: input.action,
      p_scopes: input.scopes,
      p_risk: input.risk,
      p_decision: input.decision,
      p_secret_ref: input.secretRef,
      p_idempotency_key: input.idempotencyKey,
      p_protocol: input.protocol,
      p_server_name: input.server,
      p_retry_safe: input.retrySafe,
      p_max_retries: input.maxRetries,
      p_error_code: input.errorCode || null,
    });
    if (error) throw storeError('TOOL_AUDIT_BEGIN_FAILED', error);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.execution_id || !row?.disposition) throw new ToolBrokerError('Tool audit did not return an execution lease', { code: 'TOOL_AUDIT_BEGIN_FAILED' });
    return Object.freeze({
      executionId: row.execution_id,
      status: row.status,
      disposition: row.disposition,
      attemptCount: Number(row.attempt_count || 0),
      retryCount: Number(row.retry_count || 0),
      resultSha256: row.result_sha256 || null,
    });
  }

  async finishExecution(input) {
    const { data, error } = await this.db.rpc('finish_tool_execution', {
      p_execution: input.executionId,
      p_status: input.status,
      p_duration_ms: input.durationMs,
      p_cost_usd: input.costUsd,
      p_result_sha256: input.resultSha256 || null,
      p_output_bytes: input.outputBytes || 0,
      p_attempt_count: input.attemptCount,
      p_retry_count: input.retryCount,
      p_error_code: input.errorCode || null,
    });
    if (error) throw storeError('TOOL_AUDIT_FINISH_FAILED', error);
    const row = Array.isArray(data) ? data[0] : data;
    return Object.freeze({ status: row?.status || input.status, endedAt: row?.ended_at || null });
  }
}

function storeError(code, error) {
  return new ToolBrokerError('Tool Broker audit store rejected the operation', { code, cause: error });
}
