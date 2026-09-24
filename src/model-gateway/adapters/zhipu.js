import { ChatCompletionsCompatibleAdapter } from './chat-completions-compatible.js';

export const GLM_5_3_FLASH_PRICING = Object.freeze({ inputPerMillion: 0.15, cachedInputPerMillion: 0.03, outputPerMillion: 0.50 });

export class ZhipuChatAdapter extends ChatCompletionsCompatibleAdapter {
  constructor({ apiKey, model = 'glm-5.3-flash', fetchFn = fetch, pricing = GLM_5_3_FLASH_PRICING } = {}) {
    super({ name: 'zhipu', apiKey, endpoint: 'https://api.z.ai/api/paas/v4/chat/completions', model, fetchFn, pricing,
      capabilities: ['coding', 'long-context'] });
  }
}
