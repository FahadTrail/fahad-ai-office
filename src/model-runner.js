import { randomUUID } from 'node:crypto';
import { buildModelEnvironment } from './model-gateway/adapters/anthropic.js';
import { createDefaultModelGateway } from './model-gateway/factory.js';

let sharedGateway;
let sharedPolicyGateway;
let sharedPolicyStore;
let sharedHealthStore = null;

// Lets the Office runtime share durable provider health (provider_status)
// with the Coding Agent and the Hub dashboard.
export function configureSharedProviderHealth(store) {
  sharedHealthStore = store;
  sharedGateway = undefined;
  sharedPolicyGateway = undefined;
}

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
  routingHints,
}) {
  let selectedGateway = gateway;
  if (!selectedGateway && queryFn) selectedGateway = createDefaultModelGateway({ queryFn, workspacePolicyStore, healthStore: sharedHealthStore });
  if (!selectedGateway && workspacePolicyStore) {
    if (!sharedPolicyGateway || sharedPolicyStore !== workspacePolicyStore) {
      sharedPolicyStore = workspacePolicyStore;
      sharedPolicyGateway = createDefaultModelGateway({ workspacePolicyStore, healthStore: sharedHealthStore });
    }
    selectedGateway = sharedPolicyGateway;
  }
  selectedGateway ||= (sharedGateway ||= createDefaultModelGateway({ healthStore: sharedHealthStore }));
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
    routingHints,
  }, { onAttempt, onCheckpoint, onProviderSwitch, onBudgetThreshold });
}

export { buildModelEnvironment };
