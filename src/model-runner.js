import { randomUUID } from 'node:crypto';
import { buildModelEnvironment } from './model-gateway/adapters/anthropic.js';
import { createDefaultModelGateway } from './model-gateway/factory.js';

let sharedGateway;
let sharedPolicyGateway;
let sharedPolicyStore;

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
  workspacePolicyStore,
}) {
  let selectedGateway = gateway;
  if (!selectedGateway && queryFn) selectedGateway = createDefaultModelGateway({ queryFn, workspacePolicyStore });
  if (!selectedGateway && workspacePolicyStore) {
    if (!sharedPolicyGateway || sharedPolicyStore !== workspacePolicyStore) {
      sharedPolicyStore = workspacePolicyStore;
      sharedPolicyGateway = createDefaultModelGateway({ workspacePolicyStore });
    }
    selectedGateway = sharedPolicyGateway;
  }
  selectedGateway ||= (sharedGateway ||= createDefaultModelGateway());
  return selectedGateway.execute({
    prompt,
    systemPrompt,
    model,
    provider: gatewayContext.provider,
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
