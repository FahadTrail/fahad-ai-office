// The Tool Broker startup canary proves the governed MCP path against the
// production database. It is diagnostic, not a dependency of the Office
// workflow: a failure is logged and reported through the heartbeat instead of
// terminating the process, which would otherwise put the container into a
// restart loop over non-critical canary data.
export async function runStartupCanary({ canary, log, now = () => new Date() }) {
  try {
    const result = await canary();
    log('Tool Broker production canary verified:', JSON.stringify({
      workspaceId: result.workspaceId,
      discovered: result.discovered,
      replayVerified: result.replayVerified,
      rejectionTests: {
        agentDenied: result.agentDenied,
        missingGrantDenied: result.missingGrantDenied,
        crossWorkspaceDenied: result.crossWorkspaceDenied,
      },
      budgetDeltaUsd: result.budgetDeltaUsd,
    }));
    return Object.freeze({ status: 'verified', checkedAt: now().toISOString() });
  } catch (error) {
    const reason = String(error?.message || error || 'unknown failure').slice(0, 200);
    log('WARN  Tool Broker startup canary failed; continuing in degraded mode:', reason);
    return Object.freeze({ status: 'degraded', reason, checkedAt: now().toISOString() });
  }
}
