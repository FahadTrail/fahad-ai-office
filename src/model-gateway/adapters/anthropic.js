import { GatewayError } from '../contracts.js';

export class AnthropicModelAdapter {
  constructor({ model = 'claude-sonnet-5', queryFn, env = process.env } = {}) {
    this.name = 'anthropic';
    this.model = model;
    this.queryFn = queryFn;
    this.env = env;
    this.capabilities = Object.freeze(['text', 'host_tools']);
  }

  async complete({ prompt, systemPrompt, model, maxTurns, allowedTools, onActivity }) {
    const startedAt = Date.now();
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let sawResult = false;
    let turns = 0;
    const toolUses = new Map();
    const finishedTools = new Set();
    let successfulTools = 0;
    const authorizedTools = [...new Set(allowedTools || [])];
    const invoke = this.queryFn || (await import('@anthropic-ai/claude-agent-sdk')).query;
    const stream = invoke({
      prompt,
      options: {
        model: model || this.model,
        systemPrompt,
        maxTurns,
        // allowedTools only skips prompts; tools is the actual availability boundary.
        tools: authorizedTools,
        allowedTools: authorizedTools,
        env: buildModelEnvironment(this.env),
        settingSources: [],
        permissionMode: 'dontAsk',
      },
    });

    for await (const message of stream) {
      if (message.type === 'assistant') {
        turns += 1;
        const blocks = message.message?.content || [];
        for (const block of blocks.filter((item) => item.type === 'tool_use')) {
          if (!authorizedTools.includes(block.name)) {
            throw new GatewayError('Model requested an unauthorized host tool', { code: 'UNAUTHORIZED_HOST_TOOL' });
          }
          if (!toolUses.has(block.id)) {
            toolUses.set(block.id, { name: block.name, startedAt: Date.now() });
            await onActivity({ turns, hostTool: { id: block.id, name: block.name, status: 'started' } });
          }
        }
        const chunk = blocks
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('');
        if (chunk.trim()) text = chunk;
        await onActivity({ turns });
      }
      if (message.type === 'user' && Array.isArray(message.message?.content)) {
        for (const block of message.message.content.filter((item) => item.type === 'tool_result')) {
          const tool = toolUses.get(block.tool_use_id);
          if (!tool || finishedTools.has(block.tool_use_id)) continue;
          finishedTools.add(block.tool_use_id);
          if (!block.is_error) successfulTools += 1;
          await onActivity({ turns, hostTool: {
            id: block.tool_use_id,
            name: tool.name,
            status: block.is_error ? 'failed' : 'succeeded',
            durationMs: Math.max(0, Date.now() - tool.startedAt),
          } });
        }
      }
      if (message.type === 'result') {
        sawResult = true;
        if (message.subtype !== 'success') {
          throw new GatewayError(`Model returned ${message.subtype || 'an unsuccessful result'}`, {
            code: 'PROVIDER_RESULT_FAILED',
            type: message.subtype || null,
            usage: {
              inputTokens: Number(message.usage?.input_tokens || 0),
              outputTokens: Number(message.usage?.output_tokens || 0),
              costUsd: Number(message.total_cost_usd || 0),
            },
          });
        }
        if (typeof message.result === 'string' && message.result.trim()) text = message.result;
        inputTokens = Number(message.usage?.input_tokens || 0);
        outputTokens = Number(message.usage?.output_tokens || 0);
        costUsd = Number(message.total_cost_usd || 0);
      }
    }

    if (!sawResult) throw new GatewayError('Model stream ended without a result message', { code: 'PROVIDER_RESULT_MISSING' });
    if (authorizedTools.length && successfulTools === 0) {
      throw new GatewayError('Research completed without a verified host tool result', {
        code: 'HOST_TOOL_REQUIRED',
        usage: { inputTokens, outputTokens, costUsd },
      });
    }
    if (!text.trim()) throw new GatewayError('Model returned an empty response', { code: 'PROVIDER_EMPTY_RESPONSE' });
    return {
      text: text.trim(),
      model: model || this.model,
      usage: { inputTokens, outputTokens, costUsd },
      durationMs: Date.now() - startedAt,
      turns,
    };
  }
}

export function buildModelEnvironment(source = process.env) {
  const allowed = [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
    'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'CLAUDE_CONFIG_DIR', 'IS_SANDBOX',
  ];
  return Object.fromEntries(allowed.filter((name) => source[name]).map((name) => [name, source[name]]));
}
