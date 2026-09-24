import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { AnthropicModelAdapter } from '../model-gateway/adapters/anthropic.js';
import { QwenChatAdapter } from '../model-gateway/adapters/qwen.js';
import { ModelGateway } from '../model-gateway/gateway.js';
import { RoutingPolicy } from '../model-gateway/policy.js';

const SAFE_PROMPT = 'Return exactly this JSON object and nothing else: {"canary":"ok"}';
const LIVE_CANARY_BUDGET_USD = 0.01;
const FAILOVER_CANARY_BUDGET_USD = 0.10;

export async function runQwenCanary({
  env = process.env,
  fetchFn = fetch,
  queryFn,
  forceFailover = false,
  checkpointDirectory = join(tmpdir(), 'fahad-office-qwen-canary'),
} = {}) {
  assertSecret(env.QWEN_API_KEY, 'QWEN_API_KEY');
  assertApproval(env.QWEN_API_PRIVATE_DATA_APPROVED);
  const endpoint = validateSingaporeWorkspaceEndpoint(env.QWEN_API_ENDPOINT);
  if (forceFailover) assertSecret(env.ANTHROPIC_API_KEY, 'ANTHROPIC_API_KEY');

  const qwen = new QwenChatAdapter({ apiKey: env.QWEN_API_KEY, endpoint, fetchFn });
  if (forceFailover) {
    qwen.complete = async () => {
      const error = new Error('Simulated Qwen canary provider outage');
      error.status = 503;
      throw error;
    };
  }
  const adapters = [qwen];
  if (forceFailover) adapters.push(new AnthropicModelAdapter({ queryFn, env }));
  const gateway = new ModelGateway({
    adapters,
    routingPolicy: new RoutingPolicy({
      defaultProvider: 'anthropic',
      allowedProviders: forceFailover ? ['qwen', 'anthropic'] : ['qwen'],
      failoverEnabled: forceFailover,
    }),
    maxAttemptsPerProvider: 1,
  });
  const idempotencyKey = `phase2c1-qwen-canary:${forceFailover ? 'fallback' : 'live'}:${Date.now()}`;
  let checkpointPath = null;
  const result = await gateway.execute({
    prompt: SAFE_PROMPT,
    systemPrompt: 'This is an isolated synthetic provider canary. Do not use tools or include additional data.',
    model: 'qwen3-coder-flash',
    provider: 'qwen',
    maxTurns: 1,
    maxOutputTokens: 40,
    allowedTools: [],
    capabilities: ['text'],
    stage: 'phase2c1-qwen-canary',
    idempotencyKey,
    context: {},
    routingHints: { requiresPrivateData: false },
    budget: { limitUsd: forceFailover ? FAILOVER_CANARY_BUDGET_USD : LIVE_CANARY_BUDGET_USD, spentUsd: 0 },
  }, {
    onCheckpoint: async (checkpoint) => {
      await mkdir(checkpointDirectory, { recursive: true });
      checkpointPath = join(checkpointDirectory, `${idempotencyKey.replaceAll(':', '-')}.json`);
      await writeFile(checkpointPath, JSON.stringify(checkpoint), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    },
  });

  return {
    ok: true,
    mode: forceFailover ? 'simulated-failover' : 'live-canary',
    provider: result.provider,
    model: result.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cachedInputTokens: result.usage.cachedInputTokens,
    costUsd: result.usage.costUsd,
    durationMs: result.durationMs,
    providerSwitches: result.providerSwitches,
    attempts: result.attempts.map(({ provider, model, status, error }) => ({
      provider, model, status, errorCode: error?.code || null,
    })),
    checkpointPreserved: forceFailover ? Boolean(checkpointPath) : null,
  };
}

function validateSingaporeWorkspaceEndpoint(value) {
  let endpoint;
  try { endpoint = new URL(value); } catch { throw new Error('Missing or invalid setting: QWEN_API_ENDPOINT'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password
      || !/^[a-z0-9-]+\.ap-southeast-1\.maas\.aliyuncs\.com$/i.test(endpoint.hostname)
      || endpoint.pathname.replace(/\/$/, '') !== '/compatible-mode/v1/chat/completions') {
    throw new Error('Missing or invalid setting: QWEN_API_ENDPOINT');
  }
  return endpoint.href;
}

function assertSecret(value, name) {
  if (typeof value !== 'string' || value.trim().length < 12 || /PASTE_HERE|YOUR_.*KEY/i.test(value)) {
    throw new Error(`Missing or placeholder setting: ${name}`);
  }
}

function assertApproval(value) {
  if (!/^(1|true|yes)$/i.test(String(value || ''))) {
    throw new Error('Missing private-data authorization: QWEN_API_PRIVATE_DATA_APPROVED');
  }
}

async function main() {
  const output = await runQwenCanary({ forceFailover: process.argv.includes('--simulate-failover') });
  // Deliberately excludes prompts, response text, headers and credentials.
  console.log(JSON.stringify(output));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, code: error.code || 'CANARY_FAILED', message: String(error.message).slice(0, 160) }));
    process.exitCode = 1;
  });
}
