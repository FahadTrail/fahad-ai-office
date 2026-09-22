export async function runModel({
  prompt,
  systemPrompt,
  model,
  maxTurns,
  allowedTools = [],
  onActivity = async () => {},
  queryFn,
}) {
  const startedAt = Date.now();
  let text = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  let sawResult = false;
  let turns = 0;

  const invoke = queryFn || (await import('@anthropic-ai/claude-agent-sdk')).query;
  const stream = invoke({
    prompt,
    options: {
      model,
      systemPrompt,
      maxTurns,
      allowedTools,
      env: buildModelEnvironment(),
      settingSources: [],
      permissionMode: 'bypassPermissions',
    },
  });

  for await (const message of stream) {
    if (message.type === 'assistant') {
      turns += 1;
      const blocks = message.message?.content || [];
      const chunk = blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (chunk.trim()) text = chunk;
      await onActivity({ turns });
    }

    if (message.type === 'result') {
      sawResult = true;
      if (message.subtype !== 'success' && !text.trim()) {
        throw new Error(`Model returned ${message.subtype || 'an unsuccessful result'} with no output`);
      }
      if (typeof message.result === 'string' && message.result.trim()) text = message.result;
      tokensIn = Number(message.usage?.input_tokens || 0);
      tokensOut = Number(message.usage?.output_tokens || 0);
      costUsd = Number(message.total_cost_usd || 0);
    }
  }

  if (!sawResult) throw new Error('Model stream ended without a result message');
  if (!text.trim()) throw new Error('Model returned an empty response');

  return {
    text: text.trim(),
    tokensIn,
    tokensOut,
    costUsd,
    durationMs: Date.now() - startedAt,
    turns,
  };
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
