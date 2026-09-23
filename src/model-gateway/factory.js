import {
  MODEL_GATEWAY_ALLOWED_PROVIDERS,
  MODEL_GATEWAY_FAILOVER_ENABLED,
  MODEL_GATEWAY_MAX_ATTEMPTS,
  MODEL_PROVIDER,
  DEEPSEEK_MODEL,
  OPENAI_MODEL,
} from '../config.js';
import { AnthropicModelAdapter } from './adapters/anthropic.js';
import { DeepSeekResponsesAdapter } from './adapters/deepseek.js';
import { OpenAIResponsesAdapter } from './adapters/openai.js';
import { ModelGateway } from './gateway.js';
import { RoutingPolicy } from './policy.js';

export function createDefaultModelGateway({ env = process.env, queryFn, fetchFn, sleepFn } = {}) {
  const adapters = [
    new AnthropicModelAdapter({ queryFn, env }),
    new OpenAIResponsesAdapter({ apiKey: env.OPENAI_API_KEY, model: OPENAI_MODEL, fetchFn }),
    new DeepSeekResponsesAdapter({ apiKey: env.DEEPSEEK_API_KEY, model: DEEPSEEK_MODEL, fetchFn }),
  ];
  return new ModelGateway({
    adapters,
    routingPolicy: new RoutingPolicy({
      defaultProvider: MODEL_PROVIDER,
      allowedProviders: MODEL_GATEWAY_ALLOWED_PROVIDERS,
      failoverEnabled: MODEL_GATEWAY_FAILOVER_ENABLED,
    }),
    maxAttemptsPerProvider: MODEL_GATEWAY_MAX_ATTEMPTS,
    sleepFn,
  });
}
