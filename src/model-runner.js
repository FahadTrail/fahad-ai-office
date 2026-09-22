import { randomUUID } from 'node:crypto';
import { buildModelEnvironment } from './model-gateway/adapters/anthropic.js';
import { createDefaultModelGateway } from './model-gateway/factory.js';

let sharedGateway;

export async function runModel({
  prompt,
  systemPrompt,
  model,
  maxTurns,
  allowedTools = [],
  onActivity = async () => {},
  queryFn,
  gateway,
  gatewayContext = {},
  idempotencyKey,
  budget,
  onAttempt,
  onCheckpoint,
  onProviderSwitch,
  onBudgetThreshold,
}) {
  const selectedGateway = gateway || (queryFn
    ? createDefaultModelGateway({ queryFn })
    : (sharedGateway ||= createDefaultModelGateway()));
  return selectedGateway.execute({
    prompt,
    systemPrompt,
    model,
    maxTurns,
    allowedTools,
    onActivity,
    stage: gatewayContext.stage || 'model',
    context: gatewayContext,
    idempotencyKey: idempotencyKey || `ephemeral:${randomUUID()}`,
    capabilities: allowedTools.length ? ['text', 'host_tools'] : ['text'],
    budget,
  }, { onAttempt, onCheckpoint, onProviderSwitch, onBudgetThreshold });
}

export { buildModelEnvironment };
