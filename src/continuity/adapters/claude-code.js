import { createDisabledAdapter } from './disabled.js';
export const claudeCodeAdapter = createDisabledAdapter({ key: 'claude-code', kind: 'cli', quotaSource: 'anthropic-claude-subscription', reason: 'CLI_NOT_INSTALLED', privacyClasses: ['PUBLIC'] });
