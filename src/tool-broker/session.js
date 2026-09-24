import { ToolBrokerError } from './contracts.js';

export class ScopedToolBrokerSession {
  constructor({ broker, context, idempotencyPrefix } = {}) {
    if (typeof broker?.discover !== 'function' || typeof broker?.execute !== 'function') {
      throw new TypeError('A Tool Broker is required');
    }
    this.broker = broker;
    this.context = Object.freeze({ ...context });
    this.idempotencyPrefix = String(idempotencyPrefix || context?.runId || '').trim();
    if (!this.idempotencyPrefix) throw new TypeError('A Tool Broker idempotency prefix is required');
    Object.freeze(this);
  }

  discover() {
    return this.broker.discover(this.context);
  }

  execute(input = {}) {
    const callId = String(input.callId || '').trim();
    if (!/^[A-Za-z0-9_.-]{1,160}$/.test(callId)) {
      throw new ToolBrokerError('A bounded callId is required for tool idempotency', { code: 'TOOL_CALL_ID_REQUIRED' });
    }
    return this.broker.execute({
      context: this.context,
      broker: input.broker,
      tool: input.tool,
      action: input.action,
      arguments: input.arguments,
      idempotencyKey: `${this.idempotencyPrefix}:${callId}`,
    });
  }
}
