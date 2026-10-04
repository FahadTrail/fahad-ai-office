const METHODS = Object.freeze(['capabilities', 'available', 'health', 'start', 'resume', 'stop', 'status', 'usage', 'checkpoint', 'handoff']);

export function assertAdapterContract(adapter) {
  if (!adapter || typeof adapter.key !== 'string' || !adapter.key) throw new TypeError('Adapter requires a stable key');
  for (const method of METHODS) if (typeof adapter[method] !== 'function') throw new TypeError(`${adapter.key}: missing adapter method ${method}`);
  const capabilities = adapter.capabilities();
  for (const field of ['headless', 'resume', 'structuredOutput', 'usageReporting', 'worktrees', 'privacyClasses']) {
    if (!(field in capabilities)) throw new TypeError(`${adapter.key}: capabilities.${field} is required`);
  }
  if (!Array.isArray(capabilities.privacyClasses)) throw new TypeError(`${adapter.key}: privacyClasses must be a list`);
  return adapter;
}
export function unknownUsage() {
  return { task_tokens: null, session_pct: null, weekly_pct: null, reset_at: null, basis: 'UNKNOWN' };
}
export function normalizedStatus(key, session, status = 'STANDBY', extra = {}) {
  return {
    agent: key,
    status,
    session: session || null,
    usage: extra.usage || unknownUsage(),
    quota: extra.quota || null,
    reset: extra.reset || null,
    health: extra.health || 'unknown',
    current_task: extra.current_task || null,
    checkpoint: extra.checkpoint || null,
    error: extra.error || null,
  };
}
