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
    const invoke = this.queryFn || (await import('@anthropic-ai/claude-agent-sdk')).query;
    const stream = invoke({
      prompt,
      options: {
        model: model || this.model,
        systemPrompt,
        maxTurns,
        allowedTools,
        env: buildModelEnvironment(this.env),
        settingSources: [],
        permissionMode: 'bypassPermissions',
      },
    });

    for await (const message of stream) {
      if (message.type === 'assistant') {
        turns += 1;
        const chunk = (message.message?.content || [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('');
        if (chunk.trim()) text = chunk;
        await onActivity({ turns });
      }
      if (message.type === 'result') {
        sawResult = true;
        if (message.subtype !== 'success' && !text.trim()) {
          throw new GatewayError(`Model returned ${message.subtype || 'an unsuccessful result'} with no output`, {
            code: 'PROVIDER_RESULT_FAILED',
            type: message.subtype || null,
          });
        }
        if (typeof message.result === 'string' && message.result.trim()) text = message.result;
        inputTokens = Number(message.usage?.input_tokens || 0);
        outputTokens = Number(message.usage?.output_tokens || 0);
        costUsd = Number(message.total_cost_usd || 0);
      }
    }

    if (!sawResult) throw new GatewayError('Model stream ended without a result message', { code: 'PROVIDER_RESULT_MISSING' });
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
