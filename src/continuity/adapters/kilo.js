import { createDisabledAdapter } from './disabled.js';
export function createKiloAdapter({ chatGptLogin = false, autoFreeVerified = false } = {}) {
  return createDisabledAdapter({ key: 'kilo', kind: 'manual', quotaSource: chatGptLogin ? 'openai-chatgpt' : 'kilo-auto-free', reason: 'SUPPORTED_HEADLESS_MODE_NOT_CONFIGURED', privacyClasses: autoFreeVerified ? ['PUBLIC'] : [] });
}
export const kiloAdapter = createKiloAdapter();
