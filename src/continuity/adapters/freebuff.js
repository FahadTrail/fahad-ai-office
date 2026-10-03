import { createDisabledAdapter } from './disabled.js';
export function createFreebuffAdapter({ ownerEnabled = false } = {}) {
  return createDisabledAdapter({ key: 'freebuff', kind: 'manual', quotaSource: 'freebuff', reason: ownerEnabled ? 'MANUAL_HANDOFF_REQUIRED' : 'OWNER_DISABLED', privacyClasses: ['PUBLIC'], ownerAction: 'Manual handoff only unless an official supported executable interface is documented.' });
}
export const freebuffAdapter = createFreebuffAdapter();
