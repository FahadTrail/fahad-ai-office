import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { AnthropicModelAdapter } from '../model-gateway/adapters/anthropic.js';
import { DeepSeekResponsesAdapter } from '../model-gateway/adapters/deepseek.js';
import { ModelGateway } from '../model-gateway/gateway.js';
import { RoutingPolicy } from '../model-gateway/policy.js';

const SAFE_PROMPT = 'Return exactly this JSON object and nothing else: {"canary":"ok"}';
const LIVE_CANARY_BUDGET_USD = 0.01;
const FAILOVER_CANARY_BUDGET_USD = 0.10;

export async function runDeepSeekCanary({
  env = process.env,
  fetchFn = fetch,
  queryFn,
  forceFailover = false,
  checkpointDirectory = join(tmpdir(), 'fahad-office-canary'),
} = {}) {
  assertSecret(env.DEEPSEEK_API_KEY, 'DEEPSEEK_API_KEY');
  if (forceFailover) assertSecret(env.ANTHROPIC_API_KEY, 'ANTHROPIC_API_KEY');

  const deepseek = new DeepSeekResponsesAdapter({ apiKey: env.DEEPSEEK_API_KEY, fetchFn });
  if (forceFailover) {
    deepseek.complete = async () => {
      const error = new Error('Simulated canary provider outage');
      error.status = 503;
      throw error;
    };
  }
  const adapters = [deepseek];
  if (forceFailover) adapters.push(new AnthropicModelAdapter({ queryFn, env }));
  const gateway = new ModelGateway({
    adapters,
    routingPolicy: new RoutingPolicy({
      defaultProvider: 'anthropic',
      allowedProviders: forceFailover ? ['deepseek', 'anthropic'] : ['deepseek'],
      failoverEnabled: forceFailover,
    }),
    maxAttemptsPerProvider: 1,
  });
  const idempotencyKey = `phase2c-canary:${forceFailover ? 'fallback' : 'live'}:${Date.now()}`;
  let checkpointPath = null;
  const result = await gateway.execute({
    prompt: SAFE_PROMPT,
    systemPrompt: 'This is an isolated text-only provider canary. Do not use tools or include additional data.',
    model: 'deepseek-flash',
    provider: 'deepseek',
    maxTurns: 1,
    maxOutputTokens: 40,
    allowedTools: [],
    capabilities: ['text'],
    stage: 'phase2c-canary',
    idempotencyKey,
    context: {},
    // The Anthropic SDK adds its own execution context, so the controlled
    // fallback drill needs a slightly larger ceiling than the text-only
    // DeepSeek request. Both limits remain far below a development run.
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
    costUsd: result.usage.costUsd,
    durationMs: result.durationMs,
    providerSwitches: result.providerSwitches,
    attempts: result.attempts.map(({ provider, model, status, error }) => ({
      provider, model, status, errorCode: error?.code || null,
    })),
    checkpointPreserved: forceFailover ? Boolean(checkpointPath) : null,
  };
}

function assertSecret(value, name) {
  if (typeof value !== 'string' || value.trim().length < 12 || /PASTE_HERE|YOUR_.*KEY/i.test(value)) {
    throw new Error(`Missing or placeholder setting: ${name}`);
  }
}

async function main() {
  const output = await runDeepSeekCanary({ forceFailover: process.argv.includes('--simulate-failover') });
  // The result deliberately excludes prompts, response text, headers and secrets.
  console.log(JSON.stringify(output));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, code: error.code || 'CANARY_FAILED', message: String(error.message).slice(0, 160) }));
    process.exitCode = 1;
  });
}
