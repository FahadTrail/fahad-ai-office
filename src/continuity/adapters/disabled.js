import { normalizedStatus, unknownUsage } from '../adapter-contract.js';

export function createDisabledAdapter({ key, reason = 'NOT_CONFIGURED', kind = 'manual', quotaSource, privacyClasses = ['PUBLIC'], capabilities = {}, ownerAction = 'Verify a supported executable interface before enabling this worker.' }) {
  const base = {
    executionMode: kind === 'manual' ? 'MANUAL_ONLY' : 'DISABLED',
    headless: false,
    resume: false,
    checkpoint: false,
    structuredOutput: false,
    usageReporting: false,
    worktrees: false,
    maxContext: null,
    privacyClasses,
    taskSizes: [],
    taskTypes: ['coding'],
    costClass: 'unknown',
    quotaSource,
    authRequirement: 'Not configured',
    availability: reason,
    ownerAction,
    mode: kind === 'manual' ? 'MANUAL_OR_SEMI_AUTOMATIC' : 'DISABLED',
    ...capabilities,
  };
  const unavailable = async () => { throw Object.assign(new Error(`${key}: ${reason}`), { code: reason }); };
  return {
    key,
    capabilities: () => ({ ...base, privacyClasses: [...base.privacyClasses] }),
    available: async () => ({ ok: false, reason, authState: 'OWNER_ACTION_REQUIRED' }),
    authReadiness: async () => ({ ok: false, reason, authState: 'OWNER_ACTION_REQUIRED' }),
    health: async () => ({ status: 'down', basis: 'MEASURED', detail: reason }),
    start: unavailable,
    resume: unavailable,
    stop: async () => ({ stopped: false, reason }),
    status: async ({ session } = {}) => normalizedStatus(key, session, 'UNAVAILABLE', { error: reason, health: 'down' }),
    usage: async () => unknownUsage(),
    checkpoint: unavailable,
    handoff: unavailable,
  };
}
