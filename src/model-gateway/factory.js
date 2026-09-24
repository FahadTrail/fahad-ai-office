import {
  MODEL_GATEWAY_ALLOWED_PROVIDERS,
  MODEL_GATEWAY_FAILOVER_ENABLED,
  MODEL_GATEWAY_MAX_ATTEMPTS,
  MODEL_PROVIDER,
  DEEPSEEK_MODEL,
  QWEN_MODEL,
  KIMI_MODEL,
  ZHIPU_MODEL,
  MINIMAX_MODEL,
  QWEN_API_ENDPOINT,
  MODEL_GATEWAY_AUTO_SELECT_ENABLED,
  OPENAI_MODEL,
} from '../config.js';
import { AnthropicModelAdapter } from './adapters/anthropic.js';
import { DeepSeekResponsesAdapter } from './adapters/deepseek.js';
import { OpenAIResponsesAdapter } from './adapters/openai.js';
import { QwenChatAdapter } from './adapters/qwen.js';
import { KimiChatAdapter } from './adapters/kimi.js';
import { ZhipuChatAdapter } from './adapters/zhipu.js';
import { MiniMaxChatAdapter } from './adapters/minimax.js';
import { ModelGateway } from './gateway.js';
import { RoutingPolicy } from './policy.js';
import { WorkspacePolicyGateway } from '../workspace-policy/gateway.js';

export const DEFAULT_PROVIDER_SECRET_REFS = Object.freeze({
  anthropic: 'env://ANTHROPIC_API_KEY',
  openai: 'env://OPENAI_API_KEY',
  deepseek: 'env://DEEPSEEK_API_KEY',
});

export function createDefaultModelGateway({
  env = process.env,
  queryFn,
  fetchFn,
  sleepFn,
  workspacePolicyStore,
  providerSecretRefs = DEFAULT_PROVIDER_SECRET_REFS,
} = {}) {
  const adapters = [
    new AnthropicModelAdapter({ queryFn, env }),
    new OpenAIResponsesAdapter({ apiKey: env.OPENAI_API_KEY, model: OPENAI_MODEL, fetchFn }),
    new DeepSeekResponsesAdapter({ apiKey: env.DEEPSEEK_API_KEY, model: DEEPSEEK_MODEL, fetchFn }),
    new QwenChatAdapter({ apiKey: env.QWEN_API_KEY, endpoint: QWEN_API_ENDPOINT, model: QWEN_MODEL, fetchFn }),
    new KimiChatAdapter({ apiKey: env.KIMI_API_KEY, model: KIMI_MODEL, fetchFn }),
    new ZhipuChatAdapter({ apiKey: env.ZHIPU_API_KEY, model: ZHIPU_MODEL, fetchFn }),
    new MiniMaxChatAdapter({ apiKey: env.MINIMAX_API_KEY, model: MINIMAX_MODEL, fetchFn }),
  ];
  const gateway = new ModelGateway({
    adapters,
    routingPolicy: new RoutingPolicy({
      defaultProvider: MODEL_PROVIDER,
      allowedProviders: MODEL_GATEWAY_ALLOWED_PROVIDERS,
      failoverEnabled: MODEL_GATEWAY_FAILOVER_ENABLED,
      autoSelectEnabled: MODEL_GATEWAY_AUTO_SELECT_ENABLED,
    }),
    maxAttemptsPerProvider: MODEL_GATEWAY_MAX_ATTEMPTS,
    sleepFn,
  });
  return workspacePolicyStore
    ? new WorkspacePolicyGateway({ gateway, policyStore: workspacePolicyStore, providerSecretRefs })
    : gateway;
}
