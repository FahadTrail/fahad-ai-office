import { McpClientAdapter, InMemoryMcpTransport } from './mcp-client.js';

const objectSchema = (properties, required = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});

export const SAFE_CANARY_TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    broker: 'mcp-office',
    name: 'office.echo',
    action: 'invoke',
    server: 'office-safe-canary',
    description: 'Echo a bounded non-sensitive canary message through the governed MCP path.',
    risk: 'low',
    minimumDecision: 'auto',
    scopes: Object.freeze(['canary:read']),
    agentPermission: 'office.echo',
    secretRef: null,
    inputSchema: objectSchema({ message: { type: 'string', minLength: 1, maxLength: 500 } }, ['message']),
    outputSchema: objectSchema({ message: { type: 'string', maxLength: 500 } }, ['message']),
    timeoutMs: 2_000,
    maxRetries: 0,
    retrySafe: true,
    estimatedCostUsd: 0,
  }),
  Object.freeze({
    broker: 'mcp-office',
    name: 'office.current_time',
    action: 'read',
    server: 'office-safe-canary',
    description: 'Return the broker clock without network access or credentials.',
    risk: 'low',
    minimumDecision: 'auto',
    scopes: Object.freeze(['canary:read']),
    agentPermission: 'office.current_time',
    secretRef: null,
    inputSchema: objectSchema({}),
    outputSchema: objectSchema({ iso: { type: 'string' } }, ['iso']),
    timeoutMs: 2_000,
    maxRetries: 0,
    retrySafe: true,
    estimatedCostUsd: 0,
  }),
]);

export function createSafeCanaryMcpClient({ now = () => new Date() } = {}) {
  const tools = SAFE_CANARY_TOOL_DEFINITIONS.map((definition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
  }));
  const transport = new InMemoryMcpTransport({
    tools,
    handlers: {
      'office.echo': ({ message }) => ({
        content: [{ type: 'text', text: String(message).slice(0, 500) }],
        structuredContent: { message: String(message).slice(0, 500) },
      }),
      'office.current_time': () => {
        const iso = now().toISOString();
        return { content: [{ type: 'text', text: iso }], structuredContent: { iso } };
      },
    },
  });
  return Object.freeze({
    client: new McpClientAdapter({ name: 'office-safe-canary', transport }),
    transport,
  });
}
