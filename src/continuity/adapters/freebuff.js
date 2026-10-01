import { createDisabledAdapter } from './disabled.js';
export function createFreebuffAdapter({ ownerEnabled = false } = {}) {
  return createDisabledAdapter({ key: 'freebuff', kind: 'manual', quotaSource: 'freebuff', reason: ownerEnabled ? 'MANUAL_HANDOFF_REQUIRED' : 'OWNER_DISABLED', privacyClasses: ['PUBLIC'] });
}
export const freebuffAdapter = createFreebuffAdapter();
