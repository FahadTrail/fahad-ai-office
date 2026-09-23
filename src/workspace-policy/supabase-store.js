import { WorkspacePolicyError } from './contracts.js';

export class SupabaseWorkspacePolicyStore {
  constructor(client) {
    if (!client?.from || !client?.rpc) throw new TypeError('Supabase client is required');
    this.db = client;
  }

  async getPolicy(workspaceId) {
    const { data: policy, error: policyError } = await this.db
      .from('workspace_policies')
      .select('workspace_id,enabled,version,monthly_budget_usd,max_request_budget_usd,spent_usd,reserved_usd,budget_period_start,budget_period_end')
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (policyError) throw storeError('WORKSPACE_POLICY_READ_FAILED', policyError);
    if (!policy) throw new WorkspacePolicyError('Workspace policy is missing', { code: 'WORKSPACE_POLICY_MISSING' });

    const [{ data: providers, error: providerError }, { data: tools, error: toolError }] = await Promise.all([
      this.db.from('workspace_provider_permissions')
        .select('provider,models,secret_ref,enabled').eq('workspace_id', workspaceId),
      this.db.from('workspace_tool_grants')
        .select('broker,tool_name,action,scopes,risk,decision,enabled').eq('workspace_id', workspaceId),
    ]);
    if (providerError) throw storeError('WORKSPACE_PROVIDER_POLICY_READ_FAILED', providerError);
    if (toolError) throw storeError('WORKSPACE_TOOL_POLICY_READ_FAILED', toolError);
    return {
      workspaceId: policy.workspace_id,
      enabled: policy.enabled,
      version: policy.version,
      budget: {
        monthlyLimitUsd: policy.monthly_budget_usd,
        maxRequestUsd: policy.max_request_budget_usd,
        spentUsd: policy.spent_usd,
        reservedUsd: policy.reserved_usd,
        periodStart: policy.budget_period_start,
        periodEnd: policy.budget_period_end,
      },
      providers: (providers || []).map((row) => ({
        provider: row.provider,
        models: row.models,
        secretRef: row.secret_ref,
        enabled: row.enabled,
      })),
      tools: (tools || []).map((row) => ({
        broker: row.broker,
        tool: row.tool_name,
        action: row.action,
        scopes: row.scopes,
        risk: row.risk,
        decision: row.decision,
        enabled: row.enabled,
      })),
    };
  }

  async assertExecutionContext({ workspaceId, jobId, taskId, runId }) {
    if (!jobId || !taskId || !runId) {
      throw new WorkspacePolicyError('Workspace execution lineage is incomplete', { code: 'WORKSPACE_LINEAGE_REQUIRED' });
    }
    const { error } = await this.db.rpc('assert_workspace_execution_context', {
      p_workspace: workspaceId,
      p_job: jobId,
      p_task: taskId,
      p_run: runId,
    });
    if (error) throw storeError('CROSS_WORKSPACE_ACCESS_DENIED', error);
  }

  async reserveBudget({ workspaceId, idempotencyKey, amountUsd }) {
    const { data, error } = await this.db.rpc('reserve_workspace_budget', {
      p_workspace: workspaceId,
      p_idempotency_key: idempotencyKey,
      p_requested_usd: amountUsd,
    });
    if (error) throw storeError('WORKSPACE_BUDGET_RESERVATION_FAILED', error);
    const row = Array.isArray(data) ? data[0] : data;
    return { reservationId: row?.reservation_id, reservedUsd: Number(row?.reserved_usd || 0) };
  }

  async settleBudget({ workspaceId, reservationId, idempotencyKey, actualUsd }) {
    const { error } = await this.db.rpc('settle_workspace_budget', {
      p_workspace: workspaceId,
      p_reservation: reservationId,
      p_idempotency_key: idempotencyKey,
      p_actual_usd: actualUsd,
    });
    if (error) throw storeError('WORKSPACE_BUDGET_SETTLEMENT_FAILED', error);
  }
}

function storeError(code, error) {
  return new WorkspacePolicyError('Workspace policy store rejected the operation', {
    code,
    cause: error,
  });
}
