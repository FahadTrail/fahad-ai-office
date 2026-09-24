import { MCP_PROTOCOL_VERSION, ToolBrokerError, validateMcpToolResult } from './contracts.js';

export class McpClientAdapter {
  constructor({ name, transport, protocolVersion = MCP_PROTOCOL_VERSION, clientInfo } = {}) {
    if (!name || !/^[A-Za-z0-9_.-]{1,80}$/.test(name)) throw new TypeError('A valid MCP server name is required');
    if (typeof transport?.request !== 'function') throw new TypeError('MCP transport.request is required');
    this.name = name;
    this.transport = transport;
    this.protocolVersion = protocolVersion;
    this.clientInfo = Object.freeze(clientInfo || { name: 'fahad-ai-office-tool-broker', version: '0.1.0' });
    this.initialized = null;
    this.capabilities = null;
  }

  initialize() {
    if (!this.initialized) this.initialized = this.#initialize();
    return this.initialized;
  }

  async #initialize() {
    const response = await this.transport.request('initialize', {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: this.clientInfo,
    });
    if (!response || response.protocolVersion !== this.protocolVersion || !response.serverInfo?.name) {
      throw protocolError('MCP server returned an invalid initialize result');
    }
    this.capabilities = Object.freeze({ ...(response.capabilities || {}) });
    if (typeof this.transport.notify === 'function') await this.transport.notify('notifications/initialized', {});
    return Object.freeze({
      protocolVersion: response.protocolVersion,
      serverInfo: Object.freeze({ ...response.serverInfo }),
      capabilities: this.capabilities,
    });
  }

  async listTools({ maxPages = 20 } = {}) {
    await this.initialize();
    if (!this.capabilities?.tools) throw protocolError('MCP server did not declare the tools capability');
    const tools = [];
    const names = new Set();
    let cursor;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.transport.request('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(result?.tools)) throw protocolError('MCP tools/list returned an invalid result');
      for (const value of result.tools) {
        const tool = normalizeDiscoveredTool(value);
        if (names.has(tool.name)) throw protocolError(`MCP server returned a duplicate tool: ${tool.name}`);
        names.add(tool.name);
        tools.push(tool);
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
      if (!cursor) return Object.freeze(tools);
    }
    throw protocolError('MCP tools/list exceeded the pagination safety limit');
  }

  async callTool({ name, arguments: args = {}, signal, credential } = {}) {
    await this.initialize();
    const result = await this.transport.request('tools/call', { name, arguments: args }, {
      signal,
      credential,
    });
    return validateMcpToolResult(result);
  }
}

export class InMemoryMcpTransport {
  constructor({ serverInfo = { name: 'office-safe-canary', version: '0.1.0' }, tools = [], handlers = {} } = {}) {
    this.serverInfo = Object.freeze({ ...serverInfo });
    this.tools = Object.freeze(tools.map((tool) => Object.freeze(structuredClone(tool))));
    this.handlers = Object.freeze({ ...handlers });
    this.calls = [];
    this.notifications = [];
  }

  async notify(method, params) {
    this.notifications.push({ method, params: structuredClone(params) });
  }

  async request(method, params = {}, options = {}) {
    if (method === 'initialize') {
      return {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: this.serverInfo,
      };
    }
    if (method === 'tools/list') return { tools: this.tools };
    if (method !== 'tools/call') throw protocolError(`Unsupported in-memory MCP method: ${method}`);
    const handler = this.handlers[params.name];
    if (!handler) throw protocolError(`Unknown MCP tool: ${params.name}`);
    this.calls.push({ name: params.name, arguments: structuredClone(params.arguments || {}), hasCredential: Boolean(options.credential) });
    return handler(structuredClone(params.arguments || {}), {
      signal: options.signal,
      credential: options.credential,
    });
  }
}

function normalizeDiscoveredTool(value) {
  if (!value || typeof value !== 'object' || !/^[A-Za-z0-9_.-]{1,128}$/.test(value.name || '')) {
    throw protocolError('MCP tools/list returned an invalid tool name');
  }
  if (!value.inputSchema || typeof value.inputSchema !== 'object' || Array.isArray(value.inputSchema)) {
    throw protocolError(`MCP tool ${value.name} has no valid input schema`);
  }
  return Object.freeze({
    name: value.name,
    title: typeof value.title === 'string' ? value.title : null,
    description: typeof value.description === 'string' ? value.description : '',
    inputSchema: Object.freeze(structuredClone(value.inputSchema)),
    outputSchema: value.outputSchema && typeof value.outputSchema === 'object'
      ? Object.freeze(structuredClone(value.outputSchema)) : null,
    // Server annotations are intentionally retained only as untrusted display
    // metadata. Authorization always uses the controller-owned catalog.
    annotations: value.annotations && typeof value.annotations === 'object'
      ? Object.freeze(structuredClone(value.annotations)) : null,
  });
}

function protocolError(message) {
  return new ToolBrokerError(message, { code: 'MCP_PROTOCOL_ERROR' });
}
