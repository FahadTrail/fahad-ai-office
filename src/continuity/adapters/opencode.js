import { createDisabledAdapter } from './disabled.js';
export function createOpenCodeAdapter({ zenFree = false, promotionActive = false, legitimateAccess = false, dataClassAllowed = false, autoReload = true } = {}) {
  const ready = zenFree && promotionActive && legitimateAccess && dataClassAllowed && !autoReload;
  const reason = autoReload ? 'AUTO_RELOAD_MUST_BE_OFF' : !zenFree ? 'ZEN_MODEL_NOT_VERIFIED_FREE' : !promotionActive ? 'ZEN_PROMOTION_INACTIVE' : !legitimateAccess ? 'ZEN_ACCESS_NOT_VERIFIED' : !dataClassAllowed ? 'ZEN_PRIVACY_NOT_ALLOWED' : 'NOT_CONFIGURED';
  return createDisabledAdapter({ key: 'opencode', kind: 'cli', quotaSource: 'opencode', reason: ready ? 'CLI_NOT_INSTALLED' : reason, privacyClasses: ['PUBLIC'], ownerAction: 'Verify CLI login, a legitimately free model, data policy, and disabled auto-reload before implementation is enabled.' });
}
export const openCodeAdapter = createOpenCodeAdapter();
