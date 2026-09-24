import { ToolBrokerError } from './contracts.js';

export class EnvironmentSecretResolver {
  constructor({ env = process.env, allowedReferences = [] } = {}) {
    this.env = env;
    this.allowedReferences = new Set(allowedReferences);
  }

  resolve(reference) {
    if (!reference) return null;
    if (!this.allowedReferences.has(reference)) {
      throw new ToolBrokerError('Tool secret reference is not controller-authorized', {
        code: 'TOOL_SECRET_REFERENCE_DENIED',
      });
    }
    const match = /^env:\/\/([A-Z][A-Z0-9_]{2,127})$/.exec(reference);
    if (!match) {
      throw new ToolBrokerError('Only controller-side env:// resolution is implemented in Phase 2E', {
        code: 'TOOL_SECRET_RESOLVER_UNAVAILABLE',
      });
    }
    const value = this.env[match[1]];
    if (typeof value !== 'string' || value.trim().length < 8 || /PASTE_HERE|YOUR_.*KEY/i.test(value)) {
      throw new ToolBrokerError('Tool credential is missing or invalid', { code: 'TOOL_SECRET_UNAVAILABLE' });
    }
    // This value is returned only to the broker-owned transport call. It must
    // never be placed in model context, audit rows, errors, or tool results.
    return value.trim();
  }
}
