import { normalizedStatus, unknownUsage } from '../adapter-contract.js';

export function createDisabledAdapter({ key, reason = 'NOT_CONFIGURED', kind = 'manual', quotaSource, privacyClasses = ['PUBLIC'], capabilities = {} }) {
  const base = {
    headless: false,
    resume: false,
    structuredOutput: false,
    usageReporting: false,
    worktrees: false,
    maxContext: null,
    privacyClasses,
    taskSizes: [],
    taskTypes: ['coding'],
    costClass: 'unknown',
    quotaSource,
    mode: kind === 'manual' ? 'MANUAL_OR_SEMI_AUTOMATIC' : 'DISABLED',
    ...capabilities,
  };
  const unavailable = async () => { throw Object.assign(new Error(`${key}: ${reason}`), { code: reason }); };
  return {
    key,
    capabilities: () => ({ ...base, privacyClasses: [...base.privacyClasses] }),
    available: async () => ({ ok: false, reason }),
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
